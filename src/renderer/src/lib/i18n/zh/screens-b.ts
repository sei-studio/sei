/** Filled by the localization sweep. See ../zh.ts for the dictionary rules. */
export const ZH_SCREENS_B: Record<string, string> = {
  // â”€â”€ SettingsScreen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Profile': 'ä¸ªäººèµ„æ–™',
  'Your name': 'ä½ çš„åå­—',
  'Name': 'åå­—',
  'Account': 'è´¦æˆ·',
  'Email': 'é‚®ç®±',
  'Sign out': 'é€€å‡ºç™»å½•',
  'Sendingâ€¦': 'å‘é€ä¸­â€¦',
  // 260804 â€” the row opens the code modal (which sends on mount) instead of
  // resending a link, so this screen no longer owns any send-status copy.
  'Verify email': 'éªŒè¯é‚®ç®±',
  'Enter code': 'è¾“å…¥éªŒè¯ç ',
  'Account ID': 'è´¦æˆ· ID',
  'Copy account ID': 'å¤åˆ¶è´¦æˆ· ID',
  'Copied': 'å·²å¤åˆ¶',
  'Copy': 'å¤åˆ¶',
  'Companion preferences': 'ä¼™ä¼´åå¥½',
  'Update my preferences': 'æ›´æ–°æˆ‘çš„åå¥½',
  'Companions from before you signed in': 'ç™»å½•å‰çš„ä¼™ä¼´',
  'Bring over': 'å¸¦è¿‡æ¥',
  'Upload companions to the cloud': 'æŠŠä¼™ä¼´ä¸Šä¼ åˆ°äº‘ç«¯',
  'Export data': 'å¯¼å‡ºæ•°æ®',
  'Export as JSON': 'å¯¼å‡ºä¸º JSON',
  'Saved to {path}': 'å·²ä¿å­˜åˆ° {path}',
  "Couldn't prepare your export. Try again in a moment.": 'æ— æ³•å‡†å¤‡å¯¼å‡ºæ–‡ä»¶ï¼Œè¯·ç¨åŽå†è¯•ã€‚',
  'AI': 'AI',
  'Backend': 'åŽç«¯',
  'About the AI backend': 'å…³äºŽ AI åŽç«¯',
  'Switching to your own API key turns off managed billing and routes Sei through the key stored on this device. Your subscription keeps renewing until you cancel it.':
    'åˆ‡æ¢åˆ°ä½ è‡ªå·±çš„ API å¯†é’¥ä¼šå…³é—­æ‰˜ç®¡è®¡è´¹ï¼Œå¹¶è®© Sei ä½¿ç”¨ä¿å­˜åœ¨æœ¬è®¾å¤‡ä¸Šçš„å¯†é’¥ã€‚ä½ çš„è®¢é˜…ä¼šæŒç»­ç»­è´¹ï¼Œç›´åˆ°ä½ å–æ¶ˆä¸ºæ­¢ã€‚',
  'Cloud turns off your local API key and routes Sei through our managed cloud. Switch back any time.':
    'äº‘ç«¯æ¨¡å¼ä¼šåœç”¨ä½ æœ¬åœ°çš„ API å¯†é’¥ï¼Œè®© Sei é€šè¿‡æˆ‘ä»¬çš„æ‰˜ç®¡äº‘ç«¯è¿è¡Œã€‚éšæ—¶å¯ä»¥åˆ‡æ¢å›žæ¥ã€‚',
  'Cloud': 'äº‘ç«¯',
  'My key': 'æˆ‘çš„å¯†é’¥',
  'Switched. Your running bot now routes through Seiâ€™s managed cloud.':
    'å·²åˆ‡æ¢ã€‚ä½ æ­£åœ¨è¿è¡Œçš„æœºå™¨äººçŽ°åœ¨é€šè¿‡ Sei çš„æ‰˜ç®¡äº‘ç«¯è¿è¡Œã€‚',
  'Switched. Your running bot now uses your own API key.':
    'å·²åˆ‡æ¢ã€‚ä½ æ­£åœ¨è¿è¡Œçš„æœºå™¨äººçŽ°åœ¨ä½¿ç”¨ä½ è‡ªå·±çš„ API å¯†é’¥ã€‚',
  'Provider': 'æ¨¡åž‹æä¾›å•†',
  'API key': 'API å¯†é’¥',
  'Not set': 'æœªè®¾ç½®',
  'Update': 'æ›´æ–°',
  'Set': 'è®¾ç½®',
  'API key cannot be empty.': 'API å¯†é’¥ä¸èƒ½ä¸ºç©ºã€‚',
  'Failed to save key. Try again.': 'å¯†é’¥ä¿å­˜å¤±è´¥ï¼Œè¯·é‡è¯•ã€‚',
  'Failed to save. Try again.': 'ä¿å­˜å¤±è´¥ï¼Œè¯·é‡è¯•ã€‚',
  'Failed to save provider. Try again.': 'æä¾›å•†ä¿å­˜å¤±è´¥ï¼Œè¯·é‡è¯•ã€‚',
  'ElevenLabs key': 'ElevenLabs å¯†é’¥',
  'About the ElevenLabs key': 'å…³äºŽ ElevenLabs å¯†é’¥',
  "sorry :( i'm working to support other voice models. for now, tts only supports elevenlabs.":
    'æŠ±æ­‰ :( æˆ‘ä»¬æ­£åœ¨åŠªåŠ›æ”¯æŒå…¶ä»–è¯­éŸ³æ¨¡åž‹ã€‚ç›®å‰è¯­éŸ³åˆæˆåªæ”¯æŒ ElevenLabsã€‚',
  'Your ElevenLabs key': 'ä½ çš„ ElevenLabs å¯†é’¥',
  'Your own ElevenLabs voices show up in the voice picker once your key is saved.':
    'ä¿å­˜å¯†é’¥åŽï¼Œä½ è‡ªå·±çš„ ElevenLabs å£°éŸ³ä¼šå‡ºçŽ°åœ¨å£°éŸ³é€‰æ‹©å™¨ä¸­ã€‚',
  // 261020 (T158): the optional ElevenLabs key for Sei Cloud accounts.
  'Use your own ElevenLabs voices': 'ä½¿ç”¨ä½ è‡ªå·±çš„ ElevenLabs å£°éŸ³',
  "Optional. Only needed for voices from your own ElevenLabs account, like a clone of your voice. Those voices use your ElevenLabs credits. Sei's voices are included in your plan.":
    'å¯é€‰ã€‚åªæœ‰ä½¿ç”¨ä½ è‡ªå·± ElevenLabs è´¦æˆ·é‡Œçš„å£°éŸ³ï¼ˆä¾‹å¦‚å…‹éš†çš„ä½ è‡ªå·±çš„å£°éŸ³ï¼‰æ—¶æ‰éœ€è¦ã€‚è¿™äº›å£°éŸ³ä¼šæ¶ˆè€—ä½ çš„ ElevenLabs é¢åº¦ã€‚Sei çš„å£°éŸ³å·²åŒ…å«åœ¨ä½ çš„å¥—é¤ä¸­ã€‚',
  "Only for voices in your own ElevenLabs account. Sei's voices and voice recognition keep running on Sei Cloud and never use this key.":
    'ä»…ç”¨äºŽä½ è‡ªå·± ElevenLabs è´¦æˆ·é‡Œçš„å£°éŸ³ã€‚Sei çš„å£°éŸ³å’Œè¯­éŸ³è¯†åˆ«ç»§ç»­é€šè¿‡ Sei Cloud è¿è¡Œï¼Œä¸ä¼šä½¿ç”¨è¿™ä¸ªå¯†é’¥ã€‚',
  'Remove': 'ç§»é™¤',
  'Key cannot be empty.': 'å¯†é’¥ä¸èƒ½ä¸ºç©ºã€‚',
  'Failed to remove key. Try again.': 'å¯†é’¥ç§»é™¤å¤±è´¥ï¼Œè¯·é‡è¯•ã€‚',
  'Voice recognition': 'è¯­éŸ³è¯†åˆ«',
  'ElevenLabs Scribe': 'ElevenLabs Scribe',
  'Local Whisper': 'æœ¬åœ° Whisper',
  'Offline. Downloads a small model on first call.':
    'ç¦»çº¿è¿è¡Œã€‚é¦–æ¬¡é€šè¯æ—¶ä¼šä¸‹è½½ä¸€ä¸ªå°æ¨¡åž‹ã€‚',
  'Better accuracy. Uses your ElevenLabs key.': 'è¯†åˆ«æ›´å‡†ç¡®ã€‚ä½¿ç”¨ä½ çš„ ElevenLabs å¯†é’¥ã€‚',
  'Minecraft': 'Minecraft',
  'Custom skins': 'è‡ªå®šä¹‰çš®è‚¤',
  'About custom skins': 'å…³äºŽè‡ªå®šä¹‰çš®è‚¤',
  'Give your companion a Minecraft skin so it looks right in your world. This runs a quick one-time setup for your Minecraft install.':
    'ç»™ä½ çš„ä¼™ä¼´ä¸€ä¸ª Minecraft çš®è‚¤ï¼Œè®©å®ƒåœ¨ä½ çš„ä¸–ç•Œé‡Œæœ‰æ­£ç¡®çš„å¤–è§‚ã€‚è¿™ä¼šä¸ºä½ çš„ Minecraft å®‰è£…åšä¸€æ¬¡å¿«é€Ÿçš„ä¸€æ¬¡æ€§è®¾ç½®ã€‚',
  'Re-run setup': 'é‡æ–°è¿è¡Œè®¾ç½®',
  'Run setup': 'è¿è¡Œè®¾ç½®',
  'Visual gameplay': 'è§†è§‰æ¸¸çŽ©',
  'About visual gameplay': 'å…³äºŽè§†è§‰æ¸¸çŽ©',
  "Companions usually play from lightweight snapshots of the world, but can pull a full render of what's around them when they need to see it, for example when building or navigating.":
    'ä¼™ä¼´é€šå¸¸é€šè¿‡è½»é‡çš„ä¸–ç•Œå¿«ç…§æ¥æ¸¸çŽ©ï¼Œä½†åœ¨éœ€è¦çœ‹æ¸…å‘¨å›´æ—¶ï¼ˆä¾‹å¦‚å»ºé€ æˆ–å¯»è·¯ï¼‰ï¼Œå¯ä»¥èŽ·å–å‘¨å›´çŽ¯å¢ƒçš„å®Œæ•´æ¸²æŸ“ã€‚',
  'Visual gameplay mode': 'è§†è§‰æ¸¸çŽ©æ¨¡å¼',
  'Off': 'å…³é—­',
  'On-demand': 'æŒ‰éœ€',
  'Continuous': 'æŒç»­',
  'Theme': 'ä¸»é¢˜',
  'Midnight': 'åˆå¤œ',
  'Ice': 'å†°è“',
  'Acorn': 'æ©¡æžœ',
  'Mint': 'è–„è·',
  'Background': 'èƒŒæ™¯',
  'About custom backgrounds': 'å…³äºŽè‡ªå®šä¹‰èƒŒæ™¯',
  'Shows your own picture behind the app, under the theme colors. Use the sliders to blend it in.':
    'åœ¨åº”ç”¨èƒŒåŽã€ä¸»é¢˜é¢œè‰²ä¹‹ä¸‹æ˜¾ç¤ºä½ è‡ªå·±çš„å›¾ç‰‡ã€‚ç”¨æ»‘å—è°ƒæ•´è®©å®ƒèžå…¥ç•Œé¢ã€‚',
  'Background visibility': 'èƒŒæ™¯å¯è§åº¦',
  'Background brightness': 'èƒŒæ™¯äº®åº¦',
  'Appearance': 'å¤–è§‚',
  'Realistic typing': 'æ‹ŸçœŸæ‰“å­—',
  'About realistic typing': 'å…³äºŽæ‹ŸçœŸæ‰“å­—',
  'Pauses to read your message, then paces typing to a human speed, in chat and in-game. Off replies instantly.':
    'ä¼šå…ˆåœä¸‹æ¥é˜…è¯»ä½ çš„æ¶ˆæ¯ï¼Œå†ä»¥æŽ¥è¿‘çœŸäººçš„é€Ÿåº¦æ‰“å­—ï¼ŒèŠå¤©å’Œæ¸¸æˆå†…éƒ½ç”Ÿæ•ˆã€‚å…³é—­åŽä¼šç«‹å³å›žå¤ã€‚',
  'Developer console': 'å¼€å‘è€…æŽ§åˆ¶å°',
  'About the developer console': 'å…³äºŽå¼€å‘è€…æŽ§åˆ¶å°',
  'Useful for debugging skin and bot issues.': 'ç”¨äºŽè°ƒè¯•çš®è‚¤å’Œæœºå™¨äººé—®é¢˜ã€‚',
  'Show developer console': 'æ˜¾ç¤ºå¼€å‘è€…æŽ§åˆ¶å°',
  'Usage analytics': 'ä½¿ç”¨æƒ…å†µåˆ†æž',
  'About usage analytics': 'å…³äºŽä½¿ç”¨æƒ…å†µåˆ†æž',
  'Shares anonymous usage data (feature counts, versions, errors) to help improve Sei. Never your chats, characters, or personal info. Turn off any time.':
    'åˆ†äº«åŒ¿åä½¿ç”¨æ•°æ®ï¼ˆåŠŸèƒ½ä½¿ç”¨æ¬¡æ•°ã€ç‰ˆæœ¬ã€é”™è¯¯ï¼‰æ¥å¸®åŠ©æ”¹è¿› Seiã€‚ç»ä¸åŒ…å«ä½ çš„èŠå¤©ã€è§’è‰²æˆ–ä¸ªäººä¿¡æ¯ã€‚å¯éšæ—¶å…³é—­ã€‚',
  'Call captions': 'é€šè¯å­—å¹•',
  'About call captions': 'å…³äºŽé€šè¯å­—å¹•',
  'Shows live captions during voice calls: what the companion said and what Sei heard you say.':
    'åœ¨è¯­éŸ³é€šè¯ä¸­æ˜¾ç¤ºå®žæ—¶å­—å¹•ï¼šä¼™ä¼´è¯´äº†ä»€ä¹ˆï¼Œä»¥åŠ Sei å¬åˆ°ä½ è¯´äº†ä»€ä¹ˆã€‚',
  // Avatar overlay (260804, grew out of the 260706 call overlay setting)
  'About the avatar': 'å…³äºŽè™šæ‹Ÿå½¢è±¡',
  'Floats your companion on top of every app: their picture, or a Live2D model from their profile. "When active" shows it during calls, games, screensharing and Minecraft; "Always" keeps it up while Sei is open. Hover it to move or resize.':
    'æŠŠä¼™ä¼´æ‚¬æµ®æ˜¾ç¤ºåœ¨æ‰€æœ‰åº”ç”¨ä¹‹ä¸Šï¼šå¯ä»¥æ˜¯ä»–ä»¬çš„å¤´åƒï¼Œä¹Ÿå¯ä»¥æ˜¯è§’è‰²é¡µé‡Œè®¾ç½®çš„ Live2D æ¨¡åž‹ã€‚ã€Œæ´»åŠ¨æ—¶ã€åœ¨é€šè¯ã€æ¸¸æˆã€å±å¹•åˆ†äº«å’Œ Minecraft æœŸé—´æ˜¾ç¤ºï¼›ã€Œä¸€ç›´æ˜¾ç¤ºã€åˆ™åªè¦ Sei å¼€ç€å°±ä¸€ç›´æ˜¾ç¤ºã€‚é¼ æ ‡æ‚¬åœå¯ä»¥ç§»åŠ¨å’Œè°ƒæ•´å¤§å°ã€‚',
  'When active': 'æ´»åŠ¨æ—¶',
  'Always': 'ä¸€ç›´æ˜¾ç¤º',
  'Conversation starters': 'ä¸»åŠ¨å¼€å¯è¯é¢˜',
  'About conversation starters': 'å…³äºŽä¸»åŠ¨å¼€å¯è¯é¢˜',
  'When a voice call goes quiet for a bit, your companion can bring up a topic on their own instead of waiting for you to speak.':
    'å½“è¯­éŸ³é€šè¯å®‰é™äº†ä¸€ä¼šå„¿ï¼Œä½ çš„ä¼™ä¼´å¯ä»¥è‡ªå·±å¼€å¯ä¸€ä¸ªè¯é¢˜ï¼Œè€Œä¸æ˜¯ç­‰ä½ å…ˆå¼€å£ã€‚',
  'About': 'å…³äºŽ',
  'Version': 'ç‰ˆæœ¬',
  'Check now': 'ç«‹å³æ£€æŸ¥',
  'checkingâ€¦': 'æ£€æŸ¥ä¸­â€¦',
  'up to date': 'å·²æ˜¯æœ€æ–°',
  'update available': 'æœ‰å¯ç”¨æ›´æ–°',
  'check failed': 'æ£€æŸ¥å¤±è´¥',
  // 261103: "Advanced updates" renamed to Experimental updates, ON asks first.
  'Experimental updates': 'å®žéªŒæ€§æ›´æ–°',
  // 260909 Search group
  'Search': 'æœç´¢',
  // 261023: web search moved into the Games group, renamed for both.
  'Games & search': 'æ¸¸æˆä¸Žæœç´¢',
  'Web search': 'ç½‘é¡µæœç´¢',
  'Companions can look things up on the web while you chat or play. This works out of the box for free. Add your own search API key only if lookups keep failing.':
    'ä¼™ä¼´åœ¨èŠå¤©æˆ–æ¸¸æˆæ—¶å¯ä»¥ä¸Šç½‘æŸ¥èµ„æ–™ã€‚é»˜è®¤å…è´¹å¯ç”¨ï¼Œæ— éœ€è®¾ç½®ã€‚åªæœ‰åœ¨æŸ¥è¯¢ç»å¸¸å¤±è´¥æ—¶ï¼Œæ‰éœ€è¦æ·»åŠ ä½ è‡ªå·±çš„æœç´¢ API å¯†é’¥ã€‚',
  'About search providers': 'å…³äºŽæœç´¢æä¾›æ–¹',
  'Auto uses free public search with no account. Brave, Tavily and Serper need an API key from their website; each has a free tier.':
    'è‡ªåŠ¨æ¨¡å¼ä½¿ç”¨å…è´¹çš„å…¬å…±æœç´¢ï¼Œæ— éœ€è´¦æˆ·ã€‚Braveã€Tavily å’Œ Serper éœ€è¦åœ¨å…¶å®˜ç½‘ç”³è¯· API å¯†é’¥ï¼Œå‡æœ‰å…è´¹é¢åº¦ã€‚',
  'Search provider': 'æœç´¢æä¾›æ–¹',
  'Auto (free)': 'è‡ªåŠ¨ï¼ˆå…è´¹ï¼‰',
  'Search API key': 'æœç´¢ API å¯†é’¥',
  'Paste your key': 'ç²˜è´´ä½ çš„å¯†é’¥',
  'Clear': 'æ¸…é™¤',
  'Without a key, search falls back to the free providers.': 'æœªè®¾ç½®å¯†é’¥æ—¶ï¼Œæœç´¢ä¼šå›žé€€åˆ°å…è´¹æä¾›æ–¹ã€‚',
  'About experimental updates': 'å…³äºŽå®žéªŒæ€§æ›´æ–°',
  'Try new features early. These builds can be buggy, and not every experimental feature makes it into the stable version.':
    'æŠ¢å…ˆä½“éªŒæ–°åŠŸèƒ½ã€‚è¿™äº›ç‰ˆæœ¬å¯èƒ½æœ‰ bugï¼Œè€Œä¸”å¹¶éžæ¯ä¸ªå®žéªŒæ€§åŠŸèƒ½éƒ½ä¼šè¿›å…¥ç¨³å®šç‰ˆã€‚',
  "You'll get new features early, but they can be buggy. Continue?": 'ä½ ä¼šæŠ¢å…ˆç”¨åˆ°æ–°åŠŸèƒ½ï¼Œä½†å®ƒä»¬å¯èƒ½æœ‰ bugã€‚è¦ç»§ç»­å—ï¼Ÿ',
  'Terms of Service': 'æœåŠ¡æ¡æ¬¾',
  'Privacy Policy': 'éšç§æ”¿ç­–',
  'Open': 'æ‰“å¼€',
  'Report copyright infringement (DMCA)': 'ä¸¾æŠ¥ç‰ˆæƒä¾µæƒï¼ˆDMCAï¼‰',
  'Photo credits: Minecraft artwork by Mojang Studios. Movie night photo by':
    'å›¾ç‰‡æ¥æºï¼šMinecraft ç¾Žæœ¯ä½œå“æ¥è‡ª Mojang Studiosã€‚ç”µå½±ä¹‹å¤œç…§ç‰‡æ¥è‡ª',
  '(CC licensed).': 'ï¼ˆCC è®¸å¯ï¼‰ã€‚',
  'Speech recognition: SenseVoice-Small by FunAudioLLM (Alibaba),':
    'è¯­éŸ³è¯†åˆ«ï¼šSenseVoice-Smallï¼Œæ¥è‡ª FunAudioLLMï¼ˆé˜¿é‡Œå·´å·´ï¼‰ï¼Œ',
  'FunASR Model License': 'FunASR æ¨¡åž‹è®¸å¯è¯',
  '. English voice: trained on LibriTTS-R,': 'ã€‚è‹±æ–‡è¯­éŸ³ï¼šåŸºäºŽ LibriTTS-R è®­ç»ƒï¼Œ',
  ', via Piper; converted to ONNX. Chinese voice: trained on AISHELL-3 by Beijing Shell Shell Technology,':
    'ï¼Œç»ç”± Piperï¼›å·²è½¬æ¢ä¸º ONNXã€‚ä¸­æ–‡è¯­éŸ³ï¼šåŸºäºŽåŒ—äº¬å¸Œå°”è´å£³ç§‘æŠ€çš„ AISHELL-3 è®­ç»ƒï¼Œ',
  'Apache License 2.0': 'Apache 2.0 è®¸å¯è¯',
  ', via icefall.': 'ï¼Œç»ç”± icefallã€‚',
  // 261102 Kokoro credit (Settings > About).
  'Kokoro voice:': 'Kokoro è¯­éŸ³ï¼š',
  'by hexgrad,': 'ï¼Œä½œè€… hexgradï¼Œ',
  ', converted by sherpa-onnx. Its pronunciation data comes from espeak-ng,':
    'ï¼Œç”± sherpa-onnx è½¬æ¢ã€‚å…¶å‘éŸ³æ•°æ®æ¥è‡ª espeak-ngï¼Œ',
  '.': 'ã€‚',
  'Danger': 'å±é™©æ“ä½œ',
  'Reset all companion memories': 'é‡ç½®æ‰€æœ‰ä¼™ä¼´çš„è®°å¿†',
  'All memories reset': 'å·²é‡ç½®æ‰€æœ‰è®°å¿†',
  'Resetting {done} of {total}â€¦': 'æ­£åœ¨é‡ç½® {done}/{total}â€¦',
  'Reset all memoriesâ€¦': 'é‡ç½®æ‰€æœ‰è®°å¿†â€¦',
  'Wipes saved chat history and playtime for every companion on this device. Persona, portrait, and skin are kept.':
    'æ¸…é™¤æœ¬è®¾å¤‡ä¸Šæ¯ä¸ªä¼™ä¼´å·²ä¿å­˜çš„èŠå¤©è®°å½•å’Œæ¸¸çŽ©æ—¶é•¿ã€‚äººè®¾ã€å¤´åƒå’Œçš®è‚¤ä¼šä¿ç•™ã€‚',
  'Failed to reset some memories.': 'éƒ¨åˆ†è®°å¿†é‡ç½®å¤±è´¥ã€‚',
  'Delete account': 'åˆ é™¤è´¦æˆ·',
  'Delete accountâ€¦': 'åˆ é™¤è´¦æˆ·â€¦',
  'Permanently deletes your cloud data within 30 days. Local files stay.':
    'å°†åœ¨ 30 å¤©å†…æ°¸ä¹…åˆ é™¤ä½ çš„äº‘ç«¯æ•°æ®ã€‚æœ¬åœ°æ–‡ä»¶ä¿ç•™ã€‚',
  'Factory reset': 'æ¢å¤å‡ºåŽ‚è®¾ç½®',
  'Factory resetâ€¦': 'æ¢å¤å‡ºåŽ‚è®¾ç½®â€¦',
  'Erases everything on this device and restarts Sei like a fresh install. Cloud data stays on your account.':
    'æŠ¹é™¤æœ¬è®¾å¤‡ä¸Šçš„æ‰€æœ‰å†…å®¹ï¼Œå¹¶åƒå…¨æ–°å®‰è£…ä¸€æ ·é‡å¯ Seiã€‚äº‘ç«¯æ•°æ®ä»ä¿ç•™åœ¨ä½ çš„è´¦æˆ·ä¸­ã€‚',

  // â”€â”€ CreditsScreen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Unused weekly credits do not carry over. Extra credits never expire.':
    'æœªç”¨å®Œçš„æ¯å‘¨é¢åº¦ä¸ä¼šç»“è½¬ã€‚é¢å¤–é¢åº¦æ°¸ä¸è¿‡æœŸã€‚',
  'Sign in to manage billing.': 'è¯·ç™»å½•åŽç®¡ç†è´¦å•ã€‚',
  'No billing to manage yet. Subscribe or top up first.': 'è¿˜æ²¡æœ‰å¯ç®¡ç†çš„è´¦å•ã€‚è¯·å…ˆè®¢é˜…æˆ–å……å€¼ã€‚',
  'Could not open billing. Please try again.': 'æ— æ³•æ‰“å¼€è´¦å•é¡µé¢ï¼Œè¯·é‡è¯•ã€‚',
  'Sign in to change your plan.': 'è¯·ç™»å½•åŽæ›´æ”¹å¥—é¤ã€‚',
  'Too many requests. Wait a moment and try again.': 'è¯·æ±‚è¿‡äºŽé¢‘ç¹ï¼Œè¯·ç¨åŽå†è¯•ã€‚',
  'Could not change your plan. Please try again.': 'æ— æ³•æ›´æ”¹å¥—é¤ï¼Œè¯·é‡è¯•ã€‚',
  'Usage': 'ç”¨é‡',
  'Refresh': 'åˆ·æ–°',
  'Refresh plan usage': 'åˆ·æ–°å¥—é¤ç”¨é‡',
  '{name} plan': '{name} å¥—é¤',
  "Couldn't check your account. Refresh to try again.": 'æ— æ³•æŸ¥è¯¢ä½ çš„è´¦æˆ·ã€‚è¯·åˆ·æ–°é‡è¯•ã€‚',
  'Resets in {time}': '{time}åŽé‡ç½®',
  // 260926: under the free-play reset line when the allowance is spent.
  'To keep playing before then, top up or pick a plan below.':
    'æƒ³åœ¨é‚£ä¹‹å‰ç»§ç»­çŽ©ï¼Œå¯ä»¥å……å€¼æˆ–åœ¨ä¸‹æ–¹é€‰æ‹©å¥—é¤ã€‚',
  'Extra credits': 'é¢å¤–é¢åº¦',
  '{used}/{total} credits used': 'å·²ä½¿ç”¨ {used}/{total} é¢åº¦',
  'Top up': 'å……å€¼',
  'Plan': 'å¥—é¤',
  // 'Resume' lives in games.ts ('æ¢å¤'): shared with the Draw! pause overlay.
  'Current plan': 'å½“å‰å¥—é¤',
  'Openingâ€¦': 'æ­£åœ¨æ‰“å¼€â€¦',
  'Downgrade': 'é™çº§',
  'Upgrade': 'å‡çº§',
  // 261023: the plan card buttons ({name} is the plan name, e.g. Party).
  'Get {name}': 'å¼€é€š {name}',
  'Upgrade to {name}': 'å‡çº§åˆ° {name}',
  'Resume {name}': 'æ¢å¤ {name}',
  'Recommended': 'æŽ¨è',
  'Your {name} plan will not renew. It ends {date}.': 'ä½ çš„ {name} å¥—é¤å°†ä¸å†ç»­è´¹ï¼ŒäºŽ {date} ç»“æŸã€‚',
  'Your {name} plan will not renew.': 'ä½ çš„ {name} å¥—é¤å°†ä¸å†ç»­è´¹ã€‚',
  'Your {name} plan renews on {date}.': 'ä½ çš„ {name} å¥—é¤å°†äºŽ {date} ç»­è´¹ã€‚',
  'Your last payment did not go through. Update your card in Manage billing.':
    'ä½ ä¸Šæ¬¡çš„ä»˜æ¬¾æœªæˆåŠŸã€‚è¯·åœ¨ã€Œç®¡ç†è´¦å•ã€ä¸­æ›´æ–°ä½ çš„é“¶è¡Œå¡ã€‚',
  'Manage billing': 'ç®¡ç†è´¦å•',
  'Submit feedback': 'æäº¤åé¦ˆ',
  'Confirm your plan change': 'ç¡®è®¤æ›´æ”¹å¥—é¤',
  'Confirm plan change': 'ç¡®è®¤å¥—é¤æ›´æ”¹',
  '{name} is {amount} per month, billed through Polar. It renews automatically until you cancel.':
    '{name} ä¸ºæ¯æœˆ {amount}ï¼Œé€šè¿‡ Polar è®¡è´¹ã€‚å°†è‡ªåŠ¨ç»­è´¹ï¼Œç›´åˆ°ä½ å–æ¶ˆä¸ºæ­¢ã€‚',
  'The change takes effect right away. Your card on file is charged now, prorated for the time left in your current billing period. After that you pay {amount} each month.':
    'æ›´æ”¹ç«‹å³ç”Ÿæ•ˆã€‚å°†ç«‹åˆ»ä»Žä½ å·²ç»‘å®šçš„é“¶è¡Œå¡æ‰£æ¬¾ï¼ŒæŒ‰å½“å‰è®¡è´¹å‘¨æœŸå‰©ä½™æ—¶é—´æŒ‰æ¯”ä¾‹è®¡ç®—ã€‚ä¹‹åŽæ¯æœˆæ”¯ä»˜ {amount}ã€‚',
  'The change takes effect right away. Polar prorates the difference against your card on file for the time left in your current billing period. After that you pay {amount} each month.':
    'æ›´æ”¹ç«‹å³ç”Ÿæ•ˆã€‚Polar ä¼šæŒ‰å½“å‰è®¡è´¹å‘¨æœŸå‰©ä½™æ—¶é—´ï¼ŒæŠŠå·®é¢æŒ‰æ¯”ä¾‹ç»“ç®—åˆ°ä½ å·²ç»‘å®šçš„é“¶è¡Œå¡ã€‚ä¹‹åŽæ¯æœˆæ”¯ä»˜ {amount}ã€‚',
  'You can cancel anytime from Manage billing.': 'ä½ å¯ä»¥éšæ—¶åœ¨ã€Œç®¡ç†è´¦å•ã€ä¸­å–æ¶ˆã€‚',
  'extra credits': 'é¢å¤–é¢åº¦',
  'your plan': 'ä½ çš„å¥—é¤',
  'Resume your subscription': 'æ¢å¤ä½ çš„è®¢é˜…',
  'Updating your plan': 'æ­£åœ¨æ›´æ–°ä½ çš„å¥—é¤',
  'Complete your purchase': 'å®Œæˆè´­ä¹°',
  'Subscription resumed': 'è®¢é˜…å·²æ¢å¤',
  'Plan updated': 'å¥—é¤å·²æ›´æ–°',
  'Purchase complete': 'è´­ä¹°å®Œæˆ',
  'Still processing': 'ä»åœ¨å¤„ç†ä¸­',
  'Resume subscription status': 'æ¢å¤è®¢é˜…çŠ¶æ€',
  'Checkout status': 'ç»“è´¦çŠ¶æ€',
  "Resume your {product} subscription in your browser. This screen updates automatically once it's confirmed.":
    'è¯·åœ¨æµè§ˆå™¨ä¸­æ¢å¤ä½ çš„ {product} è®¢é˜…ã€‚ç¡®è®¤åŽæ­¤é¡µé¢ä¼šè‡ªåŠ¨æ›´æ–°ã€‚',
  "Applying your {product} plan. This screen updates automatically once it's confirmed.":
    'æ­£åœ¨åº”ç”¨ä½ çš„ {product} å¥—é¤ã€‚ç¡®è®¤åŽæ­¤é¡µé¢ä¼šè‡ªåŠ¨æ›´æ–°ã€‚',
  'Finish checking out for {product} in your browser. This screen updates automatically once the payment is confirmed.':
    'è¯·åœ¨æµè§ˆå™¨ä¸­å®Œæˆ {product} çš„ç»“è´¦ã€‚ä»˜æ¬¾ç¡®è®¤åŽæ­¤é¡µé¢ä¼šè‡ªåŠ¨æ›´æ–°ã€‚',
  'Your {product} subscription will continue, with no end date.':
    'ä½ çš„ {product} è®¢é˜…å°†ç»§ç»­ï¼Œæ²¡æœ‰ç»“æŸæ—¥æœŸã€‚',
  'Your extra credits are now available.': 'ä½ çš„é¢å¤–é¢åº¦çŽ°åœ¨å¯ç”¨äº†ã€‚',
  'Your {product} plan is active.': 'ä½ çš„ {product} å¥—é¤å·²ç”Ÿæ•ˆã€‚',
  'This is taking longer than usual. You can close this; it will update here automatically once it completes.':
    'å¤„ç†æ—¶é—´æ¯”å¹³å¸¸é•¿ã€‚ä½ å¯ä»¥å…³é—­æ­¤çª—å£ï¼Œå®ŒæˆåŽè¿™é‡Œä¼šè‡ªåŠ¨æ›´æ–°ã€‚',

  // â”€â”€ ReceiptScreen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Welcome to {name}!': 'æ¬¢è¿Žä½¿ç”¨ {name}ï¼',
  '{amount} charged today.': 'ä»Šæ—¥å·²æ‰£æ¬¾ {amount}ã€‚',
  'Billed monthly until you cancel.': 'æŒ‰æœˆè®¡è´¹ï¼Œç›´åˆ°ä½ å–æ¶ˆä¸ºæ­¢ã€‚',
  'Next billing date: {date}.': 'ä¸‹æ¬¡æ‰£æ¬¾æ—¥æœŸï¼š{date}ã€‚',
  'in 30 days': '30 å¤©åŽ',
  'Cancel anytime in Playtime â†’ Sei â†’ Manage billing.':
    'å¯éšæ—¶åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ â†’ Sei â†’ ç®¡ç†è´¦å•ã€ä¸­å–æ¶ˆã€‚',
  'Back to Sei': 'è¿”å›ž Sei',

  // â”€â”€ SkinSetupScreen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Set up voice calls too': 'åŒæ—¶è®¾ç½®è¯­éŸ³é€šè¯',
  'Voice module installed. You can call your companion anytime.':
    'è¯­éŸ³æ¨¡å—å·²å®‰è£…ã€‚ä½ å¯ä»¥éšæ—¶ç»™ä½ çš„ä¼™ä¼´æ‰“ç”µè¯ã€‚',
  'Downloading the voice moduleâ€¦ {pct}%': 'æ­£åœ¨ä¸‹è½½è¯­éŸ³æ¨¡å—â€¦ {pct}%',
  'Download failed. You can retry from your first call.': 'ä¸‹è½½å¤±è´¥ã€‚ä½ å¯ä»¥åœ¨ç¬¬ä¸€æ¬¡é€šè¯æ—¶é‡è¯•ã€‚',
  'Downloads the voice-recognition module (~40 MB) in the background.':
    'åœ¨åŽå°ä¸‹è½½è¯­éŸ³è¯†åˆ«æ¨¡å—ï¼ˆçº¦ 40 MBï¼‰ã€‚',

  // â”€â”€ OnboardingScreen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'What should they call you?': 'ä»–ä»¬è¯¥æ€Žä¹ˆç§°å‘¼ä½ ï¼Ÿ',
  'Finish': 'å®Œæˆ',
  'Which model provider?': 'é€‰æ‹©å“ªä¸ªæ¨¡åž‹æä¾›å•†ï¼Ÿ',
  'Paste your {provider} API key.': 'ç²˜è´´ä½ çš„ {provider} API å¯†é’¥ã€‚',

  // â”€â”€ Companion preference questions (Sui's scenes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The option labels shared by suiQuestions' pickers. Their old home,
  // ProfileQuestionsScreen, was deleted 260802 along with its headings
  // and per-option descriptions.
  'Art style': 'ç”»é£Ž',
  'Surprise me': 'ç»™æˆ‘æƒŠå–œ',
  'Later': 'ä»¥åŽå†è¯´',
  'Savingâ€¦': 'ä¿å­˜ä¸­â€¦',
  '1st': 'ç¬¬1',
  '2nd': 'ç¬¬2',
  '3rd': 'ç¬¬3',
  '4th': 'ç¬¬4',
  '5th': 'ç¬¬5',
  'Young adult': 'é’å¹´',
  'Adult': 'æˆå¹´',
  'Mature': 'æˆç†Ÿ',
  'Elder': 'å¹´é•¿',
  'Timeless': 'æ— é¾„',
  'A partner in crime': 'ä¸€èµ·é—¯ç¥¸çš„æ­æ¡£',
  'Someone to look after': 'éœ€è¦ä½ ç…§é¡¾çš„äºº',
  'Round chibi': 'åœ†æ¶¦ Q ç‰ˆ',
  'Anime': 'åŠ¨æ¼«',
  'Cel-shaded': 'èµ›ç’ç’',
  'Cartoon': 'å¡é€š',
  '3D': '3D',

  // â”€â”€ UniqueGenderScreen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Who are you hoping to meet?': 'ä½ å¸Œæœ›é‡è§è°ï¼Ÿ',
  'Everything else about them is a surprise, cast from your profile.':
    'å…³äºŽä»–ä»¬çš„å…¶ä»–ä¸€åˆ‡éƒ½æ˜¯æƒŠå–œï¼Œç”±ä½ çš„åå¥½å¬å”¤è€Œæ¥ã€‚',
  'Companion gender': 'ä¼™ä¼´æ€§åˆ«',
  'Begin': 'å¼€å§‹',
  'Masculine': 'ç”·æ€§',
  'Cast a companion who presents masculine.': 'å¬å”¤ä¸€ä½æ°”è´¨åç”·æ€§çš„ä¼™ä¼´ã€‚',
  'Feminine': 'å¥³æ€§',
  'Cast a companion who presents feminine.': 'å¬å”¤ä¸€ä½æ°”è´¨åå¥³æ€§çš„ä¼™ä¼´ã€‚',
  'Other': 'å…¶ä»–',
  'Let the cast decide, or beyond the binary.': 'äº¤ç»™å¬å”¤å†³å®šï¼Œæˆ–è¶…è¶ŠäºŒå…ƒæ€§åˆ«ã€‚',

  // â”€â”€ UniqueCastingScreen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Finding someone for youâ€¦': 'æ­£åœ¨ä¸ºä½ å¯»æ‰¾åˆé€‚çš„äººâ€¦â€¦',
  'Seeing their faceâ€¦': 'æ­£åœ¨çœ‹æ¸… TA çš„æ ·å­â€¦â€¦',
  "Sorting out what they'll wearâ€¦": 'æ­£åœ¨å‡†å¤‡ TA çš„è£…æ‰®â€¦â€¦',
  'Hearing their storyâ€¦': 'æ­£åœ¨å¬ TA è®²è‡ªå·±çš„æ•…äº‹â€¦â€¦',
  'Bringing them overâ€¦': 'æ­£åœ¨æŠŠ TA å¸¦è¿‡æ¥â€¦â€¦',
  'Sign in to continue': 'è¯·ç™»å½•åŽç»§ç»­',
  'Meeting a unique companion needs a Sei account. Sign in and try again.':
    'é‡è§ç‹¬ç‰¹ä¼™ä¼´éœ€è¦ Sei è´¦æˆ·ã€‚è¯·ç™»å½•åŽé‡è¯•ã€‚',
  'Your slots are full': 'ä½ çš„æ ä½å·²æ»¡',
  'Free up one of your companion slots, then cast again.': 'è…¾å‡ºä¸€ä¸ªä¼™ä¼´æ ä½ï¼Œç„¶åŽå†æ¬¡å¬å”¤ã€‚',
  'Thatâ€™s enough casting for today': 'ä»Šå¤©çš„å¬å”¤å·²ç»å¤Ÿå¤šäº†',
  'Youâ€™ve reached todayâ€™s limit. Come back tomorrow to meet someone new.':
    'ä½ å·²è¾¾åˆ°ä»Šæ—¥ä¸Šé™ã€‚æ˜Žå¤©å†æ¥è®¤è¯†æ–°ä¼™ä¼´å§ã€‚',
  'The cast didnâ€™t take': 'è¿™æ¬¡å¬å”¤æ²¡æœ‰æˆåŠŸ',
  'Something went wrong weaving your companion. Letâ€™s try once more.':
    'ç¼–ç»‡ä½ çš„ä¼™ä¼´æ—¶å‡ºäº†é—®é¢˜ã€‚æˆ‘ä»¬å†è¯•ä¸€æ¬¡å§ã€‚',
  'Couldnâ€™t reach the aether': 'æ— æ³•è¿žæŽ¥åˆ°ä»¥å¤ª',
  'Check your connection and try the ritual again.': 'è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥ï¼Œç„¶åŽå†æ¬¡å°è¯•ä»ªå¼ã€‚',
  'Try again': 'å†è¯•ä¸€æ¬¡',
  'Casting your companion, {pct} percent': 'æ­£åœ¨å¬å”¤ä½ çš„ä¼™ä¼´ï¼Œ{pct}%',
  'Image generation failed. Continuing without a portrait.': 'å›¾åƒç”Ÿæˆå¤±è´¥ã€‚å°†ç»§ç»­ï¼Œä½†æ²¡æœ‰å¤´åƒã€‚',
  'Skin generation failed. Continuing with the default skin.':
    'çš®è‚¤ç”Ÿæˆå¤±è´¥ã€‚å°†ç»§ç»­ä½¿ç”¨é»˜è®¤çš®è‚¤ã€‚',

  // â”€â”€ UniqueRevealScreen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'Your companion is ready': 'ä½ çš„ä¼™ä¼´å·²å°±ç»ª',
  'Theyâ€™re waiting in your party.': 'ä»–ä»¬æ­£åœ¨ä½ çš„é˜Ÿä¼ä¸­ç­‰ä½ ã€‚',
  'Go home': 'å›žåˆ°ä¸»é¡µ',
  'Say hello': 'æ‰“ä¸ªæ‹›å‘¼',

  // â”€â”€ 261017 (issue #46): ChatGPT plan (the "Continue with ChatGPT" button
  //    label itself is translated since 261104, in gaps261104.ts) â”€â”€â”€â”€â”€â”€â”€â”€
  'ChatGPT plan': 'ChatGPT å¥—é¤',
  'Use your ChatGPT plan': 'ä½¿ç”¨ä½ çš„ ChatGPT å¥—é¤',
  'Use ChatGPT plan': 'ä½¿ç”¨ ChatGPT å¥—é¤',
  'Using ChatGPT plan': 'æ­£åœ¨ä½¿ç”¨ ChatGPT å¥—é¤',
  'Manage usage': 'ç®¡ç†ç”¨é‡',
  'Learn more': 'äº†è§£æ›´å¤š',
  'Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.':
    'åœ¨æ­¤åº”ç”¨ä¸­å®Œæˆç¬¦åˆæ¡ä»¶çš„ AI è¯·æ±‚ï¼Œç”¨é‡è®¡å…¥ä½ çš„ ChatGPT å¥—é¤æˆ–é¢åº¦ä½™é¢ã€‚',
  "Works with your ChatGPT Plus or Pro account. Usage counts toward your ChatGPT plan, not Sei's subscription or credits.":
    'é€‚ç”¨äºŽä½ çš„ ChatGPT Plus æˆ– Pro è´¦æˆ·ã€‚ç”¨é‡è®¡å…¥ä½ çš„ ChatGPT å¥—é¤ï¼Œä¸å ç”¨ Sei çš„è®¢é˜…æˆ–é¢åº¦ã€‚',
  'Use your ChatGPT plan?': 'ä½¿ç”¨ä½ çš„ ChatGPT å¥—é¤ï¼Ÿ',
  "Sei will stop using managed cloud credits and run your companions on your ChatGPT plan instead. ChatGPT plan usage is OpenAI's, separate from Sei's own subscription and credits. This applies to a running bot right away. Your Sei subscription, if you have one, keeps renewing until you cancel it.":
    'Sei å°†åœæ­¢ä½¿ç”¨äº‘ç«¯æ‰˜ç®¡é¢åº¦ï¼Œæ”¹ç”¨ä½ çš„ ChatGPT å¥—é¤è¿è¡Œä¼™ä¼´ã€‚ChatGPT å¥—é¤ç”¨é‡ç”± OpenAI æä¾›ï¼Œä¸Ž Sei è‡ªå·±çš„è®¢é˜…å’Œé¢åº¦åˆ†å¼€ã€‚æ­¤æ›´æ”¹ä¼šç«‹å³åº”ç”¨åˆ°æ­£åœ¨è¿è¡Œçš„æœºå™¨äººã€‚å¦‚æžœä½ æœ‰ Sei è®¢é˜…ï¼Œå®ƒä¼šç»§ç»­ç»­è®¢ï¼Œç›´åˆ°ä½ å–æ¶ˆã€‚',
  'ChatGPT account': 'ChatGPT è´¦æˆ·',
  'About the ChatGPT plan': 'å…³äºŽ ChatGPT å¥—é¤',
  'Works with your ChatGPT Plus or Pro account.': 'é€‚ç”¨äºŽä½ çš„ ChatGPT Plus æˆ– Pro è´¦æˆ·ã€‚',
  'ChatGPT accounts': 'ChatGPT è´¦æˆ·åˆ—è¡¨',
  'Add account': 'æ·»åŠ è´¦æˆ·',
  'Switch': 'åˆ‡æ¢',
  'active': 'å½“å‰',
  'Signed in as {name}.': 'å·²ç™»å½•ä¸º {name}ã€‚',
  'Finish signing in with ChatGPT in your browser.': 'è¯·åœ¨æµè§ˆå™¨ä¸­å®Œæˆ ChatGPT ç™»å½•ã€‚',
  'Sign in with your ChatGPT account to use your plan in Sei. No API key needed.':
    'ç™»å½•ä½ çš„ ChatGPT è´¦æˆ·ï¼Œå³å¯åœ¨ Sei ä¸­ä½¿ç”¨ä½ çš„å¥—é¤ã€‚æ— éœ€ API å¯†é’¥ã€‚',
  'Your ChatGPT sign-in ended. Continue with ChatGPT to sign in again.':
    'ä½ çš„ ChatGPT ç™»å½•å·²å¤±æ•ˆã€‚ç‚¹å‡»ã€Œé€šè¿‡ ChatGPT ç»§ç»­ã€é‡æ–°ç™»å½•ã€‚',
  'ChatGPT plan use was not turned on when you signed in, so Sei cannot use your plan yet.':
    'ç™»å½•æ—¶æ²¡æœ‰å¼€å¯ ChatGPT å¥—é¤ä½¿ç”¨æƒé™ï¼Œæ‰€ä»¥ Sei æš‚æ—¶æ— æ³•ä½¿ç”¨ä½ çš„å¥—é¤ã€‚',
  'Turn on ChatGPT plan': 'å¼€å¯ ChatGPT å¥—é¤',
  'Usage limit reached. Requests are paused.': 'å·²è¾¾åˆ°ç”¨é‡ä¸Šé™ï¼Œè¯·æ±‚å·²æš‚åœã€‚',
  "This ChatGPT account can't use its plan in Sei right now. Plan use needs ChatGPT Plus or Pro. Try another account, or pick another provider.":
    'è¿™ä¸ª ChatGPT è´¦æˆ·ç›®å‰æ— æ³•åœ¨ Sei ä¸­ä½¿ç”¨å…¶å¥—é¤ã€‚å¥—é¤ç”¨é‡éœ€è¦ ChatGPT Plus æˆ– Proã€‚è¯·æ¢ä¸€ä¸ªè´¦æˆ·ï¼Œæˆ–é€‰æ‹©å…¶ä»–æœåŠ¡å•†ã€‚',
  'Signed out on this device, but Sei could not confirm the sign-out with ChatGPT. To be sure, disconnect Sei in your ChatGPT settings.':
    'å·²åœ¨æ­¤è®¾å¤‡ä¸Šé€€å‡ºç™»å½•ï¼Œä½† Sei æ— æ³•å‘ ChatGPT ç¡®è®¤é€€å‡ºã€‚ä¸ºç¡®ä¿å®‰å…¨ï¼Œè¯·åœ¨ ChatGPT è®¾ç½®ä¸­æ–­å¼€ Sei çš„è¿žæŽ¥ã€‚',
  'Sign-in was cancelled in ChatGPT.': 'å·²åœ¨ ChatGPT ä¸­å–æ¶ˆç™»å½•ã€‚',
  'Sign-in timed out. Try again.': 'ç™»å½•è¶…æ—¶ï¼Œè¯·é‡è¯•ã€‚',
  'That is a different ChatGPT account. Sign in with the same account, or add it as a new account.':
    'è¿™æ˜¯å¦ä¸€ä¸ª ChatGPT è´¦æˆ·ã€‚è¯·ç”¨åŒä¸€ä¸ªè´¦æˆ·ç™»å½•ï¼Œæˆ–å°†å®ƒæ·»åŠ ä¸ºæ–°è´¦æˆ·ã€‚',
  'Could not reach ChatGPT. Check your connection and try again.': 'æ— æ³•è¿žæŽ¥ ChatGPTã€‚è¯·æ£€æŸ¥ç½‘ç»œåŽé‡è¯•ã€‚',
  'Sei could not save your sign-in securely on this device.': 'Sei æ— æ³•åœ¨æ­¤è®¾å¤‡ä¸Šå®‰å…¨ä¿å­˜ä½ çš„ç™»å½•ä¿¡æ¯ã€‚',
  'Could not open your browser. Try again.': 'æ— æ³•æ‰“å¼€æµè§ˆå™¨ï¼Œè¯·é‡è¯•ã€‚',
  'Sei could not start its sign-in listener. Try again.': 'Sei æ— æ³•å¯åŠ¨ç™»å½•ç›‘å¬ï¼Œè¯·é‡è¯•ã€‚',
  'Sign-in did not finish. Try again.': 'ç™»å½•æœªå®Œæˆï¼Œè¯·é‡è¯•ã€‚',
  'Sign in with ChatGPT first.': 'è¯·å…ˆç™»å½• ChatGPTã€‚',
  'Turn on ChatGPT plan use first.': 'è¯·å…ˆå¼€å¯ ChatGPT å¥—é¤ä½¿ç”¨æƒé™ã€‚',
  "You've reached your ChatGPT plan's usage limit.": 'ä½ å·²è¾¾åˆ° ChatGPT å¥—é¤çš„ç”¨é‡ä¸Šé™ã€‚',
  "This ChatGPT account can't use its plan in Sei.": 'è¿™ä¸ª ChatGPT è´¦æˆ·æ— æ³•åœ¨ Sei ä¸­ä½¿ç”¨å…¶å¥—é¤ã€‚',
  'ChatGPT plan usage limit reached': 'å·²è¾¾åˆ° ChatGPT å¥—é¤ç”¨é‡ä¸Šé™',
  "You're using your ChatGPT plan": 'ä½ æ­£åœ¨ä½¿ç”¨ ChatGPT å¥—é¤',
  'Your companions now run on your ChatGPT plan. Eligible requests count toward your plan usage or credits balance, not Sei credits.':
    'ä½ çš„ä¼™ä¼´çŽ°åœ¨ä½¿ç”¨ä½ çš„ ChatGPT å¥—é¤è¿è¡Œã€‚ç¬¦åˆæ¡ä»¶çš„è¯·æ±‚è®¡å…¥ä½ çš„å¥—é¤ç”¨é‡æˆ–é¢åº¦ä½™é¢ï¼Œä¸æ¶ˆè€— Sei é¢åº¦ã€‚',
  "You've used the ChatGPT plan usage available to Sei for now. Check Manage usage to see when it resets. Sei pauses ChatGPT requests until then.":
    'ä½ ç›®å‰å¯ä¾› Sei ä½¿ç”¨çš„ ChatGPT å¥—é¤ç”¨é‡å·²ç”¨å®Œã€‚æŸ¥çœ‹ã€Œç®¡ç†ç”¨é‡ã€äº†è§£ä½•æ—¶é‡ç½®ã€‚åœ¨æ­¤ä¹‹å‰ï¼ŒSei ä¼šæš‚åœ ChatGPT è¯·æ±‚ã€‚',
  'Sign in to ChatGPT again': 'é‡æ–°ç™»å½• ChatGPT',
  "ChatGPT didn't accept Sei's sign-in, even after renewing it. Sign in again to keep using your ChatGPT plan, or pick another AI option in Playtime.":
    'ChatGPT ä¸æŽ¥å— Sei çš„ç™»å½•ï¼Œå³ä½¿å·²ç»ç»­æœŸä¹Ÿä¸€æ ·ã€‚è¯·é‡æ–°ç™»å½•ä»¥ç»§ç»­ä½¿ç”¨ä½ çš„ ChatGPT å¥—é¤ï¼Œæˆ–åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­é€‰æ‹©å…¶ä»– AI é€‰é¡¹ã€‚',
  'ChatGPT rejected the request': 'ChatGPT æ‹’ç»äº†è¯·æ±‚',
  "ChatGPT didn't accept Sei's sign-in, even after renewing it. Sign in again to keep using your plan.":
    'ChatGPT ä¸æŽ¥å— Sei çš„ç™»å½•ï¼Œå³ä½¿å·²ç»ç»­æœŸä¹Ÿä¸€æ ·ã€‚è¯·é‡æ–°ç™»å½•ä»¥ç»§ç»­ä½¿ç”¨ä½ çš„å¥—é¤ã€‚',
  "ChatGPT didn't accept Sei's last request, so ChatGPT requests are paused.":
    'ChatGPT ä¸æŽ¥å— Sei çš„ä¸Šä¸€ä¸ªè¯·æ±‚ï¼Œæ‰€ä»¥ ChatGPT è¯·æ±‚å·²æš‚åœã€‚',
  "ChatGPT plan use isn't available here right now. It may be limited in your region or by your plan.":
    'ç›®å‰æ— æ³•åœ¨è¿™é‡Œä½¿ç”¨ ChatGPT å¥—é¤ï¼Œå¯èƒ½å—ä½ æ‰€åœ¨åœ°åŒºæˆ–å¥—é¤çš„é™åˆ¶ã€‚',
  "ChatGPT didn't accept the request Sei sent, so your companion stopped instead of retrying. Try again, or pick another AI option in Playtime.":
    'ChatGPT ä¸æŽ¥å— Sei å‘é€çš„è¯·æ±‚ï¼Œæ‰€ä»¥ä½ çš„ä¼™ä¼´åœäº†ä¸‹æ¥ï¼Œæ²¡æœ‰åå¤é‡è¯•ã€‚è¯·é‡è¯•ï¼Œæˆ–åœ¨ã€Œæ¸¸çŽ©æ—¶é•¿ã€ä¸­é€‰æ‹©å…¶ä»– AI é€‰é¡¹ã€‚',
};




