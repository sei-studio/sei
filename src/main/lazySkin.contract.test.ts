/**
 * 261027 lazy skins, pinned at the source: the billed Gemini skin call
 * (POST /generate/skin) lives in skinGeneration.ts ONLY. Creation paints the
 * free skin and marks the character pending; nothing else in main, the bot
 * or the renderer may reach the route.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'fixtures') continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('lazy skin contract', () => {
  it('only skinGeneration.ts calls /generate/skin', () => {
    const callers = sourceFiles(SRC)
      .filter((f) => /fetch\([^)]*\/generate\/skin/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(callers).toEqual([path.join('main', 'skinGeneration.ts')]);
  });

  it('the cast paints the free skin and marks the character pending', () => {
    const cast = readFileSync(path.join(SRC, 'main', 'uniqueGeneration.ts'), 'utf8');
    expect(cast).not.toMatch(/generate\/skin/);
    expect(cast).toMatch(/paintFallbackSkin\(/);
    expect(cast).toMatch(/\[SKIN_PENDING_KEY\]: true/);
    expect(cast).toMatch(/skinPending: true/);
  });
});




