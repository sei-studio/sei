/**
 * Stardew Valley companion appearance (260921): the farmer-customization
 * knobs a companion is drawn with, the same ones the game's new-farm
 * character creator offers (gender, skin, hair + color, eyes, shirt, pants +
 * color, accessory).
 *
 * The values come from ONE LLM call per character
 * (src/main/games/stardew/appearance.ts) that translates the character's
 * description into these knobs. The model cannot see the sprite sheets, so
 * the LEGENDS below are what makes its choice mean anything: every allowed
 * index carries a short description of what it looks like, and an index with
 * no description is not allowed. The legends were written from the game's own
 * sheets (Stardew 1.6.15: Characters/Farmer/hairstyles + hairstyles2, shirts,
 * pants, accessories, skinColors, unpacked and viewed on the farmer body).
 *
 * Ranges verified against the 1.6.15 assemblies and data:
 *   skin       0..23           Farmer.changeSkinColor wraps outside it
 *   hair       0..55, 100..122 hairstyles sheet (56) + Data/HairData (23)
 *   shirt      "1000".."1111"  the Data/Shirts rows with
 *                              CanChooseDuringCharacterCustomization (112)
 *   pants      "0".."3"        the Data/Pants rows with the same flag
 *   accessory  -1..29          Farmer.changeAccessory resets outside it;
 *                              0..5 are facial hair, tinted with the hair color
 * The mod clamps against the GAME's ranges, not these curated subsets, so a
 * legend can grow without a mod rebuild.
 */
import { z } from 'zod';

export interface LegendRow {
  id: number;
  look: string;
}

/** Hairstyles. `hair` on the wire is the game's hairstyle index. */
export const STARDEW_HAIR_LEGEND: readonly LegendRow[] = [
  { id: 0, look: 'short, messy, swept to one side' },
  { id: 1, look: 'short and neat, parted, covers the ears' },
  { id: 3, look: 'big round afro' },
  { id: 5, look: 'shaved sides with a small tuft on top' },
  { id: 6, look: 'chin-length bob' },
  { id: 7, look: 'very short crop' },
  { id: 8, look: 'wild spikes in every direction' },
  { id: 9, look: 'short with a long fringe swept over one eye' },
  { id: 11, look: 'buzz cut' },
  { id: 12, look: 'long low ponytail down the back' },
  { id: 13, look: 'short, spiky and unkempt' },
  { id: 16, look: 'tall high ponytail' },
  { id: 17, look: 'shoulder-length with curled ends' },
  { id: 21, look: 'two high buns' },
  { id: 22, look: 'single bun on top of the head' },
  { id: 24, look: 'long and wavy, past the shoulders' },
  { id: 26, look: 'very long and straight, down to the waist' },
  { id: 27, look: 'medium bob with flipped-out ends' },
  { id: 28, look: 'mid-height ponytail' },
  { id: 30, look: 'short low twin tails' },
  { id: 33, look: 'long twin braids' },
  { id: 34, look: 'medium twin pigtails' },
  { id: 35, look: 'high side ponytail' },
  { id: 37, look: 'short fluffy twin pigtails worn high' },
  { id: 38, look: 'round bob with a headband' },
  { id: 39, look: 'long and straight with a headband' },
  { id: 40, look: 'big voluminous curls' },
  { id: 47, look: 'plain straight shoulder-length' },
  { id: 48, look: 'messy layered shoulder-length' },
  { id: 52, look: 'bald' },
  { id: 100, look: 'long and straight with full bangs' },
  { id: 101, look: 'long, thick and curly' },
  { id: 102, look: 'very long and straight, no bangs' },
  { id: 103, look: 'low ponytail worn over one shoulder' },
  { id: 104, look: 'one long braid down the back' },
  { id: 105, look: 'long hair swept over one shoulder' },
  { id: 107, look: 'fluffy chin-length bob' },
  { id: 108, look: 'short and tousled' },
  { id: 110, look: 'long and straight with a side part' },
  { id: 115, look: 'long and straight with a centre part, to mid-back' },
  { id: 118, look: 'long, voluminous and wavy' },
  { id: 120, look: 'long and layered' },
];

/** Skin tones (index into the game's 24-row skin palette). */
export const STARDEW_SKIN_LEGEND: readonly LegendRow[] = [
  { id: 0, look: 'light peach' },
  { id: 1, look: 'tan' },
  { id: 2, look: 'light tan' },
  { id: 3, look: 'fair' },
  { id: 4, look: 'medium brown' },
  { id: 5, look: 'brown' },
  { id: 6, look: 'deep warm brown' },
  { id: 7, look: 'golden tan' },
  { id: 8, look: 'olive brown' },
  { id: 9, look: 'fair with a pink cast' },
  { id: 10, look: 'pale, cool and greyish' },
  { id: 11, look: 'warm tan' },
  { id: 12, look: 'pale ivory' },
  { id: 13, look: 'rosy pink' },
  { id: 14, look: 'dark brown, the darkest natural tone' },
  { id: 15, look: 'tan with a red cast' },
  { id: 16, look: 'blue (non-human)' },
  { id: 17, look: 'green (non-human)' },
  { id: 18, look: 'red (non-human)' },
  { id: 19, look: 'purple (non-human)' },
  { id: 20, look: 'golden yellow (non-human)' },
  { id: 21, look: 'grey-white (non-human, undead, stone, robot)' },
  { id: 22, look: 'very fair, warm' },
  { id: 23, look: 'very fair, the lightest natural tone' },
];

/** Shirts. `shirt` on the wire is the number; the game's item id is its string form. */
export const STARDEW_SHIRT_LEGEND: readonly LegendRow[] = [
  { id: 1000, look: 'blue overalls over a red shirt' },
  { id: 1001, look: 'brown-orange button shirt' },
  { id: 1002, look: 'mint green blouse with a white collar' },
  { id: 1003, look: 'plain dark shirt' },
  { id: 1004, look: 'black shirt with a skull' },
  { id: 1005, look: 'plain light blue shirt' },
  { id: 1006, look: 'cream shirt with tan stripes' },
  { id: 1007, look: 'green overalls over a blue shirt' },
  { id: 1008, look: 'yellow shirt with a zigzag stripe' },
  { id: 1009, look: 'plain aquamarine shirt' },
  { id: 1010, look: 'black suit jacket, white shirt, tie' },
  { id: 1011, look: 'green shirt with a belt' },
  { id: 1012, look: 'lime green striped shirt' },
  { id: 1013, look: 'red and cream striped shirt' },
  { id: 1014, look: 'black shirt with a skeleton ribcage' },
  { id: 1015, look: 'orange shirt' },
  { id: 1016, look: 'dark blue shirt with stars' },
  { id: 1017, look: 'green shirt with suspenders' },
  { id: 1018, look: 'brown jacket' },
  { id: 1019, look: 'white sailor shirt with a navy collar' },
  { id: 1020, look: 'green vest' },
  { id: 1021, look: 'yellow and green shirt' },
  { id: 1022, look: 'red button shirt' },
  { id: 1023, look: 'green button shirt' },
  { id: 1024, look: 'light blue button shirt' },
  { id: 1025, look: 'navy button shirt with gold buttons' },
  { id: 1026, look: 'pale teal striped shirt' },
  { id: 1027, look: 'pink striped shirt' },
  { id: 1028, look: 'black shirt with a pink heart' },
  { id: 1029, look: 'beige work shirt' },
  { id: 1030, look: 'brown jacket over a grey shirt' },
  { id: 1032, look: 'red tunic with a gold belt' },
  { id: 1033, look: 'plain green shirt' },
  { id: 1034, look: 'green tunic with a gold belt' },
  { id: 1035, look: 'fancy red blouse with gold buttons' },
  { id: 1036, look: 'pink blouse' },
  { id: 1037, look: 'plain grey shirt' },
  { id: 1038, look: 'plain white shirt' },
  { id: 1039, look: 'retro rainbow striped shirt' },
  { id: 1040, look: 'purple blouse' },
  { id: 1041, look: 'plain white blouse' },
  { id: 1043, look: 'plain royal blue shirt' },
  { id: 1044, look: 'icy light blue shirt' },
  { id: 1045, look: 'plain red-orange shirt' },
  { id: 1046, look: 'plain bright purple shirt' },
  { id: 1048, look: 'plain charcoal shirt' },
  { id: 1049, look: 'pale pink blouse' },
  { id: 1051, look: 'hot pink top' },
  { id: 1053, look: 'black shirt with a green stripe' },
  { id: 1058, look: 'plain periwinkle shirt' },
  { id: 1059, look: 'plain golden yellow shirt' },
  { id: 1061, look: 'orange checked shirt' },
  { id: 1062, look: 'white and blue sailor top' },
  { id: 1069, look: 'plain emerald green shirt' },
  { id: 1070, look: 'plain magenta shirt' },
  { id: 1073, look: 'plain dark purple shirt' },
  { id: 1080, look: 'silver-grey shirt' },
  { id: 1082, look: 'plain dark navy shirt' },
  { id: 1084, look: 'plain black shirt' },
  { id: 1085, look: 'red jacket' },
  { id: 1087, look: 'white shirt with a red bow' },
  { id: 1090, look: 'plain dark grey shirt' },
  { id: 1097, look: 'grey button shirt' },
  { id: 1098, look: 'black uniform jacket with gold buttons' },
  { id: 1100, look: 'light blue denim shirt' },
  { id: 1101, look: 'black top with a white collar' },
  { id: 1108, look: 'plain burnt orange shirt' },
  { id: 1109, look: 'purple button shirt' },
  { id: 1110, look: 'orange button shirt' },
  { id: 1111, look: 'olive green button shirt' },
];

/** Pants (the character creator's four). All are tinted with `pantsColor`. */
export const STARDEW_PANTS_LEGEND: readonly LegendRow[] = [
  { id: 0, look: 'long pants' },
  { id: 1, look: 'shorts' },
  { id: 2, look: 'long skirt' },
  { id: 3, look: 'short skirt' },
];

/** Accessories. -1 is none. 0..5 are facial hair and take the hair color. */
export const STARDEW_ACCESSORY_LEGEND: readonly LegendRow[] = [
  { id: -1, look: 'none' },
  { id: 0, look: 'full beard' },
  { id: 1, look: 'mustache' },
  { id: 3, look: 'goatee' },
  { id: 5, look: 'big bushy beard' },
  { id: 6, look: 'gold earrings' },
  { id: 7, look: 'green earrings' },
  { id: 8, look: 'glasses with blue lenses' },
  { id: 9, look: 'red lipstick' },
  { id: 10, look: 'round glasses' },
  { id: 13, look: 'brown-framed tinted glasses' },
  { id: 15, look: 'dark sunglasses' },
  { id: 16, look: 'blue neckerchief' },
];

const idsOf = (rows: readonly LegendRow[]): number[] => rows.map((r) => r.id);
const oneOf = (rows: readonly LegendRow[]) => {
  const allowed = new Set(idsOf(rows));
  return z.number().int().refine((n) => allowed.has(n), { message: 'not in the legend' });
};

/** "#rrggbb", lower-cased. */
export const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((s) => s.toLowerCase());

/**
 * The persisted + wire shape. Closed: every field only admits a value with a
 * known look, so a stored appearance is always drawable.
 */
export const StardewAppearanceSchema = z.object({
  gender: z.enum(['female', 'male']),
  skin: oneOf(STARDEW_SKIN_LEGEND),
  hair: oneOf(STARDEW_HAIR_LEGEND),
  hairColor: HexColorSchema,
  eyeColor: HexColorSchema,
  shirt: oneOf(STARDEW_SHIRT_LEGEND),
  pants: oneOf(STARDEW_PANTS_LEGEND),
  pantsColor: HexColorSchema,
  accessory: oneOf(STARDEW_ACCESSORY_LEGEND),
});
export type StardewAppearance = z.infer<typeof StardewAppearanceSchema>;

/** Neutral look used when nothing could be derived (brown hair, plain shirt, blue pants). */
export const STARDEW_DEFAULT_APPEARANCE: StardewAppearance = {
  gender: 'female',
  skin: 0,
  hair: 47,
  hairColor: '#7a4a2a',
  eyeColor: '#5a3a1e',
  shirt: 1005,
  pants: 0,
  pantsColor: '#2e55b7',
  accessory: -1,
};

/**
 * Build an appearance from untrusted input FIELD BY FIELD: a field that does
 * not validate takes the default instead of sinking the whole result (a model
 * that gets eight knobs right and invents a shirt number still produced a
 * usable look). `salvaged` counts the fields that validated, so a caller can
 * tell a real derivation from an all-default one.
 */
export function coerceStardewAppearance(input: unknown): { appearance: StardewAppearance; salvaged: number } {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const shape = StardewAppearanceSchema.shape;
  const out: Record<string, unknown> = { ...STARDEW_DEFAULT_APPEARANCE };
  let salvaged = 0;
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    let raw = src[key];
    // Models hand numbers back as strings often enough to be worth a retry.
    if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) && key !== 'hairColor' && key !== 'eyeColor' && key !== 'pantsColor') {
      raw = Number(raw.trim());
    }
    if (typeof raw === 'string') raw = raw.trim().toLowerCase();
    const parsed = (shape[key] as z.ZodTypeAny).safeParse(raw);
    if (parsed.success) {
      out[key] = parsed.data;
      salvaged++;
    }
  }
  return { appearance: out as StardewAppearance, salvaged };
}

const renderRows = (rows: readonly LegendRow[]): string => rows.map((r) => `${r.id} ${r.look}`).join('; ');

/** The legends as the tool's per-field descriptions (model-facing). */
export const STARDEW_APPEARANCE_LEGENDS = {
  skin: renderRows(STARDEW_SKIN_LEGEND),
  hair: renderRows(STARDEW_HAIR_LEGEND),
  shirt: renderRows(STARDEW_SHIRT_LEGEND),
  pants: renderRows(STARDEW_PANTS_LEGEND),
  accessory: renderRows(STARDEW_ACCESSORY_LEGEND),
} as const;
