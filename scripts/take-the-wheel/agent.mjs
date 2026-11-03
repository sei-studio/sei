// The decision step: one screenshot in, a PLAN line plus actions out.
// Anthropic computer toolset (computer_toolset_20260801) plus three pilot
// tools: move (keys held for exact milliseconds, optionally turning), look
// (relative camera turn) and done. Each step is a fresh single-turn request;
// continuity is carried by the plan line and a short action log, so the
// prompt never grows and the tools+system prefix stays cacheable.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';

// $ per million tokens: input, output, cache read, cache write (5 min).
export const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125 },
  'claude-sonnet-5': { in: 2.0, out: 10.0, cr: 0.20, cw: 2.5 },
};

export function costOf(model, u) {
  const p = PRICES[model];
  if (!p || !u) return 0;
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out
    + (u.cache_read_input_tokens || 0) * p.cr + (u.cache_creation_input_tokens || 0) * p.cw) / 1e6;
}

const PILOT_TOOLS = [
  {
    name: 'move',
    description: 'Hold one or more keys for an exact time in milliseconds, for walking and other held inputs in games. keys is a key or a combo such as "w", "w+a", "w+space", "s". Optional yaw and pitch (degrees) turn the camera while the keys are held; positive yaw turns right, positive pitch looks up. Walking speed in many 3D games is about 4 blocks or metres per second.',
    input_schema: {
      type: 'object',
      properties: {
        keys: { type: 'string' },
        ms: { type: 'integer', minimum: 50, maximum: 4000 },
        yaw: { type: 'number' },
        pitch: { type: 'number' },
      },
      required: ['keys', 'ms'],
    },
  },
  {
    name: 'look',
    description: 'Turn the camera in a 3D game where the mouse is captured. yaw in degrees, positive turns right; pitch in degrees, positive looks up. 90 is a quarter turn.',
    input_schema: {
      type: 'object',
      properties: { yaw: { type: 'number' }, pitch: { type: 'number' } },
    },
  },
  {
    name: 'done',
    description: 'Call when the task is complete, with one sentence on what you see that shows it.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
];

const SYSTEM = `You are playing a game on a computer for the player. Each turn you get a fresh screenshot of the whole screen (1024x576) and the task. Your actions run in order, then you get the next screenshot. Nothing else tells you what happened, so check the screenshot.

Start every reply with one line: PLAN: then what you have done so far, what you are doing now and what comes next, in under 40 words. This line is shown to you next turn, so keep in it anything you still need to remember. Then call tools.

Controls:
- In 3D games the mouse is usually captured and there is a crosshair in the middle. Then turn with look and walk with move. Clicks act at the crosshair and their coordinates are ignored. If the mouse is not captured, click the game once.
- move holds keys for an exact number of milliseconds and can turn at the same time. Use it for walking, jumping and any held key. hold_key only takes whole seconds.
- For menus and 2D games use the computer tools: left_click, key, type, scroll, left_click_drag and so on. Do not take screenshots; one comes every turn.
- Call done when the task is complete.`;

export function createAgent({ model = 'claude-haiku-5-5', mode = 'single', maxActions = 5 } = {}) {
  const apiKey = readFileSync(`${process.env.HOME}/.sei-dev/anthropic-test-key`, 'utf8').trim();
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60000 });
  const modeLine = mode === 'single'
    ? 'Take exactly one action this turn.'
    : `Take 1 to ${maxActions} actions this turn. They run back to back with no screenshot in between, so only chain actions whose result you can predict.`;

  return {
    model, mode,
    async step({ task, hint, plan, recent, stepNo, maxSteps, secondsLeft, pointerLocked, screenDelta, imageB64 }) {
      const lines = [
        `Task: ${task}`,
        hint ? `About the game: ${hint}` : '',
        `Turn ${stepNo} of at most ${maxSteps}, about ${Math.max(0, Math.round(secondsLeft))} seconds left.`,
        `Mouse captured by the game: ${pointerLocked ? 'yes' : 'no'}.`,
        `Your plan from last turn: ${plan || '(none yet)'}`,
        recent.length ? `Your last actions and their results:\n${recent.join('\n')}` : 'No actions yet.',
        screenDelta == null ? '' : `How much the screen changed since the last screenshot: ${screenDelta}%${screenDelta < 0.4 ? ' (almost nothing changed, so your last actions may have had no effect; if you were walking, something may be blocking you)' : ''}.`,
        modeLine,
      ].filter(Boolean);
      const body = {
        model,
        max_tokens: 600,
        thinking: { type: 'disabled' },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: [{ type: 'computer_toolset_20260801' }, ...PILOT_TOOLS],
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
          { type: 'text', text: lines.join('\n') },
        ] }],
      };
      const t0 = Date.now();
      const res = await client.messages.create(body);
      const latencyMs = Date.now() - t0;
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const m = /PLAN:\s*([^\n]+)/i.exec(text);
      const calls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, input: b.input || {} }));
      const limit = mode === 'single' ? 1 : maxActions;
      return {
        plan: m ? m[1].trim().slice(0, 400) : null,
        text: text.slice(0, 600),
        actions: calls.slice(0, limit),
        dropped: Math.max(0, calls.length - limit),
        usage: res.usage,
        cost: costOf(model, res.usage),
        latencyMs,
        stop: res.stop_reason,
      };
    },
  };
}
