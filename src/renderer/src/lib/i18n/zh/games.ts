/** Game surfaces (chess + Draw!). See ../zh.ts for the dictionary rules. */
export const ZH_GAMES: Record<string, string> = {
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
  'The download failed. Check your connection and try again.': '下载失败。请检查网络后重试。',
  'The chess brain failed to download. Check your connection and try again.':
    '国际象棋引擎下载失败。请检查网络后重试。',
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
  'Save to Desktop': '保存到桌面',
  'Play again': '再玩一局',
  'Saved to {path}': '已保存到 {path}',
  'Saved!': '已保存！',
  'The saved picture': '保存的图片',
};
