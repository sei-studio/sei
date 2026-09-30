/** macOS DST grant (260925): the pure parts of the Electron/osascript MacGrant. */
import { describe, it, expect } from 'vitest';
import { GRANT_COPY, finderDuplicateArgs } from './macGrant';

describe('macGrant', () => {
  it('passes every path as argv, never inside the AppleScript source', () => {
    const dest = "/Users/me/Library/Application Support/Steam/steamapps/common/Don't Starve Together/dontstarve_steam.app/Contents/mods";
    const args = finderDuplicateArgs(['/tmp/sei-dst-1/sei', '/tmp/sei-dst-1/modsettings.lua'], dest);
    const script = args.filter((_, i) => i % 2 === 1 && args[i - 1] === '-e');
    expect(script.join('\n')).toContain('tell application "Finder" to duplicate srcs to dest with replacing');
    expect(script.join('\n')).not.toContain("Don't");
    expect(args.slice(-3)).toEqual([dest, '/tmp/sei-dst-1/sei', '/tmp/sei-dst-1/modsettings.lua']);
  });

  it('the panel copy is short, has no em dash, and names the button it shows', () => {
    for (const lang of ['en', 'zh'] as const) {
      const c = GRANT_COPY[lang];
      for (const s of [c.message, c.hint, c.button]) expect(s).not.toContain('—');
      expect(c.message).toContain(c.button);
      expect(c.message.length).toBeLessThan(120);
    }
    expect(GRANT_COPY.en.message).toBe("macOS needs your OK once. Click Install helper to let Sei add its helper to Don't Starve Together.");
  });
});
