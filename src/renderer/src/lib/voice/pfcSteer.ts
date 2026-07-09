/**
 * PFC STEER (260706) — the voice call's "prefrontal cortex": the pure, side-
 * effect-free decision layer that steers WHO speaks WHEN on a multi-companion
 * call. Named so it is easy to find and tune later (grep "pfc steer" /
 * "pfcSteer"). The director in useVoiceStore owns the mechanics (the single
 * audio queue, barge-in, superseding); this module only answers decisions and
 * holds no mutable state of its own.
 *
 * Two jobs (a third, pickResponder — route each player utterance to ONE chosen
 * companion — was retired 260708: the player's line is now broadcast to every
 * participant, each deciding for itself whether to answer; the single-responder
 * pick starved the others of a turn and, on "both of you..." lines, had the
 * picked one fabricating the other's reply):
 *   1. decideReaction — after a companion speaks, which OTHER companion takes
 *      the next turn. With two+ companions the banter is meant to be ongoing —
 *      they keep the conversation (and play) going between themselves — so there
 *      is NO random "stop" roll. The exchange ends NATURALLY: a companion whose
 *      turn has nothing left to add returns no line, and the director stops the
 *      chain there (a real lull, not a dice roll). A hard cap (PFC_MAX_CHAIN)
 *      remains only as a runaway guard. The player can cut in at any time — a
 *      barge-in supersedes the chain (see the director in useVoiceStore).
 *   2. isJunkTranscript — reject Whisper hallucinations (echo/breath/silence
 *      transcribed as "hhhhh", "you", "[BLANK_AUDIO]") before they ever become a
 *      player turn.
 */

export interface Participant {
  id: string;
  name: string;
}

export interface ReactionDecision {
  /** The companion that should react next. */
  reactorId: string;
}

/** Runaway guard on how many companion turns a single trigger may cascade into
 * (the A→B→A… chain). This is NOT how banter normally ends — a natural lull
 * (a companion turn that produces no line) ends it first, usually well before
 * this. It is generous so an ongoing two-bot conversation is not cut short, but
 * bounded so a pair that never runs dry can't loop forever. */
export const PFC_MAX_CHAIN = 16;

/** How strongly the immediately-previous speaker is down-weighted when picking
 * the next one (1 = no bias, 0 = never repeat). Kept > 0 so a repeat is still
 * possible — natural conversation is not a strict round-robin. */
const REPEAT_WEIGHT = 0.35;

/** Word-boundary-ish name match: the player said a companion's name, so address
 * them. Case-insensitive; ignores 1-char names (too collision-prone). */
function addressedBy(text: string, participants: Participant[]): Participant | undefined {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `;
  return participants.find((p) => {
    const n = p.name.toLowerCase().trim();
    return n.length > 1 && hay.includes(` ${n} `);
  });
}

/** Weighted random choice, down-weighting `deprioritizeId` so the same speaker
 * does not clump. `rnd` is injectable so the director's variability is
 * deterministically testable. */
function weightedPick(
  list: Participant[],
  deprioritizeId: string | null,
  rnd: () => number,
): Participant {
  const weights = list.map((p) => (p.id === deprioritizeId ? REPEAT_WEIGHT : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r < 0) return list[i];
  }
  return list[list.length - 1];
}

/**
 * After `speakerId` spoke (at chain depth `depth`, 0 = the first responder),
 * decide which OTHER companion takes the next turn. Returns null only when the
 * chain genuinely cannot continue — a solo call (no one else to react) or the
 * runaway cap. Otherwise it ALWAYS hands the floor to a peer: banter between two
 * companions is meant to keep going, and it ends naturally when that peer's turn
 * produces no line (the director stops there), not by a random roll here.
 *
 * The reactor is a varied pick among the OTHER companions (never the speaker),
 * down-weighting the last reactor so a trio spreads rather than two of them
 * ping-ponging. When the speaker's line addresses a specific peer by name ("yo
 * yancy, explain that"), that peer is forced as the reactor.
 */
export function decideReaction(args: {
  speakerId: string;
  participants: Participant[];
  depth: number;
  lastReactorId: string | null;
  text?: string;
  rnd?: () => number;
}): ReactionDecision | null {
  const { speakerId, participants, depth, lastReactorId, text } = args;
  const rnd = args.rnd ?? Math.random;
  const others = participants.filter((p) => p.id !== speakerId);
  if (others.length === 0) return null; // solo call never chains
  if (depth + 1 >= PFC_MAX_CHAIN) return null; // runaway guard (also bounds name-addressed chains)
  // A companion named a specific peer — hand them the floor deterministically.
  if (text) {
    const named = addressedBy(text, others);
    if (named) return { reactorId: named.id };
  }
  return { reactorId: weightedPick(others, lastReactorId, rnd).id };
}

/**
 * Reject a transcript that is almost certainly a Whisper hallucination rather
 * than real speech. The local model invents filler on silence, breath, and the
 * companion's own TTS echo — typically a run of one letter ("hhhhh", "mmm"), a
 * bare stock phrase ("you", "thank you."), or a bracketed non-speech tag
 * ("[BLANK_AUDIO]", "(music)"). Those must never become a player turn: they
 * inject lines the player never said, confuse the companion, and (via supersede)
 * delay the real reply. Kept tight so genuine short answers ("yes", "no", "hi",
 * "ok") still pass.
 */
export function isJunkTranscript(raw: string): boolean {
  const text = raw.trim();
  if (!text) return true;
  // A fully bracketed/parenthesized utterance is a non-speech tag, not speech.
  if (/^[[(].*[\])]$/.test(text)) return true;
  // No letters at all (pure punctuation / digits / symbols) → junk.
  if (!/[a-z]/i.test(text)) return true;
  // Normalize to lowercase words for the pattern + stock-phrase checks.
  const lower = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  // A single "word" that is one letter repeated ≥3× ("hhhh", "aaaa", "mmmm").
  if (/^([a-z])\1{2,}$/.test(lower.replace(/\s/g, ''))) return true;
  // Known Whisper silence/echo hallucinations (whole-utterance match only, so a
  // real sentence containing one of these words is unaffected).
  const HALLUCINATIONS = new Set([
    'you',
    'thank you',
    'thanks for watching',
    'please subscribe',
    'subscribe',
    'blank audio',
    'blankaudio',
    'silence',
    'music',
    'applause',
    'foreign',
  ]);
  if (HALLUCINATIONS.has(lower)) return true;
  return false;
}
