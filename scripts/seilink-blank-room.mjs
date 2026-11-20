#!/usr/bin/env node
/**
 * The blank first room's art (261106, first-link flow): a black and white
 * version of the cozy room that a companion starts in on her first link.
 *
 *   node scripts/seilink-blank-room.mjs [--packs resources/seilink-packs] [--preview <png>]
 *
 * Writes into the cozy pack (same canvas, same placement labels, so every
 * part and item of the cozy room can be added back while decorating):
 *   shell_blank_<time>.webp      the walls, floor and window frame, grey
 *   shell_blank_glow_night.webp  the night glow, grey
 *   chair_plain_<time>.webp      the armchair she sits in, grey
 * and the shared view behind the window:
 *   _shared/views/blank_<time>.webp   a soft, plain grey sky
 *
 * The manifest entries (blank_room, plain_armchair, view_blank) are in
 * cozy/manifest.json; blankRoomState() in shared/seilinkRoom.ts picks them.
 * Re-run after the cozy shell or chair art changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PACKS = path.resolve(arg('packs', path.join(REPO, 'resources/seilink-packs')));
const COZY = path.join(PACKS, 'cozy');
const VIEWS = path.join(PACKS, '_shared/views');
const PREVIEW = arg('preview', null);

/** Grey with the shading kept, lifted toward white (multiplier, offset per time). */
const LEVELS = {
  day: [0.8, 70],
  dusk: [0.78, 62],
  night: [0.9, 18],
};

/** The plain sky behind the glass: top and bottom grey per time. */
const SKY = {
  day: ['#e6e6e6', '#fbfbfb'],
  dusk: ['#cfcfcf', '#ececec'],
  night: ['#1f1f1f', '#3b3b3b'],
};

async function mono(src, dst, [a, b]) {
  await sharp(src).grayscale().linear(a, b).toColourspace('srgb').webp({ quality: 88, alphaQuality: 100 }).toFile(dst);
  console.log(path.relative(REPO, dst));
}

async function sky(dst, [top, bottom], w, h) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  await sharp(Buffer.from(svg)).webp({ quality: 90 }).toFile(dst);
  console.log(path.relative(REPO, dst));
}

async function main() {
  const view = await sharp(path.join(VIEWS, 'city_day.webp')).metadata();
  for (const time of ['day', 'dusk', 'night']) {
    await mono(path.join(COZY, `shell_${time}.webp`), path.join(COZY, `shell_blank_${time}.webp`), LEVELS[time]);
    await mono(path.join(COZY, `chair_${time}.webp`), path.join(COZY, `chair_plain_${time}.webp`), LEVELS[time]);
    await sky(path.join(VIEWS, `blank_${time}.webp`), SKY[time], view.width ?? 1215, view.height ?? 1319);
  }
  await mono(path.join(COZY, 'shell_glow_night.webp'), path.join(COZY, 'shell_blank_glow_night.webp'), [1, 0]);

  if (PREVIEW) {
    const layers = [
      { input: await sharp(path.join(VIEWS, 'blank_day.webp')).resize(1219, 1292, { fit: 'cover' }).toBuffer(), left: 1341, top: 16 },
      { input: path.join(COZY, 'shell_blank_day.webp') },
      { input: path.join(COZY, 'chair_plain_day.webp') },
    ];
    const flat = await sharp({ create: { width: 2560, height: 1440, channels: 4, background: '#ffffff' } }).composite(layers).png().toBuffer();
    fs.mkdirSync(path.dirname(path.resolve(PREVIEW)), { recursive: true });
    await sharp(flat).resize(1280, 720).toFile(path.resolve(PREVIEW));
    console.log(PREVIEW);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
