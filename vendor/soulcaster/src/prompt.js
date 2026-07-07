// Stage 2 prompt builders. The system prompt fixes the model's job and the
// strict-JSON contract; the user prompt carries the rolled fields and user
// preferences. Randomness already happened in Stage 1 — the model's job is
// consolidation and enrichment, not invention of the core traits.

import { LIFE_CONTEXTS, DYNAMICS } from './tables.js';

export function buildSystemPrompt() {
  return `You are a character designer for Sei, a Minecraft AI-companion app. You turn a set of pre-rolled random traits into a single, richly detailed, internally consistent character sheet.

RULES:
- Before writing anything else, pick ONE "setting" that reconciles the rolled background (species) with the occupation you are about to invent: "fantasy", "modern", "futuristic", or "historical". Guidance: elf and beastkin default to fantasy; robot defaults to futuristic; human follows the occupation (a convenience-store clerk is modern, a shrine keeper is modern or historical, a farmhand can be any). A fantasy species with a modern occupation is allowed and means urban fantasy: pick setting "modern" and have the species living in today's world.
- EVERYTHING must then sit in that one register: outfit and accessories (no utility vests, hoodies, or sneakers in a fantasy setting; no chainmail or cloaks on a modern clerk), occupation wording, backstory details (technology, institutions, daily life), and image_prompt. Do not mix registers.
- The pre-rolled fields below were chosen by a randomizer to guarantee variety. HONOR them. Do not swap the hair color, background, personality seeds, etc. for something more "typical" — that defeats the purpose.
- You MAY consolidate or DROP a rolled field when it does not apply to this character, so an image model is not confused. Example: a robot with no hair — omit hair entirely (set appearance.hair to null). A field that does not fit the concept should be dropped, not forced.
- You MUST add and fully specify: clothing/outfit (name specific garments AND their colors), accessories, species_detail, distinguishing features, and a backstory.
- species_detail depends on background:
  - beastkin: pick one animal (dog / cat / fox / wolf person, etc.) and describe the ears and tail concretely.
  - elf: pick a subtype (wood elf / high elf / dark elf) and describe ear shape and complexion.
  - robot: pick a type (android / heavy chassis / porcelain automaton, etc.) and describe the material and finish.
  - human: describe skin tone and any notable human features.
- heritage below is a pre-rolled naming culture. Echo the heritage string in your JSON EXACTLY as given. The name MUST follow that heritage's naming culture (a japanese heritage character gets a Japanese-style name, a nordic heritage character a Nordic-style name, and so on). This applies to non-humans too: a japanese-heritage elf still gets a Japanese-style name. But heritage flavors the NAME (and, for humans only, general feature framing) — it never claims a real-world ethnicity for an elf, beastkin, or robot. A robot's "name" is really a designation; flavor the designation's naming convention by the heritage instead (e.g. a nordic-heritage robot might carry a Nordic-sounding designation), not an ethnicity claim about the machine.
- occupation: specialize the rolled life_context CATEGORY (below) into ONE concrete occupation, consistent with the character's age, heritage, and personality. The category's example specializations are inspiration only, not an exhaustive menu — invent freely within the spirit of the category. For non-human species (elf, beastkin, robot), reinterpret the category rather than ignore it (e.g. a beastkin in the rural-outdoor category could be an orchard keeper who talks to the animals; a robot in the technical-craft category could be a maintenance unit repurposed as an apprentice mechanic). The life_context hints are register-neutral: reinterpret them into your chosen setting (service-retail in a fantasy setting is a tavern server or market-stall keeper, not a convenience-store clerk).
- The backstory MUST be 150 to 300 words and must explain HOW the appearance and the personality cohere — why this person looks and acts this way. The backstory SHOULD weave in occupation and heritage: unlike combat (see below), these ARE part of the character's identity, not just gameplay, so let them shape formative details, daily life, or worldview.
- player_dynamic: one or two sentences describing who this character naturally is TO THE PLAYER they accompany in the game — the relationship role they fall into (a co-conspirator, a quiet protector, a rival who keeps score, ...). If the user prompt provides a relationship_dynamic, player_dynamic MUST express that dynamic and the personality (tone, values, quirks) must make it credible; otherwise derive it from the personality. The player is NOT in the backstory — the backstory is who the character is before they meet anyone, so keep the relationship out of it.
- combat below is a pre-rolled set of four numbers (melee, ranged, defense, intelligence, each 0 to 1) plus an archetype label. Echo the combat object in your JSON EXACTLY as given — same archetype string, same four numbers, no rounding or rewording. IMPORTANT: this is the character's Minecraft PLAYSTYLE, not their identity — these characters know they are playing a game, and combat skill is how they happen to play it, the way a shy student can be a lobby-topping sharpshooter. Do NOT derive the backstory or personality from the combat numbers: no combat training, warrior past, weapons lore, or fighter framing unless the OTHER rolled fields independently call for it. The backstory must stand entirely on its own with combat removed. This is the opposite rule from occupation and heritage above: combat stays OUT of the backstory, occupation and heritage belong IN it.
- Be ULTRA-SPECIFIC everywhere. Prefer concrete nouns and exact colors over vague adjectives. The character must be reproducible: an image model reading image_prompt should draw the same character every time.
- image_prompt is ONE self-contained paragraph, a full-body head-to-toe visual description consistent with every other field. Do NOT include any art-style words (no "anime", "realistic", "3D render", "pixel art", etc.) — the caller appends the style. Describe only the character.
- punctuation: how this character punctuates short text-chat messages. This is a TEXTING register, not persona formality. "casual" means normal modern texting: sentences without trailing full stops. It fits MOST characters, including serious, shy, or noble ones — picking casual does NOT make the persona casual. "deliberate" means they end sentences with periods on purpose: flat, measured, every word placed; to a modern reader it can come off as cold or passive-aggressive, and for the right character that is exactly the point. Reserve "deliberate" for characters whose speech is genuinely clipped, monotone, weary, exacting, or machine-precise — a deadpan robot narrating its own misery, a stern drill instructor, a jaded archivist. If in doubt, choose "casual".
- card_line is a tiny identity caption shown under the character's name on their card in the app. Format: "a <one or two tone adjectives> <species or role noun phrase>". 3 to 8 words, all lowercase, no name, no trailing period. It must reveal NO appearance, backstory, or personal details (those are for the player to discover) — only surface tone plus what they visibly are. Examples: "a wry wood elf cartographer", "a direct and candid android", "a boisterous cat-eared tinkerer".
- No em-dashes in your prose.

OUTPUT:
Return STRICT JSON only — a single object, no prose before or after, no markdown code fences. It must match this shape exactly:
{
  "name": string,
  "gender": "male" | "female" | "other",
  "age": number,
  "age_note": string | null,
  "background": "human" | "elf" | "robot" | "beastkin",
  "setting": "fantasy" | "modern" | "futuristic" | "historical",
  "species_detail": string,
  "heritage": string,
  "occupation": string,
  "personality": { "tone": string, "values": string[], "quirks": string[], "fears": string[] },
  "backstory": string,
  "player_dynamic": string | null,
  "voice_style": string,
  "punctuation": "casual" | "deliberate",
  "combat": { "archetype": string, "melee": number, "ranged": number, "defense": number, "intelligence": number },
  "appearance": {
    "overall": string,
    "hair": string | null,
    "eyes": string,
    "skin": string,
    "height": string,
    "build": string,
    "bust": string | null,
    "outfit": string,
    "accessories": string[],
    "distinguishing_features": string[]
  },
  "image_prompt": string,
  "card_line": string
}
personality.values: 3 to 5 items. personality.quirks: 2 to 3 items. personality.fears: 1 to 2 items. appearance.distinguishing_features: 1 to 3 items.`;
}

export function buildUserPrompt({ gender, userProfile, rolled }) {
  const lines = [];
  lines.push('Create the character sheet. Here are the pre-rolled random fields you must honor:');
  lines.push('');
  lines.push(`gender: ${gender}`);
  lines.push(`background: ${rolled.background}`);
  lines.push(`age: ${rolled.age}${rolled.apparent_only ? ' (this is only the APPARENT age — the character is an ancient being; write the real age into age_note)' : ''}`);
  lines.push(
    `heritage: ${rolled.heritage} (drives the naming culture for "name"; for non-humans this flavors the name only, never a real-world ethnicity claim)`,
  );
  const lifeContextHint = LIFE_CONTEXTS[rolled.life_context] ? LIFE_CONTEXTS[rolled.life_context].hint : '';
  lines.push(
    `life_context: ${rolled.life_context} (category — examples for inspiration only: ${lifeContextHint}; invent ONE concrete "occupation" within this category, consistent with age/heritage/personality` +
      (rolled.apparent_only
        ? '; this character is ancient, so feel free to reinterpret the category across a long life — e.g. "a student of several centuries" — rather than taking it literally'
        : '') +
      ')',
  );
  if (rolled.hair_color) lines.push(`hair_color: ${rolled.hair_color}`);
  if (rolled.hair_style) lines.push(`hair_style: ${rolled.hair_style}`);
  lines.push(`eye_color: ${rolled.eye_color}`);
  lines.push(`height: ${rolled.height}`);
  lines.push(`build: ${rolled.build}`);
  if (rolled.bust) lines.push(`bust: ${rolled.bust}`);
  lines.push(`personality_seeds: ${rolled.personality_seeds.join(', ')} (blend these two temperaments)`);
  if (rolled.voice) {
    lines.push(
      `voice: ${rolled.voice.label} — sounds like: ${rolled.voice.vibe} (this is the character's literal speaking voice, pre-assigned; write "voice_style" as a description of how they speak that fits BOTH this sound and the personality — do not contradict the sound, e.g. no "booming baritone" for a soft voice)`,
    );
  }
  if (rolled.dynamic && DYNAMICS[rolled.dynamic]) {
    const d = DYNAMICS[rolled.dynamic];
    lines.push(
      `relationship_dynamic: ${d.label} (${d.hint}) — the user asked to meet this; "player_dynamic" must express it and the personality must make it credible, but keep the player OUT of the backstory`,
    );
  }
  lines.push(`quirk_seed: ${rolled.quirk_seed}`);
  lines.push(`palette_accent: ${rolled.palette_accent} (use as the outfit's accent color)`);
  lines.push(
    `combat: ${JSON.stringify(rolled.combat)} (echo this object verbatim as the "combat" field; this is in-game playstyle only, keep it OUT of the backstory and personality)`,
  );

  const extras = userPreferenceLines(userProfile);
  if (extras.length) {
    lines.push('');
    lines.push('User preferences (context — respect these where they do not conflict with the rolled fields):');
    lines.push(...extras);
  }

  lines.push('');
  lines.push('Return STRICT JSON only.');
  return lines.join('\n');
}

// Turn the (loosely typed) userProfile into prompt lines. Known keys get
// friendly phrasing; unknown keys are passed through as extra context.
function userPreferenceLines(userProfile) {
  if (!userProfile || typeof userProfile !== 'object') return [];
  const out = [];
  for (const [key, value] of Object.entries(userProfile)) {
    if (value == null || value === '') continue;
    if (key === 'companion_age_range') continue; // already reflected in the rolled age
    // The full onboarding RANKING of relationship dynamics. The one dynamic
    // that applies to THIS cast arrives as rolled.dynamic (see buildUserPrompt
    // above) — dumping the whole ranked list here would leak every other
    // preference into every cast, so skip it.
    if (key === 'companion_dynamics') continue;
    if (key === 'art_style') {
      out.push(`- preferred art style (for your awareness only; do NOT put style words in image_prompt): ${value}`);
      continue;
    }
    out.push(`- ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return out;
}

// Appended to the user prompt on the single retry after a validation failure.
export function buildRetrySuffix(errorMessage) {
  return `\n\nYour previous response was rejected. Fix it. Validation error:\n${errorMessage}\n\nReturn STRICT JSON only, matching the required shape exactly. No markdown fences, no prose.`;
}
