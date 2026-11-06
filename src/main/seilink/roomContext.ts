/**
 * SeiLink, the AI side (261104): the companion knows the room she lives in.
 *
 * Shawn: "in all future prompts they should be aware of their environment.
 * the very basics, short prompt ... and they can call look() to see their
 * room ... and of course they themselves should be excluded from the pic".
 *
 * Two pieces, both only on the NON-GAME companion surfaces (typed chat, voice
 * calls, and the SeiLink desktop lines once the host calls these helpers) and
 * only when she HAS a room:
 *
 *   1. One short line in the status block, "You're in your bedroom. It's
 *      night." (~9 tokens). See roomPromptLine for where the time goes.
 *   2. look(): a picture of her room without her in it (roomRender.ts) plus
 *      describeRoom().things as a plain list.
 *
 * Inside a game (Minecraft, Stardew, DST through `inGame`; chess, Draw! and a
 * Backseat share through the game-surface probe) there is no room line and no
 * look(): she is in the game with the player, not at home.
 *
 * The room itself comes from a RoomSource (types.ts). The room store and pack
 * loader live on feat/seilink-host and register theirs with setRoomSource().
 * Until then the only source is the dev stub below (unpackaged +
 * SEI_SEILINK_ROOM), so production prompts and tools are unchanged.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { describeRoom, resolveRoomTime, roomTimeAt, SEILINK_ROOM_FORMAT, type RoomState } from '../../shared/seilinkRoom';
import { parseRoomManifest, sanitizeRoomState } from '../../shared/seilinkValidate';
import type { RoomContext, RoomSource } from './types';
import { renderRoomImage, type RoomImage } from './roomRender';
import { liveRoomFor } from './editorTogether';

export type { RoomContext, RoomSource } from './types';

// ── source + game probe (injected) ──────────────────────────────────────

let source: RoomSource | null = null;
let gameProbe: (characterId: string) => boolean = () => false;

/** The host registers its room store here. null = no rooms (the default). */
export function setRoomSource(next: RoomSource | null): void {
  source = next;
}

export function getRoomSource(): RoomSource | null {
  return source;
}

/**
 * True while the companion is on a game surface that is not a bot session
 * (chess, Draw!, a Backseat share). Wired in index.ts. Bot games arrive as
 * `inGame` on roomForSurface.
 */
export function setGameSurfaceProbe(probe: ((characterId: string) => boolean) | null): void {
  gameProbe = probe ?? (() => false);
}

function looksLikeRoom(ctx: unknown): ctx is RoomContext {
  const c = ctx as RoomContext | null;
  return Boolean(
    c &&
      c.manifest &&
      c.manifest.format === SEILINK_ROOM_FORMAT &&
      typeof c.manifest.place === 'string' &&
      Array.isArray(c.manifest.canvas) &&
      Array.isArray(c.manifest.components) &&
      c.state &&
      Array.isArray(c.state.items) &&
      typeof c.packDir === 'string',
  );
}

/**
 * Her room for a non-game surface turn, or null: no source, no room, a
 * malformed room, a source that threw, or she is in a game right now.
 */
export async function roomForSurface(characterId: string, opts: { inGame: boolean }): Promise<RoomContext | null> {
  if (opts.inGame || !source) return null;
  try {
    if (gameProbe(characterId)) return null;
  } catch {
    return null;
  }
  try {
    const ctx = await source.getRoom(characterId);
    if (!ctx) return null;
    if (!looksLikeRoom(ctx)) {
      console.warn(`[seilink] room for ${characterId.slice(0, 8)} is malformed, ignored`);
      return null;
    }
    // 261105 (T336): while the player has her room editor open, the room as it is there (unsaved).
    return liveRoomFor(characterId, ctx);
  } catch (err) {
    console.warn(`[seilink] room source failed for ${characterId.slice(0, 8)}: ${(err as Error).message}`);
    return null;
  }
}

// ── the prompt line ─────────────────────────────────────────────────────

/** Pack text reaches the prompt: one line, no control characters, bounded. */
export function plainRoomText(raw: string, max = 60): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max).trimEnd();
}

/** "You're in your bedroom." / "You're at a campfire in the forest." */
export function placeSentence(place: string): string {
  const p = plainRoomText(place) || 'your room';
  const at = /^(a|an)\s/i.test(p);
  return `You're ${at ? 'at' : 'in'} ${p}.`;
}

/**
 * The clock's time of day in plain words. The room art has one dusk frame for
 * both ends of the day, so the line says dawn before noon.
 */
export function timeSentence(now: Date): string {
  const t = roomTimeAt(now);
  if (t === 'day') return "It's daytime.";
  if (t === 'night') return "It's night.";
  return now.getHours() < 12 ? "It's dawn." : "It's dusk.";
}

/**
 * The room line for the status block.
 *
 * `includeTime` is false on a voice call whose room follows the clock: the
 * call's status block is cached and its clock rides after the last cache
 * breakpoint (clockInTail), so a time-of-day word here would re-write the
 * whole cached transcript at dusk and at night. The model reads the time of
 * day off that clock stamp instead. A room PINNED to one time never changes,
 * so its time word is safe in the cached block.
 *
 * A pinned time that disagrees with the clock (night art at noon) gets no
 * time word at all: the status block already says the real time, and the
 * look() result says how the room is lit.
 */
/** 261106: the plain first state (no room drawn yet). Model-facing, plain words. */
export const PLAIN_ROOM_LINE = "You're on the player's desktop on a plain background. Your room there is not set up yet.";

export function roomPromptLine(ctx: RoomContext, opts: { now?: Date; includeTime: boolean }): string {
  if (ctx.state.plain) return PLAIN_ROOM_LINE;
  const now = opts.now ?? new Date();
  const place = placeSentence(ctx.manifest.place);
  const pinned = ctx.state.time !== 'auto';
  if (!opts.includeTime && !pinned) return place;
  if (pinned && ctx.state.time !== roomTimeAt(now)) return place;
  return `${place} ${timeSentence(now)}`;
}

// ── look() ──────────────────────────────────────────────────────────────

/**
 * Offered on the same surfaces as the room line, only when she has a room.
 * No arguments: there is one room and one view of it. Plain description,
 * per the prompt style notes.
 */
export const LOOK_TOOL = {
  name: 'look',
  description:
    'Look around your own room, the place you are in right now. ' +
    'Returns a picture of your room and a list of what is in it. ' +
    "It shows your room only, not the player's screen or their surroundings.",
  input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
};

export const LOOK_TOOL_NAME = LOOK_TOOL.name;

export interface RoomLook {
  /** The tool_result text: place, how it is lit, and the things in it. */
  text: string;
  /** The picture, or null when the model cannot see or the render failed. */
  image: RoomImage | null;
}

const TIME_WORD: Record<string, string> = { day: 'daytime', dusk: 'dusk', night: 'night' };

/**
 * Run look(): render the room (when the model can see) and describe it. Never
 * throws: a failed render still answers with the list.
 */
export async function lookAtRoom(ctx: RoomContext, opts: { vision: 'yes' | 'no' | 'unknown'; now?: Date }): Promise<RoomLook> {
  // 261106: nothing to picture yet (no image tokens for a blank colour).
  if (ctx.state.plain) {
    return { text: 'No room yet: you are on a plain background on the player\'s desktop, with nothing around you. The player can set your room up with you.', image: null };
  }
  const now = opts.now ?? new Date();
  const d = describeRoom(ctx.manifest, ctx.state, now);
  const things = d.things.map((t) => plainRoomText(t, 40)).filter(Boolean);
  const lit = TIME_WORD[resolveRoomTime(ctx.state, now)] ?? 'daytime';
  const list = things.length ? things.join(', ') : 'nothing much yet';
  const head = `Your room: ${plainRoomText(d.place) || 'your room'}, lit for ${lit}. In it: ${list}.`;
  let image: RoomImage | null = null;
  let note: string;
  if (opts.vision === 'no') {
    note = 'You cannot see pictures right now, so this list is what you know about it.';
  } else {
    try {
      image = await renderRoomImage(ctx, { now });
      note = 'The picture shows your room right now, without you in it. It came to you, not to the player.';
    } catch (err) {
      console.warn(`[seilink] look() render failed: ${(err as Error).message}`);
      note = 'The picture did not load this time, so this list is what you know about it.';
    }
  }
  return { text: `${head} ${note}`, image };
}

/** The picture as an image block (see lookToolResult). */
export function roomImageBlock(image: RoomImage): Anthropic.Messages.ImageBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data.toString('base64') } };
}

/**
 * Where the picture rides. Measured in the 261104 probe (Haiku 5.5, n=10
 * look() turns each way): as a sibling block in the user message she read
 * it as something the player sent ("oh cool, you can see it!", 4 of 10),
 * and labelling it in text made her talk about the label. Inside the
 * tool_result, where Anthropic accepts image content, that went to 0 of 5.
 *
 * So `nested` (an Anthropic backend: cloud proxy or BYOK) puts the picture
 * inside the tool_result. Every other provider gets it as a sibling block
 * after the tool_results in the same user message: the OpenAI-compatible
 * mapper flattens tool_result content to a string (base64 as text), while
 * every mapper carries a sibling image (OpenAI-compatible, Gemini, Ollama,
 * the ChatGPT Responses wire). Draw!'s self-look uses the sibling shape.
 */
export function lookToolResult(
  toolUseId: string,
  look: RoomLook,
  opts: { nested: boolean; withImage?: boolean },
): { result: Anthropic.Messages.ToolResultBlockParam; sibling: RoomImage | null } {
  const image = opts.withImage === false ? null : look.image;
  if (image && opts.nested) {
    return {
      result: { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: look.text }, roomImageBlock(image)] },
      sibling: null,
    };
  }
  return { result: { type: 'tool_result', tool_use_id: toolUseId, content: look.text }, sibling: image };
}

/** A user message's content: the tool_results, then any sibling pictures. */
export function lookResultContent(
  toolResults: Anthropic.Messages.ToolResultBlockParam[],
  images: RoomImage[],
): Array<Anthropic.Messages.ToolResultBlockParam | Anthropic.Messages.ImageBlockParam> {
  return [...toolResults, ...images.map(roomImageBlock)];
}

// ── dev stub source ─────────────────────────────────────────────────────

interface DevRoomFile {
  /** Pack root (absolute, or relative to the JSON file). Holds manifest.json. */
  packDir: string;
  /** Room state inline, or a path (relative to the JSON file) to one. */
  state?: RoomState | string;
  /** Character ids that have this room; "*" or absent = every character. */
  characters?: string[] | '*';
}

/**
 * Dev-only room source: a JSON file naming a pack dir (with manifest.json)
 * and a room state. Read fresh on every call so it can be edited while the
 * app runs. Returns null (no source) when the path is empty.
 */
export function devRoomSource(jsonPath: string): RoomSource | null {
  const file = jsonPath.trim();
  if (!file) return null;
  const abs = path.resolve(file);
  const base = path.dirname(abs);
  return {
    getRoom(characterId: string): RoomContext | null {
      const cfg = JSON.parse(readFileSync(abs, 'utf8')) as DevRoomFile;
      if (Array.isArray(cfg.characters) && !cfg.characters.includes(characterId)) return null;
      const packDir = path.resolve(base, cfg.packDir);
      // The same validation the host's pack loader runs, so the stub cannot
      // feed the prompt or the renderer anything a real pack could not.
      const manifest = parseRoomManifest(JSON.parse(readFileSync(path.join(packDir, 'manifest.json'), 'utf8')));
      if (!manifest) throw new Error(`invalid room manifest in ${packDir}`);
      const rawState = typeof cfg.state === 'string' ? JSON.parse(readFileSync(path.resolve(base, cfg.state), 'utf8')) : cfg.state;
      const state = sanitizeRoomState(manifest, rawState ?? {});
      return { manifest, state, packDir };
    },
    // Read fresh every turn, so there is nothing to announce.
    onChange: () => () => {},
  };
}
