/**
 * Live2D parameter roles (261122, product call 261122: imported models that
 * do not blink, lip-sync or look at the cursor).
 *
 * The avatar views drive a few parameters by hand: the mouth (lip-sync), the
 * eyes and head (gaze) and, through the SDK's EyeBlink, the lids. They used
 * to write the Cubism STANDARD ids (ParamMouthOpenY, ParamEyeBallX, ...), and
 * import only added an EyeBlink group when the group was missing. Real models
 * name things their own way (an Italian model's mouth is `ParamBocca`,
 * "BoccaAperta"; Cubism 2 era exports use `PARAM_MOUTH_OPEN_Y`) and ship an
 * EyeBlink or LipSync group with no ids, so those models stood still.
 *
 * This module finds which parameter plays which role, per model, once:
 *   1. the model3.json groups the author declared (LipSync, EyeBlink);
 *   2. the standard id, when the model has it;
 *   3. the standard id written another way (`PARAM_EYE_BALL_X`);
 *   4. words in the id and its display name (cdi3.json), in several
 *      languages (mouth/Mund/bocca/boca/bouche/å£..., open/aperta/é–‹...),
 *      never a per-model table.
 * The parameter list comes from the moc3 itself (`readMoc3Parameters`, the
 * same table the Cubism Core reads, checked against the Core on the SDK's
 * sample models), else the cdi3 list. Main stores the result in the avatar
 * manifest (`params`); `paramOverrides` (nothing writes it yet) wins over it.
 *
 * Pure: shared by main (import, and a lazy heal of older stores) and the
 * renderer (the same resolver over the model's own files when a manifest has
 * no map).
 */

/** The parameters the views drive. */
export const LIVE2D_ROLES = [
  'mouthOpen',
  'eyeLOpen',
  'eyeROpen',
  'eyeBallX',
  'eyeBallY',
  'angleX',
  'angleY',
  'angleZ',
  'bodyAngleX',
  'breath',
] as const;
export type Live2DRole = (typeof LIVE2D_ROLES)[number];

/** The Cubism SDK's standard ids for each role. */
export const LIVE2D_STANDARD_IDS: Readonly<Record<Live2DRole, string>> = {
  mouthOpen: 'ParamMouthOpenY',
  eyeLOpen: 'ParamEyeLOpen',
  eyeROpen: 'ParamEyeROpen',
  eyeBallX: 'ParamEyeBallX',
  eyeBallY: 'ParamEyeBallY',
  angleX: 'ParamAngleX',
  angleY: 'ParamAngleY',
  angleZ: 'ParamAngleZ',
  bodyAngleX: 'ParamBodyAngleX',
  breath: 'ParamBreath',
};

/** Bump when the resolver gets better: stores resolved by an older one re-resolve on read. */
export const LIVE2D_RESOLVER_VERSION = 1;

/** One model parameter: its id, its display name (cdi3) and its range when known. */
export interface Live2DParamInfo {
  id: string;
  name?: string;
  min?: number;
  max?: number;
  def?: number;
}

/** What a model's parameters mean to the views (stored as AvatarManifest.params). */
export interface Live2DParamMap {
  /** LIVE2D_RESOLVER_VERSION that made it. */
  v: number;
  /** Role â†’ the model's parameter id. A missing role: the model has nothing for it. */
  roles: Partial<Record<Live2DRole, string>>;
  /** The ids the SDK's EyeBlink closes on a blink (empty: the model cannot blink). */
  blink: string[];
  /** Where the parameter list came from: the moc3, the cdi3 list, or nowhere (roles are then a guess). */
  source: 'moc' | 'cdi' | 'none';
}

/** A user's correction (AvatarManifest.paramOverrides): an id, or null to turn the role off. */
export type Live2DParamOverrides = Partial<Record<Live2DRole, string | null>>;

// â”€â”€ moc3 parameter table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Header size; the section offset table follows it. */
const MOC3_HEADER = 64;
/** Section offset table slots: [0] the count table, [50] parameter ids, then max, min, default values. */
const SEC_COUNTS = 0;
const SEC_PARAM_IDS = 50;
const SEC_PARAM_MAX = 51;
const SEC_PARAM_MIN = 52;
const SEC_PARAM_DEF = 53;
/** Count table slot of the parameter count (parts, deformers, warps, rotations, art meshes, parameters). */
const COUNT_PARAMS = 5;
/** Every id in a moc3 is a fixed 64-byte, NUL-terminated field. */
const MOC3_ID_BYTES = 64;
const MAX_PARAMS = 4096;

/**
 * The parameter table of a moc3 (ids with min, max and default), or null when
 * the bytes do not read as one. Every offset and value is checked, so a
 * format this does not know returns null instead of garbage.
 */
export function readMoc3Parameters(bytes: Uint8Array): Live2DParamInfo[] | null {
  try {
    if (bytes.byteLength < MOC3_HEADER + 4 * (SEC_PARAM_DEF + 1)) return null;
    if (bytes[0] !== 0x4d || bytes[1] !== 0x4f || bytes[2] !== 0x43 || bytes[3] !== 0x33) return null; // "MOC3"
    const version = bytes[4];
    if (version < 1 || version > 32) return null;
    const le = bytes[5] === 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = bytes.byteLength;
    const section = (i: number): number => view.getUint32(MOC3_HEADER + 4 * i, le);
    const counts = section(SEC_COUNTS);
    if (counts + 4 * (COUNT_PARAMS + 1) > size) return null;
    const n = view.getUint32(counts + 4 * COUNT_PARAMS, le);
    if (n > MAX_PARAMS) return null;
    const idsAt = section(SEC_PARAM_IDS);
    const maxAt = section(SEC_PARAM_MAX);
    const minAt = section(SEC_PARAM_MIN);
    const defAt = section(SEC_PARAM_DEF);
    if (idsAt + n * MOC3_ID_BYTES > size) return null;
    for (const at of [maxAt, minAt, defAt]) if (at + n * 4 > size) return null;
    const out: Live2DParamInfo[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let i = 0; i < n; i++) {
      const start = idsAt + i * MOC3_ID_BYTES;
      let end = start;
      while (end < start + MOC3_ID_BYTES && bytes[end] !== 0) end++;
      if (end === start || end === start + MOC3_ID_BYTES) return null;
      const id = decoder.decode(bytes.subarray(start, end));
      if (!/^[\x21-\x7e]+$/.test(id)) return null;
      const max = view.getFloat32(maxAt + 4 * i, le);
      const min = view.getFloat32(minAt + 4 * i, le);
      const def = view.getFloat32(defAt + 4 * i, le);
      if (![max, min, def].every(Number.isFinite) || min > max) return null;
      out.push({ id, min, max, def });
    }
    return out;
  } catch {
    return null;
  }
}

/** Display names from a cdi3.json (`Parameters[].Id/Name`), empty on anything else. */
export function readCdi3Names(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = (json as { Parameters?: unknown } | null)?.Parameters;
  if (!Array.isArray(list)) return out;
  for (const p of list) {
    const id = (p as { Id?: unknown })?.Id;
    const name = (p as { Name?: unknown })?.Name;
    if (typeof id === 'string' && id) out.set(id, typeof name === 'string' ? name : '');
  }
  return out;
}

/** The ids of a model3.json parameter group (`Groups[].Name`), empty when absent. */
export function groupIds(settings: unknown, name: string): string[] {
  const groups = (settings as { Groups?: unknown } | null)?.Groups;
  if (!Array.isArray(groups)) return [];
  const g = groups.find((x) => (x as { Target?: unknown; Name?: unknown })?.Name === name && (x as { Target?: unknown }).Target === 'Parameter') as
    | { Ids?: unknown }
    | undefined;
  return Array.isArray(g?.Ids) ? g.Ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

// â”€â”€ words â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Words matched at the start of a word of the id or display name (latin, Cyrillic, Thai...). */
type Words = { prefix: readonly string[]; cjk?: readonly string[] };

const W = {
  mouth: {
    prefix: ['mouth', 'mund', 'maul', 'bocca', 'boca', 'bouche', 'mond', 'usta', 'ust', 'Ñ€Ð¾Ñ‚', 'aÄŸÄ±z', 'agiz', 'mulut', 'miá»‡ng', 'mieng', 'à¸›à¸²à¸', 'kuchi'],
    cjk: ['å£', 'å˜´', 'ãã¡', 'ìž…'],
  },
  open: {
    prefix: ['open', 'offen', 'auf', 'apert', 'abiert', 'abert', 'ouvert', 'otwar', 'Ð¾Ñ‚ÐºÑ€', 'aÃ§Ä±', 'acik', 'buka', 'má»Ÿ', 'aperto', 'opening'],
    cjk: ['é–‹', 'å¼€', 'å¼µ', 'å¼ ', 'ì—´', 'ã‚ã‘', 'ã²ã‚‰ã'],
  },
  close: {
    prefix: ['close', 'shut', 'geschlossen', 'zu', 'chius', 'cerrad', 'fechad', 'ferm', 'zamkn', 'Ð·Ð°ÐºÑ€', 'kapal', 'tutup', 'nháº¯m'],
    cjk: ['é–‰', 'é—­', 'ë‹«', 'ê°'],
  },
  mouthNot: {
    prefix: ['form', 'shape', 'smile', 'grin', 'frown', 'pucker', 'tongue', 'teeth', 'tooth', 'cheek', 'corner', 'width', 'wide', 'forma', 'lÃ¤chel', 'sorris', 'sonris', 'sourire', 'ÑƒÐ»Ñ‹Ð±', 'zunge', 'lingua', 'lengua', 'dent', 'zÃ¤hn'],
    cjk: ['å½¢', 'å¤‰å½¢', 'ç¬‘', 'èˆŒ', 'æ­¯', 'ç‰™', 'è§’'],
  },
  eye: {
    prefix: ['eye', 'auge', 'occhi', 'occhio', 'ojo', 'olho', 'oeil', 'Å“il', 'yeux', 'oog', 'ogen', 'oko', 'oczy', 'Ð³Ð»Ð°Ð·', 'gÃ¶z', 'goz', 'mata', 'máº¯t', 'à¸•à¸²', 'me'],
    cjk: ['ç›®', 'çœ¼', 'ëˆˆ', 'çž³'],
  },
  ball: {
    prefix: ['ball', 'pupil', 'iris', 'pupill', 'pupila', 'pupille', 'Ð·Ñ€Ð°Ñ‡', 'bulbo', 'globo', 'augapfel', 'iride', 'medama', 'hitomi'],
    cjk: ['çž³', 'çœ¼çƒ', 'ç›®çŽ‰', 'é»’ç›®', 'ëˆˆë™ìž', 'ë™ê³µ', 'çœ¼ç '],
  },
  brow: {
    prefix: ['brow', 'eyebrow', 'augenbraue', 'braue', 'soprac', 'ceja', 'sobrancel', 'sourcil', 'Ð±Ñ€Ð¾Ð²', 'kaÅŸ', 'alis', 'mayu'],
    cjk: ['çœ‰', 'ëˆˆì¹'],
  },
  eyeNot: {
    prefix: ['smile', 'form', 'shape', 'lash', 'tear', 'highlight', 'light', 'shine', 'lÃ¤chel', 'sorris', 'sonris', 'sourire', 'ÑƒÐ»Ñ‹Ð±', 'wimper', 'lacrim', 'lÃ¡grim', 'larme'],
    cjk: ['ç¬‘', 'å½¢', 'å¤‰å½¢', 'æ¶™', 'ãƒã‚¤ãƒ©ã‚¤ãƒˆ', 'ç«'],
  },
  left: {
    prefix: ['left', 'links', 'sinistr', 'izquierd', 'esquerd', 'gauche', 'lev', 'Ð»ÐµÐ²', 'kiri', 'trÃ¡i', 'trai', 'hidari'],
    cjk: ['å·¦', 'ì™¼'],
  },
  right: {
    prefix: ['right', 'rechts', 'destr', 'derech', 'direit', 'droit', 'prav', 'Ð¿Ñ€Ð°Ð²', 'kanan', 'pháº£i', 'phai', 'migi'],
    cjk: ['å³', 'ì˜¤ë¥¸'],
  },
  head: {
    prefix: ['angle', 'head', 'face', 'kopf', 'gesicht', 'winkel', 'testa', 'viso', 'angolo', 'cabeza', 'cara', 'Ã¡ngulo', 'angulo', 'cabeÃ§', 'cabec', 'rosto', 'tÃªte', 'tete', 'visage', 'hoofd', 'gÅ‚ow', 'glow', 'Ð³Ð¾Ð»Ð¾Ð²', 'Ð»Ð¸Ñ†', 'ÑƒÐ³Ð¾Ð»', 'baÅŸ', 'bas', 'kepala', 'wajah', 'Ä‘áº§u', 'atama', 'kao'],
    cjk: ['è§’åº¦', 'é ­', 'å¤´', 'é¡”', 'è„¸', 'è‡‰', 'ë¨¸ë¦¬', 'ì–¼êµ´', 'ê³ ê°œ'],
  },
  body: {
    prefix: ['body', 'kÃ¶rper', 'korper', 'koerper', 'corpo', 'cuerpo', 'corps', 'lichaam', 'ciaÅ‚o', 'cialo', 'Ñ‚ÐµÐ»', 'Ñ‚ÑƒÐ»Ð¾Ð²Ð¸Ñ‰', 'vÃ¼cut', 'vucut', 'badan', 'tubuh', 'thÃ¢n', 'torso', 'karada'],
    cjk: ['ä½“', 'èº«ä½“', 'é«”', 'ëª¸', 'èƒ´'],
  },
  limb: {
    prefix: ['hair', 'haar', 'capell', 'pelo', 'cabel', 'cheveu', 'Ð²Ð¾Ð»Ð¾Ñ', 'arm', 'hand', 'leg', 'foot', 'tail', 'coda', 'ear', 'ohr', 'orecch', 'oreja', 'oreille', 'ribbon', 'skirt', 'cloth', 'braccio', 'brazo', 'bein', 'gamba', 'pierna', 'hat', 'hut', 'cappell', 'sombrero', 'chapeau', 'wing', 'flÃ¼gel', 'ali', 'shoulder', 'schulter', 'spalla', 'hombro'],
    cjk: ['é«ª', 'å‘', 'é«®', 'è…•', 'æ‰‹', 'è¶³', 'è„š', 'å°¾', 'è€³', 'å¸½', 'è‚©', 'è¢–', 'æœ', 'ë¨¸ë¦¬ì¹´ë½', 'íŒ”', 'ë‹¤ë¦¬', 'ê¼¬ë¦¬'],
  },
  breath: {
    prefix: ['breath', 'atem', 'atmung', 'respir', 'souffle', 'adem', 'oddech', 'Ð´Ñ‹Ñ…Ð°Ð½', 'nefes', 'napas', 'thá»Ÿ', 'tho', 'kokyu'],
    cjk: ['å‘¼å¸', 'ìˆ¨'],
  },
  axisX: { prefix: ['x', 'horizontal', 'yaw', 'turn', 'side'], cjk: ['å·¦å³', 'æ¨ª'] },
  axisY: { prefix: ['y', 'vertical', 'pitch', 'nod', 'updown'], cjk: ['ä¸Šä¸‹', 'ç¸¦'] },
  axisZ: { prefix: ['z', 'roll', 'tilt', 'lean'], cjk: ['å‚¾', 'æ–œ'] },
} as const satisfies Record<string, Words>;

/** The id and display name split into lower-case words ("ParamEyeLOpen" â†’ "param eye l open"). */
function wordsOf(p: Live2DParamInfo): string[] {
  const text = `${p.id} ${p.name ?? ''}`
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\d)/gu, '$1 $2')
    .replace(/(\d)(\p{L})/gu, '$1 $2');
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** One-letter and two-letter words only match whole; longer ones match as a word start. */
function has(words: readonly string[], raw: string, set: Words): boolean {
  for (const w of set.prefix) {
    if (w.length <= 2 ? words.includes(w) : words.some((x) => x.startsWith(w))) return true;
  }
  return !!set.cjk?.some((c) => raw.includes(c));
}

/** The standard id written another way: "PARAM_EYE_BALL_X" and "ParamEyeBallX" â†’ "eyeballx". */
function normId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^param/, '');
}

interface Cand {
  p: Live2DParamInfo;
  i: number;
  words: string[];
  raw: string;
}

/** A mouth or eye score at or above this had an "open" word. */
const OPEN_SCORE = 3;

/** A score for a parameter as `role` (â‰¤ 0: not it). */
function score(role: Live2DRole, c: Cand): number {
  const { words, raw } = c;
  const is = (set: Words): boolean => has(words, raw, set);
  const p = c.p;
  const ranged = p.min !== undefined && p.max !== undefined;
  if (ranged && !(p.max! > p.min!)) return 0;
  switch (role) {
    case 'mouthOpen': {
      if (!is(W.mouth)) return 0;
      const open = is(W.open);
      if (!open && (is(W.close) || is(W.mouthNot))) return 0;
      return 1 + (open ? OPEN_SCORE - 1 : 0) + (is(W.axisY) ? 0.5 : 0);
    }
    case 'eyeLOpen':
    case 'eyeROpen': {
      if (!is(W.eye) || is(W.ball) || is(W.brow) || is(W.mouth)) return 0;
      const open = is(W.open);
      if (!open && (is(W.close) || is(W.eyeNot))) return 0;
      // An eye-open parameter rests open: its default sits in the upper half of its range.
      if (ranged && p.def !== undefined && p.def < (p.min! + p.max!) / 2) return 0;
      const left = is(W.left);
      const right = is(W.right);
      if (left && right) return 0;
      if (role === 'eyeLOpen' ? right : left) return 0;
      return 1 + (open ? OPEN_SCORE - 1 : 0) + (left || right ? 0.5 : 0);
    }
    case 'eyeBallX':
    case 'eyeBallY': {
      if (!is(W.ball) || is(W.brow) || is(W.eyeNot) || is(W.limb)) return 0;
      const x = is(W.axisX);
      const y = is(W.axisY);
      if (role === 'eyeBallX' ? !x || y : !y || x) return 0;
      return 2 + (is(W.eye) ? 1 : 0);
    }
    case 'angleX':
    case 'angleY':
    case 'angleZ': {
      if (!is(W.head) || is(W.body) || is(W.eye) || is(W.brow) || is(W.mouth) || is(W.limb)) return 0;
      const ax = { angleX: W.axisX, angleY: W.axisY, angleZ: W.axisZ }[role];
      const others = [W.axisX, W.axisY, W.axisZ].filter((s) => s !== ax);
      if (!is(ax) || others.some((s) => is(s))) return 0;
      return 2;
    }
    case 'bodyAngleX': {
      if (!is(W.body) || is(W.limb) || !is(W.axisX) || is(W.axisY) || is(W.axisZ)) return 0;
      return 2;
    }
    case 'breath':
      return is(W.breath) ? 2 : 0;
  }
}

/** What the resolver reads from a model. */
export interface Live2DResolveInput {
  /** The model's parameters (moc3 table, else the cdi3 list), null when unknown. */
  params: Live2DParamInfo[] | null;
  /** cdi3 display names by id. */
  names?: ReadonlyMap<string, string>;
  /** model3.json `LipSync` and `EyeBlink` group ids, as written. */
  lipSync?: readonly string[];
  eyeBlink?: readonly string[];
  /** Where `params` came from. */
  source?: 'moc' | 'cdi';
}

/** Which parameter plays which role (see the file header for the order). */
export function resolveLive2DParams(input: Live2DResolveInput): Live2DParamMap {
  const lipSync = [...(input.lipSync ?? [])];
  const eyeBlink = [...(input.eyeBlink ?? [])];
  if (!input.params || input.params.length === 0) {
    // Nothing to check against: the author's groups, else the SDK's standard ids (the old behaviour).
    const roles: Partial<Record<Live2DRole, string>> = { ...LIVE2D_STANDARD_IDS };
    if (lipSync[0]) roles.mouthOpen = lipSync[0];
    return {
      v: LIVE2D_RESOLVER_VERSION,
      roles,
      blink: eyeBlink.length ? eyeBlink : [LIVE2D_STANDARD_IDS.eyeLOpen, LIVE2D_STANDARD_IDS.eyeROpen],
      source: 'none',
    };
  }
  const names = input.names ?? new Map<string, string>();
  const cands: Cand[] = input.params.map((p, i) => {
    const q = { ...p, name: p.name ?? names.get(p.id) };
    return { p: q, i, words: wordsOf(q), raw: `${q.id} ${q.name ?? ''}` };
  });
  const byId = new Map(cands.map((c) => [c.p.id, c]));
  const byNorm = new Map<string, Cand>();
  for (const c of cands) if (!byNorm.has(normId(c.p.id))) byNorm.set(normId(c.p.id), c);
  const used = new Set<string>();
  const roles: Partial<Record<Live2DRole, string>> = {};
  const take = (role: Live2DRole, id: string | undefined): boolean => {
    if (!id || used.has(id) || !byId.has(id)) return false;
    roles[role] = id;
    used.add(id);
    return true;
  };

  // 1. The author's groups.
  const blinkGroup = eyeBlink.filter((id) => byId.has(id));
  take('mouthOpen', lipSync.find((id) => byId.has(id)));
  if (blinkGroup.length === 2) {
    const [a, b] = blinkGroup.map((id) => byId.get(id)!);
    const aRight = has(a.words, a.raw, W.right) && !has(a.words, a.raw, W.left);
    const bLeft = has(b.words, b.raw, W.left) && !has(b.words, b.raw, W.right);
    const swap = aRight || bLeft;
    take('eyeLOpen', (swap ? b : a).p.id);
    take('eyeROpen', (swap ? a : b).p.id);
  } else if (blinkGroup.length === 1) {
    take('eyeLOpen', blinkGroup[0]);
  }
  // 2 and 3. The standard id, as written or written another way.
  for (const role of LIVE2D_ROLES) {
    if (roles[role]) continue;
    if (role === 'eyeROpen' && roles.eyeLOpen && blinkGroup.length === 1) continue;
    const std = LIVE2D_STANDARD_IDS[role];
    if (take(role, byId.has(std) ? std : undefined)) continue;
    take(role, byNorm.get(normId(std))?.p.id);
  }
  // 4. Words.
  for (const role of LIVE2D_ROLES) {
    if (roles[role]) continue;
    if (role === 'eyeROpen' && roles.eyeLOpen && blinkGroup.length === 1) continue;
    let best: Cand | null = null;
    let bestScore = 0;
    let count = 0;
    for (const c of cands) {
      if (used.has(c.p.id)) continue;
      const s = score(role, c);
      if (s > 0) count++;
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    // A mouth or an eye with no "open" word is only taken when it is the only
    // one ("mouth corners up" is not the mouth opening).
    const needsOpen = role === 'mouthOpen' || role === 'eyeLOpen' || role === 'eyeROpen';
    if (best && needsOpen && bestScore < OPEN_SCORE && count > 1) best = null;
    if (best) take(role, best.p.id);
  }

  const blink = blinkGroup.length ? blinkGroup : [roles.eyeLOpen, roles.eyeROpen].filter((id): id is string => !!id);
  return { v: LIVE2D_RESOLVER_VERSION, roles, blink, source: input.source ?? 'moc' };
}

/** What a model's own files say about its parameters (paths relative to the store). */
export interface Live2DModelFacts {
  /** The parameter list (moc3, else the cdi3 ids), null when neither reads. */
  params: Live2DParamInfo[] | null;
  source: 'moc' | 'cdi';
  names: Map<string, string>;
  lipSync: string[];
  eyeBlink: string[];
}

/** Resolve a model3.json ref against the entry's directory ('./' and empty segments dropped). */
export function live2dRefPath(entry: string, ref: string): string {
  const dir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '';
  return (dir ? `${dir}/${ref}` : ref)
    .split('/')
    .filter((s) => s && s !== '.')
    .join('/');
}

/** Read the facts from the entry model3.json, its moc3 and its cdi3.json; null without a readable entry. */
export function live2dModelFacts(
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  entry: string,
): Live2DModelFacts | null {
  const byPath = new Map(files.map((f) => [f.path, f.bytes]));
  const settingsBytes = byPath.get(entry);
  if (!settingsBytes) return null;
  type Settings = { FileReferences?: { Moc?: unknown; DisplayInfo?: unknown } } | null;
  let settings: Settings;
  try {
    settings = JSON.parse(new TextDecoder().decode(settingsBytes)) as Settings;
  } catch {
    return null;
  }
  const at = (ref: unknown): Uint8Array | undefined =>
    typeof ref === 'string' && ref ? byPath.get(live2dRefPath(entry, ref)) : undefined;
  const moc = at(settings?.FileReferences?.Moc);
  const cdiBytes = at(settings?.FileReferences?.DisplayInfo);
  let names = new Map<string, string>();
  if (cdiBytes) {
    try {
      names = readCdi3Names(JSON.parse(new TextDecoder().decode(cdiBytes)));
    } catch {
      /* no display names */
    }
  }
  const fromMoc = moc ? readMoc3Parameters(moc) : null;
  return {
    params: fromMoc ?? (names.size ? [...names.keys()].map((id) => ({ id })) : null),
    source: fromMoc ? 'moc' : 'cdi',
    names,
    lipSync: groupIds(settings, 'LipSync'),
    eyeBlink: groupIds(settings, 'EyeBlink'),
  };
}

/** The resolver over a model's own files (see live2dModelFacts). */
export function resolveLive2DParamsFromFiles(
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  entry: string,
): Live2DParamMap | null {
  const facts = live2dModelFacts(files, entry);
  return facts ? resolveLive2DParams(facts) : null;
}

/** The map a view uses: the stored one with the user's overrides on top. */
export function effectiveLive2DParams(
  map: Live2DParamMap,
  overrides?: Live2DParamOverrides | null,
): Live2DParamMap {
  if (!overrides) return map;
  const roles = { ...map.roles };
  for (const role of LIVE2D_ROLES) {
    const o = overrides[role];
    if (o === null) delete roles[role];
    else if (typeof o === 'string' && o) roles[role] = o;
  }
  const touchedEyes = 'eyeLOpen' in overrides || 'eyeROpen' in overrides;
  const blink = touchedEyes ? [roles.eyeLOpen, roles.eyeROpen].filter((id): id is string => !!id) : map.blink;
  return { ...map, roles, blink };
}

/**
 * Analytics shape (shape only): standard or remapped ids, and what the model
 * can do. `unknown` when its parameter list could not be read.
 */
export function live2dParamsShape(map: Live2DParamMap | null | undefined): {
  l2d_ids: 'standard' | 'remapped' | 'unknown';
  l2d_mouth: boolean;
  l2d_blink: boolean;
  l2d_gaze: 'eyes_head' | 'eyes' | 'head' | 'none';
} {
  if (!map || map.source === 'none') return { l2d_ids: 'unknown', l2d_mouth: true, l2d_blink: true, l2d_gaze: 'eyes_head' };
  const r = map.roles;
  const remapped = LIVE2D_ROLES.some((role) => r[role] !== undefined && r[role] !== LIVE2D_STANDARD_IDS[role]);
  const eyes = !!(r.eyeBallX || r.eyeBallY);
  const head = !!(r.angleX || r.angleY || r.angleZ || r.bodyAngleX);
  return {
    l2d_ids: remapped ? 'remapped' : 'standard',
    l2d_mouth: !!r.mouthOpen,
    l2d_blink: map.blink.length > 0,
    l2d_gaze: eyes && head ? 'eyes_head' : eyes ? 'eyes' : head ? 'head' : 'none',
  };
}

/**
 * Whether an .exp3.json changes anything (261122: a model shipped nine
 * expressions with no parameters, so every face the AI picked was a no-op).
 * `known`: the model's parameter ids, when known (an expression of ids the
 * model does not have does nothing either).
 */
export function expressionDoesSomething(json: unknown, known?: ReadonlySet<string> | null): boolean {
  const list = (json as { Parameters?: unknown } | null)?.Parameters;
  if (!Array.isArray(list)) return false;
  return list.some((e) => {
    const id = (e as { Id?: unknown })?.Id;
    const value = (e as { Value?: unknown })?.Value;
    const blend = (e as { Blend?: unknown })?.Blend;
    if (typeof id !== 'string' || !id || typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (known && known.size && !known.has(id)) return false;
    if ((blend === undefined || blend === 'Add') && value === 0) return false;
    if (blend === 'Multiply' && value === 1) return false;
    return true;
  });
}

/**
 * The analytics props for a shown Live2D avatar (shape only, never ids or
 * names): live2dParamsShape of the effective map, plus how many expressions
 * work and how many were left out as no-ops.
 */
export function live2dManifestShape(
  m: {
    params?: Live2DParamMap;
    paramOverrides?: Live2DParamOverrides;
    expressions?: readonly unknown[];
    unusableExpressions?: readonly string[];
  } | null | undefined,
): ReturnType<typeof live2dParamsShape> & { l2d_expr_usable: number; l2d_expr_noop: number } {
  const map = m?.params ? effectiveLive2DParams(m.params, m.paramOverrides) : null;
  return {
    ...live2dParamsShape(map),
    l2d_expr_usable: m?.expressions?.length ?? 0,
    l2d_expr_noop: m?.unusableExpressions?.length ?? 0,
  };
}




