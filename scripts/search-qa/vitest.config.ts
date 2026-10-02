import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Search QA harnesses: live model + live web, so they are kept out of the
// unit suite (`*.qa.ts` never matches the default include) and run only
// through this config. Usage and env knobs are in each harness's header
// (backseat.qa.ts, minecraft.qa.ts); the dev test key is read from
// ~/.sei-dev/anthropic-test-key unless ANTHROPIC_API_KEY is set.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve('src/renderer/src'),
      '@shared': path.resolve('src/shared'),
    },
  },
  test: {
    include: ['scripts/search-qa/**/*.qa.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    reporters: ['verbose'],
  },
});
