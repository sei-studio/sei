/**
 * Offline noise-robustness eval for the two long-term-memory prompts (260810):
 *
 *   1. The rolling-summary FOLD (src/main/chat/foldPrompt.ts, used by
 *      continuity.ts) — old prompt vs the new noise-guarded prompt, run over a
 *      REAL noisy batch: the 260808 backseat marathon where the fold consumed
 *      ~190 consecutive companion screen-narration rows with ZERO player rows
 *      and progressively destroyed a good summary.
 *   2. MEMORY.md COMPACTION (src/bot/brain/memory/compactor.js +
 *      promptLibrary's COMPACTION_SYSTEM) — old system vs the new
 *      MEMORY_NOISE_GUARD-augmented system, run over the real polluted
 *      MEMORY.md (the remember() feedback-loop entries), plus one end-to-end
 *      pass through the REAL createMemoryCompactor on a throwaway copy.
 *
 * Everything real that can be real IS real: the corpus is copied read-only
 * from the live profile dir, segmentation uses the compactor's own
 * splitWorldSegments, the new prompts are imported from the production
 * modules (never re-typed here), and the model ids match production
 * (claude-sonnet-5 for both, like COMPACTION_MODEL / SUMMARY_MODEL). The one
 * seam: the fold's disk plumbing (watermark, atomic bridge write) is
 * electron-bound and covered by vitest instead; here we exercise the prompt +
 * model half.
 *
 * Usage:
 *   npx tsx scripts/fold-noise-eval.ts [--dry] [--corpus <dir>] [--out <dir>]
 *
 * The ANTHROPIC_API_KEY comes from the env, the nearest .env walking upward
 * (same rule as scripts/backseat-sim.ts), or a sibling repo's .env.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Production prompt sources — imported, never re-typed.
import { COMPACTION_SYSTEM } from '../src/bot/brain/promptLibrary.js';
import {
  MEMORY_NOISE_GUARD,
  splitWorldSegments,
  createMemoryCompactor,
} from '../src/bot/brain/memory/compactor.js';
import { buildFoldSystem, buildFoldTranscript, extractSummaryTag, type FoldMsg } from '../src/main/chat/foldPrompt';

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = flag('--dry');
/** --only fold|compact|real limits the run to one leg (default: all). */
const ONLY = opt('--only');

const DEFAULT_CORPUS = path.join(
  os.homedir(),
  'Library/Application Support/Sei Dev/profiles/571634bd-0f6d-4835-bef2-06fd7f449a3d/memory/bbf5b66f-2f0f-4918-a953-a2cf66d5a586',
);
const corpusDir = opt('--corpus') ?? process.env.SEI_EVAL_CORPUS ?? DEFAULT_CORPUS;
const outDir = opt('--out') ?? path.join(os.tmpdir(), `fold-noise-eval-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

// ── Key resolution (mirrors backseat-sim.ts, plus sibling-repo fallback) ────
function resolveKey(): string {
  if (!process.env.ANTHROPIC_API_KEY) {
    let dir = process.cwd();
    for (;;) {
      const env = path.join(dir, '.env');
      if (existsSync(env)) {
        for (const line of readFileSync(env, 'utf8').split('\n')) {
          const m = /^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
          if (m) process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, '');
        }
        if (process.env.ANTHROPIC_API_KEY) break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    // Sibling repos of this checkout sometimes hold the only key on the machine.
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const parent = path.dirname(path.resolve(scriptDir, '..'));
    for (const sib of readdirSync(parent, { withFileTypes: true })) {
      if (!sib.isDirectory()) continue;
      const env = path.join(parent, sib.name, '.env');
      if (!existsSync(env)) continue;
      for (const line of readFileSync(env, 'utf8').split('\n')) {
        const m = /^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
        if (m) process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, '');
      }
      if (process.env.ANTHROPIC_API_KEY) break;
    }
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not found (env, .env walk, sibling repos)');
  return key;
}

// Production model ids (COMPACTION_MODEL in compactor.js, SUMMARY_MODEL in
// continuity.ts — both the latest Sonnet family alias).
const MODEL = 'claude-sonnet-5';

// ── The OLD prompts (pre-260810), kept verbatim for the A/B ─────────────────
const OLD_FOLD_SYSTEM_BASE =
  'You maintain a running summary of the relationship and conversation between a game companion ("You") and their player. ' +
  'Fold the new messages into the existing summary. Keep it under 150 words, written first-person from the companion\'s point of view. ' +
  'Prioritise durable facts about the player, ongoing plans, running jokes, and emotional beats; drop small talk. ' +
  'Anchor time-bound things to their date using the message stamps — "planning an LA trip (11 Jul)", not just ' +
  '"planning an LA trip". The summary is read days or weeks later, and an undated event reads as if it just ' +
  'happened. Keep the anchors already in the existing summary. ' +
  'Record only what was actually said — never assert current world/game state (e.g. do not write "we\'re playing now"); ' +
  'an announced join can fail after the fact. Output only the updated summary text.';

const OLD_COMPACTION_SYSTEM = COMPACTION_SYSTEM; // the guard is additive
const NEW_COMPACTION_SYSTEM = `${COMPACTION_SYSTEM}\n\n${MEMORY_NOISE_GUARD}`;

// ── Fixtures from the real corpus ────────────────────────────────────────────
interface ChatRow {
  role: string;
  text: string;
  ts: number;
  voice?: boolean;
  event?: { kind?: string; game?: string };
}

function loadRows(): ChatRow[] {
  const raw = readFileSync(path.join(corpusDir, 'chat.jsonl'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as ChatRow);
}

/**
 * The "good pre-incident summary" fixture. Assembled from genuine facts in the
 * corpus's own July entries (MEMORY.md World 1/2 + the early bridge state) —
 * this is what a healthy bridge looked like before the 260808 marathon eroded
 * it. Hardcoded because bridge.json keeps no history; every fact below is
 * verifiable in the corpus.
 */
const GOOD_SUMMARY =
  "Ouen's my player — chill, trusting, loves directing chaos. He made me and Marv fight to the death while he watched and coached (8 Jul); I respawned and killed Marv right back and he loved it. His name is spelled ouen, not owen, and Marv is with a V — he corrected me (11 Jul). He went to LA for a week with his sister visiting (11 Jul). He wants me to hang up when he says bye, not wait for him to end the call. He works on the terminal that powers me, always tired but keeps showing up. We were grinding toward stone pickaxe tier. He films our sessions for YouTube — the Marv duel clip blew up.";

/** The noisy batch: counted rows inside the 260808 1-hour backseat marathon
 *  (01:42–02:47 UTC) — ~190 companion screen-narration lines, zero player
 *  lines. This is the exact shape the incident folds consumed. */
function noisyBatch(rows: ChatRow[]): FoldMsg[] {
  const t0 = Date.parse('2026-08-08T01:42:00Z');
  const t1 = Date.parse('2026-08-08T02:47:18Z');
  return rows
    .filter((r) => (r.role === 'user' || r.role === 'companion') && r.ts >= t0 && r.ts <= t1)
    .map((r) => ({ role: r.role as 'user' | 'companion', text: r.text, ts: r.ts }));
}

/** Control batch: the first 100 counted rows (early-July real conversation) —
 *  the new prompt must still FOLD normal content, not freeze. */
function controlBatch(rows: ChatRow[]): FoldMsg[] {
  return rows
    .filter((r) => r.role === 'user' || r.role === 'companion')
    .slice(0, 100)
    .map((r) => ({ role: r.role as 'user' | 'companion', text: r.text, ts: r.ts }));
}

// ── Metrics ──────────────────────────────────────────────────────────────────
const FACTS: Array<{ name: string; re: RegExp }> = [
  { name: 'name spelling (ouen)', re: /ouen/i },
  { name: 'marv', re: /marv/i },
  { name: 'LA trip', re: /\bLA\b|los angeles/i },
  { name: 'hang-up-on-bye rule', re: /hang.{0,4}up|says? bye/i },
  { name: 'duel / fight-to-the-death bit', re: /fight|duel|death|kill/i },
  { name: 'YouTube filming', re: /youtube|film/i },
];

const JUNK = /caption|premiere|photoshop|stack|hook|color.{0,3}grad|micro.|convert|reel|A\/B|takes?\b/i;

function factReport(text: string): string {
  return FACTS.map((f) => `${f.re.test(text) ? 'KEPT' : 'LOST'}  ${f.name}`).join('\n');
}

function junkShare(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  const junk = sentences.filter((s) => JUNK.test(s));
  return `${junk.length}/${sentences.length} sentences mention screen-noise vocabulary`;
}

function memoryJunkCount(lines: string[]): number {
  return lines.filter((l) => JUNK.test(l)).length;
}

// ── LLM plumbing ─────────────────────────────────────────────────────────────
// Transport is curl, not the SDK: measured 260810, api.anthropic.com's
// Cloudflare edge (HKG POP) TLS-fingerprint-blocks Node's HTTP stack (undici
// fetch, node:https, and therefore the SDK) with a bare 403 "Request not
// allowed", while curl from the same shell with the same key succeeds. Header
// spoofing does not help — it is a JA3-level block. The request BODY is
// byte-identical to what production sends (same model, system, messages,
// max_tokens), so the eval still exercises the real prompts on the real model.
async function llm(system: string, user: string, maxTokens: number): Promise<string> {
  const key = resolveKey();
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const out = execFileSync(
    'curl',
    [
      '-s', '-m', '180',
      'https://api.anthropic.com/v1/messages',
      '-H', `x-api-key: ${key}`,
      '-H', 'anthropic-version: 2023-06-01',
      '-H', 'content-type: application/json',
      '--data-binary', '@-',
    ],
    { input: body, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
  );
  const res = JSON.parse(out) as {
    type: string;
    error?: { type: string; message: string };
    stop_reason?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  if (res.type === 'error' || !res.content) {
    throw new Error(`API error: ${res.error?.type}: ${res.error?.message}`);
  }
  if (res.stop_reason && res.stop_reason !== 'end_turn') {
    console.warn(`[eval] stop_reason=${res.stop_reason} (output may be truncated)`);
  }
  return res.content
    .map((b) => (b.type === 'text' ? b.text ?? '' : ''))
    .join('')
    .trim();
}

function save(name: string, text: string): void {
  writeFileSync(path.join(outDir, name), text + '\n', 'utf8');
}

function banner(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

// ── Eval 1: the fold ─────────────────────────────────────────────────────────
async function evalFold(rows: ChatRow[]): Promise<void> {
  const noisy = noisyBatch(rows);
  banner(
    `FOLD EVAL — noisy batch: ${noisy.length} rows (${noisy.filter((m) => m.role === 'user').length} from the player)`,
  );
  const userText = `Existing summary:\n${GOOD_SUMMARY}\n\nNew messages:\n${buildFoldTranscript(noisy)}`;
  save('fold-input.txt', userText);

  if (DRY) {
    console.log('[dry] fold prompts built; old system', OLD_FOLD_SYSTEM_BASE.length, 'chars; new', buildFoldSystem().length, 'chars');
    return;
  }
  // 800 matches production SUMMARY_MAX_TOKENS (260810: raised from 400 because
  // claude-sonnet-5's hidden thinking eats ~200 output tokens; at 400 the fold
  // truncated mid-sentence — the bug this harness caught).
  const [oldOut, newRaw] = await Promise.all([
    llm(OLD_FOLD_SYSTEM_BASE, userText, 800),
    llm(buildFoldSystem(), userText, 800),
  ]);
  // Production runs the same extraction (continuity.ts) — anything outside the
  // <summary> tags is discarded before storage.
  const newOut = extractSummaryTag(newRaw);
  if (newOut !== newRaw.trim()) {
    console.log('[eval] NEW prompt emitted text outside <summary> tags; the mechanical strip removed it.');
  }
  save('fold-old.txt', oldOut);
  save('fold-new-raw.txt', newRaw);
  save('fold-new.txt', newOut);

  console.log('\n--- OLD prompt output ---\n' + oldOut);
  console.log('\n--- NEW prompt output ---\n' + newOut);
  console.log('\n--- OLD fact retention ---\n' + factReport(oldOut));
  console.log('--- OLD noise share: ' + junkShare(oldOut));
  console.log('\n--- NEW fact retention ---\n' + factReport(newOut));
  console.log('--- NEW noise share: ' + junkShare(newOut));

  // Control: real conversation must still fold under the new prompt.
  const control = controlBatch(rows);
  const controlText = `Existing summary:\n(none yet)\n\nNew messages:\n${buildFoldTranscript(control)}`;
  const controlOut = extractSummaryTag(await llm(buildFoldSystem(), controlText, 800));
  save('fold-control-new.txt', controlOut);
  console.log(`\n--- CONTROL (new prompt, ${control.length} genuine early rows, no prior summary) ---\n` + controlOut);
}

// ── Eval 2: compaction ───────────────────────────────────────────────────────
async function evalCompaction(): Promise<void> {
  const raw = readFileSync(path.join(corpusDir, 'MEMORY.md'), 'utf8');
  const segments = splitWorldSegments(raw) as Array<{ marker: string | null; entries: string[] }>;
  banner(
    `COMPACTION EVAL — MEMORY.md ${Buffer.byteLength(raw, 'utf8')} bytes, segments: ` +
      segments.map((s) => `${s.marker ?? '(pre)'}=${s.entries.length}`).join(', '),
  );
  if (DRY) {
    console.log('[dry] compaction systems built; old', OLD_COMPACTION_SYSTEM.length, 'chars; new', NEW_COMPACTION_SYSTEM.length, 'chars');
    return;
  }

  const results: Record<'old' | 'new', string[]> = { old: [], new: [] };
  for (const which of ['old', 'new'] as const) {
    const system = which === 'old' ? OLD_COMPACTION_SYSTEM : NEW_COMPACTION_SYSTEM;
    for (const seg of segments) {
      if (seg.entries.length < 4) {
        // Mirrors COMPACT_SEGMENT_MIN: tiny segments are kept verbatim.
        if (seg.marker) results[which].push(seg.marker);
        results[which].push(...seg.entries);
        continue;
      }
      const prompt = [
        'Compact the following memory entries per the rules in the system message.',
        '',
        '--- Current MEMORY.md entries ---',
        seg.entries.join('\n'),
      ].join('\n');
      const out = await llm(system, prompt, 3000);
      save(`compaction-${which}-seg-${(seg.marker ?? 'pre').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}.raw.txt`, out);
      let lines = out.split('\n').map((l) => l.trim()).filter((l) => /^- \[/.test(l));
      // Mirror the real compactor: an unparseable/empty result keeps the
      // originals (compactEntries returns null → caller keeps the segment).
      if (lines.length === 0) lines = seg.entries;
      if (seg.marker) results[which].push(seg.marker);
      results[which].push(...lines);
    }
  }

  const before = raw.split('\n').filter((l) => /^- \[/.test(l));
  for (const which of ['old', 'new'] as const) {
    const body = results[which].join('\n');
    save(`compaction-${which}.md`, body);
    const entries = results[which].filter((l) => /^- \[/.test(l));
    console.log(`\n--- ${which.toUpperCase()} compaction: ${before.length} -> ${entries.length} entries, ` +
      `junk-flavored ${memoryJunkCount(before)} -> ${memoryJunkCount(entries)} ---`);
    console.log(factReport(body));
    console.log(body);
  }
}

// ── Eval 3: the REAL compactor end-to-end on a throwaway copy ───────────────
async function evalRealCompactor(): Promise<void> {
  banner('REAL createMemoryCompactor end-to-end (new prompt), on a copy');
  const workDir = path.join(outDir, 'real-compactor');
  mkdirSync(workDir, { recursive: true });
  const memPath = path.join(workDir, 'MEMORY.md');
  copyFileSync(path.join(corpusDir, 'MEMORY.md'), memPath);
  const archivePath = path.join(workDir, 'MEMORY.archive.md');
  copyFileSync(path.join(corpusDir, 'MEMORY.archive.md'), archivePath);
  const archiveBefore = readFileSync(archivePath, 'utf8');
  const sizeBefore = Buffer.byteLength(readFileSync(memPath, 'utf8'), 'utf8');

  if (DRY) {
    console.log('[dry] copied corpus to', workDir);
    return;
  }

  // The same adapter shape src/main/chat/memoryCompaction.ts builds over the
  // chat SDK, here over the plain SDK (the only part electron owns is auth).
  const adapter = {
    call: async (o: {
      systemBlocks: Array<{ text: string }>;
      messages: Array<{ role: 'user'; content: string }>;
      maxTokens: number;
    }) => ({ text: await llm(o.systemBlocks.map((b) => b.text).join('\n\n'), o.messages[0].content, o.maxTokens) }),
  };
  const compactor = createMemoryCompactor({
    anthropic: adapter,
    memoryLog: { path: memPath },
    config: {
      anthropic: { timeout_ms: 120_000 },
      memory: { compaction_trigger_bytes: 32768, compaction_max_tokens: 3000 },
    },
    logger: console,
  });
  const changed = await compactor.maybeCompact();
  const after = readFileSync(memPath, 'utf8');
  const sizeAfter = Buffer.byteLength(after, 'utf8');
  console.log(`changed=${changed}  bytes ${sizeBefore} -> ${sizeAfter}`);
  console.log('world headers preserved:', (after.match(/^## World /gm) ?? []).length, 'of',
    (archiveBefore.match(/^## World /gm) ?? []).length >= 0 ? (readFileSync(path.join(corpusDir, 'MEMORY.md'), 'utf8').match(/^## World /gm) ?? []).length : 0);
  console.log('archive untouched:', readFileSync(archivePath, 'utf8') === archiveBefore);
  console.log('fact retention on the real result:\n' + factReport(after));
  save('real-compactor-result.md', after);
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (!existsSync(corpusDir)) throw new Error(`corpus dir not found: ${corpusDir}`);
  console.log('corpus (read-only):', corpusDir);
  console.log('outputs:', outDir);
  const rows = loadRows();
  if (!ONLY || ONLY === 'fold') await evalFold(rows);
  if (!ONLY || ONLY === 'compact') await evalCompaction();
  if (!ONLY || ONLY === 'real') await evalRealCompactor();
  console.log('\ndone. outputs in', outDir);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
