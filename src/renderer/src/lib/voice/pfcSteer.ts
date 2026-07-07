/**
 * PFC STEER (260706) — the voice call's "prefrontal cortex": the pure, side-
 * effect-free decision layer that steers WHO speaks WHEN on a multi-companion
 * call. Named so it is easy to find and tune later (grep "pfc steer" /
 * "pfcSteer"). The director in useVoiceStore owns the mechanics (the single
 * audio queue, barge-in, superseding); this module only answers decisions and
 * holds no mutable state of its own.
 *
 * Three jobs:
 *   1. pickResponder — when the player speaks, which ONE companion answers.
 *      Addressed-by-name wins; otherwise a VARIED pick (the last responder is
 *      down-weighted, not banned) so it is not always the same AI jumping in
 *      first, without a rigid clockwork rotation either.
 *   2. decideReaction — after a companion speaks, whether ANOTHER companion
 *      reacts, and which one. Probabilistic and depth-decaying under a hard cap,
 *      so an exchange sometimes stops after a single line, sometimes banters
 *      back and forth for a few turns, but never runs away or ping-pongs forever
 *      (the player can sit back and listen without it going infinite).
 *   3. isJunkTranscript — reject Whisper hallucinations (echo/breath/silence
 *      transcribed as "hhhhh", "you", "[BLANK_AUDIO]") before they ever become a
 *      player turn.
 */

export interface Participant {
  id: string;
  name: string;
}

export interface ResponderPick {
  /** The chosen companion's id. */
  id: string;
}

export interface ReactionDecision {
  /** The companion that should react next. */
  reactorId: string;
}

/** Hard cap on how many companion turns a single player utterance may cascade
 * into (the A→B→A… chain). The floor beneath the probabilistic taper below. */
export const PFC_MAX_CHAIN = 5;

/** Chance that a FURTHER companion jumps in, indexed by how many companion turns
 * have already been spoken this utterance (0 = right after the first responder).
 * Decays so banter tapers into silence organically instead of always dying at
 * one turn or running forever. Length ties into PFC_MAX_CHAIN (0 beyond it). */
const REACTION_CHANCE = [0.6, 0.5, 0.38, 0.25, 0.12];

/** How strongly the immediately-previous speaker is down-weighted when picking
 * the next one (1 = no bias, 0 = never repeat). Kept > 0 so a repeat is still
 * possible — natural conversation is not a strict round-robin. */
const REPEAT_WEIGHT = 0.35;

export function reactionChance(turnsSoFar: number): number {
  return REACTION_CHANCE[turnsSoFar] ?? 0;
}

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
 * Choose who answers a player utterance. If the player named a companion, that
 * companion answers; otherwise pick a varied responder, down-weighting the last
 * one so the "who speaks first" alternates without a rigid rotation. With one
 * participant it just returns them.
 */
export function pickResponder(
  text: string,
  participants: Participant[],
  lastResponderId: string | null,
  rnd: () => number = Math.random,
): ResponderPick {
  if (participants.length === 0) return { id: '' };
  if (participants.length === 1) return { id: participants[0].id };
  const addressed = addressedBy(text, participants);
  if (addressed) return { id: addressed.id };
  return { id: weightedPick(participants, lastResponderId, rnd).id };
}

/**
 * After `speakerId` spoke (at chain depth `depth`, 0 = the first responder),
 * decide whether ANOTHER companion reacts and which one. Returns null when the
 * exchange should stop — solo call, hard cap reached, or the probabilistic taper
 * says "let it rest". The reactor is a varied pick among the OTHER companions
 * (never the speaker), down-weighting the last reactor so a trio spreads rather
 * than two of them ping-ponging.
 *
 * `text` is the line the speaker just said: when it addresses a specific peer by
 * name ("yo yancy, explain that"), that peer is FORCED as the reactor, bypassing
 * the probabilistic taper — a direct question must never be met with silence
 * (the "I asked them to talk to each other and Yancy never replied" bug). The
 * hard cap still applies so even name-addressed banter can't run forever.
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
  if (depth + 1 >= PFC_MAX_CHAIN) return null; // hard cap (also bounds name-addressed chains)
  // A companion named a specific peer — hand them the floor deterministically.
  if (text) {
    const named = addressedBy(text, others);
    if (named) return { reactorId: named.id };
  }
  if (rnd() >= reactionChance(depth)) return null; // organic stop
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
