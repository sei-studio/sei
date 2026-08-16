/** Shared/basic UI strings. See ../zh.ts for the dictionary rules. */
export const ZH_COMMON: Record<string, string> = {
  'Cancel': '取消',
  'Close': '关闭',
  'Confirm': '确认',
  'Continue': '继续',
  'Save': '保存',
  'Delete': '删除',
  'Back': '返回',
  'Next': '下一步',
  'Done': '完成',
  'OK': '好的',
  'Settings': '设置',
  'Retry': '重试',
  'Loading...': '加载中...',
  // Avatar overlay (260804): the Settings level control AND the profile tab.
  'Avatar': '虚拟形象',

  // W7 region gate (260816): shown by BOTH the onboarding AuthPanel and the
  // SignInModal (shared string, so it lives here per the zh.ts rule).
  'Our servers do not currently support your region. Please continue with local mode.':
    '我们的服务器暂不支持您所在的地区。请继续使用本地模式。',

  // Shared download-failure line (chess engine download + the W6 speech-pack
  // panels). Lives here per the zh.ts rule: later spreads win on duplicates,
  // so a shared key must not be declared per surface.
  'The download failed. Check your connection and try again.': '下载失败。请检查网络后重试。',

  // LLM provider labels (shared catalog PROVIDER_LABELS, rendered through
  // t() by ProviderSelect and the key prompts). Proper-noun labels fall
  // through to English; only the ones carrying a translatable word appear.
  'Ollama (local)': 'Ollama（本地）',
  'Qwen (Alibaba)': 'Qwen（阿里巴巴）',

  // Settings: Language section
  'Language': '语言',
  'App language': '应用语言',
  'About the app language': '关于应用语言',
  'Switches the whole app to this language. Companions you create while it is on speak it too.':
    '将整个应用切换到这种语言。开启后创建的伙伴也会说这种语言。',
};
