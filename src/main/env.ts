/**
 * Build-time-injected env vars — all OPTIONAL since the 260704 anon-key
 * migration.
 *
 * Default wiring (no .env at all — the GitHub build-from-source path):
 * Supabase access routes through the sei proxy's transparent `/supabase/*`
 * reverse proxy (`https://api.sei.gg/supabase`). The proxy holds the real
 * anon key and injects it server-side; the client sends a placeholder that
 * the proxy recognizes as "anonymous client" and replaces. A signed-in
 * user's JWT bearer passes through untouched, so RLS behaves identically to
 * hitting Supabase directly.
 *
 * Overrides (a .env with SUPABASE_URL + SUPABASE_ANON_KEY): electron-vite's
 * main.define replaces `import.meta.env.SUPABASE_URL` / `SUPABASE_ANON_KEY`
 * with the .env values at BUILD time, and the client talks to that Supabase
 * project directly — the path for self-hosters pointing at their own stack.
 *
 * Source: 10-01-PLAN, RESEARCH §Standard Stack; 260704 anon-key migration
 * (sei-proxy src/supabaseProxy/forward.ts holds the header contract).
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

/** Same default as every SEI_PROXY_URL consumer (botSupervisor, proxyClient…). */
const PROXY_BASE_DEFAULT = 'https://api.sei.gg';

/**
 * Placeholder anon key sent when none is baked into the build. Never accepted
 * by Supabase itself — the proxy's /supabase route overwrites the `apikey`
 * header and swaps an `Authorization: Bearer <this placeholder>` (supabase-js's
 * signed-out default) for the real anon bearer before forwarding.
 */
export const PROXY_ROUTED_ANON_KEY = 'sei-proxy-routed';

export function getSupabaseUrl(): string {
  if (URL_RAW && URL_RAW.length > 0) return URL_RAW;
  const proxyBase = process.env.SEI_PROXY_URL ?? PROXY_BASE_DEFAULT;
  return `${proxyBase}/supabase`;
}

export function getSupabaseAnonKey(): string {
  if (ANON_RAW && ANON_RAW.length > 0) return ANON_RAW;
  return PROXY_ROUTED_ANON_KEY;
}
