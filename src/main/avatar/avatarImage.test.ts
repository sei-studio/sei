import { describe, expect, it } from 'vitest';
import { MAX_PORTRAIT_SIDE, MAX_TEXTURE_SIDE, avatarImageProblem, imageFacts, sniffAvatarImage } from './avatarImage';

/** Header-only PNG: signature, IHDR (w x h), optional acTL before or after an IDAT, IEND. CRCs are not checked. */
function pngHeader(w: number, h: number, o: { actl?: 'before' | 'after' } = {}): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const actl = chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      ...(o.actl === 'before' ? [actl] : []),
      chunk('IDAT', Buffer.from([1, 2, 3])),
      ...(o.actl === 'after' ? [actl] : []),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Header-only WebP with a VP8X chunk (animation flag on request) and an optional ANIM chunk. */
function webpHeader(w: number, h: number, o: { animFlag?: boolean; animChunk?: boolean } = {}): Uint8Array {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = o.animFlag ? 0x02 : 0;
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const c = (type: string, data: Buffer) => {
    const hd = Buffer.alloc(8);
    hd.write(type, 0, 'latin1');
    hd.writeUInt32LE(data.length, 4);
    return Buffer.concat([hd, data]);
  };
  const body = Buffer.concat([Buffer.from('WEBP'), c('VP8X', vp8x), ...(o.animChunk ? [c('ANIM', Buffer.alloc(6))] : [])]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([riff, body]));
}

/** Real encoder output (ffmpeg libwebp_anim / apng, 8x8, 3 frames), the same fixtures as the proxy's tests. */
const REAL_ANIMATED_WEBP = new Uint8Array(Buffer.from('UklGRqIBAABXRUJQVlA4WAoAAAACAAAABwAABwAAQU5JTQYAAAD/////AABBTk1GnAAAAAAAAAAAAAcAAAcAAGQAAAJWUDgghAAAAJACAJ0BKggACAACADQlsAJ0MoA6QApUpcrXQxZgAP7xvH4Mzb5PUl9i8SYs9LsFD/mLNfTXj+3K+k/E8uCJ8vCnQEvw9SdXs9lPAjJ3odwBPlSj/8dnY7CkJkH77/lRVtH//KBw/5UP9ORJax/E7974hFQGF5P97z3xQ9bdz/mhn0gAAEFOTUZkAAAAAAAAAwAABwAAAQAAZAAAAFZQOCBMAAAAtAEAnQEqCAACAAAANCWoAnQA3RhbgAD+yoWP83519G14feGmtTgG//8oNL/lQ//8sB//+UGl/yof3yz/n5opj//aRCWn+aKY/ioAAEFOTUZmAAAAAAAAAwAABwAAAQAAZAAAAFZQOCBOAAAAdAIAnQEqCAACAAAANCWoAnSSAPIAyQAFDu5OuAD+4l4n4H9b/ksNvr34AAj/5QbD/5UP/7Jn/lBsP/lQ/eXaXM5P/+4E+2czk/1IAAAA', 'base64'));
const REAL_APNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAADAAAAAM7tusAAAAAaZmNUTAAAAAAAAAAIAAAACAAAAAAAAAAAAAEACgAA8k66YgAAADlJREFUeJxjYGBg+A/G/8HUfzDrP5gDkvgPJv6jsBggNIoEDFBJAsQ+wFAPohxAjrL/3wCi9uOUAADpnlKu0JPIDwAAABpmY1RMAAAAAQAAAAgAAAACAAAAAAAAAAYAAQAKAABt4hiaAAAAKWZkQVQAAAACeJxj+C/J8P8mQ9p/Bob/kQzP/jOo/Z/J8P8/wzIGXBIATsAX6dfSYXUAAAAaZmNUTAAAAAMAAAAIAAAAAgAAAAAAAAAGAAEACgAAgHTLcwAAAClmZEFUAAAABHicY/hvzPD/M4PPfwaG/8UMZ/4z8PzfzPD/P0MPAy4JAFOgF+lfJQRNAAAAAElFTkSuQmCC', 'base64'));

/** Baseline JPEG header: SOI, an APP0, SOF0 (h, w). */
function jpegHeader(w: number, h: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x01, 0x01, 0x11, 0x00,
  ]);
}

describe('avatarImage (the proxy rules, read from the header)', () => {
  it('needs the full 8-byte PNG signature, as the proxy does', () => {
    const good = pngHeader(4, 4);
    expect(sniffAvatarImage(good)).toBe('png');
    // Same first 4 bytes, a broken tail (a text-mode transfer turns \r\n into \n): not a PNG.
    for (const i of [4, 5, 6, 7]) {
      const bad = good.slice();
      bad[i] ^= 0xff;
      expect(sniffAvatarImage(bad)).toBeNull();
      expect(imageFacts(bad)).toBeNull();
    }
    expect(sniffAvatarImage(good.slice(0, 7))).toBeNull();
  });

  it('reads PNG, JPEG and WebP sizes', () => {
    expect(imageFacts(pngHeader(37, 5))).toEqual({ mime: 'image/png', width: 37, height: 5, animated: false });
    expect(imageFacts(jpegHeader(33, 7))).toEqual({ mime: 'image/jpeg', width: 33, height: 7, animated: false });
    expect(imageFacts(webpHeader(5000, 20))).toMatchObject({ width: 5000, height: 20, animated: false });
  });

  it('refuses APNG and animated WebP, including real encoder output', () => {
    expect(avatarImageProblem(pngHeader(2, 2, { actl: 'before' }), MAX_TEXTURE_SIDE)).toBe('animated_image');
    expect(avatarImageProblem(pngHeader(2, 2, { actl: 'after' }), MAX_TEXTURE_SIDE)).toBe('animated_image');
    expect(avatarImageProblem(webpHeader(4, 4, { animFlag: true }), MAX_TEXTURE_SIDE)).toBe('animated_image');
    expect(avatarImageProblem(webpHeader(4, 4, { animChunk: true }), MAX_TEXTURE_SIDE)).toBe('animated_image');
    expect(imageFacts(REAL_ANIMATED_WEBP)).toEqual({ mime: 'image/webp', width: 8, height: 8, animated: true });
    expect(imageFacts(REAL_APNG)).toEqual({ mime: 'image/png', width: 8, height: 8, animated: true });
  });

  it('caps the side (8192 textures, 4096 portraits) and refuses a broken header', () => {
    expect(avatarImageProblem(pngHeader(MAX_PORTRAIT_SIDE, 1), MAX_PORTRAIT_SIDE)).toBeNull();
    expect(avatarImageProblem(pngHeader(MAX_PORTRAIT_SIDE + 1, 1), MAX_PORTRAIT_SIDE)).toBe('image_too_large');
    expect(avatarImageProblem(pngHeader(MAX_PORTRAIT_SIDE + 1, 1), MAX_TEXTURE_SIDE)).toBeNull();
    expect(avatarImageProblem(webpHeader(1, MAX_TEXTURE_SIDE + 1), MAX_TEXTURE_SIDE)).toBe('image_too_large');
    expect(avatarImageProblem(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), 4096)).toBe('bad_image');
    expect(avatarImageProblem(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 4096)).toBe('bad_image');
    expect(avatarImageProblem(new Uint8Array([1, 2, 3]), 4096)).toBe('bad_image');
  });
});
