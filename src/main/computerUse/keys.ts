/**
 * 260925 backseat act: key-name normalization, model side -> helper side.
 *
 * HELPER_KEYS must match KEY_CODES in native/mac-input/main.swift (the CI
 * smoke test prints the helper's list). Models write keys the xdotool way
 * ("ctrl+c", "Return", "Page_Down", "super") because that is what most
 * computer-use training data uses, so the aliases below accept that and the
 * browser (KeyboardEvent.key) spellings.
 */

export const HELPER_MODIFIERS = ['cmd', 'shift', 'alt', 'ctrl', 'fn'] as const;
export type HelperModifier = (typeof HELPER_MODIFIERS)[number];

export const HELPER_KEYS: readonly string[] = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  '=', '-', ']', '[', "'", ';', '\\', ',', '/', '.', '`',
  'return', 'tab', 'space', 'backspace', 'escape', 'kp_enter',
  'cmd', 'shift', 'capslock', 'alt', 'ctrl', 'fn',
  ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`),
  'home', 'pageup', 'delete', 'end', 'pagedown', 'left', 'right', 'down', 'up',
];

const KEY_SET = new Set(HELPER_KEYS);

const ALIASES: Record<string, string> = {
  enter: 'return',
  ret: 'return',
  esc: 'escape',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  option: 'alt',
  opt: 'alt',
  control: 'ctrl',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  page_up: 'pageup',
  page_down: 'pagedown',
  prior: 'pageup',
  next: 'pagedown',
  back_space: 'backspace',
  bksp: 'backspace',
  del: 'delete',
  forwarddelete: 'delete',
  spacebar: 'space',
  ' ': 'space',
  caps_lock: 'capslock',
  kp_return: 'kp_enter',
  minus: '-',
  equal: '=',
  equals: '=',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  apostrophe: "'",
  quote: "'",
  grave: '`',
  bracketleft: '[',
  bracketright: ']',
};

/** One key name -> the helper's canonical name, or null when unknown. */
export function normalizeKey(name: string): string | null {
  if (name === ' ') return 'space';
  let k = name.trim().toLowerCase();
  if (!k) return null;
  k = k.replace(/^(left|right|l|r)_?(shift|ctrl|control|alt|option|cmd|command|meta|super)$/, '$2');
  if (KEY_SET.has(k)) return k;
  const a = ALIASES[k] ?? ALIASES[k.replace(/[\s-]/g, '_')];
  return a && KEY_SET.has(a) ? a : null;
}

export function isModifier(k: string): k is HelperModifier {
  return (HELPER_MODIFIERS as readonly string[]).includes(k);
}

/**
 * "ctrl+shift+t" / "cmd+c" / "Return" -> { key, modifiers }. The last part is
 * the key, every earlier part must be a modifier. A lone modifier ("shift")
 * is a key of its own with no modifiers. Returns an error string on anything
 * it cannot map, so the tool_result can tell the model which part was wrong.
 */
export function parseCombo(combo: string): { key: string; modifiers: HelperModifier[] } | { error: string } {
  const raw = combo.trim();
  if (!raw) return { error: 'empty key' };
  // "+" alone, or ending in "++", means the plus key.
  const parts = raw === '+' ? ['+'] : raw.split(/\+(?!$)/).map((p) => p.trim());
  const keyPart = parts[parts.length - 1]!;
  const key = normalizeKey(keyPart);
  if (!key) return { error: `unknown key "${keyPart}"` };
  const modifiers: HelperModifier[] = [];
  for (const p of parts.slice(0, -1)) {
    const m = normalizeKey(p);
    if (!m || !isModifier(m)) return { error: `"${p}" is not a modifier` };
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  return { key, modifiers };
}
