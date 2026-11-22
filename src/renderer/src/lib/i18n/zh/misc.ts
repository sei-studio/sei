/** Filled by the localization sweep. See ../zh.ts for the dictionary rules. */
export const ZH_MISC: Record<string, string> = {
  // â”€â”€ lib/errors.ts (ERROR_COPY / WARN_COPY / fallback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  "Couldn't finish joining your world in time. Press Launch to try again.":
    'æœªèƒ½åŠæ—¶åŠ å…¥ä½ çš„ä¸–ç•Œã€‚è¯·å†æ¬¡ç‚¹å‡»å¯åŠ¨é‡è¯•ã€‚',
  "We can't see an open LAN world. In Minecraft, press Esc, choose Open to LAN, then click Start LAN World.":
    'æ²¡æœ‰æ£€æµ‹åˆ°å¼€æ”¾çš„å±€åŸŸç½‘ä¸–ç•Œã€‚åœ¨ Minecraft ä¸­æŒ‰ Escï¼Œé€‰æ‹©ã€Œå¯¹å±€åŸŸç½‘å¼€æ”¾ã€ï¼Œç„¶åŽç‚¹å‡»ã€Œåˆ›å»ºå±€åŸŸç½‘ä¸–ç•Œã€ã€‚',
  'Your Anthropic API key was rejected. Open Settings â†’ re-run onboarding to paste a fresh key.':
    'ä½ çš„ Anthropic API å¯†é’¥è¢«æ‹’ç»ã€‚è¯·æ‰“å¼€è®¾ç½®ï¼Œé‡æ–°è¿è¡Œå¼•å¯¼æµç¨‹å¹¶ç²˜è´´æ–°çš„å¯†é’¥ã€‚',
  'Anthropic is throttling requests. Wait a minute and try again.':
    'Anthropic æ­£åœ¨é™æµè¯·æ±‚ã€‚è¯·ç¨ç­‰ä¸€åˆ†é’Ÿå†è¯•ã€‚',
  'No internet connection. Reconnect and try again.': 'æ²¡æœ‰ç½‘ç»œè¿žæŽ¥ã€‚è¯·é‡æ–°è”ç½‘åŽå†è¯•ã€‚',
  'Sei stopped before it could join your world. Press Launch to try again. If it keeps happening, the console at the bottom of the app has the reason.':
    'Sei åœ¨åŠ å…¥ä½ çš„ä¸–ç•Œä¹‹å‰åœæ­¢äº†ã€‚ç‚¹å‡»å¯åŠ¨é‡è¯•ã€‚å¦‚æžœåå¤å‡ºçŽ°ï¼Œåº”ç”¨åº•éƒ¨çš„æŽ§åˆ¶å°é‡Œæœ‰åŽŸå› ã€‚',
  'LAN auto-detect is blocked on this network. Try a home Wi-Fi network.':
    'å½“å‰ç½‘ç»œé˜»æ­¢äº†å±€åŸŸç½‘è‡ªåŠ¨å‘çŽ°ã€‚è¯·å°è¯•å®¶ç”¨ Wi-Fi ç½‘ç»œã€‚',
  "Couldn't read your saved API key from the system keychain. Re-run onboarding to re-save it.":
    'æ— æ³•ä»Žç³»ç»Ÿé’¥åŒ™ä¸²è¯»å–å·²ä¿å­˜çš„ API å¯†é’¥ã€‚è¯·é‡æ–°è¿è¡Œå¼•å¯¼æµç¨‹å†æ¬¡ä¿å­˜ã€‚',
  "Your system has no secret store. Sei will save your API key but it won't be hardware-protected.":
    'ä½ çš„ç³»ç»Ÿæ²¡æœ‰å®‰å…¨å­˜å‚¨ã€‚Sei ä¼šä¿å­˜ä½ çš„ API å¯†é’¥ï¼Œä½†å®ƒä¸ä¼šå—åˆ°ç¡¬ä»¶ä¿æŠ¤ã€‚',
  "A bundled module didn't load. Reinstall Sei from the .dmg / .exe.":
    'æœ‰ä¸€ä¸ªå†…ç½®æ¨¡å—åŠ è½½å¤±è´¥ã€‚è¯·é€šè¿‡ .dmg / .exe é‡æ–°å®‰è£… Seiã€‚',
  "This world's Minecraft version is not supported yet. Sei works with most Minecraft Java versions from {oldest} to {newest}. Open the Sei profile in the Minecraft Launcher (it runs {recommended}, with companion skins), open or create a world there, open it to LAN, and press Launch again. No Sei profile yet? Set it up from the Minecraft screen in Sei.":
    'æš‚ä¸æ”¯æŒè¿™ä¸ªä¸–ç•Œçš„ Minecraft ç‰ˆæœ¬ã€‚Sei æ”¯æŒ {oldest} è‡³ {newest} ä¹‹é—´çš„å¤§å¤šæ•° Minecraft Java ç‰ˆæœ¬ã€‚è¯·åœ¨ Minecraft å¯åŠ¨å™¨ä¸­æ‰“å¼€ Sei é…ç½®ï¼ˆè¿è¡Œ {recommended}ï¼Œå¯æ˜¾ç¤ºä¼™ä¼´çš®è‚¤ï¼‰ï¼Œåœ¨å…¶ä¸­æ‰“å¼€æˆ–åˆ›å»ºä¸€ä¸ªä¸–ç•Œå¹¶å¯¹å±€åŸŸç½‘å¼€æ”¾ï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»å¯åŠ¨ã€‚è¿˜æ²¡æœ‰ Sei é…ç½®ï¼Ÿè¯·åœ¨ Sei çš„ Minecraft é¡µé¢ä¸­è®¾ç½®ã€‚',
  "This world runs mods that every player must also have installed, so it turns Sei's normal Minecraft client away. Map mods can count too, like Xaero's Minimap. Open a world from the Sei profile in the Minecraft Launcher, open it to LAN, and press Launch again.":
    'è¿™ä¸ªä¸–ç•Œè¿è¡Œçš„æ¨¡ç»„è¦æ±‚æ¯ä½çŽ©å®¶ä¹Ÿå®‰è£…ï¼Œå› æ­¤ä¼šæ‹’ç» Sei çš„æ™®é€š Minecraft å®¢æˆ·ç«¯ã€‚åœ°å›¾æ¨¡ç»„ä¹Ÿå¯èƒ½å¦‚æ­¤ï¼Œæ¯”å¦‚ Xaero å°åœ°å›¾ã€‚è¯·åœ¨ Minecraft å¯åŠ¨å™¨ä¸­ç”¨ Sei é…ç½®æ‰“å¼€ä¸€ä¸ªä¸–ç•Œï¼Œå¯¹å±€åŸŸç½‘å¼€æ”¾ï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»å¯åŠ¨ã€‚',
  "This world checks Minecraft accounts (online mode), and Sei joins without one, so the world turns it away. If it is a server you run, set online-mode=false in server.properties and restart it. If a mod opened the world to LAN, turn off its online mode option, or use Minecraft's own Open to LAN instead.":
    'è¿™ä¸ªä¸–ç•Œä¼šéªŒè¯ Minecraft è´¦å·ï¼ˆæ­£ç‰ˆéªŒè¯æ¨¡å¼ï¼‰ï¼Œè€Œ Sei ä¸ä½¿ç”¨è´¦å·åŠ å…¥ï¼Œå› æ­¤è¢«æ‹’ç»ã€‚å¦‚æžœè¿™æ˜¯ä½ è‡ªå·±è¿è¡Œçš„æœåŠ¡å™¨ï¼Œè¯·åœ¨ server.properties ä¸­è®¾ç½® online-mode=false å¹¶é‡å¯æœåŠ¡å™¨ã€‚å¦‚æžœæ˜¯æŸä¸ªæ¨¡ç»„æŠŠä¸–ç•Œå¼€æ”¾åˆ°å±€åŸŸç½‘ï¼Œè¯·å…³é—­è¯¥æ¨¡ç»„çš„æ­£ç‰ˆéªŒè¯é€‰é¡¹ï¼Œæˆ–æ”¹ç”¨ Minecraft è‡ªå¸¦çš„ã€Œå¯¹å±€åŸŸç½‘å¼€æ”¾ã€ã€‚',
  "Sei can't join Forge or NeoForge worlds. Open the Sei profile in the Minecraft Launcher, open or create a world there, and open it to LAN.":
    'Sei æ— æ³•åŠ å…¥ Forge æˆ– NeoForge ä¸–ç•Œã€‚è¯·åœ¨ Minecraft å¯åŠ¨å™¨ä¸­æ‰“å¼€ Sei é…ç½®ï¼Œåœ¨å…¶ä¸­æ‰“å¼€æˆ–åˆ›å»ºä¸€ä¸ªä¸–ç•Œï¼Œå¹¶å¯¹å±€åŸŸç½‘å¼€æ”¾ã€‚',
  "Couldn't download CustomSkinLoader. Check your connection and try the setup again.":
    'æ— æ³•ä¸‹è½½ CustomSkinLoaderã€‚è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥åŽé‡æ–°è¿è¡Œè®¾ç½®ã€‚',
  "Couldn't install Fabric Loader. Make sure Minecraft is closed, then try the setup again.":
    'æ— æ³•å®‰è£… Fabric Loaderã€‚è¯·ç¡®è®¤ Minecraft å·²å…³é—­ï¼Œç„¶åŽé‡æ–°è¿è¡Œè®¾ç½®ã€‚',
  "Couldn't download the Minecraft support files (about 50 MB). Check your connection and press Summon again. A retry usually works.":
    'æ— æ³•ä¸‹è½½ Minecraft æ”¯æŒæ–‡ä»¶ï¼ˆçº¦ 50 MBï¼‰ã€‚è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥åŽå†æ¬¡ç‚¹å‡»å¬å”¤ã€‚é€šå¸¸é‡è¯•ä¸€æ¬¡å³å¯ã€‚',
  "We couldn't find any Minecraft installs. Install Minecraft, then re-run setup from Settings.":
    'æ²¡æœ‰æ‰¾åˆ°ä»»ä½• Minecraft å®‰è£…ã€‚è¯·å…ˆå®‰è£… Minecraftï¼Œå†ä»Žè®¾ç½®ä¸­é‡æ–°è¿è¡Œè®¾ç½®å‘å¯¼ã€‚',
  "Couldn't look up that username on Mojang. Check the spelling and your connection.":
    'æ— æ³•åœ¨ Mojang æŸ¥è¯¢è¯¥ç”¨æˆ·åã€‚è¯·æ£€æŸ¥æ‹¼å†™å’Œç½‘ç»œè¿žæŽ¥ã€‚',
  "That doesn't look like a Minecraft skin PNG. Skins must be 64Ã—64 pixels.":
    'è¿™çœ‹èµ·æ¥ä¸åƒ Minecraft çš®è‚¤ PNGã€‚çš®è‚¤å¿…é¡»æ˜¯ 64Ã—64 åƒç´ ã€‚',
  "Sei couldn't reserve a local port for serving skins. Restart Sei and try again.":
    'Sei æ— æ³•ä¿ç•™ç”¨äºŽæä¾›çš®è‚¤çš„æœ¬åœ°ç«¯å£ã€‚è¯·é‡å¯ Sei åŽå†è¯•ã€‚',
  "Sei doesn't have permission to write to your Minecraft folder. Grant access and try again.":
    'Sei æ²¡æœ‰å†™å…¥ä½ çš„ Minecraft æ–‡ä»¶å¤¹çš„æƒé™ã€‚è¯·æŽˆäºˆè®¿é—®æƒé™åŽå†è¯•ã€‚',
  // Game adapters (M0, 260908): game-neutral ERROR_COPY rows.
  "We can't see a game world to join. Open your world in the game, then press Play again.":
    'æ²¡æœ‰æ£€æµ‹åˆ°å¯åŠ å…¥çš„æ¸¸æˆä¸–ç•Œã€‚è¯·åœ¨æ¸¸æˆä¸­æ‰“å¼€ä½ çš„ä¸–ç•Œï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»ã€Œä¸€èµ·çŽ©ã€ã€‚',
  "We couldn't find this game on your computer. Install it, then press Play again.":
    'åœ¨ä½ çš„ç”µè„‘ä¸Šæ²¡æœ‰æ‰¾åˆ°è¿™ä¸ªæ¸¸æˆã€‚è¯·å…ˆå®‰è£…ï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»ã€Œä¸€èµ·çŽ©ã€ã€‚',
  "Couldn't finish setting up the companion mod for this game. Make sure the game is closed, then try the setup again.":
    'æ— æ³•å®Œæˆè¿™ä¸ªæ¸¸æˆçš„ä¼™ä¼´æ¨¡ç»„è®¾ç½®ã€‚è¯·ç¡®è®¤æ¸¸æˆå·²å…³é—­ï¼Œç„¶åŽé‡æ–°è¿è¡Œè®¾ç½®ã€‚',
  "The game is open but isn't answering. Make sure the Sei mod is enabled in the game, then press Play again.":
    'æ¸¸æˆå·²æ‰“å¼€ä½†æ²¡æœ‰å“åº”ã€‚è¯·ç¡®è®¤æ¸¸æˆä¸­å·²å¯ç”¨ Sei æ¨¡ç»„ï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»ã€Œä¸€èµ·çŽ©ã€ã€‚',
  "This game version isn't supported yet. Update the game to a supported version and press Play again.":
    'æš‚ä¸æ”¯æŒè¿™ä¸ªæ¸¸æˆç‰ˆæœ¬ã€‚è¯·æŠŠæ¸¸æˆæ›´æ–°åˆ°å—æ”¯æŒçš„ç‰ˆæœ¬ï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»ã€Œä¸€èµ·çŽ©ã€ã€‚',
  "Couldn't download the files this game needs. Check your connection and press Play again.":
    'æ— æ³•ä¸‹è½½è¿™ä¸ªæ¸¸æˆæ‰€éœ€çš„æ–‡ä»¶ã€‚è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥ï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»ã€Œä¸€èµ·çŽ©ã€ã€‚',
  "You've used this week's credits. Upgrade or top up in Playtime, or switch to your own API key there.":
    'æœ¬å‘¨çš„é¢åº¦å·²ç”¨å®Œã€‚ä½ å¯ä»¥åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­å‡çº§æˆ–å……å€¼ï¼Œæˆ–åœ¨é‚£é‡Œåˆ‡æ¢ä¸ºè‡ªå·±çš„ API å¯†é’¥ã€‚',
  'Too many requests right now. Wait a little and try again.': 'å½“å‰è¯·æ±‚è¿‡å¤šã€‚è¯·ç¨ç­‰ç‰‡åˆ»å†è¯•ã€‚',
  "Sei can't reach Ollama. Start the Ollama app, check the Ollama address in Settings, then press Launch again.":
    'Sei è¿žæŽ¥ä¸åˆ° Ollamaã€‚è¯·å¯åŠ¨ Ollama åº”ç”¨ï¼Œå¹¶åœ¨è®¾ç½®ä¸­æ£€æŸ¥ Ollama åœ°å€ï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»å¯åŠ¨ã€‚',
  "Ollama doesn't have the model picked in Playtime. Download it in Ollama (ollama pull followed by the model name) or pick another model, then press Launch again.":
    'Ollama é‡Œæ²¡æœ‰ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­é€‰æ‹©çš„æ¨¡åž‹ã€‚è¯·åœ¨ Ollama ä¸­ä¸‹è½½å®ƒï¼ˆollama pull åŠ ä¸Šæ¨¡åž‹åï¼‰ï¼Œæˆ–æ¢ä¸€ä¸ªæ¨¡åž‹ï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»å¯åŠ¨ã€‚',
  "This Ollama model can't use tools, and your companion needs them to talk and act in games. Pick a model with tool support in Playtime, like qwen3 or qwen3-vl, then press Launch again.":
    'è¿™ä¸ª Ollama æ¨¡åž‹ä¸æ”¯æŒå·¥å…·è°ƒç”¨ï¼Œè€Œä½ çš„ä¼™ä¼´åœ¨æ¸¸æˆé‡Œè¯´è¯å’Œè¡ŒåŠ¨éƒ½éœ€è¦å®ƒã€‚è¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­é€‰æ‹©æ”¯æŒå·¥å…·çš„æ¨¡åž‹ï¼Œä¾‹å¦‚ qwen3 æˆ– qwen3-vlï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»å¯åŠ¨ã€‚',
  "Sei doesn't know your name yet. Open Settings, type it into the Name field, then press Launch again.":
    'Sei è¿˜ä¸çŸ¥é“ä½ çš„åå­—ã€‚æ‰“å¼€è®¾ç½®ï¼Œåœ¨â€œåå­—â€ä¸€æ å¡«å†™ï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»å¯åŠ¨ã€‚',
  'Detected MC {version}. Sei needs MC 1.14 or newer. Pick a newer profile or switch to a supported version such as {latest} before continuing.':
    'æ£€æµ‹åˆ° MC {version}ã€‚Sei éœ€è¦ MC 1.14 æˆ–æ›´æ–°ç‰ˆæœ¬ã€‚è¯·é€‰æ‹©æ›´æ–°çš„é…ç½®ï¼Œæˆ–åˆ‡æ¢åˆ° {latest} ç­‰å—æ”¯æŒçš„ç‰ˆæœ¬åŽå†ç»§ç»­ã€‚',
  "Couldn't read mod metadata, so this mod will be skipped. If it's actually compatible, copy it into <install>/sei/mods/ manually.":
    'æ— æ³•è¯»å–æ¨¡ç»„å…ƒæ•°æ®ï¼Œæ­¤æ¨¡ç»„å°†è¢«è·³è¿‡ã€‚å¦‚æžœå®ƒå…¶å®žå…¼å®¹ï¼Œè¯·æ‰‹åŠ¨å°†å…¶å¤åˆ¶åˆ° <install>/sei/mods/ ä¸­ã€‚',
  'Something went wrong. {detail}Try again.': 'å‡ºäº†ç‚¹é—®é¢˜ã€‚{detail}è¯·é‡è¯•ã€‚',

  // â”€â”€ lib/presence.ts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'In your world': 'åœ¨ä½ çš„ä¸–ç•Œé‡Œ',
  'Connectingâ€¦': 'è¿žæŽ¥ä¸­â€¦',
  'New': 'æ–°ä¼™ä¼´',
  'Online': 'åœ¨çº¿',
  'Idle': 'ç©ºé—²',

  // â”€â”€ lib/actionVerb.ts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'following youâ€¦': 'æ­£åœ¨è·Ÿç€ä½ â€¦',
  'heading somewhereâ€¦': 'æ­£åœ¨èµ¶è·¯â€¦',
  'exploringâ€¦': 'æ­£åœ¨æŽ¢ç´¢â€¦',
  'gathering {item}â€¦': 'æ­£åœ¨æ”¶é›†{item}â€¦',
  'gatheringâ€¦': 'æ­£åœ¨æ”¶é›†â€¦',
  'diggingâ€¦': 'æ­£åœ¨æŒ–æŽ˜â€¦',
  'buildingâ€¦': 'æ­£åœ¨å»ºé€ â€¦',
  'building a shelterâ€¦': 'æ­£åœ¨æ­å»ºåº‡æŠ¤æ‰€â€¦',
  'placing blocksâ€¦': 'æ­£åœ¨æ”¾ç½®æ–¹å—â€¦',
  'looking for {thing}â€¦': 'æ­£åœ¨å¯»æ‰¾{thing}â€¦',
  'looking aroundâ€¦': 'æ­£åœ¨å››å¤„å¼ æœ›â€¦',
  'gearing upâ€¦': 'æ­£åœ¨æ•´ç†è£…å¤‡â€¦',
  'having a snackâ€¦': 'æ­£åœ¨åƒç‚¹ä¸œè¥¿â€¦',
  'sleepingâ€¦': 'æ­£åœ¨ç¡è§‰â€¦',
  'fighting {target}â€¦': 'æ­£åœ¨ä¸Ž{target}æˆ˜æ–—â€¦',
  'fightingâ€¦': 'æ­£åœ¨æˆ˜æ–—â€¦',
  'crafting {item}â€¦': 'æ­£åœ¨åˆ¶ä½œ{item}â€¦',
  'craftingâ€¦': 'æ­£åœ¨åˆ¶ä½œâ€¦',
  'smeltingâ€¦': 'æ­£åœ¨ç†”ç‚¼â€¦',
  'rummaging through chestsâ€¦': 'æ­£åœ¨ç¿»ç®±å­â€¦',
  'dropping itemsâ€¦': 'æ­£åœ¨ä¸¢å¼ƒç‰©å“â€¦',
  'picking up itemsâ€¦': 'æ­£åœ¨æ¡èµ·ç‰©å“â€¦',
  'reading a signâ€¦': 'æ­£åœ¨è¯»å‘Šç¤ºç‰Œâ€¦',
  'fiddling with somethingâ€¦': 'æ­£åœ¨æ‘†å¼„ä¸œè¥¿â€¦',
  'adventuringâ€¦': 'æ­£åœ¨å†’é™©â€¦',

  // â”€â”€ stores (chess / draw / voice / wizard) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Chess is not available in this build yet.': 'å½“å‰ç‰ˆæœ¬è¿˜ä¸æ”¯æŒå›½é™…è±¡æ£‹ã€‚',
  'Draw! is not available in this build yet.': 'å½“å‰ç‰ˆæœ¬è¿˜ä¸æ”¯æŒ Draw! æ¸¸æˆã€‚',
  'Sign in to use voice calls.': 'è¯·ç™»å½•åŽä½¿ç”¨è¯­éŸ³é€šè¯ã€‚',
  "You've used this week's credits. Upgrade or top up to keep calling.":
    'æœ¬å‘¨é¢åº¦å·²ç”¨å®Œã€‚å‡çº§æˆ–å……å€¼åŽæ‰èƒ½ç»§ç»­é€šè¯ã€‚',
  // 260810: voice 429 copy no longer claims a daily cap (retired 260724);
  // it reuses the 'Too many requests right now...' key above. The paused
  // captions below used to bypass i18n entirely.
  '[voice paused, too many requests right now]': '[è¯­éŸ³å·²æš‚åœï¼Œå½“å‰è¯·æ±‚è¿‡å¤š]',
  '[voice paused, out of credits]': '[è¯­éŸ³å·²æš‚åœï¼Œé¢åº¦å·²ç”¨å®Œ]',
  '[voice unavailable, this voice is not in your ElevenLabs library]':
    '[è¯­éŸ³ä¸å¯ç”¨ï¼Œè¿™ä¸ªå£°éŸ³ä¸åœ¨ä½ çš„ ElevenLabs å£°éŸ³åº“ä¸­]',
  // 261019: the user's own ElevenLabs account answered (direct key route).
  '[voice unavailable, free ElevenLabs plans cannot use this voice]':
    '[è¯­éŸ³ä¸å¯ç”¨ï¼ŒElevenLabs å…è´¹å¥—é¤æ— æ³•ä½¿ç”¨è¿™ä¸ªå£°éŸ³]',
  '[voice paused, your ElevenLabs account is out of credits]':
    '[è¯­éŸ³å·²æš‚åœï¼Œä½ çš„ ElevenLabs è´¦æˆ·é¢åº¦å·²ç”¨å®Œ]',
  '[voice unavailable, ElevenLabs rejected your key]': '[è¯­éŸ³ä¸å¯ç”¨ï¼ŒElevenLabs æ‹’ç»äº†ä½ çš„å¯†é’¥]',
  // 261020 (T158): a cloud line for an own ElevenLabs voice spoken with the
  // character's stand-in Sei voice instead.
  '[speaking with a Sei voice, add your ElevenLabs key in Playtime to hear their own voice]':
    '[æ­£åœ¨ä½¿ç”¨ Sei çš„å£°éŸ³ï¼Œåœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­æ·»åŠ ä½ çš„ ElevenLabs å¯†é’¥å³å¯å¬åˆ° TA è‡ªå·±çš„å£°éŸ³]',
  '[speaking with a Sei voice, ElevenLabs rejected your key]':
    '[æ­£åœ¨ä½¿ç”¨ Sei çš„å£°éŸ³ï¼ŒElevenLabs æ‹’ç»äº†ä½ çš„å¯†é’¥]',
  '[speaking with a Sei voice, their voice is no longer in your ElevenLabs account]':
    '[æ­£åœ¨ä½¿ç”¨ Sei çš„å£°éŸ³ï¼ŒTA çš„å£°éŸ³å·²ä¸åœ¨ä½ çš„ ElevenLabs è´¦æˆ·ä¸­]',
  '[speaking with a Sei voice, your ElevenLabs account is out of credits]':
    '[æ­£åœ¨ä½¿ç”¨ Sei çš„å£°éŸ³ï¼Œä½ çš„ ElevenLabs è´¦æˆ·é¢åº¦å·²ç”¨å®Œ]',
  '[speaking with a Sei voice, your ElevenLabs plan cannot use their voice]':
    '[æ­£åœ¨ä½¿ç”¨ Sei çš„å£°éŸ³ï¼Œä½ çš„ ElevenLabs å¥—é¤æ— æ³•ä½¿ç”¨ TA çš„å£°éŸ³]',
  // 260816 local speech: the sherpa voice pack for this call is not downloaded.
  '[voice unavailable, download the local voice pack in Playtime]':
    '[è¯­éŸ³ä¸å¯ç”¨ï¼Œè¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­ä¸‹è½½æœ¬åœ°è¯­éŸ³åŒ…]',
  // 260908: the sentinel now names WHICH pack fits the conversation language,
  // and a line spoken with a substitute pack gets its own notice.
  '[voice unavailable, download the Chinese voice pack in Playtime]':
    '[è¯­éŸ³ä¸å¯ç”¨ï¼Œè¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­ä¸‹è½½ä¸­æ–‡è¯­éŸ³åŒ…]',
  '[voice unavailable, download the English voice pack in Playtime]':
    '[è¯­éŸ³ä¸å¯ç”¨ï¼Œè¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­ä¸‹è½½è‹±æ–‡è¯­éŸ³åŒ…]',
  '[spoken with the English voice, download the Chinese voice pack in Playtime for a better fit]':
    '[å·²ç”¨è‹±æ–‡è¯­éŸ³ä»£è¯»ï¼Œåœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­ä¸‹è½½ä¸­æ–‡è¯­éŸ³åŒ…æ•ˆæžœæ›´å¥½]',
  '[spoken with the Chinese voice, download the English voice pack in Playtime for a better fit]':
    '[å·²ç”¨ä¸­æ–‡è¯­éŸ³ä»£è¯»ï¼Œåœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­ä¸‹è½½è‹±æ–‡è¯­éŸ³åŒ…æ•ˆæžœæ›´å¥½]',
  // 261102 Kokoro local voice: missing pack, or a line the Fast voice spoke
  // because Kokoro could not.
  '[voice unavailable, download the Kokoro voice pack in Playtime]':
    '[è¯­éŸ³ä¸å¯ç”¨ï¼Œè¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­ä¸‹è½½ Kokoro è¯­éŸ³åŒ…]',
  '[spoken with the Fast voice, download the Kokoro voice pack in Playtime]':
    '[å·²ç”¨å¿«é€Ÿè¯­éŸ³ä»£è¯»ï¼Œè¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­ä¸‹è½½ Kokoro è¯­éŸ³åŒ…]',
  '[spoken with the Fast voice, the Kokoro voice could not load]':
    '[å·²ç”¨å¿«é€Ÿè¯­éŸ³ä»£è¯»ï¼ŒKokoro è¯­éŸ³æ— æ³•åŠ è½½]',
  // 261103 Fish Audio local voice: a line the Fast voice spoke instead.
  '[spoken with the Fast voice, add your Fish Audio key in Playtime]':
    '[å·²ç”¨å¿«é€Ÿè¯­éŸ³ä»£è¯»ï¼Œè¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­æ·»åŠ  Fish Audio å¯†é’¥]',
  '[spoken with the Fast voice, Fish Audio rejected your key]':
    '[å·²ç”¨å¿«é€Ÿè¯­éŸ³ä»£è¯»ï¼ŒFish Audio æ‹’ç»äº†ä½ çš„å¯†é’¥]',
  '[spoken with the Fast voice, the Fish Audio free model may have ended, or your account needs credit]':
    '[å·²ç”¨å¿«é€Ÿè¯­éŸ³ä»£è¯»ï¼ŒFish Audio å…è´¹æ¨¡åž‹å¯èƒ½å·²ç»“æŸï¼Œæˆ–ä½ çš„è´¦æˆ·éœ€è¦å……å€¼]',
  '[spoken with the Fast voice, Fish Audio is busy right now]':
    '[å·²ç”¨å¿«é€Ÿè¯­éŸ³ä»£è¯»ï¼ŒFish Audio å½“å‰ç¹å¿™]',
  '[spoken with the Fast voice, the Fish Audio voice was not found]':
    '[å·²ç”¨å¿«é€Ÿè¯­éŸ³ä»£è¯»ï¼Œæ‰¾ä¸åˆ°è¯¥ Fish Audio å£°éŸ³]',
  '[spoken with the Fast voice, Fish Audio could not be reached]':
    '[å·²ç”¨å¿«é€Ÿè¯­éŸ³ä»£è¯»ï¼Œæ— æ³•è¿žæŽ¥ Fish Audio]',
  // 260817 W10: sherpa-onnx itself failed to load (e.g. a build without the
  // platform package). Without this caption the companion is silently mute.
  '[voice unavailable, local speech cannot run on this install]':
    '[è¯­éŸ³ä¸å¯ç”¨ï¼Œæœ¬åœ°è¯­éŸ³æ— æ³•åœ¨æ­¤å®‰è£…ä¸Šè¿è¡Œ]',
  // Backseat share errors (useBackseatStore) â€” these bypassed t() until 260817.
  '{name} is in your Minecraft world right now. End that session first.':
    '{name} çŽ°åœ¨æ­£åœ¨ä½ çš„ Minecraft ä¸–ç•Œé‡Œã€‚è¯·å…ˆç»“æŸé‚£è¾¹çš„ä¼šè¯ã€‚',
  'Could not start sharing. Try picking a different window.':
    'æ— æ³•å¼€å§‹å…±äº«ã€‚è¯•è¯•é€‰æ‹©å…¶ä»–çª—å£ã€‚',
  'Could not read that window.': 'æ— æ³•è¯»å–é‚£ä¸ªçª—å£ã€‚',
  'Voice service is not available right now.': 'è¯­éŸ³æœåŠ¡æš‚æ—¶ä¸å¯ç”¨ã€‚',
  'This voice is not in your ElevenLabs library. Add it there, or pick a different voice.':
    'è¿™ä¸ªå£°éŸ³ä¸åœ¨ä½ çš„ ElevenLabs å£°éŸ³åº“ä¸­ã€‚è¯·å…ˆåœ¨é‚£é‡Œæ·»åŠ å®ƒï¼Œæˆ–é€‰æ‹©å…¶ä»–å£°éŸ³ã€‚',
  'No microphone was found. Connect one and try again.': 'æ²¡æœ‰æ‰¾åˆ°éº¦å…‹é£Žã€‚è¯·è¿žæŽ¥åŽé‡è¯•ã€‚',
  'Microphone access is off for Sei.': 'Sei çš„éº¦å…‹é£Žæƒé™å·²å…³é—­ã€‚',
  'Voice call failed to start. Try again in a moment.': 'è¯­éŸ³é€šè¯å¯åŠ¨å¤±è´¥ã€‚è¯·ç¨åŽå†è¯•ã€‚',
  // 261023: call-start failures that used to fall through to the line above.
  'Your microphone could not be opened. Close other apps that use it, or pick a different microphone in your sound settings, then try again.':
    'æ— æ³•æ‰“å¼€ä½ çš„éº¦å…‹é£Žã€‚è¯·å…³é—­æ­£åœ¨ä½¿ç”¨å®ƒçš„å…¶ä»–åº”ç”¨ï¼Œæˆ–åœ¨å£°éŸ³è®¾ç½®ä¸­é€‰æ‹©å…¶ä»–éº¦å…‹é£Žï¼Œç„¶åŽé‡è¯•ã€‚',
  'Voice recognition took too long to download. Check your connection and try again.':
    'è¯­éŸ³è¯†åˆ«ä¸‹è½½æ—¶é—´è¿‡é•¿ã€‚è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥åŽé‡è¯•ã€‚',
  'Voice recognition could not start. Check your connection and try again.':
    'è¯­éŸ³è¯†åˆ«æ— æ³•å¯åŠ¨ã€‚è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥åŽé‡è¯•ã€‚',

  // â”€â”€ OS permission cards (MicAccessCard / ScreenAccessGate, 260929) â”€â”€â”€â”€
  'Turn on your microphone': 'å¼€å¯éº¦å…‹é£Ž',
  'Restart Sei to use your microphone': 'é‡å¯ Sei ä»¥ä½¿ç”¨éº¦å…‹é£Ž',
  'Sei needs your microphone so {name} can hear you.': 'Sei éœ€è¦ä½¿ç”¨éº¦å…‹é£Žï¼Œ{name} æ‰èƒ½å¬åˆ°ä½ è¯´è¯ã€‚',
  'In System Settings, open Privacy & Security > Microphone and turn on Sei.':
    'åœ¨ã€Œç³»ç»Ÿè®¾ç½®ã€ä¸­æ‰“å¼€ã€Œéšç§ä¸Žå®‰å…¨æ€§ > éº¦å…‹é£Žã€ï¼Œç„¶åŽå¼€å¯ Seiã€‚',
  'In Settings, turn on Microphone access and Let desktop apps access your microphone.':
    'åœ¨ã€Œè®¾ç½®ã€ä¸­å¼€å¯ã€Œéº¦å…‹é£Žè®¿é—®æƒé™ã€å’Œã€Œå…è®¸æ¡Œé¢åº”ç”¨è®¿é—®ä½ çš„éº¦å…‹é£Žã€ã€‚',
  'Microphone unavailable': 'éº¦å…‹é£Žä¸å¯ç”¨',
  'Your microphone is locked by Screen Time or a device policy on this Mac.':
    'è¿™å° Mac çš„éº¦å…‹é£Žå·²è¢«ã€Œå±å¹•ä½¿ç”¨æ—¶é—´ã€æˆ–è®¾å¤‡ç®¡ç†ç­–ç•¥é”å®šã€‚',
  'The call starts on its own once access is on.': 'æƒé™å¼€å¯åŽï¼Œé€šè¯ä¼šè‡ªåŠ¨å¼€å§‹ã€‚',
  'Microphone access is on, but Sei needs a restart to use it.': 'éº¦å…‹é£Žæƒé™å·²å¼€å¯ï¼Œä½† Sei éœ€è¦é‡å¯æ‰èƒ½ä½¿ç”¨ã€‚',
  'Restart Sei and call': 'é‡å¯ Sei å¹¶é€šè¯',
  'Open Settings': 'æ‰“å¼€è®¾ç½®',
  'Sei needs Screen Recording permission to see your screen.': 'Sei éœ€è¦ã€Œå±å¹•å½•åˆ¶ã€æƒé™æ‰èƒ½çœ‹åˆ°ä½ çš„å±å¹•ã€‚',
  'In System Settings, open Privacy & Security > Screen Recording and turn on Sei.':
    'åœ¨ã€Œç³»ç»Ÿè®¾ç½®ã€ä¸­æ‰“å¼€ã€Œéšç§ä¸Žå®‰å…¨æ€§ > å±å¹•å½•åˆ¶ã€ï¼Œç„¶åŽå¼€å¯ Seiã€‚',
  'Your windows show up here once access is on.': 'æƒé™å¼€å¯åŽï¼Œä½ çš„çª—å£ä¼šæ˜¾ç¤ºåœ¨è¿™é‡Œã€‚',
  'I turned it on': 'æˆ‘å·²å¼€å¯',
  'macOS sometimes needs Sei to restart before it can see the screen.': 'macOS æœ‰æ—¶éœ€è¦é‡å¯ Sei æ‰èƒ½çœ‹åˆ°å±å¹•ã€‚',
  'Restart Sei and continue': 'é‡å¯ Sei å¹¶ç»§ç»­',
  'Could not read your open windows. Check screen recording permission for Sei.':
    'æ— æ³•è¯»å–ä½ æ‰“å¼€çš„çª—å£ã€‚è¯·æ£€æŸ¥ Sei çš„å±å¹•å½•åˆ¶æƒé™ã€‚',

  // â”€â”€ Call inactivity watchdog (CallInactivityPopup, 260810) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Are you still there?': 'ä½ è¿˜åœ¨å—ï¼Ÿ',
  'This call will end in {seconds} seconds.': 'é€šè¯å°†åœ¨ {seconds} ç§’åŽç»“æŸã€‚',
  "I'm here": 'æˆ‘è¿˜åœ¨',

  // â”€â”€ HardStopModal rate-limited fallback (260810) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Lives here rather than modals.ts because that file is mid-edit by the
  // localization sweep; misc.ts spreads last, so a duplicate key here wins.
  "Sei's servers are limiting requests right now, so your companion has to sit this one out. This does not use up any of your credits. You can try again in a moment.":
    'Sei çš„æœåŠ¡å™¨å½“å‰æ­£åœ¨é™æµï¼Œä½ çš„ä¼™ä¼´åªèƒ½å…ˆæ­‡ä¸€ä¼šå„¿ã€‚è¿™ä¸ä¼šæ¶ˆè€—ä½ çš„ä»»ä½•é¢åº¦ã€‚ç¨ç­‰ç‰‡åˆ»å³å¯å†è¯•ã€‚',

  'Detection failed': 'æ£€æµ‹å¤±è´¥',
  'Install failed': 'å®‰è£…å¤±è´¥',

  // â”€â”€ App.tsx banners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Verify your email to publish companions or buy credits. Enter the code from Sei under Settings, Account.':
    'éªŒè¯é‚®ç®±åŽæ‰èƒ½å‘å¸ƒä¼™ä¼´æˆ–è´­ä¹°é¢åº¦ã€‚è¯·åœ¨â€œè®¾ç½® - è´¦æˆ·â€ä¸­è¾“å…¥ Sei å‘æ¥çš„éªŒè¯ç ã€‚',
  'Your system has no keyring, so Sei is storing your sign-in less securely. Install gnome-keyring or kwallet for full protection.':
    'ä½ çš„ç³»ç»Ÿæ²¡æœ‰å¯†é’¥çŽ¯ï¼ŒSei åªèƒ½ä»¥è¾ƒä½Žçš„å®‰å…¨æ€§ä¿å­˜ä½ çš„ç™»å½•ä¿¡æ¯ã€‚å®‰è£… gnome-keyring æˆ– kwallet å¯èŽ·å¾—å®Œæ•´ä¿æŠ¤ã€‚',

  // â”€â”€ Image pickers (background / portrait) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Pick an image file (PNG/JPG/WebP).': 'è¯·é€‰æ‹©å›¾ç‰‡æ–‡ä»¶ï¼ˆPNG/JPG/WebPï¼‰ã€‚',
  'Failed to set the background.': 'è®¾ç½®èƒŒæ™¯å¤±è´¥ã€‚',
  'Failed to remove the background.': 'ç§»é™¤èƒŒæ™¯å¤±è´¥ã€‚',
  'Background preview': 'èƒŒæ™¯é¢„è§ˆ',
  'None': 'æ— ',
  'NONE': 'æ— ',
  'Workingâ€¦': 'å¤„ç†ä¸­â€¦',
  'Change': 'æ›´æ¢',
  'Upload': 'ä¸Šä¼ ',
  'Remove': 'ç§»é™¤',
  'Could not decode the picked file as an image.': 'æ— æ³•å°†æ‰€é€‰æ–‡ä»¶è§£ç ä¸ºå›¾ç‰‡ã€‚',
  'Could not encode the image.': 'æ— æ³•ç¼–ç è¿™å¼ å›¾ç‰‡ã€‚',
  'Picture is too big (max 4096x4096).': 'å›¾ç‰‡å¤ªå¤§ï¼ˆæœ€å¤§ 4096x4096ï¼‰ã€‚',
  'File too large (max 4MB after resize).': 'æ–‡ä»¶å¤ªå¤§ï¼ˆç¼©æ”¾åŽæœ€å¤§ 4MBï¼‰ã€‚',
  'File looks empty.': 'æ–‡ä»¶ä¼¼ä¹Žæ˜¯ç©ºçš„ã€‚',
  'Only PNG, JPEG, or WebP images are accepted.': 'åªæŽ¥å— PNGã€JPEG æˆ– WebP å›¾ç‰‡ã€‚',
  'Could not open that image.': 'æ— æ³•æ‰“å¼€è¿™å¼ å›¾ç‰‡ã€‚',
  'Could not get this image under 500KB. Try a simpler picture.':
    'æ— æ³•å°†è¿™å¼ å›¾ç‰‡åŽ‹ç¼©åˆ° 500KB ä»¥å†…ã€‚è¯·æ¢ä¸€å¼ æ›´ç®€å•çš„å›¾ç‰‡ã€‚',
  'Failed to apply portrait.': 'åº”ç”¨å¤´åƒå¤±è´¥ã€‚',
  'Failed to remove portrait.': 'ç§»é™¤å¤´åƒå¤±è´¥ã€‚',
  'Change profile picture': 'æ›´æ¢å¤´åƒ',
  'Add profile picture': 'æ·»åŠ å¤´åƒ',
  'Card image preview': 'å¡ç‰‡å›¾ç‰‡é¢„è§ˆ',
  'Picture is too big (max 1024Ã—1024).': 'å›¾ç‰‡å¤ªå¤§ï¼ˆæœ€å¤§ 1024Ã—1024ï¼‰ã€‚',
  'File too large (max 500KB after resize).': 'æ–‡ä»¶å¤ªå¤§ï¼ˆç¼©æ”¾åŽæœ€å¤§ 500KBï¼‰ã€‚',

  // â”€â”€ KnowledgeDropZone â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Upload knowledge files': 'ä¸Šä¼ çŸ¥è¯†æ–‡ä»¶',
  'Reading filesâ€¦': 'æ­£åœ¨è¯»å–æ–‡ä»¶â€¦',
  'Drop to upload': 'æ¾å¼€å³å¯ä¸Šä¼ ',
  '.md, .txt, .text, .docx (max 512 KB each)': '.mdã€.txtã€.textã€.docxï¼ˆæ¯ä¸ªæœ€å¤§ 512 KBï¼‰',

  // â”€â”€ FeedbackRewardCard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Daily feedback limit reached. Try again tomorrow.': 'å·²è¾¾åˆ°ä»Šæ—¥åé¦ˆä¸Šé™ã€‚è¯·æ˜Žå¤©å†è¯•ã€‚',
  'Sign in to submit feedback.': 'è¯·ç™»å½•åŽæäº¤åé¦ˆã€‚',
  'Feedback could not be sent. Your message is still here. Check your connection and press Submit to try again.':
    'åé¦ˆå‘é€å¤±è´¥ã€‚ä½ çš„å†…å®¹ä»ä¿ç•™åœ¨è¿™é‡Œã€‚è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥ï¼Œç„¶åŽå†æ¬¡ç‚¹å‡»æäº¤ã€‚',
  "This week's credits are reset. Thank you for the feedback.":
    'æœ¬å‘¨é¢åº¦å·²é‡ç½®ã€‚æ„Ÿè°¢ä½ çš„åé¦ˆã€‚',
  'Feedback sent. The reward was already claimed on this account.':
    'åé¦ˆå·²å‘é€ã€‚æ­¤è´¦æˆ·å·²ç»é¢†å–è¿‡è¯¥å¥–åŠ±ã€‚',
  'What do you not like about Sei? As a thank you, your weekly usage limit will be reset immediately.':
    'ä½ å¯¹ Sei æœ‰ä»€ä¹ˆä¸æ»¡æ„çš„åœ°æ–¹ï¼Ÿä½œä¸ºæ„Ÿè°¢ï¼Œä½ çš„æ¯å‘¨ä½¿ç”¨ä¸Šé™å°†ç«‹å³é‡ç½®ã€‚',
  'Tell us what to fix or improve': 'å‘Šè¯‰æˆ‘ä»¬è¯¥ä¿®å¤æˆ–æ”¹è¿›ä»€ä¹ˆ',
  'Feedback': 'åé¦ˆ',
  'Reply to my email': 'å›žå¤åˆ°æˆ‘çš„é‚®ç®±',
  'Sendingâ€¦': 'å‘é€ä¸­â€¦',
  'Submit and reset my credits': 'æäº¤å¹¶é‡ç½®æˆ‘çš„é¢åº¦',

  // â”€â”€ ProviderSelect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Choose a model provider': 'é€‰æ‹©æ¨¡åž‹æä¾›å•†',
  'Model provider': 'æ¨¡åž‹æä¾›å•†',

  // â”€â”€ SkinEditor / SkinUploadZone / UsernameSearchField / SkinPreview3d â”€â”€
  'Letters, digits, and underscores only, max 16 characters.':
    'åªèƒ½ä½¿ç”¨å­—æ¯ã€æ•°å­—å’Œä¸‹åˆ’çº¿ï¼Œæœ€å¤š 16 ä¸ªå­—ç¬¦ã€‚',
  'Skin setup not complete': 'çš®è‚¤è®¾ç½®å°šæœªå®Œæˆ',
  'Your skin wonâ€™t show in Minecraft until you set up skins on this computer.':
    'åœ¨è¿™å°ç”µè„‘ä¸Šå®Œæˆçš®è‚¤è®¾ç½®ä¹‹å‰ï¼Œçš®è‚¤ä¸ä¼šåœ¨ Minecraft ä¸­æ˜¾ç¤ºã€‚',
  'Set up skins': 'è®¾ç½®çš®è‚¤',
  'Edit skin': 'ç¼–è¾‘çš®è‚¤',
  'Skin & username': 'çš®è‚¤ä¸Žç”¨æˆ·å',
  'In-game username': 'æ¸¸æˆå†…ç”¨æˆ·å',
  'This is the name other players see above the bot. Any text works in offline LAN worlds.':
    'è¿™æ˜¯å…¶ä»–çŽ©å®¶åœ¨ä¼™ä¼´å¤´é¡¶çœ‹åˆ°çš„åå­—ã€‚ç¦»çº¿å±€åŸŸç½‘ä¸–ç•Œä¸­ä»»æ„æ–‡æœ¬éƒ½å¯ä»¥ã€‚',
  '{other} also joins as "{name}". In a world, two characters with the same in-game name share one inventory and location: connect one after the other and the second inherits the first\'s items and spot. Give one a different name to keep them separate.':
    '{other} ä¹Ÿä¼šä»¥ã€Œ{name}ã€çš„åå­—åŠ å…¥ã€‚åœ¨åŒä¸€ä¸ªä¸–ç•Œé‡Œï¼Œä¸¤ä¸ªæ¸¸æˆå†…åŒåçš„è§’è‰²ä¼šå…±äº«åŒä¸€ä»½èƒŒåŒ…å’Œä½ç½®ï¼šå…ˆåŽè¿žæŽ¥æ—¶ï¼ŒåŽè¿›å…¥çš„ä¼šç»§æ‰¿å…ˆè¿›å…¥è€…çš„ç‰©å“å’Œä½ç½®ã€‚è¯·ç»™å…¶ä¸­ä¸€ä¸ªæ”¹ä¸ªåå­—ä»¥ä¾¿åŒºåˆ†ã€‚',
  'Skin source': 'çš®è‚¤æ¥æº',
  'Upload PNG': 'ä¸Šä¼  PNG',
  'Search MC': 'æœç´¢ MC',
  'Applying...': 'åº”ç”¨ä¸­...',
  'Apply skin': 'åº”ç”¨çš®è‚¤',
  'Skin removed': 'çš®è‚¤å·²ç§»é™¤',
  'Click again to remove': 'å†æ¬¡ç‚¹å‡»ä»¥ç§»é™¤',
  'Remove skin': 'ç§»é™¤çš®è‚¤',
  'Stop the bot before changing skin. Skin applies on next connect.':
    'æ›´æ¢çš®è‚¤å‰è¯·å…ˆåœæ­¢ä¼™ä¼´ã€‚çš®è‚¤å°†åœ¨ä¸‹æ¬¡è¿žæŽ¥æ—¶ç”Ÿæ•ˆã€‚',
  'Pick an upload or search a username first.': 'è¯·å…ˆä¸Šä¼ çš®è‚¤æˆ–æœç´¢ä¸€ä¸ªç”¨æˆ·åã€‚',
  "Skin applied. It'll show up the next time the bot connects.":
    'çš®è‚¤å·²åº”ç”¨ã€‚ä¼™ä¼´ä¸‹æ¬¡è¿žæŽ¥æ—¶å°±ä¼šæ˜¾ç¤ºã€‚',
  // Skin generate button (SkinGenerateButton, 261027 lazy skins).
  'Making skin...': 'æ­£åœ¨åˆ¶ä½œçš®è‚¤...',
  'Generate Minecraft skin': 'ç”Ÿæˆ Minecraft çš®è‚¤',
  'Regenerate skin': 'é‡æ–°ç”Ÿæˆçš®è‚¤',
  'New skin ready. {name} wears it the next time they join.': 'æ–°çš®è‚¤å·²å°±ç»ªã€‚{name} ä¸‹æ¬¡åŠ å…¥æ—¶å°±ä¼šæ¢ä¸Šã€‚',
  'Not enough credits to make a skin. The current skin stays.': 'é¢åº¦ä¸è¶³ï¼Œæ— æ³•åˆ¶ä½œçš®è‚¤ã€‚å½“å‰çš®è‚¤ä¿æŒä¸å˜ã€‚',
  "You've made the most skins allowed today. Try again tomorrow.": 'ä»Šå¤©åˆ¶ä½œçš„çš®è‚¤å·²è¾¾ä¸Šé™ã€‚è¯·æ˜Žå¤©å†è¯•ã€‚',
  'Sign in to make a Minecraft skin.': 'ç™»å½•åŽæ‰èƒ½åˆ¶ä½œ Minecraft çš®è‚¤ã€‚',
  "Only {name}'s creator can make their skin.": 'åªæœ‰ {name} çš„åˆ›å»ºè€…æ‰èƒ½åˆ¶ä½œçš®è‚¤ã€‚',
  '{name} needs a picture before Sei can make their skin.': '{name} éœ€è¦å…ˆæœ‰ä¸€å¼ å›¾ç‰‡ï¼ŒSei æ‰èƒ½åˆ¶ä½œçš®è‚¤ã€‚',
  "Couldn't make a skin. The current skin stays.": 'çš®è‚¤åˆ¶ä½œå¤±è´¥ã€‚å½“å‰çš®è‚¤ä¿æŒä¸å˜ã€‚',
  'Drop a 64x64 PNG here, or click to browse': 'å°† 64x64 çš„ PNG æ‹–åˆ°è¿™é‡Œï¼Œæˆ–ç‚¹å‡»æµè§ˆ',
  'Files stay on your computer.': 'æ–‡ä»¶åªä¿å­˜åœ¨ä½ çš„ç”µè„‘ä¸Šã€‚',
  'No Minecraft account named {name}. Check the spelling.':
    'æ²¡æœ‰åä¸º {name} çš„ Minecraft è´¦æˆ·ã€‚è¯·æ£€æŸ¥æ‹¼å†™ã€‚',
  'Mojang is rate-limiting lookups. Wait a minute and try again.':
    'Mojang æ­£åœ¨é™åˆ¶æŸ¥è¯¢é¢‘çŽ‡ã€‚è¯·ç¨ç­‰ä¸€åˆ†é’Ÿå†è¯•ã€‚',
  "That doesn't look like a Minecraft username. Use letters, digits, and underscores only.":
    'è¿™çœ‹èµ·æ¥ä¸åƒ Minecraft ç”¨æˆ·åã€‚è¯·åªä½¿ç”¨å­—æ¯ã€æ•°å­—å’Œä¸‹åˆ’çº¿ã€‚',
  "Couldn't reach Mojang. Check your connection and try again.":
    'æ— æ³•è¿žæŽ¥ Mojangã€‚è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥åŽé‡è¯•ã€‚',
  'MOJANG USERNAME': 'MOJANG ç”¨æˆ·å',
  'e.g. Notch': 'ä¾‹å¦‚ Notch',
  'Mojang username': 'Mojang ç”¨æˆ·å',
  'Searching...': 'æœç´¢ä¸­...',
  'Look up': 'æŸ¥è¯¢',
  "Found {name}'s current skin.": 'å·²æ‰¾åˆ° {name} å½“å‰çš„çš®è‚¤ã€‚',
  'Loading preview...': 'é¢„è§ˆåŠ è½½ä¸­...',
  '3D preview unavailable. Showing 2D thumbnail.': '3D é¢„è§ˆä¸å¯ç”¨ã€‚å·²æ˜¾ç¤º 2D ç¼©ç•¥å›¾ã€‚',
  "3D preview of {name}'s skin": '{name} çš„çš®è‚¤ 3D é¢„è§ˆ',

  // â”€â”€ VoicePicker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Could not load the voice list.': 'æ— æ³•åŠ è½½å£°éŸ³åˆ—è¡¨ã€‚',
  'Sample unavailable right now.': 'ç¤ºä¾‹æš‚æ—¶ä¸å¯ç”¨ã€‚',
  'Stop {name} sample': 'åœæ­¢ {name} çš„å£°éŸ³ç¤ºä¾‹',
  'Play {name} sample': 'æ’­æ”¾ {name} çš„å£°éŸ³ç¤ºä¾‹',
  'Voice': 'å£°éŸ³',
  'Auto: let Sei pick': 'è‡ªåŠ¨ï¼šè®© Sei æŒ‘é€‰',
  'No voice': 'æ— å£°éŸ³',
  'Sign in to play the current voice sample. Picking a voice still works.':
    'ç™»å½•åŽæ‰èƒ½æ’­æ”¾å½“å‰å£°éŸ³ç¤ºä¾‹ã€‚é€‰æ‹©å£°éŸ³ä¸å—å½±å“ã€‚',
  'Current voice': 'å½“å‰å£°éŸ³',
  'Voice group': 'å£°éŸ³åˆ†ç»„',
  'Feminine': 'å¥³æ€§',
  'Masculine': 'ç”·æ€§',
  'Neutral': 'ä¸­æ€§',
  'Tune the voice': 'è°ƒæ•´å£°éŸ³',
  'Pick a voice to tune it.': 'å…ˆé€‰æ‹©ä¸€ä¸ªå£°éŸ³å†è¿›è¡Œè°ƒæ•´ã€‚',
  'Sign in to hear tuned samples.': 'ç™»å½•åŽæ‰èƒ½è¯•å¬è°ƒæ•´åŽçš„ç¤ºä¾‹ã€‚',
  'Pitch': 'éŸ³é«˜',
  'Reset': 'é‡ç½®',
  'Higher or lower voice. Speaking pace stays the same.': 'å£°éŸ³æ›´é«˜æˆ–æ›´ä½Žã€‚è¯­é€Ÿä¿æŒä¸å˜ã€‚',
  'Hear the pitch': 'è¯•å¬éŸ³é«˜',
  'Stop the pitch sample': 'åœæ­¢è¯•å¬',
  'Download a voice pack in Playtime to hear a sample.': 'å…ˆåœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­ä¸‹è½½è¯­éŸ³åŒ…ï¼Œæ‰èƒ½è¯•å¬ã€‚',
  'Local speech cannot run on this install.': 'æœ¬åœ°è¯­éŸ³æ— æ³•åœ¨æ­¤å®‰è£…ä¸Šè¿è¡Œã€‚',
  'Calmness': 'å¹³ç¨³åº¦',
  'Higher is steadier and more even. Lower is more dramatic.':
    'è¶Šé«˜è¶Šå¹³ç¨³å‡åŒ€ï¼Œè¶Šä½Žè¶Šå¯Œæœ‰æˆå‰§æ€§ã€‚',
  // 261019: the user's own ElevenLabs voices in the picker.
  'Your ElevenLabs voices': 'ä½ çš„ ElevenLabs å£°éŸ³',
  'No voices in your ElevenLabs account yet. Voices you clone, design or save there show up here.':
    'ä½ çš„ ElevenLabs è´¦æˆ·é‡Œè¿˜æ²¡æœ‰å£°éŸ³ã€‚ä½ åœ¨é‚£é‡Œå…‹éš†ã€è®¾è®¡æˆ–æ”¶è—çš„å£°éŸ³ä¼šæ˜¾ç¤ºåœ¨è¿™é‡Œã€‚',
  'Refresh': 'åˆ·æ–°',
  'Cloned voice': 'å…‹éš†å£°éŸ³',
  'Professional clone': 'ä¸“ä¸šå…‹éš†',
  'Designed voice': 'è®¾è®¡çš„å£°éŸ³',
  'Library voice': 'å£°éŸ³åº“å£°éŸ³',
  'Your voice': 'ä½ çš„å£°éŸ³',
  // 261020 (T158): cloud users with no key hear the stand-in Sei voice.
  'From your ElevenLabs account. Without your ElevenLabs key, a Sei voice speaks for them.':
    'æ¥è‡ªä½ çš„ ElevenLabs è´¦æˆ·ã€‚æ²¡æœ‰ä½ çš„ ElevenLabs å¯†é’¥æ—¶ï¼Œä¼šç”±ä¸€ä¸ª Sei çš„å£°éŸ³ä»£ä¸ºè¯´è¯ã€‚',
  // 261119: the Voice Library link (261120: short own-key notes, a menu label).
  'Voice options': 'å£°éŸ³é€‰é¡¹',
  'Browse the Voice Library': 'æµè§ˆå£°éŸ³åº“',
  'Voices you save there show up under Your ElevenLabs voices. Paid plans only.': 'åœ¨é‚£é‡Œæ”¶è—çš„å£°éŸ³ä¼šå‡ºçŽ°åœ¨ã€Œä½ çš„ ElevenLabs å£°éŸ³ã€ä¸­ã€‚ä»…é™ä»˜è´¹å¥—é¤ã€‚',
  'To use one, add your ElevenLabs key in Playtime. Paid plans only.': 'è¦ä½¿ç”¨ï¼Œè¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­æ·»åŠ  ElevenLabs å¯†é’¥ã€‚ä»…é™ä»˜è´¹å¥—é¤ã€‚',
  'Could not read your ElevenLabs voices. Check your ElevenLabs key in Playtime.':
    'æ— æ³•è¯»å–ä½ çš„ ElevenLabs å£°éŸ³ã€‚è¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­æ£€æŸ¥ä½ çš„ ElevenLabs å¯†é’¥ã€‚',
  'Could not load your ElevenLabs voices right now.': 'æš‚æ—¶æ— æ³•åŠ è½½ä½ çš„ ElevenLabs å£°éŸ³ã€‚',
  "Sei's voices need a paid ElevenLabs plan on your key.": "ç”¨ä½ çš„å¯†é’¥æ—¶ï¼ŒSei çš„å£°éŸ³éœ€è¦ ElevenLabs ä»˜è´¹å¥—é¤ã€‚",
  'Free ElevenLabs plans cannot play this voice through your key. Pick one of your own voices.':
    'ElevenLabs å…è´¹å¥—é¤æ— æ³•é€šè¿‡ä½ çš„å¯†é’¥æ’­æ”¾è¿™ä¸ªå£°éŸ³ã€‚è¯·é€‰æ‹©ä½ è‡ªå·±çš„å£°éŸ³ã€‚',
  'Your ElevenLabs account is out of credits.': 'ä½ çš„ ElevenLabs è´¦æˆ·é¢åº¦å·²ç”¨å®Œã€‚',
  'ElevenLabs rejected your key. Check it in Playtime.': 'ElevenLabs æ‹’ç»äº†ä½ çš„å¯†é’¥ã€‚è¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­æ£€æŸ¥ã€‚',

  // â”€â”€ Small components (BrowseCard, IdTag, InfoTip, chrome, buttons) â”€â”€â”€â”€â”€
  'Open {name}': 'æ‰“å¼€ {name}',
  'Public ID {id}': 'å…¬å¼€ ID {id}',
  'Public ID Â· #{id}': 'å…¬å¼€ ID Â· #{id}',
  'More info': 'æ›´å¤šä¿¡æ¯',
  'Expand {label}': 'å±•å¼€{label}',
  'Expand': 'å±•å¼€',
  'Minimize': 'æœ€å°åŒ–',
  'Maximize': 'æœ€å¤§åŒ–',
  'Restore': 'è¿˜åŽŸ',
  '{value} percent': '{value}%',
  'Sign in with Google': 'ä½¿ç”¨ Google ç™»å½•',
  'Sign up with Google': 'ä½¿ç”¨ Google æ³¨å†Œ',
  'Continue with Google': 'é€šè¿‡ Google ç»§ç»­',
  'Companion': 'ä¼™ä¼´',
  'You': 'ä½ ',

  // â”€â”€ 261017 (issue #46): ChatGPT plan ERROR_COPY rows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  "You've reached your ChatGPT plan's usage limit. Check Manage usage in ChatGPT to see when it resets, or switch to another AI option in Playtime.":
    'ä½ å·²è¾¾åˆ° ChatGPT å¥—é¤çš„ç”¨é‡ä¸Šé™ã€‚åœ¨ ChatGPT çš„ã€Œç®¡ç†ç”¨é‡ã€ä¸­æŸ¥çœ‹ä½•æ—¶é‡ç½®ï¼Œæˆ–åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­æ¢ç”¨å…¶ä»– AI é€‰é¡¹ã€‚',
  "This ChatGPT account can't use its plan in Sei. Plan use needs ChatGPT Plus or Pro. Sign in with a different account, or pick another AI option in Playtime.":
    'è¿™ä¸ª ChatGPT è´¦æˆ·æ— æ³•åœ¨ Sei ä¸­ä½¿ç”¨å…¶å¥—é¤ã€‚å¥—é¤ç”¨é‡éœ€è¦ ChatGPT Plus æˆ– Proã€‚è¯·æ¢ä¸€ä¸ªè´¦æˆ·ç™»å½•ï¼Œæˆ–åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­é€‰æ‹©å…¶ä»– AI é€‰é¡¹ã€‚',
  "ChatGPT plan use isn't available here right now. It may be limited in your region or by your plan. Pick another AI option in Playtime.":
    'ç›®å‰æ— æ³•åœ¨è¿™é‡Œä½¿ç”¨ ChatGPT å¥—é¤ï¼Œå¯èƒ½å—ä½ æ‰€åœ¨åœ°åŒºæˆ–å¥—é¤çš„é™åˆ¶ã€‚è¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­é€‰æ‹©å…¶ä»– AI é€‰é¡¹ã€‚',
  "ChatGPT didn't accept Sei's sign-in, even after renewing it. Continue with ChatGPT in Playtime to sign in again.":
    'ChatGPT ä¸æŽ¥å— Sei çš„ç™»å½•ï¼Œå³ä½¿å·²ç»ç»­æœŸä¹Ÿä¸€æ ·ã€‚è¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­ç‚¹å‡»ã€Œé€šè¿‡ ChatGPT ç»§ç»­ã€é‡æ–°ç™»å½•ã€‚',
  "ChatGPT didn't accept the request Sei sent, so your companion stopped. Try again, or pick another AI option in Playtime.":
    'ChatGPT ä¸æŽ¥å— Sei å‘é€çš„è¯·æ±‚ï¼Œæ‰€ä»¥ä½ çš„ä¼™ä¼´å·²åœä¸‹ã€‚è¯·é‡è¯•ï¼Œæˆ–åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­é€‰æ‹©å…¶ä»– AI é€‰é¡¹ã€‚',
  "The ChatGPT model picked in Playtime can't handle this request. Pick another model there and try again.":
    'ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­é€‰æ‹©çš„ ChatGPT æ¨¡åž‹æ— æ³•å¤„ç†è¿™ä¸ªè¯·æ±‚ã€‚è¯·åœ¨é‚£é‡Œæ¢ä¸€ä¸ªæ¨¡åž‹åŽé‡è¯•ã€‚',
  'Your ChatGPT sign-in ended. Continue with ChatGPT in Playtime to sign in again.':
    'ä½ çš„ ChatGPT ç™»å½•å·²å¤±æ•ˆã€‚è¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­ç‚¹å‡»ã€Œé€šè¿‡ ChatGPT ç»§ç»­ã€é‡æ–°ç™»å½•ã€‚',
  "ChatGPT plan use isn't turned on for this sign-in. Turn it on in Playtime, then try again.":
    'è¿™æ¬¡ç™»å½•æ²¡æœ‰å¼€å¯ ChatGPT å¥—é¤ä½¿ç”¨æƒé™ã€‚è¯·åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­å¼€å¯åŽé‡è¯•ã€‚',
  // 261019: own ElevenLabs voice on a shared character ("Others will hear").
  "Your voice is from your ElevenLabs account, so others can't play it. Others will hear:":
    'è¿™ä¸ªå£°éŸ³æ¥è‡ªä½ çš„ ElevenLabs è´¦å·ï¼Œå…¶ä»–äººæ— æ³•æ’­æ”¾ã€‚å…¶ä»–äººä¼šå¬åˆ°ï¼š',
  'Voice others will hear': 'å…¶ä»–äººå¬åˆ°çš„å£°éŸ³',
  'Closest Sei voice ({name})': 'æœ€æŽ¥è¿‘çš„ Sei å£°éŸ³ï¼ˆ{name}ï¼‰',
  'Closest Sei voice': 'æœ€æŽ¥è¿‘çš„ Sei å£°éŸ³',
  'Sei voice': 'Sei å£°éŸ³',
  'Voice for others: {name}': 'å…¶ä»–äººå¬åˆ°çš„å£°éŸ³ï¼š{name}',
  'Voice for others: a Sei voice': 'å…¶ä»–äººå¬åˆ°çš„å£°éŸ³ï¼šä¸€ä¸ª Sei å£°éŸ³',

  // â”€â”€ 261023: Continue with ChatGPT as a Sei account sign-in â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'ChatGPT did not confirm this email, so Sei checks it once.': 'ChatGPT æ²¡æœ‰ç¡®è®¤è¿™ä¸ªé‚®ç®±ï¼Œæ‰€ä»¥ Sei éœ€è¦éªŒè¯ä¸€æ¬¡ã€‚',
  'ChatGPT sign-in': 'ChatGPT ç™»å½•',
  'ChatGPT sign-in hit a snag. Try again.': 'ChatGPT ç™»å½•å‡ºäº†ç‚¹é—®é¢˜ï¼Œè¯·é‡è¯•ã€‚',
  'ChatGPT sign-in is having trouble right now. Try again in a moment.': 'ChatGPT ç™»å½•æš‚æ—¶æœ‰é—®é¢˜ï¼Œè¯·ç¨åŽå†è¯•ã€‚',
  "ChatGPT sign-in isn't available in your region.": 'ä½ æ‰€åœ¨çš„åœ°åŒºæ— æ³•ä½¿ç”¨ ChatGPT ç™»å½•ã€‚',
  'OpenAI does not support your region. You can use local mode with your own API key instead.':
    'OpenAI ä¸æ”¯æŒä½ æ‰€åœ¨çš„åœ°åŒºã€‚ä½ å¯ä»¥æ”¹ç”¨æœ¬åœ°æ¨¡å¼ï¼Œä½¿ç”¨ä½ è‡ªå·±çš„ API å¯†é’¥ã€‚',
  'OpenAI does not support your region.': 'OpenAI ä¸æ”¯æŒä½ æ‰€åœ¨çš„åœ°åŒºã€‚',
  '{provider} does not support your region.': '{provider} ä¸æ”¯æŒä½ æ‰€åœ¨çš„åœ°åŒºã€‚',
  'Your AI provider': 'ä½ çš„ AI æœåŠ¡å•†',
  'Local mode can also use your ChatGPT plan.': 'æœ¬åœ°æ¨¡å¼ä¹Ÿå¯ä»¥ä½¿ç”¨ä½ çš„ ChatGPT å¥—é¤ã€‚',
  'ChatGPT sign-in was declined. Try again, or use another way to sign in.': 'ChatGPT ç™»å½•è¢«æ‹’ç»ã€‚è¯·é‡è¯•ï¼Œæˆ–æ¢ä¸€ç§æ–¹å¼ç™»å½•ã€‚',
  "Couldn't reach Sei. Check your internet and try again.": 'æ— æ³•è¿žæŽ¥åˆ° Seiã€‚è¯·æ£€æŸ¥ç½‘ç»œåŽé‡è¯•ã€‚',
  'Finish in your browser': 'è¯·åœ¨æµè§ˆå™¨ä¸­å®Œæˆ',
  'Finish signing in to ChatGPT in the browser tab that opened.': 'è¯·åœ¨æ‰“å¼€çš„æµè§ˆå™¨æ ‡ç­¾é¡µä¸­å®Œæˆ ChatGPT ç™»å½•ã€‚',
  'First time on this computer. Enter the code to confirm it is you.': 'è¿™æ˜¯ä½ ç¬¬ä¸€æ¬¡åœ¨è¿™å°ç”µè„‘ä¸Šç™»å½•ã€‚è¯·è¾“å…¥éªŒè¯ç ç¡®è®¤æ˜¯ä½ æœ¬äººã€‚',
  'Link ChatGPT': 'å…³è” ChatGPT',
  'Linked': 'å·²å…³è”',
  'Unlink': 'å–æ¶ˆå…³è”',
  "Couldn't unlink right now. Try again later.": 'æš‚æ—¶æ— æ³•å–æ¶ˆå…³è”ï¼Œè¯·ç¨åŽå†è¯•ã€‚',
  "Sei couldn't confirm your ChatGPT sign-in. Try again.": 'Sei æ— æ³•ç¡®è®¤ä½ çš„ ChatGPT ç™»å½•ï¼Œè¯·é‡è¯•ã€‚',
  "Sei couldn't open your browser. Try again.": 'Sei æ— æ³•æ‰“å¼€ä½ çš„æµè§ˆå™¨ï¼Œè¯·é‡è¯•ã€‚',
  'Sign in to Sei first.': 'è¯·å…ˆç™»å½• Seiã€‚',
  'That Sei account is already linked to a different ChatGPT account. Sign in with your email or Google instead.':
    'è¿™ä¸ª Sei è´¦æˆ·å·²ç»å…³è”äº†å¦ä¸€ä¸ª ChatGPT è´¦æˆ·ã€‚è¯·æ”¹ç”¨é‚®ç®±æˆ– Google ç™»å½•ã€‚',
  'That code expired or had too many tries. Start again.': 'éªŒè¯ç å·²è¿‡æœŸæˆ–å°è¯•æ¬¡æ•°è¿‡å¤šï¼Œè¯·é‡æ–°å¼€å§‹ã€‚',
  "That code isn't right. Check it and try again.": 'éªŒè¯ç ä¸æ­£ç¡®ï¼Œè¯·æ£€æŸ¥åŽé‡è¯•ã€‚',
  'The ChatGPT sign-in took too long. Try again.': 'ChatGPT ç™»å½•ç”¨æ—¶è¿‡é•¿ï¼Œè¯·é‡è¯•ã€‚',
  'This ChatGPT account is already linked to a different Sei account.': 'è¿™ä¸ª ChatGPT è´¦æˆ·å·²ç»å…³è”äº†å¦ä¸€ä¸ª Sei è´¦æˆ·ã€‚',
  'This email already has a Sei account. Enter the code to sign in to it with ChatGPT.':
    'è¿™ä¸ªé‚®ç®±å·²ç»æœ‰ Sei è´¦æˆ·ã€‚è¾“å…¥éªŒè¯ç ï¼Œå³å¯ç”¨ ChatGPT ç™»å½•è¯¥è´¦æˆ·ã€‚',
  'Too many tries. Wait a bit, or continue with Google.': 'å°è¯•æ¬¡æ•°è¿‡å¤šï¼Œè¯·ç¨ç­‰ä¸€ä¼šå„¿ï¼Œæˆ–ä½¿ç”¨ Google ç»§ç»­ã€‚',
  'Too many tries. Wait a bit and try again.': 'å°è¯•æ¬¡æ•°è¿‡å¤šï¼Œè¯·ç¨ç­‰ä¸€ä¼šå„¿å†è¯•ã€‚',
  "We opened a browser tab to finish signing in with ChatGPT. Come back when you're done; this picks up on its own.":
    'æˆ‘ä»¬æ‰“å¼€äº†ä¸€ä¸ªæµè§ˆå™¨æ ‡ç­¾é¡µæ¥å®Œæˆ ChatGPT ç™»å½•ã€‚å®ŒæˆåŽå›žåˆ°è¿™é‡Œï¼Œä¼šè‡ªåŠ¨ç»§ç»­ã€‚',
  "Your ChatGPT account didn't share an email address, so Sei can't make an account from it.":
    'ä½ çš„ ChatGPT è´¦æˆ·æ²¡æœ‰æä¾›é‚®ç®±åœ°å€ï¼Œæ‰€ä»¥ Sei æ— æ³•ç”¨å®ƒåˆ›å»ºè´¦æˆ·ã€‚',
  // Voice Library voices on Sei cloud (261119).
  "This voice is no longer available.": "è¿™ä¸ªå£°éŸ³å·²ä¸å†å¯ç”¨ã€‚",
  "No longer available. A similar Sei voice speaks for them until you pick another.": "å·²ä¸å†å¯ç”¨ã€‚åœ¨ä½ å¦é€‰å£°éŸ³ä¹‹å‰ï¼Œç”±ä¸€ä¸ªç›¸ä¼¼çš„ Sei å£°éŸ³ä»£ä¸ºå‘å£°ã€‚",
  "Use a voice from the library": "ä½¿ç”¨å£°éŸ³åº“ä¸­çš„å£°éŸ³",
  "Voice Library link or voice ID": "å£°éŸ³åº“é“¾æŽ¥æˆ–å£°éŸ³ ID",
  "Looking up...": "æŸ¥è¯¢ä¸­...",
  "In use": "ä½¿ç”¨ä¸­",
  "Adding...": "æ·»åŠ ä¸­...",
  "Use this voice": "ä½¿ç”¨è¿™ä¸ªå£°éŸ³",
  "Paste a link from the ElevenLabs Voice Library, or a voice ID.": "è¯·ç²˜è´´ ElevenLabs å£°éŸ³åº“çš„é“¾æŽ¥æˆ–å£°éŸ³ IDã€‚",
  "That voice is not in the public ElevenLabs Voice Library.": "å…¬å¼€çš„ ElevenLabs å£°éŸ³åº“ä¸­æ²¡æœ‰è¿™ä¸ªå£°éŸ³ã€‚",
  "That voice is already one of the Sei voices below.": "è¿™ä¸ªå£°éŸ³å·²ç»æ˜¯ä¸‹æ–¹çš„ Sei å£°éŸ³ä¹‹ä¸€ã€‚",
  "That voice costs extra to use, so it cannot be used on the Sei plan.": "è¿™ä¸ªå£°éŸ³éœ€è¦é¢å¤–ä»˜è´¹ï¼Œå› æ­¤æ— æ³•åœ¨ Sei å¥—é¤ä¸­ä½¿ç”¨ã€‚",
  "That voice has its own content checks that can cut lines off, so it cannot be used here.": "è¿™ä¸ªå£°éŸ³è‡ªå¸¦å†…å®¹å®¡æ ¸ï¼Œå¯èƒ½ä¼šæˆªæ–­å°è¯ï¼Œå› æ­¤æ— æ³•åœ¨è¿™é‡Œä½¿ç”¨ã€‚",
  "That voice could leave the library on short notice, so it cannot be used here.": "è¿™ä¸ªå£°éŸ³å¯èƒ½ä¼šåœ¨çŸ­æ—¶é—´å†…ä»Žå£°éŸ³åº“ä¸‹æž¶ï¼Œå› æ­¤æ— æ³•åœ¨è¿™é‡Œä½¿ç”¨ã€‚",
  "That voice is leaving the library, so it cannot be used.": "è¿™ä¸ªå£°éŸ³å³å°†ä»Žå£°éŸ³åº“ä¸‹æž¶ï¼Œå› æ­¤æ— æ³•ä½¿ç”¨ã€‚",
  "That kind of voice cannot be used on the Sei plan.": "è¿™ç±»å£°éŸ³æ— æ³•åœ¨ Sei å¥—é¤ä¸­ä½¿ç”¨ã€‚",
  "You have added as many library voices as you can today. Try again tomorrow.": "ä½ ä»Šå¤©æ·»åŠ çš„å£°éŸ³åº“å£°éŸ³å·²è¾¾ä¸Šé™ã€‚è¯·æ˜Žå¤©å†è¯•ã€‚",
  "Your companions already use as many library voices as allowed. Switch one back to a Sei voice first.": "ä½ çš„è§’è‰²ä½¿ç”¨çš„å£°éŸ³åº“å£°éŸ³å·²è¾¾ä¸Šé™ã€‚è¯·å…ˆæŠŠå…¶ä¸­ä¸€ä¸ªæ¢å›ž Sei å£°éŸ³ã€‚",
  "Library voices are full right now. Try again later, or pick a Sei voice.": "å£°éŸ³åº“å£°éŸ³ç›®å‰å·²æ»¡ã€‚è¯·ç¨åŽå†è¯•ï¼Œæˆ–é€‰æ‹©ä¸€ä¸ª Sei å£°éŸ³ã€‚",
  "Sign in to use a voice from the library.": "ç™»å½•åŽå³å¯ä½¿ç”¨å£°éŸ³åº“ä¸­çš„å£°éŸ³ã€‚",
  "Too many tries. Wait a little and try again.": "å°è¯•æ¬¡æ•°è¿‡å¤šã€‚è¯·ç¨ç­‰åŽå†è¯•ã€‚",
  "Could not reach the Voice Library right now. Try again in a moment.": "æš‚æ—¶æ— æ³•è¿žæŽ¥å£°éŸ³åº“ã€‚è¯·ç¨åŽå†è¯•ã€‚",
  "[spoken with a similar Sei voice, their Voice Library voice is no longer available]": "[å·²ç”¨ç›¸ä¼¼çš„ Sei å£°éŸ³è¯´å‡ºï¼ŒTA çš„å£°éŸ³åº“å£°éŸ³å·²ä¸å†å¯ç”¨]",
};




