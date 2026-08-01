/**
 * Markdown strip for chat lines the player actually reads (260728).
 *
 * The Minecraft bot has had this since 260615 (`postProcessSay` in
 * src/bot/brain/orchestrator.js, "strip asterisks so *stage directions* never
 * reach chat"); the in-app surfaces never did, because nothing prompted the
 * model to format until the prompts themselves grew headers, backticks and
 * bullet lists. Live capture in Draw!: "is it a **hearing aid**?" — the model
 * emphasising its own guess, rendered as literal asterisks in a handwritten
 * chat bubble.
 *
 * A prompt rule alone is not enough for this: emphasis is a strong habit, and
 * the failure is silent and ugly rather than loud. So the rule is stated AND
 * the characters are removed on the way out.
 *
 * Deliberately NOT touched: brackets and parentheses (they carry tone and the
 * silence-filler detector looks for them), and dashes (Draw! has no dash rule
 * of its own; the bot's dash-as-message-break lives at its own emit points).
 */

/** One chat line, with any markdown emphasis removed. */
export function plainLine(text: string): string {
  return (
    String(text ?? '')
      // Headers and bullets, which only ever appear at the start of a line.
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}[-+]\s+/, '')
      // Every asterisk goes, same as the bot: it is emphasis, a bullet or a
      // stage direction, and none of the three belong in a spoken-style line.
      .replace(/\*/g, '')
      .replace(/~~/g, '')
      .replace(/`+/g, '')
      // _underscore emphasis_ only when it wraps something, so a stray
      // underscore inside a word (a username, a file) survives.
      .replace(/(^|[\s([])_{1,2}([^_]+)_{1,2}(?=$|[\s.,!?)\]])/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
