import { describe, it, expect } from 'vitest';
import {
  looksLikePngRemix,
  parsePngRemix,
  pngSize,
  PngRemixError,
  PNGREMIX_MAX_BYTES,
  PNGREMIX_MAX_LAYERS,
  PNGREMIX_MAX_STATES,
  validatePngRemixSpec,
} from './pngRemix';
import { encodeStoredVar, fakeOld, fakePng, fakeV14, obj, v2, type FakeSprite } from './__fixtures__/godotEncode';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof PngRemixError) return err.code;
    throw err;
  }
  return 'ok';
}

const PNG_A = fakePng(40, 60, {}, 1);
const PNG_B = fakePng(10, 10, {}, 2);
const PNG_UNUSED = fakePng(8, 8, {}, 3);

/** A small 1.4.x model: body with eyes, a mouth and a hidden asset; three states. */
function v14Model(): Uint8Array {
  const on = { visible: true };
  return fakeV14({
    images: [
      { id: 11, png: PNG_A },
      { id: 12, png: PNG_B },
      { id: 13, png: PNG_UNUSED },
    ],
    states: [{ current_mc_anim: 'Bouncy', mouth_open: 3 }, { current_mc_anim: 'Float' }, {}],
    names: ['Idle', '2', 'Idle'],
    sprites: [
      { id: 1, name: 'body', image: 11, states: [{ ...on, z_index: 2, xAmp: 4, xFrq: 0.5 }, on, on], extra: { rest_mode: 1 } },
      { id: 2, parent: 1, name: 'eyes closed', image: 12, states: [{ should_blink: true, open_eyes: false, position: v2(3, -20) }, on, on] },
      { id: 3, parent: 1, name: 'mouth', image: 12, states: [{ should_talk: true, open_mouth: true }, on, on] },
      { id: 4, parent: 1, name: 'hat', image: 12, states: [on, on, on], extra: { is_asset: true, was_active_before: false, rest_mode: 4 } },
      { id: 5, name: 'note', type: 'Comment', states: [on] },
      { id: 6, parent: 1, name: 'folder', states: [{ folder: true }, on, on] },
    ],
  });
}

describe('parsePngRemix: 1.4.x saves', () => {
  it('reads the layer tree, states and images', () => {
    const { spec, images, skippedImages } = parsePngRemix(v14Model());
    expect(spec.source).toEqual({ generation: 'v14', version: '1.4.3' });
    expect(spec.tickRate).toBe(1);
    expect(spec.states.map((s) => s.name)).toEqual(['Idle', 'State 2', 'Idle (2)']);
    expect(spec.states[0]!.closed.anim).toBe('bouncy');
    expect(spec.states[0]!.open.onEnter).toBe(3);
    expect(spec.states[1]!.closed.anim).toBe('float');
    // The Comment sprite is dropped; the folder has no picture.
    expect(spec.layers.map((l) => l.name)).toEqual(['body', 'eyes closed', 'mouth', 'hat', 'folder']);
    expect(spec.layers.map((l) => l.parent)).toEqual([-1, 0, 0, 0, 0]);
    expect(spec.layers[4]!.image).toBe(-1);
    // Image 12 is shared and stored once; image 13 is never used and left out.
    expect(spec.images).toEqual([
      { path: 'img/0.png', w: 40, h: 60 },
      { path: 'img/1.png', w: 10, h: 10 },
    ]);
    expect(images.length).toBe(2);
    expect(Array.from(images[0]!)).toEqual(Array.from(PNG_A));
    expect(skippedImages).toBe(0);
    for (const l of spec.layers) expect(l.states.length).toBe(3);
  });

  it('maps blink, talk, asset and still flags', () => {
    const { spec } = parsePngRemix(v14Model());
    const [body, eyes, mouth, hat] = spec.layers;
    expect(eyes!.states[0]!.blink).toBe(2);
    expect(eyes!.states[0]!.pos).toEqual([3, -20]);
    expect(mouth!.states[0]!.talk).toBe(1);
    expect(body!.states[0]!.blink).toBe(0);
    expect(body!.states[0]!.z).toBe(2);
    expect(body!.states[0]!.motion.xAmp).toBe(4);
    expect(hat!.startHidden).toBe(true);
    expect(hat!.still).toBe(true);
    expect(body!.still).toBe(false);
  });

  it('produces a spec the renderer accepts, through JSON', () => {
    const { spec } = parsePngRemix(v14Model());
    expect(() => validatePngRemixSpec(JSON.parse(JSON.stringify(spec)))).not.toThrow();
  });

  it('keeps copies of the images, not views into the file', () => {
    const file = v14Model();
    const { images } = parsePngRemix(file);
    const before = Array.from(images[0]!);
    file.fill(0);
    expect(Array.from(images[0]!)).toEqual(before);
  });

  it('reads an appendage strip', () => {
    const file = fakeV14({
      images: [{ id: 1, png: PNG_A }],
      sprites: [
        {
          id: 1,
          type: 'WiggleApp',
          image: 1,
          states: [{ wiggle_segm: 6, segm_length: 12, width: 30, auto_wag: true, wag_freq: 0.1 }],
        },
      ],
    });
    const layer = parsePngRemix(file).spec.layers[0]!;
    expect(layer.kind).toBe('appendage');
    expect(layer.states[0]!.appendage).toMatchObject({ segments: 6, segLen: 12, width: 30, wag: { freq: 0.1 } });
  });

  it('breaks a parent cycle instead of looping', () => {
    const on = { visible: true };
    const file = fakeV14({
      images: [{ id: 1, png: PNG_A }],
      sprites: [
        { id: 1, parent: 2, image: 1, states: [on] },
        { id: 2, parent: 1, image: 1, states: [on] },
        { id: 3, parent: 3, image: 1, states: [on] },
      ],
    });
    const { spec } = parsePngRemix(file);
    expect(spec.layers.length).toBe(3);
    spec.layers.forEach((l, i) => expect(l.parent).toBeLessThan(i));
    expect(() => validatePngRemixSpec(spec)).not.toThrow();
  });
});

describe('parsePngRemix: older saves', () => {
  it('1.3.x: per-sprite PNG bytes, and positions rebuilt from global_position', () => {
    const file = fakeOld({
      states: [{}, {}],
      sprites: [
        // Old canvas centre is (640, 360): the body sits 10 right, 20 down.
        { id: 1, image: PNG_A, states: [{ global_position: v2(650, 380), scale: v2(2, 2) }, { global_position: v2(640, 360) }] },
        // The head is 50 above the body; the body is scaled 2x, so 25 in body space.
        { id: 2, parent: 1, image: PNG_B, states: [{ global_position: v2(650, 330) }, { global_position: v2(640, 300) }] },
      ],
    });
    const { spec } = parsePngRemix(file);
    expect(spec.source).toEqual({ generation: 'v13', version: '1.3.6' });
    expect(spec.tickRate).toBe(60);
    expect(spec.layers[0]!.states[0]!.pos).toEqual([10, 20]);
    expect(spec.layers[1]!.states[0]!.pos[0]).toBeCloseTo(0);
    expect(spec.layers[1]!.states[0]!.pos[1]).toBeCloseTo(-25);
    expect(spec.layers[0]!.states[1]!.pos).toEqual([0, 0]);
    expect(spec.layers[1]!.states[1]!.pos[1]).toBeCloseTo(-60);
  });

  it('legacy: base64 images and top-level bounce settings', () => {
    const b64 = Buffer.from(PNG_A).toString('base64');
    const file = fakeOld({
      legacy: true,
      settings: { bounceGravity: 900, bounceSlider: 120 },
      names: ['Happy'],
      sprites: [{ id: 1, image: b64, states: [{ visible: true }] }],
    });
    const { spec, images } = parsePngRemix(file);
    expect(spec.source.generation).toBe('legacy');
    expect(spec.states[0]!.name).toBe('Happy');
    expect(spec.states[0]!.closed.gravity).toBe(900);
    expect(spec.states[0]!.closed.energy).toBe(120);
    expect(Array.from(images[0]!)).toEqual(Array.from(PNG_A));
  });

  it('skips pictures that are not static PNGs', () => {
    const file = fakeOld({
      sprites: [
        { id: 1, image: PNG_A, states: [{ visible: true }] },
        { id: 2, image: fakePng(4, 4, { actl: true }), states: [{ visible: true }] },
        { id: 3, image: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]), states: [{ visible: true }] },
      ],
    });
    const { spec, skippedImages } = parsePngRemix(file);
    expect(skippedImages).toBe(2);
    expect(spec.layers.map((l) => l.image)).toEqual([0, -1, -1]);
  });
});

describe('parsePngRemix: refusals', () => {
  it('not a Remix file', () => {
    expect(codeOf(() => parsePngRemix(Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])))).toBe('not_pngremix');
    expect(codeOf(() => parsePngRemix(encodeStoredVar([1, 2, 3])))).toBe('not_pngremix');
    expect(codeOf(() => parsePngRemix(encodeStoredVar({ other: 1 })))).toBe('not_pngremix');
    expect(looksLikePngRemix(new TextEncoder().encode('PK\u0003\u0004 a zip file here'))).toBe(false);
  });

  it('too big', () => {
    const big = new Uint8Array(PNGREMIX_MAX_BYTES + 1);
    expect(codeOf(() => parsePngRemix(big))).toBe('too_big');
  });

  it('a script anywhere in the file', () => {
    const file = fakeV14({
      images: [{ id: 1, png: PNG_A }],
      sprites: [{ id: 1, image: 1, states: [{ visible: true }], extra: { hotkey: obj('InputEventKey', [['script', obj('InputEventKey', [])]]) } }],
    });
    expect(codeOf(() => parsePngRemix(file))).toBe('unsafe');
  });

  it('an object class we do not read', () => {
    const file = fakeV14({
      images: [{ id: 1, png: PNG_A }],
      sprites: [{ id: 1, image: 1, states: [{ visible: true }], extra: { node: obj('Node2D', []) } }],
    });
    expect(codeOf(() => parsePngRemix(file))).toBe('unsafe');
  });

  it('truncated', () => {
    // A cut file is not even sniffed as a Remix save (its length prefix runs past the end) ...
    const file = v14Model();
    expect(codeOf(() => parsePngRemix(file.subarray(0, file.length - 9)))).toBe('not_pngremix');
    // ... and one whose prefix agrees with the cut fails inside the decoder.
    const cut = file.slice(0, file.length - 8);
    new DataView(cut.buffer).setUint32(0, cut.length - 4, true);
    expect(codeOf(() => parsePngRemix(cut))).toBe('malformed');
  });

  it('no layer with a usable picture', () => {
    const file = fakeOld({ sprites: [{ id: 1, image: Uint8Array.from([1, 2, 3]), states: [{ visible: true }] }] });
    expect(codeOf(() => parsePngRemix(file))).toBe('no_layers');
  });

  it('an image over the side limit', () => {
    const file = fakeOld({ sprites: [{ id: 1, image: fakePng(9000, 10), states: [{ visible: true }] }] });
    expect(codeOf(() => parsePngRemix(file))).toBe('image_too_large');
  });

  it('too many layers or states', () => {
    const sprites: FakeSprite[] = Array.from({ length: PNGREMIX_MAX_LAYERS + 1 }, (_, i) => ({ id: i + 1, states: [] }));
    expect(codeOf(() => parsePngRemix(fakeOld({ sprites })))).toBe('too_many');
    const states = Array.from({ length: PNGREMIX_MAX_STATES + 1 }, () => ({}));
    expect(codeOf(() => parsePngRemix(fakeOld({ states, sprites: [{ id: 1, image: PNG_A, states: [] }] })))).toBe('too_many');
  });
});

describe('pngSize', () => {
  it('reads IHDR and refuses APNG and non-PNG', () => {
    expect(pngSize(fakePng(7, 9))).toEqual({ w: 7, h: 9 });
    expect(pngSize(fakePng(7, 9, { actl: true }))).toBeNull();
    expect(pngSize(new Uint8Array(40))).toBeNull();
  });
});

describe('validatePngRemixSpec', () => {
  it('refuses broken specs', () => {
    const good = () => JSON.parse(JSON.stringify(parsePngRemix(v14Model()).spec));
    expect(() => validatePngRemixSpec({ ...good(), format: 'x' })).toThrow();
    const badParent = good();
    badParent.layers[0].parent = 3;
    expect(() => validatePngRemixSpec(badParent)).toThrow(/parent/);
    const badPath = good();
    badPath.images[0].path = '../../etc/passwd';
    expect(() => validatePngRemixSpec(badPath)).toThrow(/image path/);
    const badStates = good();
    badStates.layers[1].states.pop();
    expect(() => validatePngRemixSpec(badStates)).toThrow(/states/);
  });
});
