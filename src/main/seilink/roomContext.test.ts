import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  LOOK_TOOL,
  devRoomSource,
  lookAtRoom,
  lookResultContent,
  placeSentence,
  roomForSurface,
  roomPromptLine,
  setGameSurfaceProbe,
  setRoomSource,
  type RoomContext,
} from './roomContext';
import { renderRoomImage, ROOM_LOOK_WIDTH } from './roomRender';

const FIXTURE = path.join(__dirname, '__fixtures__', 'room-pack', 'room.json');
const NO_CHANGE = () => () => {};
const NOON = new Date(2026, 10, 4, 12, 0);
const NIGHT = new Date(2026, 10, 4, 23, 0);
const DAWN = new Date(2026, 10, 4, 6, 0);
const EVENING = new Date(2026, 10, 4, 18, 0);

type SharpLike = (input?: unknown, opts?: Record<string, unknown>) => {
  png(): { toBuffer(): Promise<Buffer> };
  raw(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> };
  metadata(): Promise<{ width?: number; height?: number; format?: string }>;
};
let sharp: SharpLike;

function fixtureRoom(): RoomContext {
  return devRoomSource(FIXTURE)!.getRoom('any') as RoomContext;
}

beforeAll(() => {
  const req = createRequire(import.meta.url);
  sharp = req(req.resolve('sharp', { paths: [path.dirname(req.resolve('img2skin/package.json'))] })) as SharpLike;
});

afterEach(() => {
  setRoomSource(null);
  setGameSurfaceProbe(null);
});

describe('room line', () => {
  it('names the place and the time of day', () => {
    const room = fixtureRoom();
    room.state.time = 'auto';
    expect(roomPromptLine(room, { now: NIGHT, includeTime: true })).toBe("You're in your bedroom. It's night.");
    expect(roomPromptLine(room, { now: NOON, includeTime: true })).toBe("You're in your bedroom. It's daytime.");
    expect(roomPromptLine(room, { now: DAWN, includeTime: true })).toBe("You're in your bedroom. It's dawn.");
    expect(roomPromptLine(room, { now: EVENING, includeTime: true })).toBe("You're in your bedroom. It's dusk.");
  });

  it('leaves an auto time of day out when asked (the call keeps it in the clock stamp)', () => {
    const room = fixtureRoom();
    room.state.time = 'auto';
    expect(roomPromptLine(room, { now: NIGHT, includeTime: false })).toBe("You're in your bedroom.");
  });

  it('keeps a pinned time that matches the clock, drops one that does not', () => {
    const room = fixtureRoom();
    room.state.time = 'night';
    expect(roomPromptLine(room, { now: NIGHT, includeTime: false })).toBe("You're in your bedroom. It's night.");
    expect(roomPromptLine(room, { now: NOON, includeTime: true })).toBe("You're in your bedroom.");
  });

  it('uses "at" for a place that starts with an article, and plain text only', () => {
    expect(placeSentence('a campfire in the forest')).toBe("You're at a campfire in the forest.");
    expect(placeSentence('your gaming room')).toBe("You're in your gaming room.");
    expect(placeSentence('your\nroom‮')).toBe("You're in your room.");
    expect(placeSentence('')).toBe("You're in your room.");
  });

  it('is short and has no em dash', () => {
    const line = roomPromptLine(fixtureRoom(), { now: NIGHT, includeTime: true });
    expect(line).not.toContain('—');
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(8);
  });
});

describe('roomForSurface', () => {
  it('is null with no source (production until the host registers one)', async () => {
    expect(await roomForSurface('c1', { inGame: false })).toBeNull();
  });

  it('returns the room on a non-game surface', async () => {
    setRoomSource(devRoomSource(FIXTURE));
    const room = await roomForSurface('c1', { inGame: false });
    expect(room?.manifest.place).toBe('your bedroom');
  });

  it('is null in a bot game and on chess / Draw! / Backseat', async () => {
    setRoomSource(devRoomSource(FIXTURE));
    expect(await roomForSurface('c1', { inGame: true })).toBeNull();
    setGameSurfaceProbe((id) => id === 'c1');
    expect(await roomForSurface('c1', { inGame: false })).toBeNull();
    expect(await roomForSurface('c2', { inGame: false })).not.toBeNull();
  });

  it('is null when the companion has no room, the source throws, or the room is malformed', async () => {
    setRoomSource({ getRoom: () => null, onChange: NO_CHANGE });
    expect(await roomForSurface('c1', { inGame: false })).toBeNull();
    setRoomSource({
      getRoom: () => {
        throw new Error('boom');
      },
      onChange: NO_CHANGE,
    });
    expect(await roomForSurface('c1', { inGame: false })).toBeNull();
    setRoomSource({ getRoom: async () => ({ manifest: { format: 'nope' }, state: {}, packDir: '/x' }) as unknown as RoomContext, onChange: NO_CHANGE });
    expect(await roomForSurface('c1', { inGame: false })).toBeNull();
  });
});

describe('look()', () => {
  it('has no arguments and says it is her own room', () => {
    expect(LOOK_TOOL.name).toBe('look');
    expect(LOOK_TOOL.input_schema).toEqual({ type: 'object', properties: {}, required: [] });
    expect(LOOK_TOOL.description).toContain('your own room');
    expect(LOOK_TOOL.description).toContain("not the player's screen");
  });

  it('returns the list and a jpeg picture', async () => {
    const look = await lookAtRoom(fixtureRoom(), { vision: 'yes', now: NIGHT });
    expect(look.text).toContain('your bedroom');
    expect(look.text).toContain('lit for night');
    expect(look.text).toContain('purple curtains, bed, floor lamp, round rug, desk chair, Sei 2026 trophy, potted plant');
    expect(look.text).toContain('without you in it');
    expect(look.image?.mediaType).toBe('image/jpeg');
    expect(look.image?.width).toBe(ROOM_LOOK_WIDTH);
    const content = lookResultContent([{ type: 'tool_result', tool_use_id: 'tu1', content: look.text }], [look.image!]);
    expect(content.map((b) => b.type)).toEqual(['tool_result', 'image']);
    const img = content[1] as { source: { type: string; media_type: string; data: string } };
    expect(img.source.type).toBe('base64');
    expect(img.source.media_type).toBe('image/jpeg');
    expect(Buffer.from(img.source.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('sends the list only when the model cannot see', async () => {
    const look = await lookAtRoom(fixtureRoom(), { vision: 'no', now: NIGHT });
    expect(look.image).toBeNull();
    expect(look.text).toContain('Sei 2026 trophy');
    expect(look.text).toContain('cannot see pictures');
  });

  it('still answers with the list when the render fails', async () => {
    const room = fixtureRoom();
    room.manifest = { ...room.manifest, canvas: [0, 0] };
    const look = await lookAtRoom(room, { vision: 'yes', now: NIGHT });
    expect(look.text).toContain('Sei 2026 trophy');
  });
});

describe('renderRoomImage', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('is 1024 wide at the canvas aspect, and she is not in it', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sei-room-'));
    // A pure red stand-in for her avatar. The renderer must never draw it.
    const redPng = path.join(dir, 'avatar.png');
    await sharp({ create: { width: 400, height: 1100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
      .png()
      .toBuffer()
      .then((b) => import('node:fs/promises').then((fs) => fs.writeFile(redPng, b)));
    const room = fixtureRoom();
    room.state.avatar = { kind: 'live2d', modelPath: redPng };

    const img = await renderRoomImage(room, { now: NIGHT });
    expect(img.width).toBe(1024);
    expect(img.height).toBe(576);
    const meta = await sharp(img.data).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([1024, 576]);
    expect(img.data.length).toBeLessThan(200_000);

    const { data, info } = await sharp(img.data).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // Where she would sit (manifest.avatar x 1280, chest height) the chair shows.
    const [r, g, b] = px(Math.round((1280 / 2560) * 1024), Math.round((950 / 1440) * 576));
    expect(g).toBeGreaterThan(130);
    expect(r).toBeLessThan(60);
    expect(b).toBeLessThan(60);
    // And nothing anywhere is her red.
    let red = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] > 200 && data[i + 1] < 40 && data[i + 2] < 40) red++;
    }
    expect(red).toBe(0);
  });

  it('tints through the mask and follows the time of day', async () => {
    const room = fixtureRoom();
    const sample = async (now: Date) => {
      const img = await renderRoomImage(room, { now });
      const { data, info } = await sharp(img.data).raw().toBuffer({ resolveWithObject: true });
      const at = (x: number, y: number) => {
        const i = (Math.round((y / 1440) * info.height) * info.width + Math.round((x / 2560) * info.width)) * info.channels;
        return [data[i], data[i + 1], data[i + 2]];
      };
      return { curtain: at(1780, 500), sky: at(1900, 700) };
    };
    room.state.time = 'auto';
    const night = await sample(NIGHT);
    const day = await sample(NOON);
    // Curtains: grey art x purple tint (#7b4fc9) = purple, blue over red.
    expect(night.curtain[2]).toBeGreaterThan(night.curtain[0]);
    expect(night.curtain[1]).toBeLessThan(night.curtain[2] - 40);
    // Sky through the window: dark at night, light at noon.
    expect(night.sky[2]).toBeLessThan(90);
    expect(day.sky[2]).toBeGreaterThan(200);
  });
});
