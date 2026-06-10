import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
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
      // which this glob doesn't touch.)
      'src/renderer/**/*.test.js',
    ],
  },
});
