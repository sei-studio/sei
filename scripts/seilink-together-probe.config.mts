// Runs only the decorating-together probe (scripts/seilink-together-probe.vitest.ts); the suite never picks it up.
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vitest.config';

export default mergeConfig(base, defineConfig({ test: { include: ['scripts/seilink-together-probe.vitest.ts'], exclude: [] } }));
