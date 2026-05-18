// scripts/lib/hook.mjs
//
// Self-contained module-resolver hook used by Phase 9 verify scripts. Handles
// TWO things in one chain so we don't fight with tsx's hook ordering:
//   1. `import { app } from 'electron'` → redirect to electron-stub.mjs
//   2. `.ts` files → transpile via esbuild ourselves (replicates what tsx
//      would do at the load stage; running tsx + our hook together caused
//      tsx's transform output to come back empty, so we do the transform
//      directly inside our load hook instead).
//
// This is paired with scripts/lib/electron-stub-loader.mjs which calls
// register('./hook.mjs', ...). Verify scripts should be run via plain `node
// --import` (NOT `tsx --import`) since we're handling the .ts case ourselves.
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const stubUrl = pathToFileURL(path.join(here, 'electron-stub.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: stubUrl, shortCircuit: true, format: 'module' };
  }
  // TS-aware resolution: when a relative `./foo` import is missing its
  // extension, Node's default resolver won't find a matching `.ts` file
  // (extensions other than .mjs/.cjs/.js need to be explicit). Try `.ts`
  // / `.tsx` ourselves before delegating.
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.(m?js|c?js|ts|tsx|json)$/.test(specifier) &&
    context.parentURL
  ) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    for (const ext of ['.ts', '.tsx']) {
      const candidate = path.resolve(parentDir, specifier + ext);
      try {
        const { stat } = await import('node:fs/promises');
        await stat(candidate);
        return {
          url: pathToFileURL(candidate).href,
          format: 'module',
          shortCircuit: true,
        };
      } catch {
        /* try next */
      }
    }
  }
  const result = await nextResolve(specifier, context);
  // Tag .ts URLs with our format so the load hook below picks them up.
  if (result.url.endsWith('.ts') || result.url.endsWith('.tsx')) {
    return { ...result, format: 'module', shortCircuit: true };
  }
  return result;
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const { code } = await transform(source, {
      loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
      format: 'esm',
      target: 'esnext',
      sourcefile: fileURLToPath(url),
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
