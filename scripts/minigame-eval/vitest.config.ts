/**
 * Vitest config for the minigame eval (not part of `npm test`: the files are
 * `*.eval.ts`, outside the default include). Run one eval with e.g.
 *
 *   env -u POSTHOG_KEY npx vitest run --config scripts/minigame-eval/vitest.config.ts \
 *     scripts/minigame-eval/skill.eval.ts
 *
 * See scripts/minigame-eval/README.md for the env knobs.
 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve('src/renderer/src'),
      '@shared': path.resolve('src/shared'),
    },
  },
  test: {
    include: ['scripts/minigame-eval/**/*.eval.ts'],
    setupFiles: ['scripts/minigame-eval/setup.ts'],
    testTimeout: 0,
    hookTimeout: 0,
    // Live API runs: never retry a game behind our back.
    retry: 0,
    pool: 'forks',
    fileParallelism: false,
  },
});
