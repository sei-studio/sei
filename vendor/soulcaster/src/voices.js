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

export const VOICE_TAGS = [
  'warm', 'soft', 'gentle', 'calm', 'steady', 'deep', 'bright', 'upbeat',
  'cute', 'energetic', 'excited', 'rough', 'raspy', 'dark', 'intense', 'sly',
  'dry', 'casual', 'classy', 'commanding', 'confident', 'professional',
  'sassy', 'wise', 'robotic',
];

export const VOICES = [
  // ------------------------------------------------------------------ female
  // young
  { id: 'EXAVITQu4vr4xnSDxMaL', owner: null, label: 'Sarah', gender: 'female', age: 'young', tags: ['confident', 'warm', 'steady', 'professional'], vibe: 'reassuring and confident, a young voice with mature composure, American accent' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', owner: null, label: 'Laura', gender: 'female', age: 'young', tags: ['sassy', 'upbeat', 'energetic'], vibe: 'enthusiastic with a quirky, sassy attitude, American accent' },
  { id: 'cgSgspJ2msm6clMCkdW9', owner: null, label: 'Jessica', gender: 'female', age: 'young', tags: ['cute', 'bright', 'upbeat', 'warm'], vibe: 'playful, bright and warm, American accent' },
  { id: 'tpS5zOAgWUiQMhzYbG2h', owner: 'f745fefd052c8699003ea6c949d21e18090f4818b199ddecd057f35b62d418c1', label: 'Sapphire', gender: 'female', age: 'young', tags: ['cute', 'classy', 'gentle'], vibe: 'well-mannered, smooth and clean, softly British' },
  { id: 'm0MqfGOWTAfVVEaz4KxX', owner: 'a937f4da3109e25e3b44d742d0216fc0938a0dff7cbeb850fdc4bc7e6a725927', label: 'Alexandra', gender: 'female', age: 'young', tags: ['calm', 'soft', 'classy'], vibe: 'calm and collected with a light British lilt' },
  { id: 'MJqcNjMbvfGUxatGjPcI', owner: '5539983ff5d908f497d64bd46fb33f4d8470c72507dfcf0a93f08e8c8922d5de', label: 'Daisy', gender: 'female', age: 'young', tags: ['upbeat', 'bright', 'cute'], vibe: 'upbeat and cheery, young British' },
  { id: 'Y0G5nEDw2qHnUHGmtoM9', owner: 'c89e19f9d2383eff6abc6e3b15773564d04f64a90de81e22f1f218afa9a2d540', label: 'Boo', gender: 'female', age: 'young', tags: ['soft', 'warm', 'gentle'], vibe: 'soft, warm and expressive, American accent' },
  { id: 'FNhoq0qHG3T8YOWzBtd6', owner: '941f1f501fbba05614a17d087fed1008a6ce594f34808b6b8d981fa348a04dbd', label: 'Allison', gender: 'female', age: 'young', tags: ['sassy', 'energetic', 'rough'], vibe: 'a cowgirl drawl, sassy Southern twang' },
  { id: 'tnVKC6NjwhdRxoQIfKue', owner: '0a2b6902206ee5c247450ff82caa110406aedfb7173a54281db01ffe36abe033', label: 'Lyan', gender: 'female', age: 'young', tags: ['casual', 'bright'], vibe: 'casual, natural, girl-next-door, American accent' },
  // adult
  { id: 'Xb7hH8MSUJpSbSDYk0k2', owner: null, label: 'Alice', gender: 'female', age: 'adult', tags: ['professional', 'bright', 'confident'], vibe: 'clear and engaging, crisp British educator' },
  { id: 'XrExE9yKIg1WjnnlVkGX', owner: null, label: 'Matilda', gender: 'female', age: 'adult', tags: ['professional', 'upbeat', 'warm'], vibe: 'knowledgeable and friendly, upbeat professional, American accent' },
  { id: 'hpp4J3VqNfWAUOO0d1Us', owner: null, label: 'Bella', gender: 'female', age: 'adult', tags: ['warm', 'bright', 'professional'], vibe: 'bright, warm and polished, American accent' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', owner: null, label: 'Lily', gender: 'female', age: 'adult', tags: ['classy', 'confident', 'soft'], vibe: 'velvety and theatrical, confident British actress' },
  { id: 'FF59babHL8N8gfTgtBMT', owner: 'b955a4bb67e72ec37c93539f5affc5054b2cef725a611a8111e5364f04136a27', label: 'Jodi', gender: 'female', age: 'adult', tags: ['professional', 'steady', 'calm'], vibe: 'clear, measured British' },
  { id: 'DIS307HFaAvJZzq496qM', owner: 'e3f59c5c065dae143d73d51c5a4a6fa45d1f39e239c78b3fc1557a641de97381', label: 'Cecilia', gender: 'female', age: 'adult', tags: ['warm', 'casual', 'gentle'], vibe: 'warm, easy conversational tone, American accent' },
  { id: 'vHMylH8q68M5Wk9WkVr1', owner: 'e3f59c5c065dae143d73d51c5a4a6fa45d1f39e239c78b3fc1557a641de97381', label: 'Claudia', gender: 'female', age: 'adult', tags: ['upbeat', 'bright', 'energetic'], vibe: 'bright and quirky, quick to laugh, American accent' },
  { id: 'WMKg7TxPpPWCryaXE42r', owner: '5214e3d3123945dcad0881d8743a206c4dbc617f34e858e8878c4fd90deb4892', label: 'Cruella', gender: 'female', age: 'adult', tags: ['intense', 'sly', 'classy', 'dark'], vibe: 'dangerously charming, silky menace, theatrical British' },
  { id: '4BAlflaQyhIcCfHiEI7x', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Tess', gender: 'female', age: 'adult', tags: ['wise', 'steady', 'commanding'], vibe: 'direct and grounded, no-nonsense British' },
  { id: 'FCYF8vBfwu11whOhvb94', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Jade', gender: 'female', age: 'adult', tags: ['raspy', 'dry', 'dark', 'casual'], vibe: 'edgy and nonchalant, a raspy shrug of a voice, American accent' },
  { id: 'mrmaApeLxpgZi4RK7oGq', owner: '6ee30dd5a46fe2743d8eb1d6c1528a17cd5557b79bb63e2ffc775efd3cf941d2', label: 'Meaghan', gender: 'female', age: 'adult', tags: ['casual', 'warm'], vibe: 'relaxed, everyday American' },
  { id: 'u6a6bRv82Zfi9NzoIqvt', owner: 'c175136d2654486b92e9a2c2e83bc31dee510255df7d5e5d6c7e729234851d99', label: 'Lia', gender: 'female', age: 'adult', tags: ['calm', 'gentle', 'warm'], vibe: 'clear and calm, Japanese-accented English' },
  // elder
  { id: 'xIzR6egd3S3LJZbVW0c1', owner: 'a94a9f377c73aede55c18062ec4a353157e2898a7f0dcb96bbb492b6084a0e87', label: 'Margaret', gender: 'female', age: 'elder', tags: ['gentle', 'warm', 'calm'], vibe: 'a sweet little old lady, gentle and unhurried, American accent' },
  { id: '2qQJWjw5XdG80GreshqG', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Eleanor', gender: 'female', age: 'elder', tags: ['classy', 'commanding', 'wise', 'calm'], vibe: 'gracious and authoritative, aged British elegance' },
  { id: 'YHcCpa6SBWnKDaCPZJQR', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Mora', gender: 'female', age: 'elder', tags: ['raspy', 'dark', 'wise', 'intense'], vibe: 'gritty and enigmatic, smoke-worn and knowing, American accent' },
  { id: 'wGcFBfKz5yUQqhqr0mVy', owner: '38ce59162eff3a60d0f238a254659263b013e077722cc3c4b152a249ee9ce83a', label: 'Maria', gender: 'female', age: 'elder', tags: ['warm', 'gentle', 'wise', 'calm'], vibe: 'grandmotherly storykeeper, warm and steady, American accent' },

  // -------------------------------------------------------------------- male
  // young
  { id: 'IKne3meq5aSn9XLyUdCD', owner: null, label: 'Charlie', gender: 'male', age: 'young', tags: ['energetic', 'confident', 'deep'], vibe: 'deep, confident and energetic Australian' },
  { id: 'SOYHLrjzK2X1ezoPC6cr', owner: null, label: 'Harry', gender: 'male', age: 'young', tags: ['rough', 'intense', 'energetic'], vibe: 'fierce and rough, a young warrior’s bark, American accent' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', owner: null, label: 'Liam', gender: 'male', age: 'young', tags: ['confident', 'upbeat', 'energetic'], vibe: 'energetic and social, fast-talking creator energy, American accent' },
  { id: 'bIHbv24MWmeRgasZH58o', owner: null, label: 'Will', gender: 'male', age: 'young', tags: ['casual', 'calm', 'warm'], vibe: 'relaxed optimist, easygoing and friendly, American accent' },
  { id: 'wSqOdjeNqDrHcoK0zorF', owner: '59b69ab0c20dacf272109a7a9f65228f6767244c99a93f287eec05754f550f7a', label: 'Lukas', gender: 'male', age: 'young', tags: ['excited', 'upbeat', 'bright', 'energetic'], vibe: 'excited and youthful, bursting with enthusiasm, American accent' },
  { id: 'NXaTw4ifg0LAguvKuIwZ', owner: 'be7f2f07098dc23343bab4a9a1202b290c2456f82b01ebcecea0a8af8a146bd9', label: 'Josh', gender: 'male', age: 'young', tags: ['classy', 'sly', 'confident'], vibe: 'posh British, playfully smug' },
  { id: 'atemG3csutMIyK7AbS5c', owner: '6fa0b9e9f871151a5df4bbb9174ae32f6500655d387ea4a85e15e47a887901c8', label: 'Quang Anh', gender: 'male', age: 'young', tags: ['bright', 'calm', 'gentle'], vibe: 'bright and brilliant, calm clarity, American accent' },
  { id: '5J8HNhWkTAhN2YWsd9Ta', owner: '533f956cf2444e80b69c8f48cd7ba487892379c6754f9019db544a3e1fffae74', label: 'Dev', gender: 'male', age: 'young', tags: ['cute', 'upbeat', 'casual'], vibe: 'lively Korean-accented streamer, boyish charm' },
  { id: 'gUU37agQvEpxeWrZUIMk', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Alaric', gender: 'male', age: 'young', tags: ['intense', 'dark', 'classy'], vibe: 'intense and theatrical, every line a stage, American accent' },
  // adult
  { id: 'CwhRBWXzGAHq8TQ4Fs17', owner: null, label: 'Roger', gender: 'male', age: 'adult', tags: ['casual', 'deep', 'dry', 'classy'], vibe: 'laid-back, casual and resonant, American accent' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', owner: null, label: 'George', gender: 'male', age: 'adult', tags: ['warm', 'wise', 'classy'], vibe: 'warm captivating storyteller, rich British' },
  { id: 'N2lVS1w4EtoT3dr4eOWO', owner: null, label: 'Callum', gender: 'male', age: 'adult', tags: ['sly', 'raspy', 'dry'], vibe: 'husky trickster, mischief in the gravel, American accent' },
  { id: 'cjVigY5qzO86Huf0OWal', owner: null, label: 'Eric', gender: 'male', age: 'adult', tags: ['calm', 'classy', 'confident'], vibe: 'smooth and trustworthy, American accent' },
  { id: 'iP95p4xoKVk53GoZ742B', owner: null, label: 'Chris', gender: 'male', age: 'adult', tags: ['casual', 'warm'], vibe: 'charming and down-to-earth, American accent' },
  { id: 'nPczCjzI2devNBz1zQrb', owner: null, label: 'Brian', gender: 'male', age: 'adult', tags: ['deep', 'calm', 'steady', 'classy'], vibe: 'deep, resonant and comforting, American accent' },
  { id: 'onwK4e9ZLuTAKqWW03F9', owner: null, label: 'Daniel', gender: 'male', age: 'adult', tags: ['professional', 'steady', 'commanding', 'classy'], vibe: 'steady British broadcaster, formal and clear' },
  { id: 'pNInz6obpgDQGcFmaJgB', owner: null, label: 'Adam', gender: 'male', age: 'adult', tags: ['commanding', 'intense', 'deep'], vibe: 'dominant and firm, American accent' },
  { id: 'ktrGUw7rURIQyMrQZqCu', owner: 'bb2cf94b50b0c896a7379e353e0cbf14e27975948e820bb6e749f0013e238cc8', label: 'Cassius', gender: 'male', age: 'adult', tags: ['commanding', 'classy', 'wise', 'calm'], vibe: 'velvety, measured and commanding British' },
  { id: 'Xq2dbIWNPChFB77imiDe', owner: 'f426b5e4e149cced75ac3745b8ef7071a45c5e94648bbb4eef3a45c303152e71', label: 'Gideon', gender: 'male', age: 'adult', tags: ['rough', 'sly', 'raspy'], vibe: 'a pirate’s brogue, rough Irish mischief' },
  { id: '7squ7rvxEIZ2rYy7KYPP', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Malakai', gender: 'male', age: 'adult', tags: ['raspy', 'dark', 'intense'], vibe: 'shadowed and gruff, low menace, American accent' },
  { id: 'cymHWdiF8WjUCg6vvFxx', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Vane', gender: 'male', age: 'adult', tags: ['rough', 'raspy', 'steady'], vibe: 'rugged and gravelly, weathered outdoorsman, American accent' },
  { id: 'jhBzyKbsdeM6F66SZCaK', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Sterling', gender: 'male', age: 'adult', tags: ['steady', 'deep', 'classy', 'rough'], vibe: 'steady and resonant British' },
  { id: 'enzbGixeo55iqn1QxbbC', owner: 'b45c1524a1f360319535f16b301e5b6f37edf26fd1d59861eda66206ff25cdc9', label: 'Jon', gender: 'male', age: 'adult', tags: ['calm', 'steady', 'gentle'], vibe: 'calm presence, quiet reassurance, American accent' },
  { id: 'pCL8Ua4MoAGISUaDmw69', owner: 'e334d26c2e9dee52ae815c6dc3b4e6ebc05e94046f1382a825b82813aad95d5c', label: 'Miller', gender: 'male', age: 'adult', tags: ['casual', 'warm', 'dry'], vibe: 'relatable dad vibe, comfortable and wry, American accent' },
  { id: 'aCF7fSyJwGn1etojgoux', owner: '6b23cb827cffc727ee63533b4d22b384b930ea6d31dd1cf65f49beb14b22ed10', label: 'Kel', gender: 'male', age: 'adult', tags: ['calm', 'deep', 'casual'], vibe: 'calm, authentic and deep, unhurried, American accent' },
  { id: 'bAq8AI9QURijOtmeFFqT', owner: 'b70fb323818c15577a8d8626a1f514d62fd3572497d33722a5dcb724524192c9', label: 'Sigma', gender: 'male', age: 'adult', tags: ['robotic', 'calm', 'steady'], vibe: 'an AI’s even cadence, synthetic calm, American accent' },
  { id: 'NoiYxL9g25M4orC8Q0ls', owner: '84170eba2e50e0df575fca41c02e69d51200016cc292e0f433bb2b37cea28126', label: 'Vector', gender: 'male', age: 'adult', tags: ['robotic', 'professional'], vibe: 'clipped technical synth, machine-precise, American accent' },
  // elder
  { id: 'pqHfZKP75CvOlQylNhV4', owner: null, label: 'Bill', gender: 'male', age: 'elder', tags: ['wise', 'steady', 'calm', 'bright'], vibe: 'wise, mature and balanced, crisp diction, American accent' },
  { id: 'PerZoH0r6nxBZXCoIPpv', owner: '7b9cf99b1fe258205c832232c860ee10e107124014583b23066e7b84730df696', label: 'Michael', gender: 'male', age: 'elder', tags: ['warm', 'deep', 'gentle', 'wise'], vibe: 'grandfatherly, warm and deep, American accent' },
  { id: 'UzI1NsMEV3ni5JRkRSls', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Alistair', gender: 'male', age: 'elder', tags: ['classy', 'wise', 'professional'], vibe: 'cultured and articulate, aged British scholar' },
  { id: 'M5E055lOUxMi0kJpGyE9', owner: '72026985ddcf2e1b6cf05e05a8d5dc2e4d1b644e967553f8f6bf36210739d9a5', label: 'Gravel', gender: 'male', age: 'elder', tags: ['rough', 'raspy', 'dark', 'deep'], vibe: 'deep grit, midnight rasp, British accent' },
  { id: '507tTFX0IPtqFzGd1CAL', owner: '84170eba2e50e0df575fca41c02e69d51200016cc292e0f433bb2b37cea28126', label: 'Rusty', gender: 'male', age: 'elder', tags: ['casual', 'dry', 'raspy'], vibe: 'weathered and folksy, porch-chair drawl' },
  { id: 'RcEmXcISaHUgHOU4uNTz', owner: '4d558654544071fcfeaba0aa7b7014f69faa40c4d9d5c2cb8aebfd331a0721ac', label: 'Hansi', gender: 'male', age: 'elder', tags: ['gentle', 'warm', 'calm'], vibe: 'kind Swedish grandpa, soft accented warmth' },
  { id: '0hh7H4ZVAtaGpm1VZyEN', owner: 'fd99b11504e8c1aac6e847ea61616cd450db4e2b1b8aaa196c35d58c85fd9f28', label: 'David', gender: 'male', age: 'elder', tags: ['deep', 'steady', 'rough'], vibe: 'deep Southern cowboy, slow and sure' },

  // ----------------------------------------------------------------- neutral
  { id: 'SAz9YHcvj6GT2YYXdXww', owner: null, label: 'River', gender: 'neutral', age: 'adult', tags: ['calm', 'casual', 'steady'], vibe: 'relaxed, neutral and informative, American accent' },
  { id: 'M563YhMmA0S8vEYwkgYa', owner: '72d8ea4415caeb85f77dd77de1c9d5e039bb42aae280420cd215e24ef5d6fdbd', label: 'Sammy', gender: 'neutral', age: 'young', tags: ['cute', 'warm', 'upbeat'], vibe: 'sweet, warm and quirky, American accent' },
  { id: 'JGzTGubAVbbgG0SsLIlg', owner: '64cbc624eb5aab4e95a968e1f41d75402277cca6e549036ed17e56ea33bbbc9e', label: 'Riley', gender: 'neutral', age: 'young', tags: ['upbeat', 'bright', 'raspy'], vibe: 'husky optimism, scratchy and content, American accent' },
  { id: 'Z9VxF84ucVtzvKlmYFhh', owner: '896c30d5b4e54ce4e58ad93dd5dd5c0c615976a5503741f047fbf6b1ac977a5f', label: 'Ramona', gender: 'neutral', age: 'young', tags: ['casual', 'dry'], vibe: 'casual and unbothered, American accent' },
  { id: 'YKlogvnVogI4aFHoGIEw', owner: 'ad827f2c0300d36094ca79e518b1a5df8c3609eb269353c30dcec3ac8878a437', label: 'Aaron', gender: 'neutral', age: 'adult', tags: ['deep', 'calm', 'confident'], vibe: 'deep, smooth and confident, American accent' },
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
