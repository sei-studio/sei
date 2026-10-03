/** Game surfaces (chess + Draw!). See ../zh.ts for the dictionary rules. */
export const ZH_GAMES: Record<string, string> = {
  // ── Game packs (260908, components/games/GamePackCard) ───────────────────
  'Download {name} support (about {size})': '下载 {name} 支持文件（约 {size}）',
  'Download ({size})': '下载（{size}）',
  'Playing {name} together needs a one-time download. It is stored on this device and only downloads again after an update that needs a newer version.':
    '一起玩 {name} 需要一次性下载支持文件。文件会保存在这台设备上，只有更新后需要新版本时才会再次下载。',
  'Downloading {name} support…': '正在下载 {name} 支持文件…',
  '{name} support download, {pct} percent': '{name} 支持文件下载进度 {pct}%',
  '{received} of {total}': '{received} / {total}',
  "Couldn't download {name} support": '无法下载 {name} 支持文件',
  // ── Mini tile (bottom-right return tile) ──────────────────────────────────
  'Back to game': '返回游戏',
  'Draw!': '你画我猜！',
  // ── Vision gate (china-compat W9) ─────────────────────────────────────────
  'Draw! needs a model that can see images. Your current model ({model}) does not support vision.':
    '你画我猜需要能看懂图像的模型。你当前的模型（{model}）不支持视觉能力。',
  'Draw! needs a model that can see images. Your current model does not support vision.':
    '你画我猜需要能看懂图像的模型。你当前的模型不支持视觉能力。',
  // ── Chess: launch screen ──────────────────────────────────────────────────
  'Chess': '国际象棋',
  'Chess with {name}': '与{name}下棋',
  'Companion': '伙伴',
  'White': '白方',
  'Random': '随机',
  'Black': '黑方',
  'Your side': '你的执子',
  // 'Launch' lives in chatui.ts ('启动'): the key is shared with the
  // Minecraft launch button, so the value must fit both surfaces.
  'Start': '开始',
  'Starting…': '正在开始…',
  'Try again': '再试一次',
  'Setting up the chess brain (one-time download).': '正在准备国际象棋引擎（仅需下载一次）。',
  'Chess engine download progress': '国际象棋引擎下载进度',
  // 'The download failed...' moved to common.ts (shared with the W6 pack panels).
  'The chess brain failed to download. Check your connection and try again.':
    '国际象棋引擎下载失败。请检查网络后重试。',
  "The chess brain couldn't start. Try again in a moment.": '国际象棋引擎无法启动。请稍后再试。',
  'Chess is not available in this build yet.': '此版本暂不支持国际象棋。',
  "The game couldn't start. Try again in a moment.": '对局无法开始。请稍后再试。',

  // ── Chess: in-game HUD ────────────────────────────────────────────────────
  'Game controls': '对局控制',
  'Flip board': '翻转棋盘',
  'Offer draw': '提和',
  'Resign': '认输',
  'Resign?': '认输？',
  'Yes': '是',
  'No': '否',
  'Captured by white': '白方吃掉的棋子',
  'Captured by black': '黑方吃掉的棋子',
  'No moves yet': '还没有着法',
  'Back to live': '回到当前局面',
  '{name} offers a draw': '{name}提议和棋',
  'Accept': '接受',
  'Decline': '拒绝',
  'Draw offer sent': '和棋提议已发出',
  'Rematch': '再来一局',
  'Chess board': '棋盘',
  'Your move': '轮到你了',
  "{name}'s move": '轮到{name}',
  '{name} is thinking…': '{name}正在思考…',
  'Elo ~{elo}': '等级分约 {elo}',
  'Promote to': '升变为',
  'Promote to queen': '升变为后',
  'Promote to knight': '升变为马',
  'Promote to rook': '升变为车',
  'Promote to bishop': '升变为象',

  // ── Chess: results ────────────────────────────────────────────────────────
  'Draw': '和棋',
  'You won': '你赢了',
  '{name} won': '{name}赢了',
  'Checkmate.': '将杀。',
  'Stalemate. No legal moves left.': '逼和。没有合法着法了。',
  'You both agreed to a draw.': '你们同意和棋。',
  'Not enough pieces left to checkmate.': '剩余棋子不足以将杀。',
  'The same position repeated three times.': '同一局面重复出现了三次。',
  'Fifty moves without a capture or pawn move.': '连续五十回合没有吃子或动兵。',
  'You resigned. {name} takes the game.': '你认输了。这局归{name}。',
  '{name} forfeited the game.': '{name}弃权认负。',
  'Game closed': '对局已关闭',
  'This game ended without a result.': '这局没有分出结果就结束了。',

  // ── Chess: Minecraft conflict modal ───────────────────────────────────────
  '{name} is in Minecraft': '{name}正在 Minecraft 中',
  '{name} is playing in a Minecraft world right now. Disconnect them from the world to start a chess game?':
    '{name}正在一个 Minecraft 世界里游玩。要将其断开连接并开始下棋吗？',
  'Disconnect and play': '断开并开始',

  // ── Chess: replay ─────────────────────────────────────────────────────────
  'Chess replay with {name}': '与{name}的对局回放',
  'Replay controls': '回放控制',
  'No moves': '没有着法',
  'Final position': '最终局面',

  // ── Draw!: setup + pick ───────────────────────────────────────────────────
  'DRAW!': '你画我猜！',
  'A hand-drawn shrimp': '一只手绘的虾',
  'A hand-drawn crown': '一顶手绘的王冠',
  'A hand-drawn horse': '一匹手绘的马',
  'Take turns drawing and guessing. Three rounds.': '轮流画画和猜词。一共三轮。',
  '{name} draws first, you guess. Then it is your turn. One quick round.': '{name}先画，你来猜。然后轮到你画。只玩一轮。',
  'Start!': '开始！',
  'Starting...': '正在开始...',
  'Leave Draw!': '退出你画我猜',
  'Leave': '离开',
  'Pick a word': '选一个词',

  // ── Draw!: in-game ────────────────────────────────────────────────────────
  'Round {n}/{m}': '第 {n}/{m} 轮',
  'It was "{word}"': '答案是“{word}”',
  'Turn over': '回合结束',
  '{name} is drawing': '{name}正在画',
  'game paused': '游戏已暂停',
  'usage limit reached. top up or wait, then resume: the turn picks up right where it stopped.':
    '已达到用量上限。充值或稍等片刻后继续：回合会从停下的地方接着进行。',
  // 260926: the credit-wall variant of the pause card. The reset line between
  // these two comes from src/shared/freePlayReset.ts.
  "you're out of playtime for now, so {name} can't draw or guess.":
    '你的游玩时间暂时用完了，{name}现在没法画画或猜词。',
  'top up and resume, or end the game and keep your drawings.':
    '充值后可以继续，也可以现在结束游戏并保留你们的画。',
  // Shared with CreditsScreen's resume-plan button, so the value must fit
  // both "resume the paused game" and "resume the plan".
  'Resume': '恢复',
  'Pen': '画笔',
  'Stroke eraser': '笔画橡皮',
  'Eraser (removes a whole stroke)': '橡皮（擦除整条笔画）',
  'Say something': '说点什么',
  'Type your guess': '输入你的猜测',
  'Talk while you draw': '边画边聊',
  'Chat and guesses': '聊天和猜词',

  // ── Draw!: gallery ────────────────────────────────────────────────────────
  'you': '你',
  'Saving...': '正在保存...',
  'Save to Downloads': '保存到下载文件夹',
  'Play again': '再玩一局',
  'Saved to {path}': '已保存到 {path}',
  'Saved!': '已保存！',
  'The saved picture': '保存的图片',
  // The caption on a single drawing's share tile. {word} is left in place by
  // the caller so the composer can put the highlighter behind the word alone,
  // and {a} is the English article, which Chinese simply drops.
  'according to {name}, this is {a} {word}.': '据{name}说，这是{word}。',

  // ── Game adapters (M0, 260908): generic bot-backed game surfaces ─────────
  // components/games/GenericGamePanels.tsx
  'Your world is open. Press Play to bring your companion in.': '你的世界已经打开。点击「一起玩」让伙伴加入。',
  'Open your world in {game} first, then press Play.': '请先在 {game} 中打开你的世界，然后点击「一起玩」。',
  'Playing': '游戏中',
  // screens/ChatScreen.tsx (per-game aside label)
  '{game} dashboard': '{game} 面板',
  // components/GameSetupModal.tsx
  'Open your {game} world': '打开你的 {game} 世界',
  'Sei could not find an open {game} world. Open your world in the game with the Sei mod enabled; your companion joins as soon as it appears.':
    'Sei 没有找到已打开的 {game} 世界。请在游戏中启用 Sei 模组并打开你的世界，伙伴会在世界出现后立即加入。',
  'Sei keeps looking while this window is open.': '这个窗口打开期间，Sei 会持续查找。',
  // components/GameErrorModal.tsx
  "{name} couldn't join {game}": '{name}无法加入 {game}',
  // The one-step setup window on the launch panels (components/games/SetupStepper.tsx, 260909).
  'Step {n} of {m}': '第 {n} 步，共 {m} 步',
  'Waiting for your farm...': '等待你的农场…',
  // Game dashboards, companions in the same world (260909).
  "Open {name}'s chat": '打开{name}的聊天',
  'Holding {item}': '手持{item}',
  'Empty hands': '空手',
  // ── Backseat games (260929, Roblox tile: BackseatGameModal) ───────────────
  'Roblox (Backseat)': 'Roblox（Backseat）',
  'Roblox': 'Roblox',
  'Play any Roblox game while {name} watches your screen and talks with you on a voice call.':
    '玩任意 Roblox 游戏，{name}会通过语音通话看着你的屏幕陪你聊天。',
  'Roblox is available via Backseat: your companion can watch you play through your screen.':
    'Roblox 通过 Backseat 支持：你的伙伴可以通过屏幕共享看你玩。',
  // The pick step, redesigned 261004: the companion asks, the cards answer.
  'What are we playing?': '我们玩什么？',
  'Hmm, let me look...': '嗯，我找找看…',
  '{game} search is busy. Any of these?': '{game} 搜索有点忙。是这些里的吗？',
  'Any of these?': '是这些里的吗？',
  "Can't find that one. Try pasting the game's link?": '没找到这个。试试粘贴游戏链接？',
  "That's not a {game} game link.": '这不是 {game} 游戏链接哦。',
  "Hmm, that game doesn't seem to exist.": '嗯，这个游戏好像不存在。',
  "I can't reach {game} right now. We can just skip this!": '现在连不上 {game}。直接跳过也可以！',
  "I can't load games right now. Paste a link or just skip!": '现在加载不了游戏。粘贴链接，或者直接跳过吧！',
  "Ooh, {game}! Let's go.": '哦，{game}！出发吧。',
  'Search or paste a link': '搜索或粘贴链接',
  'Search {game} games or paste a link': '搜索 {game} 游戏或粘贴链接',
  'Skip': '跳过',
  'by {creator}': '作者：{creator}',
  '{count} playing': '{count} 人在玩',
  // The auto-share wait on the call (261004, ShareWaiting).
  "Hop in, I'll be watching!": '进游戏吧，我看着呢！',
  "Hop back in, I'm still here.": '回来继续玩吧，我还在。',
  "Hmm, I couldn't start watching.": '嗯，我没能开始看。',
  'Waiting for {game}': '等待 {game}',
  'Share something else': '共享其他内容',
  'Could not start sharing.': '无法开始共享。',
  'your game': '你的游戏',
  'Open {game} and its window will show up here.': '打开 {game}，它的窗口就会出现在这里。',
};
