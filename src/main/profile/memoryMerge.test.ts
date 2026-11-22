import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mergeJsonlByTs,
  mergeMemoryDir,
  mergeMemoryMarkdown,
  mergeWorldRegistries,
  renumberWorldHeaders,
  UNREGISTERED_WORLD_FP,
} from './memoryMerge';

const HEADER = '# Memory\n\nAppend-only record. One line per entry. Written via remember(); removed via forget().\n\n';

describe('mergeMemoryMarkdown', () => {
  it('keeps the account text byte for byte and appends only new local lines', () => {
    const target = HEADER + '- [2026-10-01T00:00:00.000Z] a\n\n## World 1 â€” Base\n- [2026-10-01T01:00:00.000Z] b\n';
    const local = HEADER + '- [2026-10-01T00:00:00.000Z] a\n\n## World 1 â€” Base\n- [2026-10-01T01:00:00.000Z] b\n- [2026-09-01T00:00:00.000Z] c\n';
    const out = mergeMemoryMarkdown(target, local);
    expect(out.startsWith(target.trimEnd())).toBe(true);
    expect(out.endsWith('## World 1 â€” Base\n- [2026-09-01T00:00:00.000Z] c\n')).toBe(true);
    expect(mergeMemoryMarkdown(out, local)).toBe(out);
  });

  it('puts local entries from before any section ahead of the account sections', () => {
    const target = HEADER + '## World 1 â€” Base\n- [2026-10-01T01:00:00.000Z] b\n';
    const local = HEADER + '- [2026-09-01T00:00:00.000Z] loose\n';
    const out = mergeMemoryMarkdown(target, local);
    expect(out.indexOf('loose')).toBeLessThan(out.indexOf('## World 1'));
  });

  it('takes the local file whole when the account has none', () => {
    const local = HEADER + '- [2026-09-01T00:00:00.000Z] only\n';
    expect(mergeMemoryMarkdown('', local)).toBe(local);
  });
});

describe('world numbering', () => {
  it('maps known worlds by fingerprint and gives new ones the next free number', () => {
    const { merged, map } = mergeWorldRegistries(
      { version: 1, worlds: [{ num: 1, fingerprint: 'a' }] },
      { version: 1, worlds: [{ num: 1, fingerprint: 'b' }, { num: 2, fingerprint: 'a' }] },
      3,
    );
    expect(map.get(1)).toBe(4);
    expect(map.get(2)).toBe(1);
    expect(merged.worlds.map((w) => [w.fingerprint, w.num])).toEqual([['a', 1], ['b', 4]]);
  });

  it('gives a local header with no registry entry a fresh, reserved number', () => {
    const { merged, map } = mergeWorldRegistries(
      { version: 1, worlds: [{ num: 1, fingerprint: 'a' }, { num: 2, fingerprint: 'c' }] },
      { version: 1, worlds: [{ num: 1, fingerprint: 'b' }] },
      2,
      [3, 1, 3],
    );
    // Registered local World 1 is new here: 3. Unregistered World 3: 4.
    expect(map.get(1)).toBe(3);
    expect(map.get(3)).toBe(4);
    // The reservation keeps the bot's next new world (max + 1) off 4.
    expect(merged.worlds.find((w) => w.num === 4)?.fingerprint).toBe(`${UNREGISTERED_WORLD_FP}3`);
    expect(Math.max(...merged.worlds.map((w) => w.num))).toBe(4);
  });

  it('maps an unregistered header to its earlier reservation on a re-run', () => {
    const first = mergeWorldRegistries({ version: 1, worlds: [{ num: 1, fingerprint: 'a' }] }, { version: 1, worlds: [] }, 1, [1]);
    expect(first.map.get(1)).toBe(2);
    const again = mergeWorldRegistries(first.merged, { version: 1, worlds: [] }, 2, [1]);
    expect(again.map.get(1)).toBe(2);
    expect(again.merged.worlds).toHaveLength(2);
  });

  it('renumbers headers in one pass (a swap does not chain)', () => {
    const text = '## World 1 â€” X\n- e1\n## World 2 â€” Y\n- e2\n## World 12 â€” Z\n';
    const out = renumberWorldHeaders(text, new Map([[1, 2], [2, 1]]));
    expect(out).toBe('## World 2 â€” X\n- e1\n## World 1 â€” Y\n- e2\n## World 12 â€” Z\n');
  });
});

describe('mergeJsonlByTs', () => {
  it('unions rows and orders them by ts, keeping ts-less rows next to their neighbour', () => {
    const t = '{"ts":2,"text":"t2"}\n{"ts":4,"text":"t4"}\n';
    const l = '{"ts":1,"text":"l1"}\n{"text":"no-ts"}\n{"ts":2,"text":"t2"}\n{"ts":3,"text":"l3"}\n';
    const out = mergeJsonlByTs(t, l)
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x).text);
    expect(out).toEqual(['l1', 'no-ts', 't2', 'l3', 't4']);
    expect(mergeJsonlByTs(mergeJsonlByTs(t, l), l)).toBe(mergeJsonlByTs(t, l));
  });
});

describe('mergeMemoryDir: local World headers without a worlds.json entry', () => {
  let tmp = '';
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = '';
  });

  it('files them under a new number instead of the account world with the same one', async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'sei-memmerge-'));
    const src = path.join(tmp, 'local');
    const dest = path.join(tmp, 'account');
    await mkdir(src, { recursive: true });
    await mkdir(dest, { recursive: true });
    await writeFile(
      path.join(dest, 'MEMORY.md'),
      HEADER + '## World 1 â€” Acct Base\n- [2026-10-01T00:00:00.000Z] account fact\n',
    );
    await writeFile(path.join(dest, 'worlds.json'), JSON.stringify({ version: 1, worlds: [{ num: 1, fingerprint: 'acct' }] }));
    // The local registry is gone; its MEMORY.md still names World 1.
    await writeFile(
      path.join(src, 'MEMORY.md'),
      HEADER + '## World 1 â€” Local Farm\n- [2026-09-01T00:00:00.000Z] local fact\n',
    );

    await mergeMemoryDir(src, dest);

    const memory = await readFile(path.join(dest, 'MEMORY.md'), 'utf8');
    expect(memory).toMatch(/## World 1 â€” Acct Base\n- \[2026-10-01T00:00:00.000Z\] account fact/);
    expect(memory).toMatch(/## World 2 â€” Local Farm\n- \[2026-09-01T00:00:00.000Z\] local fact/);
    const reg = JSON.parse(await readFile(path.join(dest, 'worlds.json'), 'utf8'));
    expect(reg.worlds.map((w: { num: number }) => w.num)).toEqual([1, 2]);
  });
});




