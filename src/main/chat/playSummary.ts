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
