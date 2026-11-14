/**
 * KTANE bomb sheet (261115): what the expert companion has written down about
 * the bomb in front of the player. The companion fills it through its own
 * bomb_notes() tool (src/main/ktane/ktanePrompts.ts); the app never parses the
 * player's words into it. It rides every turn as a short note at the end of
 * the prompt, because a voice call only sends the last few transcript rows and
 * a long bomb outlives them (serial number, batteries, Memory stages).
 *
 * Pure and shared: main applies tool calls with it, the renderer shows the
 * same object in the panel, and the eval harness uses it unchanged.
 */

export interface KtaneIndicator {
  label: string;
  lit: boolean;
}

export interface KtaneSheet {
  /** Bomb number in this session (1-based). */
  bomb: number;
  serial: string | null;
  batteries: number | null;
  /** null = not asked yet; [] = the player said there are none. */
  indicators: KtaneIndicator[] | null;
  ports: string[] | null;
  strikes: number;
  /** The module being worked on now (free text, the companion's own name for it). */
  module: string | null;
  /** Stage notes for the current module (Memory stages, wire counts, Simon flashes). */
  memo: string | null;
  /** Modules finished on this bomb, in order. */
  solved: string[];
}

export interface KtaneSessionTotals {
  bombs: number;
  defused: number;
  exploded: number;
  modulesSolved: number;
  strikes: number;
}

export function emptySheet(bomb = 1): KtaneSheet {
  return { bomb, serial: null, batteries: null, indicators: null, ports: null, strikes: 0, module: null, memo: null, solved: [] };
}

/** The bomb_notes() input, as the model sends it (every field optional). */
export interface BombNotesInput {
  serial?: unknown;
  batteries?: unknown;
  indicators?: unknown;
  ports?: unknown;
  strikes?: unknown;
  module?: unknown;
  memo?: unknown;
  solved?: unknown;
  bomb?: unknown;
}

export type BombOutcome = 'new' | 'defused' | 'exploded';

export interface ApplyResult {
  sheet: KtaneSheet;
  /** What changed, for the tool_result and analytics (field names only). */
  changed: string[];
  /** A bomb ended or a new one began in this call. */
  outcome: BombOutcome | null;
  /** A module was marked solved in this call. */
  solvedModule: string | null;
}

const MAX_TEXT = 240;
// The memo also carries a maze route traced square by square.
const MAX_MEMO = 600;

function cleanText(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function cleanInt(v: unknown, lo: number, hi: number): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i < lo || i > hi ? null : i;
}

/** "lit FRK", "FRK lit", "unlit CAR", {label, lit}. Unknown shapes are dropped. */
function cleanIndicators(v: unknown): KtaneIndicator[] | null {
  if (!Array.isArray(v)) return null;
  const out: KtaneIndicator[] = [];
  for (const item of v.slice(0, 12)) {
    if (item && typeof item === 'object') {
      const o = item as { label?: unknown; lit?: unknown };
      const label = cleanText(o.label, 3);
      if (label && /^[A-Za-z]{3}$/.test(label)) out.push({ label: label.toUpperCase(), lit: o.lit === true || o.lit === 'true' });
      continue;
    }
    if (typeof item !== 'string') continue;
    const words = item.toUpperCase().split(/[\s,:-]+/).filter(Boolean);
    const label = words.find((w) => /^[A-Z]{3}$/.test(w) && w !== 'OFF' && w !== 'LIT');
    if (!label) continue;
    const lit = words.includes('LIT') && !words.includes('UNLIT');
    out.push({ label, lit });
  }
  return out;
}

function cleanPorts(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .map((p) => cleanText(p, 24))
    .filter((p): p is string => !!p)
    .slice(0, 12);
}

/** Apply one bomb_notes() call. Pure; never throws on bad input. */
export function applyBombNotes(prev: KtaneSheet, input: BombNotesInput): ApplyResult {
  let sheet: KtaneSheet = { ...prev, solved: [...prev.solved] };
  const changed: string[] = [];
  let outcome: BombOutcome | null = null;
  let solvedModule: string | null = null;

  const bomb = typeof input.bomb === 'string' ? input.bomb.toLowerCase() : null;
  if (bomb === 'defused' || bomb === 'exploded') {
    outcome = bomb;
    changed.push('bomb');
  } else if (bomb === 'new') {
    // A fresh bomb: everything about the old one is gone.
    outcome = 'new';
    sheet = emptySheet(prev.bomb + 1);
    changed.push('bomb');
  }

  const serial = cleanText(input.serial, 12);
  if (serial) {
    sheet.serial = serial.toUpperCase().replace(/\s+/g, '');
    changed.push('serial');
  }
  const batteries = cleanInt(input.batteries, 0, 20);
  if (batteries !== null) {
    sheet.batteries = batteries;
    changed.push('batteries');
  }
  const indicators = cleanIndicators(input.indicators);
  if (indicators) {
    sheet.indicators = indicators;
    changed.push('indicators');
  }
  const ports = cleanPorts(input.ports);
  if (ports) {
    sheet.ports = ports;
    changed.push('ports');
  }
  const strikes = cleanInt(input.strikes, 0, 9);
  if (strikes !== null) {
    sheet.strikes = strikes;
    changed.push('strikes');
  }
  const module = cleanText(input.module, 40);
  if (module && module.toLowerCase() !== (sheet.module ?? '').toLowerCase()) {
    // Moving to another module drops the old module's stage notes.
    sheet.module = module.toLowerCase();
    sheet.memo = null;
    changed.push('module');
  }
  if (input.memo !== undefined) {
    sheet.memo = cleanText(input.memo, MAX_MEMO);
    changed.push('memo');
  }
  if (input.solved === true || input.solved === 'true') {
    solvedModule = sheet.module ?? 'module';
    sheet.solved.push(solvedModule);
    sheet.module = null;
    sheet.memo = null;
    changed.push('solved');
  }
  return { sheet, changed, outcome, solvedModule };
}

function yesNoUnknown<T>(v: T | null, render: (v: T) => string): string {
  return v === null ? 'not asked yet' : render(v);
}

/** The per-turn note: the companion's own notes, read back to it. */
export function renderSheetNote(s: KtaneSheet): string {
  const serial = s.serial
    ? `${s.serial} (last digit ${lastDigit(s.serial) ?? '?'}, ${/[AEIOU]/.test(s.serial) ? 'has a vowel' : 'no vowel'})`
    : 'not asked yet';
  const lines = [
    `[your bomb notes, bomb ${s.bomb}] serial: ${serial}. batteries: ${yesNoUnknown(s.batteries, String)}. ` +
      `indicators: ${yesNoUnknown(s.indicators, (l) => (l.length ? l.map((i) => `${i.lit ? 'lit' : 'unlit'} ${i.label}`).join(', ') : 'none'))}. ` +
      `ports: ${yesNoUnknown(s.ports, (p) => (p.length ? p.join(', ') : 'none'))}. strikes: ${s.strikes}.`,
    `working on: ${s.module ?? 'nothing yet'}${s.memo ? `. your notes: ${s.memo}` : ''}. solved: ${s.solved.length ? s.solved.join(', ') : 'none'}.`,
  ];
  return lines.join('\n');
}

export function lastDigit(serial: string): number | null {
  const d = serial.match(/\d(?=\D*$)/);
  return d ? Number(d[0]) : null;
}
