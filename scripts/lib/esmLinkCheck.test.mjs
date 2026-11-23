import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkEsmLinks } from './esmLinkCheck.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The guard itself: every module the packaged app loads unbundled must link
// under plain Node ESM. Vitest cannot see this class of bug on its own (its
// transform turns a missing named export into `undefined`), which is how
// v0.7.0-beta.5 shipped a bot that never loaded.
describe('packaged ESM link check (this checkout)', () => {
  it('every src/bot and vendored runtime import links under plain Node ESM', () => {
    const { errors, stats } = checkEsmLinks({ root: REPO });
    expect(errors).toEqual([]);
    expect(stats.files).toBeGreaterThan(100);
  }, 60_000);
});

let dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Build a throwaway tree with one root at src/bot (type: module). */
function fixture(files, { typeModule = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'esm-link-'));
  dirs.push(root);
  const all = { ...(typeModule ? { 'src/bot/package.json': '{"type":"module"}' } : {}), ...files };
  for (const [rel, content] of Object.entries(all)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return checkEsmLinks({ root, roots: [{ dir: 'src/bot', boundary: 'src/bot' }] }).errors;
}

describe('esmLinkCheck', () => {
  it('catches the v0.7.0-beta.5 incident: a named import the barrel does not re-export', () => {
    const errors = fixture({
      'src/bot/brain/prompts/language.js': 'export function renderAdoptedLanguageNote() {}\nexport const other = 1;\n',
      'src/bot/brain/prompts/core.js': 'export const buildSystemPrompt = () => "";\n',
      'src/bot/brain/prompts.js': "export { buildSystemPrompt } from './prompts/core.js';\nexport { other } from './prompts/language.js';\n",
      'src/bot/brain/orchestrator.js': "import { buildSystemPrompt, renderAdoptedLanguageNote } from './prompts.js';\nexport { buildSystemPrompt, renderAdoptedLanguageNote };\n",
    });
    expect(errors).toEqual([
      "src/bot/brain/orchestrator.js:1: './prompts.js' does not provide an export named 'renderAdoptedLanguageNote'",
    ]);
  });

  it('passes once the barrel re-exports it, directly or through export * chains', () => {
    expect(
      fixture({
        'src/bot/a.js': 'export const deep = 1;\nexport default 2;\n',
        'src/bot/b.js': "export * from './a.js';\nexport { default as aDefault } from './a.js';\n",
        'src/bot/barrel.js': "export * from './b.js';\nexport * as ns from './a.js';\nimport { deep as d } from './a.js';\nexport { d as renamed };\n",
        'src/bot/use.js': "import { deep, aDefault, ns, renamed } from './barrel.js';\nimport * as all from './barrel.js';\nexport { deep, aDefault, ns, renamed, all };\n",
      }),
    ).toEqual([]);
  });

  it('export * never forwards default, and a re-export of a missing binding fails downstream too', () => {
    const errors = fixture({
      'src/bot/a.js': 'export default 1;\nexport const x = 1;\n',
      'src/bot/b.js': "export * from './a.js';\n",
      'src/bot/c.js': "import { gone } from './a.js';\nexport { gone };\n",
      'src/bot/use.js': "import b from './b.js';\nimport { gone } from './c.js';\nexport { b, gone };\n",
    });
    expect(errors).toEqual([
      "src/bot/c.js:1: './a.js' does not provide an export named 'gone'",
      "src/bot/use.js:1: './b.js' does not provide an export named 'default'",
      "src/bot/use.js:2: './c.js' does not provide an export named 'gone'",
    ]);
  });

  it('reports an ambiguous name from two export * sources', () => {
    const errors = fixture({
      'src/bot/a.js': 'export const dup = 1;\n',
      'src/bot/b.js': 'export const dup = 2;\n',
      'src/bot/barrel.js': "export * from './a.js';\nexport * from './b.js';\n",
      'src/bot/use.js': "import { dup } from './barrel.js';\nexport { dup };\n",
    });
    expect(errors).toEqual(["src/bot/use.js:1: './barrel.js' export 'dup' is ambiguous (conflicting `export *`)"]);
  });

  it('resolves relative specifiers like Node ESM: exact file, no extension guessing', () => {
    const errors = fixture({
      'src/bot/a.js': 'export const x = 1;\n',
      'src/bot/use.js': "import { x } from './a';\nimport './missing.js';\nconst later = () => import('./nope.js');\nexport { x, later };\n",
    });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/use\.js:1: cannot resolve '\.\/a'.*did you mean '\.\/a\.js'/);
    expect(errors[1]).toMatch(/use\.js:2: cannot resolve '\.\/missing\.js'/);
    expect(errors[2]).toMatch(/use\.js:3: dynamic import\(\) cannot resolve '\.\/nope\.js'/);
  });

  it('flags imports that leave the shipped tree', () => {
    const errors = fixture({
      'src/shared/thing.js': 'export const t = 1;\n',
      'src/bot/use.js': "import { t } from '../shared/thing.js';\nexport { t };\n",
    });
    expect(errors).toEqual([
      "src/bot/use.js:1: '../shared/thing.js' resolves outside the shipped tree (src/bot), so the packaged app does not have it",
    ]);
  });

  it('checks builtins and JSON import attributes', () => {
    const errors = fixture({
      'src/bot/data.json': '{"a":1}',
      'src/bot/use.js': [
        "import { join, notAThing } from 'node:path';",
        "import { EventEmitter } from 'events';",
        "import data from './data.json' with { type: 'json' };",
        "import bad from './data.json';",
        'export { join, notAThing, EventEmitter, data, bad };',
      ].join('\n'),
    });
    expect(errors).toEqual([
      "src/bot/use.js:1: 'node:path' does not provide an export named 'notAThing'",
      "src/bot/use.js:4: './data.json' is JSON and needs `with { type: 'json' }`",
    ]);
  });

  it('checks ESM packages through their exports map and leaves CommonJS named imports alone', () => {
    const errors = fixture({
      'node_modules/esm-pkg/package.json': JSON.stringify({
        name: 'esm-pkg',
        type: 'module',
        exports: { '.': { types: './x.d.ts', import: './index.js', require: './index.cjs' }, './sub/*': './lib/*.js' },
      }),
      'node_modules/esm-pkg/index.js': "export * from './lib/real.js';\n",
      'node_modules/esm-pkg/lib/real.js': 'export const real = 1;\n',
      'node_modules/cjs-pkg/package.json': JSON.stringify({ name: 'cjs-pkg', main: 'index.js' }),
      'node_modules/cjs-pkg/index.js': 'module.exports = { a: 1 };\n',
      'src/bot/use.js': [
        "import { real, fake } from 'esm-pkg';",
        "import { real as r2 } from 'esm-pkg/sub/real';",
        "import 'esm-pkg/hidden.js';",
        "import { anything } from 'cjs-pkg';",
        "import 'not-installed';",
        'export { real, fake, r2, anything };',
      ].join('\n'),
    });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBe("src/bot/use.js:1: 'esm-pkg' does not provide an export named 'fake'");
    expect(errors[1]).toMatch(/use\.js:3: 'esm-pkg\/hidden\.js': subpath '\.\/hidden\.js' is not exported/);
    expect(errors[2]).toMatch(/use\.js:5: cannot resolve package 'not-installed'/);
  });

  it('requires the shipped tree to declare type: module and to parse as ESM', () => {
    const errors = fixture({ 'src/bot/use.js': 'export const x = ;\n' }, { typeModule: false });
    expect(errors[0]).toMatch(/src\/bot\/package\.json: must exist and declare "type": "module"/);
    expect(errors[1]).toMatch(/src\/bot\/use\.js: does not parse as an ES module/);
  });

  it('skips test files and fixtures, which never ship', () => {
    expect(
      fixture({
        'src/bot/a.test.js': "import { nope } from './missing.js';\n",
        'src/bot/fixtures/f.js': "import { nope } from './missing.js';\n",
        'src/bot/brain/__fixtures__/f.js': "import { nope } from './missing.js';\n",
      }),
    ).toEqual([]);
  });
});
