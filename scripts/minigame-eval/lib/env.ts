/**
 * Shared eval plumbing: the dev key (read in-process, never printed), the
 * output dir, list prices, the metered companion provider and the character
 * registry the setup shim reads from.
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { LlmCallParams, LlmProvider, LlmResult } from '../../../src/main/llm/types';
import { createAnthropicProvider } from '../../../src/main/llm/anthropic';
import { _setUserDataOverride } from '../../../src/main/paths';

// ── key + output ────────────────────────────────────────────────────────────

export function loadApiKey(): string {
  const env = process.env.ANTHROPIC_API_KEY?.trim();
  if (env) return env;
  const file = path.join(homedir(), '.sei-dev', 'anthropic-test-key');
  if (!existsSync(file)) throw new Error('mg-eval: no ANTHROPIC_API_KEY and no ~/.sei-dev/anthropic-test-key');
  return readFileSync(file, 'utf8').trim();
}

/** Where runs write transcripts and metrics (MG_EVAL_OUT, else a temp dir). */
export const OUT_DIR: string = (() => {
  const dir = process.env.MG_EVAL_OUT || path.join(tmpdir(), 'mg-eval-out');
  mkdirSync(dir, { recursive: true });
  return dir;
})();

export function outPath(...parts: string[]): string {
  const p = path.join(OUT_DIR, ...parts);
  mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

export function writeJson(file: string, data: unknown): void {
  writeFileSync(outPath(file), JSON.stringify(data, null, 2));
}

export function appendJsonl(file: string, row: unknown): void {
  appendFileSync(outPath(file), JSON.stringify(row) + '\n');
}

// ── prices (public list prices, $ per million tokens) ──────────────────────

type Price = { in: number; cw: number; cr: number; out: number };
export const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 },
  'claude-sonnet-5-5': { in: 2, cw: 2.5, cr: 0.1, out: 10 },
  'claude-opus-5-5': { in: 4, cw: 5, cr: 0.2, out: 20 },
};

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costOf(model: string, u: Usage | undefined): number {
  const p = PRICES[model];
  if (!p || !u) return 0;
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.cache_creation_input_tokens ?? 0) * p.cw +
      (u.cache_read_input_tokens ?? 0) * p.cr +
      (u.output_tokens ?? 0) * p.out) /
    1e6
  );
}

// ── the companion provider, metered ─────────────────────────────────────────

export interface CallRecord {
  at: number;
  ms: number;
  /** What the turn block asked for (move / place / chat-reply / game-over). */
  kind: string;
  usage: Usage | undefined;
  cost: number;
  stopReason: string | null;
  /** Plain text the model wrote (scratch on move turns, spoken on chat turns). */
  text: string;
  tools: Array<{ name: string; input: unknown }>;
  error?: string;
}

function lastUserText(p: LlmCallParams): string {
  const m = p.messages[p.messages.length - 1];
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (m.content as Array<{ type: string; text?: string; content?: unknown }>)
    .map((b) => (b.type === 'text' ? b.text ?? '' : b.type === 'tool_result' ? String(b.content ?? '') : ''))
    .join('\n');
}

function turnKindOf(p: LlmCallParams): string {
  const t = lastUserText(p);
  if (/The game is over\./.test(t)) return 'game-over';
  if (/They just said something/.test(t)) return 'chat-reply';
  if (/Place your fleet now|place_fleet\(\) with all five/.test(t)) return 'place';
  if (/It is YOUR (shot|move)/.test(t)) return 'move';
  // A follow-up hop of a turn (tool_result / nudge): same kind as before.
  return 'hop';
}

export class Meter {
  calls: CallRecord[] = [];
  inflight = 0;
  private lastKind = 'move';

  reset(): CallRecord[] {
    const out = this.calls;
    this.calls = [];
    return out;
  }

  get cost(): number {
    return this.calls.reduce((a, c) => a + c.cost, 0);
  }

  async idle(quietMs = 800, maxMs = 30_000): Promise<void> {
    const t0 = Date.now();
    let quietSince = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (this.inflight > 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) return;
      await sleep(50);
    }
  }

  wrap(inner: LlmProvider): LlmProvider {
    return {
      ...inner,
      call: async (params: LlmCallParams): Promise<LlmResult> => {
        let kind = turnKindOf(params);
        if (kind === 'hop') kind = this.lastKind;
        else this.lastKind = kind;
        const at = Date.now();
        this.inflight++;
        try {
          const res = await inner.call(params);
          const content = (res.content ?? []) as Array<{ type: string; text?: string; name?: string; input?: unknown }>;
          this.calls.push({
            at,
            ms: Date.now() - at,
            kind,
            usage: res.usage as Usage,
            cost: costOf(inner.model ?? 'claude-haiku-5-5', res.usage as Usage),
            stopReason: res.stopReason ?? null,
            text: content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim(),
            tools: content.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name ?? '', input: b.input })),
          });
          return res;
        } catch (err) {
          this.calls.push({
            at,
            ms: Date.now() - at,
            kind,
            usage: undefined,
            cost: 0,
            stopReason: null,
            text: '',
            tools: [],
            error: String((err as Error)?.message ?? err).slice(0, 300),
          });
          throw err;
        } finally {
          this.inflight--;
        }
      },
    };
  }
}

/** The app's real Anthropic provider (BYOK branch, see setup.ts), metered. */
export async function companionProvider(meter: Meter): Promise<LlmProvider> {
  const inner = await createAnthropicProvider('local' as never);
  return meter.wrap(inner);
}

// ── characters + process globals ────────────────────────────────────────────

export interface CharacterRow {
  id: string;
  name: string;
  owner: string | null;
  kind: string | null;
  persona_source: string | null;
  persona_expanded: string | null;
  metadata: Record<string, unknown> | null;
  shared?: boolean | null;
}

/** cloudCharacterClient.rowToCharacter, reduced to what the game turn reads. */
export function rowToCharacter(row: CharacterRow, id: string): Record<string, unknown> {
  const { description: _d, ...metadata } = (row.metadata ?? {}) as Record<string, unknown>;
  void _d;
  return {
    id,
    kind: row.kind ?? 'custom',
    public_id: null,
    name: row.name,
    slug: null,
    persona: { source: row.persona_source ?? '', expanded: row.persona_expanded ?? '' },
    is_default: false,
    shared: row.shared ?? true,
    owner: row.owner,
    metadata,
  };
}

const CHAR_CACHE = (): string => outPath('chars');

/** A public character row by name, from the run's cache (fetched once, never committed). */
export async function loadCharacterRow(name: string): Promise<CharacterRow> {
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(CHAR_CACHE())) {
    if (!f.endsWith('.json')) continue;
    const rows = JSON.parse(readFileSync(path.join(CHAR_CACHE(), f), 'utf8')) as CharacterRow[];
    const hit = (Array.isArray(rows) ? rows : [rows]).find((r) => r.name === name);
    if (hit) return hit;
  }
  // Public rows read through the proxy's /supabase route with the placeholder key (no account).
  const url =
    'https://api.sei.gg/supabase/rest/v1/characters?select=*&shared=eq.true&name=eq.' + encodeURIComponent(name);
  const res = await fetch(url, { headers: { apikey: 'sei-proxy-routed', Authorization: 'Bearer sei-proxy-routed' } });
  const rows = (await res.json()) as CharacterRow[];
  if (!rows.length) throw new Error(`mg-eval: no public character named ${name}`);
  writeFileSync(path.join(CHAR_CACHE(), `${name.replace(/\W+/g, '_')}.json`), JSON.stringify(rows));
  return rows[0];
}

/** Pinned rows when a name is ambiguous (two public "Chen Wei"s). */
export const CHARACTER_IDS: Record<string, string> = {
  Sui: 'bbf5b66f-2f0f-4918-a953-a2cf66d5a586',
  Lyra: 'e4511df2-fd20-470b-9131-f8f9968e1c01',
  Marv: '25770cd6-a50b-409d-a7e2-6cc2026dd673',
  'Eris Greyrat': '7c10f582-9176-4e72-b0be-56f0edc6398d',
  'Chen Wei': '4d44f1a0-a43a-4f6d-9dbd-e1c744d8cc27',
};

export async function characterRow(name: string): Promise<CharacterRow> {
  const want = CHARACTER_IDS[name];
  const { readdirSync } = await import('node:fs');
  if (want) {
    for (const f of readdirSync(CHAR_CACHE())) {
      if (!f.endsWith('.json')) continue;
      const rows = JSON.parse(readFileSync(path.join(CHAR_CACHE(), f), 'utf8')) as CharacterRow[];
      const hit = (Array.isArray(rows) ? rows : [rows]).find((r) => r.id === want);
      if (hit) return hit;
    }
    const url = `https://api.sei.gg/supabase/rest/v1/characters?select=*&id=eq.${want}`;
    const res = await fetch(url, { headers: { apikey: 'sei-proxy-routed', Authorization: 'Bearer sei-proxy-routed' } });
    const rows = (await res.json()) as CharacterRow[];
    if (rows.length) {
      writeFileSync(path.join(CHAR_CACHE(), `${want}.json`), JSON.stringify(rows));
      return rows[0];
    }
  }
  return loadCharacterRow(name);
}

export interface EvalGlobals {
  characters: Map<string, Record<string, unknown>>;
  captures: Array<{ event: string; props: Record<string, unknown>; at: number }>;
}

/**
 * Install the process globals setup.ts reads, and a fresh temp userData dir
 * (chat transcript, memory) for the run.
 */
export function installGlobals(playerName: string): EvalGlobals {
  const gl: EvalGlobals = { characters: new Map(), captures: [] };
  (globalThis as Record<string, unknown>).__mgEval = {
    getCharacter: (id: string) => gl.characters.get(id) ?? null,
    playerName,
    apiKey: loadApiKey(),
    capture: (event: string, props: Record<string, unknown>) => gl.captures.push({ event, props, at: Date.now() }),
  };
  _setUserDataOverride(mkdtempSync(path.join(tmpdir(), 'mg-eval-userdata-')));
  return gl;
}

/** A fresh character id for one game: empty transcript and memory, same persona. */
export function registerGameCharacter(gl: EvalGlobals, row: CharacterRow): string {
  const id = randomUUID();
  gl.characters.set(id, rowToCharacter(row, id));
  return id;
}

// ── small utils ─────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitUntil<T>(fn: () => T | null | undefined | false, maxMs: number, stepMs = 50): Promise<T | null> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > maxMs) return null;
    await sleep(stepMs);
  }
}

/** mulberry32: small deterministic PRNG for seeds. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
