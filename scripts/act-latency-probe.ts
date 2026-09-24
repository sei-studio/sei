/**
 * 260925 backseat act: per-step latency probe for the vision chooser and the
 * completion check, on Linux, with no Mac and no helper.
 *
 *   npx tsx scripts/act-latency-probe.ts [--n 3] [--models claude-haiku-4-5,claude-sonnet-5]
 *
 * Renders a synthetic sign-in page (the perception fixture's layout) to a
 * 1280 px JPEG, builds the real options list from the fixture, and runs the
 * real VisionChooser and verifier against Anthropic directly. Reports model
 * latency, tokens, and whether the step picked the "Sign in" button (by
 * option or by a click inside it).
 *
 * Key: SEI_ACT_ANTHROPIC_KEY, else ~/.sei-dev/anthropic-test-key (dev only,
 * never in the repo). Costs a few cents per run.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import fixture from '../src/main/computerUse/__fixtures__/login-page.json';
import { buildActSystem } from '../src/main/computerUse/actPrompt';
import { createDirectAnthropicCall } from '../src/main/computerUse/directAnthropic';
import { globalToImage } from '../src/main/computerUse/geometry';
import { perceive } from '../src/main/computerUse/perception';
import type { AxNode, Frame, OcrBox, Rect } from '../src/main/computerUse/types';
import { makeVerifier, VisionChooser } from '../src/main/computerUse/visionChooser';

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const N = Number(arg('n', '3'));
const MODELS = arg('models', 'claude-haiku-4-5,claude-sonnet-5').split(',');

const key =
  process.env.SEI_ACT_ANTHROPIC_KEY?.trim() ||
  readFileSync(path.join(os.homedir(), '.sei-dev', 'anthropic-test-key'), 'utf8').trim();
const call = createDirectAnthropicCall(key);

const win = fixture.window as Rect;
const W = fixture.frame.width;
const H = fixture.frame.height;
const fr = { rect: win, width: W, height: H };
const img = (r: Rect) => {
  const a = globalToImage({ x: r.x, y: r.y }, fr);
  const b = globalToImage({ x: r.x + r.w, y: r.y + r.h }, fr);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
};

async function renderFrame(signedIn: boolean): Promise<Frame> {
  const email = img({ x: 1900, y: 300, w: 400, h: 30 });
  const pass = img({ x: 1900, y: 350, w: 400, h: 30 });
  const btn = img({ x: 1900, y: 400, w: 120, h: 32 });
  const link = img({ x: 1900, y: 450, w: 150, h: 20 });
  const welcome = img({ x: 1900, y: 200, w: 300, h: 40 });
  const terms = img({ x: 1900, y: 700, w: 200, h: 20 });
  const body = signedIn
    ? `<text x="${welcome.x}" y="${welcome.y + 30}" font-size="30" font-family="sans-serif">You are signed in. Inbox (3)</text>`
    : `
    <text x="${welcome.x}" y="${welcome.y + 30}" font-size="30" font-family="sans-serif">Welcome back</text>
    <rect x="${email.x}" y="${email.y}" width="${email.w}" height="${email.h}" fill="#fff" stroke="#888"/>
    <text x="${email.x + 8}" y="${email.y + 22}" font-size="16" fill="#999" font-family="sans-serif">Email</text>
    <rect x="${pass.x}" y="${pass.y}" width="${pass.w}" height="${pass.h}" fill="#fff" stroke="#888"/>
    <text x="${pass.x + 8}" y="${pass.y + 22}" font-size="16" fill="#999" font-family="sans-serif">Password</text>
    <rect x="${btn.x}" y="${btn.y}" width="${btn.w}" height="${btn.h}" rx="6" fill="#2a6df4"/>
    <text x="${btn.x + 30}" y="${btn.y + 23}" font-size="16" fill="#fff" font-family="sans-serif">Sign in</text>
    <text x="${link.x}" y="${link.y + 16}" font-size="15" fill="#2a6df4" font-family="sans-serif">Forgot password?</text>
    <text x="${terms.x}" y="${terms.y + 16}" font-size="14" fill="#666" font-family="sans-serif">Terms of service</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="100%" height="100%" fill="#f4f5f7"/>
    <rect width="100%" height="36" fill="#dcdde1"/>
    <circle cx="16" cy="18" r="6" fill="#ff5f57"/><circle cx="36" cy="18" r="6" fill="#febc2e"/><circle cx="56" cy="18" r="6" fill="#28c840"/>
    <text x="${W / 2 - 60}" y="24" font-size="14" font-family="sans-serif">Sign in - Example</text>
    ${body}
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
  return { data: buf.toString('base64'), mime: 'image/jpeg', width: W, height: H, rect: win, capturedAt: Date.now() };
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

async function main() {
  const frame = await renderFrame(false);
  const doneFrame = await renderFrame(true);
  const perception = perceive({
    frame,
    targetRect: win,
    ax: fixture.ax as AxNode[],
    ocr: fixture.ocr as OcrBox[],
    focused: null,
    appName: 'Safari',
    windowTitle: 'Sign in - Example',
  });
  const signIn = perception.options.find((o) => o.label === 'click button "Sign in"')!;
  const btnImg = img({ x: 1900, y: 400, w: 120, h: 32 });
  const system = buildActSystem({ characterName: 'Sui', target: { kind: 'window', windowId: 1 }, targetLabel: 'Safari' });

  const configs: Array<{ label: string; model: string; extra?: Record<string, unknown> }> = [];
  for (const m of MODELS) {
    if (/(sonnet|opus|fable)-5/.test(m)) {
      configs.push({ label: `${m} effort=low`, model: m, extra: { output_config: { effort: 'low' } } });
      configs.push({ label: `${m} thinking=off`, model: m, extra: { thinking: { type: 'disabled' } } });
    } else configs.push({ label: m, model: m });
  }
  for (const withOptions of [true, false]) {
    for (const c of configs) {
      const chooser = new VisionChooser({ call, model: c.model, system, cache: true, anthropicExtra: c.extra });
      const lat: number[] = [];
      let right = 0;
      let inTok = 0;
      let outTok = 0;
      for (let i = 0; i < N; i++) {
        const t0 = Date.now();
        const ch = await chooser.choose(
          {
            goal: 'Click the Sign in button',
            frame,
            perception: withOptions ? perception : null,
            step: 1,
            maxSteps: 40,
            timeLeftS: 120,
            notes: [],
            playerLines: [],
          },
          withOptions ? perception.options : [],
          [],
          new AbortController().signal,
        );
        lat.push(Date.now() - t0);
        inTok += ch.usage?.input_tokens ?? 0;
        outTok += ch.usage?.output_tokens ?? 0;
        const a = ch.index !== undefined ? perception.options[ch.index]?.action : ch.action;
        const hit =
          ch.index === signIn.index ||
          (a?.name === 'click' &&
            a.input.x >= btnImg.x &&
            a.input.x <= btnImg.x + btnImg.w &&
            a.input.y >= btnImg.y &&
            a.input.y <= btnImg.y + btnImg.h);
        if (hit) right += 1;
        if (i === 0) console.log(`  ${c.label} ${withOptions ? 'options' : 'pixels'} sample: ${ch.index !== undefined ? `choose ${ch.index}` : JSON.stringify(a)}${ch.say ? ` say="${ch.say}"` : ''}${ch.error ? ` error=${ch.error}` : ''}`);
      }
      console.log(
        `${c.label.padEnd(34)} ${withOptions ? 'options' : 'pixels '} p50=${pct(lat, 0.5)}ms max=${Math.max(...lat)}ms right=${right}/${N} in=${Math.round(inTok / N)} out=${Math.round(outTok / N)}`,
      );
    }
  }
  for (const m of MODELS) {
    const verify = makeVerifier({ call, model: m, anthropic: true });
    const a = await verify('Sign in to the site', doneFrame, new AbortController().signal);
    const b = await verify('Sign in to the site', frame, new AbortController().signal);
    console.log(`verify ${m}: signed-in frame -> ${a.achieved} (${a.latencyMs}ms, "${a.why}"); login frame -> ${b.achieved} (${b.latencyMs}ms)`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
