/** Game surfaces (chess + Draw!). See ../zh.ts for the dictionary rules. */
export const ZH_GAMES: Record<string, string> = {
  // â”€â”€ Game packs (260908, components/games/GamePackCard) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Download {name} support (about {size})': 'ä¸‹è½½ {name} æ”¯æŒæ–‡ä»¶ï¼ˆçº¦ {size}ï¼‰',
  'Download ({size})': 'ä¸‹è½½ï¼ˆ{size}ï¼‰',
  'Your companion needs a one-time download to play {name} with you. It is stored on this device and only downloads again after an update that needs a newer version.':
    'ä¼™ä¼´è¦å’Œä½ ä¸€èµ·çŽ© {name}ï¼Œéœ€è¦ä¸€æ¬¡æ€§ä¸‹è½½æ”¯æŒæ–‡ä»¶ã€‚æ–‡ä»¶ä¼šä¿å­˜åœ¨è¿™å°è®¾å¤‡ä¸Šï¼Œåªæœ‰æ›´æ–°åŽéœ€è¦æ–°ç‰ˆæœ¬æ—¶æ‰ä¼šå†æ¬¡ä¸‹è½½ã€‚',
  'Downloading {name} supportâ€¦': 'æ­£åœ¨ä¸‹è½½ {name} æ”¯æŒæ–‡ä»¶â€¦',
  '{name} support download, {pct} percent': '{name} æ”¯æŒæ–‡ä»¶ä¸‹è½½è¿›åº¦ {pct}%',
  '{received} of {total}': '{received} / {total}',
  "Couldn't download {name} support": 'æ— æ³•ä¸‹è½½ {name} æ”¯æŒæ–‡ä»¶',
  // â”€â”€ Mini tile (bottom-right return tile) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Back to game': 'è¿”å›žæ¸¸æˆ',
  'Draw!': 'ä½ ç”»æˆ‘çŒœï¼',
  // â”€â”€ Vision gate (china-compat W9) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Draw! needs a model that can see images. Your current model ({model}) does not support vision.':
    'ä½ ç”»æˆ‘çŒœéœ€è¦èƒ½çœ‹æ‡‚å›¾åƒçš„æ¨¡åž‹ã€‚ä½ å½“å‰çš„æ¨¡åž‹ï¼ˆ{model}ï¼‰ä¸æ”¯æŒè§†è§‰èƒ½åŠ›ã€‚',
  'Draw! needs a model that can see images. Your current model does not support vision.':
    'ä½ ç”»æˆ‘çŒœéœ€è¦èƒ½çœ‹æ‡‚å›¾åƒçš„æ¨¡åž‹ã€‚ä½ å½“å‰çš„æ¨¡åž‹ä¸æ”¯æŒè§†è§‰èƒ½åŠ›ã€‚',
  // â”€â”€ Chess: launch screen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Chess': 'å›½é™…è±¡æ£‹',
  'Chess with {name}': 'ä¸Ž{name}ä¸‹æ£‹',
  'Companion': 'ä¼™ä¼´',
  'White': 'ç™½æ–¹',
  'Random': 'éšæœº',
  'Black': 'é»‘æ–¹',
  'Your side': 'ä½ çš„æ‰§å­',
  // 'Launch' lives in chatui.ts ('å¯åŠ¨'): the key is shared with the
  // Minecraft launch button, so the value must fit both surfaces.
  'Start': 'å¼€å§‹',
  'Startingâ€¦': 'æ­£åœ¨å¼€å§‹â€¦',
  'Try again': 'å†è¯•ä¸€æ¬¡',
  'Setting up the chess brain (one-time download).': 'æ­£åœ¨å‡†å¤‡å›½é™…è±¡æ£‹å¼•æ“Žï¼ˆä»…éœ€ä¸‹è½½ä¸€æ¬¡ï¼‰ã€‚',
  'Chess engine download progress': 'å›½é™…è±¡æ£‹å¼•æ“Žä¸‹è½½è¿›åº¦',
  // 'The download failed...' moved to common.ts (shared with the W6 pack panels).
  'The chess brain failed to download. Check your connection and try again.':
    'å›½é™…è±¡æ£‹å¼•æ“Žä¸‹è½½å¤±è´¥ã€‚è¯·æ£€æŸ¥ç½‘ç»œåŽé‡è¯•ã€‚',
  "The chess brain couldn't start. Try again in a moment.": 'å›½é™…è±¡æ£‹å¼•æ“Žæ— æ³•å¯åŠ¨ã€‚è¯·ç¨åŽå†è¯•ã€‚',
  'Chess is not available in this build yet.': 'æ­¤ç‰ˆæœ¬æš‚ä¸æ”¯æŒå›½é™…è±¡æ£‹ã€‚',
  "The game couldn't start. Try again in a moment.": 'å¯¹å±€æ— æ³•å¼€å§‹ã€‚è¯·ç¨åŽå†è¯•ã€‚',

  // â”€â”€ Chess: in-game HUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Game controls': 'å¯¹å±€æŽ§åˆ¶',
  'Flip board': 'ç¿»è½¬æ£‹ç›˜',
  'Offer draw': 'æå’Œ',
  'Resign': 'è®¤è¾“',
  'Resign?': 'è®¤è¾“ï¼Ÿ',
  'Yes': 'æ˜¯',
  'No': 'å¦',
  'Captured by white': 'ç™½æ–¹åƒæŽ‰çš„æ£‹å­',
  'Captured by black': 'é»‘æ–¹åƒæŽ‰çš„æ£‹å­',
  'No moves yet': 'è¿˜æ²¡æœ‰ç€æ³•',
  'Back to live': 'å›žåˆ°å½“å‰å±€é¢',
  '{name} offers a draw': '{name}æè®®å’Œæ£‹',
  'Accept': 'æŽ¥å—',
  'Decline': 'æ‹’ç»',
  'Draw offer sent': 'å’Œæ£‹æè®®å·²å‘å‡º',
  'Rematch': 'å†æ¥ä¸€å±€',
  'Chess board': 'æ£‹ç›˜',
  'Your move': 'è½®åˆ°ä½ äº†',
  "{name}'s move": 'è½®åˆ°{name}',
  '{name} is thinkingâ€¦': '{name}æ­£åœ¨æ€è€ƒâ€¦',
  'Elo ~{elo}': 'ç­‰çº§åˆ†çº¦ {elo}',
  'Promote to': 'å‡å˜ä¸º',
  'Promote to queen': 'å‡å˜ä¸ºåŽ',
  'Promote to knight': 'å‡å˜ä¸ºé©¬',
  'Promote to rook': 'å‡å˜ä¸ºè½¦',
  'Promote to bishop': 'å‡å˜ä¸ºè±¡',

  // â”€â”€ Chess: results â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Draw': 'å’Œæ£‹',
  'You won': 'ä½ èµ¢äº†',
  '{name} won': '{name}èµ¢äº†',
  'Checkmate.': 'å°†æ€ã€‚',
  'Stalemate. No legal moves left.': 'é€¼å’Œã€‚æ²¡æœ‰åˆæ³•ç€æ³•äº†ã€‚',
  'You both agreed to a draw.': 'ä½ ä»¬åŒæ„å’Œæ£‹ã€‚',
  'Not enough pieces left to checkmate.': 'å‰©ä½™æ£‹å­ä¸è¶³ä»¥å°†æ€ã€‚',
  'The same position repeated three times.': 'åŒä¸€å±€é¢é‡å¤å‡ºçŽ°äº†ä¸‰æ¬¡ã€‚',
  'Fifty moves without a capture or pawn move.': 'è¿žç»­äº”åå›žåˆæ²¡æœ‰åƒå­æˆ–åŠ¨å…µã€‚',
  'You resigned. {name} takes the game.': 'ä½ è®¤è¾“äº†ã€‚è¿™å±€å½’{name}ã€‚',
  '{name} forfeited the game.': '{name}å¼ƒæƒè®¤è´Ÿã€‚',
  'Game closed': 'å¯¹å±€å·²å…³é—­',
  'This game ended without a result.': 'è¿™å±€æ²¡æœ‰åˆ†å‡ºç»“æžœå°±ç»“æŸäº†ã€‚',

  // â”€â”€ Chess: Minecraft conflict modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  '{name} is in Minecraft': '{name}æ­£åœ¨ Minecraft ä¸­',
  '{name} is playing in a Minecraft world right now. Disconnect them from the world to start a chess game?':
    '{name}æ­£åœ¨ä¸€ä¸ª Minecraft ä¸–ç•Œé‡Œæ¸¸çŽ©ã€‚è¦å°†å…¶æ–­å¼€è¿žæŽ¥å¹¶å¼€å§‹ä¸‹æ£‹å—ï¼Ÿ',
  'Disconnect and play': 'æ–­å¼€å¹¶å¼€å§‹',

  // â”€â”€ Chess: replay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Chess replay with {name}': 'ä¸Ž{name}çš„å¯¹å±€å›žæ”¾',
  'Replay controls': 'å›žæ”¾æŽ§åˆ¶',
  'No moves': 'æ²¡æœ‰ç€æ³•',
  'Final position': 'æœ€ç»ˆå±€é¢',

  // â”€â”€ Draw!: setup + pick â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'DRAW!': 'ä½ ç”»æˆ‘çŒœï¼',
  'A hand-drawn shrimp': 'ä¸€åªæ‰‹ç»˜çš„è™¾',
  'A hand-drawn crown': 'ä¸€é¡¶æ‰‹ç»˜çš„çŽ‹å† ',
  'A hand-drawn horse': 'ä¸€åŒ¹æ‰‹ç»˜çš„é©¬',
  'Take turns drawing and guessing. Three rounds.': 'è½®æµç”»ç”»å’ŒçŒœè¯ã€‚ä¸€å…±ä¸‰è½®ã€‚',
  '{name} draws first, you guess. Then it is your turn. One quick round.': '{name}å…ˆç”»ï¼Œä½ æ¥çŒœã€‚ç„¶åŽè½®åˆ°ä½ ç”»ã€‚åªçŽ©ä¸€è½®ã€‚',
  'Start!': 'å¼€å§‹ï¼',
  'Starting...': 'æ­£åœ¨å¼€å§‹...',
  'Leave Draw!': 'é€€å‡ºä½ ç”»æˆ‘çŒœ',
  'Leave': 'ç¦»å¼€',
  'Pick a word': 'é€‰ä¸€ä¸ªè¯',

  // â”€â”€ Draw!: in-game â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Round {n}/{m}': 'ç¬¬ {n}/{m} è½®',
  'It was "{word}"': 'ç­”æ¡ˆæ˜¯â€œ{word}â€',
  'Turn over': 'å›žåˆç»“æŸ',
  '{name} is drawing': '{name}æ­£åœ¨ç”»',
  'game paused': 'æ¸¸æˆå·²æš‚åœ',
  'usage limit reached. top up or wait, then resume: the turn picks up right where it stopped.':
    'å·²è¾¾åˆ°ç”¨é‡ä¸Šé™ã€‚å……å€¼æˆ–ç¨ç­‰ç‰‡åˆ»åŽç»§ç»­ï¼šå›žåˆä¼šä»Žåœä¸‹çš„åœ°æ–¹æŽ¥ç€è¿›è¡Œã€‚',
  // 260926: the credit-wall variant of the pause card. The reset line between
  // these two comes from src/shared/freePlayReset.ts.
  "you're out of playtime for now, so {name} can't draw or guess.":
    'ä½ çš„æ¸¸çŽ©æ—¶é—´æš‚æ—¶ç”¨å®Œäº†ï¼Œ{name}çŽ°åœ¨æ²¡æ³•ç”»ç”»æˆ–çŒœè¯ã€‚',
  'top up and resume, or end the game and keep your drawings.':
    'å……å€¼åŽå¯ä»¥ç»§ç»­ï¼Œä¹Ÿå¯ä»¥çŽ°åœ¨ç»“æŸæ¸¸æˆå¹¶ä¿ç•™ä½ ä»¬çš„ç”»ã€‚',
  // Shared with CreditsScreen's resume-plan button, so the value must fit
  // both "resume the paused game" and "resume the plan".
  'Resume': 'æ¢å¤',
  'Pen': 'ç”»ç¬”',
  'Stroke eraser': 'ç¬”ç”»æ©¡çš®',
  'Eraser (removes a whole stroke)': 'æ©¡çš®ï¼ˆæ“¦é™¤æ•´æ¡ç¬”ç”»ï¼‰',
  'Say something': 'è¯´ç‚¹ä»€ä¹ˆ',
  'Type your guess': 'è¾“å…¥ä½ çš„çŒœæµ‹',
  'Talk while you draw': 'è¾¹ç”»è¾¹èŠ',
  'Chat and guesses': 'èŠå¤©å’ŒçŒœè¯',

  // â”€â”€ Draw!: gallery â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'you': 'ä½ ',
  'Saving...': 'æ­£åœ¨ä¿å­˜...',
  'Save to Downloads': 'ä¿å­˜åˆ°ä¸‹è½½æ–‡ä»¶å¤¹',
  'Play again': 'å†çŽ©ä¸€å±€',
  'Saved to {path}': 'å·²ä¿å­˜åˆ° {path}',
  'Saved!': 'å·²ä¿å­˜ï¼',
  'The saved picture': 'ä¿å­˜çš„å›¾ç‰‡',
  // The caption on a single drawing's share tile. {word} is left in place by
  // the caller so the composer can put the highlighter behind the word alone,
  // and {a} is the English article, which Chinese simply drops.
  'according to {name}, this is {a} {word}.': 'æ®{name}è¯´ï¼Œè¿™æ˜¯{word}ã€‚',

  // â”€â”€ Game adapters (M0, 260908): generic bot-backed game surfaces â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // components/games/GenericGamePanels.tsx
  'Your world is open. Press Play to bring your companion in.': 'ä½ çš„ä¸–ç•Œå·²ç»æ‰“å¼€ã€‚ç‚¹å‡»ã€Œä¸€èµ·çŽ©ã€è®©ä¼™ä¼´åŠ å…¥ã€‚',
  'Open your world in {game} first, then press Play.': 'è¯·å…ˆåœ¨ {game} ä¸­æ‰“å¼€ä½ çš„ä¸–ç•Œï¼Œç„¶åŽç‚¹å‡»ã€Œä¸€èµ·çŽ©ã€ã€‚',
  'Playing': 'æ¸¸æˆä¸­',
  // screens/ChatScreen.tsx (per-game aside label)
  '{game} dashboard': '{game} é¢æ¿',
  // components/GameSetupModal.tsx
  'Open your {game} world': 'æ‰“å¼€ä½ çš„ {game} ä¸–ç•Œ',
  'Sei could not find an open {game} world. Open your world in the game with the Sei mod enabled; your companion joins as soon as it appears.':
    'Sei æ²¡æœ‰æ‰¾åˆ°å·²æ‰“å¼€çš„ {game} ä¸–ç•Œã€‚è¯·åœ¨æ¸¸æˆä¸­å¯ç”¨ Sei æ¨¡ç»„å¹¶æ‰“å¼€ä½ çš„ä¸–ç•Œï¼Œä¼™ä¼´ä¼šåœ¨ä¸–ç•Œå‡ºçŽ°åŽç«‹å³åŠ å…¥ã€‚',
  'Sei keeps looking while this window is open.': 'è¿™ä¸ªçª—å£æ‰“å¼€æœŸé—´ï¼ŒSei ä¼šæŒç»­æŸ¥æ‰¾ã€‚',
  // components/GameErrorModal.tsx
  "{name} couldn't join {game}": '{name}æ— æ³•åŠ å…¥ {game}',
  // The one-step setup window on the launch panels (components/games/SetupStepper.tsx, 260909).
  'Step {n} of {m}': 'ç¬¬ {n} æ­¥ï¼Œå…± {m} æ­¥',
  'Waiting for your farm...': 'ç­‰å¾…ä½ çš„å†œåœºâ€¦',
  // Game dashboards, companions in the same world (260909).
  "Open {name}'s chat": 'æ‰“å¼€{name}çš„èŠå¤©',
  'Holding {item}': 'æ‰‹æŒ{item}',
  'Empty hands': 'ç©ºæ‰‹',
  // â”€â”€ Backseat games (260929, Roblox tile: BackseatGameModal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Roblox (Backseat)': 'Robloxï¼ˆBackseatï¼‰',
  'Roblox': 'Roblox',
  'Play any Roblox game while {name} watches your screen and talks with you on a voice call.':
    'çŽ©ä»»æ„ Roblox æ¸¸æˆï¼Œ{name}ä¼šé€šè¿‡è¯­éŸ³é€šè¯çœ‹ç€ä½ çš„å±å¹•é™ªä½ èŠå¤©ã€‚',
  'Roblox is available via Backseat: your companion can watch you play through your screen.':
    'Roblox é€šè¿‡ Backseat æ”¯æŒï¼šä½ çš„ä¼™ä¼´å¯ä»¥é€šè¿‡å±å¹•å…±äº«çœ‹ä½ çŽ©ã€‚',
  // The pick step (261004): a plain title, the cards, one line when there are none.
  'Play {game}': 'çŽ© {game}',
  "No games found. Try pasting the game's link.": 'æ²¡æœ‰æ‰¾åˆ°æ¸¸æˆã€‚è¯•è¯•ç²˜è´´æ¸¸æˆé“¾æŽ¥ã€‚',
  "That's not a {game} game link.": 'è¿™ä¸æ˜¯ {game} æ¸¸æˆé“¾æŽ¥ã€‚',
  "Couldn't find that game.": 'æ‰¾ä¸åˆ°è¿™ä¸ªæ¸¸æˆã€‚',
  "Can't reach {game} right now.": 'çŽ°åœ¨è¿žä¸ä¸Š {game}ã€‚',
  'Search or paste a link': 'æœç´¢æˆ–ç²˜è´´é“¾æŽ¥',
  'Search {game} games or paste a link': 'æœç´¢ {game} æ¸¸æˆæˆ–ç²˜è´´é“¾æŽ¥',
  'Skip': 'è·³è¿‡',
  '{count} playing': '{count} äººåœ¨çŽ©',
  // The auto-share wait on the call (261004, ShareWaiting).
  "Hop in, I'll be watching!": 'è¿›æ¸¸æˆå§ï¼Œæˆ‘çœ‹ç€å‘¢ï¼',
  "Hop back in, I'm still here.": 'å›žæ¥ç»§ç»­çŽ©å§ï¼Œæˆ‘è¿˜åœ¨ã€‚',
  "Hmm, I couldn't start watching.": 'å—¯ï¼Œæˆ‘æ²¡èƒ½å¼€å§‹çœ‹ã€‚',
  'Waiting for {game}': 'ç­‰å¾… {game}',
  'Share something else': 'å…±äº«å…¶ä»–å†…å®¹',
  'Could not start sharing.': 'æ— æ³•å¼€å§‹å…±äº«ã€‚',
  'your game': 'ä½ çš„æ¸¸æˆ',
  'Open {game} and its window will show up here.': 'æ‰“å¼€ {game}ï¼Œå®ƒçš„çª—å£å°±ä¼šå‡ºçŽ°åœ¨è¿™é‡Œã€‚',
  // Suggest-a-game hint (261109)
  '{game} already works in Sei': '{game} å·²ç»å¯ä»¥åœ¨ Sei é‡ŒçŽ©äº†',
};




