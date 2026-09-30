/**
 * 260925 backseat act: accuracy + latency eval for the TEXT chooser over the
 * seed set in src/main/computerUse/__fixtures__/chooser-eval.json.
 *
 *   npx tsx scripts/act-chooser-eval.ts [--n 3] [--chooser haiku|jev] [--model claude-haiku-4-5] [--only id,id]
 *
 * Runs the real TextChooser (same prompt, forced tool, one-hot confidence) or
 * the Jev ProbabilityChooser against each case and reports per-case hits,
 * accuracy per tag, how often the answer would fall back to vision
 * (textChoiceNeedsVision), and latency percentiles.
 *
 * Keys, dev only, never in the repo: SEI_ACT_ANTHROPIC_KEY, else
 * ~/.sei-dev/anthropic-test-key (Haiku); SEI_JEV_API_KEY (Jev). A full Haiku
 * run over 13 cases x 3 is about 40 calls, a few cents.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import evalSet from '../src/main/computerUse/__fixtures__/chooser-eval.json';
import { textChoiceNeedsVision, type ChooseState, type Chooser, type HistoryEntry } from '../src/main/computerUse/chooser';
import { createDirectAnthropicCall } from '../src/main/computerUse/directAnthropic';
import { buildJevChooser } from '../src/main/computerUse/jevChooser';
import type { ActOption, OptionKind } from '../src/main/computerUse/perception';
import { TEXT_CHOOSER_MODEL, TextChooser } from '../src/main/computerUse/textChooser';

interface EvalCase {
  id: string;
  tags: string[];
  goal: string;
  state: string;
  options: string[];
  correct: number[];
  history?: HistoryEntry[];
}

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const N = Number(arg('n', '3'));
const KIND = arg('chooser', 'haiku');
const ONLY = arg('only', '').split(',').filter(Boolean);

function makeChooser(): Chooser {
  if (KIND === 'jev') {
    const c = buildJevChooser(process.env);
    if (!c) throw new Error('SEI_JEV_API_KEY is not set');
    return c;
  }
  const key =
    process.env.SEI_ACT_ANTHROPIC_KEY?.trim() ||
    readFileSync(path.join(os.homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
  return new TextChooser({ call: createDirectAnthropicCall(key), model: arg('model', TEXT_CHOOSER_MODEL), anthropic: true });
}

function kindOf(label: string): OptionKind {
  if (label.startsWith('DONE:')) return 'done';
  if (label.startsWith('GIVE_UP:')) return 'give_up';
  if (/^type text/.test(label)) return 'type';
  return 'ax';
}

/** Eval options carry a placeholder action (the text chooser never reads it) except the "type" hand-off, as in the loop. */
function toOptions(labels: string[]): ActOption[] {
  return labels.map((label, index) => {
    const kind = kindOf(label);
    return kind === 'type'
      ? { index, kind, label }
      : { index, kind, label, action: { name: 'wait', input: { ms: 50 } } };
  });
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

async function main() {
  const chooser = makeChooser();
  const cases = (evalSet.cases as EvalCase[]).filter((c) => !ONLY.length || ONLY.includes(c.id));
  const frame = { data: '', mime: 'image/jpeg' as const, width: 1, height: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, capturedAt: 0 };
  const lat: number[] = [];
  const byTag = new Map<string, { hit: number; n: number }>();
  let hits = 0;
  let total = 0;
  let fallbacks = 0;
  let inTok = 0;
  let outTok = 0;
  console.log(`chooser=${chooser.name} model=${chooser.model} cases=${cases.length} n=${N}`);
  for (const c of cases) {
    const options = toOptions(c.options);
    const state: ChooseState = {
      goal: c.goal,
      frame,
      perception: { state: c.state, options, richness: options.length, focusedEditable: false, focusedEmpty: false, focusedSecure: false },
      step: (c.history?.length ?? 0) + 1,
      maxSteps: 40,
      timeLeftS: 120,
      notes: [],
      playerLines: [],
    };
    const picks: string[] = [];
    let caseHits = 0;
    for (let i = 0; i < N; i++) {
      const ch = await chooser.choose(state, options, c.history ?? [], new AbortController().signal);
      lat.push(ch.latencyMs);
      inTok += ch.usage?.input_tokens ?? 0;
      outTok += ch.usage?.output_tokens ?? 0;
      const ok = ch.index !== undefined && c.correct.includes(ch.index);
      if (ok) caseHits += 1;
      if (textChoiceNeedsVision(ch, options)) fallbacks += 1;
      const conf = ch.probs && ch.index !== undefined ? ch.probs[ch.index]!.toFixed(2) : '-';
      picks.push(ch.error ? `err(${ch.error.slice(0, 40)})` : `${ch.index}@${conf}`);
    }
    hits += caseHits;
    total += N;
    for (const t of c.tags.length ? c.tags : ['untagged']) {
      const b = byTag.get(t) ?? { hit: 0, n: 0 };
      b.hit += caseHits;
      b.n += N;
      byTag.set(t, b);
    }
    const want = c.correct.map((i) => `${i} (${c.options[i]})`).join(' | ');
    console.log(`${caseHits === N ? 'ok  ' : 'MISS'} ${c.id.padEnd(26)} ${caseHits}/${N} picks=[${picks.join(', ')}] want=${want}`);
  }
  console.log(`\naccuracy ${hits}/${total} (${((100 * hits) / total).toFixed(0)}%), vision fallbacks ${fallbacks}/${total}`);
  for (const [t, b] of [...byTag].sort()) console.log(`  ${t.padEnd(22)} ${b.hit}/${b.n}`);
  console.log(`latency p50=${pct(lat, 0.5)}ms p90=${pct(lat, 0.9)}ms max=${Math.max(...lat)}ms; avg tokens in=${Math.round(inTok / total)} out=${Math.round(outTok / total)}`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
