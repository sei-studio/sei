/** Setup fixes (261104): Stardew folder picker, SMAPI errors, Minecraft without Java. */
export const ZH_SETUP_261104: Record<string, string> = {
  "Installed somewhere else? Choose the game folder.": "è£…åœ¨åˆ«çš„ä½ç½®ï¼Ÿè¯·é€‰æ‹©æ¸¸æˆæ–‡ä»¶å¤¹ã€‚",
  "Choose folder": "é€‰æ‹©æ–‡ä»¶å¤¹",
  "That folder doesn't have Stardew Valley in it. Pick the folder with Stardew Valley.dll in it.": "è¿™ä¸ªæ–‡ä»¶å¤¹é‡Œæ²¡æœ‰æ˜Ÿéœ²è°·ç‰©è¯­ã€‚è¯·é€‰æ‹©åŒ…å« Stardew Valley.dll çš„æ–‡ä»¶å¤¹ã€‚",
  "This Stardew Valley is too old for Sei. Update the game to {min} or newer, then check again.": "è¿™ä¸ªç‰ˆæœ¬çš„æ˜Ÿéœ²è°·ç‰©è¯­å¤ªæ—§ï¼ŒSei æ— æ³•ä½¿ç”¨ã€‚è¯·æŠŠæ¸¸æˆæ›´æ–°åˆ° {min} æˆ–æ›´æ–°ç‰ˆæœ¬ï¼Œç„¶åŽé‡æ–°æ£€æŸ¥ã€‚",
  "Stardew Valley is running, but Sei's helper isn't answering. The game has to start through SMAPI: close it, then press Launch Stardew Valley (with Sei).": "æ˜Ÿéœ²è°·ç‰©è¯­æ­£åœ¨è¿è¡Œï¼Œä½† Sei çš„è¾…åŠ©æ¨¡ç»„æ²¡æœ‰å“åº”ã€‚æ¸¸æˆéœ€è¦é€šè¿‡ SMAPI å¯åŠ¨ï¼šè¯·å…³é—­æ¸¸æˆï¼Œç„¶åŽç‚¹å‡»ã€Œå¯åŠ¨æ˜Ÿéœ²è°·ç‰©è¯­ï¼ˆå¸¦ Seiï¼‰ã€ã€‚",
  "Couldn't download SMAPI, the mod loader Stardew Valley needs. Check your internet connection, then try the setup again.": "æ— æ³•ä¸‹è½½ SMAPIï¼ˆæ˜Ÿéœ²è°·ç‰©è¯­éœ€è¦çš„æ¨¡ç»„åŠ è½½å™¨ï¼‰ã€‚è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥ï¼Œç„¶åŽé‡æ–°è¿è¡Œè®¾ç½®ã€‚",
  "SMAPI wasn't allowed to change the Stardew Valley folder. Close the game and Steam, then try the setup again. If it keeps failing, install SMAPI from smapi.io and re-run the setup.": "SMAPI æ²¡æœ‰æƒé™ä¿®æ”¹æ˜Ÿéœ²è°·ç‰©è¯­çš„æ–‡ä»¶å¤¹ã€‚è¯·å…³é—­æ¸¸æˆå’Œ Steamï¼Œç„¶åŽé‡æ–°è¿è¡Œè®¾ç½®ã€‚å¦‚æžœä¸€ç›´å¤±è´¥ï¼Œè¯·ä»Ž smapi.io å®‰è£… SMAPIï¼Œå†é‡æ–°è¿è¡Œè®¾ç½®ã€‚",
  "Stardew Valley is running, so SMAPI can't be installed. Close the game, then try the setup again.": "æ˜Ÿéœ²è°·ç‰©è¯­æ­£åœ¨è¿è¡Œï¼Œæ— æ³•å®‰è£… SMAPIã€‚è¯·å…³é—­æ¸¸æˆï¼Œç„¶åŽé‡æ–°è¿è¡Œè®¾ç½®ã€‚",
  "SMAPI was installed, but your antivirus most likely removed it. Allow StardewModdingAPI.exe in your antivirus, then run the setup again. In Windows Security: Virus & threat protection, Protection history, pick the item, then Allow on device.": "SMAPI å·²å®‰è£…ï¼Œä½†å¾ˆå¯èƒ½è¢«ä½ çš„æ€æ¯’è½¯ä»¶åˆ é™¤äº†ã€‚è¯·åœ¨æ€æ¯’è½¯ä»¶ä¸­å…è®¸ StardewModdingAPI.exeï¼Œç„¶åŽé‡æ–°è¿è¡Œè®¾ç½®ã€‚åœ¨ Windows å®‰å…¨ä¸­å¿ƒï¼šç—…æ¯’å’Œå¨èƒé˜²æŠ¤ï¼Œä¿æŠ¤åŽ†å²è®°å½•ï¼Œé€‰æ‹©è¯¥é¡¹ç›®ï¼Œç„¶åŽç‚¹å‡»ã€Œåœ¨è®¾å¤‡ä¸Šå…è®¸ã€ã€‚",
  "Minecraft Java found in {launcher}. Sei can't add its setup there, but your companion can still join: open a world there on a version up to {latest} and choose Open to LAN.": "åœ¨ {launcher} ä¸­æ‰¾åˆ°äº† Minecraft Java ç‰ˆã€‚Sei æ— æ³•åœ¨é‚£é‡Œå®Œæˆè®¾ç½®ï¼Œä½†ä½ çš„ä¼™ä¼´ä»ç„¶å¯ä»¥åŠ å…¥ï¼šåœ¨é‚£é‡Œæ‰“å¼€ä¸€ä¸ª {latest} åŠä»¥ä¸‹ç‰ˆæœ¬çš„ä¸–ç•Œï¼Œç„¶åŽé€‰æ‹©ã€Œå¯¹å±€åŸŸç½‘å¼€æ”¾ã€ã€‚",
  "To see companion skins in your game, use the official Minecraft Launcher, where Sei can set everything up.": "æƒ³åœ¨æ¸¸æˆé‡Œçœ‹åˆ°ä¼™ä¼´çš„çš®è‚¤ï¼Œè¯·ä½¿ç”¨å®˜æ–¹ Minecraft å¯åŠ¨å™¨ï¼ŒSei å¯ä»¥åœ¨é‚£é‡Œå¸®ä½ è®¾ç½®å¥½ä¸€åˆ‡ã€‚",
  "Sei needs Minecraft Java Edition, and this computer only has Bedrock Edition. If you own Minecraft for Windows, you most likely own Java Edition too: since 2022 the two come together.": "Sei éœ€è¦ Minecraft Java ç‰ˆï¼Œè€Œè¿™å°ç”µè„‘ä¸Šåªæœ‰åŸºå²©ç‰ˆã€‚å¦‚æžœä½ æ‹¥æœ‰ Minecraft for Windowsï¼Œä½ å¾ˆå¯èƒ½ä¹Ÿæ‹¥æœ‰ Java ç‰ˆï¼šè‡ª 2022 å¹´èµ·ä¸¤è€…æ˜¯ä¸€èµ·æä¾›çš„ã€‚",
  "The Minecraft Launcher is installed, but Java Edition hasn't been played on this computer yet.": "Minecraft å¯åŠ¨å™¨å·²å®‰è£…ï¼Œä½†è¿™å°ç”µè„‘ä¸Šè¿˜æ²¡æœ‰çŽ©è¿‡ Java ç‰ˆã€‚",
  "Open the Minecraft Launcher, choose Minecraft: Java Edition, and press Play once. Then check again.": "æ‰“å¼€ Minecraft å¯åŠ¨å™¨ï¼Œé€‰æ‹© Minecraft: Java Editionï¼Œç‚¹å‡»ä¸€æ¬¡ã€Œå¼€å§‹æ¸¸æˆã€ã€‚ç„¶åŽé‡æ–°æ£€æŸ¥ã€‚",
  "Open Minecraft Launcher": "æ‰“å¼€ Minecraft å¯åŠ¨å™¨",
};




