#!/usr/bin/env node
/**
 * china-compat W8 (260816): assemble the dl.sei.gg mirror tree locally.
 *
 * Downloads every runtime model asset the app fetches from firewall-hostile
 * hosts (Hugging Face is hard-blocked in mainland China; GitHub release
 * assets are unreliable there) into ./mirror-out/, laid out exactly as the
 * bucket should serve it:
 *
 *   hf/<model>/resolve/main/<file>   transformers.js layout — the renderer
 *                                    points env.remoteHost at
 *                                    https://dl.sei.gg/hf and the default
 *                                    remotePathTemplate resolves the rest
 *   chess/maia3-5m.onnx              src/main/chess/modelStore.ts
 *   speech/<archive>                 sherpa-onnx packs (src/main/speech/mirrors.ts)
 *
 * Whisper file set is pinned to what the worker actually requests
 * (device wasm + dtype q8 → *_quantized.onnx; see whisperWorker.ts). If the
 * worker's dtype ever changes, change WHISPER_FILES with it.
 *
 * Usage: node scripts/mirror-assets.mjs [--only hf|chess|speech]
 * Then upload mirror-out/ to the sei-dl R2 bucket (wrangler r2 object put,
 * the dashboard uploader, or rclone). Updater artifacts are NOT handled
 * here — .github/workflows/mirror-release.yml mirrors those per release.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const OUT = join(process.cwd(), 'mirror-out');

const WHISPER_MODELS = ['onnx-community/whisper-tiny.en', 'onnx-community/whisper-base'];
const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'normalizer.json',
  'merges.txt',
  'vocab.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

const CHESS = [
  {
    url: 'https://github.com/sei-studio/cce-1/releases/download/model-v1/maia3-5m.onnx',
    dest: 'chess/maia3-5m.onnx',
  },
];

// Keep in sync with src/main/speech/mirrors.ts (the speech workstream owns
// the authoritative list; this seed matches the researched pack set).
const SHERPA_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';
const SPEECH = [
  `${SHERPA_BASE}/vits-piper-en_US-libritts_r-medium.tar.bz2`,
  `${SHERPA_BASE}/vits-icefall-zh-aishell3.tar.bz2`,
  `${SHERPA_BASE}/vits-piper-zh_CN-chaowen-medium.tar.bz2`,
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
].map((url) => ({ url, dest: `speech/${url.split('/').pop()}` }));

async function fetchTo(url, dest) {
  const abs = join(OUT, dest);
  const existing = await stat(abs).catch(() => null);
  if (existing && existing.size > 0) {
    console.log(`skip (exists)  ${dest}`);
    return;
  }
  await mkdir(dirname(abs), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    // A 404 on an optional tokenizer file (not every model ships every one)
    // is tolerable for the hf set; hard assets must exist.
    if (res.status === 404 && dest.startsWith('hf/')) {
      console.warn(`404 (optional) ${dest}`);
      return;
    }
    throw new Error(`${res.status} ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(abs));
  const { size } = await stat(abs);
  console.log(`ok ${(size / 1e6).toFixed(1).padStart(7)} MB  ${dest}`);
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

const jobs = [];
if (!only || only === 'hf') {
  for (const model of WHISPER_MODELS) {
    for (const f of WHISPER_FILES) {
      jobs.push({ url: `https://huggingface.co/${model}/resolve/main/${f}`, dest: `hf/${model}/resolve/main/${f}` });
    }
  }
}
if (!only || only === 'chess') jobs.push(...CHESS);
if (!only || only === 'speech') jobs.push(...SPEECH);

let failed = 0;
for (const j of jobs) {
  try {
    await fetchTo(j.url, j.dest);
  } catch (e) {
    failed++;
    console.error(`FAIL ${j.dest}: ${e.message}`);
  }
}
console.log(failed ? `\n${failed} failures` : '\nmirror-out/ ready for upload');
process.exit(failed ? 1 : 0);
