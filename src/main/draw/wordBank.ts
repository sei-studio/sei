/**
 * Draw! word bank (260727) â€” the fixed pool of things to draw.
 *
 * Selection rules the list is built to satisfy:
 *   - one or two words, because the guess prompt tells the character the
 *     answer is one or two words;
 *   - drawable as a black line doodle in well under three minutes, with no
 *     reliance on colour, text or fine detail;
 *   - a concrete noun wherever possible, so a guess can be matched literally
 *     (see matchesWord in drawService.ts) rather than semantically;
 *   - nothing that needs cultural or brand knowledge to draw or to guess.
 *
 * The bank is deliberately large so a five-round game (ten turns) never
 * repeats and repeat games stay fresh. Order is irrelevant; pickWords shuffles.
 */

const RAW_WORDS: readonly string[] = [
  // animals
  'cat', 'dog', 'horse', 'cow', 'pig', 'sheep', 'goat', 'duck', 'chicken', 'owl',
  'penguin', 'flamingo', 'peacock', 'parrot', 'eagle', 'bat', 'mouse', 'rabbit',
  'squirrel', 'hedgehog', 'fox', 'wolf', 'bear', 'lion', 'tiger', 'zebra',
  'giraffe', 'elephant', 'rhino', 'hippo', 'camel', 'kangaroo', 'koala', 'panda',
  'monkey', 'gorilla', 'sloth', 'deer', 'moose', 'raccoon', 'skunk', 'beaver',
  'otter', 'seal', 'whale', 'dolphin', 'shark', 'octopus', 'squid', 'jellyfish',
  'crab', 'lobster', 'shrimp', 'starfish', 'seahorse', 'snail', 'slug', 'worm',
  'ant', 'bee', 'wasp', 'butterfly', 'moth', 'ladybug', 'spider', 'scorpion',
  'beetle', 'dragonfly', 'grasshopper', 'caterpillar', 'frog', 'toad', 'turtle',
  'lizard', 'snake', 'crocodile', 'dinosaur', 'dragon', 'unicorn', 'mermaid',

  // plants and nature
  'tree', 'palm tree', 'cactus', 'flower', 'sunflower', 'rose', 'tulip', 'daisy',
  'mushroom', 'leaf', 'clover', 'acorn', 'pinecone', 'grass', 'bush', 'vine',
  'seaweed', 'coral', 'log', 'stump', 'root', 'branch', 'forest', 'island',
  'mountain', 'volcano', 'cave', 'cliff', 'waterfall', 'river', 'lake', 'beach',
  'desert', 'sand dune', 'iceberg', 'glacier', 'rock', 'boulder', 'canyon',

  // sky and weather
  'sun', 'moon', 'star', 'cloud', 'rain', 'snow', 'snowflake', 'rainbow',
  'lightning', 'tornado', 'hurricane', 'comet', 'planet', 'saturn', 'galaxy',
  'eclipse', 'sunrise', 'sunset', 'fog', 'puddle', 'icicle', 'wind',

  // food and drink
  'apple', 'banana', 'orange', 'grapes', 'strawberry', 'watermelon', 'pineapple',
  'lemon', 'cherry', 'peach', 'pear', 'coconut', 'avocado', 'carrot', 'broccoli',
  'corn', 'potato', 'tomato', 'onion', 'pepper', 'pumpkin', 'peas', 'lettuce',
  'bread', 'baguette', 'toast', 'sandwich', 'burger', 'hot dog', 'pizza', 'taco',
  'burrito', 'sushi', 'noodles', 'spaghetti', 'soup', 'salad', 'rice', 'egg',
  'bacon', 'cheese', 'butter', 'pancakes', 'waffle', 'donut', 'cookie', 'cake',
  'cupcake', 'pie', 'ice cream', 'popsicle', 'lollipop', 'candy', 'chocolate',
  'popcorn', 'pretzel', 'french fries', 'honey', 'jam', 'cereal', 'coffee', 'tea',
  'milk', 'juice', 'soda', 'water bottle', 'wine glass', 'mug', 'straw',

  // house and furniture
  'house', 'apartment', 'castle', 'tent', 'igloo', 'barn', 'lighthouse',
  'windmill', 'skyscraper', 'bridge', 'fence', 'gate', 'door', 'window', 'roof',
  'chimney', 'stairs', 'ladder', 'elevator', 'mailbox', 'porch', 'balcony',
  'chair', 'table', 'bed', 'couch', 'lamp', 'bookshelf', 'desk', 'dresser',
  'mirror', 'rug', 'curtain', 'pillow', 'blanket', 'clock', 'painting', 'vase',
  'candle', 'fireplace', 'bathtub', 'shower', 'sink', 'toilet', 'towel', 'soap',
  'toothbrush', 'comb', 'hairdryer', 'trash can', 'broom', 'mop', 'bucket',

  // kitchen and tools
  'fork', 'spoon', 'knife', 'plate', 'bowl', 'cup', 'teapot', 'kettle', 'pot',
  'pan', 'spatula', 'whisk', 'blender', 'toaster', 'oven', 'microwave', 'fridge',
  'hammer', 'screwdriver', 'wrench', 'saw', 'drill', 'nail', 'screw', 'axe',
  'shovel', 'rake', 'scissors', 'tape', 'glue', 'rope', 'chain', 'hook', 'magnet',
  'flashlight', 'battery', 'lightbulb', 'plug', 'key', 'lock', 'padlock',
  'toolbox', 'wheelbarrow', 'watering can', 'paintbrush', 'paint roller',

  // clothing
  'shirt', 'jacket', 'coat', 'sweater', 'pants', 'shorts', 'skirt', 'dress',
  'sock', 'shoe', 'boot', 'sandal', 'hat', 'cap', 'crown', 'helmet', 'scarf',
  'glove', 'mitten', 'belt', 'tie', 'bowtie', 'glasses', 'sunglasses', 'watch',
  'ring', 'necklace', 'earring', 'backpack', 'purse', 'umbrella',
  'apron', 'raincoat', 'swimsuit', 'pocket', 'button', 'zipper', 'shoelace',

  // vehicles and travel
  'car', 'truck', 'bus', 'van', 'taxi', 'ambulance', 'fire truck', 'tractor',
  'bulldozer', 'crane', 'train', 'subway', 'tram', 'bicycle', 'motorcycle',
  'scooter', 'skateboard', 'roller skate', 'wheelchair', 'stroller', 'boat',
  'sailboat', 'canoe', 'kayak', 'ship', 'submarine', 'ferry', 'anchor',
  'airplane', 'helicopter', 'parachute', 'rocket', 'ufo',
  'satellite', 'wheel', 'tire', 'steering wheel', 'traffic light', 'stop sign',
  'road', 'railroad', 'tunnel', 'map', 'compass', 'suitcase', 'passport',

  // music and art
  'guitar', 'violin', 'piano', 'drum', 'trumpet', 'saxophone', 'flute', 'harp',
  'accordion', 'banjo', 'microphone', 'headphones', 'speaker', 'radio',
  'music note', 'record', 'easel', 'palette', 'crayon', 'pencil', 'pen',
  'marker', 'eraser', 'notebook', 'book', 'newspaper', 'envelope', 'stamp',
  'camera', 'film', 'projector', 'stage', 'curtain call', 'mask', 'puppet',

  // sport and play
  'ball', 'soccer ball', 'basketball', 'baseball', 'football', 'tennis ball',
  'golf ball', 'bowling pin', 'racket', 'baseball bat', 'baseball glove', 'hoop',
  'skis', 'snowboard', 'surfboard', 'sled', 'kite', 'yo-yo', 'jump rope',
  'swing', 'slide', 'seesaw', 'trampoline', 'bicycle helmet', 'medal', 'trophy',
  'dice', 'chess piece', 'playing card', 'puzzle piece', 'domino', 'balloon',
  'teddy bear', 'doll', 'robot', 'kite string', 'marbles', 'top', 'whistle',

  // body and people
  'eye', 'ear', 'nose', 'mouth', 'tooth', 'tongue', 'hand', 'foot', 'finger',
  'thumb', 'arm', 'leg', 'knee', 'elbow', 'shoulder', 'hair', 'beard',
  'moustache', 'eyebrow', 'skeleton', 'skull', 'brain', 'heart', 'bone',
  'footprint', 'handprint', 'smile', 'tear', 'shadow', 'ghost', 'angel',
  'wizard', 'knight', 'pirate', 'cowboy', 'astronaut', 'diver', 'clown',
  'snowman', 'scarecrow', 'statue', 'king', 'queen',

  // objects and odds and ends
  'phone', 'laptop', 'computer', 'keyboard', 'mouse pad', 'television',
  'remote', 'game controller', 'calculator', 'printer', 'usb stick',
  'light switch', 'fan', 'heater', 'air conditioner', 'vacuum', 'washing machine',
  'iron', 'sewing machine', 'needle', 'thread', 'yarn', 'basket', 'box',
  'present', 'ribbon', 'bow', 'balloon animal', 'birthday cake', 'candle stick',
  'lantern', 'torch', 'campfire', 'matchstick', 'firework', 'bomb', 'sword',
  'shield', 'arrow', 'slingshot', 'fishing net', 'fishing rod',
  'telescope', 'microscope', 'magnifying glass', 'hourglass', 'scale', 'thermometer',
  'stethoscope', 'bandage', 'crutch', 'pill', 'syringe',
  'wallet', 'coin', 'money', 'piggy bank', 'safe', 'treasure chest', 'crown jewel',
  'ticket', 'sign', 'flag', 'banner', 'trophy case', 'bell', 'horn', 'siren',
  'gear', 'spring', 'pipe', 'faucet', 'hose', 'sponge', 'mirror ball',
  'tombstone', 'well', 'bench', 'streetlight', 'fire hydrant', 'bird house',
  'beehive', 'nest', 'web', 'cage', 'aquarium', 'bone collar', 'leash',
  'saddle', 'horseshoe', 'wagon', 'barrel', 'crate', 'sack', 'jar', 'can',
  'bottle', 'cork', 'funnel', 'ladle', 'grater', 'timer', 'stopwatch',
] as const;

/**
 * Deduped once at load. The list above is grouped by theme for human editing,
 * which makes an accidental repeat across two groups easy to introduce, and a
 * repeat would quietly break pickWords' distinctness guarantee.
 */
export const WORD_BANK: readonly string[] = [...new Set(RAW_WORDS)];

/**
 * 260730: the Chinese bank, used when the character is language-pinned zh
 * (metadata.language). Same selection rules: one word (1-3 characters),
 * drawable as a line doodle, concrete, no culture/brand knowledge needed.
 * Matching is contiguous containment (guessMatch CJK path), so entries must
 * be everyday words the guesser would naturally type in a sentence.
 */
const RAW_WORDS_ZH: readonly string[] = [
  // åŠ¨ç‰©
  'çŒ«', 'ç‹—', 'é©¬', 'ç‰›', 'çŒª', 'ç¾Š', 'é¸­å­', 'é¸¡', 'çŒ«å¤´é¹°', 'ä¼é¹…',
  'é¹¦é¹‰', 'è€é¹°', 'è™è ', 'è€é¼ ', 'å…”å­', 'æ¾é¼ ', 'åˆºçŒ¬', 'ç‹ç‹¸', 'ç‹¼', 'ç†Š',
  'ç‹®å­', 'è€è™Ž', 'æ–‘é©¬', 'é•¿é¢ˆé¹¿', 'å¤§è±¡', 'çŠ€ç‰›', 'æ²³é©¬', 'éª†é©¼', 'è¢‹é¼ ', 'ç†ŠçŒ«',
  'çŒ´å­', 'é¹¿', 'æµ£ç†Š', 'æµ·è±¹', 'é²¸é±¼', 'æµ·è±š', 'é²¨é±¼', 'ç« é±¼', 'é±¿é±¼', 'æ°´æ¯',
  'èžƒèŸ¹', 'é¾™è™¾', 'è™¾', 'æµ·æ˜Ÿ', 'æµ·é©¬', 'èœ—ç‰›', 'è™«å­', 'èš‚èš', 'èœœèœ‚', 'è´è¶',
  'é£žè›¾', 'ç“¢è™«', 'èœ˜è››', 'èŽå­', 'èœ»èœ“', 'èš±èœ¢', 'æ¯›æ¯›è™«', 'é’è›™', 'ä¹Œé¾Ÿ', 'èœ¥èœ´',
  'è›‡', 'é³„é±¼', 'æé¾™', 'é¾™', 'ç‹¬è§’å…½', 'ç¾Žäººé±¼',
  // æ¤ç‰©å’Œè‡ªç„¶
  'æ ‘', 'æ¤°å­æ ‘', 'ä»™äººæŽŒ', 'èŠ±', 'å‘æ—¥è‘µ', 'çŽ«ç‘°', 'éƒé‡‘é¦™', 'è˜‘è‡', 'å¶å­', 'å››å¶è‰',
  'æ¾æžœ', 'è‰', 'æµ·è‰', 'çŠç‘š', 'æœ¨å¤´', 'æ ‘æž', 'æ£®æž—', 'å²›', 'å±±', 'ç«å±±',
  'æ´žç©´', 'æ‚¬å´–', 'ç€‘å¸ƒ', 'æ²³', 'æ¹–', 'æµ·æ»©', 'æ²™æ¼ ', 'å†°å±±', 'çŸ³å¤´', 'å³¡è°·',
  // å¤©ç©ºå’Œå¤©æ°”
  'å¤ªé˜³', 'æœˆäº®', 'æ˜Ÿæ˜Ÿ', 'äº‘', 'é›¨', 'é›ª', 'é›ªèŠ±', 'å½©è™¹', 'é—ªç”µ', 'é¾™å·é£Ž',
  'å½—æ˜Ÿ', 'æ˜Ÿçƒ', 'åœŸæ˜Ÿ', 'é“¶æ²³', 'æ—¥å‡º', 'æ—¥è½', 'é›¾', 'æ°´å‘', 'å†°æŸ±', 'é£Ž',
  // é£Ÿç‰©å’Œé¥®æ–™
  'è‹¹æžœ', 'é¦™è•‰', 'æ©™å­', 'è‘¡è„', 'è‰èŽ“', 'è¥¿ç“œ', 'è è', 'æŸ æª¬', 'æ¨±æ¡ƒ', 'æ¡ƒå­',
  'æ¢¨', 'æ¤°å­', 'ç‰›æ²¹æžœ', 'èƒ¡èåœ', 'è¥¿å…°èŠ±', 'çŽ‰ç±³', 'åœŸè±†', 'è¥¿çº¢æŸ¿', 'æ´‹è‘±', 'è¾£æ¤’',
  'å—ç“œ', 'ç”Ÿèœ', 'é¢åŒ…', 'åå¸', 'ä¸‰æ˜Žæ²»', 'æ±‰å ¡', 'çƒ­ç‹—', 'æŠ«è¨', 'å¯¿å¸', 'é¢æ¡',
  'æ±¤', 'æ²™æ‹‰', 'ç±³é¥­', 'é¸¡è›‹', 'åŸ¹æ ¹', 'å¥¶é…ª', 'é»„æ²¹', 'ç…Žé¥¼', 'åŽå¤«é¥¼', 'ç”œç”œåœˆ',
  'é¥¼å¹²', 'è›‹ç³•', 'çº¸æ¯è›‹ç³•', 'æ´¾', 'å†°æ·‡æ·‹', 'å†°æ£', 'æ£’æ£’ç³–', 'ç³–æžœ', 'å·§å…‹åŠ›', 'çˆ†ç±³èŠ±',
  'èœ‚èœœ', 'æžœé…±', 'å’–å•¡', 'èŒ¶', 'é¥ºå­', 'åŒ…å­', 'ç«é”…', 'ç²½å­', 'æœˆé¥¼', 'å¥¶èŒ¶',
  // ç‰©å“
  'æ¤…å­', 'æ¡Œå­', 'åºŠ', 'æ²™å‘', 'ç¯', 'ä¹¦', 'é“…ç¬”', 'é’¢ç¬”', 'å‰ªåˆ€', 'é’¥åŒ™',
  'é”', 'é—¨', 'çª—æˆ·', 'æ¢¯å­', 'æ¡¶', 'æ‰«å¸š', 'é›¨ä¼ž', 'çœ¼é•œ', 'å¸½å­', 'æ‰‹å¥—',
  'å›´å·¾', 'è¢œå­', 'éž‹å­', 'é´å­', 'è£™å­', 'è£¤å­', 'è¡¬è¡«', 'å¤–å¥—', 'èƒŒåŒ…', 'é’±åŒ…',
  'æ‰‹è¡¨', 'æˆ’æŒ‡', 'çš‡å† ', 'æ‰‹æœº', 'ç”µè„‘', 'é”®ç›˜', 'é¼ æ ‡', 'è€³æœº', 'ç›¸æœº', 'ç”µè§†',
  'é¥æŽ§å™¨', 'ç”µæ± ', 'ç¯æ³¡', 'èœ¡çƒ›', 'ç«æŸ´', 'é”¤å­', 'é”¯å­', 'èžºä¸åˆ€', 'æ‰³æ‰‹', 'é’‰å­',
  'æ–§å¤´', 'é“²å­', 'æ°´ç®¡', 'é£Žç­', 'æ°”çƒ', 'ç¤¼ç‰©', 'è›‹ç­’', 'ç“¶å­', 'æ¯å­', 'ç¢—',
  'ç›˜å­', 'ç­·å­', 'å‹ºå­', 'å‰å­', 'åˆ€', 'é”…', 'æ°´å£¶', 'ç‰™åˆ·', 'ç‰™è†', 'è‚¥çš‚',
  'æ¯›å·¾', 'é•œå­', 'æ¢³å­', 'æž•å¤´', 'æ¯¯å­', 'é—¹é’Ÿ', 'æ—¥åŽ†', 'ä¿¡å°', 'é‚®ç¥¨', 'åœ°å›¾',
  'æ——å­', 'å¥–æ¯', 'éª°å­', 'æ‹¼å›¾', 'ç§¯æœ¨', 'é™€èžº', 'æ‚ æ‚ çƒ', 'ç§‹åƒ', 'æ»‘æ¢¯', 'è··è··æ¿',
  // äº¤é€šå’Œå»ºç­‘
  'æ±½è½¦', 'å…¬äº¤è½¦', 'å¡è½¦', 'æ‹–æ‹‰æœº', 'æ‘©æ‰˜è½¦', 'è‡ªè¡Œè½¦', 'æ»‘æ¿', 'ç«è½¦', 'åœ°é“', 'é£žæœº',
  'ç›´å‡æœº', 'ç«ç®­', 'é£žç¢Ÿ', 'çƒ­æ°”çƒ', 'èˆ¹', 'å¸†èˆ¹', 'æ½œæ°´è‰‡', 'é”š', 'ç¯å¡”', 'æ¡¥',
  'æˆ¿å­', 'åŸŽå ¡', 'å¡”', 'æ•™å ‚', 'å¸ç¯·', 'å°æœ¨å±‹', 'é£Žè½¦', 'æ°´äº•', 'çƒŸå›±', 'æ …æ ',
  'é•¿åŸŽ', 'é‡‘å­—å¡”', 'æ‘©å¤©è½®', 'è¿‡å±±è½¦', 'é›•åƒ', 'å–·æ³‰', 'è·¯ç¯', 'çº¢ç»¿ç¯', 'é‚®ç®±', 'åžƒåœ¾æ¡¶',
  // äººå’Œèº«ä½“
  'çœ¼ç›', 'é¼»å­', 'å˜´å·´', 'è€³æœµ', 'æ‰‹', 'è„š', 'ç‰™é½¿', 'å¤´å‘', 'èƒ¡å­', 'éª¨å¤´',
  'å¿ƒ', 'è„šå°', 'æ‹³å¤´', 'å©´å„¿', 'æœºå™¨äºº', 'å¹½çµ', 'å·«å¸ˆ', 'å›½çŽ‹', 'çŽ‹åŽ', 'éª‘å£«',
  'æµ·ç›—', 'å°ä¸‘', 'å¤©ä½¿', 'é›ªäºº', 'æœ¨ä¹ƒä¼Š', 'ä¾¦æŽ¢', 'å®‡èˆªå‘˜', 'è¶…äºº',
  // è¿åŠ¨å’Œä¹å™¨
  'è¶³çƒ', 'ç¯®çƒ', 'æ£’çƒ', 'ç½‘çƒ', 'ä¹’ä¹“çƒ', 'ä¿é¾„çƒ', 'é£žé•–', 'é’“é±¼ç«¿', 'æ»‘é›ªæ¿', 'å†°éž‹',
  'å‰ä»–', 'é’¢ç´', 'å°æç´', 'é¼“', 'å–‡å­', 'ç¬›å­', 'å£ç´', 'éº¦å…‹é£Ž', 'é“ƒé“›', 'å“¨å­',
];

export const WORD_BANK_ZH: readonly string[] = [...new Set(RAW_WORDS_ZH)];

/**
 * Pick `count` distinct words. Uniform Fisher-Yates over a copy, so a game
 * never repeats a word and no part of the bank is favoured. `language`
 * selects the bank (260730): 'zh' draws from the Chinese bank, anything else
 * from the English one.
 */
export function pickWords(count: number, language?: string): string[] {
  const pool = language === 'zh' ? [...WORD_BANK_ZH] : [...WORD_BANK];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}




