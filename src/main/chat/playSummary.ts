/**
 * The one sentence every game surface writes into the transcript (260728).
 *
 * Each game used to compose its own: chess reported the result and the move
 * count, Draw! listed both players' words and the score, backseat named the
 * window. Read back in the chat log that is four different registers for the
 * same event, and the detail was the part that aged worst, because a scoreline
 * from four days ago is the least interesting thing about having played.
 *
 * So it is one shape, for all of them: who, what, how long. The result belongs
 * in the game, not in the record that it happened.
 *
 * Note this is also what the character reads later, via the rolling summary, so
 * dropping the results is a deliberate trade: the companion remembers the
 * SESSION rather than the scoreline. Anything genuinely worth keeping is what
 * remember() is for, and every surface offers it.
 */

/** "a few seconds" / "7 minutes" / "2 hours". */
export function formatPlayDuration(ms: number, language?: 'en' | 'zh'): string {
  if (language === 'zh') {
    if (ms < 60_000) return '几秒钟';
    if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}分钟`;
    return `${Math.max(1, Math.round(ms / 3_600_000))}小时`;
  }
  if (ms < 60_000) return 'a few seconds';
  if (ms < 3_600_000) {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const h = Math.max(1, Math.round(ms / 3_600_000));
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/**
 * `You and Marv played Draw! for 7 minutes.`
 *
 * `game` is shown verbatim, so pass it as it should read to the player
 * ("Minecraft", "Chess", "Draw!", "Backseat").
 *
 * 260730: the row is PERSISTED transcript content, so a zh-pinned character
 * writes it in Chinese (the language it and its player converse in), not in
 * the current UI language, which can change after the fact.
 */
export function playSummaryText(
  name: string,
  game: string,
  durationMs: number,
  language?: 'en' | 'zh',
): string {
  if (language === 'zh') {
    return `你和${name}玩了${formatPlayDuration(durationMs, 'zh')}${game}。`;
  }
  return `You and ${name} played ${game} for ${formatPlayDuration(durationMs)}.`;
}

// ── what happened in a game session (261113, v0.7 consistency D1) ──────────
//
// A game session's own lines never reach the transcript (the bot's chat lives
// in the game), so before this the play row was all the app ever knew of a
// session: "You and Sui played Minecraft for 40 minutes". Chat and calls
// afterwards had no idea the creeper took the roof. The row now carries the
// story of the session, written once at its end:
//   - `recap`: the companion's own short first-person recap, from the
//     session-end call that already runs (playerEndNextStep.ts runSessionEnd);
//   - `lines`: when there is no recap (the check was skipped, failed or timed
//     out), the last few lines of the session digest instead, no LLM involved.
// Both are model-facing only. The renderer still shows `text`.

/** One line of a session digest, as the bot reports it (sessionDigest.js). */
export interface PlayStoryLine {
  who: 'player' | 'you' | 'other';
  text: string;
}

/** Digest lines kept on the row when there is no recap. */
export const PLAY_FALLBACK_LINES = 8;
/** Longest recap kept (characters); the prompt asks for 50 words. */
export const PLAY_RECAP_MAX_CHARS = 600;

/** The story fields of a play row's event: a recap, else the last digest lines, else nothing. */
export function playStory(
  recap: string | null | undefined,
  lines: readonly PlayStoryLine[] | null | undefined,
): { recap?: string; lines?: PlayStoryLine[] } {
  const r = typeof recap === 'string' ? recap.replace(/\s+/g, ' ').trim().slice(0, PLAY_RECAP_MAX_CHARS) : '';
  if (r) return { recap: r };
  const kept = (lines ?? [])
    .filter((l) => l && typeof l.text === 'string' && l.text.trim())
    .slice(-PLAY_FALLBACK_LINES)
    .map((l) => ({ who: l.who === 'you' || l.who === 'other' ? l.who : 'player', text: l.text.replace(/\s+/g, ' ').trim().slice(0, 200) }) as PlayStoryLine);
  return kept.length ? { lines: kept } : {};
}

function speakerOf(who: PlayStoryLine['who']): string {
  return who === 'you' ? 'You' : who === 'other' ? 'Another companion' : 'Player';
}

/**
 * The story of a play row, for the model: what is read in the transcript
 * (toMessages), the fold and the next game's launch continuity. '' when the
 * row has none (older rows, chess, Draw!, backseat).
 */
export function playStoryText(event: { recap?: unknown; lines?: unknown } | undefined): string {
  if (!event) return '';
  if (typeof event.recap === 'string' && event.recap.trim()) {
    return `Your own recap of it afterwards: ${event.recap.trim()}`;
  }
  if (Array.isArray(event.lines) && event.lines.length) {
    const lines = (event.lines as PlayStoryLine[])
      .filter((l) => l && typeof l.text === 'string')
      .map((l) => `${speakerOf(l.who)}: "${l.text}"`);
    // One line, so a quoted "Player:" never reads as a transcript row.
    if (lines.length) return `The last things said in the game: ${lines.join(' / ')}`;
  }
  return '';
}

/** The play row for a finished game session (index.ts emitPlaySession). */
export function buildPlayRow(p: {
  name: string;
  gameName: string;
  game: string;
  durationMs: number;
  language?: 'en' | 'zh';
  recap?: string | null;
  lines?: readonly PlayStoryLine[] | null;
}): { role: 'system'; text: string; event: { kind: 'play'; game: string; durationMs: number; recap?: string; lines?: PlayStoryLine[] } } {
  return {
    role: 'system',
    text: playSummaryText(p.name, p.gameName, p.durationMs, p.language),
    event: { kind: 'play', game: p.game, durationMs: p.durationMs, ...playStory(p.recap, p.lines) },
  };
}
