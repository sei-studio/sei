// scripts/lib/electron-stub-loader.mjs
//
// Tiny Node `--import` hook used by Phase 9 verify scripts that import
// src/main/* modules transitively. Substitutes the `electron` package with a
// tiny stub (electron-stub.mjs) so `app.getPath('userData')` inside
// src/main/paths.ts doesn't throw outside an Electron context.
//
// Usage:
//   tsx --import ./scripts/lib/electron-stub-loader.mjs scripts/verify-<x>.mjs
//
// Implementation note: there's a subtle interaction between tsx's loader
// (auto-registered when tsx is the runner) and additional --import hooks
// that fall through via `nextResolve` — chained hook registrations break
// tsx's `.ts` transform pipeline (the .ts file resolves but the load hook's
// transform output gets eaten somewhere downstream). To work around this,
// the hook below uses a custom resolve that performs the electron redirect
// AND a custom `load` hook that, for .ts files, manually invokes esbuild's
// transform to produce JS (the same thing tsx would have done). This keeps
// the chain self-contained.
import { register } from 'node:module';

register('./hook.mjs', import.meta.url);
