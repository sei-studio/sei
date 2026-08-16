/**
 * Simplified-Chinese dictionary, keyed by the exact English UI string.
 *
 * Rules:
 *  - Keys are the literal English strings passed to t(); a missing key just
 *    renders English, so never invent keys that no call site uses.
 *  - `{name}`-style placeholders must survive translation verbatim.
 *  - Chinese copy uses Chinese punctuation (，。！？「」), and the no-em-dash
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

export const ZH: Record<string, string> = {
  ...ZH_COMMON,
  ...ZH_SCREENS_A,
  ...ZH_SCREENS_B,
  ...ZH_ONBOARD,
  ...ZH_MODALS,
  ...ZH_CHATUI,
  ...ZH_GAMES,
  ...ZH_MISC,

  // W5 settings (china-compat)
  // Model picker + Test probe (SettingsScreen)
  'Model': '模型',
  'default': '默认',
  'Choose model': '选择模型',
  'Loading models…': '正在加载模型…',
  'no vision': '不支持图像',
  'No models listed.': '没有可列出的模型。',
  'Models marked "no vision" cannot see images. Screen sharing and Draw! need a model that can see images.':
    '标有「不支持图像」的模型无法识别图片。屏幕共享和 Draw! 需要能识别图片的模型。',
  'Connection': '连接',
  'Test': '测试',
  'Testing…': '测试中…',
  'Working. Replied in {s}s.': '正常。{s} 秒内回复。',
  'Testing your key and model. This can take up to a minute.':
    '正在测试你的密钥和模型，最长可能需要一分钟。',
  'Add your API key first.': '请先填写你的 API 密钥。',
  'The provider rejected your key. Check that it is correct and active.':
    '服务商拒绝了你的密钥。请确认密钥正确且有效。',
  'Timed out. Check your connection and try again.': '请求超时。请检查网络后重试。',
  'Could not reach the provider. Check your connection.': '无法连接到服务商。请检查网络。',
  'The provider returned an error (HTTP {status}).': '服务商返回了错误（HTTP {status}）。',
  'Something went wrong. Try again.': '出了点问题。请重试。',
  // Voice group: TTS engine + local voice packs
  'Voices': '语音',
  'About voice engines': '关于语音引擎',
  "What speaks your companions' lines on calls. ElevenLabs uses your own key. Local voices are free, run on this device, and work offline.":
    '通话时由谁来朗读伙伴的台词。ElevenLabs 使用你自己的密钥。本地语音免费，在本机运行，可离线使用。',
  'ElevenLabs': 'ElevenLabs',
  'Local (free)': '本地（免费）',
  'ElevenLabs voices need your own ElevenLabs API key. No key? Switch to the free local voices.':
    'ElevenLabs 语音需要你自己的 ElevenLabs API 密钥。没有密钥？可以切换到免费的本地语音。',
  'English voices, female and male': '英语语音，女声和男声',
  'Chinese voice, female': '中文语音，女声',
  'Chinese voice, male': '中文语音，男声',
  '(free)': '（免费）',
  'Downloading… {pct}%': '下载中… {pct}%',
  'Ready': '已就绪',
  'Download…': '下载…',
  'Free voices that run on this device. Each companion speaks with the one matching their voice and chat language.':
    '在本机运行的免费语音。每位伙伴会使用与其声音和聊天语言匹配的那一个。',
  'Download failed. Check your connection and try again.': '下载失败。请检查网络后重试。',
  'Failed to remove. Try again.': '移除失败。请重试。',
  // STT: SenseVoice row
  'SenseVoice': 'SenseVoice',
  'SenseVoice (free)': 'SenseVoice（免费）',
  'Downloading SenseVoice… {pct}%': '正在下载 SenseVoice… {pct}%',
  'Free and offline. Runs on this device. Strongest on Chinese and English.':
    '免费离线，在本机运行。中英文识别效果最好。',
  // Shared download confirm (DownloadConfirmModal)
  'Download {name}?': '下载{name}？',
  'This is a free, one-time {mb} MB download. It is stored on this device and works offline.':
    '这是一次性的免费下载（{mb} MB），保存在本机，可离线使用。',
  'Download ({mb} MB)': '下载（{mb} MB）',
  // Edit companion voice section under local TTS
  'Local voices are on: Sei picks a local voice that matches this companion. Tune the pitch here. Their ElevenLabs voice is kept for when you switch back.':
    '本地语音已开启：Sei 会为这位伙伴挑选匹配的本地语音，可以在这里调整音高。其 ElevenLabs 声音会保留，切换回去时继续使用。',

  // W6 onboarding (china-compat)
  'Ollama runs on your computer and needs no API key.': 'Ollama 在你的电脑上运行，不需要 API 密钥。',
  'Pick the model your companions will think with.': '选择伙伴们思考时使用的模型。',
  'Loading the model list...': '正在加载模型列表……',
  "Couldn't load the model list. Keep the suggested model or type a model id.":
    '无法加载模型列表。可以保留建议的模型，或手动输入模型 ID。',
  'This model cannot see images. Screen sharing and Draw! need a vision model.':
    '这个模型看不到图片。屏幕共享和你画我猜需要支持视觉的模型。',
  'Testing...': '测试中……',
  'Testing... DeepSeek can take up to a minute to answer.': '测试中……DeepSeek 最长可能需要一分钟才响应。',
  'Connection works ({seconds}s).': '连接正常（{seconds} 秒）。',
  'No API key saved. Go back a step and paste your key.': '还没有保存 API 密钥。请返回上一步粘贴你的密钥。',
  'The provider rejected this API key.': '服务商拒绝了这个 API 密钥。',
  'The test timed out. Check your connection and try again.': '测试超时了。请检查网络后再试一次。',
  "Couldn't reach the provider. Check your connection.": '无法连接到服务商。请检查网络。',
  'The test failed. Check the model name and your key.': '测试失败了。请检查模型名称和你的密钥。',
  'Voice calls: how should companions hear you?': '语音通话：伙伴要怎么听到你说话？',
  'ElevenLabs Scribe (your ElevenLabs key)': 'ElevenLabs Scribe（用你的 ElevenLabs 密钥）',
  'Whisper (free)': 'Whisper（免费）',
  'SenseVoice (free, best for Chinese)': 'SenseVoice（免费，中文效果最好）',
  'The free options run on your computer. Whisper downloads itself on first use.':
    '免费选项在你的电脑上运行。Whisper 会在首次使用时自动下载。',
  'Decide later': '以后再决定',
  'SenseVoice runs on your computer, free.': 'SenseVoice 在你的电脑上运行，免费。',
  'And how should companions speak?': '那伙伴要怎么说话呢？',
  'ElevenLabs voices (your ElevenLabs key)': 'ElevenLabs 语音（用你的 ElevenLabs 密钥）',
  'Local voices (free)': '本地语音（免费）',
  'Local voices run on your computer, free.': '本地语音在你的电脑上运行，免费。',
  'Paste your ElevenLabs API key. It powers Scribe recognition and ElevenLabs voices.':
    '粘贴你的 ElevenLabs API 密钥。它用于 Scribe 语音识别和 ElevenLabs 语音。',
  'ElevenLabs API key': 'ElevenLabs API 密钥',
  'Already downloaded. Continue': '已经下载好了。继续',
  'Download? ({mb} MB)': '下载吗？（{mb} MB）',
  'Downloading... {pct}%': '下载中……{pct}%',
  // 'The download failed...' lives in common.ts (shared with the chess panel).
  'You can keep going; it finishes in the background.': '可以继续下一步，下载会在后台完成。',
};
