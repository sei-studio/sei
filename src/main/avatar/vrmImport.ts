/**
 * VRM avatar import (261122, experimental: feat/vrm-avatar, branch only).
 *
 * A VRM is a glTF 2.0 binary (.glb) carrying the VRM extension: `VRM`
 * (VRM 0.x, VRoid Studio before 1.0, VSeeFace) or `VRMC_vrm` (VRM 1.0). The
 * renderer draws it with three.js + @pixiv/three-vrm (lib/vrm/VrmView.tsx).
 *
 * The file comes from the user's disk and is parsed by GLTFLoader in the
 * renderer, so it is checked strictly here first, before anything is stored:
 *  - a well-formed GLB container (magic, version 2, exact length, one JSON
 *    chunk and at most one BIN chunk, every chunk inside the file);
 *  - at most VRM_MAX_BYTES;
 *  - nothing external: no buffer or image may have a `uri` (not even a
 *    data: URI), so the loader never fetches anything and every byte it reads
 *    is in this file; one buffer, the GLB BIN chunk;
 *  - every bufferView inside its buffer, every image a real PNG, JPEG or WebP
 *    by magic bytes that matches its mimeType, static and at most
 *    MAX_TEXTURE_SIDE px (the same image rules as the Live2D store);
 *  - only extensionsRequired the stock GLTFLoader + VRM plugin can honour
 *    (no Draco, meshopt or KTX2: those need decoders we do not ship);
 *  - a VRM extension with a humanoid that names hips and head on real nodes.
 *
 * The VRM meta (licence) fields are read and kept on the manifest
 * (`manifest.vrm`), normalized to the VRM 1.0 vocabulary. They are recorded
 * and shown, never enforced.
 *
 * Pure (no fs): avatarStore.ts writes the bytes and the manifest.
 */
import { avatarImageProblem, MAX_TEXTURE_SIDE, sniffAvatarImage } from './avatarImage';
import type { AvatarEmotion, AvatarVrmInfo } from '../../shared/ipc';

/** Cap for one .vrm file (VRoid exports with 4k textures run 20 to 60 MB). */
export const VRM_MAX_BYTES = 100 * 1024 * 1024;
/** Cap on the JSON chunk (a large VRM's JSON is a few MB). */
const VRM_JSON_MAX_BYTES = 32 * 1024 * 1024;
/** The stored file name (the original name never becomes a path). */
export const VRM_ENTRY = 'model.vrm';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** extensionsRequired the renderer's GLTFLoader handles with no extra decoder. */
const SUPPORTED_REQUIRED = /^(KHR_materials_[a-z_]+|KHR_texture_transform|KHR_mesh_quantization|EXT_texture_webp|VRMC_[A-Za-z_]+|VRM)$/;

/** Why a file is not an importable VRM (analytics fail class + message key). */
export type VrmProblem =
  | 'too_big'
  | 'not_glb'
  | 'bad_glb'
  | 'bad_json'
  | 'not_vrm'
  | 'external_uri'
  | 'bad_buffer'
  | 'bad_image'
  | 'unsupported_extension'
  | 'no_humanoid';

export class VrmImportError extends Error {
  constructor(
    readonly problem: VrmProblem,
    message: string,
  ) {
    super(message);
    this.name = 'VrmImportError';
  }
}

const fail = (problem: VrmProblem, message: string): never => {
  throw new VrmImportError(problem, message);
};

/** True when the bytes start like a GLB (the import dispatch sniff). */
export function looksLikeGlb(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isIndex = (v: unknown, len: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < len;
const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Clip an untrusted meta string (they are shown in the UI, never as HTML). */
function str(v: unknown, max = 200): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}
/** Only http(s) URLs survive (a licence link the UI may show). */
function url(v: unknown): string | undefined {
  const s = str(v, 500);
  return s && /^https?:\/\/[^\s]+$/i.test(s) ? s : undefined;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
function allow0(v: unknown): boolean | null {
  return v === 'Allow' ? true : v === 'Disallow' ? false : null;
}

/** VRM 0.x blend shape preset → the VRM 1.0 expression name three-vrm uses. */
const V0_PRESET: Record<string, string> = {
  joy: 'happy',
  angry: 'angry',
  sorrow: 'sad',
  fun: 'relaxed',
  surprised: 'surprised',
  a: 'aa',
  i: 'ih',
  u: 'ou',
  e: 'ee',
  o: 'oh',
  blink: 'blink',
  blink_l: 'blinkLeft',
  blink_r: 'blinkRight',
  lookup: 'lookUp',
  lookdown: 'lookDown',
  lookleft: 'lookLeft',
  lookright: 'lookRight',
  neutral: 'neutral',
};

/** Our emotions → the VRM presets that show them (first one present wins). */
const EMOTION_PRESETS: ReadonlyArray<readonly [AvatarEmotion, readonly string[]]> = [
  ['happy', ['happy']],
  ['excited', ['happy', 'surprised']],
  ['love', ['relaxed', 'happy']],
  ['shy', ['relaxed']],
  ['sad', ['sad']],
  ['angry', ['angry']],
  ['surprised', ['surprised']],
];
/** Custom expression names that read as one of our emotions (VRoid has none by default). */
const CUSTOM_KEYWORDS: ReadonlyArray<readonly [AvatarEmotion, RegExp]> = [
  ['shy', /blush|shy|embarrass|照れ|赤面|害羞|脸红/i],
  ['love', /love|heart|ハート|爱心/i],
  ['excited', /excite|sparkle|star|キラ|兴奋/i],
  ['surprised', /surprise|shock|驚|惊/i],
];
const PRESET_NAMES = new Set(Object.values(V0_PRESET));

/** Map the expression names a VRM offers onto our emotion set. Exported for tests. */
export function mapVrmEmotions(names: readonly string[]): Partial<Record<AvatarEmotion, string>> {
  const have = new Set(names);
  const out: Partial<Record<AvatarEmotion, string>> = {};
  for (const [emotion, presets] of EMOTION_PRESETS) {
    const hit = presets.find((p) => have.has(p));
    if (hit) out[emotion] = hit;
  }
  const custom = names.filter((n) => !PRESET_NAMES.has(n));
  for (const [emotion, re] of CUSTOM_KEYWORDS) {
    // A preset named like the emotion (surprised) is the real thing; any other
    // mapping (love -> relaxed, shy -> relaxed) is a stand-in a custom face beats.
    if (out[emotion] === emotion) continue;
    const hit = custom.find((n) => re.test(n));
    if (hit) out[emotion] = hit;
  }
  return out;
}

export interface ParsedVrm {
  info: AvatarVrmInfo;
  name: string;
  emotions: Partial<Record<AvatarEmotion, string>>;
}

interface Glb {
  json: Json;
  binLength: number;
  binOffset: number;
}

function readGlb(b: Buffer): Glb {
  if (b.byteLength > VRM_MAX_BYTES) fail('too_big', `VRM file too large (${b.byteLength} bytes)`);
  if (b.byteLength < 20 || b.readUInt32LE(0) !== GLB_MAGIC) fail('not_glb', 'not a glTF binary (.glb / .vrm) file');
  if (b.readUInt32LE(4) !== 2) fail('bad_glb', `unsupported glTF binary version ${b.readUInt32LE(4)}`);
  if (b.readUInt32LE(8) !== b.byteLength) fail('bad_glb', 'glTF binary length does not match the file');
  let off = 12;
  let json: Json | null = null;
  let binOffset = -1;
  let binLength = 0;
  let index = 0;
  while (off < b.byteLength) {
    if (off + 8 > b.byteLength) fail('bad_glb', 'truncated glTF chunk header');
    const len = b.readUInt32LE(off);
    const type = b.readUInt32LE(off + 4);
    const start = off + 8;
    if (start + len > b.byteLength) fail('bad_glb', 'glTF chunk runs past the end of the file');
    if (index === 0) {
      if (type !== CHUNK_JSON) fail('bad_glb', 'first glTF chunk is not JSON');
      if (len > VRM_JSON_MAX_BYTES) fail('bad_json', 'glTF JSON chunk too large');
      let parsed: unknown;
      try {
        parsed = JSON.parse(b.subarray(start, start + len).toString('utf8'));
      } catch {
        fail('bad_json', 'glTF JSON chunk is not valid JSON');
      }
      if (!isObj(parsed)) fail('bad_json', 'glTF JSON is not an object');
      json = parsed as Json;
    } else if (index === 1 && type === CHUNK_BIN) {
      binOffset = start;
      binLength = len;
    } else {
      fail('bad_glb', 'unexpected extra glTF chunk');
    }
    off = start + len;
    index++;
  }
  if (!json) fail('bad_glb', 'glTF binary has no JSON chunk');
  return { json: json!, binOffset, binLength };
}

/**
 * Validate a .vrm file and read its meta. Throws VrmImportError with a
 * readable message on anything it refuses. Exported for tests.
 */
export function parseVrm(bytes: Buffer, fileName?: string): ParsedVrm {
  const { json, binOffset, binLength } = readGlb(bytes);
  const asset = json.asset;
  if (!isObj(asset) || typeof asset.version !== 'string' || !asset.version.startsWith('2.')) {
    fail('bad_json', 'not a glTF 2.0 asset');
  }

  // ── nothing external, every view inside the one embedded buffer ──────────
  const buffers = arr(json.buffers);
  if (buffers.length > 1) fail('external_uri', 'VRM has more than one buffer (only the embedded one is allowed)');
  for (const buf of buffers) {
    if (!isObj(buf)) fail('bad_buffer', 'buffer is not an object');
    if ('uri' in (buf as Json)) fail('external_uri', 'VRM references an external buffer');
    const len = (buf as Json).byteLength;
    if (!nonNegInt(len) || binOffset < 0 || len > binLength) fail('bad_buffer', 'buffer does not fit the embedded data');
  }
  const bufferLength = buffers.length ? ((buffers[0] as Json).byteLength as number) : 0;
  const views = arr(json.bufferViews);
  for (const v of views) {
    if (!isObj(v) || !isIndex(v.buffer, buffers.length)) fail('bad_buffer', 'bufferView points at no buffer');
    const o = ((v as Json).byteOffset ?? 0) as unknown;
    const l = (v as Json).byteLength;
    if (!nonNegInt(o) || !nonNegInt(l) || o + l > bufferLength) fail('bad_buffer', 'bufferView runs past its buffer');
  }
  const images = arr(json.images);
  let maxSide = 0;
  for (const img of images) {
    if (!isObj(img)) fail('bad_image', 'image is not an object');
    const im = img as Json;
    if ('uri' in im) fail('external_uri', 'VRM references an external image');
    if (!isIndex(im.bufferView, views.length)) fail('bad_image', 'image has no embedded data');
    const view = views[im.bufferView as number] as Json;
    const start = binOffset + ((view.byteOffset as number | undefined) ?? 0);
    const data = bytes.subarray(start, start + (view.byteLength as number));
    const kind = sniffAvatarImage(data);
    const mime = im.mimeType;
    if (!kind || mime !== `image/${kind}`) fail('bad_image', 'VRM texture is not a PNG, JPEG or WebP matching its type');
    const problem = avatarImageProblem(data, MAX_TEXTURE_SIDE);
    if (problem === 'animated_image') fail('bad_image', 'VRM texture is animated');
    if (problem === 'image_too_large') fail('bad_image', `VRM texture is larger than ${MAX_TEXTURE_SIDE} px`);
    if (problem) fail('bad_image', 'VRM texture is not a readable image');
    maxSide = Math.max(maxSide, textureSide(data));
  }
  for (const ext of arr(json.extensionsRequired)) {
    if (typeof ext !== 'string' || !SUPPORTED_REQUIRED.test(ext)) {
      fail('unsupported_extension', `VRM needs an unsupported glTF extension: ${String(ext).slice(0, 60)}`);
    }
  }

  // ── the VRM extension itself ──────────────────────────────────────────────
  const exts = isObj(json.extensions) ? json.extensions : {};
  const v1 = isObj(exts.VRMC_vrm) ? exts.VRMC_vrm : null;
  const v0 = !v1 && isObj(exts.VRM) ? exts.VRM : null;
  if (!v1 && !v0) fail('not_vrm', 'glTF file has no VRM extension (VRM or VRMC_vrm)');
  const nodeCount = arr(json.nodes).length;

  let info: AvatarVrmInfo;
  if (v1) {
    const bones = isObj(v1.humanoid) && isObj(v1.humanoid.humanBones) ? v1.humanoid.humanBones : {};
    const node = (name: string): unknown => (isObj(bones[name]) ? (bones[name] as Json).node : undefined);
    if (!isIndex(node('hips'), nodeCount) || !isIndex(node('head'), nodeCount)) {
      fail('no_humanoid', 'VRM humanoid has no hips or head bone');
    }
    const ex = isObj(v1.expressions) ? v1.expressions : {};
    const names = [
      ...Object.keys(isObj(ex.preset) ? ex.preset : {}),
      ...Object.keys(isObj(ex.custom) ? ex.custom : {}),
    ].slice(0, 200);
    const m = isObj(v1.meta) ? v1.meta : {};
    info = {
      specVersion: '1.0',
      title: str(m.name),
      modelVersion: str(m.version, 60),
      authors: arr(m.authors).map((a) => str(a, 80)).filter((a): a is string => !!a).slice(0, 8),
      contact: str(m.contactInformation),
      references: arr(m.references).map((r) => str(r, 300)).filter((r): r is string => !!r).slice(0, 4),
      copyright: str(m.copyrightInformation),
      licenseUrl: url(m.licenseUrl),
      otherLicenseUrl: url(m.otherLicenseUrl),
      avatarPermission: oneOf(m.avatarPermission, ['onlyAuthor', 'onlySeparatelyLicensedPerson', 'everyone']),
      commercialUsage: oneOf(m.commercialUsage, ['personalNonProfit', 'personalProfit', 'corporation']),
      violentUsage: bool(m.allowExcessivelyViolentUsage),
      sexualUsage: bool(m.allowExcessivelySexualUsage),
      politicalOrReligiousUsage: bool(m.allowPoliticalOrReligiousUsage),
      antisocialOrHateUsage: bool(m.allowAntisocialOrHateUsage),
      creditNotation: oneOf(m.creditNotation, ['required', 'unnecessary']),
      redistribution: bool(m.allowRedistribution),
      modification: oneOf(m.modification, ['prohibited', 'allowModification', 'allowModificationRedistribution']),
      expressions: names,
      maxTextureSide: maxSide,
      springBones: isObj(exts.VRMC_springBone) ? arr((exts.VRMC_springBone as Json).springs).length : 0,
    };
  } else {
    const hum = isObj(v0!.humanoid) ? v0!.humanoid : {};
    const bone = (name: string): unknown =>
      (arr(hum.humanBones).find((b) => isObj(b) && b.bone === name) as Json | undefined)?.node;
    if (!isIndex(bone('hips'), nodeCount) || !isIndex(bone('head'), nodeCount)) {
      fail('no_humanoid', 'VRM humanoid has no hips or head bone');
    }
    const groups = arr(isObj(v0!.blendShapeMaster) ? (v0!.blendShapeMaster as Json).blendShapeGroups : []);
    const names: string[] = [];
    for (const g of groups) {
      if (!isObj(g)) continue;
      const preset = typeof g.presetName === 'string' ? V0_PRESET[g.presetName.toLowerCase()] : undefined;
      const name = preset ?? str(g.name, 80);
      if (name && !names.includes(name)) names.push(name);
      if (names.length >= 200) break;
    }
    const m = isObj(v0!.meta) ? v0!.meta : {};
    const licenseName = str(m.licenseName, 60);
    const cc = licenseName && /^CC/i.test(licenseName);
    info = {
      specVersion: '0.x',
      title: str(m.title),
      modelVersion: str(m.version, 60),
      authors: str(m.author, 80) ? [str(m.author, 80)!] : [],
      contact: str(m.contactInformation),
      references: str(m.reference, 300) ? [str(m.reference, 300)!] : [],
      licenseName,
      otherLicenseUrl: url(m.otherLicenseUrl),
      otherPermissionUrl: url(m.otherPermissionUrl),
      avatarPermission:
        m.allowedUserName === 'OnlyAuthor'
          ? 'onlyAuthor'
          : m.allowedUserName === 'ExplicitlyLicensedPerson'
            ? 'onlySeparatelyLicensedPerson'
            : m.allowedUserName === 'Everyone'
              ? 'everyone'
              : 'unknown',
      // VRM 0.x has one yes/no; the 1.0 migration reads Allow as personal profit.
      commercialUsage: m.commercialUssageName === 'Allow' ? 'personalProfit' : m.commercialUssageName === 'Disallow' ? 'personalNonProfit' : 'unknown',
      violentUsage: allow0(m.violentUssageName),
      sexualUsage: allow0(m.sexualUssageName),
      politicalOrReligiousUsage: null,
      antisocialOrHateUsage: null,
      creditNotation: licenseName === 'CC0' ? 'unnecessary' : cc ? 'required' : 'unknown',
      redistribution: licenseName === 'Redistribution_Prohibited' ? false : cc ? true : null,
      modification: licenseName && /_ND$/i.test(licenseName) ? 'prohibited' : cc ? 'allowModificationRedistribution' : 'unknown',
      expressions: names,
      maxTextureSide: maxSide,
      springBones: arr(isObj(v0!.secondaryAnimation) ? (v0!.secondaryAnimation as Json).boneGroups : []).length,
    };
  }
  const stem = fileName ? str(fileName.replace(/^.*[\\/]/, '').replace(/\.(vrm|glb)$/i, ''), 80) : undefined;
  return { info, name: info.title ?? stem ?? 'VRM', emotions: mapVrmEmotions(info.expressions) };
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | 'unknown' {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : 'unknown';
}

/** The longer side of a PNG / JPEG / WebP (0 when it cannot be read cheaply). */
function textureSide(b: Uint8Array): number {
  if (sniffAvatarImage(b) === 'png' && b.length >= 24) {
    const w = (b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!;
    const h = (b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!;
    return Math.max(w >>> 0, h >>> 0);
  }
  if (sniffAvatarImage(b) === 'jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return 0;
      const marker = b[i + 1]!;
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return Math.max((b[i + 5]! << 8) | b[i + 6]!, (b[i + 7]! << 8) | b[i + 8]!);
      }
      i += 2 + len;
    }
  }
  return 0;
}

// ── analytics (shape only: enums, buckets, never names, authors or URLs) ────

/** File size bucket in MB. */
function mbBucket(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? '<10' : mb < 25 ? '10-25' : mb < 50 ? '25-50' : mb < 100 ? '50-100' : '100+';
}

/** avatar_vrm_imported props. */
export function vrmImportedProps(info: AvatarVrmInfo, bytes: number): Record<string, string | number | boolean | null> {
  return {
    vrm_version: info.specVersion,
    mb: mbBucket(bytes),
    max_texture: info.maxTextureSide,
    spring_bones: Math.min(info.springBones, 99),
    expressions: Math.min(info.expressions.length, 99),
    avatar_permission: info.avatarPermission,
    commercial_usage: info.commercialUsage,
    redistribution: info.redistribution,
    modification: info.modification,
  };
}

/** avatar_vrm_import_failed props: the fail class only. */
export function vrmImportFailProps(err: unknown, bytes: number): Record<string, string> {
  return { reason: err instanceof VrmImportError ? err.problem : 'other', mb: mbBucket(bytes) };
}
