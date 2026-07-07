// Character image -> valid Minecraft skin.
// Usage:
//   node src/pipeline.js <characterImage> <outSkin.png> [--variant wide|slim]
//                        [--mock <atlasImage>] [--keep-raw]
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateImage } from './gemini.js';
import { ATLAS_PROMPT, PANEL_PROMPT } from './prompts.js';
import { downsampleToSkin, writeSkinPng } from './downsample.js';
import { panelToAtlas } from './panelmap.js';
import { fallbackAtlas } from './fallback.js';
import { enforceLayout, flatBaseFaces } from './enforce.js';
import { renderPreview } from './render.js';
import { validateSkin } from './validate.js';

const REFERENCE_ATLAS = new URL('../assets/steve512.png', import.meta.url).pathname;

// 'wide' is the launcher's name for the classic 4px-arm model.
const normalizeVariant = (v) => (v === 'wide' ? 'classic' : v);

export async function characterToSkin(characterImage, outSkin, opts = {}) {
  const {
    variant: rawVariant = 'classic',
    branch = 'panel', // 'panel' (Branch B, default) | 'atlas' (Branch A)
    mockAtlas = null, // pre-made generator output; skips the API call
    keepRaw = false,
  } = opts;
  const variant = normalizeVariant(rawVariant);
  const rawOut = outSkin.replace(/\.png$/, `.raw-${branch}.png`);

  let usedBranch = branch;
  let fallbackReason = null;
  let genOutput = null;
  let raw;
  if (branch === 'fallback') {
    raw = await fallbackAtlas(characterImage, { variant });
  } else if (mockAtlas) {
    genOutput = mockAtlas;
    raw =
      branch === 'panel'
        ? await panelToAtlas(genOutput, { variant })
        : await downsampleToSkin(genOutput);
  } else {
    try {
      const [buf] = await generateImage({
        prompt: branch === 'panel' ? PANEL_PROMPT : ATLAS_PROMPT,
        images: branch === 'panel' ? [characterImage] : [REFERENCE_ATLAS, characterImage],
      });
      await writeFile(rawOut, buf);
      genOutput = rawOut;
      raw =
        branch === 'panel'
          ? await panelToAtlas(genOutput, { variant })
          : await downsampleToSkin(genOutput);
    } catch (err) {
      // Generation or mapping failed: fall back to the deterministic no-LLM
      // painter so every input still yields a valid skin.
      usedBranch = 'fallback';
      fallbackReason = String(err?.message ?? err);
      genOutput = null;
      raw = await fallbackAtlas(characterImage, { variant });
    }
  }
  const flat = flatBaseFaces(raw, { variant });
  const skin = enforceLayout(raw, { variant });
  await writeSkinPng(skin, outSkin);

  const problems = await validateSkin(outSkin, variant);
  const previewOut = outSkin.replace(/\.png$/, '.preview.png');
  await renderPreview(skin, previewOut, { variant });

  void keepRaw;
  return {
    skin: outSkin,
    preview: previewOut,
    branch: usedBranch,
    fallbackReason,
    rawAtlas: mockAtlas || !genOutput ? null : rawOut,
    flatBaseFaces: flat,
    valid:
      problems.transparentBase.length === 0 &&
      problems.opaqueWhitespace.length === 0,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [characterImage, outSkin] = pos;
  if (!characterImage || !outSkin) {
    console.error('usage: node src/pipeline.js <characterImage> <outSkin.png> [--variant wide|slim] [--branch panel|atlas|fallback] [--mock <generatorOutput>]');
    process.exit(1);
  }
  const res = await characterToSkin(path.resolve(characterImage), path.resolve(outSkin), {
    variant: flag('variant') ?? 'classic',
    branch: flag('branch') ?? 'panel',
    mockAtlas: flag('mock') ? path.resolve(flag('mock')) : null,
    keepRaw: args.includes('--keep-raw'),
  });
  console.log(JSON.stringify(res, null, 2));
}
