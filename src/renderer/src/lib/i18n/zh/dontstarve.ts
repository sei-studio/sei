/**
 * Don't Starve Together surfaces (game adapters M2, 260908): the launch
 * panel, dashboard, setup-modal body, settings group, the shared game
 * controls window, and the DST error copy. See ../zh.ts for the rules.
 */
export const ZH_DONTSTARVE: Record<string, string> = {
  // â”€â”€ shared game controls (components/games/GameControlsWindow.tsx) â”€â”€
  'Resume': 'ç»§ç»­',
  'The AI plays alongside you. Can act without your command. Costs more usage.':
    'AI ä¼šå’Œä½ ä¸€èµ·çŽ©ã€‚æ— éœ€ä½ çš„æŒ‡ä»¤ä¹Ÿä¼šè¡ŒåŠ¨ã€‚æ¶ˆè€—æ›´å¤šç”¨é‡ã€‚',

  // â”€â”€ setup steps (components/dontstarve/DstSteps.tsx, 260909) â”€â”€
  '{game} setup steps': '{game} è®¾ç½®æ­¥éª¤',
  'Setup': 'è®¾ç½®',
  "Install Don't Starve Together through Steam, then check again. We looked in:": 'è¯·é€šè¿‡ Steam å®‰è£…ã€Šé¥¥è’è”æœºç‰ˆã€‹ï¼Œç„¶åŽé‡æ–°æ£€æŸ¥ã€‚æˆ‘ä»¬æŸ¥æ‰¾è¿‡è¿™äº›ä½ç½®ï¼š',
  "Don't Starve Together is installed.": 'ã€Šé¥¥è’è”æœºç‰ˆã€‹å·²å®‰è£…ã€‚',
  "Couldn't add Sei's helper.": 'æ— æ³•æ·»åŠ  Sei åŠ©æ‰‹ã€‚',
  "Sei's helper is in the game (v{version}).": 'Sei åŠ©æ‰‹å·²åœ¨æ¸¸æˆä¸­ï¼ˆv{version}ï¼‰ã€‚',
  "Add Sei's helper. It is a small server-side mod that lets your companion join the worlds you host. Friends who join need nothing.":
    'æ·»åŠ  Sei åŠ©æ‰‹ã€‚å®ƒæ˜¯ä¸€ä¸ªå°å°çš„æœåŠ¡ç«¯æ¨¡ç»„ï¼Œè®©ä½ çš„ä¼™ä¼´èƒ½åŠ å…¥ä½ ä¸»æŒçš„ä¸–ç•Œã€‚åŠ å…¥çš„æœ‹å‹æ— éœ€å®‰è£…ä»»ä½•ä¸œè¥¿ã€‚',
  "Don't Starve Together is running.": 'ã€Šé¥¥è’è”æœºç‰ˆã€‹æ­£åœ¨è¿è¡Œã€‚',
  "Don't Starve Together is running. It will need a restart once the helper is added.": 'ã€Šé¥¥è’è”æœºç‰ˆã€‹æ­£åœ¨è¿è¡Œã€‚æ·»åŠ åŠ©æ‰‹åŽéœ€è¦é‡å¯æ¸¸æˆã€‚',
  "Quit Don't Starve Together and open it again. The helper loads when the game starts.": 'è¯·é€€å‡ºã€Šé¥¥è’è”æœºç‰ˆã€‹å¹¶é‡æ–°æ‰“å¼€ã€‚åŠ©æ‰‹ä¼šåœ¨æ¸¸æˆå¯åŠ¨æ—¶åŠ è½½ã€‚',
  'Waiting for the game to close...': 'ç­‰å¾…æ¸¸æˆå…³é—­â€¦',
  "Open Don't Starve Together.": 'æ‰“å¼€ã€Šé¥¥è’è”æœºç‰ˆã€‹ã€‚',
  'Your world is open: {world}, day {day}.': 'ä½ çš„ä¸–ç•Œå·²å¼€å¯ï¼š{world}ï¼Œç¬¬ {day} å¤©ã€‚',
  'Your world': 'ä½ çš„ä¸–ç•Œ',
  "Sei couldn't open a local port for Don't Starve Together (ports {first} to {last} are all in use). Close whatever is using them, then try again.":
    'Sei æ— æ³•ä¸ºã€Šé¥¥è’è”æœºç‰ˆã€‹æ‰“å¼€æœ¬åœ°ç«¯å£ï¼ˆç«¯å£ {first} åˆ° {last} å…¨éƒ¨è¢«å ç”¨ï¼‰ã€‚è¯·å…³é—­å ç”¨å®ƒä»¬çš„ç¨‹åºï¼Œç„¶åŽå†è¯•ä¸€æ¬¡ã€‚',
  "Host a world: in the game choose Host Game, pick a world (new or saved, caves on or off), then choose your survivor and press Go. Sei's helper is on automatically.":
    'ä¸»æŒä¸€ä¸ªä¸–ç•Œï¼šåœ¨æ¸¸æˆä¸­é€‰æ‹©â€œä¸»æŒæ¸¸æˆâ€ï¼ŒæŒ‘ä¸€ä¸ªä¸–ç•Œï¼ˆæ–°å»ºæˆ–å·²æœ‰å­˜æ¡£ï¼Œå¼€ä¸å¼€æ´žç©´éƒ½å¯ä»¥ï¼‰ï¼Œç„¶åŽé€‰æ‹©ä½ çš„è§’è‰²å¹¶æŒ‰â€œå‡ºå‘â€ã€‚Sei åŠ©æ‰‹ä¼šè‡ªåŠ¨å¼€å¯ã€‚',
  'The game shows a "Mods Installed" notice at start. Press "I understand."': 'æ¸¸æˆå¯åŠ¨æ—¶ä¼šæ˜¾ç¤ºâ€œå·²å®‰è£…æ¨¡ç»„â€æç¤ºï¼ŒæŒ‰â€œæˆ‘æ˜Žç™½äº†â€å³å¯ã€‚',
  "Sei's helper": 'Sei åŠ©æ‰‹',
  'The game': 'æ¸¸æˆ',
  'A hosted world': 'ä¸»æŒçš„ä¸–ç•Œ',
  'Waiting for your world...': 'ç­‰å¾…ä½ çš„ä¸–ç•Œâ€¦',
  "macOS blocked Sei from adding the helper to the game (it needs App Management permission).":
    'macOS é˜»æ­¢äº† Sei æŠŠåŠ©æ‰‹æ·»åŠ åˆ°æ¸¸æˆä¸­ï¼ˆéœ€è¦â€œåº”ç”¨ç¨‹åºç®¡ç†â€æƒé™ï¼‰ã€‚',

  // â”€â”€ launch panel (components/dontstarve/DstLaunchPanel.tsx) â”€â”€
  "Looking for Don't Starve Together on this computer...": 'æ­£åœ¨è¿™å°ç”µè„‘ä¸ŠæŸ¥æ‰¾ã€Šé¥¥è’è”æœºç‰ˆã€‹â€¦',
  'Check again': 'é‡æ–°æ£€æŸ¥',
  "Adding Sei's helper...": 'æ­£åœ¨æ·»åŠ  Sei åŠ©æ‰‹â€¦',
  'Enabling the helper in the game': 'æ­£åœ¨æ¸¸æˆä¸­å¯ç”¨åŠ©æ‰‹',
  'Copying the helper into the game folder': 'æ­£åœ¨æŠŠåŠ©æ‰‹å¤åˆ¶åˆ°æ¸¸æˆæ–‡ä»¶å¤¹',
  'Click Install helper in the window macOS opened.': 'è¯·åœ¨ macOS æ‰“å¼€çš„çª—å£ä¸­ç‚¹å‡»â€œå®‰è£…åŠ©æ‰‹â€ã€‚',
  'Copying through Finder. If macOS asks whether Sei may control Finder, click Allow.':
    'æ­£åœ¨é€šè¿‡è®¿è¾¾å¤åˆ¶ã€‚å¦‚æžœ macOS è¯¢é—®æ˜¯å¦å…è®¸ Sei æŽ§åˆ¶è®¿è¾¾ï¼Œè¯·ç‚¹å‡»â€œå…è®¸â€ã€‚',
  "A newer version of Sei's helper is ready. macOS needs your OK once to add it.":
    'æ–°ç‰ˆ Sei åŠ©æ‰‹å·²å°±ç»ªã€‚macOS éœ€è¦ä½ ç¡®è®¤ä¸€æ¬¡æ‰èƒ½æ·»åŠ ã€‚',
  'Update helper': 'æ›´æ–°åŠ©æ‰‹',
  "The game turned Sei's helper off. Game updates do this.": 'æ¸¸æˆå…³é—­äº† Sei åŠ©æ‰‹ã€‚æ¸¸æˆæ›´æ–°ä¼šè¿™æ ·åšã€‚',
  'Turn the helper back on': 'é‡æ–°å¼€å¯åŠ©æ‰‹',
  "Couldn't add Sei's helper": 'æ— æ³•æ·»åŠ  Sei åŠ©æ‰‹',
  "Add Sei's helper": 'æ·»åŠ  Sei åŠ©æ‰‹',
  'Opening Steam...': 'æ­£åœ¨æ‰“å¼€ Steamâ€¦',
  "Launch Don't Starve Together": 'å¯åŠ¨ã€Šé¥¥è’è”æœºç‰ˆã€‹',
  'Your world is open': 'ä½ çš„ä¸–ç•Œå·²å¼€å¯',
  '{name} will appear as "{ingame}" next to you.': '{name} ä¼šä»¥ã€Œ{ingame}ã€çš„åå­—å‡ºçŽ°åœ¨ä½ èº«è¾¹ã€‚',
  'Day {day}, {season}, {phase}': 'ç¬¬ {day} å¤©ï¼Œ{season}ï¼Œ{phase}',
  'Survivor': 'ç”Ÿå­˜è€…',
  '{name} will play as {survivor}.': '{name} å°†æ‰®æ¼” {survivor}ã€‚',
  '{name} wants to play as {survivor}.': '{name} æƒ³æ‰®æ¼” {survivor}ã€‚',
  'Change': 'æ›´æ¢',
  'Let {name} choose': 'è®© {name} è‡ªå·±é€‰',
  '{name} is choosing a survivor...': '{name} æ­£åœ¨é€‰æ‹©ç”Ÿå­˜è€…â€¦',
  'Survivor not chosen yet.': 'å°šæœªé€‰æ‹©ç”Ÿå­˜è€…ã€‚',

  // â”€â”€ dashboard (components/dontstarve/DstDashboardPanel.tsx) â”€â”€
  "{name}'s Don't Starve Together dashboard": '{name} çš„ã€Šé¥¥è’è”æœºç‰ˆã€‹é¢æ¿',
  "{name} in Don't Starve Together": '{name} åœ¨ã€Šé¥¥è’è”æœºç‰ˆã€‹ä¸­',
  'Day {day}': 'ç¬¬ {day} å¤©',
  '{temp} degrees': '{temp} åº¦',
  'Health': 'ç”Ÿå‘½',
  'Hunger': 'é¥¥é¥¿',
  'Sanity': 'ç†æ™º',
  'Nothing carried yet.': 'è¿˜æ²¡æœ‰æºå¸¦ä»»ä½•ç‰©å“ã€‚',
  'at {x}, {z}': 'ä½äºŽ {x}, {z}',
  // Dashboard redesign (260909): the HUD badges, the day clock, the hand slot.
  'Autumn': 'ç§‹',
  'Daytime': 'ç™½å¤©',
  'Dusk': 'é»„æ˜',
  'Night': 'å¤œæ™š',
  'Freezing': 'å†»åƒµ',
  'Cold': 'å¯’å†·',
  'Hot': 'ç‚Žçƒ­',
  'Overheating': 'è¿‡çƒ­',
  'Hand': 'æ‰‹æŒ',
  'as {survivor}': 'æ‰®æ¼” {survivor}',

  // â”€â”€ setup modal body (components/dontstarve/DstSetupBody.tsx) â”€â”€

  // â”€â”€ settings (components/dontstarve/DstSettingsSection.tsx) â”€â”€
  "Don't Starve Together": 'é¥¥è’è”æœºç‰ˆ',
  'Checking...': 'æ­£åœ¨æ£€æŸ¥â€¦',
  'Game not found': 'æœªæ‰¾åˆ°æ¸¸æˆ',
  'Setup failed': 'è®¾ç½®å¤±è´¥',
  'Game found, helper not installed': 'å·²æ‰¾åˆ°æ¸¸æˆï¼ŒåŠ©æ‰‹æœªå®‰è£…',
  'Helper installed (v{version})': 'åŠ©æ‰‹å·²å®‰è£…ï¼ˆv{version}ï¼‰',
  'Helper installed, not enabled': 'åŠ©æ‰‹å·²å®‰è£…ï¼Œæœªå¯ç”¨',
  'Helper mod': 'åŠ©æ‰‹æ¨¡ç»„',
  'Enable': 'å¯ç”¨',
  'Add': 'æ·»åŠ ',
  'Game folder': 'æ¸¸æˆæ–‡ä»¶å¤¹',

  // â”€â”€ lib/errors.ts (ERROR_COPY) â”€â”€
  "Sei's helper answered, but no survivor appeared in your world. Make sure you are the host, then press Play again.":
    'Sei åŠ©æ‰‹æœ‰å›žåº”ï¼Œä½†ä½ çš„ä¸–ç•Œé‡Œæ²¡æœ‰å‡ºçŽ°ç”Ÿå­˜è€…ã€‚è¯·ç¡®è®¤ä½ æ˜¯ä¸»æœºï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»å¼€å§‹ã€‚',
  "Don't Starve Together fits one companion at a time. Disconnect the companion already in your world, then press Play.":
    'ã€Šé¥¥è’è”æœºç‰ˆã€‹ä¸€æ¬¡åªèƒ½å®¹çº³ä¸€ä½ä¼™ä¼´ã€‚è¯·å…ˆæ–­å¼€å·²åœ¨ä½ ä¸–ç•Œé‡Œçš„ä¼™ä¼´ï¼Œå†æŒ‰â€œå¼€å§‹â€ã€‚',
  "{other} is already in this world. Don't Starve Together fits one companion at a time, so disconnect {other} first.":
    '{other} å·²ç»åœ¨è¿™ä¸ªä¸–ç•Œé‡Œäº†ã€‚ã€Šé¥¥è’è”æœºç‰ˆã€‹ä¸€æ¬¡åªèƒ½å®¹çº³ä¸€ä½ä¼™ä¼´ï¼Œè¯·å…ˆæ–­å¼€ {other}ã€‚',
  'Another companion': 'å¦ä¸€ä½ä¼™ä¼´',
  "Your companion's survivor died in the Constant. Press Play to summon them again.":
    'ä½ ä¼™ä¼´çš„ç”Ÿå­˜è€…åœ¨æ°¸æ’å¤§é™†æ­»åŽ»äº†ã€‚ç‚¹å‡»å¼€å§‹å†æ¬¡å¬å”¤ã€‚',
  "Your companion died again after coming back 3 times this session, so Sei stopped bringing them back. Press Play to summon them again when you're ready.":
    'ä½ çš„ä¼™ä¼´æœ¬æ¬¡å·²ç»å¤æ´»äº† 3 æ¬¡ï¼Œåˆæ­»äº†ï¼Œæ‰€ä»¥ Sei ä¸å†è®© TA å¤æ´»ã€‚å‡†å¤‡å¥½åŽç‚¹å‡»å¼€å§‹å†æ¬¡å¬å”¤ã€‚',
  "Your companion died right after coming back, twice in a row, so Sei stopped bringing them back. Move somewhere safer (near a fire at night), then press Play.":
    'ä½ çš„ä¼™ä¼´è¿žç»­ä¸¤æ¬¡åˆšå¤æ´»å°±åˆæ­»äº†ï¼Œæ‰€ä»¥ Sei ä¸å†è®© TA å¤æ´»ã€‚å…ˆåŽ»æ›´å®‰å…¨çš„åœ°æ–¹ï¼ˆå¤œé‡Œå¾…åœ¨ç«è¾¹ï¼‰ï¼Œå†ç‚¹å‡»å¼€å§‹ã€‚',
};




