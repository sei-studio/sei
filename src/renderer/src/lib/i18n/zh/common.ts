/** Shared/basic UI strings. See ../zh.ts for the dictionary rules. */
export const ZH_COMMON: Record<string, string> = {
  'Cancel': 'å–æ¶ˆ',
  'Close': 'å…³é—­',
  'Announcement': 'å…¬å‘Š',
  'Confirm': 'ç¡®è®¤',
  'Continue': 'ç»§ç»­',
  'Save': 'ä¿å­˜',
  'Delete': 'åˆ é™¤',
  'Back': 'è¿”å›ž',
  'Next': 'ä¸‹ä¸€æ­¥',
  'Done': 'å®Œæˆ',
  'OK': 'å¥½çš„',
  'Settings': 'è®¾ç½®',
  'Retry': 'é‡è¯•',
  'Loading...': 'åŠ è½½ä¸­...',
  // Avatar overlay (260804): the Settings level control AND the profile tab.
  'Avatar': 'è™šæ‹Ÿå½¢è±¡',

  // W7 region gate (260816): shown by BOTH the onboarding AuthPanel and the
  // SignInModal (shared string, so it lives here per the zh.ts rule).
  'Our servers do not currently support your region. Please continue with local mode.':
    'æˆ‘ä»¬çš„æœåŠ¡å™¨æš‚ä¸æ”¯æŒæ‚¨æ‰€åœ¨çš„åœ°åŒºã€‚è¯·ç»§ç»­ä½¿ç”¨æœ¬åœ°æ¨¡å¼ã€‚',

  // Shared download-failure line (chess engine download + the W6 speech-pack
  // panels). Lives here per the zh.ts rule: later spreads win on duplicates,
  // so a shared key must not be declared per surface.
  'The download failed. Check your connection and try again.': 'ä¸‹è½½å¤±è´¥ã€‚è¯·æ£€æŸ¥ç½‘ç»œåŽé‡è¯•ã€‚',

  // LLM provider labels (shared catalog PROVIDER_LABELS, rendered through
  // t() by ProviderSelect and the key prompts). Proper-noun labels fall
  // through to English; only the ones carrying a translatable word appear.
  'Ollama (local)': 'Ollamaï¼ˆæœ¬åœ°ï¼‰',
  'Qwen (Alibaba)': 'Qwenï¼ˆé˜¿é‡Œå·´å·´ï¼‰',

  // Settings: Language section
  'Language': 'è¯­è¨€',
  'App language': 'åº”ç”¨è¯­è¨€',
  'About the app language': 'å…³äºŽåº”ç”¨è¯­è¨€',
  'Switches the whole app to this language. Companions you create while it is on speak it too.':
    'å°†æ•´ä¸ªåº”ç”¨åˆ‡æ¢åˆ°è¿™ç§è¯­è¨€ã€‚å¼€å¯åŽåˆ›å»ºçš„ä¼™ä¼´ä¹Ÿä¼šè¯´è¿™ç§è¯­è¨€ã€‚',

  // Start Minecraft / Sei profile action (260929), shared by the Minecraft
  // panel, the setup window, the summon modals and the setup wizard.
  'Start Minecraft': 'æ‰“å¼€ Minecraft',
  'Set up Sei profile': 'è®¾ç½® Sei é…ç½®',
  'The Minecraft Launcher is opening with "{profile}" selected. Press Play.':
    'Minecraft å¯åŠ¨å™¨æ­£åœ¨æ‰“å¼€ï¼Œå·²é€‰å¥½ã€Œ{profile}ã€ã€‚ç‚¹å‡»ã€Œå¼€å§‹æ¸¸æˆã€å³å¯ã€‚',
  'The Minecraft Launcher is already open. Pick "{profile}" next to Play, then press Play.':
    'Minecraft å¯åŠ¨å™¨å·²ç»æ‰“å¼€ã€‚è¯·åœ¨ã€Œå¼€å§‹æ¸¸æˆã€æ—é€‰æ‹©ã€Œ{profile}ã€ï¼Œç„¶åŽç‚¹å‡»ã€Œå¼€å§‹æ¸¸æˆã€ã€‚',
  'No Sei profile found. Use Set up Sei profile first.': 'æ²¡æœ‰æ‰¾åˆ° Sei é…ç½®ã€‚è¯·å…ˆç‚¹å‡»ã€Œè®¾ç½® Sei é…ç½®ã€ã€‚',
  'Could not open the Minecraft Launcher. Open it yourself, pick "{profile}" next to Play, and press Play.':
    'æ— æ³•æ‰“å¼€ Minecraft å¯åŠ¨å™¨ã€‚è¯·æ‰‹åŠ¨æ‰“å¼€å®ƒï¼Œåœ¨ã€Œå¼€å§‹æ¸¸æˆã€æ—é€‰æ‹©ã€Œ{profile}ã€ï¼Œç„¶åŽç‚¹å‡»ã€Œå¼€å§‹æ¸¸æˆã€ã€‚',
  'Didn\'t see the launcher? Open the Minecraft Launcher, pick "{profile}" next to Play, and press Play.':
    'æ²¡çœ‹åˆ°å¯åŠ¨å™¨ï¼Ÿè¯·æ‰“å¼€ Minecraft å¯åŠ¨å™¨ï¼Œåœ¨ã€Œå¼€å§‹æ¸¸æˆã€æ—é€‰æ‹©ã€Œ{profile}ã€ï¼Œç„¶åŽç‚¹å‡»ã€Œå¼€å§‹æ¸¸æˆã€ã€‚',
  'Could not open the Minecraft Launcher. Open it yourself and pick the Sei profile next to Play.':
    'æ— æ³•æ‰“å¼€ Minecraft å¯åŠ¨å™¨ã€‚è¯·æ‰‹åŠ¨æ‰“å¼€å®ƒï¼Œå¹¶åœ¨ã€Œå¼€å§‹æ¸¸æˆã€æ—é€‰æ‹© Sei é…ç½®ã€‚',
  'Windows may ask whether Java can use the network. You can press Cancel. Sei joins your world from this computer, so it still works.':
    'Windows å¯èƒ½ä¼šè¯¢é—®æ˜¯å¦å…è®¸ Java è®¿é—®ç½‘ç»œã€‚ä½ å¯ä»¥ç‚¹å‡»ã€Œå–æ¶ˆã€ã€‚Sei åœ¨è¿™å°ç”µè„‘ä¸ŠåŠ å…¥ä½ çš„ä¸–ç•Œï¼Œæ‰€ä»¥ä¸å—å½±å“ã€‚',
  // Plain error lines (261119, lib/errors.ts userFacingError).
  "Can't reach Sei right now. Check your connection and try again.": "çŽ°åœ¨è¿žä¸ä¸Š Seiã€‚è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥åŽå†è¯•ä¸€æ¬¡ã€‚",
  "That took too long. Please try again.": "ç”¨æ—¶å¤ªä¹…äº†ï¼Œè¯·å†è¯•ä¸€æ¬¡ã€‚",
  "Sei's servers are having trouble. Please try again in a moment.": "Sei çš„æœåŠ¡å™¨å‡ºäº†ç‚¹é—®é¢˜ï¼Œè¯·ç¨åŽå†è¯•ã€‚",
  "You can only have {n} companions. Remove one to make room.": "ä½ æœ€å¤šåªèƒ½æœ‰ {n} ä½ä¼™ä¼´ã€‚ç§»é™¤ä¸€ä½æ¥è…¾å‡ºä½ç½®å§ã€‚",
  "Some knowledge could not be saved. You can add it later from the companion page.": "éƒ¨åˆ†çŸ¥è¯†æ²¡èƒ½ä¿å­˜ã€‚ä½ ä¹‹åŽå¯ä»¥åœ¨ä¼™ä¼´é¡µé¢å†æ·»åŠ ã€‚",
};




