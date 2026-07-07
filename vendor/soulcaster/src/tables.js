// Option tables for the Stage 1 randomizer.
//
// All randomness lives here, never in the LLM. LLM sampling is biased toward
// clichés (always the same handful of "cool" hair colors, the same tropes), so
// we roll concrete fields first and hand them to the model as fixed constraints.
//
// Every exported table is a plain array (uniform roll) or an array of
// { value, weight } entries (weighted roll). See rollFields in index.js.

// Companion age ranges. `timeless` rolls an APPARENT age of 18-35 but flags the
// character as an ancient being, so the LLM writes a real age into age_note.
export const AGE_RANGES = {
  'young-adult': { min: 18, max: 25 },
  adult: { min: 26, max: 35 },
  mature: { min: 36, max: 50 },
  elder: { min: 51, max: 75 },
  timeless: { min: 18, max: 35, apparent_only: true },
};

// Default when no companion_age_range is supplied.
export const DEFAULT_AGE_RANGE = { min: 18, max: 60 };

// Weighted: human is the common case, robot the rarest.
export const BACKGROUNDS = [
  { value: 'human', weight: 55 },
  { value: 'elf', weight: 20 },
  { value: 'beastkin', weight: 20 },
  { value: 'robot', weight: 15 },
];

// 22 options: natural spectrum first, then fantasy.
export const HAIR_COLORS = [
  // natural
  'black',
  'dark brown',
  'chestnut brown',
  'auburn',
  'ginger',
  'strawberry-blonde',
  'golden-blonde',
  'platinum blonde',
  'silver',
  'white',
  'ash-gray',
  // fantasy
  'sky blue',
  'teal',
  'mint-green',
  'lavender',
  'pink',
  'rose-red',
  'crimson',
  'violet',
  'black-to-red ombre',
  'blue-to-purple ombre',
  'pink-and-white two-tone',
];

// 13 options.
export const HAIR_STYLES = [
  'pixie cut',
  'short bob',
  'long straight',
  'long wavy',
  'twin-tails',
  'high ponytail',
  'side braid',
  'undercut',
  'messy short',
  'buzzed',
  'hime-cut',
  'curly shoulder-length',
  'top-knot',
];

// 14 options; heterochromia is a rare final roll (see rollEyeColor).
export const EYE_COLORS = [
  'dark brown',
  'hazel',
  'amber',
  'emerald green',
  'forest green',
  'sky blue',
  'ice blue',
  'steel gray',
  'violet',
  'crimson',
  'gold',
  'jet black',
  'pale pink',
  'turquoise',
];

// Rare special eye rolls, appended with low weight.
export const EYE_SPECIAL = ['heterochromia (one blue, one gold)', 'heterochromia (one green, one violet)'];

export const HEIGHTS = ['petite', 'short', 'average', 'tall', 'towering'];

export const BUILDS = ['slender', 'athletic', 'soft', 'curvy', 'stocky', 'lithe', 'broad'];

// Rolled only when gender === 'female'.
export const BUSTS = ['flat', 'small', 'medium', 'large'];

// 24 contrasting temperament words. Two distinct picks force personality
// diversity across generated characters.
export const PERSONALITY_SEEDS = [
  'stoic',
  'playful',
  'blunt',
  'gentle',
  'scheming',
  'earnest',
  'dry-witted',
  'brooding',
  'sunny',
  'meticulous',
  'reckless',
  'motherly',
  'aloof',
  'zealous',
  'mischievous',
  'melancholic',
  'fierce',
  'timid',
  'sardonic',
  'devoted',
  'restless',
  'serene',
  'proud',
  'curious',
];

// 16 quirky habits / obsessions.
export const QUIRK_SEEDS = [
  'hums old folk tunes while working',
  'collects smooth river stones',
  'never removes a pair of fingerless gloves',
  'talks to animals as if they answer',
  'obsessively tidies any space they enter',
  'refuses to walk on cracks',
  'names every tool and weapon',
  'sketches maps of places they visit',
  'hoards shiny trinkets like a magpie',
  'quotes proverbs at odd moments',
  'always knows which way is north',
  'sleeps with one eye metaphorically open, distrusts easily',
  'counts things under their breath',
  'keeps a running tally of favors owed',
  'cannot resist a dare',
  'brews a strange tea from foraged herbs',
];

// ---------------------------------------------------------------------------
// Relationship dynamics
// ---------------------------------------------------------------------------
//
// What the user is looking for in a companion, ranked once at onboarding
// (the client stores the ranking; the Nth unique cast passes the Nth ranked
// key here as `dynamic`). Each dynamic biases the Stage 1 personality roll —
// seed 1 is drawn from `seed_pool`, seed 2 stays a free roll from the full
// PERSONALITY_SEEDS list so two casts with the same dynamic still differ —
// and adds one Stage 2 prompt line so the sheet's tone, values, and
// player_dynamic serve the relationship. `label` is user-visible phrasing
// echoed into the prompt; `hint` is model-facing guidance only.
// Every seed_pool entry MUST exist in PERSONALITY_SEEDS (tests enforce it).
export const DYNAMICS = {
  'partner-in-crime': {
    label: 'a partner in crime',
    hint: 'co-conspirator energy: playful, scheme-hatching, always game for the questionable idea, and loyal when it goes sideways',
    seed_pool: ['mischievous', 'scheming', 'playful', 'reckless', 'sardonic'],
  },
  caretaker: {
    label: 'someone who looks after you',
    hint: 'warm and steady, protective without smothering; notices when their player is struggling and quietly handles things',
    seed_pool: ['motherly', 'devoted', 'gentle', 'earnest', 'serene'],
  },
  protege: {
    label: 'someone to look after',
    hint: 'a little green or unsure of themselves, eager to learn, openly grateful; grows in confidence at their player’s side',
    seed_pool: ['timid', 'curious', 'earnest', 'sunny', 'restless'],
  },
  'chill-friend': {
    label: 'a chill, easygoing friend',
    hint: 'low-drama, comfortable-silence company; unhurried, wry, easy to be around',
    seed_pool: ['serene', 'dry-witted', 'stoic', 'sunny', 'playful'],
  },
  challenger: {
    label: 'someone who pushes you',
    hint: 'sharp and competitive, holds their player to a high standard; teasing rivalry with real respect underneath',
    seed_pool: ['fierce', 'blunt', 'proud', 'zealous', 'sardonic'],
  },
};

// ---------------------------------------------------------------------------
// Combat archetypes
// ---------------------------------------------------------------------------
//
// Four combat stats — melee, ranged, defense, intelligence — are each rolled
// in [0,1] and quantized to 0.05 steps (see rollCombat in index.js). Gameplay
// meaning (consumed by the Minecraft bot adapter, not by this package):
//
//   melee         hit chance = 50% + melee*50% (melee is forgiving to land:
//                 0 -> 50% hit chance, 1 -> 100%).
//   ranged        bow/crossbow accuracy = ranged*100%. ALSO proxies draw
//                 strength: how fully the character draws the bow before
//                 releasing (draw fraction ~= 0.5 + ranged*0.5), so a weak
//                 archer releases early with less damage and arrow velocity.
//   defense       reaction speed + dodge chance + the discipline to
//                 proactively open distance to heal or draw a bow. Dodge
//                 chance ~= defense; reaction delay lerps from ~600ms (low
//                 defense) to ~100ms (high defense); disengage-to-heal
//                 propensity scales with it too.
//   intelligence  battle IQ / combo play. Melee crit attempts (jumping and
//                 striking mid-fall) chance ~= intelligence*0.5 per
//                 engagement. ALSO governs weapon-switch discipline
//                 (swapping melee<->bow at the correct range), the quality of
//                 retreat-to-heal timing, and strafe unpredictability.
//
// Independent uniform sampling of each stat would make every rolled character
// mid-pack (everything clusters near 0.5). Instead we roll a weighted
// archetype first — each archetype defines a [min,max] band per stat — so
// real builds emerge (a brawler is reliably melee-heavy and ranged-light, a
// tactician is reliably int-heavy, etc). Small per-species modifiers are
// applied afterward; they are kept small on purpose so the archetype, not the
// species, dominates the final shape.
//
// See scripts/combatStudy.js for the distribution this table produces.
export const COMBAT_ARCHETYPES = [
  {
    value: {
      label: 'brawler',
      melee: [0.55, 1.0],
      ranged: [0.0, 0.45],
      defense: [0.25, 0.75],
      intelligence: [0.15, 0.65],
    },
    weight: 20,
  },
  {
    value: {
      label: 'sharpshooter',
      melee: [0.05, 0.55],
      ranged: [0.55, 1.0],
      defense: [0.25, 0.75],
      intelligence: [0.35, 0.85],
    },
    weight: 15,
  },
  {
    value: {
      label: 'duelist',
      melee: [0.45, 0.9],
      ranged: [0.05, 0.55],
      defense: [0.55, 1.0],
      intelligence: [0.35, 0.85],
    },
    weight: 15,
  },
  {
    value: {
      label: 'tactician',
      melee: [0.25, 0.7],
      ranged: [0.25, 0.7],
      defense: [0.25, 0.7],
      intelligence: [0.65, 1.0],
    },
    weight: 10,
  },
  {
    value: {
      label: 'skirmisher',
      melee: [0.15, 0.6],
      ranged: [0.35, 0.8],
      defense: [0.45, 0.9],
      intelligence: [0.35, 0.8],
    },
    weight: 10,
  },
  {
    value: {
      label: 'juggernaut',
      melee: [0.6, 1.0],
      ranged: [0.0, 0.35],
      defense: [0.1, 0.45],
      intelligence: [0.05, 0.5],
    },
    weight: 10,
  },
  {
    value: {
      label: 'balanced',
      melee: [0.3, 0.7],
      ranged: [0.3, 0.7],
      defense: [0.3, 0.7],
      intelligence: [0.3, 0.7],
    },
    weight: 15,
  },
  {
    value: {
      label: 'noncombatant',
      melee: [0.0, 0.4],
      ranged: [0.0, 0.4],
      defense: [0.0, 0.4],
      intelligence: [0.0, 0.4],
    },
    weight: 7,
  },
];

// Small per-species bumps applied after the archetype roll, each sampled
// uniformly from the given [min,max] range and added (then clamped to [0,1]
// and re-quantized). Kept small relative to the archetype bands above so the
// archetype dominates the final build; the species only nudges it.
export const COMBAT_SPECIES_MODIFIERS = {
  elf: { ranged: [0.05, 0.15], defense: [0.05, 0.15] },
  beastkin: { melee: [0.05, 0.15], defense: [0.05, 0.15] },
  robot: { ranged: [0.05, 0.15], intelligence: [0.05, 0.15] },
  // Humans have no strong innate combat trait; a slight intelligence edge
  // (adaptability/training) rather than none, so the table isn't empty for
  // the most common background.
  human: { intelligence: [0.0, 0.08] },
};

// ---------------------------------------------------------------------------
// Heritage
// ---------------------------------------------------------------------------
//
// Heritage drives the NAME's naming culture and, for humans, general feature
// framing (e.g. skin tone / feature wording the LLM uses in appearance).
// For non-humans (elf, beastkin, robot) it flavors the naming culture ONLY —
// a japanese-heritage elf gets a Japanese-style name, never a real-world
// ethnicity claim. A robot's "name" is really a designation; heritage flavors
// that designation's naming convention (e.g. a nordic-heritage robot might
// carry a Nordic-style designation), again never claiming real ethnicity for
// a machine.
//
// Weighted so no single heritage dominates (cap ~20%) and the invented
// fantasy option stays a modest minority (~10%) rather than a common escape
// hatch.
export const HERITAGES = [
  { value: 'japanese', weight: 14 },
  { value: 'korean', weight: 9 },
  { value: 'chinese', weight: 12 },
  { value: 'south-asian', weight: 9 },
  { value: 'nordic', weight: 7 },
  { value: 'slavic', weight: 7 },
  { value: 'latin-american', weight: 8 },
  { value: 'middle-eastern', weight: 7 },
  { value: 'west-african', weight: 7 },
  { value: 'anglo', weight: 10 },
  // French / Italian / Spanish-European naming culture, grouped as one
  // "Romance-language Europe" bucket rather than splitting into three tiny
  // slices.
  { value: 'romance', weight: 8 },
  { value: 'fantasy-invented', weight: 10 },
];

// ---------------------------------------------------------------------------
// Life context (occupation category)
// ---------------------------------------------------------------------------
//
// We roll a coarse CATEGORY here, table-side, so distribution stays under our
// control (10 weights, not hundreds of jobs). The LLM invents ONE concrete
// occupation within the rolled category, consistent with age, heritage, and
// personality — see buildSystemPrompt/buildUserPrompt in prompt.js. `hint` is
// a short list of EXAMPLE specializations fed to the model as inspiration,
// not an exhaustive menu.
export const LIFE_CONTEXTS = {
  student: { hint: 'university student, vocational school, final-year exam prepper' },
  'service-retail': { hint: 'convenience-store clerk, cafe barista, izakaya waitress' },
  'creative-performer': { hint: 'failed idol, aspiring mangaka, street musician, small-time streamer' },
  'care-medical': { hint: 'night-shift nurse, elder-care worker, pharmacy assistant' },
  'technical-craft': { hint: 'apprentice mechanic, carpenter, small electronics repair' },
  'academic-professional': { hint: 'professor, museum curator, junior architect' },
  'rural-outdoor': { hint: 'farmer, orchard keeper, fishing-boat hand' },
  'spiritual-traditional': { hint: 'shrine keeper, monastery novice, tea-ceremony teacher' },
  'in-between': { hint: 'recently quit, job-hunting, just moved to town' },
  wildcard: { hint: 'anything plausible — invent freely, no example list constrains this one' },
};

// Age bands used to select the LIFE_CONTEXT_WEIGHTS column. For `timeless`
// (apparent_only) characters, the roll uses the APPARENT age (already 18-35)
// so it lands in band 0-2; the prompt separately invites the model to
// reinterpret ("a student of several centuries").
export const LIFE_CONTEXT_AGE_BANDS = ['18-22', '23-29', '30-45', '46+'];

// Per-category weight across the four age bands above, in column order.
// Tuned via scripts/identityStudy.js — see README.md "Life context" section
// for the resulting distributions and the sanity targets these were tuned
// against.
export const LIFE_CONTEXT_WEIGHTS = {
  // student band 0 bumped 30 -> 40 from the original draft: young-adult
  // (age 18-25) straddles bands 0 and 1, so the blended average undershot
  // the ~25-35% target at 30 (came out ~22%); 40 lands the blend at ~28%.
  // See scripts/identityStudy.js output / README.md for the measured result.
  student: [40, 8, 1, 0.5],
  'service-retail': [18, 16, 10, 6],
  'creative-performer': [16, 16, 10, 6],
  'care-medical': [4, 10, 12, 10],
  'technical-craft': [8, 14, 16, 14],
  'academic-professional': [1, 8, 16, 18],
  'rural-outdoor': [6, 8, 12, 18],
  'spiritual-traditional': [3, 5, 8, 14],
  'in-between': [10, 10, 8, 8],
  wildcard: [4, 5, 5, 5],
};

// Outfit accent color words.
export const PALETTE_ACCENTS = [
  'crimson',
  'deep teal',
  'burnt orange',
  'royal purple',
  'forest green',
  'gold',
  'ivory',
  'charcoal',
  'rose',
  'cobalt blue',
  'amber',
  'silver',
];
