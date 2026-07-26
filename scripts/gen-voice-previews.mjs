// Generate bundled voice-preview mp3s for curated-pool voices.
//
// For each (voiceId, lang) pair missing on disk under
// src/renderer/public/voice-previews/<voiceId>-<lang>.mp3, synthesizes the
// per-language sample line via the ElevenLabs TTS API and writes the file.
//
// Usage:
//   node scripts/gen-voice-previews.mjs [voiceId ...]
// With no args, scans the whole soulcaster pool for ids missing any asset.
//
// API key comes from the SEI_TTS_DEV_KEY= line in ./.env (gitignored). The
// key is never printed. Idempotent: existing files are skipped. Per-file
// failures are reported and generation continues; a summary prints at the end.

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'renderer', 'public', 'voice-previews');

// MUST match PREVIEW_LINES in src/main/voice/tts.ts exactly.
const PREVIEW_LINES = {
  en: 'Hi, this is what I sound like.',
  zh: '嗨，这就是我的声音。',
  ja: 'やあ、これが私の声だよ。',
  ko: '안녕, 이게 내 목소리야.',
  fr: 'Salut, voici ma voix.',
  es: 'Hola, así es como sueno.',
};
const LANGS = Object.keys(PREVIEW_LINES);

function readApiKey() {
  const envPath = join(ROOT, '.env');
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    throw new Error('.env not found; SEI_TTS_DEV_KEY is required');
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^SEI_TTS_DEV_KEY=(.+)$/);
    if (m) return m[1].trim();
  }
  throw new Error('SEI_TTS_DEV_KEY not set in .env');
}

async function poolVoiceIds() {
  const { VOICES } = await import(
    new URL('../vendor/soulcaster/src/voices.js', import.meta.url)
  );
  return VOICES.map((v) => v.id);
}

async function synthesize(apiKey, voiceId, lang) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  const body = { text: PREVIEW_LINES[lang], model_id: 'eleven_flash_v2_5' };
  if (lang !== 'en') body.language_code = lang;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('empty response body');
  return buf;
}

async function main() {
  const apiKey = readApiKey();
  mkdirSync(OUT_DIR, { recursive: true });

  let ids = process.argv.slice(2);
  if (ids.length === 0) {
    const all = await poolVoiceIds();
    ids = all.filter((id) =>
      LANGS.some((lang) => !existsSync(join(OUT_DIR, `${id}-${lang}.mp3`))),
    );
    if (ids.length === 0) {
      console.log('All pool voices have all preview assets. Nothing to do.');
      return;
    }
  }

  let generated = 0;
  let skipped = 0;
  const failures = [];

  for (const id of ids) {
    for (const lang of LANGS) {
      const file = join(OUT_DIR, `${id}-${lang}.mp3`);
      if (existsSync(file) && statSync(file).size > 0) {
        skipped += 1;
        continue;
      }
      try {
        const buf = await synthesize(apiKey, id, lang);
        writeFileSync(file, buf);
        generated += 1;
        console.log(`ok   ${id}-${lang}.mp3 (${buf.length} bytes)`);
      } catch (err) {
        failures.push({ id, lang, message: err.message });
        console.error(`FAIL ${id}-${lang}.mp3: ${err.message}`);
      }
    }
  }

  console.log(
    `\nSummary: ${generated} generated, ${skipped} skipped (existing), ${failures.length} failed.`,
  );
  if (failures.length) {
    for (const f of failures) console.error(`  failed: ${f.id}-${f.lang}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
