/**
 * Draw! word bank (260727) — the fixed pool of things to draw.
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
  'fish', 'goldfish', 'hamster', 'guinea pig', 'ferret', 'donkey', 'bull', 'rooster', 'turkey', 'goose',
  'swan', 'llama', 'pigeon', 'seagull', 'crow', 'ostrich', 'toucan', 'pelican', 'hummingbird', 'woodpecker',
  'vulture', 'stork', 'puffin', 'dodo', 'mole', 'badger', 'boar', 'cheetah', 'hyena', 'buffalo',
  'meerkat', 'lemur', 'mammoth', 'polar bear', 'walrus', 'platypus', 'anteater', 'armadillo', 'stingray', 'eel',
  'swordfish', 'clownfish', 'pufferfish', 'narwhal', 'manatee', 'piranha', 'catfish', 'clam', 'sea urchin',
  'chameleon', 'cobra', 'tadpole', 'fly', 'mosquito', 'cockroach', 'cricket', 'firefly', 'centipede',
  'praying mantis',

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

  // occupations. Drawable by outfit or prop; office jobs that all render as
  // "person at desk" (lawyer, programmer, accountant) are left out on purpose.
  'firefighter', 'soldier', 'sailor', 'pilot', 'mailman', 'lifeguard', 'referee', 'doctor', 'nurse', 'dentist',
  'surgeon', 'judge', 'chef', 'baker', 'butcher', 'waiter', 'farmer', 'mechanic', 'plumber', 'carpenter',
  'construction worker', 'janitor', 'lumberjack', 'miner', 'blacksmith', 'shepherd', 'beekeeper', 'zookeeper',
  'bus driver', 'jockey', 'teacher', 'librarian', 'scientist', 'vet', 'detective', 'spy', 'ninja', 'viking',
  'witch', 'superhero', 'caveman', 'magician', 'juggler', 'acrobat', 'ballerina', 'photographer', 'reporter',
  'dj', 'artist', 'singer', 'samurai',

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
 * Pick `count` distinct words. Uniform Fisher-Yates over a copy, so a game
 * never repeats a word and no part of the bank is favoured.
 */
export function pickWords(count: number): string[] {
  const pool = [...WORD_BANK];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}
