/**
 * Simplified-Chinese dictionary, keyed by the exact English UI string.
 *
 * Rules:
 *  - Keys are the literal English strings passed to t(); a missing key just
 *    renders English, so never invent keys that no call site uses.
 *  - `{name}`-style placeholders must survive translation verbatim.
 *  - Chinese copy uses Chinese punctuation (ï¼Œã€‚ï¼ï¼Ÿã€Œã€), and the no-em-dash
 *    rule applies to BOTH languages: no em dash in any value.
 *  - The dictionary is split into per-surface part files under ./zh/ so the
 *    localization sweep can fill them independently; later spreads win on a
 *    duplicate key, so keep shared strings in common.ts only.
 */
import { ZH_COMMON } from './zh/common';
import { ZH_SCREENS_A } from './zh/screens-a';
import { ZH_SCREENS_B } from './zh/screens-b';
import { ZH_ONBOARD } from './zh/onboard';
import { ZH_MODALS } from './zh/modals';
import { ZH_CHATUI } from './zh/chatui';
import { ZH_GAMES } from './zh/games';
import { ZH_MISC } from './zh/misc';
import { ZH_DONTSTARVE } from './zh/dontstarve';
import { ZH_STARDEW } from './zh/stardew';
import { ZH_GAPS_261104 } from './zh/gaps261104';
import { ZH_SEILINK } from './zh/seilink';
import { ZH_SETUP_261104 } from './zh/setup261104';
import { ZH_AVATARS_261106 } from './zh/avatars261106';
import { ZH_PROFILE_261107 } from './zh/profile261107';
import { ZH_PLAYTIME_261110 } from './zh/playtime261110';

export const ZH: Record<string, string> = {
  ...ZH_COMMON,
  ...ZH_SCREENS_A,
  ...ZH_SCREENS_B,
  ...ZH_ONBOARD,
  ...ZH_MODALS,
  ...ZH_CHATUI,
  ...ZH_GAMES,
  ...ZH_MISC,
  ...ZH_DONTSTARVE,
  ...ZH_STARDEW,
  ...ZH_GAPS_261104,
  ...ZH_SEILINK,
  ...ZH_SETUP_261104,
  ...ZH_AVATARS_261106,
  ...ZH_PROFILE_261107,
  ...ZH_PLAYTIME_261110,

  // W5 settings (china-compat)
  // Model picker + Test probe (SettingsScreen)
  'Model': 'æ¨¡åž‹',
  'default': 'é»˜è®¤',
  'Choose model': 'é€‰æ‹©æ¨¡åž‹',
  'Loading modelsâ€¦': 'æ­£åœ¨åŠ è½½æ¨¡åž‹â€¦',
  'no vision': 'ä¸æ”¯æŒå›¾åƒ',
  'No models listed.': 'æ²¡æœ‰å¯åˆ—å‡ºçš„æ¨¡åž‹ã€‚',
  'Models marked "no vision" cannot see images. Screen sharing and Draw! need a model that can see images.':
    'æ ‡æœ‰ã€Œä¸æ”¯æŒå›¾åƒã€çš„æ¨¡åž‹æ— æ³•è¯†åˆ«å›¾ç‰‡ã€‚å±å¹•å…±äº«å’Œ Draw! éœ€è¦èƒ½è¯†åˆ«å›¾ç‰‡çš„æ¨¡åž‹ã€‚',
  'Connection': 'è¿žæŽ¥',
  'Test': 'æµ‹è¯•',
  'Testingâ€¦': 'æµ‹è¯•ä¸­â€¦',
  'Working. Replied in {s}s.': 'æ­£å¸¸ã€‚{s} ç§’å†…å›žå¤ã€‚',
  'Testing your key and model. This can take up to a minute.':
    'æ­£åœ¨æµ‹è¯•ä½ çš„å¯†é’¥å’Œæ¨¡åž‹ï¼Œæœ€é•¿å¯èƒ½éœ€è¦ä¸€åˆ†é’Ÿã€‚',
  'Add your API key first.': 'è¯·å…ˆå¡«å†™ä½ çš„ API å¯†é’¥ã€‚',
  'The provider rejected your key. Check that it is correct and active.':
    'æœåŠ¡å•†æ‹’ç»äº†ä½ çš„å¯†é’¥ã€‚è¯·ç¡®è®¤å¯†é’¥æ­£ç¡®ä¸”æœ‰æ•ˆã€‚',
  'Timed out. Check your connection and try again.': 'è¯·æ±‚è¶…æ—¶ã€‚è¯·æ£€æŸ¥ç½‘ç»œåŽé‡è¯•ã€‚',
  'Could not reach the provider. Check your connection.': 'æ— æ³•è¿žæŽ¥åˆ°æœåŠ¡å•†ã€‚è¯·æ£€æŸ¥ç½‘ç»œã€‚',
  'The provider returned an error (HTTP {status}).': 'æœåŠ¡å•†è¿”å›žäº†é”™è¯¯ï¼ˆHTTP {status}ï¼‰ã€‚',
  'Something went wrong. Try again.': 'å‡ºäº†ç‚¹é—®é¢˜ã€‚è¯·é‡è¯•ã€‚',
  // Voice group: TTS engine + local voice packs
  'Voices': 'è¯­éŸ³',
  'About voice engines': 'å…³äºŽè¯­éŸ³å¼•æ“Ž',
  "What speaks your companions' lines on calls. ElevenLabs uses your own key. Local voices run on this device and work offline.":
    'é€šè¯æ—¶ç”±è°æ¥æœ—è¯»ä¼™ä¼´çš„å°è¯ã€‚ElevenLabs ä½¿ç”¨ä½ è‡ªå·±çš„å¯†é’¥ã€‚æœ¬åœ°è¯­éŸ³åœ¨æœ¬æœºè¿è¡Œï¼Œå¯ç¦»çº¿ä½¿ç”¨ã€‚',
  'ElevenLabs': 'ElevenLabs',
  'Local': 'æœ¬åœ°',
  'ElevenLabs voices need your own ElevenLabs API key. No key? Switch to the local voices.':
    'ElevenLabs è¯­éŸ³éœ€è¦ä½ è‡ªå·±çš„ ElevenLabs API å¯†é’¥ã€‚æ²¡æœ‰å¯†é’¥ï¼Ÿå¯ä»¥åˆ‡æ¢åˆ°æœ¬åœ°è¯­éŸ³ã€‚',
  'Not connected to Sei cloud or an ElevenLabs key. Custom voices will not play. Local voice packs still work.':
    'æœªè¿žæŽ¥ Sei äº‘ç«¯ï¼Œä¹Ÿæ²¡æœ‰ ElevenLabs å¯†é’¥ã€‚è‡ªå®šä¹‰è¯­éŸ³å°†æ— æ³•æ’­æ”¾ã€‚æœ¬åœ°è¯­éŸ³åŒ…ä»å¯æ­£å¸¸ä½¿ç”¨ã€‚',
  'English voices, female and male': 'è‹±è¯­è¯­éŸ³ï¼Œå¥³å£°å’Œç”·å£°',
  'Chinese voices, female and male': 'ä¸­æ–‡è¯­éŸ³ï¼Œå¥³å£°å’Œç”·å£°',
  // 261102: Local voice choice (Fast = the original packs, or Kokoro).
  'Kokoro voices': 'Kokoro è¯­éŸ³',
  'Local voice': 'æœ¬åœ°è¯­éŸ³',
  'About local voices': 'å…³äºŽæœ¬åœ°è¯­éŸ³',
  'Fast': 'å¿«é€Ÿ',
  "Fast voices start speaking right away and come in English and Chinese. Kokoro sounds more natural but takes longer to speak, and speaks English, Spanish and French. Other languages use the Fast voices. Fish Audio is an online service that needs your own free Fish Audio key. It sends your companions' lines to Fish Audio.":
    'å¿«é€Ÿè¯­éŸ³èƒ½ç«‹åˆ»å¼€å£ï¼Œæä¾›è‹±è¯­å’Œä¸­æ–‡ã€‚Kokoro å¬èµ·æ¥æ›´è‡ªç„¶ï¼Œä½†å¼€å£è¦æ…¢ä¸€äº›ï¼Œæ”¯æŒè‹±è¯­ã€è¥¿ç­ç‰™è¯­å’Œæ³•è¯­ã€‚å…¶ä»–è¯­è¨€ä½¿ç”¨å¿«é€Ÿè¯­éŸ³ã€‚Fish Audio æ˜¯åœ¨çº¿æœåŠ¡ï¼Œéœ€è¦ä½ è‡ªå·±çš„å…è´¹ Fish Audio å¯†é’¥ï¼Œä¼šæŠŠä¼™ä¼´è¦è¯´çš„è¯å‘é€ç»™ Fish Audioã€‚',
  'Kokoro speaks English, Spanish and French. Companions in other languages use the Fast voices.':
    'Kokoro æ”¯æŒè‹±è¯­ã€è¥¿ç­ç‰™è¯­å’Œæ³•è¯­ã€‚ä½¿ç”¨å…¶ä»–è¯­è¨€çš„ä¼™ä¼´ä¼šä½¿ç”¨å¿«é€Ÿè¯­éŸ³ã€‚',
  'Kokoro sounds more natural but is slower.': 'Kokoro å¬èµ·æ¥æ›´è‡ªç„¶ï¼Œä½†é€Ÿåº¦è¾ƒæ…¢ã€‚',
  // 261103 Fish Audio local voice (Settings + Edit companion)
  'Fish Audio (online, free API key)': 'Fish Audioï¼ˆåœ¨çº¿ï¼Œå…è´¹ API å¯†é’¥ï¼‰',
  'If Fish Audio cannot speak a line, the Fast voices below speak it.': 'å¦‚æžœ Fish Audio æ— æ³•æœ—è¯»æŸå¥è¯ï¼Œä¼šæ”¹ç”¨ä¸‹æ–¹çš„å¿«é€Ÿè¯­éŸ³ã€‚',
  'Fish Audio key': 'Fish Audio å¯†é’¥',
  'Your Fish Audio key': 'ä½ çš„ Fish Audio å¯†é’¥',
  'Fish Audio works.': 'Fish Audio å¯ä»¥æ­£å¸¸ä½¿ç”¨ã€‚',
  "Fish Audio is an online service. Sei uses its free model and sends your companions' lines to Fish Audio to be spoken.":
    'Fish Audio æ˜¯åœ¨çº¿æœåŠ¡ã€‚Sei ä½¿ç”¨å®ƒçš„å…è´¹æ¨¡åž‹ï¼Œå¹¶æŠŠä¼™ä¼´è¦è¯´çš„è¯å‘é€ç»™ Fish Audio æœ—è¯»ã€‚',
  'Get a free key': 'èŽ·å–å…è´¹å¯†é’¥',
  'Add your Fish Audio key first.': 'è¯·å…ˆæ·»åŠ ä½ çš„ Fish Audio å¯†é’¥ã€‚',
  'Fish Audio rejected this key.': 'Fish Audio æ‹’ç»äº†è¿™ä¸ªå¯†é’¥ã€‚',
  'Fish Audio refused the free model. It may have ended, or your account needs credit.':
    'Fish Audio æ‹’ç»äº†å…è´¹æ¨¡åž‹ã€‚å…è´¹æ¨¡åž‹å¯èƒ½å·²ç»“æŸï¼Œæˆ–ä½ çš„è´¦æˆ·éœ€è¦å……å€¼ã€‚',
  'Fish Audio is busy. Try again in a moment.': 'Fish Audio æ­£å¿™ï¼Œè¯·ç¨åŽå†è¯•ã€‚',
  'That voice was not found on Fish Audio.': 'åœ¨ Fish Audio ä¸Šæ‰¾ä¸åˆ°è¿™ä¸ªå£°éŸ³ã€‚',
  'That is not a Fish Audio voice link.': 'è¿™ä¸æ˜¯ Fish Audio çš„å£°éŸ³é“¾æŽ¥ã€‚',
  'Could not reach Fish Audio. Check your connection.': 'æ— æ³•è¿žæŽ¥ Fish Audioã€‚è¯·æ£€æŸ¥ç½‘ç»œã€‚',
  'Fish Audio voice': 'Fish Audio å£°éŸ³',
  'Automatic': 'è‡ªåŠ¨',
  'Preview': 'è¯•å¬',
  'Use automatic': 'æ”¹å›žè‡ªåŠ¨',
  'Paste a fish.audio voice link or id': 'ç²˜è´´ fish.audio å£°éŸ³é“¾æŽ¥æˆ– ID',
  'Fish Audio voice link': 'Fish Audio å£°éŸ³é“¾æŽ¥',
  'Use voice': 'ä½¿ç”¨æ­¤å£°éŸ³',
  'This voice plays without the pitch setting. It is saved right away.': 'è¿™ä¸ªå£°éŸ³ä¸ä½¿ç”¨éŸ³è°ƒè®¾ç½®ï¼Œé€‰æ‹©åŽç«‹å³ä¿å­˜ã€‚',
  'Sei picks a Fish Audio voice that matches this companion. Paste a voice link to choose your own.':
    'Sei ä¼šä¸ºè¿™ä½ä¼™ä¼´æŒ‘é€‰åŒ¹é…çš„ Fish Audio å£°éŸ³ã€‚ç²˜è´´å£°éŸ³é“¾æŽ¥å³å¯è‡ªå·±é€‰æ‹©ã€‚',
  'Their own Fish Audio voice plays without the pitch setting.': 'ä»–ä»¬è‡ªå·±çš„ Fish Audio å£°éŸ³ä¸ä½¿ç”¨éŸ³è°ƒè®¾ç½®ã€‚',
  'It is a {mb} MB download.': 'éœ€è¦ä¸‹è½½ {mb} MBã€‚',
  'Downloadingâ€¦ {pct}%': 'ä¸‹è½½ä¸­â€¦ {pct}%',
  'Ready': 'å·²å°±ç»ª',
  'Downloadâ€¦': 'ä¸‹è½½â€¦',
  'Uninstall': 'å¸è½½',
  'Voices that run on this device. Each companion speaks with the one matching their voice and chat language.':
    'åœ¨æœ¬æœºè¿è¡Œçš„è¯­éŸ³ã€‚æ¯ä½ä¼™ä¼´ä¼šä½¿ç”¨ä¸Žå…¶å£°éŸ³å’ŒèŠå¤©è¯­è¨€åŒ¹é…çš„é‚£ä¸€ä¸ªã€‚',
  'Download failed. Check your connection and try again.': 'ä¸‹è½½å¤±è´¥ã€‚è¯·æ£€æŸ¥ç½‘ç»œåŽé‡è¯•ã€‚',
  'Failed to uninstall. Try again.': 'å¸è½½å¤±è´¥ã€‚è¯·é‡è¯•ã€‚',
  // STT: SenseVoice row
  'SenseVoice': 'SenseVoice',
  'Downloading SenseVoiceâ€¦ {pct}%': 'æ­£åœ¨ä¸‹è½½ SenseVoiceâ€¦ {pct}%',
  'Offline. Runs on this device. Strongest for Chinese; English is weaker.':
    'ç¦»çº¿ï¼Œåœ¨æœ¬æœºè¿è¡Œã€‚ä¸­æ–‡è¯†åˆ«æ•ˆæžœæœ€å¥½ï¼Œè‹±æ–‡è¯†åˆ«ç›¸å¯¹è¾ƒå¼±ã€‚',
  // Shared download confirm (DownloadConfirmModal)
  'Download {name}?': 'ä¸‹è½½{name}ï¼Ÿ',
  'This is a one-time {mb} MB download. It is stored on this device and works offline.':
    'è¿™æ˜¯ä¸€æ¬¡æ€§ä¸‹è½½ï¼ˆ{mb} MBï¼‰ï¼Œä¿å­˜åœ¨æœ¬æœºï¼Œå¯ç¦»çº¿ä½¿ç”¨ã€‚',
  'Download ({mb} MB)': 'ä¸‹è½½ï¼ˆ{mb} MBï¼‰',
  // Edit companion voice section under local TTS
  'Local voices are on: Sei picks a local voice that matches this companion. Tune the pitch here. Their ElevenLabs voice is kept for when you switch back.':
    'æœ¬åœ°è¯­éŸ³å·²å¼€å¯ï¼šSei ä¼šä¸ºè¿™ä½ä¼™ä¼´æŒ‘é€‰åŒ¹é…çš„æœ¬åœ°è¯­éŸ³ï¼Œå¯ä»¥åœ¨è¿™é‡Œè°ƒæ•´éŸ³é«˜ã€‚å…¶ ElevenLabs å£°éŸ³ä¼šä¿ç•™ï¼Œåˆ‡æ¢å›žåŽ»æ—¶ç»§ç»­ä½¿ç”¨ã€‚',

  // W6 onboarding (china-compat)
  'Ollama runs on your computer and needs no API key.': 'Ollama åœ¨ä½ çš„ç”µè„‘ä¸Šè¿è¡Œï¼Œä¸éœ€è¦ API å¯†é’¥ã€‚',
  'Pick the model your companions will think with.': 'é€‰æ‹©ä¼™ä¼´ä»¬æ€è€ƒæ—¶ä½¿ç”¨çš„æ¨¡åž‹ã€‚',
  'Loading the model list...': 'æ­£åœ¨åŠ è½½æ¨¡åž‹åˆ—è¡¨â€¦â€¦',
  "Couldn't load the model list. Keep the suggested model or type a model id.":
    'æ— æ³•åŠ è½½æ¨¡åž‹åˆ—è¡¨ã€‚å¯ä»¥ä¿ç•™å»ºè®®çš„æ¨¡åž‹ï¼Œæˆ–æ‰‹åŠ¨è¾“å…¥æ¨¡åž‹ IDã€‚',
  'This model cannot see images. Screen sharing and Draw! need a vision model.':
    'è¿™ä¸ªæ¨¡åž‹çœ‹ä¸åˆ°å›¾ç‰‡ã€‚å±å¹•å…±äº«å’Œä½ ç”»æˆ‘çŒœéœ€è¦æ”¯æŒè§†è§‰çš„æ¨¡åž‹ã€‚',
  'Testing...': 'æµ‹è¯•ä¸­â€¦â€¦',
  'Testing... DeepSeek can take up to a minute to answer.': 'æµ‹è¯•ä¸­â€¦â€¦DeepSeek æœ€é•¿å¯èƒ½éœ€è¦ä¸€åˆ†é’Ÿæ‰å“åº”ã€‚',
  'Connection works ({seconds}s).': 'è¿žæŽ¥æ­£å¸¸ï¼ˆ{seconds} ç§’ï¼‰ã€‚',
  'No API key saved. Go back a step and paste your key.': 'è¿˜æ²¡æœ‰ä¿å­˜ API å¯†é’¥ã€‚è¯·è¿”å›žä¸Šä¸€æ­¥ç²˜è´´ä½ çš„å¯†é’¥ã€‚',
  'The provider rejected this API key.': 'æœåŠ¡å•†æ‹’ç»äº†è¿™ä¸ª API å¯†é’¥ã€‚',
  'The test timed out. Check your connection and try again.': 'æµ‹è¯•è¶…æ—¶äº†ã€‚è¯·æ£€æŸ¥ç½‘ç»œåŽå†è¯•ä¸€æ¬¡ã€‚',
  "Couldn't reach the provider. Check your connection.": 'æ— æ³•è¿žæŽ¥åˆ°æœåŠ¡å•†ã€‚è¯·æ£€æŸ¥ç½‘ç»œã€‚',
  'The test failed. Check the model name and your key.': 'æµ‹è¯•å¤±è´¥äº†ã€‚è¯·æ£€æŸ¥æ¨¡åž‹åç§°å’Œä½ çš„å¯†é’¥ã€‚',
  'Voice calls: how should companions hear you?': 'è¯­éŸ³é€šè¯ï¼šä¼™ä¼´è¦æ€Žä¹ˆå¬åˆ°ä½ è¯´è¯ï¼Ÿ',
  'ElevenLabs Scribe (your ElevenLabs key)': 'ElevenLabs Scribeï¼ˆç”¨ä½ çš„ ElevenLabs å¯†é’¥ï¼‰',
  'SenseVoice (best for Chinese)': 'SenseVoiceï¼ˆä¸­æ–‡æ•ˆæžœæœ€å¥½ï¼‰',
  'These options run on your computer. Whisper downloads itself on first use.':
    'è¿™äº›é€‰é¡¹åœ¨ä½ çš„ç”µè„‘ä¸Šè¿è¡Œã€‚Whisper ä¼šåœ¨é¦–æ¬¡ä½¿ç”¨æ—¶è‡ªåŠ¨ä¸‹è½½ã€‚',
  'Decide later': 'ä»¥åŽå†å†³å®š',
  'SenseVoice runs on your computer.': 'SenseVoice åœ¨ä½ çš„ç”µè„‘ä¸Šè¿è¡Œã€‚',
  'And how should companions speak?': 'é‚£ä¼™ä¼´è¦æ€Žä¹ˆè¯´è¯å‘¢ï¼Ÿ',
  'ElevenLabs voices (your ElevenLabs key)': 'ElevenLabs è¯­éŸ³ï¼ˆç”¨ä½ çš„ ElevenLabs å¯†é’¥ï¼‰',
  'Local voices': 'æœ¬åœ°è¯­éŸ³',
  'Local voices run on your computer.': 'æœ¬åœ°è¯­éŸ³åœ¨ä½ çš„ç”µè„‘ä¸Šè¿è¡Œã€‚',
  'Paste your ElevenLabs API key. It powers Scribe recognition and ElevenLabs voices.':
    'ç²˜è´´ä½ çš„ ElevenLabs API å¯†é’¥ã€‚å®ƒç”¨äºŽ Scribe è¯­éŸ³è¯†åˆ«å’Œ ElevenLabs è¯­éŸ³ã€‚',
  'ElevenLabs API key': 'ElevenLabs API å¯†é’¥',
  'Already downloaded. Continue': 'å·²ç»ä¸‹è½½å¥½äº†ã€‚ç»§ç»­',
  // Key-step probe (260817): Continue verifies the key before the wizard
  // moves on; a definite failure interrupts with Back / Continue anyway.
  'Checking your key...': 'æ­£åœ¨æ£€æŸ¥ä½ çš„å¯†é’¥â€¦â€¦',
  "Couldn't reach Ollama on your computer. Make sure Ollama is running.":
    'æ— æ³•è¿žæŽ¥åˆ°ä½ ç”µè„‘ä¸Šçš„ Ollamaã€‚è¯·ç¡®è®¤ Ollama æ­£åœ¨è¿è¡Œã€‚',
  'We will not be able to match you with a unique companion.':
    'æˆ‘ä»¬å°†æ— æ³•ä¸ºä½ åŒ¹é…ä¸€ä½ç‹¬ä¸€æ— äºŒçš„ä¼™ä¼´ã€‚',
  'We may not be able to match you with a unique companion.':
    'æˆ‘ä»¬å¯èƒ½æ— æ³•ä¸ºä½ åŒ¹é…ä¸€ä½ç‹¬ä¸€æ— äºŒçš„ä¼™ä¼´ã€‚',
  // 'Continue anyway' lives in modals.ts (shared).
  'Download? ({mb} MB)': 'ä¸‹è½½å—ï¼Ÿï¼ˆ{mb} MBï¼‰',
  'Downloading... {pct}%': 'ä¸‹è½½ä¸­â€¦â€¦{pct}%',
  // 'The download failed...' lives in common.ts (shared with the chess panel).
  'You can keep going; it finishes in the background.': 'å¯ä»¥ç»§ç»­ä¸‹ä¸€æ­¥ï¼Œä¸‹è½½ä¼šåœ¨åŽå°å®Œæˆã€‚',
  // 261120: Playtime > Sei > Voice > Advanced (Fish Audio on cloud).
  "Voice provider": "è¯­éŸ³æä¾›æ–¹",
  "[spoken with a Sei voice, add your Fish Audio key in Playtime]": "[å·²ç”¨ Sei å£°éŸ³æœ—è¯»ï¼Œè¯·åœ¨æ¸¸çŽ©æ—¶é•¿ä¸­æ·»åŠ ä½ çš„ Fish Audio å¯†é’¥]",
  "[spoken with a Sei voice, Fish Audio could not speak this line]": "[å·²ç”¨ Sei å£°éŸ³æœ—è¯»ï¼ŒFish Audio æœªèƒ½æœ—è¯»è¿™å¥è¯]",
  "[voice could not load, check your connection]": "[è¯­éŸ³åŠ è½½å¤±è´¥ï¼Œè¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥]",
  "[voice could not play this line]": "[è¯­éŸ³æ— æ³•æ’­æ”¾è¿™å¥è¯]",
  // 261122 checkout clarity
  "Couldn't open checkout": "æ— æ³•æ‰“å¼€ç»“è´¦é¡µé¢",
  "Nothing was charged. Check your connection and try again.": "æœªäº§ç”Ÿä»»ä½•æ‰£æ¬¾ã€‚è¯·æ£€æŸ¥ç½‘ç»œè¿žæŽ¥åŽé‡è¯•ã€‚",
  "Companion": "Companion",
  "Forza 4 is not available in this build yet.": "Forza 4 is not available in this build yet.",
  "The game couldn't start. Try again in a moment.": "The game couldn't start. Try again in a moment.",
  "Forza 4 with {name}": "Forza 4 with {name}",
  "Forza 4": "Forza 4",
  "Your side": "Your side",
  "Red": "Red",
  "Yellow": "Yellow",
  "Random": "Random",
  "Startingâ€¦": "Startingâ€¦",
  "Start": "Start",
  "Launch": "Launch",
  "Empty cell, row {r}, column {c}": "Empty cell, row {r}, column {c}",
  "Red piece": "Red piece",
  "Yellow piece": "Yellow piece",
  "It's your turn, {name}": "It's your turn, {name}",
  "{name}'s turn": "{name}'s turn",
  "Resign?": "Resign?",
  "Yes": "Yes",
  "No": "No",
  "Resign": "Resign",
  "Draw": "Draw",
  "You won": "You won",
  "{name} won": "{name} won",
  "Four in a row.": "Four in a row.",
  "The board is full.": "The board is full.",
  "This game ended without a result.": "This game ended without a result.",
  "Rematch": "Rematch",  "Battleship con {name}": "Battleship con {name}",
  "Battleship": "Battleship",
  "Battleship is not available in this build yet.": "Battleship is not available in this build yet.",
  "Your ships": "Your ships",
  "Enemy grid": "Enemy grid",
  "All ships sunk.": "All ships sunk.",

};




