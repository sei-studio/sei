import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror the renderer build aliases (electron.vite.config.ts) so a test that
  // actually imports a renderer module resolves its `@shared` / `@` value
  // imports at runtime (a bare `import type` is erased, but a value import like
  // countsAsHomeSlot is not).
  resolve: {
    alias: {
      '@': path.resolve('src/renderer/src'),
      '@shared': path.resolve('src/shared'),
    },
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      // Vendored sibling packages (procgen: soulcaster, img2skin) ship their
      // own test suites (node:test), validated in their own repos, not here.
      'vendor/**',
      // electron-builder output: app.asar.unpacked contains a full copy of
      // src/bot/** (asarUnpack), so vitest would re-run every bot test from
      // the stale packaged snapshot.
      '**/release/**',
      '**/.claude/worktrees/**',
      'test/**/*.test.mjs',
      // Supabase Edge Functions are Deno tests (jsr:/std specifiers, Deno
      // globals). They run under `deno test` from inside each function dir,
      // never under Node/vitest — exclude so the vitest suite doesn't try to
      // resolve Deno-only imports.
      'supabase/functions/**',
      // `tsc --build` (typecheck) emits a `.js` twin next to every renderer
      // `.test.tsx` / `.test.ts` (tsconfig.web.json has no outDir/noEmit).
      // These are gitignored build artifacts — running them would double every
      // renderer test AND run STALE assertions in the window between a source
      // edit and the next typecheck. The `.tsx`/`.ts` source is the only copy
      // vitest should execute. (Hand-authored `.test.js` live under src/bot/**,
      // which these globs don't touch.)
      'src/renderer/**/*.test.js',
      // Same twin hazard for src/shared (also in tsconfig.web's include): CI
      // runs typecheck before test, so without this the shared suite runs
      // twice — once from the stale emitted `.js`.
      'src/shared/**/*.test.js',
    ],
  },
});
