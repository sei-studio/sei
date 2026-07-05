import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  // Pull optional overrides from .env at config load. Empty prefix = read all
  // keys; we whitelist explicitly below so we never expose unrelated shell env
  // vars to the bundle. Since the 260704 anon-key migration ALL of these are
  // optional — with no .env, Supabase access routes through the sei proxy
  // (api.sei.gg/supabase) which injects the anon key server-side (env.ts).
  const env = loadEnv(mode, process.cwd(), '');
  return {
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: { index: path.resolve('src/main/index.ts') },
      },
    },
    define: {
      // OPTIONAL direct-to-Supabase override (self-hosters). ANON key is
      // public-by-design (RLS is the security gate). See .env.example.
      'import.meta.env.SUPABASE_URL': JSON.stringify(env.SUPABASE_URL ?? ''),
      'import.meta.env.SUPABASE_ANON_KEY': JSON.stringify(env.SUPABASE_ANON_KEY ?? ''),
      // Phase 13 — proxy host. Read at main-process module load via
      // process.env.* (proxyClient.ts, botSupervisor.ts). Checkout + portal
      // sessions are minted server-side by the proxy (Polar migration 2026-06),
      // so no product/variant ids are injected into the client bundle anymore.
      //
      // Defined ONLY when set (260704): an unconditional `?? ''` define
      // substituted the literal '' into every `process.env.SEI_PROXY_URL ??
      // 'https://api.sei.gg'` consumer, silently killing the default for
      // .env-less (GitHub from-source) builds. Leaving the key undefined keeps
      // the expression as a real runtime env lookup → undefined → fallback.
      ...(env.SEI_PROXY_URL
        ? { 'process.env.SEI_PROXY_URL': JSON.stringify(env.SEI_PROXY_URL) }
        : {}),
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: { index: path.resolve('src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name]-[hash].cjs',
        },
      },
    },
  },
  renderer: {
    root: path.resolve('src/renderer'),
    // file:// in packaged builds needs relative asset URLs; without this,
    // url('/img/...') in CSS resolves to filesystem root → ERR_FILE_NOT_FOUND.
    base: './',
    build: {
      outDir: path.resolve('dist/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: path.resolve('src/renderer/index.html') },
      },
    },
    plugins: [react()],
    // Voice dictation (260705): the Whisper STT worker
    // (lib/voice/whisperWorker.ts) imports @huggingface/transformers, which
    // code-splits — Vite's default iife worker format can't hold multiple
    // chunks, so production builds need ES-module workers (dev always uses
    // ESM workers regardless).
    worker: {
      format: 'es' as const,
    },
    resolve: {
      alias: {
        '@': path.resolve('src/renderer/src'),
        '@shared': path.resolve('src/shared'),
      },
    },
  },
  };
});
