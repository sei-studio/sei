/** Filled by the localization sweep. See ../zh.ts for the dictionary rules. */
export const ZH_CHATUI: Record<string, string> = {
  // ChatTopBar
  'Companion': '伙伴',
  "Open {name}'s profile": '打开{name}的资料页',
  'Play together': '一起玩',
  'Back to chat': '返回聊天',
  'Voice call': '语音通话',

  // IconRail
  'Primary': '主导航',
  'Home': '主页',
  'World': '世界',
  'Awaken a companion': '唤醒一位伙伴',
  'Awaken': '唤醒',
  'Usage: {pct}%': '用量：{pct}%',
  'Plan': '套餐',
  'Switch to cloud': '切换到云端',
  '{name}, on a call': '{name}，通话中',
  '{name}, playing a game': '{name}，游戏中',
  'Party full': '队伍已满',
  'All {n} companion slots are taken. Release a companion from their page to make room for a new one.':
    '全部{n}个伙伴栏位都已被占用。到伙伴的页面放走一位，为新伙伴腾出位置。',
  'Got it': '知道了',
  'Switch to cloud?': '切换到云端？',
  "Sign in to use Sei's hosted AI. You keep your local characters either way.":
    '登录即可使用 Sei 托管的 AI。无论如何，你的本地角色都会保留。',
  'Not now': '暂时不用',

  // GameSurface
  'Show chat, new messages': '显示聊天，有新消息',
  'Show chat': '显示聊天',
  'Hide chat': '隐藏聊天',
  'Enter fullscreen': '进入全屏',
  'Exit fullscreen': '退出全屏',
  'Fullscreen': '全屏',
  'Return to call with {name}': '返回与{name}的通话',
  'Return to call': '返回通话',
  'End game': '结束游戏',
  'This will end the game.': '这将结束本局游戏。',

  // GamesPickerModal
  'your companion': '你的伙伴',
  'About {name}': '关于{name}',
  'SOON': '敬请期待',
  'Suggest a game': '推荐一款游戏',
  'Game': '游戏',
  'What game should we add?': '你希望我们加入什么游戏？',

  // CallControls
  'Mute': '静音',
  'Unmute': '取消静音',
  'Deafen': '拒听',
  'Undeafen': '取消拒听',
  'Hang up': '挂断',

  // McDashboardPanel
  "{name}'s Minecraft dashboard": '{name}的 Minecraft 仪表盘',
  '{name} in Minecraft': '{name} 在 Minecraft 中',
  'Status': '状态',
  'Paused': '已暂停',
  "{name}'s inventory": '{name}的物品栏',
  'Inventory': '物品栏',
  'Minimap': '小地图',
  'The Nether': '下界',
  'The End': '末地',
  'Overworld': '主世界',
  'Companion controls': '伙伴控制',
  'Pause': '暂停',
  'Mode': '模式',
  'Reactive': '被动',
  'Proactive': '主动',
  'Disconnect': '断开连接',
  'Waiting for {name}...': '正在等待{name}...',
  'Freezes your companion in the game. They stand still and stop thinking until you unpress it.':
    '将你的伙伴在游戏中冻结。他们会原地站立并停止思考，直到你再次按下取消。',
  'The AI follows simple instructions. Does not act without your command. Costs less usage.':
    'AI 只执行简单指令，没有你的命令不会行动。消耗的用量更少。',
  'The AI plays Minecraft alongside you. Can act without your command. Costs more usage.':
    'AI 与你一起玩 Minecraft，可以在没有你命令时自行行动。消耗的用量更多。',
  'Your companion leaves the world. You can launch them back in whenever you want.':
    '你的伙伴会离开世界。你随时可以再次让他们进入。',

  // McDashVitals
  'Health {value} of 20': '生命值 {value}/20',
  'Food {value} of 20': '饥饿值 {value}/20',

  // McDashMinimap
  'Minimap around the companion': '伙伴周围的小地图',
  'Surveying...': '勘测中...',

  // McLaunchPanel
  'Connecting...': '连接中...',
  'Launch': '启动',
  'How do I set up launch?': '如何设置启动？',

  // McInstallList / McInstallRow
  'Detected Minecraft installs': '检测到的 Minecraft 安装',
  'Limited': '受限',
  'Sei enabled': '已启用 Sei',
  'Mod missing': '缺少模组',
  'Re-run setup to reinstall.': '重新运行设置以重新安装。',
  'Version drift': '版本不一致',
  'Re-run setup to update.': '重新运行设置以更新。',
  'Vanilla launcher': '原版启动器',
  'Enable Sei for {name}': '为{name}启用 Sei',
  "Sei can join the same server, but Lunar doesn't support custom skin mods, so the bot will appear with a default Mojang skin.":
    'Sei 可以加入同一服务器，但 Lunar 不支持自定义皮肤模组，因此机器人会以默认 Mojang 皮肤出现。',

  // InstallProgressList
  'Queued': '排队中',
  'Downloading Fabric Loader… {pct}%': '正在下载 Fabric Loader… {pct}%',
  'Installing Fabric Loader…': '正在安装 Fabric Loader…',
  'Scanning your mods…': '正在扫描你的模组…',
  'Scanning your mods (linked {linked} of {total} so far, {excluded} excluded).':
    '正在扫描你的模组（目前已链接 {linked}/{total}，排除 {excluded} 个）。',
  'Downloading CustomSkinLoader… {pct}%': '正在下载 CustomSkinLoader… {pct}%',
  'Placing mod…': '正在放置模组…',
  'Writing config…': '正在写入配置…',
  'Setup complete': '设置完成',
  'Setup failed': '设置失败',
  'Cancelled': '已取消',
  'Skipped': '已跳过',
  'Lunar Client needs no setup. Skin mods are not supported.':
    'Lunar Client 无需设置。不支持皮肤模组。',

  // Banner
  'Dismiss': '忽略',

  // UsageBar
  'Played {time} total': '累计游玩 {time}',
  "Couldn't check your account right now. Refresh to try again.":
    '暂时无法查询你的账户。请刷新重试。',
  'usage unavailable': '用量不可用',
  '{pct} percent used': '已使用 {pct}%',
  'Refresh': '刷新',
  'Refresh plan usage': '刷新套餐用量',

  // games.ts catalog (tile captions + hover descriptions)
  '{name} joins your Minecraft world as a real player, walking beside you, mining, building, and talking as you explore together.':
    '{name} 会以真实玩家的身份加入你的 Minecraft 世界，走在你身旁，一边挖矿、建造，一边和你聊天，陪你一起探索。',
  'A classic game of chess against {name}, right inside your chat. Untimed, so take as long as you like.':
    '在聊天里就能和 {name} 来一盘经典国际象棋。不限时，想思考多久都可以。',
  'Take turns sketching and guessing with {name}. Whoever is guessing types in the chat, and any sentence with the word in it counts.':
    '和 {name} 轮流画画和猜词。猜的一方在聊天里输入，只要句子里包含那个词就算猜中。',
  'Share a window and {name} watches you play, reacting as it happens and saying what they want to see you try next. Works with any game.':
    '共享一个窗口，{name} 会看着你玩，实时做出反应，并说出接下来想看你尝试什么。适用于任何游戏。',
  'Farm side by side in Pelican Town. {name} joins your co-op farm to plant, mine, and chat through the seasons with you.':
    '在鹈鹕镇并肩务农。{name} 会加入你的合作农场，和你一起种地、挖矿，聊着天度过四季。',
  'Survive the Constant together. {name} gathers, fights, and keeps the fire going with you through the night.':
    '一起在永恒大陆求生。{name} 会采集、战斗，和你一起守着火堆熬过黑夜。',
  'A quiet co-working session. {name} keeps you company while you get things done.':
    '一段安静的共同工作时光。{name} 会在你做事时陪伴你。',
  'Tell us what you want to play together. Suggestions go straight to the team.':
    '告诉我们你想一起玩什么。建议会直接送达团队。',
};
