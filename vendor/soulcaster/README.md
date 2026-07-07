# soulcaster

Procedural character-sheet generator for [Sei](https://sei.gg), a Minecraft AI-companion app.

soulcaster is a deterministic, two-stage character generator. Stage 1 rolls every piece of variety from seeded weighted tables, no LLM involved. Stage 2 hands the rolled fields to an injected LLM, which consolidates them into a single, richly detailed, schema-validated character sheet. The package never holds API keys; the caller supplies its own `llm` function.

## Pipeline

```
gender, userProfile, rng
        |
        v
  rollFields()  ---- tables.js (weighted picks, seeded rng)
        |
        v
  rolled fields  (background, appearance, heritage, life_context,
                  personality seeds, combat stats, ...)
        |
        v
  buildSystemPrompt() + buildUserPrompt()   (prompt.js)
        |
        v
       LLM   (caller-injected async function)
        |
        v
  parse + CharacterSheetSchema.safeParse()   (zod)
        |          \
        |           \-- invalid --> retry once with the error appended
        v
  authoritative overwrites
  (combat, heritage re-stamped from the rolled values)
        |
        v
  { sheet, rolled }
```

Everything above the LLM box is pure and synchronous. Everything below the LLM box is validation and drift-proofing, not invention.

## Components

### Age ranges

`rollFields` takes an optional `userProfile.companion_age_range`: `young-adult` (18-25), `adult` (26-35), `mature` (36-50), `elder` (51-75), or `timeless` (rolls an apparent age of 18-35 but flags the character as an ancient being; the LLM writes the real age into `age_note`). With no profile, age falls back to a default 18-60 range. 18 is a hard floor everywhere.

### Species / backgrounds

Weighted pick over `BACKGROUNDS`: human (50%), elf, beastkin, robot. Human is the common case so most characters are ordinary people; the other three are rarer and each carry their own `species_detail` convention (animal type and features for beastkin, subtype and ear shape for elves, chassis type and material for robots).

### Appearance tables

Hair color (22 options, natural spectrum plus fantasy colors), hair style, eye color (14 options plus a rare heterochromia roll), height, build, and bust (rolled only for female characters). These are independent uniform picks; keeping them out of the LLM avoids the model collapsing toward the same "cool" hair colors and tropes every run.

### Personality and quirk seeds

Two distinct temperament words are picked from a 24-word list (`PERSONALITY_SEEDS`) and handed to the LLM as "blend these two," which forces contrast (e.g. "scheming yet devoted") instead of one flat trait. A single quirk seed (`QUIRK_SEEDS`, 16 options) gives the model a concrete habit to build from.

### Relationship dynamics

`rollFields` and `castSoul` take an optional `dynamic`: one of `partner-in-crime`, `caretaker` (someone who looks after you), `protege` (someone to look after), `chill-friend`, or `challenger` (someone who pushes you) — see `DYNAMICS` in `src/tables.js`. This is what the user said they are looking for in a companion; the caller resolves which dynamic applies to a given cast (in Sei, users rank dynamics at onboarding and the Nth unique companion uses the Nth ranked entry).

A dynamic biases the personality roll: seed 1 is drawn from the dynamic's `seed_pool` so the relationship reliably reads through, while seed 2 stays a free roll from the full list so two casts with the same dynamic still differ. The prompt also gains a `relationship_dynamic` line, and the sheet gains a `player_dynamic` field (one or two sentences on who the character is to the player). The player never appears in the backstory. With no dynamic, `player_dynamic` is derived from the personality by the model.

### Heritage

`HERITAGES` is a weighted table of 12 naming cultures: japanese, korean, chinese, south-asian, nordic, slavic, latin-american, middle-eastern, west-african, anglo, romance (French/Italian/Spanish-European), and fantasy-invented. No single heritage is weighted above ~20%, and fantasy-invented stays a modest ~9-10% so it is not the default escape hatch.

Heritage drives the naming culture of the `name` field, and for humans it also informs general feature framing. For non-humans (elf, beastkin, robot) it flavors the naming culture only: a japanese-heritage elf gets a Japanese-style name, never a claim of real-world ethnicity. A robot's "name" is really a designation; heritage flavors the designation's naming convention the same way.

### Life context

Rather than let the LLM invent an occupation from scratch (uncontrolled distribution) or hand it a giant enumerated job list (rigid), `rollFields` rolls a coarse **category** and the LLM specializes it into one concrete occupation consistent with age, heritage, and personality. This keeps distribution control on the table side (10 weights) while the actual jobs stay unbounded.

The category roll is weighted by an age x category matrix (`LIFE_CONTEXT_WEIGHTS` in `src/tables.js`), banded at 18-22 / 23-29 / 30-45 / 46+:

| category | 18-22 | 23-29 | 30-45 | 46+ |
|---|---|---|---|---|
| student | 40 | 8 | 1 | 0.5 |
| service-retail | 18 | 16 | 10 | 6 |
| creative-performer | 16 | 16 | 10 | 6 |
| care-medical | 4 | 10 | 12 | 10 |
| technical-craft | 8 | 14 | 16 | 14 |
| academic-professional | 1 | 8 | 16 | 18 |
| rural-outdoor | 6 | 8 | 12 | 18 |
| spiritual-traditional | 3 | 5 | 8 | 14 |
| in-between | 10 | 10 | 8 | 8 |
| wildcard | 4 | 5 | 5 | 5 |

The band is chosen from the character's own rolled age (the apparent age, for `timeless` characters, so an ancient being still lands in a young-looking band; the prompt separately invites it to reinterpret the category across a long life). Run `node scripts/identityStudy.js` to see the resulting distribution per profile, the heritage spread, and sample rolls.

Each category carries a short `hint` string of example specializations (e.g. student: "university student, vocational school, final-year exam prepper") fed to the LLM as inspiration, not an exhaustive menu. The LLM's output lands in the `occupation` field. Unlike combat, heritage and occupation are meant to shape the backstory: they are identity, not just gameplay.

### Setting

The LLM picks one `setting` (`fantasy`, `modern`, `futuristic`, or `historical`) before writing anything else, reconciling the rolled `background` species with the occupation it is about to invent, then keeps outfit, accessories, backstory details, and `image_prompt` inside that single register. Elf and beastkin default to fantasy, robot defaults to futuristic, and human follows the occupation. A fantasy species with a modern occupation is allowed and reads as urban fantasy: the species lives in today's world under a `modern` setting. `setting` is chosen by the LLM, not rolled in Stage 1, because a blind roll could hand a farmhand elf a futuristic setting with no way to reconcile it.

### Combat

`rollFields` also rolls a `combat` block: four stats in `[0,1]`, quantized to 0.05 steps, plus an archetype label.

- **melee** - sword/axe skill. Hit chance = `50% + melee*50%`.
- **ranged** - bow/crossbow accuracy = `ranged*100%`; also proxies draw strength (weaker archers release early).
- **defense** - reaction speed, dodge chance, and the discipline to disengage and heal.
- **intelligence** - battle IQ: crit timing, weapon-switch discipline, retreat-to-heal quality.

Independent uniform rolls per stat would cluster every character mid-pack, so the roller first picks a weighted archetype (`brawler`, `sharpshooter`, `duelist`, `tactician`, `skirmisher`, `juggernaut`, `balanced`, `noncombatant`), each defining a `[min,max]` band per stat, then applies a small per-species bump (elf leans ranged/defense, beastkin leans melee/defense, robot leans ranged/intelligence, human gets a slight intelligence edge). Run `node scripts/combatStudy.js` for the resulting histograms and archetype frequency.

**Combat is in-game playstyle only.** It is never derived from or woven into personality or backstory: a shy student can be a lobby-topping sharpshooter. This is the opposite rule from heritage and occupation above, which the backstory should draw on.

### Voice

`rollFields` also rolls a `voice` from the curated ElevenLabs pool in `src/voices.js` (63 voices, each tagged with gender, an age band, and personality tags). The roll is table-side like everything else: gender is a hard filter (neutral voices are eligible for everyone, and are the core pool for `other` characters), young and elder bands never cross, robotic voices are reserved for `robot` backgrounds, and personality-seed tag affinity multiplies the weights so the voice suits the temperament. The rolled `{ id, label, vibe }` is fed to the LLM so `voice_style` prose matches the actual sound, and `castSoul` stamps `sheet.voice_id` after validation (same re-stamp pattern as combat and heritage; the model never chooses the voice).

Callers pass `takenVoiceIds` (the voice ids of the user's other companions) to `rollFields`/`castSoul`; those are excluded from the pool unless exclusion would empty it. `node scripts/voiceStudy.js` measures the result: with `takenVoiceIds` a 4-companion roster repeats a voice 0% of the time, and two fully independent same-gender rolls collide under 4%.

`scripts/syncVoices.js` makes an ElevenLabs account usable with the table: it adds every shared-library voice to the account (adding preserves the public voice id) and verifies the premade ones exist. Run it once per account/key: `ELEVENLABS_API_KEY=... node scripts/syncVoices.js`.

### LLM consolidation contract

`castSoul` builds a system prompt and a user prompt (rolled fields plus any user preferences) and calls the injected `llm` function. The model must echo the rolled, closed-vocabulary fields verbatim (background, combat, heritage) and invent the rest (setting, name, species_detail, occupation, personality, backstory, appearance, image_prompt) as strict JSON, validated against `CharacterSheetSchema` (zod). `setting` is its own case: a closed enum like background, but chosen by the model rather than rolled, so it is validated like the rolled fields yet never re-stamped like them. On a parse or schema failure, it retries once with the validation error appended, then throws a typed `SoulcasterError`.

After validation, `castSoul` re-stamps `sheet.combat` and `sheet.heritage` from the rolled values regardless of what the model echoed. Both are closed vocabularies rolled deterministically in Stage 1, so a paraphrase or dropped digit on retry can never desync the sheet from what was actually rolled. `occupation` is not rolled and is never overwritten; it is pure LLM invention, only validated.

### Determinism / seeding

Every roll takes an `rng` (default `Math.random`). Passing `mulberry32(seed)` (exported) makes every roll, including `castSoul`'s Stage 1 fields, fully reproducible from an integer seed. This is what the CLI's `--seed` flag and the whole test suite rely on.

### CLI

```sh
# Skip the LLM: print the rolled fields plus a stub sheet.
node src/cli.js --gender female --mock

# Deterministic rolls with a seed.
node src/cli.js --gender female --seed 42 --mock

# With a profile file ({ companion_age_range?, art_style?, ... }).
node src/cli.js --gender other --profile profile.json --mock

# Real generation (needs ANTHROPIC_API_KEY; model claude-haiku-4-5).
export ANTHROPIC_API_KEY=sk-ant-...
node src/cli.js --gender female --seed 42
```

The Anthropic fetch lives only in the CLI. It is a convenience for testing and manual generation, never part of the library path.

### Testing

```sh
npm test
```

`tests/` is a `node:test` suite: roll determinism and coverage (`rollFields.test.js`), the combat roller's bands and species modifiers (`combat.test.js`), heritage and life-context banding, coverage, and sanity targets (`identity.test.js`), and the `castSoul` happy path, retry, and failure behavior against a mock `llm` (`castSoul.test.js`). No API key is needed.

`scripts/combatStudy.js` and `scripts/identityStudy.js` are standalone distribution studies (no test dependencies) used to tune the weight tables by eye.

## Library usage

```js
import { castSoul, rollFields } from 'soulcaster';

// Stage 1 only: just the rolled traits (pure, synchronous).
const rolled = rollFields({ gender: 'female', userProfile: { companion_age_range: 'adult' } });

// Full sheet: inject your own LLM, signature async ({ system, user, maxTokens }) => string.
const llm = async ({ system, user, maxTokens }) => { /* call your backend, return raw text */ };

const { sheet, rolled: rolledUsed } = await castSoul({
  gender: 'female',
  userProfile: { companion_age_range: 'adult', art_style: 'soft anime' },
  llm,
});
```

## Output schema

`CharacterSheetSchema` (zod, exported) validates:

```
{
  name,                    // follows heritage's naming culture
  gender, age, age_note,   // age_note e.g. "appears 24, is 312", or null
  background,              // human | elf | robot | beastkin
  setting,                 // fantasy | modern | futuristic | historical, chosen by the LLM
  species_detail,          // e.g. "wood elf with tapered ears"
  heritage,                // rolled naming culture, re-stamped after validation
  occupation,              // LLM's concrete specialization of the rolled life_context
  personality: { tone, values /* 3-5 */, quirks /* 2-3 */, fears /* 1-2 */ },
  backstory,               // 150 to 300 words, weaves in heritage and occupation
  voice_style,
  punctuation,             // casual | deliberate — texting register, defaults casual.
                           // casual = normal modern texting, no sentence-ending periods
                           // (most characters). deliberate = ends sentences with full
                           // stops on purpose (deadpan, measured, can read
                           // passive-aggressive); the client enforces it in chat.
  combat: {                // rolled in Stage 1, re-stamped after validation
    archetype,
    melee, ranged, defense, intelligence   // 0 to 1, quantized to 0.05 steps
  },
  appearance: {
    overall, hair /* null for robots */, eyes, skin, height, build,
    bust,                  // null unless applicable
    outfit, accessories, distinguishing_features  // 1-3 items
  },
  image_prompt             // one self-contained paragraph, no art-style words
}
```

## Package surface

```
src/
  index.js   castSoul, rollFields, CharacterSheetSchema, option tables, mulberry32
  tables.js  all option tables (heritage, life context, combat, appearance, ...)
  prompt.js  system and user prompt builders
  cli.js     CLI (--gender, --profile, --seed, --mock)
scripts/
  combatStudy.js    distribution study for the combat roller (no deps)
  identityStudy.js  distribution study for heritage + life_context (no deps)
tests/       node:test suite (npm test, no API key needed)
```

## Install

Requires Node.js 18+.

```sh
npm install
```

## License

MIT
