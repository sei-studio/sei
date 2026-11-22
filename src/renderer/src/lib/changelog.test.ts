import { describe, it, expect } from 'vitest';
import { stripDuplicateTitleHeading, topChangelogLine } from './changelog';

const TITLES = ['Whatâ€™s new in 0.6.9-beta.3'];

describe('stripDuplicateTitleHeading (261020, T158)', () => {
  it('drops a first heading that repeats the modal title', () => {
    const md = "## What's new in 0.6.9-beta.3\n\n- Own voices on Sei Cloud\n- Fixes";
    expect(stripDuplicateTitleHeading(md, TITLES)).toBe('- Own voices on Sei Cloud\n- Fixes');
  });

  it('matches across apostrophe style, case, a "v" prefix and trailing colon', () => {
    for (const h of [
      '## Whatâ€™s new in 0.6.9-beta.3',
      "## WHAT'S NEW IN v0.6.9-beta.3:",
      "#  What's  new in 0.6.9-beta.3",
    ]) {
      expect(stripDuplicateTitleHeading(`${h}\n- A`, TITLES)).toBe('- A');
    }
  });

  it('drops it when it matches the English title on a localized UI', () => {
    const md = "## What's new in 0.6.9-beta.3\n- A";
    expect(stripDuplicateTitleHeading(md, ['0.6.9-beta.3 ç‰ˆæœ¬æ›´æ–°å†…å®¹', "What's new in 0.6.9-beta.3"])).toBe('- A');
  });

  it('keeps a heading for a different version or with other text', () => {
    const other = "## What's new in 0.6.8\n- A";
    expect(stripDuplicateTitleHeading(other, TITLES)).toBe(other);
    const fixes = '## Fixes\n- A';
    expect(stripDuplicateTitleHeading(fixes, TITLES)).toBe(fixes);
  });

  it('only looks at the first non-blank line', () => {
    const md = "Intro line\n## What's new in 0.6.9-beta.3\n- A";
    expect(stripDuplicateTitleHeading(md, TITLES)).toBe(md);
    expect(stripDuplicateTitleHeading("\n\n## What's new in 0.6.9-beta.3\n- A", TITLES)).toBe('- A');
  });

  it('leaves an empty changelog alone', () => {
    expect(stripDuplicateTitleHeading('', TITLES)).toBe('');
  });
});

describe('topChangelogLine (261023)', () => {
  it('takes the first bullet of the newest section', () => {
    const md = "## What's new in 0.7.0\n- Faster voice calls\n- Fixes\n\n## What's new in 0.6.9\n- Old";
    expect(topChangelogLine(md)).toBe('Faster voice calls');
  });

  it('cuts a long first bullet to its first sentence', () => {
    const md =
      '## What\'s new in 0.6.9-beta.3\n- New: use your own ElevenLabs voices. Save your ElevenLabs key in Settings and the voice picker gets a tab';
    expect(topChangelogLine(md)).toBe('New: use your own ElevenLabs voices.');
  });

  it('keeps a short bullet whole and strips markdown emphasis', () => {
    expect(topChangelogLine('- **Chess** is back. Try it')).toBe('Chess is back. Try it');
  });

  it('falls back to the first plain line, then to empty', () => {
    expect(topChangelogLine('## Heading\nJust a sentence')).toBe('Just a sentence');
    expect(topChangelogLine('')).toBe('');
    expect(topChangelogLine('## Only a heading')).toBe('');
  });
});




