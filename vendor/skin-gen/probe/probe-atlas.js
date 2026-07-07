// Branch A probe: ask Nano Banana Pro for the flat UV atlas directly,
// with a real skin atlas as layout reference.
// Usage: node probe/probe-atlas.js <characterImage> <outPrefix> [runs]
import { generateImageToFile } from '../src/gemini.js';
import { ATLAS_PROMPT } from '../src/prompts.js';

const [, , character, outPrefix = 'out/probe', runs = '2'] = process.argv;
if (!character) {
  console.error('usage: node probe/probe-atlas.js <characterImage> <outPrefix> [runs]');
  process.exit(1);
}

for (let i = 0; i < Number(runs); i++) {
  const out = `${outPrefix}-run${i + 1}.png`;
  const t0 = Date.now();
  await generateImageToFile(
    { prompt: ATLAS_PROMPT, images: ['assets/steve512.png', character] },
    out
  );
  console.log(`${out} written in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
