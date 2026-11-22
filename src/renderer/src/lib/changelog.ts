/**
 * Changelog display helpers (261020, T158).
 *
 * The update feed's changelog markdown (sei-website version-beta.json /
 * version.json) usually opens with "## What's new in X.Y.Z", which the
 * What's new modal already shows as its title. The feed format stays as is
 * (older clients render that heading); the modal drops the first heading
 * instead when it only repeats the title.
 */

/** Lowercase, straight apostrophes, no "v" before a version number, single
 * spaces, no trailing punctuation. */
function normalizeTitle(s: string): string {
  return s
    .replace(/[â€˜â€™Ê¼`]/g, "'")
    .replace(/\bv(?=\d)/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:.!-]+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Remove the changelog's first heading when it duplicates the modal title.
 * `titles` are the titles that count as a duplicate: the localized modal
 * title and the English one (the feed is written in English, so a zh UI
 * would otherwise show both). Only a heading that is the first non-blank
 * line is ever removed; everything else is returned untouched.
 */
export function stripDuplicateTitleHeading(text: string, titles: string[]): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first === -1) return text;
  const m = /^#{1,3}\s+(.*)$/.exec(lines[first].trim());
  if (!m) return text;
  const heading = normalizeTitle(m[1]);
  if (!titles.some((title) => normalizeTitle(title) === heading)) return text;
  return lines
    .slice(first + 1)
    .join('\n')
    .replace(/^\s*\n/, '');
}

/**
 * The headline of a changelog for the post-update "Updated to vX" toast
 * (261023): the first bullet, cut to its first sentence when it runs on, with
 * markdown emphasis removed. Falls back to the first plain line. Empty string
 * when there is nothing to show. The feed is cumulative, newest section first,
 * so the first bullet belongs to the version that was just installed.
 */
export function topChangelogLine(text: string): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const bullet = lines.find((l) => /^[-*â€¢]\s+/.test(l));
  const plain = lines.find((l) => !/^#{1,6}\s/.test(l));
  let line = (bullet ?? plain ?? '').replace(/^[-*â€¢]\s+/, '');
  line = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1');
  const sentence = /^(.{20,}?[.!?])\s+\S/.exec(line);
  if (sentence && line.length > 80) line = sentence[1];
  return line.trim();
}




