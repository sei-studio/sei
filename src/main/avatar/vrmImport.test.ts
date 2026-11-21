import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { looksLikeGlb, mapVrmEmotions, parseVrm, VRM_MAX_BYTES, VrmImportError, vrmImportedProps, vrmImportFailProps } from './vrmImport';

/** A 1x1 PNG (valid signature + IHDR, enough for the sniff and the size read). */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082',
  'hex',
);

function pad4(b: Buffer, fill: number): Buffer {
  const n = (4 - (b.byteLength % 4)) % 4;
  return n ? Buffer.concat([b, Buffer.alloc(n, fill)]) : b;
}

/** Build a GLB from a glTF JSON object and an optional BIN payload. */
function glb(json: Record<string, unknown>, bin?: Buffer, extraChunk?: Buffer): Buffer {
  const j = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const parts: Buffer[] = [];
  const chunk = (data: Buffer, type: number): void => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.byteLength, 0);
    h.writeUInt32LE(type, 4);
    parts.push(h, data);
  };
  chunk(j, 0x4e4f534a);
  if (bin) chunk(pad4(bin, 0), 0x004e4942);
  if (extraChunk) chunk(extraChunk, 0x12345678);
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + body.byteLength, 8);
  return Buffer.concat([head, body]);
}

function vrm1(overrides: Record<string, unknown> = {}, bin: Buffer = PNG): Buffer {
  return glb(
    {
      asset: { version: '2.0' },
      extensionsUsed: ['VRMC_vrm'],
      buffers: [{ byteLength: bin.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: PNG.byteLength }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
      nodes: [{ name: 'hips' }, { name: 'head' }],
      extensions: {
        VRMC_vrm: {
          specVersion: '1.0',
          meta: {
            name: 'Test Girl',
            version: '1',
            authors: ['someone'],
            licenseUrl: 'https://vrm.dev/licenses/1.0/',
            avatarPermission: 'everyone',
            commercialUsage: 'personalNonProfit',
            allowExcessivelyViolentUsage: false,
            allowExcessivelySexualUsage: false,
            allowPoliticalOrReligiousUsage: false,
            allowAntisocialOrHateUsage: false,
            creditNotation: 'required',
            allowRedistribution: false,
            modification: 'prohibited',
          },
          humanoid: { humanBones: { hips: { node: 0 }, head: { node: 1 } } },
          expressions: { preset: { happy: {}, sad: {}, angry: {}, relaxed: {}, surprised: {}, aa: {}, blink: {} }, custom: { Blush: {} } },
        },
      },
      ...overrides,
    },
    bin,
  );
}

function vrm0(meta: Record<string, unknown> = {}): Buffer {
  return glb(
    {
      asset: { version: '2.0' },
      buffers: [{ byteLength: PNG.byteLength }],
      bufferViews: [{ buffer: 0, byteLength: PNG.byteLength }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
      nodes: [{}, {}, {}],
      extensions: {
        VRM: {
          meta: {
            title: 'Old Model',
            author: 'author0',
            allowedUserName: 'OnlyAuthor',
            violentUssageName: 'Disallow',
            sexualUssageName: 'Disallow',
            commercialUssageName: 'Allow',
            licenseName: 'CC_BY_ND',
            ...meta,
          },
          humanoid: { humanBones: [{ bone: 'hips', node: 0 }, { bone: 'head', node: 2 }] },
          blendShapeMaster: {
            blendShapeGroups: [
              { name: 'Joy', presetName: 'joy' },
              { name: 'Sorrow', presetName: 'sorrow' },
              { name: 'A', presetName: 'a' },
              { name: 'Blink', presetName: 'blink' },
              { name: 'Heart eyes', presetName: 'unknown' },
            ],
          },
          secondaryAnimation: { boneGroups: [{}, {}] },
        },
      },
    },
    PNG,
  );
}

const problemOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof VrmImportError ? err.problem : `other: ${String(err)}`;
  }
};

describe('parseVrm', () => {
  it('reads a VRM 1.0 file: meta, expressions, emotions', () => {
    const p = parseVrm(vrm1(), 'ignored.vrm');
    expect(p.name).toBe('Test Girl');
    expect(p.info.specVersion).toBe('1.0');
    expect(p.info.authors).toEqual(['someone']);
    expect(p.info.avatarPermission).toBe('everyone');
    expect(p.info.commercialUsage).toBe('personalNonProfit');
    expect(p.info.redistribution).toBe(false);
    expect(p.info.modification).toBe('prohibited');
    expect(p.info.licenseUrl).toBe('https://vrm.dev/licenses/1.0/');
    expect(p.info.maxTextureSide).toBe(1);
    expect(p.emotions).toMatchObject({ happy: 'happy', sad: 'sad', angry: 'angry', surprised: 'surprised', love: 'relaxed', shy: 'Blush' });
  });

  it('reads a VRM 0.x file and maps its meta to the 1.0 vocabulary', () => {
    const p = parseVrm(vrm0(), 'Fallback Name.vrm');
    expect(p.info.specVersion).toBe('0.x');
    expect(p.name).toBe('Old Model');
    expect(p.info.authors).toEqual(['author0']);
    expect(p.info.avatarPermission).toBe('onlyAuthor');
    expect(p.info.commercialUsage).toBe('personalProfit');
    expect(p.info.violentUsage).toBe(false);
    expect(p.info.licenseName).toBe('CC_BY_ND');
    expect(p.info.modification).toBe('prohibited');
    expect(p.info.creditNotation).toBe('required');
    expect(p.info.springBones).toBe(2);
    expect(p.info.expressions).toEqual(['happy', 'sad', 'aa', 'blink', 'Heart eyes']);
    expect(p.emotions).toMatchObject({ happy: 'happy', sad: 'sad', love: 'Heart eyes' });
  });

  it('falls back to the file name when the meta has no title', () => {
    expect(parseVrm(vrm0({ title: '' }), 'C:\\models\\My Avatar.vrm').name).toBe('My Avatar');
  });

  it('refuses what is not a GLB', () => {
    expect(problemOf(() => parseVrm(Buffer.from('PK\u0003\u0004 not a glb at all....')))).toBe('not_glb');
  });

  it('refuses a GLB whose header length lies', () => {
    const b = vrm1();
    b.writeUInt32LE(b.byteLength + 4, 8);
    expect(problemOf(() => parseVrm(b))).toBe('bad_glb');
  });

  it('refuses a truncated file', () => {
    const b = vrm1();
    const cut = Buffer.from(b.subarray(0, b.byteLength - 8));
    cut.writeUInt32LE(cut.byteLength, 8);
    expect(problemOf(() => parseVrm(cut))).toBe('bad_glb');
  });

  it('refuses an unknown extra chunk', () => {
    const b = glb({ asset: { version: '2.0' } }, PNG, Buffer.alloc(4));
    expect(problemOf(() => parseVrm(b))).toBe('bad_glb');
  });

  it('refuses a plain glTF with no VRM extension', () => {
    const b = vrm1({ extensions: {} });
    expect(problemOf(() => parseVrm(b))).toBe('not_vrm');
  });

  it('refuses an external buffer URI (also data: URIs)', () => {
    expect(problemOf(() => parseVrm(vrm1({ buffers: [{ byteLength: PNG.byteLength, uri: 'https://example.com/x.bin' }] })))).toBe('external_uri');
    expect(problemOf(() => parseVrm(vrm1({ buffers: [{ byteLength: PNG.byteLength }, { byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' }] })))).toBe('external_uri');
  });

  it('refuses an external image URI', () => {
    expect(problemOf(() => parseVrm(vrm1({ images: [{ uri: 'file:///etc/passwd' }] })))).toBe('external_uri');
  });

  it('refuses a bufferView outside the buffer', () => {
    expect(problemOf(() => parseVrm(vrm1({ bufferViews: [{ buffer: 0, byteOffset: 8, byteLength: PNG.byteLength }] })))).toBe('bad_buffer');
  });

  it('refuses a texture that is not what its mimeType says', () => {
    expect(problemOf(() => parseVrm(vrm1({ images: [{ bufferView: 0, mimeType: 'image/jpeg' }] })))).toBe('bad_image');
    const junk = Buffer.alloc(PNG.byteLength, 7);
    expect(problemOf(() => parseVrm(vrm1({}, junk)))).toBe('bad_image');
  });

  it('refuses extensionsRequired the loader cannot decode (Draco, meshopt, KTX2)', () => {
    for (const ext of ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu']) {
      expect(problemOf(() => parseVrm(vrm1({ extensionsRequired: [ext] })))).toBe('unsupported_extension');
    }
    expect(problemOf(() => parseVrm(vrm1({ extensionsRequired: ['KHR_texture_transform', 'KHR_materials_unlit'] })))).toBeNull();
  });

  it('refuses a VRM with no usable humanoid', () => {
    const b = vrm1({
      extensions: { VRMC_vrm: { meta: {}, humanoid: { humanBones: { hips: { node: 0 }, head: { node: 9 } } } } },
    });
    expect(problemOf(() => parseVrm(b))).toBe('no_humanoid');
  });

  it('refuses a file over the cap before parsing it', () => {
    const big = { byteLength: VRM_MAX_BYTES + 1, readUInt32LE: () => 0 } as unknown as Buffer;
    expect(problemOf(() => parseVrm(big))).toBe('too_big');
  });

  it('keeps meta strings plain and URLs http(s) only', () => {
    const b = vrm1({
      extensions: {
        VRMC_vrm: {
          meta: { name: 'a\u0000b\nc', authors: ['x'.repeat(500)], licenseUrl: 'javascript:alert(1)', otherLicenseUrl: 'https://ok.example/l' },
          humanoid: { humanBones: { hips: { node: 0 }, head: { node: 1 } } },
        },
      },
    });
    const p = parseVrm(b);
    expect(p.name).toBe('a b c');
    expect(p.info.authors[0]!.length).toBe(80);
    expect(p.info.licenseUrl).toBeUndefined();
    expect(p.info.otherLicenseUrl).toBe('https://ok.example/l');
    expect(p.info.avatarPermission).toBe('unknown');
  });
});

describe('helpers', () => {
  it('looksLikeGlb sniffs the magic', () => {
    expect(looksLikeGlb(vrm1())).toBe(true);
    expect(looksLikeGlb(Buffer.from('PK\u0003\u0004'))).toBe(false);
  });

  it('mapVrmEmotions: same-name presets win, a custom face beats a stand-in preset', () => {
    expect(mapVrmEmotions(['happy', 'Shy face', 'Sparkle'])).toEqual({ happy: 'happy', excited: 'Sparkle', love: 'happy', shy: 'Shy face' });
    expect(mapVrmEmotions(['surprised', 'Shock'])).toEqual({ excited: 'surprised', surprised: 'surprised' });
  });

  it('analytics props are shape only', () => {
    const p = parseVrm(vrm1());
    const props = vrmImportedProps(p.info, 30 * 1024 * 1024);
    expect(props).toMatchObject({ vrm_version: '1.0', mb: '25-50', commercial_usage: 'personalNonProfit', redistribution: false });
    expect(JSON.stringify(props)).not.toContain('Test Girl');
    expect(JSON.stringify(props)).not.toContain('someone');
    expect(vrmImportFailProps(new VrmImportError('not_vrm', 'x'), 5)).toEqual({ reason: 'not_vrm', mb: '<10' });
    expect(vrmImportFailProps(new Error('boom'), 5).reason).toBe('other');
  });
});

// The downloaded samples (not in the repo): parsed when present on this machine.
const SAMPLES = process.env.SEI_VRM_SAMPLES;
describe.runIf(!!SAMPLES && existsSync(SAMPLES))('real sample VRMs', () => {
  for (const rel of ['seed-san/Seed-san.vrm', 'three-vrm-girl/three-vrm-girl.vrm', 'twist/VRM1_Constraint_Twist_Sample.vrm']) {
    it(`parses ${rel}`, () => {
      const file = `${SAMPLES}/${rel}`;
      if (!existsSync(file)) return;
      const p = parseVrm(readFileSync(file), rel);
      // eslint-disable-next-line no-console
      console.log(rel, JSON.stringify({ name: p.name, emotions: p.emotions, ...p.info }));
      expect(p.info.expressions).toContain('aa');
    });
  }
});
