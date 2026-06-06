/**
 * Build-time-injected env vars.
 *
 * Wiring: electron.vite.config.ts main.define replaces `import.meta.env.SUPABASE_URL`
 * (and SUPABASE_ANON_KEY) with the JSON-stringified value of process.env.<NAME> at
 * BUILD time. Dev runs `electron-vite dev` which reads from .env automatically.
 *
 * If you see SUPABASE_ENV_MISSING at boot, your .env is missing or the build
 * was produced without the env vars set. See .env.example.
 *
 * Source: 10-01-PLAN, RESEARCH §Standard Stack, CONTEXT D-13 (safeStorage pattern reuse).
 */

// Augment ImportMeta so the build-time-defined env vars are typed in the
// main bundle. electron-vite rewrites these via `define` at build; at runtime
// the substituted string literals replace `import.meta.env.SUPABASE_URL`.
declare global {
  interface ImportMeta {
    readonly env: {
      readonly SUPABASE_URL?: string;
      readonly SUPABASE_ANON_KEY?: string;
    };
  }
}

const URL_RAW = import.meta.env.SUPABASE_URL as string | undefined;
const ANON_RAW = import.meta.env.SUPABASE_ANON_KEY as string | undefined;

function requireEnv(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(`SUPABASE_ENV_MISSING: ${name} must be set at build time (see .env.example)`);
  }
  return value;
}

// Lazy getters so module import doesn't crash when env is missing in test envs
// that never call into Supabase.
export function getSupabaseUrl(): string {
  return requireEnv('SUPABASE_URL', URL_RAW);
}
export function getSupabaseAnonKey(): string {
  return requireEnv('SUPABASE_ANON_KEY', ANON_RAW);
}
