/**
 * Chat turn orchestration (main process). Builds the prompt, calls Anthropic,
 * runs the single `launch` tool loop, persists both sides, returns the reply.
 *
 * The launch loop implements the user's spec: launch() starts the summon
 * immediately when a LAN world is open; otherwise it feeds a plain-language
 * tool_result back to the model explaining the world is not open and how to open
 * it, and the model paraphrases that in its own voice.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatSendResult, LanState } from '../../shared/ipc';
import { paths } from '../paths';
import { loadConfig } from '../configStore';
import { getCharacter, patchCharacter } from '../characterStore';
import { buildChatSdk, CHAT_TIMEOUT_MS } from './sdk';
import { buildSystemBlocks, markLastMessageCached, LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL, REMEMBER_TOOL } from './chatPrompts';
import { appendMemory } from '../../bot/brain/memory/memoryLog.js';
import { isCallActive } from '../voice/callState';
import { readChatContext, foldIfDue, formatChatTimestamp } from './continuity';
import { clampChatLanguage } from '../../shared/chatLanguage';
import * as chatStore from './chatStore';
import {
  drainThoughts,
  pushThought,
  renderThoughtNote,
  THOUGHT_FIRST_MEETING,
  THOUGHT_JOINING_GAME,
} from './thoughts';

export interface ChatDeps {
  getLanState: () => LanState;
  summon: (characterId: string) => Promise<void>;
  /** Task 4 — true when the character's bot is fully spawned in-world right now. */
  isInGame?: (characterId: string) => boolean;
  /**
   * Task 4 — route a message INTO the live game session (shared brain + prompt
   * cache). Returns false if no session took it, so the caller can fall back to
   * the standalone chat brain.
   */
  routeToBot?: (characterId: string, payload: { from: string; text: string; voice?: boolean }) => boolean;
  /** The (non-blocking) join kicked off by launch() failed — report it to the
   * player in the companion's own voice (index.ts sendLaunchFailedTurn). */
  onLaunchFailed?: (characterId: string, reason: string) => void;
  /**
   * Task 5 — the companion called quit() from chat: leave the game and end the
   * live session (supervisor.stop). A no-op when no session is live.
   */
  leaveGame?: (characterId: string) => void;
  /**
   * Voice calls (260706): push ONE already-persisted companion reply to the
   * renderer immediately (the `chat:message` channel, no re-persist). Used by the
   * streaming voice turn to emit each sentence the moment it completes, so TTS
   * starts on sentence 1 while the rest still generates. Wired to pushChatMessage
   * in index.ts; absent → the turn falls back to the blocking, all-at-once path.
   */
  emitReply?: (characterId: string, message: ChatMessage) => void;
}

const MEMORY_BUDGET_BYTES = 6000;
const MAX_HOPS = 3;
/**
 * Voice calls (260706): cap the transcript sent to the model to the last N rows.
 * Memory (MEMORY.md) + the rolling summary still carry older context, so the
 * companion keeps continuity, but a live call sends a tiny window instead of the
 * full 50-99 verbatim tail — the prompt (and the cache-write during dialing) is
 * much smaller, which is the dominant per-turn latency. Typed chat is unbounded
 * (its window is capped only by the fold watermark) since latency matters less
 * there and richer context reads better.
 */
const VOICE_RECENT_CAP = 10;

/**
 * In-flight chat turn per character (chat #9). A new send for the same character
 * aborts the previous one's LLM call and supersedes it, so the user can fire a
 * follow-up (or correction) without waiting — the stale turn never appends a
 * reply. Keyed by characterId; the entry is the current turn's controller.
 */
const inflight = new Map<string, AbortController>();

/** Sentinel thrown when a turn was interrupted/superseded (not a real failure). */
export const CHAT_ABORTED = 'CHAT_ABORTED';

/** True if the error is our deliberate abort (vs a real API/timeout error). */
function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === 'AbortError' || /abort/i.test(e?.message ?? '');
}

/**
 * 260705: external interrupt for a character's in-flight chat turn.
 * resetMemoryForCharacter calls this before wiping the memory dir — a reply
 * still in the LLM would otherwise append to chat.jsonl AFTER the wipe,
 * repopulating the "blank slate" with one orphan companion message. Rides the
 * existing supersede path: the aborted turn throws the CHAT_ABORTED sentinel
 * (renderer treats it as an interrupt, not a failure) and never persists.
 */
export function cancelInflightTurn(characterId: string): void {
  inflight.get(characterId)?.abort();
}

async function readMemoryTail(characterId: string): Promise<string> {
  try {
    const raw = await readFile(path.join(paths.memoryDir(characterId), 'MEMORY.md'), 'utf8');
    return raw.length <= MEMORY_BUDGET_BYTES ? raw : raw.slice(-MEMORY_BUDGET_BYTES);
  } catch {
    return '';
  }
}

/**
 * Honor remember() calls in a SINGLE-SHOT voice turn (greeting, companion
 * reaction) — those turns offer the tool for the shared cache prefix but run no
 * tool loop, so without this the write would be silently dropped. Best-effort;
 * a failed append never breaks the spoken reply.
 */
async function honorRememberCalls(characterId: string, content: Anthropic.Messages.ContentBlock[]): Promise<void> {
  for (const b of content) {
    if (b.type !== 'tool_use' || b.name !== 'remember') continue;
    const text = String((b.input as { text?: string })?.text ?? '').trim();
    if (!text) continue;
    try {
      await appendMemory(path.join(paths.memoryDir(characterId), 'MEMORY.md'), text);
    } catch (err) {
      console.warn(`[sei] voice remember() append failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Split a reply into the separate chat messages the UI should send. ANY newline
 * run is a split point (260722: was blank-lines-only, which rendered a reply
 * written one-thought-per-line as a single wall of text — a model prompted to
 * "keep lines short like texting" separates thoughts with single newlines, not
 * blank ones). One line → one bubble, matching the bot's in-game
 * splitChatMessages. Purely visual: voice TTS streams off the raw reply by
 * sentence, not off these bubbles. Empty chunks are dropped; a reply with no
 * content collapses to a single "…" so the turn is never message-less.
 */
export function splitReply(text: string, punctuation: 'casual' | 'deliberate' = 'casual'): string[] {
  const parts = text
    .split(/\n+/)
    .map((s) => s.trim())
    // 260705: casual texters (the default) drop a single trailing period per
    // bubble — how people actually text. ONLY a lone period: an ellipsis
    // ("hm...") carries tone and is kept, and ? / ! always stay. 'deliberate'
    // characters (character.metadata.punctuation) keep their full stops.
    // Mirrors splitChatMessages in src/bot/brain/orchestrator.js.
    .map((s) => (punctuation === 'deliberate' ? s : s.replace(/(?<!\.)\.$/, '')))
    .filter(Boolean);
  return parts.length ? parts : ['…'];
}

/**
 * Voice streaming (260706): pull COMPLETE sentences off the front of a growing
 * buffer so each can be spoken the moment it finishes while the model is still
 * writing the rest. A boundary is sentence-ending punctuation (. ! ?) followed
 * by whitespace, with the preceding char NOT a digit so "1.618" / "3.5" never
 * split mid-number. The trailing partial stays buffered for the next delta.
 * Exported for testing.
 */
export function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  // Western boundaries require trailing whitespace (and the digit guard keeps
  // "1.618" whole). CJK sentences end with 。！？ and NO space after — without
  // their own branch (260709) a Chinese reply never split, so the whole
  // generation had to finish before the first bubble/TTS clip.
  const re = /(?<!\d)[.!?]+\s+|[。！？]+\s*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    const trailingWs = /\s*$/.exec(m[0])![0].length; // keep the punctuation, drop any trailing space
    const end = m.index + m[0].length - trailingWs;
    const s = buf.slice(last, end).trim();
    if (s) sentences.push(s);
    last = re.lastIndex;
  }
  return { sentences, rest: buf.slice(last) };
}

/**
 * Transcript-continuation stop (260722). Live capture: a voice-call reply turn
 * kept generating past the companion's own lines — a fabricated player turn
 * ("Human: [22 Jul 11:32] *...*") followed by an invented direction — and the
 * whole continuation was persisted as voice rows and SPOKEN by TTS, because a
 * turn runner treats the model's text output as the companion's speech. Each
 * marker here is a line-start token only the OTHER side of the transcript ever
 * writes (the pretraining Human/Assistant convention, the summarizer's Player
 * label), so generation ends the instant the model starts writing somebody
 * else's turn: the fabricated text never exists to persist or speak. This is
 * API-level plumbing (stop_sequences), not an output scrub — nothing legitimate
 * is removed. Every turn that persists or speaks reply text must pass these.
 */
export const TRANSCRIPT_STOP_SEQUENCES = ['\nHuman:', '\nAssistant:', '\nPlayer:'];

/** Concatenate the text blocks of an Anthropic response content array. */
function textOf(content: Array<{ type: string }>): string {
  return content
    .map((b) => (b.type === 'text' ? (b as unknown as { text: string }).text : ''))
    .join('')
    .trim();
}

/**
 * Map the persisted transcript into an alternating Anthropic messages array.
 * Exported for testing. Every emitted row — play rows included — flows through
 * the ONE shared same-role merge at the bottom: a play row is just a `user` row
 * with bracketed content, so two adjacent play rows (or a user message followed
 * by a play row) fold into a single user turn instead of two adjacent `user`
 * messages that Anthropic rejects with 400 "roles must alternate".
 */
export function toMessages(history: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const m of history) {
    // Per row, derive role + content first; then run the single shared merge.
    let role: 'user' | 'assistant';
    let content: string;
    if (m.role === 'system' && m.event?.kind === 'play') {
      // A finished play session is shared history, not chatter: surface it as a
      // bracketed system fact so the companion knows you actually played together
      // (the game→chat memory gap — otherwise chat only sees MEMORY.md, which may
      // never have captured the session). Framed so the model doesn't read it as
      // the player speaking or as a still-hypothetical plan.
      role = 'user';
      content = `[${formatChatTimestamp(m.ts)}] [Shared history: ${m.text} You were there together in the world — treat it as something you actually did, not a plan.]`;
    } else if (m.role === 'system' && m.event?.kind === 'call') {
      // A finished voice call is shared history the same way a play session is
      // (260705): without it, a later turn only sees the transcript lines and
      // may not realize they were spoken on a real call.
      role = 'user';
      content = `[${formatChatTimestamp(m.ts)}] [Shared history: ${m.text} That was a real voice call you were both on — treat it as a conversation you actually had.]`;
    } else if (m.role === 'system') {
      // Other system rows (e.g. "joined your world") are UI-only; skip them so
      // they don't pollute the model's turn-taking.
      continue;
    } else {
      // A quoted reply is surfaced to the model as a short lead-in so it knows
      // what the user is referring to, then the actual message text.
      content = m.text;
      if (m.replyTo) {
        const who = m.replyTo.role === 'companion' ? 'your earlier message' : 'their earlier message';
        content = `(replying to ${who}: "${m.replyTo.text}")\n${m.text}`;
      }
      role = m.role === 'companion' ? 'assistant' : 'user';
      // 260703: stamp USER messages with their send time so the model can feel
      // gaps (overnight silence vs rapid-fire). Assistant turns stay unstamped —
      // stamping the model's own prior output teaches it to emit timestamps.
      if (role === 'user') content = `[${formatChatTimestamp(m.ts)}] ${content}`;
    }
    // Merge consecutive same-role turns. An interrupted turn (#9) leaves a user
    // message with no reply, and play rows arrive as user rows, so the transcript
    // can hold two user turns in a row; Anthropic requires strict alternation, so
    // fold them into one.
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n${content}`;
    } else {
      out.push({ role, content });
    }
  }
  // Anthropic requires the first message to be from the user. Never satisfy
  // that by DROPPING a leading assistant turn: after a first-meeting greeting
  // the transcript is [companion..., user reply], so the shifted-off assistant
  // turn was the ENTIRE conversation — the model got the player's "the latter
  // :)" with no antecedent and asked what it was replying to (260721 live
  // capture). Seat a neutral marker user turn instead; it makes no claim about
  // who spoke first or whether this is the conversation's absolute start, so
  // it is also safe for mid-conversation windows (voice recentCap, fold
  // watermark) that happen to open on an assistant row.
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '[Session transcript begins here.]' });
  }
  return out;
}

/**
 * Fold a bracketed model-facing note into the messages array without breaking
 * Anthropic's strict role alternation. If the transcript already ends on a user
 * turn (a play row, or the player typing while something ran), append the note to
 * that turn's string content; otherwise the last turn is assistant (or the array
 * is empty), so push the note as a fresh user message. Shared by the three note
 * sites: the launch-failed turn, the drained-thought fold in a normal turn, and
 * the first-meeting turn. A blank note is a no-op. Exported for testing.
 */
export function foldUserNote(
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
  note: string,
): void {
  if (!note) return;
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && typeof last.content === 'string') {
    last.content = `${last.content}\n${note}`;
  } else {
    messages.push({ role: 'user', content: note });
  }
}

/**
 * Author's proactiveness dial (0-2). Missing / non-integer / out-of-range →
 * reactive (1). MIRROR: src/bot/index.js (~line 538) clamps
 * character.metadata.proactiveness identically; the bot ships as raw ESM in a
 * separate process and CANNOT import from src/main, so these two copies must be
 * kept in sync by hand.
 */
function clampProactiveness(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) ? Math.min(Math.max(0, raw), 2) : 1;
}

/**
 * Texting punctuation register off character.metadata.punctuation (260705).
 * Only the exact 'deliberate' value opts out of the casual trailing-period
 * strip; anything else (missing, junk) reads as 'casual'. MIRROR of the read
 * in src/bot/index.js (the bot cannot import from src/main) — keep in sync.
 */
function clampPunctuation(raw: unknown): 'casual' | 'deliberate' {
  return raw === 'deliberate' ? 'deliberate' : 'casual';
}

/**
 * Shared prompt assembly for a chat turn — getCharacter, loadConfig, the
 * summary+memory reads, the proactiveness clamp, the system blocks, and the
 * alternating messages array. Returns null when the character is missing.
 * Both sendChatMessage and sendLaunchFailedTurn build on this; the two callers
 * differ only in the per-turn openWorldDetected/inGame truth they pass in.
 *
 * NOTE: sendChatMessage appends the player's new message to the transcript
 * BEFORE calling this, so readChatContext here already includes it — do not
 * hoist this call above that append.
 */
async function prepareChatTurn(
  characterId: string,
  opts: {
    openWorldDetected: boolean;
    inGame: boolean;
    voiceCall?: boolean;
    voicePeers?: string[];
    /** Cap the transcript to the last N rows (voice calls, see VOICE_RECENT_CAP). */
    recentCap?: number;
  },
) {
  const character = await getCharacter(characterId);
  if (!character) return null;
  const config = await loadConfig();
  // Watermark-based context (260702): every not-yet-summarized message verbatim
  // (50-99 between folds) + the rolling summary. Pure read — the batch fold runs
  // in the background AFTER the reply (see foldIfDue).
  const [{ summary, history }, memory] = await Promise.all([
    readChatContext(characterId),
    readMemoryTail(characterId),
  ]);
  // Same source + clamp the bot uses (character.metadata.proactiveness), so the
  // character is as forward in chat as it is in-game.
  const proactiveness = clampProactiveness(character.metadata?.proactiveness);
  // Same source the bot uses (character.metadata.punctuation), so the character
  // texts with the same register in-app as in-game.
  const punctuation = clampPunctuation(character.metadata?.punctuation);
  const system = buildSystemBlocks({
    persona: character.persona,
    name: character.name,
    preferredName: config.preferred_name ?? '',
    proactiveness,
    punctuation,
    memory,
    summary,
    openWorldDetected: opts.openWorldDetected,
    inGame: opts.inGame,
    voiceCall: opts.voiceCall === true,
    voicePeers: opts.voicePeers,
    // 260709: conversation language — read per turn (loadConfig above), so a
    // Settings change applies from the very next message with no restart.
    language: clampChatLanguage(config.chat_language),
  });
  // Voice: only the last N rows go to the model (VOICE_RECENT_CAP). Slice the raw
  // transcript BEFORE toMessages so role-merge + first-must-be-user still hold.
  const windowed = opts.recentCap ? history.slice(-opts.recentCap) : history;
  const messages = toMessages(windowed);
  return { character, config, system, messages, punctuation };
}

/**
 * Split a reply on blank lines (task 8) into separate persisted companion
 * messages — each its own bubble in the UI, revealed one at a time — and append
 * them in order (ascending ts so ordering is stable). Shared by the normal turn
 * and the launch-failed turn.
 */
/**
 * Silence-by-convention (260707): models cannot produce an empty reply, but
 * they reliably WRITE a placeholder — "(silence)", "(staying silent)",
 * "[says nothing]" — when told quiet is fine. That is the official silence
 * mechanism on the VOICE-CALL surface only: the call prompts instruct "reply
 * with exactly (silence)", and every voice reply path parses it out, so the
 * line is never persisted or spoken and the turn simply ends with no reply
 * (which also lets a group banter chain rest). Typed text chat never prompts
 * the convention, so there a "*stays silent*" is a real in-character beat and
 * must pass through untouched. Only bracketed/asterisked forms match: a bare
 * in-character "silence!" is a real line and passes through.
 * Models embellish the marker with a trailing clause — real captured examples:
 * "(staying silent, letting it rest)", "(saying nothing, the thread has
 * landed)", "(nothing)" — so after a silence keyword the rest of the aside is
 * allowed (anything up to the closing bracket), and bare "(nothing)" matches
 * too. A line with content AFTER the closing bracket is real and passes.
 * Mirrors the say()-side backstop in src/bot/brain/orchestrator.js
 * (postProcessSay) — keep the two patterns in sync.
 *
 * 260709 (conversation language): the # LANGUAGE directive tells the model to
 * keep the marker as the literal English "(silence)", but under a "speak
 * Japanese" instruction it sometimes localizes it anyway, so the pattern also
 * accepts the common localized forms: silen[a-z]* covers silence / silent /
 * silencio / silencieux..., nada / rien are the "(nothing)" equivalents, and
 * the silen-stem and CJK keywords (沉默 / 无言 zh, 沈黙 / 無言 ja, 침묵 / 조용 ko)
 * allow a short lead-in ("reste silencieux", 保持沉默, 계속 침묵) — CJK also
 * needs this shape because \b never matches between two non-word chars.
 */
const SILENCE_FILLER_RE =
  /^\s*[([*]+\s*(?:nothing|(?:(?:stay(?:s|ing)?\s+(?:silent|quiet)|remain(?:s|ing)?\s+(?:silent|quiet)|say(?:s|ing)?\s+nothing|no\s+reply|no\s+response|nada|rien)\b|[^)\]]{0,12}(?:silen[a-z]*|沉默|无言|沈黙|無言|침묵|조용))[^)\]]*)\s*[)\]*.!]*\s*$/i;
export function isSilenceFiller(text: string): boolean {
  return SILENCE_FILLER_RE.test(text);
}

/**
 * Peer-impersonation drop (260708). On a group call the transcript attributes
 * other companions' lines as "(Name, on the call): ...", and a model
 * occasionally ECHOES the convention — writing a fabricated line for the OTHER
 * companion inside its own reply (live capture: Marv's streamed reply opened
 * with "(Sui, on the call): oh let's go..." spoken in Marv's TTS voice, and a
 * ghost Sui line landed in the transcript she never said). The prefix is ours,
 * injected only on heard lines — a companion's own reply never legitimately
 * starts with it — so any reply part carrying it is fabricated dialogue and is
 * dropped before it is persisted or spoken. Voice paths only, next to the
 * silence-filler drop. Line-level, operating on the raw reply (it splits on
 * every newline itself), so only the impersonated lines are removed and the
 * rest is rejoined — independent of how splitReply later bubbles the text.
 */
const PEER_IMPERSONATION_RE = /^\s*\(\s*[^()\n]{1,60},\s*on the call\s*\)\s*:/i;
export function stripPeerImpersonation(text: string): string {
  return text
    .split('\n')
    .filter((l) => !PEER_IMPERSONATION_RE.test(l))
    .join('\n')
    .trim();
}

async function persistReplies(
  characterId: string,
  replyText: string,
  punctuation: 'casual' | 'deliberate' = 'casual',
  opts?: { voice?: boolean },
): Promise<ChatMessage[]> {
  const now = Date.now();
  // Silence-filler drop is voice-only (see SILENCE_FILLER_RE): typed chat never
  // prompts the "(silence)" convention, so a filler-shaped line there is a real
  // reply and persisting it beats silently losing the turn.
  const parts = splitReply(replyText, punctuation);
  const replies: ChatMessage[] = (opts?.voice
    ? parts.map(stripPeerImpersonation).filter((text) => text && !isSilenceFiller(text))
    : parts)
    .map((text, i) => ({
    id: randomUUID(),
    role: 'companion',
    text,
    ts: now + i,
    // Spoken on a live call → hidden in the chat UI (see ChatMessage.voice).
    ...(opts?.voice ? { voice: true } : {}),
  }));
  for (const reply of replies) await chatStore.appendMessage(characterId, reply);
  return replies;
}

export async function sendChatMessage(
  args: {
    characterId: string;
    text: string;
    replyTo?: ChatMessage['replyTo'];
    voiceCall?: boolean;
    /** Multi-companion voice (260706): names of the OTHER companions on the same
     * call, so the prompt frames the group. Absent/empty = a solo call. */
    voicePeers?: string[];
  },
  deps: ChatDeps,
): Promise<ChatSendResult> {
  // #9 — supersede any in-flight turn for this character: abort its LLM call so
  // this new message interrupts + replaces it. `superseded()` catches the race
  // where the old call resolved between abort() and the abort taking effect.
  inflight.get(args.characterId)?.abort();
  const ctrl = new AbortController();
  inflight.set(args.characterId, ctrl);
  const superseded = (): boolean => inflight.get(args.characterId) !== ctrl;

  try {
    const character = await getCharacter(args.characterId);
    if (!character) throw new Error('Character not found');
    const config = await loadConfig();

    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      text: args.text,
      ts: Date.now(),
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      // Sent during a live call (a transcribed utterance, or typed mid-call —
      // either way the exchange is spoken) → hidden in the chat UI.
      ...(args.voiceCall === true ? { voice: true } : {}),
    };
    await chatStore.appendMessage(args.characterId, userMsg);

    // Task 4 — if the companion is live in-game, route this message INTO that
    // session (same brain + prompt cache) instead of the standalone chat brain,
    // so the two surfaces are one conversation. The bot receives it as an
    // out-of-band "message via Sei chat" and replies asynchronously over the
    // chat:message push; we return `routed` so the renderer keeps the typing
    // indicator up until that reply lands. Falls through to the chat brain if
    // the session vanished between the check and the post.
    if (deps.isInGame?.(args.characterId) && deps.routeToBot) {
      const from = (config.preferred_name ?? '').trim() || 'The player';
      // 260708: a mid-call utterance reaching an in-game bot is live speech,
      // not an out-of-band app text. The voice flag switches the bot-side
      // framing (deliverSeiChat) from the "Sei chat / NOT in the game" wrapper
      // to in-game voice delivery.
      if (deps.routeToBot(args.characterId, { from, text: args.text, voice: args.voiceCall === true })) {
        // In-game chatter appends to the transcript without ever running a
        // standalone chat turn, so drain any fold backlog from here too —
        // otherwise a long play session could grow the window unbounded.
        void foldIfDue(args.characterId, character.persona.expanded).catch(() => {});
        // A routed exchange is still a chat — stamp last_chatted here too, or
        // the Home card keeps calling a companion the player talks to in-game
        // "New". Best-effort, same as the standalone-turn stamp below.
        try {
          await patchCharacter(args.characterId, (c) => ({ ...c, last_chatted: new Date().toISOString() }));
        } catch (err) {
          console.warn(`[sei] failed to stamp last_chatted for ${args.characterId}: ${(err as Error).message}`);
        }
        return { replies: [], routed: true };
      }
    }

    // Build the prompt AFTER the user message is appended above, so the turn's
    // context includes it. Per-turn truth passed in:
    //   openWorldDetected — is an open-to-LAN world detected right now? Lets the
    //     model decide launch() vs. open-to-LAN instructions.
    //   inGame — usually false here (a live session routes messages in-game), but
    //     re-read so the routed-then-vanished fallback and any races tell the truth.
    const prep = await prepareChatTurn(args.characterId, {
      openWorldDetected: deps.getLanState().kind === 'open',
      inGame: deps.isInGame?.(args.characterId) ?? false,
      // 260705: while a voice call is open the reply is read aloud by TTS, so
      // the system prompt leads with the voice-call primer (spoken register).
      voiceCall: args.voiceCall === true,
      // 260706: on a multi-companion call, name the other companions on the line.
      voicePeers: args.voicePeers,
      // 260706: a live call sends only the last few rows (memory + summary carry
      // the rest), so the prompt stays small and the reply comes back fast.
      recentCap: args.voiceCall === true ? VOICE_RECENT_CAP : undefined,
    });
    if (!prep) throw new Error('Character not found');
    const { system, messages } = prep;
    // Fold any pending steering thoughts into this turn (ephemeral; drained here
    // so they ride this prompt once and never persist). Not drained on the
    // routed-to-bot path above: in-game routing is out of scope for thoughts.
    foldUserNote(messages, renderThoughtNote(drainThoughts(args.characterId)));
    // Prompt caching (260706): mark the last message AFTER every foldUserNote —
    // the transcript is then cached prefix-incrementally across the call's turns.
    markLastMessageCached(messages);
    const { client, model } = await buildChatSdk();

    // Voice calls (260706): STREAM the reply so TTS can start on sentence 1 while
    // the model is still writing the rest, instead of waiting for the whole reply
    // (the "8s before the companion speaks" latency). Each completed sentence is
    // persisted (voice-flagged) and pushed to the renderer immediately via
    // deps.emitReply; the renderer speaks it and, because we return streamed:true,
    // does NOT re-speak the returned replies.
    // Typed chat NEVER streams (settled 260709 after two live trials): the
    // casual texting register writes punctuation-less lines separated by blank
    // lines, so sentence streaming finds no boundaries — the reply still
    // arrived all at once, then splitReply dumped it as an unpaced wall of
    // bubbles. Typed chat keeps the blocking path in BOTH realistic-typing
    // modes; its latency floor is the model round trip.
    const isVoice = args.voiceCall === true && typeof deps.emitReply === 'function';
    const isStreaming = isVoice;
    const streamedReplies: ChatMessage[] = [];
    let streamBuf = '';
    const emitStreamedBubble = async (raw: string): Promise<void> => {
      for (const raw_b of splitReply(raw, prep.punctuation)) {
        // The silence-filler and peer-impersonation drops stay VOICE-scoped
        // (matching persistReplies): typed chat never prompts the "(silence)"
        // convention, so a filler-shaped line there is a real reply.
        const b = isVoice ? stripPeerImpersonation(raw_b) : raw_b;
        if (!b || (isVoice && isSilenceFiller(b))) continue;
        const msg: ChatMessage = {
          id: randomUUID(),
          role: 'companion',
          text: b,
          ts: Date.now() + streamedReplies.length, // monotonic within the turn
          // Spoken on a live call → hidden in the chat UI; typed bubbles show.
          ...(args.voiceCall === true ? { voice: true } : {}),
        };
        streamedReplies.push(msg);
        await chatStore.appendMessage(args.characterId, msg);
        deps.emitReply?.(args.characterId, msg);
      }
    };

    let launch: ChatSendResult['launch'];
    let replyText = '';
    // Task 2 — the actual summon is deferred until AFTER the reply is persisted,
    // so the companion's "hopping in" acknowledgement lands in chat before the
    // live-session popup (SummonedWidget) appears. Set when launch() resolves to
    // an open world; fired at the end of the turn.
    let startSummon = false;
    // Voice calls (260705) — the model called end_call(): returned to the
    // renderer, which speaks the goodbye replies first, then hangs up.
    let endCallRequested = false;
    // Set when the model logged off (quit) this turn — pairs with endCallRequested
    // for the double-goodbye guard below.
    let quitCalled = false;
    // Set when the model called launch this turn. A quit+launch ("log off and hop
    // back in") must keep looping for its "hopping back in" line, so the
    // double-goodbye break must NOT fire when a launch rode along.
    let launchCalled = false;
    // end_call + remember are offered only while a call is open (block 0
    // already flips for the primer, so this adds no extra cache churn).
    const tools =
      args.voiceCall === true ? [LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL, REMEMBER_TOOL] : [LAUNCH_TOOL, QUIT_TOOL];

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      // Hard cap kept low so a reply can't ratchet into paragraphs. Each turn
      // feeds the model its own prior replies (toMessages), and with a generous
      // ceiling it self-conditions on the last (longest) turn and creeps up a
      // sentence each time. 200 tokens comfortably fits the 1–2 sentence target
      // from the system prompt without truncating mid-sentence.
      const params = {
        model,
        max_tokens: 200,
        system,
        tools,
        stop_sequences: TRANSCRIPT_STOP_SEQUENCES,
        messages: messages as never,
      };
      // #9 — abortable: a follow-up send aborts this signal.
      const opts = { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal };
      const t0 = Date.now();
      let res: Anthropic.Messages.Message;
      if (isStreaming) {
        const stream = client.messages.stream(params, opts);
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            streamBuf += ev.delta.text;
            const { sentences, rest } = takeSentences(streamBuf);
            streamBuf = rest;
            for (const s of sentences) await emitStreamedBubble(s);
          }
        }
        res = await stream.finalMessage();
        // This hop's trailing partial (a final sentence with no boundary punct,
        // or the whole reply when the model ends without terminal punctuation).
        if (streamBuf.trim()) await emitStreamedBubble(streamBuf);
        streamBuf = '';
      } else {
        res = await client.messages.create(params, opts);
      }
      // Instrumentation (260706): per-hop timing + token usage, so cache hits
      // (cacheRead > 0) and overload retries (a slow hop) are visible in the dev
      // log the way a gameplay turn is. One compact line per LLM round-trip.
      const u = res.usage;
      console.log(
        `[sei/chat] turn char=${args.characterId.slice(0, 8)} hop=${hop} voice=${isVoice} ` +
          `${Date.now() - t0}ms in=${u?.input_tokens ?? '?'} out=${u?.output_tokens ?? '?'} ` +
          `cacheRead=${u?.cache_read_input_tokens ?? 0} cacheWrite=${u?.cache_creation_input_tokens ?? 0}`,
      );
      const text = textOf(res.content);
      if (text) replyText = text;

      // With two tools offered the model may call both in one response (e.g.
      // quit + launch for "log off and hop back in"). Every tool_use id in an
      // assistant turn MUST get a matching tool_result in the next user message
      // or the follow-up create() 400s — so answer ALL of them, not just the
      // first.
      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) break;

      messages.push({ role: 'assistant', content: res.content });
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        let note: string;
        if (toolUse.name === 'launch') {
          launchCalled = true;
          const game = String((toolUse.input as { game?: string })?.game ?? 'minecraft');
          const result = resolveLaunch(game, deps);
          launch = result.launch;
          // Defer the real join — don't fire summon mid-loop (task 2).
          if (result.summon) startSummon = true;
          note = result.note;
        } else if (toolUse.name === 'quit_game') {
          // Task 5 — leave the game from chat. End the live session (no-op when
          // none is live) and tell the model it has logged off.
          quitCalled = true;
          deps.leaveGame?.(args.characterId);
          note =
            'You have left the Minecraft world and logged off. You are back in chat only now — ' +
            'say a short goodbye if you have not already. Do not claim you are still in the game.';
        } else if (toolUse.name === 'end_call') {
          // Voice calls (260705) — hang up. The actual teardown is renderer-side
          // (it must finish speaking the goodbye first), so just flag the result.
          endCallRequested = true;
          note =
            'You are hanging up the call — it ends right after this turn. ' +
            'If you have not said goodbye yet, say it now (it is still spoken aloud). ' +
            'The player can still reach you in text chat afterward.';
        } else if (toolUse.name === 'remember') {
          // Voice calls (260707) — same MEMORY.md the game brain writes, so what
          // the player shares on a call carries into future sessions everywhere.
          // Best-effort like honorRememberCalls: a failed write (disk full,
          // permissions) must never abort the turn — the reply still lands.
          const memText = String((toolUse.input as { text?: string })?.text ?? '').trim();
          if (memText) {
            try {
              await appendMemory(path.join(paths.memoryDir(args.characterId), 'MEMORY.md'), memText);
              note = 'Saved to your memory. Continue your reply; do not mention saving it.';
            } catch (err) {
              console.warn(`[sei] chat remember() append failed: ${(err as Error).message}`);
              note = 'The memory could not be saved. Continue your reply; do not mention it.';
            }
          } else {
            note = 'Nothing was saved; the text was empty.';
          }
        } else {
          // Unreachable with the closed tool set, but an unanswered tool_use
          // would poison the next hop — answer it rather than break mid-turn.
          note = `The tool "${toolUse.name}" is not available. Reply without using tools.`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: note });
      }
      messages.push({ role: 'user', content: toolResults });

      // Double-goodbye guard (260706): the quit/end_call tool notes tell the model
      // to "say goodbye if you have not already". If it ALREADY spoke this turn,
      // running another hop just produces a redundant second farewell (the "double
      // message" on hang-up / log-off). Stop here — the reply + endCall/quit side
      // effects are already recorded. Keep looping only when nothing was said yet
      // (the goodbye still needs to land) or a relaunch is pending (quit+launch
      // "log off and hop back in" needs its follow-up "hopping back in" line).
      const spokeThisTurn = isStreaming ? streamedReplies.length > 0 : Boolean(replyText.trim());
      if ((endCallRequested || quitCalled) && spokeThisTurn && !launchCalled) break;
    }

    // #9 — if a newer send arrived (or we were aborted) while this turn ran,
    // drop the reply rather than append a stale one.
    if (ctrl.signal.aborted || superseded()) {
      const e = new Error(CHAT_ABORTED);
      e.name = 'AbortError';
      throw e;
    }

    // Voice streaming already persisted + pushed each sentence as it completed;
    // reuse those rows. Typed chat (and the non-streaming voice fallback) persists
    // the whole reply here as usual. On a VOICE turn a "(silence)" reply persists
    // NOTHING: the voice-scoped filler filter inside persistReplies removes it
    // before the "…" fallback could ever apply (splitReply already returned a
    // non-empty part). Typed chat keeps such lines — they are real replies there.
    const replies = isStreaming
      ? streamedReplies
      : await persistReplies(args.characterId, replyText, prep.punctuation, {
          voice: args.voiceCall === true,
        });

    // Background compaction (260702): the reply is persisted, so if 50+
    // messages have aged past the window, fold them NOW — while the player is
    // typing — rather than making some future turn (or a summon) pay for it.
    // Fire-and-forget; single-flighted inside foldIfDue.
    void foldIfDue(args.characterId, character.persona.expanded).catch(() => {});

    // Task 2 — NOW that the "hopping in" reply is persisted (and about to be
    // returned + rendered), kick off the real join. Firing it here rather than
    // mid-loop guarantees the acknowledgement message lands before the live-
    // session popup appears. Still non-blocking: a full join can take many
    // seconds, so we never await it on the chat turn.
    if (startSummon) {
      void deps.summon(args.characterId).catch((e) => {
        deps.onLaunchFailed?.(args.characterId, (e as Error)?.message ?? 'unknown error');
      });
    }

    // #6 — stamp last_chatted on a successful reply so a plain chat counts as a
    // "last interaction" for the card date + ordering (device-local, like
    // last_launched; the cloud upsert omits it). Best-effort — a persistence
    // hiccup must not fail the chat turn. 260705: patchCharacter, never a spread
    // of the turn-opening `character` snapshot — it predates the LLM round-trip,
    // and spreading that stale copy would silently revert any edit the player
    // saved while the reply was generating.
    try {
      await patchCharacter(args.characterId, (c) => ({ ...c, last_chatted: new Date().toISOString() }));
    } catch (err) {
      console.warn(`[sei] failed to stamp last_chatted for ${args.characterId}: ${(err as Error).message}`);
    }

    return { replies, launch, ...(endCallRequested ? { endCall: true } : {}), ...(isStreaming ? { streamed: true } : {}) };
  } catch (err) {
    // Interrupt/supersede surfaces as a typed sentinel so the renderer can tell
    // it apart from a real failure (and NOT show the "sorry" fallback).
    if (isAbortError(err) || ctrl.signal.aborted || superseded()) {
      const e = new Error(CHAT_ABORTED);
      (e as Error & { code?: string }).code = CHAT_ABORTED;
      throw e;
    }
    throw err;
  } finally {
    // Only clear the map if we're still the current turn (a superseding send
    // already replaced the entry and must keep its own controller).
    if (inflight.get(args.characterId) === ctrl) inflight.delete(args.characterId);
  }
}

/**
 * 260702 (task 2): the deferred join kicked off by launch() failed AFTER the
 * companion already told the player it was hopping in. Without a correcting
 * turn, the companion's own transcript says it joined — so later turns insist
 * "i'm already in" while nothing is in the world. Run a short persona-voiced
 * turn around an ephemeral system note so the companion (a) learns the join
 * failed and (b) tells the player in its own words; its reply is persisted, so
 * the correction survives into every future turn's history. No tools are
 * offered — this turn reports the failure, it must not retry the launch.
 * Replies are persisted here; the caller pushes them to the renderer.
 */
export async function sendLaunchFailedTurn(
  characterId: string,
  reason: string,
): Promise<ChatMessage[]> {
  const prep = await prepareChatTurn(characterId, {
    openWorldDetected: false,
    // This turn exists BECAUSE the join failed — the companion is not in-game.
    inGame: false,
  });
  if (!prep) return [];
  const { system, messages } = prep;
  // Keep the model-facing reason to a single sanitized line — the raw summon
  // error can carry a multi-line stderr tail.
  const shortReason = (reason || 'unknown error').split('\n')[0].slice(0, 200);
  const note =
    `[System note — not the player speaking: your attempt to join the Minecraft world just failed (${shortReason}). ` +
    'You never made it in; you are NOT in the world, you are still here in chat. ' +
    'Tell the player the join failed and that you can try again — one short line, in your own voice. Do not pretend you got in.]';
  // Anthropic requires strict role alternation; fold the note into a trailing
  // user turn (e.g. the player typed something while the join was dying) rather
  // than appending a second user message.
  foldUserNote(messages, note);
  // Any steering thoughts queued for this character ride this turn too, as a
  // second user-side aside (drained so they never persist).
  foldUserNote(messages, renderThoughtNote(drainThoughts(characterId)));

  const { client, model } = await buildChatSdk();
  const res = await client.messages.create(
    { model, max_tokens: 200, system, stop_sequences: TRANSCRIPT_STOP_SEQUENCES, messages: messages as never },
    { timeout: CHAT_TIMEOUT_MS },
  );
  const replyText = textOf(res.content);
  if (!replyText) return [];
  return persistReplies(characterId, replyText, prep.punctuation);
}

/**
 * In-flight first-meeting turn per character. A second chat:opened arriving
 * while one runs returns the same promise instead of firing a duplicate greeting.
 */
const firstMeetingInflight = new Map<string, Promise<ChatMessage[]>>();

/**
 * First-meeting greeting (thoughts consumer #1). When the player first opens chat
 * with a freshly met companion, the companion speaks FIRST, steered by
 * THOUGHT_FIRST_MEETING. Applies to ALL three companion kinds — 'unique'
 * (system-cast), 'custom' (user-authored), and 'world' (invited from the World
 * tab, incl. bundled defaults): each is "just summoned by this human" from its
 * own perspective, and its persona (already folded into the system prompt by
 * prepareChatTurn) is what makes the greeting sound like the right character, so
 * one shared steering constant covers all three with no per-kind LLM call. No-op
 * (returns []) unless BOTH hold:
 *   - the persisted transcript is EMPTY, and
 *   - the character has never been chatted with (!last_chatted), which guards the
 *     transcript-cleared case, where "you were just summoned" would be a lie.
 * Single-flight per character. We do NOT stamp last_chatted (the player has not
 * spoken yet); the greeting's own persisted reply makes the transcript non-empty,
 * so the next open sees a non-empty transcript and the turn won't refire. Because
 * eligibility is recomputed from PERSISTED state (transcript + last_chatted) on
 * every open, a first meeting deferred to a later session still fires then. No
 * tools are offered; this turn only speaks.
 *
 * The renderer calls this on every empty-history open and lets main no-op; policy
 * (emptiness) lives here, never in the renderer.
 */
export async function sendFirstMeetingTurn(
  characterId: string,
  deps?: Pick<ChatDeps, 'getLanState'>,
): Promise<ChatMessage[]> {
  const existing = firstMeetingInflight.get(characterId);
  if (existing) return existing;

  const run = (async (): Promise<ChatMessage[]> => {
    const character = await getCharacter(characterId);
    if (!character) return [];
    // All companion kinds get the first-meeting greeting (unique / custom /
    // world) — the kind gate that once restricted this to system-cast uniques
    // was dropped so user-authored and World-invited companions greet too.
    if (character.last_chatted) return [];
    const transcript = await chatStore.readAll(characterId);
    if (transcript.length > 0) return [];

    pushThought(characterId, THOUGHT_FIRST_MEETING);
    const prep = await prepareChatTurn(characterId, {
      openWorldDetected: deps?.getLanState?.().kind === 'open',
      inGame: false,
    });
    if (!prep) return [];
    const { system, messages } = prep;
    // The transcript is empty, so messages is empty: the drained thought becomes
    // the (only) user message, satisfying Anthropic's "first message is user".
    foldUserNote(messages, renderThoughtNote(drainThoughts(characterId)));

    // Register in the per-character `inflight` slot (like sendVoiceGreetingTurn)
    // so a user message sent while this greeting is in flight aborts/supersedes
    // it — otherwise the two run concurrently and the reply persists first, then
    // the cold greeting lands out of order. The firstMeetingInflight map above
    // still dedupes duplicate chat:opened events; this guards the user-race.
    inflight.get(characterId)?.abort();
    const ctrl = new AbortController();
    inflight.set(characterId, ctrl);
    try {
      const { client, model } = await buildChatSdk();
      const res = await client.messages.create(
        { model, max_tokens: 200, system, stop_sequences: TRANSCRIPT_STOP_SEQUENCES, messages: messages as never },
        { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
      );
      if (ctrl.signal.aborted || inflight.get(characterId) !== ctrl) return [];
      const replyText = textOf(res.content);
      if (!replyText) return [];
      return await persistReplies(characterId, replyText, prep.punctuation);
    } catch (err) {
      // Superseded by a real user message — the greeting is best-effort, so a
      // deliberate abort is not a failure; drop it silently. Real errors still
      // propagate to the caller.
      if (isAbortError(err) || ctrl.signal.aborted || inflight.get(characterId) !== ctrl) {
        return [];
      }
      throw err;
    } finally {
      if (inflight.get(characterId) === ctrl) inflight.delete(characterId);
    }
  })().finally(() => {
    firstMeetingInflight.delete(characterId);
  });

  firstMeetingInflight.set(characterId, run);
  return run;
}

/**
 * Voice calls (260705): the call pipeline just went LIVE and the character has
 * no in-game session — run a short persona-voiced turn so the companion speaks
 * FIRST (like answering the phone), instead of dead air until the player talks.
 * Same ephemeral-system-note pattern as sendLaunchFailedTurn; the reply is
 * persisted (it is a real thing the companion said) and returned for the
 * caller to push, where the renderer speaks it via TTS.
 *
 * Registered in the same per-character `inflight` slot as sendChatMessage so a
 * player who starts talking immediately supersedes the greeting turn instead
 * of racing it (two replies interleaving on the call).
 */
export async function sendVoiceGreetingTurn(
  characterId: string,
  peers: string[] = [],
): Promise<ChatMessage[]> {
  inflight.get(characterId)?.abort();
  const ctrl = new AbortController();
  inflight.set(characterId, ctrl);
  try {
    const prep = await prepareChatTurn(characterId, {
      openWorldDetected: false,
      inGame: false,
      voiceCall: true,
      voicePeers: peers,
      recentCap: VOICE_RECENT_CAP,
    });
    if (!prep) return [];
    const { system, messages } = prep;
    // Multi-companion (260706): a companion ADDED to an ongoing call greets the
    // group (it is joining a call already in progress), not the player cold.
    const note =
      peers.length > 0
        ? `[System note — not the player speaking: you were just added to an ongoing group voice call with the player and ${peers.join(' and ')}. ` +
          'Announce yourself to the room in one short spoken line, in your own voice, like walking into a call already in progress. Do not mention this note.]'
        : '[System note — not the player speaking: the player just started a voice call with you ' +
          'and the line is live now. Greet them first, like answering the phone: one short line, ' +
          'in your own voice. They often call with no particular reason, just to hang out, so do not ' +
          'ask why they called or what is up. You can bring up something you remember about them, ' +
          'or just say hi. Do not mention this note.]';
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') {
      last.content = `${last.content}\n${note}`;
    } else {
      messages.push({ role: 'user', content: note });
    }

    const { client, model } = await buildChatSdk();
    // Cache PREWARM (260706): this greeting fires while the call is still
    // dialing. Offer the SAME tools a live user turn does — tools sit at the
    // front of the prompt-cache prefix, so a greeting with no tools warms a
    // DIFFERENT cache than the user turn reads (the "first reply was a cacheWrite,
    // not a cacheRead" symptom). Matching them writes the tools+system prefix
    // here, during the ring, so the first spoken user reply is a fast cache READ.
    markLastMessageCached(messages);
    const tools = [LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL, REMEMBER_TOOL];
    const res = await client.messages.create(
      { model, max_tokens: 200, system, tools, stop_sequences: TRANSCRIPT_STOP_SEQUENCES, messages: messages as never },
      { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
    );
    if (ctrl.signal.aborted || inflight.get(characterId) !== ctrl) return [];
    await honorRememberCalls(characterId, res.content);
    const replyText = textOf(res.content);
    if (!replyText) return [];
    return await persistReplies(characterId, replyText, prep.punctuation, { voice: true });
  } catch (err) {
    // Superseded by a real message (or a real failure) — the greeting is
    // best-effort either way; the call works without it.
    if (!isAbortError(err)) {
      console.warn(`[sei] voice greeting turn failed: ${(err as Error).message}`);
    }
    return [];
  } finally {
    if (inflight.get(characterId) === ctrl) inflight.delete(characterId);
  }
}

/**
 * Multi-companion voice (260706): record a line spoken on the call into
 * `characterId`'s transcript WITHOUT running a turn, so a companion who is not
 * the one currently responding still has the context (the player's words, or
 * another companion's line) when its own turn comes up. Voice-flagged (hidden
 * from the chat view). Player lines are recorded verbatim; companion lines are
 * prefixed "(Name, on the call): ..." to match the group-call attribution.
 */
export async function observeVoiceLine(
  characterId: string,
  from: string,
  text: string,
): Promise<void> {
  const isPlayer = from === 'player' || from === '';
  const row: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    text: isPlayer ? text : `(${from}, on the call): ${text}`,
    ts: Date.now(),
    voice: true,
  };
  try {
    await chatStore.appendMessage(characterId, row);
  } catch (err) {
    console.warn(`[sei] observeVoiceLine failed for ${characterId}: ${(err as Error).message}`);
  }
}

/**
 * Multi-companion voice (260706): companion `characterId` HEARD another
 * companion (`speakerName`) say `text` on the same call, and gets a turn to
 * react in character — or to stay silent (returns [] when the model produces no
 * text). This is the seam the renderer's voice director uses to make two
 * companions actually converse: after A speaks, B is handed A's line here.
 *
 * The heard line is persisted into B's transcript as a voice-flagged user row
 * PREFIXED with the speaker's name in parentheses ("(Sui, on the call): ..."),
 * matching the attribution convention the group-call prompt note describes, so
 * later turns remember the banter and never mistake a companion for the player.
 * B's own reply is persisted voice-flagged too (hidden from the chat view).
 *
 * No tools are offered: a cross-companion reaction should just talk, not launch
 * or hang up (the player or the primary companion drives those). Registered in
 * the same per-character `inflight` slot as sendChatMessage so a player barge-in
 * (a new real utterance to this companion) supersedes an in-flight reaction.
 */
export async function sendCompanionVoiceTurn(
  characterId: string,
  ctx: {
    speakerName: string;
    text: string;
    peers: string[];
    depth?: number;
    /** 260708: live LAN truth. This turn used to hardcode `false`, so a
     * call-only companion whose sibling was already IN the world was told no
     * world existed — and repeated the "open to LAN" instructions to a player
     * standing in their open world. */
    openWorldDetected?: boolean;
    /** 260708: honor a launch() call from this single-shot turn (no tool loop
     * runs here, so without this the model says "hopping in" and nothing
     * happens — the join only worked once the in-game sibling disconnected). */
    onLaunch?: () => void;
  },
): Promise<ChatMessage[]> {
  inflight.get(characterId)?.abort();
  const ctrl = new AbortController();
  inflight.set(characterId, ctrl);
  try {
    const heard: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      text: `(${ctx.speakerName}, on the call): ${ctx.text}`,
      ts: Date.now(),
      voice: true,
    };
    await chatStore.appendMessage(characterId, heard);

    const prep = await prepareChatTurn(characterId, {
      openWorldDetected: ctx.openWorldDetected === true,
      inGame: false,
      voiceCall: true,
      voicePeers: ctx.peers,
      recentCap: VOICE_RECENT_CAP,
    });
    if (!prep) return [];
    const { system, messages } = prep;
    // As banter runs long, nudge toward a NATURAL wind-down so an ongoing
    // exchange tapers off on its own (a companion letting it rest ends the chain)
    // instead of running until the director's hard cap. Kicks in a few turns in.
    const windDown =
      (ctx.depth ?? 0) >= 4
        ? ' This back-and-forth has gone on a while, so let it breathe: only add another line if you genuinely have something new, otherwise let it rest by replying with exactly (silence).'
        : '';
    const note =
      `[System note — not the player speaking: ${ctx.speakerName} just said the line above on the call. ` +
      'If there is a live thread worth continuing, react in your own voice in ONE short spoken line, building on it rather than closing it off. ' +
      'If the exchange has genuinely run its course, reply with exactly (silence) and nothing else; it is never spoken, it just ends your turn quietly.' +
      windDown +
      ' Do not mention this note.]';
    foldUserNote(messages, note);
    // Share the same warm tools+system cache prefix as every other voice turn.
    markLastMessageCached(messages);

    const { client, model } = await buildChatSdk();
    const tools = [LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL, REMEMBER_TOOL];
    const res = await client.messages.create(
      { model, max_tokens: 200, system, tools, stop_sequences: TRANSCRIPT_STOP_SEQUENCES, messages: messages as never },
      { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
    );
    if (ctrl.signal.aborted || inflight.get(characterId) !== ctrl) return [];
    await honorRememberCalls(characterId, res.content);
    // 260708: honor launch() the same single-shot way remember() is honored —
    // the caller (ipc) gates it on a live open world and fires the summon.
    if (ctx.onLaunch && res.content.some((b) => b.type === 'tool_use' && b.name === 'launch')) {
      try { ctx.onLaunch(); } catch { /* best-effort — the reply still lands */ }
    }
    const replyText = textOf(res.content);
    if (!replyText) return [];
    return await persistReplies(characterId, replyText, prep.punctuation, { voice: true });
  } catch (err) {
    if (!isAbortError(err)) {
      console.warn(`[sei] companion voice turn failed: ${(err as Error).message}`);
    }
    return [];
  } finally {
    if (inflight.get(characterId) === ctrl) inflight.delete(characterId);
  }
}

/**
 * Idle conversation starter (260707). The renderer's call-idle timer fires this
 * when a live call has been quiet for a stretch: `characterId` gets a nudge to
 * start a topic, or to stay quiet by replying (silence). Unlike every other turn, this
 * must NOT preempt a real one — if anything is already in flight for this
 * character (the player just spoke, a greeting is generating), the conversation
 * is not actually idle, so the nudge is skipped instead of aborting it. Once
 * running it sits in the same `inflight` slot, so a real player message
 * supersedes IT, and the renderer additionally drops the reply if the player
 * spoke while it generated.
 *
 * Returns `{ messages, endCall }`: the spoken lines, plus `endCall: true` when
 * the model hung up this turn (end_call). The renderer speaks `messages` (the
 * goodbye) first, then runs its companion-hang-up path.
 */
export async function sendVoiceIdleTurn(
  characterId: string,
  quietSeconds: number,
  peers: string[] = [],
  /** 260708: live LAN truth + single-shot launch honor (see
   * sendCompanionVoiceTurn) — an idle nudge that says "i'll hop in" must
   * actually join instead of hanging. */
  opts: { openWorldDetected?: boolean; onLaunch?: () => void } = {},
): Promise<{ messages: ChatMessage[]; endCall?: boolean }> {
  // The nudge can race a hang-up (the renderer timer fires as the call ends).
  // Without this guard the turn still runs a full paid LLM round-trip and
  // persists a voice-flagged line that is never spoken anywhere.
  if (!isCallActive(characterId)) return { messages: [] };
  if (inflight.has(characterId)) return { messages: [] };
  const ctrl = new AbortController();
  inflight.set(characterId, ctrl);
  try {
    const prep = await prepareChatTurn(characterId, {
      openWorldDetected: opts.openWorldDetected === true,
      inGame: false,
      voiceCall: true,
      voicePeers: peers,
      recentCap: VOICE_RECENT_CAP,
    });
    if (!prep) return { messages: [] };
    const { system, messages } = prep;
    // Proactiveness-keyed nudge (260708): an agentic character (dial 2) is the
    // one who keeps a call alive — its nudge asks for a topic outright and
    // offers no silence option, so a quiet stretch reliably becomes
    // conversation (the same dial that makes it self-directed in-game). Lower
    // dials keep the original take-it-or-leave-it note with silence sanctioned.
    const proactive = clampProactiveness(prep.character.metadata?.proactiveness) >= 2;
    const quiet = Math.max(1, Math.round(quietSeconds));
    const note = proactive
      ? `[System note — not the player speaking: the conversation has been quiet for about ${quiet} seconds. ` +
        'Keep the call alive: say something in one short spoken line. Anything real works: a thought on your mind, ' +
        'something you remember about the player, something from earlier in this call, a question you actually want answered, ' +
        (peers.length ? 'something to rope the other companions on the call into, ' : '') +
        'or a new topic entirely. Pick whichever thread feels most alive and pull it. ' +
        'Do not greet them again and do not ask if they are still there. Do not mention this note.]'
      : `[System note — not the player speaking: the conversation has been quiet for about ${quiet} seconds. ` +
        'You can start a topic in one short spoken line: something you remember about the player, something from earlier in this call, or a genuine question. ' +
        'Or reply with exactly (silence) and let the quiet sit, which is completely fine; it is never spoken, it just ends your turn. ' +
        'Do not greet them again and do not ask if they are still there. Do not mention this note.]';
    foldUserNote(messages, note);
    // Same warm tools+system cache prefix as every other voice turn.
    markLastMessageCached(messages);
    const { client, model } = await buildChatSdk();
    const tools = [LAUNCH_TOOL, QUIT_TOOL, END_CALL_TOOL, REMEMBER_TOOL];
    const res = await client.messages.create(
      { model, max_tokens: 200, system, tools, stop_sequences: TRANSCRIPT_STOP_SEQUENCES, messages: messages as never },
      { timeout: CHAT_TIMEOUT_MS, signal: ctrl.signal },
    );
    if (ctrl.signal.aborted || inflight.get(characterId) !== ctrl) return { messages: [] };
    await honorRememberCalls(characterId, res.content);
    // No tool loop runs here, so honor end_call by flagging it for the caller:
    // "well, I'll let you go, bye" must actually hang up, not just be spoken
    // while later nudges keep firing. 260708: launch() is now honored too (via
    // opts.onLaunch, gated on a live open world by the caller) — a nudge turn
    // that says "i'll hop in" used to just hang. quit_game() stays unhonored
    // (the tool list is kept identical for prompt-cache warmth).
    if (opts.onLaunch && res.content.some((b) => b.type === 'tool_use' && b.name === 'launch')) {
      try { opts.onLaunch(); } catch { /* best-effort — the reply still lands */ }
    }
    const endCall = res.content.some((b) => b.type === 'tool_use' && b.name === 'end_call');
    const replyText = textOf(res.content);
    if (!replyText) return { messages: [], ...(endCall ? { endCall: true } : {}) };
    const spoken = await persistReplies(characterId, replyText, prep.punctuation, { voice: true });
    return { messages: spoken, ...(endCall ? { endCall: true } : {}) };
  } catch (err) {
    if (!isAbortError(err)) {
      console.warn(`[sei] voice idle turn failed: ${(err as Error).message}`);
    }
    return { messages: [] };
  } finally {
    if (inflight.get(characterId) === ctrl) inflight.delete(characterId);
  }
}

/**
 * Decide what a launch() tool call should do, WITHOUT side effects. The actual
 * summon is deferred to the caller (fired after the reply persists, task 2), so
 * this only reads the current LAN state and returns the model-facing note, the
 * launch descriptor, and whether a join should start.
 */
function resolveLaunch(
  game: string,
  deps: ChatDeps,
): { note: string; launch: NonNullable<ChatSendResult['launch']>; summon: boolean } {
  if (game !== 'minecraft') {
    return {
      note: `The game "${game}" is not available yet — only Minecraft can be launched right now. Tell the player it is coming soon.`,
      launch: { game, status: 'lan-not-open' },
      summon: false,
    };
  }
  const lan = deps.getLanState();
  if (lan.kind === 'open') {
    return {
      // The steering TEXT now lives in the thoughts module (the single seam a
      // future narrator edits). This consumer delivers it as a tool_result mid-
      // turn, so it uses the raw constant rather than the bracketed thought-note
      // framing (which would read oddly as a launch() result); the model-facing
      // meaning is identical: on the way in, say you're hopping in, don't claim
      // arrival, one short line.
      note: THOUGHT_JOINING_GAME,
      launch: { game, status: 'summoning' },
      summon: true,
    };
  }
  return {
    note:
      'The player\'s Minecraft world is not open to LAN, so you cannot join yet. ' +
      'In Minecraft they need to pause the game (press Esc), click "Open to LAN", then "Start LAN World". ' +
      'Explain this to them in your own voice and ask them to do it, then you can hop in.',
    launch: { game, status: 'lan-not-open' },
    summon: false,
  };
}

export { readRecent } from './chatStore';
export const chatStoreApi = chatStore;
