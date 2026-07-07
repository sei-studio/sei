// Minimal Gemini image-generation client (REST, no SDK).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const NANO_BANANA_PRO = 'gemini-3-pro-image';

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY not set (source .env)');
  return k;
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

async function imagePart(file) {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`unsupported image type: ${file}`);
  return { inline_data: { mime_type: mime, data: (await readFile(file)).toString('base64') } };
}

/**
 * Generate image(s) from a prompt plus optional input images.
 * Returns array of Buffers (usually length 1).
 */
export async function generateImage({ prompt, images = [], model = NANO_BANANA_PRO, aspectRatio = '1:1', retries = 2 }) {
  const parts = [{ text: prompt }];
  for (const f of images) parts.push(await imagePart(f));
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio },
    },
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      if (attempt < retries && (res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      throw new Error(`gemini ${model} HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = await res.json();
    const outParts = json.candidates?.[0]?.content?.parts ?? [];
    const bufs = outParts
      .filter((p) => p.inlineData || p.inline_data)
      .map((p) => Buffer.from((p.inlineData ?? p.inline_data).data, 'base64'));
    if (bufs.length === 0) {
      const finish = json.candidates?.[0]?.finishReason;
      const text = outParts.map((p) => p.text).filter(Boolean).join(' ');
      if (attempt < retries) continue;
      throw new Error(`no image in response (finishReason=${finish}, text=${text.slice(0, 200)})`);
    }
    return bufs;
  }
}

export async function generateImageToFile(opts, outFile) {
  const [buf] = await generateImage(opts);
  await writeFile(outFile, buf);
  return outFile;
}
