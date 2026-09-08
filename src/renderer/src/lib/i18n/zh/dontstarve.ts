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

  // ── launch panel (components/dontstarve/DstLaunchPanel.tsx) ──
  "Looking for Don't Starve Together on this computer...": '正在这台电脑上查找《饥荒联机版》…',
  "We couldn't find Don't Starve Together": '没有找到《饥荒联机版》',
  'Install it through Steam, then check again. We looked in:': '请通过 Steam 安装，然后重新检查。我们查找过这些位置：',
  'Check again': '重新检查',
  "Adding Sei's helper...": '正在添加 Sei 助手…',
  'Enabling the helper in the game': '正在游戏中启用助手',
  'Copying the helper into the game folder': '正在把助手复制到游戏文件夹',
  "Couldn't add Sei's helper": '无法添加 Sei 助手',
  "Add Sei's helper to Don't Starve Together": '把 Sei 助手添加到《饥荒联机版》',
  'A small server-side mod lets your companion join the worlds you host. Friends who join need nothing. It stays quiet until Sei asks it to spawn someone.':
    '一个小小的服务端模组，让你的伙伴能加入你主持的世界。加入的朋友无需安装任何东西。在 Sei 请求生成角色之前，它不会做任何事。',
  "Add Sei's helper": '添加 Sei 助手',
  'Waiting for your world': '等待你的世界',
  "Open the game and host a world. Sei's helper is enabled automatically; your companion can join as soon as the world is running.":
    '打开游戏并主持一个世界。Sei 助手会自动启用；世界运行起来后，你的伙伴就能加入。',
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
  "We couldn't find Don't Starve Together on this computer. Install it through Steam, then check again.":
    '在这台电脑上没有找到《饥荒联机版》。请通过 Steam 安装，然后重新检查。',
  "Sei's helper is not in your game yet. It is a small server-side mod; friends who join need nothing.":
    'Sei 助手还没有装进你的游戏。它是一个小小的服务端模组；加入的朋友无需安装任何东西。',
  "Couldn't add Sei's helper. Make sure the game is closed, then try again.":
    '无法添加 Sei 助手。请确认游戏已关闭，然后再试一次。',
  "Open Don't Starve Together and host a world (any slot, caves on or off). Your companion joins as soon as the world is running.":
    '打开《饥荒联机版》并主持一个世界（任意存档位，开不开洞穴都可以）。世界运行起来后，你的伙伴就会加入。',

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
  'Discovery port': '发现端口',
  "This port is in use. Pick another one and set the same port in the helper mod's options in the game.":
    '这个端口已被占用。请换一个，并在游戏内助手模组的选项中设置相同的端口。',
  "Only change this if another program uses port {port}; set the same port in the helper mod's options in the game.":
    '仅当其他程序占用了端口 {port} 时才需要更改；请在游戏内助手模组的选项中设置相同的端口。',

  // ── lib/errors.ts (ERROR_COPY) ──
  "Sei's helper answered, but no survivor appeared in your world. Make sure you are the host, then press Play again.":
    'Sei 助手有回应，但你的世界里没有出现生存者。请确认你是主机，然后再次点击开始。',
  "Sei couldn't open its local port for Don't Starve Together. Change the discovery port in Settings, or close whatever is using it, and try again.":
    'Sei 无法为《饥荒联机版》打开本地端口。请在设置中更改发现端口，或关闭占用它的程序，然后再试一次。',
  "Your companion's survivor died in the Constant. Press Play to summon them again.":
    '你伙伴的生存者在永恒大陆死去了。点击开始再次召唤。',
};
