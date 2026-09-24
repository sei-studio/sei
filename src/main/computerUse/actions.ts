/**
 * 260925 backseat act: the action vocabulary. Basic controls only: move,
 * click (left/right), double_click, drag, scroll, key combo, hold a key for
 * ms, type text, wait ms. Plus `choose` (pick a numbered option from the
 * perception list), `say`, `done` and `give_up`.
 *
 * CUSTOM tools, not Anthropic's computer_toolset: the toolset is
 * Anthropic-only and not on Haiku 4.5, and a custom schema runs on every
 * provider the LLM layer supports, BYOK included.
 *
 * Coordinates are IMAGE PX of the latest frame. Every coordinate is CLAMPED
 * into the frame, and the frame is exactly the shared window or display, so
 * nothing the model writes can land outside what the player shared.
 */
import { z } from 'zod';
import type { LlmToolDef } from '../llm/types';
import { imageToGlobal } from './geometry';
import { parseCombo, normalizeKey, type HelperModifier } from './keys';
import type { Frame, Point } from './types';

const coord = z.number().finite();
const xy = { x: coord, y: coord };

export const ActionSchemas = {
  move: z.object(xy),
  click: z.object({ ...xy, button: z.enum(['left', 'right']).default('left') }),
  double_click: z.object(xy),
  drag: z.object({ from_x: coord, from_y: coord, to_x: coord, to_y: coord }),
  scroll: z.object({
    ...xy,
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(15).default(3),
  }),
  key: z.object({ keys: z.string().min(1).max(60) }),
  hold_key: z.object({ key: z.string().min(1).max(30), ms: z.number().int().min(20).max(10_000) }),
  type: z.object({ text: z.string().min(1).max(500) }),
  wait: z.object({ ms: z.number().int().min(50).max(5000) }),
  choose: z.object({ index: z.number().int().min(0) }),
  say: z.object({ text: z.string().min(1).max(300) }),
  done: z.object({ summary: z.string().max(300).default('') }),
  give_up: z.object({ reason: z.string().max(300).default('') }),
} as const;

export type ActionName = keyof typeof ActionSchemas;
export type ParsedAction = { [K in ActionName]: { name: K; input: z.infer<(typeof ActionSchemas)[K]> } }[ActionName];
export type InputAction = Exclude<ParsedAction, { name: 'choose' | 'say' | 'done' | 'give_up' }>;

/** Actions that post input (scope check + helper call). `wait` goes to the helper but touches nothing. */
export const INPUT_ACTIONS = new Set<ActionName>(['move', 'click', 'double_click', 'drag', 'scroll', 'key', 'hold_key', 'type']);

const XY_PROPS = {
  x: { type: 'number', description: 'Pixels from the left edge of the latest screenshot.' },
  y: { type: 'number', description: 'Pixels from the top edge of the latest screenshot.' },
};

/** The tool array for the vision chooser, the same list every step (prompt cache). */
export const ACT_TOOLS: LlmToolDef[] = [
  {
    name: 'click',
    description: 'Move the pointer to a point on the latest screenshot and click there.',
    input_schema: {
      type: 'object',
      properties: { ...XY_PROPS, button: { type: 'string', enum: ['left', 'right'], description: 'Defaults to left.' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'double_click',
    description: 'Double click a point on the latest screenshot.',
    input_schema: { type: 'object', properties: XY_PROPS, required: ['x', 'y'] },
  },
  {
    name: 'move',
    description: 'Move the pointer without clicking, for hover menus and tooltips.',
    input_schema: { type: 'object', properties: XY_PROPS, required: ['x', 'y'] },
  },
  {
    name: 'drag',
    description: 'Press the left button at one point, move to another, and release.',
    input_schema: {
      type: 'object',
      properties: { from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll with the pointer over a point. Each unit is one wheel notch.',
    input_schema: {
      type: 'object',
      properties: {
        ...XY_PROPS,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', minimum: 1, maximum: 15, description: 'Defaults to 3.' },
      },
      required: ['x', 'y', 'direction'],
    },
  },
  {
    name: 'key',
    description: 'Press a key or shortcut, written like "return", "escape", "tab", "down", "cmd+c", "cmd+shift+t". This is a Mac: use cmd for shortcuts.',
    input_schema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] },
  },
  {
    name: 'hold_key',
    description: 'Hold one key down for some milliseconds, then release it. For movement keys in games.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, ms: { type: 'integer', minimum: 20, maximum: 10000 } },
      required: ['key', 'ms'],
    },
  },
  {
    name: 'type',
    description: 'Type text into whatever has keyboard focus, one field at a time. A newline at the very end presses Return. No tabs or other newlines: press those with key, as their own step.',
    input_schema: { type: 'object', properties: { text: { type: 'string', maxLength: 500 } }, required: ['text'] },
  },
  {
    name: 'wait',
    description: 'Wait some milliseconds for something on screen to finish before the next screenshot.',
    input_schema: { type: 'object', properties: { ms: { type: 'integer', minimum: 50, maximum: 5000 } }, required: ['ms'] },
  },
  {
    name: 'choose',
    description: 'Do one of the numbered options listed with this step, by its number. Use it when an option does exactly what you want; it is more precise than a click at pixel coordinates.',
    input_schema: { type: 'object', properties: { index: { type: 'integer', minimum: 0 } }, required: ['index'] },
  },
  {
    name: 'say',
    description: 'Say one short line out loud to the player, in your own voice. At most one per step.',
    input_schema: { type: 'object', properties: { text: { type: 'string', maxLength: 300 } }, required: ['text'] },
  },
  {
    name: 'done',
    description: 'The goal is achieved. Call this alone, after checking the screenshot shows it.',
    input_schema: { type: 'object', properties: { summary: { type: 'string', description: 'One line on what you did.' } } },
  },
  {
    name: 'give_up',
    description: 'Stop because the goal cannot be reached from here. Call this alone.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } } },
  },
];

/** Validate one tool call. */
export function parseAction(name: string, input: unknown): { ok: true; action: ParsedAction } | { ok: false; error: string } {
  if (!(name in ActionSchemas)) return { ok: false, error: `unknown tool ${name}` };
  const r = ActionSchemas[name as ActionName].safeParse(input ?? {});
  if (!r.success) {
    const f = r.error.flatten();
    const parts = [...f.formErrors, ...Object.entries(f.fieldErrors).map(([k, v]) => `${k}: ${(v ?? []).join(', ')}`)];
    return { ok: false, error: `invalid input: ${parts.join('; ')}` };
  }
  return { ok: true, action: { name, input: r.data } as ParsedAction };
}

/**
 * Shortcuts that are never sent, whatever the goal: quitting apps, force
 * quit, log out, lock, sleep, restart, shut down. They end or hide the thing
 * being worked on, or the whole session, and none is ever the way to finish a
 * task in a shared window.
 */
export function blockedCombo(key: string, mods: readonly string[]): string | null {
  const m = new Set(mods);
  const cmd = m.has('cmd');
  // cmd+q, cmd+shift+q (log out), cmd+alt+shift+q, ctrl+cmd+q (lock).
  if (cmd && key === 'q') return 'quitting apps, locking or logging out';
  // cmd+alt+escape and cmd+alt+shift+escape (force quit).
  if (cmd && m.has('alt') && key === 'escape') return 'force quit';
  // Power and eject combos: sleep, restart, shut down.
  if (key === 'power' || key === 'eject') return 'sleep, restart or shut down';
  // Launchers (Spotlight cmd+space, Finder search cmd+alt+space, Alfred,
  // Raycast and ChatGPT on alt+space). Their panels take keystrokes without
  // changing the frontmost app, so the scope check cannot see that the keys
  // left the shared window, and a launcher can open or run anything.
  if (key === 'space' && (cmd || m.has('alt'))) return 'opening a launcher outside the shared window';
  // Empty the Trash (with alt: without asking); in browsers, clear history.
  if (cmd && m.has('shift') && key === 'backspace') return 'emptying the Trash or clearing history';
  // ctrl+cmd+f is fullscreen and fine; ctrl+alt+cmd+anything else is left to scope.
  return null;
}

/** A command for the helper, in global points. */
export type HelperCommand =
  | { cmd: 'click'; x: number; y: number; button: string; count: number; modifiers: string[] }
  | { cmd: 'move'; x: number; y: number }
  | { cmd: 'drag'; from: [number, number]; to: [number, number]; durationMs: number }
  | { cmd: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { cmd: 'type'; text: string }
  | { cmd: 'key'; key: string; modifiers: string[]; repeat: number }
  | { cmd: 'hold'; key: string; ms: number }
  | { cmd: 'wait'; ms: number };

/** What an action will touch, for the scope check. */
export interface ActionTouch {
  /** Global points the pointer will go to. */
  points: Point[];
  /** Keyboard input (goes to the focused app). */
  keyboard: boolean;
  /** Text entry: refused when the focused element is a password field. */
  typing: boolean;
}

/**
 * Map an input action to a helper command through the frame the model saw.
 * Coordinates are clamped into the frame (so into the shared bounds).
 */
export function toHelperCommand(
  a: ParsedAction,
  frame: Pick<Frame, 'rect' | 'width' | 'height'>,
): { ok: true; command: HelperCommand; touch: ActionTouch } | { ok: false; error: string } {
  const pt = (x: number, y: number): Point => imageToGlobal({ x, y }, frame);
  const none: ActionTouch = { points: [], keyboard: false, typing: false };
  switch (a.name) {
    case 'click':
    case 'double_click': {
      const p = pt(a.input.x, a.input.y);
      const button = a.name === 'click' ? a.input.button : 'left';
      return {
        ok: true,
        command: { cmd: 'click', x: p.x, y: p.y, button, count: a.name === 'double_click' ? 2 : 1, modifiers: [] },
        touch: { ...none, points: [p] },
      };
    }
    case 'move': {
      const p = pt(a.input.x, a.input.y);
      return { ok: true, command: { cmd: 'move', x: p.x, y: p.y }, touch: { ...none, points: [p] } };
    }
    case 'drag': {
      const f = pt(a.input.from_x, a.input.from_y);
      const t = pt(a.input.to_x, a.input.to_y);
      return {
        ok: true,
        command: { cmd: 'drag', from: [f.x, f.y], to: [t.x, t.y], durationMs: 400 },
        touch: { ...none, points: [f, t] },
      };
    }
    case 'scroll': {
      const p = pt(a.input.x, a.input.y);
      // Helper wheel convention: positive dy is wheel UP (content moves down).
      const n = a.input.amount;
      const dy = a.input.direction === 'up' ? n : a.input.direction === 'down' ? -n : 0;
      const dx = a.input.direction === 'left' ? n : a.input.direction === 'right' ? -n : 0;
      return { ok: true, command: { cmd: 'scroll', x: p.x, y: p.y, dx, dy }, touch: { ...none, points: [p] } };
    }
    case 'type': {
      // The helper types a tab or newline as a real Tab or Return key, which
      // can move focus mid-text (Tab to the next field, Return to a password
      // page), past the one focus check the password guard runs before the
      // action. So one type fills one field: a newline is allowed only as the
      // last character, and tabs never.
      const body = a.input.text.replace(/\r?\n$/, '');
      if (/[\t\r\n]/.test(body)) {
        return { ok: false, error: 'type fills one field at a time: no tabs, and a newline only at the very end. Use the key tool for tab or return, as its own step' };
      }
      return { ok: true, command: { cmd: 'type', text: a.input.text }, touch: { ...none, keyboard: true, typing: true } };
    }
    case 'key': {
      const c = parseCombo(a.input.keys);
      if ('error' in c) return { ok: false, error: c.error };
      const why = blockedCombo(c.key, c.modifiers);
      if (why) return { ok: false, error: `refused: ${a.input.keys} is not allowed (${why})` };
      // A bare printable key is text entry too (password fields).
      const printable = c.modifiers.length === 0 && c.key.length === 1;
      return {
        ok: true,
        command: { cmd: 'key', key: c.key, modifiers: c.modifiers as HelperModifier[], repeat: 1 },
        touch: { ...none, keyboard: true, typing: printable || c.key === 'space' },
      };
    }
    case 'hold_key': {
      const k = normalizeKey(a.input.key);
      if (!k) return { ok: false, error: `unknown key "${a.input.key}"` };
      return {
        ok: true,
        command: { cmd: 'hold', key: k, ms: a.input.ms },
        touch: { ...none, keyboard: true, typing: k.length === 1 },
      };
    }
    case 'wait':
      return { ok: true, command: { cmd: 'wait', ms: a.input.ms }, touch: none };
    default:
      return { ok: false, error: `${a.name} is not an input action` };
  }
}

/** One-line description of an action, for history and logs. */
export function describeAction(a: ParsedAction): string {
  const i = a.input as Record<string, unknown>;
  switch (a.name) {
    case 'click':
      return `${i.button === 'right' ? 'right click' : 'click'} (${Math.round(i.x as number)}, ${Math.round(i.y as number)})`;
    case 'double_click':
    case 'move':
      return `${a.name.replace('_', ' ')} (${Math.round(i.x as number)}, ${Math.round(i.y as number)})`;
    case 'drag':
      return `drag (${Math.round(i.from_x as number)}, ${Math.round(i.from_y as number)}) to (${Math.round(i.to_x as number)}, ${Math.round(i.to_y as number)})`;
    case 'scroll':
      return `scroll ${i.direction} ${i.amount} at (${Math.round(i.x as number)}, ${Math.round(i.y as number)})`;
    case 'key':
      return `key ${i.keys}`;
    case 'hold_key':
      return `hold ${i.key} ${i.ms} ms`;
    case 'type':
      return `type "${String(i.text).slice(0, 40)}${String(i.text).length > 40 ? '...' : ''}"`;
    case 'wait':
      return `wait ${i.ms} ms`;
    default:
      return a.name;
  }
}
