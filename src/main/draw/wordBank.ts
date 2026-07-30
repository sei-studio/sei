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
  // 动物
  '猫', '狗', '马', '牛', '猪', '羊', '鸭子', '鸡', '猫头鹰', '企鹅',
  '鹦鹉', '老鹰', '蝙蝠', '老鼠', '兔子', '松鼠', '刺猬', '狐狸', '狼', '熊',
  '狮子', '老虎', '斑马', '长颈鹿', '大象', '犀牛', '河马', '骆驼', '袋鼠', '熊猫',
  '猴子', '鹿', '浣熊', '海豹', '鲸鱼', '海豚', '鲨鱼', '章鱼', '鱿鱼', '水母',
  '螃蟹', '龙虾', '虾', '海星', '海马', '蜗牛', '虫子', '蚂蚁', '蜜蜂', '蝴蝶',
  '飞蛾', '瓢虫', '蜘蛛', '蝎子', '蜻蜓', '蚱蜢', '毛毛虫', '青蛙', '乌龟', '蜥蜴',
  '蛇', '鳄鱼', '恐龙', '龙', '独角兽', '美人鱼',
  // 植物和自然
  '树', '椰子树', '仙人掌', '花', '向日葵', '玫瑰', '郁金香', '蘑菇', '叶子', '四叶草',
  '松果', '草', '海草', '珊瑚', '木头', '树枝', '森林', '岛', '山', '火山',
  '洞穴', '悬崖', '瀑布', '河', '湖', '海滩', '沙漠', '冰山', '石头', '峡谷',
  // 天空和天气
  '太阳', '月亮', '星星', '云', '雨', '雪', '雪花', '彩虹', '闪电', '龙卷风',
  '彗星', '星球', '土星', '银河', '日出', '日落', '雾', '水坑', '冰柱', '风',
  // 食物和饮料
  '苹果', '香蕉', '橙子', '葡萄', '草莓', '西瓜', '菠萝', '柠檬', '樱桃', '桃子',
  '梨', '椰子', '牛油果', '胡萝卜', '西兰花', '玉米', '土豆', '西红柿', '洋葱', '辣椒',
  '南瓜', '生菜', '面包', '吐司', '三明治', '汉堡', '热狗', '披萨', '寿司', '面条',
  '汤', '沙拉', '米饭', '鸡蛋', '培根', '奶酪', '黄油', '煎饼', '华夫饼', '甜甜圈',
  '饼干', '蛋糕', '纸杯蛋糕', '派', '冰淇淋', '冰棍', '棒棒糖', '糖果', '巧克力', '爆米花',
  '蜂蜜', '果酱', '咖啡', '茶', '饺子', '包子', '火锅', '粽子', '月饼', '奶茶',
  // 物品
  '椅子', '桌子', '床', '沙发', '灯', '书', '铅笔', '钢笔', '剪刀', '钥匙',
  '锁', '门', '窗户', '梯子', '桶', '扫帚', '雨伞', '眼镜', '帽子', '手套',
  '围巾', '袜子', '鞋子', '靴子', '裙子', '裤子', '衬衫', '外套', '背包', '钱包',
  '手表', '戒指', '皇冠', '手机', '电脑', '键盘', '鼠标', '耳机', '相机', '电视',
  '遥控器', '电池', '灯泡', '蜡烛', '火柴', '锤子', '锯子', '螺丝刀', '扳手', '钉子',
  '斧头', '铲子', '水管', '风筝', '气球', '礼物', '蛋筒', '瓶子', '杯子', '碗',
  '盘子', '筷子', '勺子', '叉子', '刀', '锅', '水壶', '牙刷', '牙膏', '肥皂',
  '毛巾', '镜子', '梳子', '枕头', '毯子', '闹钟', '日历', '信封', '邮票', '地图',
  '旗子', '奖杯', '骰子', '拼图', '积木', '陀螺', '悠悠球', '秋千', '滑梯', '跷跷板',
  // 交通和建筑
  '汽车', '公交车', '卡车', '拖拉机', '摩托车', '自行车', '滑板', '火车', '地铁', '飞机',
  '直升机', '火箭', '飞碟', '热气球', '船', '帆船', '潜水艇', '锚', '灯塔', '桥',
  '房子', '城堡', '塔', '教堂', '帐篷', '小木屋', '风车', '水井', '烟囱', '栅栏',
  '长城', '金字塔', '摩天轮', '过山车', '雕像', '喷泉', '路灯', '红绿灯', '邮箱', '垃圾桶',
  // 人和身体
  '眼睛', '鼻子', '嘴巴', '耳朵', '手', '脚', '牙齿', '头发', '胡子', '骨头',
  '心', '脚印', '拳头', '婴儿', '机器人', '幽灵', '巫师', '国王', '王后', '骑士',
  '海盗', '小丑', '天使', '雪人', '木乃伊', '侦探', '宇航员', '超人',
  // 运动和乐器
  '足球', '篮球', '棒球', '网球', '乒乓球', '保龄球', '飞镖', '钓鱼竿', '滑雪板', '冰鞋',
  '吉他', '钢琴', '小提琴', '鼓', '喇叭', '笛子', '口琴', '麦克风', '铃铛', '哨子',
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
