/**
 * Source-contract tests for the local (BYOK) generateUnique path (260817,
 * china-compat W6). The orchestrator is electron-coupled, so the mode split
 * is pinned grep-style over the source (same convention as the renderer's
 * screen tests): the CLOUD guard and route selection must stay exactly as
 * they were, and the LOCAL path must exist with its three deliberate
 * degradations (vendored prompts, JWT-gated portrait/skin, null owner).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, 'uniqueGeneration.ts'), 'utf-8');

describe('generateUnique backend guard (W6)', () => {
  it('cloud-proxy still requires a signed-in session', () => {
    expect(src).toContain("backendKind === 'cloud-proxy' && (!jwt || !userId)");
    expect(src).toContain("code: 'not_signed_in'");
  });
  it('the old local-mode rejection is gone', () => {
    expect(src).not.toContain('Switch to managed billing (cloud) to generate');
  });
});

describe('local sheet + persona routing (W6)', () => {
  it('the sheet dispatches by backend: proxy soulcast for cloud, vendored castSoul for local', () => {
    expect(src).toContain("backendKind === 'cloud-proxy'");
    expect(src).toContain('castSoulViaProxy');
    expect(src).toContain('castSoulLocal');
  });
  it('castSoulLocal drives soulcaster castSoul through the main llm layer', () => {
    const fn = src.slice(src.indexOf('async function castSoulLocal'), src.indexOf('async function postSoulcast'));
    expect(fn).toContain("await import('soulcaster')");
    expect(fn).toContain('buildLlmProvider');
    expect(fn).toContain('castSoul({');
  });
  it('the local persona branch passes the anthropic key explicitly and fetches the server prompt best-effort', () => {
    const persona = src.slice(src.indexOf('const personaBranch'), src.indexOf('Promise.allSettled'));
    expect(persona).toContain('localProviderKind');
    expect(persona).toContain('expansionInput.apiKey = await loadApiKey()');
    expect(persona).toContain('fetchServerExpansionSystem');
    // Cloud branch unchanged: /free/expand with the Bearer JWT.
    expect(persona).toContain('/free/expand');
  });
});

describe('JWT-gated proxy stages (W6)', () => {
  it('portrait/skin run only with a session (signed-out local saves portraitless)', () => {
    expect(src).toContain('const portraitSkinBranch = jwt === null ? Promise.resolve()');
  });
  it('the public_id fetch-back is signed-in only', () => {
    expect(src).toContain('if (jwt !== null) try {');
  });
  it('owner rides the (nullable) session user id', () => {
    expect(src).toContain('owner: userId');
    expect(src).toContain('jwt: string | null');
    expect(src).toContain('userId: string | null');
  });
});
