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

  // W6 onboarding (china-compat)
  'Ollama runs on your computer and needs no API key.': 'Ollama 在你的电脑上运行，不需要 API 密钥。',
  'Pick the model your companions will think with.': '选择伙伴们思考时使用的模型。',
  'Loading the model list...': '正在加载模型列表……',
  'Model': '模型',
  "Couldn't load the model list. Keep the suggested model or type a model id.":
    '无法加载模型列表。可以保留建议的模型，或手动输入模型 ID。',
  'This model cannot see images. Screen sharing and Draw! need a vision model.':
    '这个模型看不到图片。屏幕共享和你画我猜需要支持视觉的模型。',
  'Test': '测试',
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
  'The download failed. Check your connection and try again.': '下载失败了。请检查网络后再试一次。',
  'You can keep going; it finishes in the background.': '可以继续下一步，下载会在后台完成。',
};
