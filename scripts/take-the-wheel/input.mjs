// Generic OS-level input on the private X display through xdotool, mapped
// from the computer toolset's member tools plus two pilot extras (look,
// timed holds). Nothing here knows which game is running; the one
// game-facing knob is `pxPerDegree` for relative look, which a real product
// would calibrate once per game (turn, compare two screenshots).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY_ALIASES = {
  enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', space: 'space', spacebar: 'space',
  tab: 'Tab', backspace: 'BackSpace', delete: 'Delete', del: 'Delete',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', super: 'super', cmd: 'super', meta: 'super',
  pageup: 'Prior', pagedown: 'Next', home: 'Home', end: 'End',
};

export function normalizeKey(k) {
  const t = String(k).trim();
  if (!t) return t;
  const a = KEY_ALIASES[t.toLowerCase()];
  if (a) return a;
  if (/^[A-Z]$/.test(t)) return t.toLowerCase(); // "W" means the w key, not shift+w
  if (/^f\d{1,2}$/i.test(t)) return t.toUpperCase();
  return t;
}
export function splitCombo(text) {
  return String(text).split('+').map(normalizeKey).filter(Boolean);
}

export function createInput({ display, pxPerDegree = 20, isPointerLocked = async () => false }) {
  const env = { ...process.env, DISPLAY: `:${display}` };
  const xdo = (...args) => pexec('xdotool', args, { env, timeout: 15000 });
  const held = new Set();

  async function withMods(text, fn) {
    const mods = text ? splitCombo(text) : [];
    for (const m of mods) await xdo('keydown', m);
    try { await fn(); } finally { for (const m of mods.reverse()) await xdo('keyup', m); }
  }
  async function moveTo(coord) {
    if (!coord) return;
    const [x, y] = coord.map((v) => Math.round(Number(v)));
    await xdo('mousemove', String(x), String(y));
  }
  async function clickAt(input, button, repeat = 1) {
    const locked = await isPointerLocked();
    // With the pointer captured (crosshair games) an absolute move would spin
    // the camera, so clicks act where the crosshair is.
    if (!locked) await moveTo(input.coordinate);
    await withMods(input.text, () => xdo('click', '--repeat', String(repeat), '--delay', '80', String(button)));
    return locked && input.coordinate ? 'OK (mouse is captured: clicked at the crosshair, coordinate ignored)' : 'OK';
  }
  async function relLook(yawDeg = 0, pitchDeg = 0, durationMs = 0) {
    let dx = Number(yawDeg) * pxPerDegree;
    let dy = -Number(pitchDeg) * pxPerDegree;
    // Measured in Minecraft Classic: 60 px chunks 12 ms apart lost up to 15% of a
    // turn; 20 px chunks at least 15 ms apart land within a few degrees.
    const CH = Number(process.env.TTW_LOOK_CHUNK || 20), GAP = Number(process.env.TTW_LOOK_GAP || 15);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / CH));
    const per = Math.max(GAP, durationMs > 0 ? durationMs / steps : 0);
    let sx = 0, sy = 0;
    for (let i = 1; i <= steps; i++) {
      const tx = Math.round((dx * i) / steps), ty = Math.round((dy * i) / steps);
      await xdo('mousemove_relative', '--', String(tx - sx), String(ty - sy));
      sx = tx; sy = ty;
      await sleep(per);
    }
  }

  const handlers = {
    async key({ text, repeat = 1 }) {
      const n = Math.max(1, Math.min(100, Number(repeat) || 1));
      await xdo('key', '--repeat', String(n), '--delay', '90', splitCombo(text).join('+'));
      return 'OK';
    },
    async hold_key({ text, duration = 0.5 }) {
      const keys = splitCombo(text);
      const ms = Math.max(30, Math.min(10000, Number(duration) * 1000));
      for (const k of keys) { await xdo('keydown', k); held.add(k); }
      await sleep(ms);
      for (const k of keys.reverse()) { await xdo('keyup', k); held.delete(k); }
      return 'OK';
    },
    async type({ text }) { await xdo('type', '--delay', '40', '--', String(text)); return 'OK'; },
    left_click: (i) => clickAt(i, 1),
    right_click: (i) => clickAt(i, 3),
    middle_click: (i) => clickAt(i, 2),
    double_click: (i) => clickAt(i, 1, 2),
    triple_click: (i) => clickAt(i, 1, 3),
    async left_click_drag({ start_coordinate, coordinate, text }) {
      if (await isPointerLocked()) throw new Error('mouse is captured by the game; drag is not available');
      await moveTo(start_coordinate);
      await withMods(text, async () => {
        await xdo('mousedown', '1');
        const [x0, y0] = start_coordinate, [x1, y1] = coordinate;
        for (let i = 1; i <= 8; i++) {
          await xdo('mousemove', String(Math.round(x0 + ((x1 - x0) * i) / 8)), String(Math.round(y0 + ((y1 - y0) * i) / 8)));
          await sleep(25);
        }
        await xdo('mouseup', '1');
      });
      return 'OK';
    },
    async mouse_move({ coordinate }) {
      if (await isPointerLocked()) throw new Error('mouse is captured by the game; use look to turn');
      await moveTo(coordinate); return 'OK';
    },
    async left_mouse_down() { await xdo('mousedown', '1'); return 'OK'; },
    async left_mouse_up() { await xdo('mouseup', '1'); return 'OK'; },
    async scroll({ scroll_direction = 'down', scroll_amount = 3, coordinate, text }) {
      if (!(await isPointerLocked())) await moveTo(coordinate);
      const btn = { up: 4, down: 5, left: 6, right: 7 }[scroll_direction] ?? 5;
      await withMods(text, () => xdo('click', '--repeat', String(Math.max(1, Math.min(30, scroll_amount))), '--delay', '50', String(btn)));
      return 'OK';
    },
    async wait({ duration = 1 }) { await sleep(Math.max(0, Math.min(10, Number(duration))) * 1000); return 'OK'; },
    // Pilot extra: relative camera turn for pointer-lock games.
    async look({ yaw = 0, pitch = 0 }) { await relLook(yaw, pitch); return 'OK'; },
    // Pilot extra: keys held while the camera turns (walk and steer).
    async move({ keys = 'w', ms, duration, yaw = 0, pitch = 0 }) {
      const ks = splitCombo(keys);
      const want = ms != null ? Number(ms) : Number(duration ?? 0.8) * 1000;
      ms = Math.max(30, Math.min(4000, want || 800));
      for (const k of ks) { await xdo('keydown', k); held.add(k); }
      const t0 = Date.now();
      if (yaw || pitch) await relLook(yaw, pitch, ms);
      const rest = ms - (Date.now() - t0);
      if (rest > 0) await sleep(rest);
      for (const k of ks.reverse()) { await xdo('keyup', k); held.delete(k); }
      return 'OK';
    },
  };

  return {
    names: Object.keys(handlers),
    async run(name, input) {
      const h = handlers[name];
      if (!h) throw new Error(`unknown action ${name}`);
      return h(input || {});
    },
    async releaseAll() {
      for (const k of [...held]) { try { await xdo('keyup', k); } catch {} held.delete(k); }
      try { await xdo('mouseup', '1'); } catch {}
    },
  };
}

export async function screenshot(display, file) {
  await pexec('import', ['-window', 'root', '-quality', '82', file], { env: { ...process.env, DISPLAY: `:${display}` }, timeout: 15000 });
}
