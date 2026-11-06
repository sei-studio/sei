/**
 * Avatar image rules (261106), read from the header without decoding: the
 * same checks the avatar library proxy runs on every portrait and every image
 * in a model zip (sei-proxy src/avatars/image.ts), so whatever the local store
 * holds can be uploaded.
 *
 * Moderation judges one frame, so an animated image is refused:
 *   APNG           an acTL, fcTL or fdAT chunk anywhere in the PNG
 *   animated WebP  the VP8X animation flag, or an ANIM / ANMF chunk
 * Pixel size is capped too: MAX_TEXTURE_SIDE for an image in a model zip,
 * MAX_PORTRAIT_SIDE for a portrait.
 */

/** PNG / JPEG / WebP by magic bytes, or null. */
export function sniffAvatarImage(b: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

export const MAX_TEXTURE_SIDE = 8192;
export const MAX_PORTRAIT_SIDE = 4096;

export type ImageFacts = { mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number; animated: boolean };
export type ImageProblem = 'bad_image' | 'animated_image' | 'image_too_large';

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}
function tag(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}

function png(b: Uint8Array): ImageFacts | null {
  // IHDR is the first chunk.
  if (b.length < 33 || u32be(b, 8) !== 13 || tag(b, 12) !== 'IHDR') return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  let animated = false;
  let p = 8;
  // Walk every chunk header (length, type, data, crc) up to IEND.
  while (p + 8 <= b.length) {
    const len = u32be(b, p);
    const type = tag(b, p + 4);
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      animated = true;
      break;
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return { mime: 'image/png', width, height, animated };
}

function jpeg(b: Uint8Array): ImageFacts | null {
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1]!;
    if (marker === 0xff) {
      p += 1;
      continue;
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      p += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = u16be(b, p + 2);
    if (len < 2) return null;
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (p + 9 > b.length) return null;
      return { mime: 'image/jpeg', height: u16be(b, p + 5), width: u16be(b, p + 7), animated: false };
    }
    p += 2 + len;
  }
  return null;
}

function webp(b: Uint8Array): ImageFacts | null {
  const end = Math.min(b.length, 8 + u32le(b, 4));
  let width = 0;
  let height = 0;
  let animated = false;
  let sized = false;
  let p = 12;
  while (p + 8 <= end) {
    const type = tag(b, p);
    const len = u32le(b, p + 4);
    const d = p + 8;
    if (type === 'ANIM' || type === 'ANMF') animated = true;
    else if (type === 'VP8X' && d + 10 <= end) {
      if (b[d]! & 0x02) animated = true;
      width = u24le(b, d + 4) + 1;
      height = u24le(b, d + 7) + 1;
      sized = true;
    } else if (type === 'VP8 ' && !sized && d + 10 <= end) {
      if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return null;
      width = (b[d + 6]! | (b[d + 7]! << 8)) & 0x3fff;
      height = (b[d + 8]! | (b[d + 9]! << 8)) & 0x3fff;
      sized = true;
    } else if (type === 'VP8L' && !sized && d + 5 <= end) {
      if (b[d] !== 0x2f) return null;
      const bits = u32le(b, d + 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      sized = true;
    }
    p = d + len + (len & 1);
  }
  if (!sized) return null;
  return { mime: 'image/webp', width, height, animated };
}

/** Header facts of a PNG / JPEG / WebP, or null when it is none of them (or its header is broken). */
export function imageFacts(bytes: Uint8Array): ImageFacts | null {
  const kind = sniffAvatarImage(bytes);
  if (kind === 'png') return png(bytes);
  if (kind === 'jpeg') return jpeg(bytes);
  if (kind === 'webp') return webp(bytes);
  return null;
}

/** Why an image cannot be stored, or null when it can. */
export function imageProblem(facts: ImageFacts | null, maxSide: number): ImageProblem | null {
  if (!facts || facts.width <= 0 || facts.height <= 0) return 'bad_image';
  if (facts.animated) return 'animated_image';
  if (facts.width > maxSide || facts.height > maxSide) return 'image_too_large';
  return null;
}

/** The problem of these bytes as an avatar image, or null when they can be stored. */
export function avatarImageProblem(bytes: Uint8Array, maxSide: number): ImageProblem | null {
  return imageProblem(imageFacts(bytes), maxSide);
}
