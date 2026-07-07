#!/usr/bin/env node
// soulcaster CLI — for testing and manual generation.
//
//   node src/cli.js --gender female [--dynamic caretaker] [--profile profile.json] [--seed 42] [--mock]
//
// --mock  skip the LLM: print the rolled fields plus a stub sheet.
// no flag use ANTHROPIC_API_KEY from env (plain fetch to the Anthropic API).
//
// The Anthropic fetch lives ONLY here — it is a CLI convenience and never part
// of the library path. Library callers inject their own `llm` into castSoul.

import { readFileSync } from 'node:fs';
import { rollFields, castSoul, mulberry32 } from './index.js';

function parseArgs(argv) {
  const args = { gender: null, dynamic: null, profile: null, seed: null, mock: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--gender') args.gender = argv[++i];
    else if (a === '--dynamic') args.dynamic = argv[++i];
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--mock') args.mock = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const USAGE = `soulcaster — procedural character-sheet generator

Usage:
  node src/cli.js --gender <male|female|other> [options]

Options:
  --gender   required: male | female | other
  --dynamic  relationship dynamic for this cast:
             partner-in-crime | caretaker | protege | chill-friend | challenger
  --profile  path to a JSON user profile
             ({ companion_age_range?, art_style?, ... })
  --seed     integer seed for deterministic rolls (mulberry32)
  --mock     skip the LLM; print rolled fields + a stub sheet
  --help     show this message

Without --mock, ANTHROPIC_API_KEY must be set (model claude-haiku-4-5).`;

// Minimal Anthropic Messages client. CLI-only; not exported, not in the lib path.
async function anthropicLlm({ system, user, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens ?? 4096,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`anthropic API ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.content || []).map((block) => block.text || '').join('');
}

// A deterministic stub sheet built directly from the rolled fields, so --mock
// exercises the roller without any model call.
function stubSheet(gender, rolled) {
  const hasHair = rolled.background !== 'robot';
  const speciesDetail = {
    human: 'human, warm olive skin',
    elf: 'wood elf with long tapered ears and a faint sun-freckled complexion',
    beastkin: 'fox-person with tall russet ears and a full brush tail',
    robot: 'porcelain-plated android with brushed-steel joints',
  }[rolled.background];

  // A plausible default per species so --mock output stays schema-valid:
  // elf/beastkin lean fantasy, robot leans futuristic, human lands on
  // modern. Real (non-mock) runs let the LLM choose this per the
  // reconciliation rules in buildSystemPrompt.
  const setting = { human: 'modern', elf: 'fantasy', beastkin: 'fantasy', robot: 'futuristic' }[rolled.background];

  return {
    name: 'Stub',
    gender,
    age: rolled.age,
    age_note: rolled.apparent_only ? `appears ${rolled.age}, is far older` : null,
    background: rolled.background,
    setting,
    species_detail: speciesDetail,
    // Always the rolled values in --mock mode too, for the same reason as
    // combat below: heritage is a closed vocabulary, never invented here.
    heritage: rolled.heritage,
    occupation: `(mock) an unspecified ${rolled.life_context} role`,
    personality: {
      tone: `${rolled.personality_seeds[0]} yet ${rolled.personality_seeds[1]}`,
      values: ['loyalty', 'curiosity', 'craft'],
      quirks: [rolled.quirk_seed, 'fidgets with a favorite trinket'],
      fears: ['being left behind'],
    },
    backstory:
      'This is a placeholder backstory generated in --mock mode without any LLM call. ' +
      'It exists only to demonstrate the shape of the output. In a real run the model ' +
      'weaves the rolled fields into a 150 to 300 word history explaining how the ' +
      "character's look and temperament came to be.",
    player_dynamic: rolled.dynamic
      ? `(mock) leans into being ${rolled.dynamic.replace(/-/g, ' ')} for the player`
      : null,
    voice_style: 'speaks plainly, with short sentences and a dry edge',
    punctuation: 'casual',
    // Always the rolled value, never invented — see castSoul's authoritative
    // overwrite in src/index.js for why this is never LLM-derived even in a
    // real (non-mock) run.
    combat: rolled.combat,
    appearance: {
      overall: `a ${rolled.height} ${rolled.build} figure`,
      hair: hasHair ? `${rolled.hair_color} ${rolled.hair_style}` : null,
      eyes: rolled.eye_color,
      skin: rolled.background === 'robot' ? 'matte porcelain plating' : 'warm olive',
      height: rolled.height,
      build: rolled.build,
      bust: rolled.bust ?? null,
      outfit: `layered traveler's clothes with ${rolled.palette_accent} accents`,
      accessories: ['a worn leather satchel'],
      distinguishing_features: ['a small scar above one eyebrow'],
    },
    image_prompt:
      `Full-body view of a ${rolled.height} ${rolled.build} ${rolled.background} character, ` +
      `${hasHair ? `${rolled.hair_color} ${rolled.hair_style}, ` : ''}${rolled.eye_color} eyes, ` +
      `wearing layered traveler's clothes with ${rolled.palette_accent} accents and a worn leather satchel, ` +
      'a small scar above one eyebrow, standing straight and facing forward.',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.gender) {
    console.error('error: --gender is required\n');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  let userProfile = null;
  if (args.profile) {
    userProfile = JSON.parse(readFileSync(args.profile, 'utf8'));
  }

  const rng = args.seed != null && !Number.isNaN(args.seed) ? mulberry32(args.seed) : Math.random;

  if (args.mock) {
    const rolled = rollFields({ gender: args.gender, userProfile, dynamic: args.dynamic, rng });
    const sheet = stubSheet(args.gender, rolled);
    console.log('=== rolled fields (Stage 1) ===');
    console.log(JSON.stringify(rolled, null, 2));
    console.log('\n=== stub sheet (no LLM) ===');
    console.log(JSON.stringify(sheet, null, 2));
    return;
  }

  const { sheet, rolled } = await castSoul({
    gender: args.gender,
    userProfile,
    dynamic: args.dynamic,
    llm: anthropicLlm,
    rng,
  });
  console.log('=== rolled fields (Stage 1) ===');
  console.log(JSON.stringify(rolled, null, 2));
  console.log('\n=== character sheet (Stage 2) ===');
  console.log(JSON.stringify(sheet, null, 2));
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exitCode = 1;
});
