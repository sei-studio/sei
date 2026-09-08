/**
 * Don't Starve Together surfaces (game adapters M2, 260908): the launch
 * panel, dashboard, setup-modal body, settings group, the shared game
 * controls window, and the DST error copy. See ../zh.ts for the rules.
 */
export const ZH_DONTSTARVE: Record<string, string> = {
  // ── shared game controls (components/games/GameControlsWindow.tsx) ──
  'Resume': '继续',
  'The AI plays alongside you. Can act without your command. Costs more usage.':
    'AI 会和你一起玩。无需你的指令也会行动。消耗更多用量。',

  // ── setup steps (components/dontstarve/DstSteps.tsx, 260909) ──
  '{game} setup steps': '{game} 设置步骤',
  'Setup': '设置',
  "Install Don't Starve Together through Steam, then check again. We looked in:": '请通过 Steam 安装《饥荒联机版》，然后重新检查。我们查找过这些位置：',
  "Don't Starve Together is installed.": '《饥荒联机版》已安装。',
  "Couldn't add Sei's helper.": '无法添加 Sei 助手。',
  "Sei's helper is in the game (v{version}).": 'Sei 助手已在游戏中（v{version}）。',
  "Add Sei's helper. It is a small server-side mod that lets your companion join the worlds you host. Friends who join need nothing.":
    '添加 Sei 助手。它是一个小小的服务端模组，让你的伙伴能加入你主持的世界。加入的朋友无需安装任何东西。',
  "Don't Starve Together is running.": '《饥荒联机版》正在运行。',
  "Don't Starve Together is running. It will need a restart once the helper is added.": '《饥荒联机版》正在运行。添加助手后需要重启游戏。',
  "Quit Don't Starve Together and open it again. The helper loads when the game starts.": '请退出《饥荒联机版》并重新打开。助手会在游戏启动时加载。',
  'Waiting for the game to close...': '等待游戏关闭…',
  "Open Don't Starve Together.": '打开《饥荒联机版》。',
  'Your world is open: {world}, day {day}.': '你的世界已开启：{world}，第 {day} 天。',
  'Your world': '你的世界',
  "Sei couldn't open a local port for Don't Starve Together (ports {first} to {last} are all in use). Close whatever is using them, then try again.":
    'Sei 无法为《饥荒联机版》打开本地端口（端口 {first} 到 {last} 全部被占用）。请关闭占用它们的程序，然后再试一次。',
  "Host a world: in the game choose Play, then Host, pick a world (new or saved, caves on or off) and start it. Sei's helper is on automatically.":
    '主持一个世界：在游戏中选择“开始游戏”，再选“主持”，挑一个世界（新建或已有存档，开不开洞穴都可以）并启动。Sei 助手会自动开启。',
  'Waiting for your world...': '等待你的世界…',
  "macOS needs your permission first: the game keeps its mods inside its app, and changing another app needs App Management. Open System Settings, go to Privacy & Security, then App Management, turn on Sei, and try again.":
    'macOS 需要你先授权：游戏把模组放在它自己的应用包里，而修改其他应用需要“应用程序管理”权限。请打开“系统设置”，进入“隐私与安全性”，再进入“应用程序管理”，打开 Sei，然后再试一次。',
  'Open System Settings': '打开系统设置',

  // ── launch panel (components/dontstarve/DstLaunchPanel.tsx) ──
  "Looking for Don't Starve Together on this computer...": '正在这台电脑上查找《饥荒联机版》…',
  'Check again': '重新检查',
  "Adding Sei's helper...": '正在添加 Sei 助手…',
  'Enabling the helper in the game': '正在游戏中启用助手',
  'Copying the helper into the game folder': '正在把助手复制到游戏文件夹',
  "Couldn't add Sei's helper": '无法添加 Sei 助手',
  "Add Sei's helper": '添加 Sei 助手',
  'Opening Steam...': '正在打开 Steam…',
  "Launch Don't Starve Together": '启动《饥荒联机版》',
  'Your world is open': '你的世界已开启',
  '{name} will appear as "{ingame}" next to you.': '{name} 会以「{ingame}」的名字出现在你身边。',
  'Day {day}, {season}, {phase}': '第 {day} 天，{season}，{phase}',
  'Survivor': '生存者',
  '{name} will play as {survivor}.': '{name} 将扮演 {survivor}。',
  '{name} wants to play as {survivor}.': '{name} 想扮演 {survivor}。',
  'Change': '更换',
  'Let {name} choose': '让 {name} 自己选',
  '{name} is choosing a survivor...': '{name} 正在选择生存者…',
  'Survivor not chosen yet.': '尚未选择生存者。',

  // ── dashboard (components/dontstarve/DstDashboardPanel.tsx) ──
  "{name}'s Don't Starve Together dashboard": '{name} 的《饥荒联机版》面板',
  "{name} in Don't Starve Together": '{name} 在《饥荒联机版》中',
  'Day {day}': '第 {day} 天',
  '{temp} degrees': '{temp} 度',
  'Health': '生命',
  'Hunger': '饥饿',
  'Sanity': '理智',
  'Nothing carried yet.': '还没有携带任何物品。',
  'at {x}, {z}': '位于 {x}, {z}',

  // ── setup modal body (components/dontstarve/DstSetupBody.tsx) ──

  // ── settings (components/dontstarve/DstSettingsSection.tsx) ──
  "Don't Starve Together": '饥荒联机版',
  'Checking...': '正在检查…',
  'Game not found': '未找到游戏',
  'Setup failed': '设置失败',
  'Game found, helper not installed': '已找到游戏，助手未安装',
  'Helper installed (v{version})': '助手已安装（v{version}）',
  'Helper installed, not enabled': '助手已安装，未启用',
  'Helper mod': '助手模组',
  'Enable': '启用',
  'Add': '添加',
  'Game folder': '游戏文件夹',

  // ── lib/errors.ts (ERROR_COPY) ──
  "Sei's helper answered, but no survivor appeared in your world. Make sure you are the host, then press Play again.":
    'Sei 助手有回应，但你的世界里没有出现生存者。请确认你是主机，然后再次点击开始。',
  "Your companion's survivor died in the Constant. Press Play to summon them again.":
    '你伙伴的生存者在永恒大陆死去了。点击开始再次召唤。',
};
