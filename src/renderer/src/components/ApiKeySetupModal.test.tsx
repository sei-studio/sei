/**
 * ApiKeySetupModal (260915): Ollama is keyless — the key field is replaced by a
 * note and Save is enabled with an empty key, so the modal can actually switch
 * to a local model (it used to gate Save on a non-empty field for every
 * provider, contradicting its own empty-key-is-valid-for-ollama rule).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const src = readFileSync(resolve(__dirname, 'ApiKeySetupModal.tsx'), 'utf-8');

describe('ApiKeySetupModal: keyless Ollama', () => {
  it('enables Save without a key for ollama only', () => {
    expect(src).toContain("const keyless = provider === 'ollama';");
    expect(src).toContain("const canSave = (apiKey.trim() !== '' || keyless) && !saving;");
  });
  it('replaces the key field with the keyless note', () => {
    expect(src).toMatch(/keyless \? \(\s*<p[^]*?needs no API key[^]*?\) : \(\s*<div className=\{styles\.keyField\}/);
  });
  it('still never saves an empty key', () => {
    expect(src).toContain('if (key) await sei.saveApiKey(key);');
  });
});
