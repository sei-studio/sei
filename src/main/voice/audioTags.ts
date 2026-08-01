/**
 * Audio tags (260730) — bracketed performance directions like `[laughs]` that
 * a TTS model PERFORMS instead of reading aloud.
 *
 * They are real, and they are not available to us yet. Measured live against
 * this account, same voice, `[flibberflop]` used as the control:
 *
 *   eleven_flash_v2_5   plain 1.26s   [laughs] 2.28s   [flibberflop] 2.09s
 *   eleven_v3           plain 2.28s   [laughs] 3.16s   [flibberflop] 2.12s
 *
 * The control is the whole story. Flash spends nearly as long on the nonsense
 * tag as on the real one, because it is READING THE BRACKETS ALOUD — a tag we
 * emitted today would be heard as the word "laughs". v3 swallows the nonsense
 * tag (shorter than plain: it is consumed and dropped) and performs the real
 * one, which is what support looks like.
 *
 * So the vocabulary below is written down, validated and stripped, but never
 * offered to the model: SUPPORTS_AUDIO_TAGS is derived from the model we
 * actually ship and is false. Three measured things had to change before it
 * could flip; one of them since has (260731), leaving two:
 *
 *   1. RESOLVED 260731. v3 IGNORES voice_settings.speed — measured, flash:
 *      3.66s → 4.91s at speed 0.74, exactly the 1.35x asked for; v3:
 *      4.21s → 4.13s, i.e. unchanged. That used to be disqualifying, because
 *      speed was how the pitch trick paid for itself and a character like Sui
 *      would have played back 35% fast with nothing compensating. The pitch
 *      shift is local and pace-preserving now (renderer lib/voice/pitchBus.ts)
 *      and no request carries `speed` at all, so v3 ignoring it costs nothing.
 *   2. v3 REJECTS previous_text / next_text outright — HTTP 400,
 *      "not yet supported with the 'eleven_v3' model". That is the utterance
 *      conditioning in tts.ts, which exists to stop clips landing a hard
 *      terminal pitch drop mid-reply.
 *   3. v3 is slower where a call feels it: time to first byte 591-1395ms
 *      against flash's 262-330ms.
 *
 * Plus the model id is pinned server-side for cloud users (sei-proxy
 * src/tts/forward.ts), so a switch needs a proxy deploy, not just this file.
 *
 * What IS live is the stripping. Models emit stage directions unprompted, and
 * on flash that is not a cosmetic bug, it is a word spoken in the character's
 * voice. So tags are removed at the synthesis boundary and out of chat bubbles,
 * exactly like the markdown strip in plainLine.ts: state the rule in the prompt
 * when there is a rule to state, and remove the characters regardless.
 */

import { isSilenceFiller } from '../../bot/brain/silenceFiller.js';

/** Whether the shipped TTS model performs tags rather than reading them. */
export const SUPPORTS_AUDIO_TAGS = false;

/**
 * The closed vocabulary a companion would be offered on a call. Deliberately
 * short: v3 accepts free-form tags, but an open list invites the model to
 * invent stage directions ("[leans in]") that no model performs and every model
 * charges for. Delivery and reaction only, nothing that describes a body the
 * character does not have on a phone call.
 */
export const AUDIO_TAGS: readonly string[] = [
  'laughs',
  'giggles',
  'sighs',
  'exhales',
  'gasps',
  'snorts',
  'whispers',
  'clears throat',
  'short pause',
  'long pause',
];

const TAG_SET = new Set(AUDIO_TAGS);

/**
 * Bracket-tag shape: one to three plain words. Narrow on purpose. Anything
 * carrying digits, punctuation or real sentence structure is prose the model
 * chose to bracket, not a stage direction, and deleting it would lose content.
 */
const TAG_RE = /\[[ ]*([a-z]+(?:[ ]+[a-z]+){0,2})[ ]*\]/gi;

/** Collapse the gaps a removed tag leaves behind. */
function tidy(text: string): string {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .trim();
}

/**
 * Remove bracketed stage directions from a line.
 *
 * `keep` retains the ones in AUDIO_TAGS, for a model that performs them; it is
 * what SUPPORTS_AUDIO_TAGS would turn on. Invalid tags are removed either way,
 * which is the half that matters: a model handed a list still invents entries,
 * and an invented tag is spoken aloud even by a model that performs the real
 * ones (v3 dropped `[flibberflop]`, but only because it recognized nothing in
 * it — that is luck, not a contract).
 */
export function stripAudioTags(text: string, keep = false): string {
  const line = String(text ?? '');
  // The silence sentinel has square-bracket forms of its own ("[silence]",
  // "[says nothing]") and they are tag-shaped, so this ran first and emptied
  // them — which did not silence the turn, it turned it into a "…" bubble,
  // because the filler drop downstream never saw anything to match. The
  // detector owns that line; hand it over untouched. Same reasoning as the
  // markdown strip in plainLine.ts, which leaves brackets alone for exactly
  // this consumer.
  if (isSilenceFiller(line)) return line;
  return tidy(
    line.replace(TAG_RE, (match, body: string) =>
      keep && TAG_SET.has(body.trim().toLowerCase()) ? match : '',
    ),
  );
}

/**
 * The tag half of the voice-call prompt. Returns '' while the shipped model
 * cannot perform tags, so nothing is spent telling a character about an ability
 * that would come out of its mouth as the word "laughs".
 */
export function audioTagDirective(): string {
  if (!SUPPORTS_AUDIO_TAGS) return '';
  return `# PERFORMANCE
You may place a performance direction in square brackets and it will be HEARD as that sound, not read out: ${AUDIO_TAGS.map((t) => `[${t}]`).join(' ')}. Only those exact ones exist. Anything else in brackets is deleted before you are heard, so inventing one costs you the beat and gives you nothing. Use them the way a person actually punctuates speech, which is rarely: at most one in a line, and only when the sound is the point. Never narrate yourself in brackets.`;
}
