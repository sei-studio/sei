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
//   label  Display name (shown in UI / prompt).
//   gender 'female' | 'male' | 'neutral'. Neutral voices are eligible for any
//          character gender (see rollVoice weighting).
//   age    'young' | 'adult' | 'elder' — coarse apparent-age band.
//   tags   Closed vocabulary matched against SEED_VOICE_TAGS for personality
//          affinity. 'robotic' is special: robotic voices are ONLY eligible
//          for robot-background characters (and are strongly preferred there).
//   vibe   Short prose description fed to the LLM so voice_style matches the
//          actual sound.
//
// All shared voices here are free_users_allowed in the ElevenLabs library
// (checked at curation time) so any tier of account can add them.
//
// 260707: the pool is curated to ElevenLabs use_case 'characters_animation'
// ONLY. Conversational / narration / informative voices read as podcast
// hosts and audiobook narrators, not game companions, and were cut (65 -> 25
// voices; the removed entries are in git history). When adding a voice, check
// its use_case first: GET /v1/voices/{id} -> labels.use_case must be
// 'characters_animation'.

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
  { id: 'tnVKC6NjwhdRxoQIfKue', owner: '0a2b6902206ee5c247450ff82caa110406aedfb7173a54281db01ffe36abe033', label: 'Lyan', gender: 'female', age: 'young', tags: ['casual', 'bright'], vibe: 'casual, natural, girl-next-door, American accent' },
  // adult
  { id: 'WMKg7TxPpPWCryaXE42r', owner: '5214e3d3123945dcad0881d8743a206c4dbc617f34e858e8878c4fd90deb4892', label: 'Cruella', gender: 'female', age: 'adult', tags: ['intense', 'sly', 'classy', 'dark'], vibe: 'dangerously charming, silky menace, theatrical British' },
  { id: '4BAlflaQyhIcCfHiEI7x', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Tess', gender: 'female', age: 'adult', tags: ['wise', 'steady', 'commanding'], vibe: 'direct and grounded, no-nonsense British' },
  { id: 'FCYF8vBfwu11whOhvb94', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Jade', gender: 'female', age: 'adult', tags: ['raspy', 'dry', 'dark', 'casual'], vibe: 'edgy and nonchalant, a raspy shrug of a voice, American accent' },
  { id: 'mrmaApeLxpgZi4RK7oGq', owner: '6ee30dd5a46fe2743d8eb1d6c1528a17cd5557b79bb63e2ffc775efd3cf941d2', label: 'Meaghan', gender: 'female', age: 'adult', tags: ['casual', 'warm'], vibe: 'relaxed, everyday American' },
  // elder
  { id: 'YHcCpa6SBWnKDaCPZJQR', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Mora', gender: 'female', age: 'elder', tags: ['raspy', 'dark', 'wise', 'intense'], vibe: 'gritty and enigmatic, smoke-worn and knowing, American accent' },

  // -------------------------------------------------------------------- male
  // young
  { id: 'SOYHLrjzK2X1ezoPC6cr', owner: null, label: 'Harry', gender: 'male', age: 'young', tags: ['rough', 'intense', 'energetic'], vibe: 'fierce and rough, a young warrior’s bark, American accent' },
  { id: 'wSqOdjeNqDrHcoK0zorF', owner: '59b69ab0c20dacf272109a7a9f65228f6767244c99a93f287eec05754f550f7a', label: 'Lukas', gender: 'male', age: 'young', tags: ['excited', 'upbeat', 'bright', 'energetic'], vibe: 'excited and youthful, bursting with enthusiasm, American accent' },
  { id: 'NXaTw4ifg0LAguvKuIwZ', owner: 'be7f2f07098dc23343bab4a9a1202b290c2456f82b01ebcecea0a8af8a146bd9', label: 'Josh', gender: 'male', age: 'young', tags: ['classy', 'sly', 'confident'], vibe: 'posh British, playfully smug' },
  { id: 'atemG3csutMIyK7AbS5c', owner: '6fa0b9e9f871151a5df4bbb9174ae32f6500655d387ea4a85e15e47a887901c8', label: 'Quang Anh', gender: 'male', age: 'young', tags: ['bright', 'calm', 'gentle'], vibe: 'bright and brilliant, calm clarity, American accent' },
  { id: '5J8HNhWkTAhN2YWsd9Ta', owner: '533f956cf2444e80b69c8f48cd7ba487892379c6754f9019db544a3e1fffae74', label: 'Dev', gender: 'male', age: 'young', tags: ['cute', 'upbeat', 'casual'], vibe: 'lively Korean-accented streamer, boyish charm' },
  { id: 'gUU37agQvEpxeWrZUIMk', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Alaric', gender: 'male', age: 'young', tags: ['intense', 'dark', 'classy'], vibe: 'intense and theatrical, every line a stage, American accent' },
  // adult
  { id: 'N2lVS1w4EtoT3dr4eOWO', owner: null, label: 'Callum', gender: 'male', age: 'adult', tags: ['sly', 'raspy', 'dry'], vibe: 'husky trickster, mischief in the gravel, American accent' },
  { id: 'ktrGUw7rURIQyMrQZqCu', owner: 'bb2cf94b50b0c896a7379e353e0cbf14e27975948e820bb6e749f0013e238cc8', label: 'Cassius', gender: 'male', age: 'adult', tags: ['commanding', 'classy', 'wise', 'calm'], vibe: 'velvety, measured and commanding British' },
  { id: 'Xq2dbIWNPChFB77imiDe', owner: 'f426b5e4e149cced75ac3745b8ef7071a45c5e94648bbb4eef3a45c303152e71', label: 'Gideon', gender: 'male', age: 'adult', tags: ['rough', 'sly', 'raspy'], vibe: 'a pirate’s brogue, rough Irish mischief' },
  { id: '7squ7rvxEIZ2rYy7KYPP', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Malakai', gender: 'male', age: 'adult', tags: ['raspy', 'dark', 'intense'], vibe: 'shadowed and gruff, low menace, American accent' },
  { id: 'cymHWdiF8WjUCg6vvFxx', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Vane', gender: 'male', age: 'adult', tags: ['rough', 'raspy', 'steady'], vibe: 'rugged and gravelly, weathered outdoorsman, American accent' },
  { id: 'jhBzyKbsdeM6F66SZCaK', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Sterling', gender: 'male', age: 'adult', tags: ['steady', 'deep', 'classy', 'rough'], vibe: 'steady and resonant British' },
  { id: 'aCF7fSyJwGn1etojgoux', owner: '6b23cb827cffc727ee63533b4d22b384b930ea6d31dd1cf65f49beb14b22ed10', label: 'Kel', gender: 'male', age: 'adult', tags: ['calm', 'deep', 'casual'], vibe: 'calm, authentic and deep, unhurried, American accent' },
  { id: 'bAq8AI9QURijOtmeFFqT', owner: 'b70fb323818c15577a8d8626a1f514d62fd3572497d33722a5dcb724524192c9', label: 'Sigma', gender: 'male', age: 'adult', tags: ['robotic', 'calm', 'steady'], vibe: 'an AI’s even cadence, synthetic calm, American accent' },
  { id: 'NoiYxL9g25M4orC8Q0ls', owner: '84170eba2e50e0df575fca41c02e69d51200016cc292e0f433bb2b37cea28126', label: 'Vector', gender: 'male', age: 'adult', tags: ['robotic', 'professional'], vibe: 'clipped technical synth, machine-precise, American accent' },
  // elder
  { id: 'M5E055lOUxMi0kJpGyE9', owner: '72026985ddcf2e1b6cf05e05a8d5dc2e4d1b644e967553f8f6bf36210739d9a5', label: 'Gravel', gender: 'male', age: 'elder', tags: ['rough', 'raspy', 'dark', 'deep'], vibe: 'deep grit, midnight rasp, British accent' },
  { id: '507tTFX0IPtqFzGd1CAL', owner: '84170eba2e50e0df575fca41c02e69d51200016cc292e0f433bb2b37cea28126', label: 'Rusty', gender: 'male', age: 'elder', tags: ['casual', 'dry', 'raspy'], vibe: 'weathered and folksy, porch-chair drawl' },
  { id: '0hh7H4ZVAtaGpm1VZyEN', owner: 'fd99b11504e8c1aac6e847ea61616cd450db4e2b1b8aaa196c35d58c85fd9f28', label: 'David', gender: 'male', age: 'elder', tags: ['deep', 'steady', 'rough'], vibe: 'deep Southern cowboy, slow and sure' },

];

// Personality seed -> voice tags that suit it. Used as a soft multiplier in
// rollVoice, never a hard filter — every seed still has the whole pool
// available, matching voices are just likelier. Keys must cover
// PERSONALITY_SEEDS (tables.js); a test enforces the mapping stays complete.
export const SEED_VOICE_TAGS = {
  stoic: ['calm', 'steady', 'deep'],
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
  mischievous: ['sly', 'upbeat', 'cute'],
  melancholic: ['soft', 'dark', 'calm'],
  fierce: ['intense', 'rough', 'commanding'],
  timid: ['soft', 'gentle', 'cute'],
  sardonic: ['dry', 'raspy', 'sly'],
  devoted: ['warm', 'steady', 'gentle'],
  restless: ['energetic', 'excited', 'casual'],
  serene: ['calm', 'soft', 'steady'],
  proud: ['classy', 'commanding', 'confident'],
  curious: ['bright', 'upbeat', 'excited'],
};
