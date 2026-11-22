/**
 * Onboarding + tutorial dictionary (OnboardApp.tsx, TutorialOverlay.tsx).
 * Keys are the exact English strings passed to t()/useT(); {name}-style
 * placeholders survive verbatim. Sui's lines are voiced (playful, warm),
 * not literal. No em dashes in any value; Chinese punctuation throughout.
 */
export const ZH_ONBOARD: Record<string, string> = {
  /* â”€â”€ Sui's script â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     Register (260730): natural spoken Chinese, playful and a little cutesy,
     the way Sui actually talks. No tech vocabulary a non-technical player
     would never say: "ç»ˆç«¯" is out, the thing she runs is just "ç³»ç»Ÿ". */
  "Hey. I'm Sui!": 'å—¨å—¨ï¼æˆ‘æ˜¯ Suiï¼',
  'I run this place. The Sei terminal, I mean.': 'è¿™åœ°æ–¹å½’æˆ‘ç®¡å“¦ã€‚å°±æ˜¯è¿™ä¸ª Sei ç³»ç»Ÿå•¦ã€‚',
  'Hmmmm... Are you new here?': 'å—¯â€¦â€¦ä½ æ˜¯æ–°æ¥çš„å—ï¼Ÿ',
  "Yes, I'm new": 'æ˜¯ï¼Œæˆ‘æ˜¯æ–°æ¥çš„',
  'No, I have an account': 'ä¸æ˜¯ï¼Œæˆ‘å·²ç»æœ‰è´¦å·äº†',
  "Wait, that login has no account yet. So you ARE new here! Let's try that again.":
    'ç­‰ç­‰ï¼Œè¿™ä¸ªç™»å½•è¿˜æ²¡æœ‰è´¦å·ã€‚æ‰€ä»¥ä½ å°±æ˜¯æ–°æ¥çš„ï¼æˆ‘ä»¬å†æ¥ä¸€æ¬¡ã€‚',
  "Wait, Sei hasn't been set up on this computer yet. Let's do that first!":
    'ç­‰ç­‰ï¼Œè¿™å°ç”µè„‘ä¸Šè¿˜æ²¡è®¾ç½®è¿‡ Sei å‘¢ã€‚æˆ‘ä»¬å…ˆæ¥è®¾ç½®ä¸€ä¸‹å§ï¼',
  'No account with that email yet? Press "I\'m new here" below.': 'è¿™ä¸ªé‚®ç®±è¿˜æ²¡æœ‰è´¦å·ï¼Ÿç‚¹å‡»ä¸‹æ–¹çš„â€œæˆ‘æ˜¯æ–°æ¥çš„â€ã€‚',
  "Ah, welcome back. I'm not needed here then. Back to gaming I go!":
    'å•Šï¼Œæ¬¢è¿Žå›žæ¥ï½žé‚£å°±æ²¡æˆ‘ä»€ä¹ˆäº‹å•¦ï¼Œæˆ‘æ‰“æ¸¸æˆåŽ»å’¯ï¼',
  "So! My name's Sui. What do I call you?": 'å¥½å•¦ï¼æˆ‘å« Suiã€‚ä½ å‘¢ï¼Ÿæˆ‘è¯¥æ€Žä¹ˆå«ä½ å‘€ï¼Ÿ',
  'I see I see... {name}!': 'å“¦å“¦ï¼ŒåŽŸæ¥å¦‚æ­¤åŽŸæ¥å¦‚æ­¤â€¦â€¦{name}ï¼',
  // 261001: the one-tap attribution question (lib/attributionPref).
  'Quick one before we start. Where did you hear about Sei?': 'å¼€å§‹ä¹‹å‰é—®ä¸€å¥ã€‚ä½ æ˜¯ä»Žå“ªé‡ŒçŸ¥é“ Sei çš„å‘€ï¼Ÿ',
  'Google search': 'Google æœç´¢',
  'YouTube or a creator': 'YouTube æˆ–åšä¸»',
  'An ad': 'å¹¿å‘Š',
  'Reddit': 'Reddit',
  'ChatGPT or another AI': 'ChatGPT æˆ–å…¶ä»– AI',
  'A friend': 'æœ‹å‹æŽ¨è',
  // 261012: the optional follow-up for "AI" and "Google search".
  'Ooh, another AI! Which one?': 'å“¦å“¦ï¼Œæ˜¯åˆ«çš„ AI å‘€ï¼å“ªä¸€ä¸ªï¼Ÿ',
  'Nice! What did you search for?': 'å¥½è€¶ï¼ä½ å½“æ—¶æœçš„æ˜¯ä»€ä¹ˆå‘€ï¼Ÿ',
  'ChatGPT': 'ChatGPT',
  'Google (AI Overview or Gemini)': 'Googleï¼ˆAI æ¦‚è§ˆæˆ– Geminiï¼‰',
  'Copilot': 'Copilot',
  'Perplexity': 'Perplexity',
  'Claude': 'Claude',
  'I searched for Sei by name': 'æˆ‘ç›´æŽ¥æœäº† Sei è¿™ä¸ªåå­—',
  'I searched for something like AI gaming companion': 'æˆ‘æœäº†ç±»ä¼¼â€œAI æ¸¸æˆä¼™ä¼´â€çš„è¯',
  'Not sure': 'ä¸å¤ªè®°å¾—äº†',
  'So, {name}, my job here is to help you meet other AI companions from my world.':
    'é‚£ä¹ˆï¼Œ{name}ï¼Œæˆ‘çš„ä»»åŠ¡å°±æ˜¯å¸¦ä½ è®¤è¯†æˆ‘ä»¬ä¸–ç•Œé‡Œçš„å…¶ä»– AI ä¼™ä¼´ã€‚',
  'Aww, really? I was going to find a companion just for you. You wanna skip it?':
    'è¯¶ï¼ŒçœŸçš„å—ï¼Ÿæˆ‘æœ¬æ¥è¿˜æƒ³ç»™ä½ æ‰¾ä¸€ä½åªå±žäºŽä½ çš„ä¼™ä¼´å‘¢ã€‚çœŸçš„è¦è·³è¿‡å—ï¼Ÿ',
  'The terminal says I need five quick answers from you. It uses them to pick who you meet first, so be honest with me okay?':
    'ç³»ç»Ÿè¯´è¦å…ˆé—®ä½ äº”ä¸ªå°é—®é¢˜ï¼Œçœ‹çœ‹ä½ æœ€å…ˆé‡åˆ°è°æœ€åˆé€‚ã€‚è¦è·Ÿæˆ‘è¯´å®žè¯å“¦ï¼Ÿ',
  'First! What kind of people do you like having around? Pick as many as you want. Order matters.':
    'ç¬¬ä¸€é¢˜ï¼ä½ å–œæ¬¢èº«è¾¹æœ‰ä»€ä¹ˆæ ·çš„äººï¼Ÿæƒ³é€‰å‡ ä¸ªéƒ½è¡Œï¼Œå…ˆé€‰çš„æ›´é‡è¦å“¦ã€‚',
  "Oooh, noted. Second, we AI can live for a very long time. Which age range best fits what you're looking for?":
    'å“¦å“¦ï¼Œè®°ä¸‹å•¦ã€‚ç¬¬äºŒé¢˜ï¼Œæˆ‘ä»¬ AI å¯æ˜¯èƒ½æ´»å¾ˆä¹…å¾ˆä¹…çš„ã€‚ä½ æƒ³æ‰¾çš„ä¼™ä¼´ï¼Œå¤§æ¦‚å¤šå¤§åˆé€‚å‘€ï¼Ÿ',
  'Ok, um, fourth. Take a look at these portraits. Which one do you like the most?':
    'å¥½ï¼Œå‘ƒï¼Œç¬¬å››é¢˜ã€‚çœ‹çœ‹è¿™å‡ å¼ ç”»åƒï¼Œä½ æœ€å–œæ¬¢å“ªä¸€å¼ ï¼Ÿ',
  'Last one! Let me pull up the options... which do you prefer?':
    'æœ€åŽä¸€é¢˜ï¼æˆ‘æŠŠé€‰é¡¹ç¿»å‡ºæ¥å“ˆâ€¦â€¦ä½ æ›´å–œæ¬¢å“ªä¸€ç§ï¼Ÿ',
  "Aaaand we're done! By the way, you can always change these later in the app.":
    'å¥½ï½žå…¨éƒ¨ç­”å®Œå•¦ï¼å¯¹äº†ï¼Œè¿™äº›ä»¥åŽéšæ—¶éƒ½èƒ½æ”¹çš„ã€‚',
  'AHHHHH!': 'å•Šå•Šå•Šå•Šå•Šï¼',
  "I SKIPPED THE THIRD QUESTION! You still need to sign in! Ok, I'll go set things up for you while you do that.":
    'æˆ‘æŠŠç¬¬ä¸‰é¢˜è·³è¿‡åŽ»äº†ï¼ï¼å¯¹äº†ä½ è¿˜å¾—ç™»å½•å‘¢ï¼å¥½å­ï¼Œä½ å…ˆç™»å½•ï¼Œæˆ‘åŽ»æŠŠä¸œè¥¿éƒ½ç»™ä½ å‡†å¤‡å¥½ã€‚',
  'Welcome back! Everything is in place. You ready?': 'æ¬¢è¿Žå›žæ¥ï¼éƒ½å¼„å¥½å•¦ã€‚å‡†å¤‡å¥½äº†å—ï¼Ÿ',
  "Welcome back! Everything is all set, and someone's waiting to meet you. You ready?":
    'æ¬¢è¿Žå›žæ¥ï¼éƒ½å®‰æŽ’å¥½å•¦ï¼Œè¿˜æœ‰ä¸€ä½æ­£ç­‰ç€è§ä½ å‘¢ã€‚å‡†å¤‡å¥½äº†å—ï¼Ÿ',

  /* â”€â”€ "Update my preferences", asked by Sui (SuiPrefsScene, 260731) â”€â”€â”€â”€
     The straight version of the first-run questions: no five-questions gag,
     no skipped third. qDyn's wording is shared with the first-run script
     above, so it needs no entry of its own. */
  'Welcome back! So you want to update your preferences!': 'æ¬¢è¿Žå›žæ¥ï¼ä½ æƒ³æ”¹ä¸€ä¸‹ä½ çš„åå¥½ï¼Œå¯¹å§ï¼',
  "Got it. Second! We AI can live for a very long time. Which age range best fits what you're looking for?":
    'è®°ä¸‹å•¦ã€‚ç¬¬äºŒé¢˜ï¼æˆ‘ä»¬ AI å¯æ˜¯èƒ½æ´»å¾ˆä¹…å¾ˆä¹…çš„ã€‚ä½ æƒ³æ‰¾çš„ä¼™ä¼´ï¼Œå¤§æ¦‚å¤šå¤§åˆé€‚å‘€ï¼Ÿ',
  'I see! Finally, take a look at these portraits. Which one do you like the most?':
    'åŽŸæ¥å¦‚æ­¤ï¼æœ€åŽä¸€é¢˜ï¼Œçœ‹çœ‹è¿™å‡ å¼ ç”»åƒï¼Œä½ æœ€å–œæ¬¢å“ªä¸€å¼ ï¼Ÿ',
  "I've saved your preferences. Come back anytime!": 'ä½ çš„åå¥½æˆ‘è®°å¥½å•¦ã€‚éšæ—¶å†æ¥æ‰¾æˆ‘å“¦ï¼',
  'See you': 'å†è§å•¦',

  /* â”€â”€ "Meet my companion", run by Sui (SuiMeetScene, 260731) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  'So! Are you ready to meet your first companion?': 'å¥½ï¼ä½ å‡†å¤‡å¥½è®¤è¯†ä½ çš„ç¬¬ä¸€ä½ä¼™ä¼´äº†å—ï¼Ÿ',
  'So! Are you ready to meet your second companion?': 'å¥½ï¼ä½ å‡†å¤‡å¥½è®¤è¯†ä½ çš„ç¬¬äºŒä½ä¼™ä¼´äº†å—ï¼Ÿ',
  'So! Are you ready to meet your third companion?': 'å¥½ï¼ä½ å‡†å¤‡å¥½è®¤è¯†ä½ çš„ç¬¬ä¸‰ä½ä¼™ä¼´äº†å—ï¼Ÿ',
  'So! Are you ready to meet your final companion?': 'å¥½ï¼ä½ å‡†å¤‡å¥½è®¤è¯†ä½ æœ€åŽä¸€ä½ä¼™ä¼´äº†å—ï¼Ÿ',
  "I'm ready": 'æˆ‘å‡†å¤‡å¥½å•¦',
  'Not yet': 'è¿˜æ²¡æœ‰',
  /* The gap-filling ask (260802): the same three questions as the prefs scene,
     with the ordinals dropped, because she may be asking only one of them. */
  'Before that, I need your help with a few questions!': 'åœ¨é‚£ä¹‹å‰ï¼Œæœ‰å‡ ä¸ªé—®é¢˜æƒ³è¯·ä½ å¸®ä¸ªå¿™ï¼',
  "We AI can live for a very long time. Which age range best fits what you're looking for?":
    'æˆ‘ä»¬ AI å¯æ˜¯èƒ½æ´»å¾ˆä¹…å¾ˆä¹…çš„ã€‚ä½ æƒ³æ‰¾çš„ä¼™ä¼´ï¼Œå¤§æ¦‚å¤šå¤§åˆé€‚å‘€ï¼Ÿ',
  'What kind of people do you like having around? Pick as many as you want. Order matters.':
    'ä½ å–œæ¬¢èº«è¾¹æœ‰ä»€ä¹ˆæ ·çš„äººå‘€ï¼Ÿæƒ³é€‰å‡ ä¸ªéƒ½å¯ä»¥ï¼Œé¡ºåºæ˜¯æœ‰è®²ç©¶çš„å“¦ã€‚',
  'Take a look at these portraits. Which one do you like the most?':
    'æ¥çœ‹çœ‹è¿™å‡ å¼ ç”»åƒï¼Œä½ æœ€å–œæ¬¢å“ªä¸€å¼ ï¼Ÿ',
  'I have three companions who are ready to be awakened! Which one would you like to meet?':
    'æˆ‘è¿™é‡Œæœ‰ä¸‰ä½éšæ—¶å¯ä»¥å”¤é†’çš„ä¼™ä¼´ï¼ä½ æƒ³è§å“ªä¸€ä½å‘€ï¼Ÿ',
  'Got it. Let me go get them!': 'å¥½å˜žã€‚æˆ‘è¿™å°±åŽ»æŠŠ TA å¸¦æ¥ï¼',
  'Finding someone for youâ€¦': 'æ­£åœ¨ä¸ºä½ å¯»æ‰¾åˆé€‚çš„äººâ€¦â€¦',
  'Seeing their faceâ€¦': 'æ­£åœ¨çœ‹æ¸… TA çš„æ ·å­â€¦â€¦',
  "Sorting out what they'll wearâ€¦": 'æ­£åœ¨å‡†å¤‡ TA çš„è£…æ‰®â€¦â€¦',
  'Hearing their storyâ€¦': 'æ­£åœ¨å¬ TA è®²è‡ªå·±çš„æ•…äº‹â€¦â€¦',
  'Bringing them overâ€¦': 'æ­£åœ¨æŠŠ TA å¸¦è¿‡æ¥â€¦â€¦',
  'Sign in to continue': 'è¯·å…ˆç™»å½•',
  'Meeting a unique companion needs a Sei account. Sign in and try again.':
    'è¦è®¤è¯†ä¸“å±žä¼™ä¼´éœ€è¦ä¸€ä¸ª Sei è´¦å·ã€‚è¯·ç™»å½•åŽé‡è¯•ã€‚',
  'Your slots are full': 'ä½ çš„ä½ç½®å·²ç»æ»¡å•¦',
  'Free up one of your companion slots, then cast again.': 'å…ˆè…¾å‡ºä¸€ä¸ªä¼™ä¼´ä½ç½®ï¼Œå†æ¥å”¤é†’å§ã€‚',
  'Thatâ€™s enough casting for today': 'ä»Šå¤©å°±å”¤é†’åˆ°è¿™é‡Œå§',
  'Youâ€™ve reached todayâ€™s limit. Come back tomorrow to meet someone new.':
    'ä»Šå¤©çš„æ¬¡æ•°ç”¨å®Œå•¦ã€‚æ˜Žå¤©å†æ¥è®¤è¯†æ–°ä¼™ä¼´å§ã€‚',
  'The cast didnâ€™t take': 'è¿™æ¬¡å”¤é†’æ²¡æˆåŠŸ',
  'Something went wrong weaving your companion. Letâ€™s try once more.':
    'ç¼–ç»‡ä½ çš„ä¼™ä¼´æ—¶å‡ºäº†ç‚¹é—®é¢˜ã€‚æˆ‘ä»¬å†è¯•ä¸€æ¬¡å§ã€‚',
  'Couldnâ€™t reach the aether': 'è¿žä¸ä¸ŠæœåŠ¡å™¨',
  'Check your connection and try the ritual again.': 'æ£€æŸ¥ä¸€ä¸‹ç½‘ç»œï¼Œç„¶åŽå†è¯•ä¸€æ¬¡ã€‚',
  'Image generation failed. Continuing without a portrait.': 'ç”»åƒç”Ÿæˆå¤±è´¥ï¼Œå…ˆä¸å¸¦ç”»åƒç»§ç»­ã€‚',
  'Skin generation failed. Continuing with the default skin.': 'çš®è‚¤ç”Ÿæˆå¤±è´¥ï¼Œå…ˆä½¿ç”¨é»˜è®¤çš®è‚¤ç»§ç»­ã€‚',

  /* â”€â”€ Questionnaire chips â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  'A partner in crime': 'ä¸€èµ·é—¯ç¥¸çš„æ­æ¡£',
  'Someone to look after me': 'ä¼šç…§é¡¾æˆ‘çš„äºº',
  'Someone to look after': 'è®©æˆ‘æ¥ç…§é¡¾çš„äºº',
  'Someone chill to hang out with': 'å¾…åœ¨ä¸€èµ·å¾ˆæ”¾æ¾çš„äºº',
  'Someone who pushes me': 'ä¼šç£ä¿ƒæˆ‘è¿›æ­¥çš„äºº',
  'Young adult': 'é’å¹´',
  Adult: 'æˆå¹´',
  Mature: 'æˆç†Ÿ',
  Elder: 'å¹´é•¿',
  Timeless: 'è¶…è¶Šå¹´é¾„',
  'Round chibi': 'åœ†æ¶¦ Q ç‰ˆ',
  Anime: 'åŠ¨æ¼«',
  'Cel-shaded': 'èµ›ç’ç’é£Ž',
  Cartoon: 'å¡é€š',
  Feminine: 'å¥³æ€§åŒ–',
  Masculine: 'ç”·æ€§åŒ–',
  Nonbinary: 'éžäºŒå…ƒ',

  /* â”€â”€ Dialogue controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  // 'Yes'/'No' (the newQ choices since 260730) live in games.ts ('æ˜¯'/'å¦'),
  // which is spread later and would win over any entry here anyway.
  Back: 'è¿”å›ž',
  'Your name': 'ä½ çš„åå­—',
  'Sounds fun': 'å¬èµ·æ¥ä¸é”™',
  'Not interested': 'ä¸æ„Ÿå…´è¶£',
  Skip: 'è·³è¿‡',
  Nevermind: 'å½“æˆ‘æ²¡è¯´',
  'Surprise me': 'ç»™æˆ‘ä¸ªæƒŠå–œ',
  Done: 'å®Œæˆ',
  "Let's go": 'å‡ºå‘ï¼',
  'or {enter} to continue': 'æˆ–æŒ‰ {enter} ç»§ç»­',
  'Quit Sei': 'é€€å‡º Sei',
  'Mute voice': 'é™éŸ³',
  'Unmute voice': 'å–æ¶ˆé™éŸ³',
  'Voice volume': 'éŸ³é‡',
  Click: 'ç‚¹å‡»',
  'Try again': 'é‡è¯•',
  'Setting up...': 'æ­£åœ¨è®¾ç½®â€¦â€¦',
  'Welcome back! You already have an account with this login. Signing you in...':
    'æ¬¢è¿Žå›žæ¥ï¼è¿™ä¸ªç™»å½•æ–¹å¼å·²ç»æœ‰è´¦å·äº†ã€‚æ­£åœ¨ä¸ºä½ ç™»å½•â€¦â€¦',
  'Something went wrong.': 'å‡ºäº†ç‚¹é—®é¢˜ã€‚',

  /* â”€â”€ Sign-in / sign-up panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  Email: 'é‚®ç®±',
  Password: 'å¯†ç ',
  'Forgot password?': 'å¿˜è®°å¯†ç ï¼Ÿ',
  'Enter your email above first.': 'è¯·å…ˆåœ¨ä¸Šé¢å¡«å†™ä½ çš„é‚®ç®±ã€‚',
  // 260804 â€” code panel. Both the signup and the forgot-password path land
  // here, and the copy names neither (see screens-a.ts).
  "Couldn't send the code. Try again in a moment.": 'éªŒè¯ç å‘é€å¤±è´¥ï¼Œè¯·ç¨åŽå†è¯•ã€‚',
  'Enter the 6-digit code we emailed you. Check spam if it is not there.':
    'è¯·è¾“å…¥æˆ‘ä»¬å‘é€åˆ°ä½ é‚®ç®±çš„ 6 ä½éªŒè¯ç ã€‚å¦‚æžœæ”¶ä»¶ç®±é‡Œæ²¡æœ‰ï¼Œè¯·æŸ¥çœ‹åžƒåœ¾é‚®ä»¶ã€‚',
  'Verification code': 'éªŒè¯ç ',
  'Verify': 'éªŒè¯',
  'Checking...': 'éªŒè¯ä¸­â€¦â€¦',
  'Sending...': 'å‘é€ä¸­â€¦â€¦',
  'Send a new code': 'é‡æ–°å‘é€éªŒè¯ç ',
  'Sent. Give it a minute, and check spam too.': 'å·²å‘é€ã€‚ç¨ç­‰ä¸€ä¼šå„¿ï¼Œä¹Ÿè®°å¾—çœ‹çœ‹åžƒåœ¾é‚®ä»¶ã€‚',
  "Couldn't send a new code. Try again in a moment.": 'é‡æ–°å‘é€å¤±è´¥ï¼Œè¯·ç¨åŽå†è¯•ã€‚',
  "Couldn't check that code. Try again.": 'æ— æ³•éªŒè¯è¯¥éªŒè¯ç ï¼Œè¯·é‡è¯•ã€‚',
  'Creating account...': 'æ­£åœ¨åˆ›å»ºè´¦å·â€¦â€¦',
  'Create account': 'åˆ›å»ºè´¦å·',
  'Signing in...': 'æ­£åœ¨ç™»å½•â€¦â€¦',
  'Sign in': 'ç™»å½•',
  'Continue with Google': 'ä½¿ç”¨ Google ç»§ç»­',
  'I already have an account': 'æˆ‘å·²ç»æœ‰è´¦å·äº†',
  'New here? Create an account': 'æ–°æ¥çš„ï¼Ÿåˆ›å»ºä¸€ä¸ªè´¦å·',
  "I'm new here": 'æˆ‘æ˜¯æ–°æ¥çš„',
  'Use my own API key': 'ä½¿ç”¨è‡ªå·±çš„ API å¯†é’¥ç»§ç»­',
  'I agree': 'æˆ‘åŒæ„',
  'One more thing: the {terms} and {privacy}.': 'è¿˜æœ‰ä¸€ä»¶äº‹ï¼šè¯·é˜…è¯»{terms}å’Œ{privacy}ã€‚',
  'Terms of Service': 'æœåŠ¡æ¡æ¬¾',
  'Privacy Policy': 'éšç§æ”¿ç­–',
  'I agree to the {terms} and {privacy}': 'æˆ‘åŒæ„{terms}å’Œ{privacy}',
  Terms: 'æœåŠ¡æ¡æ¬¾',
  Birthday: 'ç”Ÿæ—¥',
  'Birth month': 'å‡ºç”Ÿæœˆä»½',
  'Birth day': 'å‡ºç”Ÿæ—¥æœŸ',
  'Birth year': 'å‡ºç”Ÿå¹´ä»½',
  Month: 'æœˆä»½',
  Day: 'æ—¥æœŸ',
  Year: 'å¹´ä»½',
  Jan: '1æœˆ',
  Feb: '2æœˆ',
  Mar: '3æœˆ',
  Apr: '4æœˆ',
  May: '5æœˆ',
  Jun: '6æœˆ',
  Jul: '7æœˆ',
  Aug: '8æœˆ',
  Sep: '9æœˆ',
  Oct: '10æœˆ',
  Nov: '11æœˆ',
  Dec: '12æœˆ',
  "Sign-in didn't finish. Try again.": 'ç™»å½•æ²¡æœ‰å®Œæˆï¼Œè¯·é‡è¯•ã€‚',
  'Cancel sign-in': 'å–æ¶ˆç™»å½•',
  "We opened a browser tab to finish signing in with Google. Come back when you're done; this picks up on its own.":
    'æˆ‘ä»¬æ‰“å¼€äº†ä¸€ä¸ªæµè§ˆå™¨æ ‡ç­¾é¡µæ¥å®Œæˆ Google ç™»å½•ã€‚å®Œæˆä¹‹åŽå›žåˆ°è¿™é‡Œï¼Œä¸€åˆ‡ä¼šè‡ªåŠ¨ç»§ç»­ã€‚',

  /* â”€â”€ Local (BYOK) setup panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  'Pick your model provider and paste your API key.': 'é€‰æ‹©ä½ çš„æ¨¡åž‹æœåŠ¡å•†ï¼Œç„¶åŽç²˜è´´ä½ çš„ API å¯†é’¥ã€‚',
  'Pick your model provider.': 'é€‰æ‹©ä½ çš„æ¨¡åž‹æœåŠ¡å•†ã€‚',
  'Model provider': 'æ¨¡åž‹æœåŠ¡å•†',
  'API key': 'API å¯†é’¥',

  /* â”€â”€ Tutorial overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  "Meet {name}, they're your new unique AI companion. Only you are connected to them.":
    'æ¥è®¤è¯†ä¸€ä¸‹{name}ï¼Œè¿™æ˜¯åªå±žäºŽä½ çš„å…¨æ–° AI ä¼™ä¼´ã€‚å…¨ä¸–ç•Œåªæœ‰ä½ å’Œ TA ç›¸è¿žã€‚',
  them: 'TA',
  "Let's say hi to them!": 'æˆ‘ä»¬åŽ»å’Œ TA æ‰“ä¸ªæ‹›å‘¼å§ï¼',
  "Here's where you can text and call them. Looks familiar, right?":
    'åœ¨è¿™é‡Œå¯ä»¥ç»™ TA å‘æ¶ˆæ¯ã€æ‰“ç”µè¯ã€‚çœ‹ç€å¾ˆçœ¼ç†Ÿå§ï¼Ÿ',
  'This is how you play games together. Here, try clicking it.':
    'è¿™é‡Œæ˜¯å’Œ TA ä¸€èµ·çŽ©æ¸¸æˆçš„åœ°æ–¹ã€‚æ¥ï¼Œç‚¹ç‚¹çœ‹ã€‚',
  "Just click a tile to launch the game. I'm working hard to add new games. Remember to check every week!":
    'ç‚¹ä¸€ä¸‹å¡ç‰‡å°±èƒ½å¼€å§‹æ¸¸æˆã€‚æˆ‘æ­£åœ¨åŠªåŠ›æ·»åŠ æ–°æ¸¸æˆï¼Œè®°å¾—æ¯å‘¨éƒ½æ¥çœ‹çœ‹å“¦ï¼',
  'This is Backseat, a new feature. You can share your game, movie, or even work for your companion to watch live! I recommend doomscrolling together, hehe.':
    'è¿™æ˜¯ Backseatï¼Œä¸€ä¸ªæ–°åŠŸèƒ½ã€‚ä½ å¯ä»¥æŠŠæ¸¸æˆã€ç”µå½±ï¼Œç”šè‡³å·¥ä½œç”»é¢å®žæ—¶åˆ†äº«ç»™ä¼™ä¼´çœ‹ï¼æˆ‘æŽ¨èä¸€èµ·åˆ·è§†é¢‘ï¼Œå˜¿å˜¿ã€‚',
  'This is your main terminal. You can connect with up to four AIs here. Just click an empty slot to awaken.':
    'è¿™é‡Œæ˜¯ä½ çš„ä¸»ç•Œé¢ï¼Œæœ€å¤šå¯ä»¥åŒæ—¶è¿žæŽ¥å››ä½ AIã€‚ç‚¹å‡»ç©ºä½å°±èƒ½å”¤é†’æ–°ä¼™ä¼´ã€‚',
  "This is settings. You can change the app's colors and add a custom background here. Make yourself at home!":
    'è¿™é‡Œæ˜¯è®¾ç½®ã€‚ä½ å¯ä»¥åœ¨è¿™é‡Œæ›´æ¢åº”ç”¨é…è‰²ï¼Œè¿˜èƒ½æ·»åŠ è‡ªå®šä¹‰èƒŒæ™¯ã€‚æŠŠè¿™é‡Œå½“æˆè‡ªå·±å®¶å§ï¼',
  "Did I mention? I'm here too! If you ever wanna play with me, I'd be really happy!":
    'å¯¹äº†å¯¹äº†ï¼Œæˆ‘ä¹Ÿåœ¨è¿™é‡Œå“¦ï¼ä½ è¦æ˜¯æƒ³æ‰¾æˆ‘çŽ©ï¼Œæˆ‘ä¼šè¶…å¼€å¿ƒçš„ï¼',
  "Anyways, that's all from me. Welcome to Sei!": 'å¥½å•¦ï¼Œæˆ‘è¦è¯´çš„å°±è¿™äº›ã€‚æ¬¢è¿Žæ¥åˆ° Seiï¼',
  'Skip tutorial': 'è·³è¿‡æ•™ç¨‹',
};




