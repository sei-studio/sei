// Curated ElevenLabs voice pool for the Stage 1 voice roll.
//
// Like every other option table, voice variety is forced table-side: rollVoice
// (index.js) filters this pool by the character's gender and age band, weights
// it by personality-seed affinity, excludes voices already taken by the
// caller's other characters, and picks one. The LLM never chooses the voice —
// it only writes voice_style prose consistent with the rolled voice's vibe.
//
// Entry shape:
//   id     ElevenLabs voice_id. Stable across accounts: adding a shared voice
//          to an account preserves the public voice_id (verified 260705), so
//          this table works for any account that ran scripts/syncVoices.js.
//   owner  public_owner_id for shared-library voices (needed by the add call);
//          null for ElevenLabs premade voices, which exist in every account.
//   label  Display name (shown in UI / prompt). Our own short name, never a
//          brand or a known character (Grampa Werthers -> Walt).
//   gender 'female' | 'male' | 'neutral'. Neutral voices are eligible for any
//          character gender (see rollVoice weighting).
//   age    'young' | 'adult' | 'elder' — coarse apparent-age band.
//   tags   Closed vocabulary matched against SEED_VOICE_TAGS for personality
//          affinity. 'robotic' is special: robotic voices are ONLY eligible
//          for robot-background characters (and are strongly preferred there).
//   vibe   Short prose description fed to the LLM so voice_style matches the
//          actual sound.
//   roll   Optional. `roll: false` = picker only: listed in the voice picker,
//          never drawn by rollVoice (so neither soulcaster nor the client's
//          fallback roll assigns it). Used for Sui's voice (Lyan, so new
//          characters don't sound like Sui) and the everyday-sounding voices
//          users may still want on purpose.
//
// Curation rule (261119 voice library refresh, replaces the 260707 note):
//   - ElevenLabs use_case 'characters_animation' (GET /v1/shared-voices or
//     /v1/voices/{id} -> labels.use_case). Conversational, narration and
//     informative voices read as podcast hosts and audiobook narrators, not
//     game companions. Five conversational voices (River, Sammy, Riley,
//     Ramona, Aaron) came back on 260725 and became the "generic American"
//     sound; do not let that happen again.
//   - notice_period of 365 days or more (an owner who delists keeps our
//     access only for the notice period).
//   - The voice's language verified on eleven_flash_v2_5 (the model tts.ts
//     uses for every language).
//   - live_moderation_enabled false, rate 1.0 (standard price).
//   - No celebrity, brand or known-character imitation in the voice or label.
// free_users_allowed is NOT required: it only limits free-plan ElevenLabs
// accounts, and BYOK users on a free plan can't use any library voice anyway
// (VOICE_NEEDS_PAID_PLAN).
//
// Retiring a voice: delete it here and add its id to LEGACY_VOICE_IDS (sei
// src/shared/poolVoiceIds.ts), the local-voice gender table (sei
// src/main/speech/localVoice.ts) and LEGACY_VOICES (sei-proxy
// scripts/genVoiceAllowlist.mjs). Existing characters keep the voice; it stays
// on the ElevenLabs account. 261119 retired Gravel, Rusty, Sigma, Ramona,
// River, Aaron, Malakai and Mora (full entries in git history).

export const VOICE_TAGS = [
  'warm', 'soft', 'gentle', 'calm', 'steady', 'deep', 'bright', 'upbeat',
  'cute', 'energetic', 'excited', 'rough', 'raspy', 'dark', 'intense', 'sly',
  'dry', 'casual', 'classy', 'commanding', 'confident', 'professional',
  'sassy', 'wise', 'robotic',
];

export const VOICES = [
  // ------------------------------------------------------------------ female
  // young
  { id: 'FNhoq0qHG3T8YOWzBtd6', owner: '941f1f501fbba05614a17d087fed1008a6ce594f34808b6b8d981fa348a04dbd', label: 'Allison', gender: 'female', age: 'young', tags: ['sassy', 'energetic', 'rough'], vibe: 'a cowgirl drawl, sassy Southern twang' },
  { id: 'WtA85syCrJwasGeHGH2p', owner: '676836da794e5521fa0d8bea0f0eb62593e5a418cfc28e5cfbf56763ec40921c', label: 'Ember', gender: 'female', age: 'young', tags: ['energetic', 'confident', 'bright'], vibe: 'bold adventurous protagonist, fearless with a playful edge, American' },
  { id: '54Cze5LrTSyLgbO6Fhlc', owner: '551e509d9ac4c438a9986fd0988732a1919ef0380f17e14b4467dba496c7a4f3', label: 'Caty', gender: 'female', age: 'young', tags: ['dry', 'sassy', 'casual'], vibe: 'droll and wry, a sarcastic side-eye of a voice, American' },
  { id: 'BlgEcC0TfWpBak7FmvHW', owner: '9ec32a295ffc64373eae80b35c5258afa9880ddc6083a0a43ca59e4660bb4244', label: 'Fena', gender: 'female', age: 'young', tags: ['sassy', 'cute', 'energetic'], vibe: 'girly, sassy young hero, American' },
  { id: 'XdflFrQO8wbGpWMNZHFr', owner: 'b5a61d83f7f8b3f1c62cbb20f2e46436af713c1c66b5473bb0487f61e4d6b200', label: 'Zoe', gender: 'female', age: 'young', tags: ['sly', 'confident', 'upbeat'], vibe: 'playfully arrogant stage magician, theatrical, American' },
  { id: 'n7Wi4g1bhpw4Bs8HK5ph', owner: '9b90e86d9a4f269df3fd50cd3dc9641ad870ac1b954133a660f5e87b90703db6', label: 'Gigi', gender: 'female', age: 'young', tags: ['cute', 'energetic', 'upbeat'], vibe: 'peppy, cute and ready to kick butt, American' },
  { id: 'Nggzl2QAXh3OijoXD116', owner: 'ae849c785506c5b89d2a80b9521dd6cd34eaafc69ce6ad4ea9d65f490a3d1f41', label: 'Candy', gender: 'female', age: 'young', tags: ['cute', 'bright', 'excited'], vibe: 'high, bubbly, kawaii-sweet magical girl, American' },
  { id: '3bMMFnv44fDwVPsFtKwZ', owner: '01ae919fc2d03a1caeb66a9fa8ebd7966f757e589a72ddc448208015b744e010', label: 'Elowen', gender: 'female', age: 'young', tags: ['sassy', 'sly', 'bright'], vibe: 'quick-witted cheeky elf, crisp British' },
  // picker only (roll: false)
  { id: 'tnVKC6NjwhdRxoQIfKue', owner: '0a2b6902206ee5c247450ff82caa110406aedfb7173a54281db01ffe36abe033', label: 'Lyan', gender: 'female', age: 'young', roll: false, tags: ['casual', 'bright'], vibe: 'casual, natural, girl-next-door, American accent' },
  // adult
  { id: 'WMKg7TxPpPWCryaXE42r', owner: '5214e3d3123945dcad0881d8743a206c4dbc617f34e858e8878c4fd90deb4892', label: 'Cruella', gender: 'female', age: 'adult', tags: ['intense', 'sly', 'classy', 'dark'], vibe: 'dangerously charming, silky menace, theatrical British' },
  { id: '4BAlflaQyhIcCfHiEI7x', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Tess', gender: 'female', age: 'adult', tags: ['wise', 'steady', 'commanding'], vibe: 'direct and grounded, no-nonsense British' },
  { id: 'FCYF8vBfwu11whOhvb94', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Jade', gender: 'female', age: 'adult', tags: ['raspy', 'dry', 'dark', 'casual'], vibe: 'edgy and nonchalant, a raspy shrug of a voice, American accent' },
  { id: 'sssn4wp3AspuK2kvy3Ym', owner: '90bcaeda9ed6d1dea5a80cc31469586854c06a388054be31490a3b0e6732358a', label: 'Vivien', gender: 'female', age: 'adult', tags: ['dark', 'classy', 'soft'], vibe: 'mysterious witch, velvety dark-fantasy elegance, American' },
  { id: 'xNtG3W2oqJs0cJZuTyBc', owner: '09298f102c8256124b1a9105b63018af44d6529a253ef238e2a752b854e18697', label: 'Chloe', gender: 'female', age: 'adult', tags: ['upbeat', 'casual', 'bright'], vibe: 'lively and expressive, strong French accent' },
  { id: 'fgDJOgmENIR82PueQrVs', owner: 'e21da34db31d58704b7b2776dcf7db1c31b464e5bffd71727d5f1c4abafafa87', label: 'Minerva', gender: 'female', age: 'adult', tags: ['classy', 'intense', 'dark'], vibe: 'dark enchantress noblewoman, cold calculation and passion, British' },
  { id: 'EMYWJ6jws25NB7xJgDxG', owner: '051cfdc5e0be9c442c83d31d163487c38d6959182eaee9ca4b0445d3b9aa770b', label: 'Dusty', gender: 'female', age: 'adult', tags: ['sassy', 'warm', 'dry'], vibe: 'sarcastic Southern firecracker, sweet once she knows you' },
  // picker only (roll: false)
  { id: 'mrmaApeLxpgZi4RK7oGq', owner: '6ee30dd5a46fe2743d8eb1d6c1528a17cd5557b79bb63e2ffc775efd3cf941d2', label: 'Meaghan', gender: 'female', age: 'adult', roll: false, tags: ['casual', 'warm'], vibe: 'relaxed, everyday American' },
  // elder
  { id: '7NsaqHdLuKNFvEfjpUno', owner: 'a42905fd2095e55c89320aa75143b885e3ccd020577c280c8c0d0d022f3cfe44', label: 'Morganna', gender: 'female', age: 'elder', tags: ['wise', 'commanding', 'intense'], vibe: 'old fortune-telling seer, clear and intimidating' },
  { id: 'vFLqXa8bgbofGarf6fZh', owner: 'ae23ca715ed6b339e4ad22f2d45dd40b36a6449e031b4f8970bfe29524bd1bbc', label: 'Oxley', gender: 'female', age: 'elder', tags: ['warm', 'gentle', 'soft'], vibe: 'sweet caring grandmother, modest pacing, American' },

  // -------------------------------------------------------------------- male
  // young
  { id: 'SOYHLrjzK2X1ezoPC6cr', owner: null, label: 'Harry', gender: 'male', age: 'young', tags: ['rough', 'intense', 'energetic'], vibe: 'fierce and rough, a young warrior’s bark, American accent' },
  { id: 'wSqOdjeNqDrHcoK0zorF', owner: '59b69ab0c20dacf272109a7a9f65228f6767244c99a93f287eec05754f550f7a', label: 'Lukas', gender: 'male', age: 'young', tags: ['excited', 'upbeat', 'bright', 'energetic'], vibe: 'excited and youthful, bursting with enthusiasm, American accent' },
  { id: 'NXaTw4ifg0LAguvKuIwZ', owner: 'be7f2f07098dc23343bab4a9a1202b290c2456f82b01ebcecea0a8af8a146bd9', label: 'Josh', gender: 'male', age: 'young', tags: ['classy', 'sly', 'confident'], vibe: 'posh British, playfully smug' },
  { id: '5J8HNhWkTAhN2YWsd9Ta', owner: '533f956cf2444e80b69c8f48cd7ba487892379c6754f9019db544a3e1fffae74', label: 'Dev', gender: 'male', age: 'young', tags: ['cute', 'upbeat', 'casual'], vibe: 'lively Korean-accented streamer, boyish charm' },
  { id: 'gUU37agQvEpxeWrZUIMk', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Alaric', gender: 'male', age: 'young', tags: ['intense', 'dark', 'classy'], vibe: 'intense and theatrical, every line a stage, American accent' },
  { id: '6IwYbsNENZgAB1dtBZDp', owner: 'a72a436938f959ab051e6a27b035db67a4b75945b4d6e8c86ed40e6e946a2e11', label: 'Jett', gender: 'male', age: 'young', tags: ['rough', 'energetic', 'confident'], vibe: 'gritty, spunky young hero with an edge, American' },
  { id: 'loY1uopAz31XyhAEhNSa', owner: 'edb29bf3ecacd3634096c4bc62c0537e04cbfb94cf27cd2babced5c1709800d6', label: 'Valf', gender: 'male', age: 'young', tags: ['cute', 'sly', 'energetic'], vibe: 'very young, playful and sarcastic, anime-dub energy, American' },
  { id: 'AFkIMdmeB0MMrr1tgGds', owner: 'b25bee16aa91821a617fff12da5f5afd5961297e500d49f06e98e9faefebdc7f', label: 'Cyrien', gender: 'male', age: 'young', tags: ['sly', 'confident', 'classy'], vibe: 'charming flirty rogue, high-fantasy swagger, American' },
  { id: 'wo6udizrrtpIxWGp2qJk', owner: '3d1fa6a5595e0a31fff8d7c1a2f2794b91ca87ddd200066dfbdfcef662a65a1b', label: 'Terry', gender: 'male', age: 'young', tags: ['raspy', 'casual', 'upbeat'], vibe: 'eccentric husky lad from the North of England' },
  // picker only (roll: false)
  { id: 'atemG3csutMIyK7AbS5c', owner: '6fa0b9e9f871151a5df4bbb9174ae32f6500655d387ea4a85e15e47a887901c8', label: 'Quang Anh', gender: 'male', age: 'young', roll: false, tags: ['bright', 'calm', 'gentle'], vibe: 'bright and brilliant, calm clarity, American accent' },
  // adult
  { id: 'N2lVS1w4EtoT3dr4eOWO', owner: null, label: 'Callum', gender: 'male', age: 'adult', tags: ['sly', 'raspy', 'dry'], vibe: 'husky trickster, mischief in the gravel, American accent' },
  { id: 'ktrGUw7rURIQyMrQZqCu', owner: 'bb2cf94b50b0c896a7379e353e0cbf14e27975948e820bb6e749f0013e238cc8', label: 'Cassius', gender: 'male', age: 'adult', tags: ['commanding', 'classy', 'wise', 'calm'], vibe: 'velvety, measured and commanding British' },
  { id: 'Xq2dbIWNPChFB77imiDe', owner: 'f426b5e4e149cced75ac3745b8ef7071a45c5e94648bbb4eef3a45c303152e71', label: 'Gideon', gender: 'male', age: 'adult', tags: ['rough', 'sly', 'raspy'], vibe: 'a pirate’s brogue, rough Irish mischief' },
  { id: 'cymHWdiF8WjUCg6vvFxx', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Vane', gender: 'male', age: 'adult', tags: ['rough', 'raspy', 'steady'], vibe: 'rugged and gravelly, weathered outdoorsman, American accent' },
  { id: 'jhBzyKbsdeM6F66SZCaK', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Sterling', gender: 'male', age: 'adult', tags: ['steady', 'deep', 'classy', 'rough'], vibe: 'steady and resonant British' },
  { id: '2ajXGJNYBR0iNHpS4VZb', owner: '465295810ef94f8627fad34ba88551a02745957d1c3b09877a3fc3de528d6f2f', label: 'Rob', gender: 'male', age: 'adult', tags: ['rough', 'steady', 'deep'], vibe: 'tough, calloused British veteran' },
  { id: 'agL69Vji082CshT65Tcy', owner: 'd396af315ee8681a2edbd4739b7c111101366f851614b6d67562a5f62a619e20', label: 'Lance', gender: 'male', age: 'adult', tags: ['sly', 'classy', 'dark'], vibe: 'posh sinister aristocrat, dry ironic drawl, British' },
  { id: 'ljo9gAlSqKOvF6D8sOsX', owner: '0fe52f209ed41586089f6955eebdd52aea973a12de5285ab6101ed2ea46def5c', label: 'Bjorn', gender: 'male', age: 'adult', tags: ['deep', 'rough', 'commanding'], vibe: 'gravelly Viking raider, Nordic accent' },
  { id: 'yjJ45q8TVCrtMhEKurxY', owner: '7d685d7536ae3391b6591c42fe9dbc281640b415005069ea019e870008dd535f', label: 'Von', gender: 'male', age: 'adult', tags: ['excited', 'energetic', 'sly'], vibe: 'quirky mad scientist, manic inventor, American' },
  // picker only (roll: false)
  { id: 'aCF7fSyJwGn1etojgoux', owner: '6b23cb827cffc727ee63533b4d22b384b930ea6d31dd1cf65f49beb14b22ed10', label: 'Kel', gender: 'male', age: 'adult', roll: false, tags: ['calm', 'deep', 'casual'], vibe: 'calm, authentic and deep, unhurried, American accent' },
  // elder
  { id: '0hh7H4ZVAtaGpm1VZyEN', owner: 'fd99b11504e8c1aac6e847ea61616cd450db4e2b1b8aaa196c35d58c85fd9f28', label: 'David', gender: 'male', age: 'elder', tags: ['deep', 'steady', 'rough'], vibe: 'deep Southern cowboy, slow and sure' },
  { id: '6sFKzaJr574YWVu4UuJF', owner: 'a72a436938f959ab051e6a27b035db67a4b75945b4d6e8c86ed40e6e946a2e11', label: 'Cornelius', gender: 'male', age: 'elder', tags: ['wise', 'deep', 'warm'], vibe: 'wise old sage wizard with tales to spin, British' },
  { id: 'ouL9IsyrSnUkCmfnD02u', owner: '9d48e632126e47fa24331617611c4fab3fbb61beadec42067817c28ade5f332f', label: 'Grimble', gender: 'male', age: 'elder', tags: ['raspy', 'dry', 'wise'], vibe: 'high-pitched snarky gnome, grumpy humor with warm wisdom, British' },
  { id: 'MKlLqCItoCkvdhrxgtLv', owner: '675db5c1a341e2f820aefb00825680aa042d958a4a3aef3200735c799210dcb4', label: 'Walt', gender: 'male', age: 'elder', tags: ['dry', 'raspy', 'casual'], vibe: 'cranky old-timer grandpa, sometimes sweet, always honest, American' },

  // ----------------------------------------------------------------- neutral
  { id: 'qXpMhyvQqiRxWQs4qSSB', owner: '4e120f88d43f125a4c1f56885db63990e17568c80c5cca2f9f3a6459230fbeb1', label: 'Horatius', gender: 'neutral', age: 'young', tags: ['energetic', 'confident', 'sly'], vibe: 'over-the-top precocious adventurer or evil genius, American' },
  { id: 'NoiYxL9g25M4orC8Q0ls', owner: '84170eba2e50e0df575fca41c02e69d51200016cc292e0f433bb2b37cea28126', label: 'Vector', gender: 'neutral', age: 'adult', tags: ['robotic', 'professional'], vibe: 'clipped technical synth, machine-precise, American accent' },
  // picker only (roll: false)
  { id: 'M563YhMmA0S8vEYwkgYa', owner: '72d8ea4415caeb85f77dd77de1c9d5e039bb42aae280420cd215e24ef5d6fdbd', label: 'Sammy', gender: 'neutral', age: 'young', roll: false, tags: ['cute', 'warm', 'upbeat'], vibe: 'sweet, warm and quirky, American accent' },
  { id: 'JGzTGubAVbbgG0SsLIlg', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Riley', gender: 'neutral', age: 'young', roll: false, tags: ['upbeat', 'bright', 'raspy'], vibe: 'husky optimism, scratchy and content, American accent' },
];

// Personality seed -> voice tags that suit it. Used as a soft multiplier in
// rollVoice, never a hard filter — every seed still has the whole pool
// available, matching voices are just likelier. Keys must cover
// PERSONALITY_SEEDS (tables.js); a test enforces the mapping stays complete,
// and that every tag a rollable voice carries is reachable from some seed
// ('wise' and 'sassy' joined on 261119, when Kel, River, Aaron and Sigma left
// the roll and 'calm' alone no longer carried stoic/serene characters).
export const SEED_VOICE_TAGS = {
  stoic: ['calm', 'steady', 'deep', 'wise'],
  playful: ['upbeat', 'cute', 'bright', 'sly'],
  blunt: ['rough', 'commanding', 'dry'],
  gentle: ['soft', 'gentle', 'warm'],
  scheming: ['sly', 'classy', 'dark'],
  earnest: ['warm', 'bright', 'confident'],
  'dry-witted': ['dry', 'casual', 'raspy'],
  brooding: ['dark', 'deep', 'raspy'],
  sunny: ['upbeat', 'bright', 'cute'],
  meticulous: ['professional', 'classy', 'steady'],
  reckless: ['energetic', 'excited', 'rough'],
  motherly: ['warm', 'gentle', 'soft'],
  aloof: ['calm', 'classy', 'dry'],
  zealous: ['intense', 'energetic', 'confident'],
  mischievous: ['sly', 'upbeat', 'cute', 'sassy'],
  melancholic: ['soft', 'dark', 'calm'],
  fierce: ['intense', 'rough', 'commanding'],
  timid: ['soft', 'gentle', 'cute'],
  sardonic: ['dry', 'raspy', 'sly', 'sassy'],
  devoted: ['warm', 'steady', 'gentle'],
  restless: ['energetic', 'excited', 'casual'],
  serene: ['calm', 'soft', 'steady', 'wise'],
  proud: ['classy', 'commanding', 'confident'],
  curious: ['bright', 'upbeat', 'excited'],
};
