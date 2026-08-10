/**
 * Fold prompt construction (260810) — PURE, extracted from continuity.ts.
 *
 * Why a separate module: continuity.ts drags in electron-bound plumbing
 * (paths, chatStore, the chat SDK), so nothing outside Electron could exercise
 * the fold's actual prompt text. The offline eval harness
 * (scripts/fold-noise-eval.ts) needs to run the REAL prompt against a real
 * model on real noisy data — the 260808 incident where ~20 consecutive folds
 * over phantom voice rows (a mic hearing reels audio) progressively destroyed
 * a good summary. Keeping the text and the transcript formatting here means
 * the harness and production build byte-identical prompts.
 *
 * NOTHING in this file may import from continuity.ts, paths.ts, sdk.ts, or
 * anything else that touches electron — plain `npx tsx` must be able to load it.
 */

export interface FoldMsg {
  role: 'user' | 'companion';
  text: string;
  ts?: number;
}

/**
 * Compact human timestamp for model-facing message stamps: "3 Jul 10:34"
 * (local time — main and the bot both run on the player's machine). Shared by
 * the chat prompt builder, the summary fold, and the launch continuity block.
 * (Lives here since 260810 so the fold harness gets it without electron;
 * continuity.ts re-exports it for its existing consumers.)
 */
export function formatChatTimestamp(ts: number): string {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${months[d.getMonth()]} ${hh}:${mm}`;
}

/** The evicted batch rendered as the fold's transcript block. */
export function buildFoldTranscript(msgs: FoldMsg[]): string {
  return msgs
    .map((m) => {
      const who = m.role === 'user' ? 'Player' : 'You';
      const when = typeof m.ts === 'number' ? ` (${formatChatTimestamp(m.ts)})` : '';
      return `${who}${when}: ${m.text}`;
    })
    .join('\n');
}

/**
 * The fold's system prompt.
 *
 * 260810 noise-robustness addition: the summarizer is told explicitly that a
 * low-signal batch should leave the existing summary's durable facts intact.
 * The instruction NAMES THE SHAPE of the noise in prose and never quotes an
 * example noise line — quoting a phrase inside a ban has been measured on this
 * project (backseat 260807) to FEED the phrase back into outputs.
 */
export function buildFoldSystem(personaExpanded?: string): string {
  const personaBlock =
    personaExpanded && personaExpanded.trim()
      ? "\n\nWrite the summary in the companion's own voice. The companion's persona:\n" +
        personaExpanded.trim()
      : '';
  return (
    'You maintain a running summary of the relationship and conversation between a game companion ("You") and their player. ' +
    'Fold the new messages into the existing summary. Keep it under 150 words, written first-person from the companion\'s point of view. ' +
    'Prioritise durable facts about the player, ongoing plans, running jokes, and emotional beats; drop small talk. ' +
    'Anchor time-bound things to their date using the message stamps — "planning an LA trip (11 Jul)", not just ' +
    '"planning an LA trip". The summary is read days or weeks later, and an undated event reads as if it just ' +
    'happened. Keep the anchors already in the existing summary. ' +
    'Record only what was actually said — never assert current world/game state (e.g. do not write "we\'re playing now"); ' +
    'an announced join can fail after the fact. ' +
    'Weigh the new messages before letting them change anything. A batch can be low-signal: ambient chatter, lines with a ' +
    'repetitive machine cadence, running narration of whatever was on a shared screen, or text that reads like transcribed ' +
    'background media rather than the player actually talking to the companion. When the new messages are low-signal in ' +
    'that way, keep the existing summary\'s durable facts intact and change little or nothing — returning the existing ' +
    'summary nearly unchanged is the correct output, not a failure. Low-signal material must never displace, rewrite, or ' +
    'crowd out established facts about the player; if a new message seems to contradict an established fact but reads like ' +
    'screen narration or background media, keep the established fact. ' +
    'Wrap the updated summary in <summary> and </summary> tags. Only what is inside the tags is stored and re-read by ' +
    'every future prompt; anything outside the tags is discarded, so never put summary content outside them.' +
    personaBlock
  );
}

/**
 * Deterministic backstop for the tag contract (260810). Measured on the noisy
 * corpus: asked in prose to "never open with a preamble", Sonnet still
 * sometimes prefixed a paragraph explaining what it kept and why — and the
 * fold's output is stored VERBATIM, so that analysis would have been re-read
 * by every future prompt as if it were the summary. Same lesson as
 * plainLine/stripDashes: a prompt rule needs a mechanical strip behind it.
 * Falls back to the whole trimmed text when the tags are missing, which is
 * exactly the pre-260810 behavior.
 */
export function extractSummaryTag(text: string): string {
  const m = /<summary>([\s\S]*?)<\/summary>/i.exec(text);
  return (m ? m[1] : text).trim();
}
