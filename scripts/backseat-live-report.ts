/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * scripts/backseat-live-report.ts — metrics, transcripts and captioned review
 * clips for runs produced by scripts/backseat-live-replay.ts (261009).
 *
 *   npx tsx scripts/backseat-live-report.ts <runsDir> <vidsDir> <outDir> [--clips] [--crf 25] [--videos minecraft,roblox] [--badge "(tuned)"]
 *
 * <runsDir> holds one directory per run named <video>-<arm>[-rN] (e.g.
 * minecraft-55, minecraft-45-r2), each with events.jsonl + lines.json from the
 * replay harness. <vidsDir>/<video>.mp4 is the footage that was replayed.
 *
 * --videos a,b limits clip rendering to those videos.
 *
 * Writes:
 *   <outDir>/transcripts/<run>.md   per-run transcript (vt, tick, words, latency)
 *   <outDir>/metrics.json           per-run + per (video, arm) aggregates
 *   <outDir>/metrics-table.md       the aggregate table, ready to paste
 *   <outDir>/clips/<video>-<arm>.mp4  (with --clips) rep-1 footage with every
 *       companion line burned in at the moment it was produced (white text in
 *       a dark box, bottom, [5.5]/[4.5] tag) and the scripted player questions
 *       at the top. H.264 720p, capped bitrate so 170 s stays under 45 MB.
 *
 * Lines/min, word counts, openers, question endings, "(silence)" anomalies and
 * latencies are computed here. Grounding errors and answer quality need a human
 * (or a frame check) and are scored in summary.md, not here.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

type Ev = Record<string, any> & { vt: number; type: string }
type Line = { vt: number; text: string; kind: string; tickVt: number; latencyMs: number | null }

const ARM_TAG: Record<string, string> = { '55': '5.5', '45': '4.5' }
const USER_TICK_DELAY_S = 2.5 // captureController latches the grid at question time, sends 2.5 s later

function parseArgs(argv: string[]) {
  const pos: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++ }
      else flags[a.slice(2)] = true
    } else pos.push(a)
  }
  return { pos, flags }
}

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length
function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))
  return s[idx]
}
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const opener = (s: string) => (s.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z']/g, '')
// 261010: the player's real-life pet from memory.txt. Any line naming it is a
// candidate memory bleed; summary.md classifies each by hand (a dog on screen
// called by that name is bleed, a remark about the real dog is not).
const BLEED_RE = /\bmochi\b/i
// 261010 (Shawn: do not narrate). A rough flag for a line that reads the
// screen back: "you're on/in/at...", "that's a...", "stage 12 now", "just got
// hit". It over- and under-counts; summary.md hand-checks a sample.
const NARR_RE = /\b(you'?re|you are|they'?re|he'?s|she'?s)\s+(now\s+|already\s+|just\s+|still\s+)?(in|on|at|inside|running|walking|climbing|standing|heading|going|getting|back|fighting|chopping|building|walking)\b|\b(that'?s|there'?s|this is)\s+(a|an|the)\b|\bstage \d+\b|\b(just|now)\s+(got|hit|used|died|took|landed)\b/i
const narrates = (s: string) => NARR_RE.test(s)
// The start tick spoke = some line came from the 'start' turn.
const startSpoke = (lines: Line[]) => lines.some((l) => l.kind === 'start')

function loadRun(dir: string) {
  const events: Ev[] = readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const lines: Line[] = JSON.parse(readFileSync(join(dir, 'lines.json'), 'utf8'))
  // Runs recorded before the harness fixed attribution credited a line to the
  // most recently STARTED turn. When a screen tick slipped in while a user turn
  // was still awaiting its chat-row write, the user reply was labelled "jolt".
  // Re-derive the speaker from the "turn <kind>: ..." log just before the line.
  const logs = events.filter((e) => e.type === 'log')
  for (const l of lines) {
    const done = [...logs].reverse().find((e) => e.vt <= l.vt + 0.005 && l.vt - e.vt < 0.5 && /^turn \w+: /.test(e.msg))
    const kind = done?.msg.match(/^turn (\w+): /)?.[1]
    if (!kind || kind === l.kind) continue
    const started = [...logs].reverse().find((e) => e.vt <= l.vt && new RegExp(`^tick ${kind}(?::\\w+)? (?:-> turn|preempts)`).test(e.msg))
    l.kind = kind
    if (started) { l.tickVt = started.vt; l.latencyMs = Math.round((l.vt - started.vt) * 1000) }
  }
  const meta: Record<string, any> = events.find((e) => e.type === 'meta') ?? {}
  const end = events.find((e) => e.type === 'end')
  return { events, lines, meta, durationS: end?.vt ?? 170 }
}

function runMetrics(name: string, run: ReturnType<typeof loadRun>) {
  const { events, lines, meta } = run
  const durS = Math.min(run.durationS, 170)
  const said = lines.filter((l) => l.vt <= durS + 8)
  const nonUser = said.filter((l) => l.kind !== 'user')
  const ticks = events.filter((e) => e.type === 'tick')
  const logs = events.filter((e) => e.type === 'log').map((e) => String(e.msg))
  const api = events.filter((e) => e.type === 'api')
  const noLine = logs.filter((m) => /NO LINE/.test(m))
  const dropped = logs.filter((m) => /^tick \S+ dropped/.test(m))
  const preempt = logs.filter((m) => /preempts/.test(m))
  const ops = said.map((l) => opener(l.text))
  const opCounts = new Map<string, number>()
  for (const o of ops) opCounts.set(o, (opCounts.get(o) ?? 0) + 1)
  const topOp = [...opCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  const questions: { at: number; text: string }[] = meta.questions ?? []
  // Reply to a scripted question = first user-kind line after it was asked.
  const answers = questions.map((q) => {
    const l = said.find((x) => x.kind === 'user' && x.vt >= q.at)
    return { q: q.text, at: q.at, line: l?.text ?? null, vt: l?.vt ?? null,
      // Time the player waits after finishing the question (includes the 2.5 s latch).
      waitS: l ? +(l.vt - q.at).toFixed(2) : null,
      apiMs: l?.latencyMs ?? null }
  })
  const idleTicks = ticks.filter((t) => t.kind === 'idle').length
  const joltTicks = ticks.filter((t) => t.kind === 'jolt').length
  return {
    name, model: meta.model, label: meta.label, seed: meta.seed,
    lines: said.length,
    linesPerMin: +(said.length / (durS / 60)).toFixed(2),
    byKind: Object.fromEntries(['start', 'jolt', 'idle', 'user'].map((k) => [k, said.filter((l) => l.kind === k).length])),
    ticks: { total: ticks.length, jolt: joltTicks, idle: idleTicks, start: ticks.filter((t) => t.kind === 'start').length,
      user: ticks.filter((t) => t.kind === 'user').length, dropped: dropped.length, preempted: preempt.length },
    silenceReplies: noLine.length,
    wordsMedian: median(said.map((l) => words(l.text))),
    wordsP90: quantile(said.map((l) => words(l.text)), 0.9),
    wordsMedianNonUser: median(nonUser.map((l) => words(l.text))),
    wordsP90NonUser: quantile(nonUser.map((l) => words(l.text)), 0.9),
    waitOpeners: ops.filter((o) => o === 'wait').length,
    topOpener: topOp[0], topOpenerShare: said.length ? +(topOp[1] / said.length).toFixed(2) : 0,
    endsWithQuestion: said.filter((l) => /\?\s*["')]*\s*$/.test(l.text)).length,
    containsQuestion: said.filter((l) => l.text.includes('?')).length,
    containsQuestionNonUser: nonUser.filter((l) => l.text.includes('?')).length,
    distinctOpeners: opCounts.size,
    narrationNonUser: nonUser.filter((l) => narrates(l.text)).length,
    greetedAtStart: startSpoke(said),
    bleedLines: said.filter((l) => BLEED_RE.test(l.text)).map((l) => ({ vt: l.vt, kind: l.kind, text: l.text })),
    maxTokensStops: api.filter((a) => a.stopReason === 'max_tokens').length,
    maxTokensStopsLook: api.filter((a) => a.stopReason === 'max_tokens' && a.maxTokens != null && a.maxTokens < 100).length,
    outTokensMedian: median(api.map((a) => a.usage?.output_tokens ?? NaN).filter(Number.isFinite)),
    apiCalls: api.length,
    apiMsMedian: median(api.map((a) => a.ms)), apiMsP90: quantile(api.map((a) => a.ms), 0.9),
    lineLatencyMedianMs: median(said.map((l) => l.latencyMs ?? NaN).filter(Number.isFinite)),
    lineLatencyP90Ms: quantile(said.map((l) => l.latencyMs ?? NaN).filter(Number.isFinite), 0.9),
    answers,
    cost: +api.reduce((s, a) => s + (a.cost ?? 0), 0).toFixed(5),
    maxLagMs: events.find((e) => e.type === 'end')?.maxLagMs ?? null,
  }
}
type RunM = ReturnType<typeof runMetrics>

function transcriptMd(m: RunM, run: ReturnType<typeof loadRun>): string {
  const rows: string[] = []
  const items: { vt: number; row: string }[] = []
  for (const l of run.lines) {
    items.push({ vt: l.vt, row: `| ${l.vt.toFixed(1)} | ${l.kind} | ${words(l.text)} | ${l.latencyMs ?? ''} | ${l.text.replace(/\|/g, '\\|')} |` })
  }
  for (const e of run.events) {
    if (e.type === 'playerLine') items.push({ vt: e.vt, row: `| ${e.vt.toFixed(1)} | PLAYER | ${words(e.text)} | | **Ouen:** ${String(e.text).replace(/\|/g, '\\|')} |` })
    if (e.type === 'log' && /stopped at max_tokens/.test(e.msg)) items.push({ vt: e.vt, row: `| ${e.vt.toFixed(1)} | ${String(e.msg).match(/turn (\w+)/)?.[1] ?? '?'} | | | _cut off at max_tokens_ |` })
    if (e.type === 'log' && /NO LINE/.test(e.msg)) items.push({ vt: e.vt, row: `| ${e.vt.toFixed(1)} | ${String(e.msg).match(/turn (\w+)/)?.[1] ?? '?'} | 0 | | _(silence) reply on an always-speak tick_ |` })
  }
  items.sort((a, b) => a.vt - b.vt)
  rows.push(`# ${m.name} (${m.model})`, '', `Source label: ${m.label} · seed ${m.seed} · ${m.lines} lines · ${m.linesPerMin}/min · cost $${m.cost}`, '',
    'vt = seconds into the 170 s clip; latency = API time for the turn that produced the line (ms).', '',
    '| vt (s) | tick | words | latency ms | text |', '|---|---|---|---|---|', ...items.map((i) => i.row), '')
  return rows.join('\n')
}

// ---------- captions ----------
function assTime(s: number): string {
  const cs = Math.max(0, Math.round(s * 100))
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100), c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}
const assEsc = (s: string) => s.replace(/[{}]/g, '').replace(/\\/g, '/').replace(/\r?\n/g, ' ')

let badgeSuffix = ''
function buildAss(run: ReturnType<typeof loadRun>, arm: string, title: string): string {
  const tag = ARM_TAG[arm] ?? arm
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Line,Noto Sans,34,&H00FFFFFF,&H00FFFFFF,&H30000000,&H30000000,0,0,0,0,100,100,0,0,3,10,0,2,90,90,36,1
Style: Player,Noto Sans,30,&H0080F0FF,&H0080F0FF,&H30000000,&H30000000,0,0,0,0,100,100,0,0,3,8,0,8,90,90,30,1
Style: Badge,Noto Sans,24,&H00FFFFFF,&H00FFFFFF,&H50000000,&H50000000,1,0,0,0,100,100,0,0,3,6,0,9,20,20,16,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const ev: string[] = []
  ev.push(`Dialogue: 0,${assTime(0)},${assTime(run.durationS + 1)},Badge,,0,0,0,,${assEsc(`Sui on Haiku ${tag}${badgeSuffix} · ${title}`)}`)
  const lines = [...run.lines].sort((a, b) => a.vt - b.vt)
  lines.forEach((l, i) => {
    let end = l.vt + 5
    const next = lines[i + 1]
    // Hand over to the next line unless it came from the same turn (then stack).
    if (next && next.vt - l.vt > 1 && next.vt < end) end = next.vt - 0.05
    end = Math.max(end, l.vt + 2.5)
    ev.push(`Dialogue: 0,${assTime(l.vt)},${assTime(end)},Line,,0,0,0,,${assEsc(`[${tag}] (${l.kind}) Sui: ${l.text}`)}`)
  })
  for (const q of (run.meta.questions ?? []) as { at: number; text: string }[]) {
    ev.push(`Dialogue: 0,${assTime(q.at - 1.5)},${assTime(q.at + USER_TICK_DELAY_S + 1.5)},Player,,0,0,0,,${assEsc(`Ouen (player, typed/said): ${q.text}`)}`)
  }
  return head + ev.join('\n') + '\n'
}

function renderClip(video: string, ass: string, out: string, crf: number) {
  // Cap the bitrate so a 170 s clip stays under ~40 MB even on busy footage.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video,
    '-vf', `scale=-2:720,ass=${ass}`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-maxrate', '1700k', '-bufsize', '3400k',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out], { stdio: 'inherit' })
}

function fmt(x: number | null | undefined, d = 0) { return x == null || Number.isNaN(x) ? '-' : x.toFixed(d) }

function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2))
  const [runsDir, vidsDir, outDir] = pos
  if (!runsDir || !vidsDir || !outDir) {
    console.error('usage: backseat-live-report.ts <runsDir> <vidsDir> <outDir> [--clips] [--crf 25]')
    process.exit(2)
  }
  mkdirSync(join(outDir, 'transcripts'), { recursive: true })
  const runNames = readdirSync(runsDir).filter((n) => existsSync(join(runsDir, n, 'events.jsonl'))).sort()
  const all: RunM[] = []
  const runs = new Map<string, ReturnType<typeof loadRun>>()
  for (const n of runNames) {
    const r = loadRun(join(runsDir, n))
    runs.set(n, r)
    const m = runMetrics(n, r)
    all.push(m)
    writeFileSync(join(outDir, 'transcripts', `${n}.md`), transcriptMd(m, r))
  }

  // Aggregate per (video, arm) over reps: pooled lines for word stats, mean of per-run rates.
  const groups = new Map<string, { video: string; arm: string; runs: string[] }>()
  for (const n of runNames) {
    const m = n.match(/^(.+)-(\d\d)(?:-r\d+)?$/)
    if (!m) continue
    const key = `${m[1]}-${m[2]}`
    if (!groups.has(key)) groups.set(key, { video: m[1], arm: m[2], runs: [] })
    groups.get(key)!.runs.push(n)
  }
  const agg = [...groups.values()].map((g) => {
    const ms = all.filter((m) => g.runs.includes(m.name))
    const pooled = g.runs.flatMap((n) => runs.get(n)!.lines)
    const pooledNU = pooled.filter((l) => l.kind !== 'user')
    const api = g.runs.flatMap((n) => runs.get(n)!.events.filter((e) => e.type === 'api').map((e) => e.ms as number))
    const ans = ms.flatMap((m) => m.answers)
    const nLines = pooled.length
    return {
      video: g.video, arm: g.arm, model: ms[0]?.model, reps: ms.length,
      linesPerMin: mean(ms.map((m) => m.linesPerMin)),
      linesPerMinRange: [Math.min(...ms.map((m) => m.linesPerMin)), Math.max(...ms.map((m) => m.linesPerMin))],
      wordsMedian: median(pooled.map((l) => words(l.text))), wordsP90: quantile(pooled.map((l) => words(l.text)), 0.9),
      wordsMedianNonUser: median(pooledNU.map((l) => words(l.text))), wordsP90NonUser: quantile(pooledNU.map((l) => words(l.text)), 0.9),
      waitOpenerShare: nLines ? pooled.filter((l) => opener(l.text) === 'wait').length / nLines : 0,
      ...(() => {
        const c = new Map<string, number>()
        for (const l of pooled) c.set(opener(l.text), (c.get(opener(l.text)) ?? 0) + 1)
        const top = [...c.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
        return { topOpener: top[0], topOpenerShare: nLines ? top[1] / nLines : 0, distinctOpenerShare: nLines ? c.size / nLines : 0 }
      })(),
      containsQuestionShare: nLines ? pooled.filter((l) => l.text.includes('?')).length / nLines : 0,
      containsQuestionShareNonUser: pooledNU.length ? pooledNU.filter((l) => l.text.includes('?')).length / pooledNU.length : 0,
      greetedAtStart: ms.filter((m) => m.greetedAtStart).length,
      narrationShareNonUser: pooledNU.length ? pooledNU.filter((l) => narrates(l.text)).length / pooledNU.length : 0,
      bleedLines: ms.reduce((s, m) => s + m.bleedLines.length, 0),
      maxTokensStopsLook: ms.reduce((s, m) => s + m.maxTokensStopsLook, 0),
      outTokensMedian: median(g.runs.flatMap((n) => runs.get(n)!.events.filter((e) => e.type === 'api').map((e) => e.usage?.output_tokens ?? NaN)).filter(Number.isFinite)),
      endsWithQuestionShare: nLines ? pooled.filter((l) => /\?\s*["')]*\s*$/.test(l.text)).length / nLines : 0,
      silenceReplies: ms.reduce((s, m) => s + m.silenceReplies, 0),
      idleTicks: ms.reduce((s, m) => s + m.ticks.idle, 0),
      idleLines: ms.reduce((s, m) => s + m.byKind.idle, 0),
      apiMsMedian: median(api), apiMsP90: quantile(api, 0.9),
      answerWaitMedianS: median(ans.map((a) => a.waitS ?? NaN).filter(Number.isFinite)),
      unanswered: ans.filter((a) => a.line == null).length,
      cost: ms.reduce((s, m) => s + m.cost, 0),
    }
  }).sort((a, b) => a.video.localeCompare(b.video) || b.arm.localeCompare(a.arm))

  const totalCost = all.reduce((s, m) => s + m.cost, 0)
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify({ runs: all, aggregate: agg, totalCost }, null, 1))
  const table = [
    '| video | model | runs | greeted at start | words med / p90 | non-user words med | contains "?" (all / non-user) | top opener | distinct openers / lines | Mochi lines | narration (non-user, heuristic) | looks cut at max_tokens | out tokens med | (silence) on always-speak | lines/min | cost |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...agg.map((a) => `| ${a.video} | ${ARM_TAG[a.arm] ?? a.arm} | ${a.reps} | ${a.greetedAtStart}/${a.reps} | ${fmt(a.wordsMedian)} / ${fmt(a.wordsP90)} | ${fmt(a.wordsMedianNonUser)} | ${(a.containsQuestionShare * 100).toFixed(0)}% / ${(a.containsQuestionShareNonUser * 100).toFixed(0)}% | ${a.topOpener} ${(a.topOpenerShare * 100).toFixed(0)}% | ${(a.distinctOpenerShare * 100).toFixed(0)}% | ${a.bleedLines} | ${(a.narrationShareNonUser * 100).toFixed(0)}% | ${a.maxTokensStopsLook} | ${fmt(a.outTokensMedian)} | ${a.silenceReplies} | ${fmt(a.linesPerMin, 2)} | $${a.cost.toFixed(3)} |`),
    '',
    '| video | model | lines/min (3 reps) | words med / p90 | non-user words med / p90 | "Wait" opener | ends with "?" | (silence) on always-speak | API ms med / p90 | Q reply wait med (s) | cost |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...agg.map((a) => `| ${a.video} | ${ARM_TAG[a.arm] ?? a.arm} | ${fmt(a.linesPerMin, 2)} (${a.linesPerMinRange.map((x) => x.toFixed(1)).join('-')}) | ${fmt(a.wordsMedian)} / ${fmt(a.wordsP90)} | ${fmt(a.wordsMedianNonUser)} / ${fmt(a.wordsP90NonUser)} | ${(a.waitOpenerShare * 100).toFixed(0)}% | ${(a.endsWithQuestionShare * 100).toFixed(0)}% | ${a.silenceReplies} | ${fmt(a.apiMsMedian)} / ${fmt(a.apiMsP90)} | ${fmt(a.answerWaitMedianS, 1)} | $${a.cost.toFixed(3)} |`),
    '', `Total API spend across ${all.length} runs: $${totalCost.toFixed(3)}`, '',
  ].join('\n')
  writeFileSync(join(outDir, 'metrics-table.md'), table)
  console.log(table)

  if (typeof flags.badge === 'string') badgeSuffix = ` ${flags.badge}`
  if (flags.clips) {
    const crf = Number(flags.crf ?? 25)
    mkdirSync(join(outDir, 'clips'), { recursive: true })
    const titles: Record<string, string> = {}
    for (const g of groups.values()) {
      const rep1 = g.runs.find((n) => !/-r\d+$/.test(n))
      if (!rep1) continue
      if (typeof flags.videos === 'string' && !flags.videos.split(',').includes(g.video)) continue
      const run = runs.get(rep1)!
      const video = join(vidsDir, `${g.video}.mp4`)
      if (!existsSync(video)) { console.error(`missing ${video}`); continue }
      titles[g.video] ??= String(run.meta.label ?? g.video)
      const assPath = join(outDir, 'clips', `${g.video}-${g.arm}.ass`)
      writeFileSync(assPath, buildAss(run, g.arm, `${g.video} (rep 1)`))
      const out = join(outDir, 'clips', `${g.video}-haiku${g.arm}.mp4`)
      renderClip(video, assPath, out, crf)
      console.log(`${out} ${(statSync(out).size / 1e6).toFixed(1)} MB`)
    }
  }
}

main()
