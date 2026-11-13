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
  /**
   * 261113: 'session' is a finished game session (a play row), folded with
   * the conversation around it. Its text is the row's line plus its story
   * (playSummary.ts playStoryText): the recap, or the last lines said.
   */
  role: 'user' | 'companion' | 'session';
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

const FOLD_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The fold's own stamp, "Sat 24 Oct 16:45" (261024). The weekday is what lets
 * the summarizer turn "tomorrow" or "next Thursday" into the right date:
 * without it the model had to work out the weekday of a bare "24 Oct" itself,
 * and in the summary-model eval (scripts/summary-model-eval.ts) both Sonnet 5
 * and Haiku 5.5 dated a "Wednesday" or a "next Thursday" a day off.
 */
export function formatFoldTimestamp(ts: number): string {
  return `${FOLD_DAYS[new Date(ts).getDay()]} ${formatChatTimestamp(ts)}`;
}

/**
 * A heard line from another companion on a group call is stored as a player
 * row carrying this prefix (observeVoiceLine, sendCompanionVoiceTurn).
 */
const PEER_LINE_RE = /^\(\s*([^()\n]{1,60}?),\s*on the call\s*\)\s*:\s*/i;

/**
 * The evicted batch rendered as the fold's transcript block. A group-call line
 * from another companion is labeled with that companion's name (261024): it
 * used to read "Player (...): (Marv, on the call): ...", and the summarizer
 * gave Marv's facts and lines to the player or to the wrong companion.
 */
export function buildFoldTranscript(msgs: FoldMsg[]): string {
  return msgs
    .map((m) => {
      let who = m.role === 'user' ? 'Player' : m.role === 'session' ? 'Game session' : 'You';
      let text = m.text;
      if (m.role === 'user') {
        const peer = PEER_LINE_RE.exec(text);
        if (peer) {
          who = peer[1].trim();
          text = text.slice(peer[0].length);
        }
      }
      const when = typeof m.ts === 'number' ? ` (${formatFoldTimestamp(m.ts)})` : '';
      return `${who}${when}: ${text}`;
    })
    .join('\n');
}

const FOLD_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

/**
 * A day-by-day calendar line for the batch (261024): from the first stamped
 * day (at most a week before the last one) to two weeks after the last.
 * Haiku 5.5 counted "next Thursday" from "Sat 24 Oct" as 30 Oct even with the
 * weekday in the stamps, then put "the Saturday after" on 1 Nov; with the days
 * listed, turning a weekday into a date is a lookup. Empty when no message is
 * stamped.
 */
export function buildFoldCalendar(msgs: FoldMsg[]): string {
  const stamps = msgs.map((m) => m.ts).filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  if (!stamps.length) return '';
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  };
  const last = day(Math.max(...stamps));
  const first = day(Math.max(Math.min(...stamps), last.getTime() - 7 * DAY_MS));
  const days: string[] = [];
  // Step by calendar date, not by 24h, so a DST change cannot skip or repeat a day.
  for (let d = new Date(first); d.getTime() <= last.getTime() + 14 * DAY_MS + 3_600_000; d.setDate(d.getDate() + 1)) {
    days.push(`${FOLD_DAYS[d.getDay()]} ${d.getDate()} ${FOLD_MONTHS[d.getMonth()]}`);
    if (days.length > 40) break;
  }
  return `Calendar for working out dates: ${days.join(', ')}.`;
}

/**
 * The fold's user message: the existing summary, the evicted batch, and the
 * calendar line. Shared by continuity.ts and the offline evals so both send
 * the same text.
 */
export function buildFoldUserText(summary: string, msgs: FoldMsg[], memory?: string): string {
  const calendar = buildFoldCalendar(msgs);
  // 261113 (v0.7 D2): the memory notes, so the fold's <remember> lines skip
  // what is already saved. Omitted (undefined) by callers that predate it.
  const notes = memory === undefined ? '' : `Your memory notes, already saved:\n${memory.trim() || '(none yet)'}\n\n`;
  return (
    `${notes}Existing summary:\n${summary || '(none yet)'}\n\nNew messages:\n${buildFoldTranscript(msgs)}` +
    (calendar ? `\n\n${calendar}` : '')
  );
}

/** Most lines one fold's <remember> block may save. */
export const FOLD_MAX_FACTS = 8;
/** Longest saved fact line (characters). */
export const FACT_MAX_CHARS = 300;

/**
 * The lines of the fold's <remember> block (261113, v0.7 D2): one fact per
 * line, list bullets dropped, at most FOLD_MAX_FACTS. [] when the block is
 * missing or empty. Only the tag is read, like extractSummaryTag.
 */
export function extractRememberTag(text: string, max = FOLD_MAX_FACTS): string[] {
  const m = /<remember>([\s\S]*?)<\/remember>/i.exec(text);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim().slice(0, FACT_MAX_CHARS))
    .filter(Boolean)
    .slice(0, max);
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
    'Anchor time-bound things to their date using the message stamps, so "planning an LA trip (11 Jul)", not just ' +
    '"planning an LA trip". The summary is read days or weeks later, and an undated event reads as if it just ' +
    'happened. Keep the anchors already in the existing summary. ' +
    // 261024 accuracy rules, measured with scripts/summary-model-eval.ts when
    // the fold moved from Sonnet 5 to Haiku 5.5 (see continuity.ts).
    'Each stamp has the weekday, and a calendar of the days around the messages follows them. When someone says yesterday, last night, tomorrow, a weekday, or next week, find the date on that calendar, counting from the stamp of that message. ' +
    'If you cannot tell the date for sure, keep the words they used instead of a date. ' +
    'Each line starts with who said it: Player is the player, You is you, and any other name is another companion on the call. ' +
    // 261113 (D1): a game session's play row, with its recap or last lines.
    'A line starting with Game session is a game the two of you played together, with your own recap of it or the last things said in it; keep what happened in it the same way. ' +
    'Keep track of who said what, and never give another companion\'s facts, likes, or lines to the player or to yourself. ' +
    'Keep the certainty the speaker had: a maybe stays a maybe, a joke or a bit stays a joke, an offer stays an offer until it is accepted, ' +
    'a plan that changed keeps only its latest version, and something that happened once is not a habit. ' +
    'Write only what the messages or the existing summary say, without adding details or reasons nobody gave. ' +
    'Record only what was actually said, and never assert current world or game state (for example, do not write "we\'re playing now"), ' +
    'because an announced join can fail after the fact. ' +
    'Weigh the new messages before letting them change anything. A batch can be low-signal: ambient chatter, lines with a ' +
    'repetitive machine cadence, running narration of whatever was on a shared screen, or text that reads like transcribed ' +
    'background media rather than the player actually talking to the companion. When the new messages are low-signal in ' +
    'that way, keep the existing summary\'s durable facts intact and change little or nothing. Returning the existing ' +
    'summary nearly unchanged is the correct output, not a failure. Low-signal material must never displace, rewrite, or ' +
    'crowd out established facts about the player; if a new message seems to contradict an established fact but reads like ' +
    'screen narration or background media, keep the established fact. ' +
    'Wrap the updated summary in <summary> and </summary> tags. Only what is inside the tags is stored and re-read by ' +
    'every future prompt; anything outside the tags is discarded, so never put summary content outside them. ' +
    // 261113 (v0.7 D2): durable facts go to memory before the summary
    // compresses them away. Measured with the consistency eval (A, B, D) and
    // scripts/remember-eval.ts --fold.
    'The summary gets shorter as it is folded again, so a fact that lives only in the summary can be lost. After the summary, ' +
    'pick out the durable facts in the new messages that your memory notes do not have yet: things about the player (names, ' +
    'the people and pets in their life, their job or school, dates and plans they told you, what they like or dislike, rules ' +
    'they asked you to keep) and plans or promises the two of you made. Write each as one short line in the first person, ' +
    'like your own memory notes, with its date in the sentence when it is tied to one (not a stamp in brackets: each note is ' +
    'stamped when it is saved). When a new message changes something in your notes ' +
    '(a new job, a new favourite, a plan that moved), write the new fact and say that it is now different, so it reads as the ' +
    'newer one. Leave out anything your notes already say, small talk, passing moods, game state, anything from low-signal ' +
    `material, and anything nobody actually said. Put the lines inside <remember> and </remember> tags, one per line, at most ${FOLD_MAX_FACTS}, and leave the tags ` +
    'empty when there is nothing new.' +
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
  // 261113: the untagged fallback must not store the <remember> block (D2).
  return (m ? m[1] : text.replace(/<remember>[\s\S]*?(?:<\/remember>|$)/gi, '')).trim();
}
