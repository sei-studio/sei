/**
 * Transcript to model messages (261024), PURE: moved out of chatService.ts so
 * the offline call-cache probe (scripts/call-cache-probe.ts) builds the exact
 * messages array a call turn sends. Nothing here may import electron-bound
 * modules; chatService re-exports toMessages for its existing importers.
 */
import type { ChatMessage } from '../../shared/ipc';
import { formatChatTimestamp } from './foldPrompt';
import { playStoryText } from './playSummary';

/**
 * Voice-call transcript window (261024). A call sends only the recent rows
 * (memory + summary carry the rest). The window used to SLIDE, history.slice(-cap),
 * so its first row changed on every turn. The transcript sits after the system
 * prompt in the cache prefix, so a moved first row meant the whole window was
 * re-written to cache on every call turn (the ~1,100 cache-write tokens per turn
 * seen on free calls) and nothing of it was ever read back.
 *
 * Now the start only moves in steps of `step` conversation rows, so the window
 * holds between `cap` and `cap + step - 1` user/companion rows (plus any system
 * rows among them) and keeps the same first row for `step` turns in a row: each
 * turn reads the cached transcript and writes only what is new.
 *
 * The step is counted on each row's ABSOLUTE position in the whole transcript,
 * not on its index in `history`. `history` is the unsummarized tail, and its
 * front moves on its own: a fold drops a batch from it, and while folds keep
 * failing readWindow caps it at the newest MAX_UNSUMMARIZED rows, so its
 * length stays constant and its front advances by one row every turn. Counted
 * from the front of `history`, that brought the sliding window back. `base` is
 * the absolute position of the first user/companion row in `history` (the
 * clamped watermark from readChatContext). System rows are not counted, the
 * same as the watermark.
 *
 * Returns the slice start index into `history`.
 */
export function voiceWindowStart(history: readonly ChatMessage[], base: number, cap: number, step: number): number {
  const s = Math.max(1, Math.floor(step));
  const counted: number[] = [];
  history.forEach((m, i) => {
    if (m.role === 'user' || m.role === 'companion') counted.push(i);
  });
  if (counted.length <= cap) return 0;
  const b = Math.max(0, Math.floor(base) || 0);
  const total = b + counted.length;
  // First row to keep, as an absolute position, then as a history index.
  const absStart = Math.max(b, Math.floor((total - cap) / s) * s);
  return counted[absStart - b];
}

/**
 * Map the persisted transcript into an alternating Anthropic messages array.
 * Exported for testing. Every emitted row — play rows included — flows through
 * the ONE shared same-role merge at the bottom: a play row is just a `user` row
 * with bracketed content, so two adjacent play rows (or a user message followed
 * by a play row) fold into a single user turn instead of two adjacent `user`
 * messages that Anthropic rejects with 400 "roles must alternate".
 *
 * `appendOnly` (261102, backseat): a merged row becomes its own text block,
 * "\n" + row, instead of being concatenated onto the previous row's string.
 * The text the model reads is the same (Anthropic joins the text blocks of a
 * message with no separator, so ["a", "\nb"] reads as "a\nb"; count_tokens
 * gives both the same size), but the bytes of the earlier rows no longer
 * change when a row is appended. That matters to a surface that puts its
 * cache breakpoint on the last history message and then appends to that same
 * message next turn. Backseat does exactly that: the companion speaks on
 * every look and the player rarely does, so consecutive companion lines merge
 * into one assistant message. As a growing string, the block the breakpoint
 * sat on changed on every tick, so its cache write was never read back and
 * the whole transcript was written again at 1.25x on the next look (live
 * free sessions: cache_read flat at the system prefix, ~900 tokens written
 * per tick). As separate blocks, the previous breakpoint's block is still
 * there, unchanged, and the next tick reads it. Chat and calls keep the
 * string merge (their transcript alternates, so it rarely merges across turns).
 */
export function toMessages(
  history: ChatMessage[],
  opts: { appendOnly?: boolean } = {},
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const appendOnly = opts.appendOnly === true;
  // Adds `text` to a message as a new row: a fresh block in appendOnly mode,
  // a "\n"-joined string otherwise. False when the message cannot take it.
  const appendRow = (msg: { content: unknown }, text: string): boolean => {
    if (typeof msg.content === 'string') {
      msg.content = appendOnly
        ? [{ type: 'text', text: msg.content }, { type: 'text', text: `\n${text}` }]
        : `${msg.content}\n${text}`;
      return true;
    }
    if (appendOnly && Array.isArray(msg.content)) {
      msg.content.push({ type: 'text', text: `\n${text}` });
      return true;
    }
    return false;
  };
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
      // 261113: plus what happened in it (its recap, or its last lines), so a
      // chat right after a game knows the creeper took the roof.
      role = 'user';
      const story = playStoryText(m.event);
      content = `[${formatChatTimestamp(m.ts)}] [Shared history: ${m.text} You were there together in the world — treat it as something you actually did, not a plan.${story ? ` ${story}` : ''}]`;
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
      // 261003b: a line spoken from a real web lookup gets the lookup in front
      // of it, as a user-side note between the line before the search and the
      // answer, the way the results arrived. Without it a real lookup and a
      // "let me check" followed by a made-up answer looked the same in
      // history, and the model copied the made-up shape.
      const queries = role === 'assistant' ? (m.lookup?.queries ?? []).filter((q) => typeof q === 'string' && q.trim()) : [];
      if (queries.length) {
        const note = `[results of your web search for ${queries.map((q) => `"${q.trim()}"`).join(', ')} came back here]`;
        const prev = out[out.length - 1];
        if (!(prev && prev.role === 'user' && appendRow(prev, note))) out.push({ role: 'user', content: note });
      }
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
    if (!(last && last.role === role && appendRow(last, content))) out.push({ role, content });
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
