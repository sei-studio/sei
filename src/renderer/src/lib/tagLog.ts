/**
 * Pure regex log-line color tagger.
 *
 * Source: 04-UI-SPEC.md §Logs panel + 04-PATTERNS.md §src/renderer/src/lib/tagLog.ts.
 *
 * Matches the [HH:MM:SS.mmm] timestamp prefix that src/bot/brain/log.js emits,
 * then dispatches by tag. Falls back to plain --text-2 mono when no rule matches.
 *
 * Returns CSS variable references (not hex) so theme switching recolors lines
 * without re-tagging.
 */

export interface TaggedLine {
  color: string;
  line: string;
}

const TS = String.raw`\[\d{2}:\d{2}:\d{2}\.\d{3}\]`;

const RULES: Array<{ re: RegExp; color: string }> = [
  // Owner → bot: chat outbound (only place log lines may use accent)
  { re: new RegExp(`^${TS}\\s+\\[chat->\\]`), color: 'var(--accent)' },
  // Bot → owner: chat inbound
  { re: new RegExp(`^${TS}\\s+\\[chat<-\\]`), color: 'var(--accent)' },
  // Haiku response (text emit)
  { re: new RegExp(`^${TS}\\s+\\[haiku!\\]`), color: 'var(--text)' },
  // Haiku prompt (request)
  { re: new RegExp(`^${TS}\\s+\\[haiku\\?\\]`), color: 'var(--text-2)' },
  // Errors — case-insensitive, anywhere in line
  { re: /\[error\]|^ERROR\b|^Error:/i, color: 'var(--red)' },
  // Warnings
  { re: /\[warn\]|^WARN\b/i, color: 'var(--warn)' },
];

export function tagLog(line: string): TaggedLine {
  for (const rule of RULES) {
    if (rule.re.test(line)) return { color: rule.color, line };
  }
  return { color: 'var(--text-2)', line };
}
