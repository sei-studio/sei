/** Filled by the localization sweep. See ../zh.ts for the dictionary rules. */
export const ZH_MISC: Record<string, string> = {
  // ── lib/errors.ts (ERROR_COPY / WARN_COPY / fallback) ──────────────────
  "Couldn't finish joining your world in time. Press Summon to try again.":
    '未能及时加入你的世界。请再次点击召唤重试。',
  "We can't see an open LAN world. In Minecraft, press Esc, choose Open to LAN, then click Start LAN World.":
    '没有检测到开放的局域网世界。在 Minecraft 中按 Esc，选择「对局域网开放」，然后点击「创建局域网世界」。',
  'Your Anthropic API key was rejected. Open Settings → re-run onboarding to paste a fresh key.':
    '你的 Anthropic API 密钥被拒绝。请打开设置，重新运行引导流程并粘贴新的密钥。',
  'Anthropic is throttling requests. Wait a minute and try again.':
    'Anthropic 正在限流请求。请稍等一分钟再试。',
  'No internet connection. Reconnect and try again.': '没有网络连接。请重新联网后再试。',
  'Sei stopped unexpectedly. Press Summon to restart.': 'Sei 意外停止了。点击召唤以重新启动。',
  'LAN auto-detect is blocked on this network. Try a home Wi-Fi network.':
    '当前网络阻止了局域网自动发现。请尝试家用 Wi-Fi 网络。',
  "Couldn't read your saved API key from the system keychain. Re-run onboarding to re-save it.":
    '无法从系统钥匙串读取已保存的 API 密钥。请重新运行引导流程再次保存。',
  "Your system has no secret store. Sei will save your API key but it won't be hardware-protected.":
    '你的系统没有安全存储。Sei 会保存你的 API 密钥，但它不会受到硬件保护。',
  "A bundled module didn't load. Reinstall Sei from the .dmg / .exe.":
    '有一个内置模块加载失败。请通过 .dmg / .exe 重新安装 Sei。',
  "This world's Minecraft version is not supported yet. Open your world on a supported Java version and press Summon again.":
    '暂不支持这个世界的 Minecraft 版本。请用受支持的 Java 版打开你的世界，然后再次点击召唤。',
  "Couldn't download CustomSkinLoader. Check your connection and try the setup again.":
    '无法下载 CustomSkinLoader。请检查网络连接后重新运行设置。',
  "Couldn't install Fabric Loader. Make sure Minecraft is closed, then try the setup again.":
    '无法安装 Fabric Loader。请确认 Minecraft 已关闭，然后重新运行设置。',
  "We couldn't find any Minecraft installs. Install Minecraft, then re-run setup from Settings.":
    '没有找到任何 Minecraft 安装。请先安装 Minecraft，再从设置中重新运行设置向导。',
  "Couldn't look up that username on Mojang. Check the spelling and your connection.":
    '无法在 Mojang 查询该用户名。请检查拼写和网络连接。',
  "That doesn't look like a Minecraft skin PNG. Skins must be 64×64 pixels.":
    '这看起来不像 Minecraft 皮肤 PNG。皮肤必须是 64×64 像素。',
  "Sei couldn't reserve a local port for serving skins. Restart Sei and try again.":
    'Sei 无法保留用于提供皮肤的本地端口。请重启 Sei 后再试。',
  "Sei doesn't have permission to write to your Minecraft folder. Grant access and try again.":
    'Sei 没有写入你的 Minecraft 文件夹的权限。请授予访问权限后再试。',
  "You've used this week's credits. Upgrade or top up on the plan screen, or switch to your own API key in Settings.":
    '本周的额度已用完。你可以在方案页面升级或充值，或在设置中切换为自己的 API 密钥。',
  'Too many requests right now. Wait a little and try again.': '当前请求过多。请稍等片刻再试。',
  'Detected MC {version}. Sei needs MC 1.14 or newer. Pick a newer profile or switch to 1.21.x before continuing.':
    '检测到 MC {version}。Sei 需要 MC 1.14 或更新版本。请选择更新的配置，或切换到 1.21.x 后再继续。',
  "Couldn't read mod metadata, so this mod will be skipped. If it's actually compatible, copy it into <install>/sei/mods/ manually.":
    '无法读取模组元数据，此模组将被跳过。如果它其实兼容，请手动将其复制到 <install>/sei/mods/ 中。',
  'Something went wrong. {detail}Try again.': '出了点问题。{detail}请重试。',

  // ── lib/presence.ts ────────────────────────────────────────────────────
  'In your world': '在你的世界里',
  'Connecting…': '连接中…',
  'New': '新伙伴',
  'Online': '在线',
  'Idle': '空闲',

  // ── lib/actionVerb.ts ──────────────────────────────────────────────────
  'following you…': '正在跟着你…',
  'heading somewhere…': '正在赶路…',
  'exploring…': '正在探索…',
  'gathering {item}…': '正在收集{item}…',
  'gathering…': '正在收集…',
  'digging…': '正在挖掘…',
  'building…': '正在建造…',
  'building a shelter…': '正在搭建庇护所…',
  'placing blocks…': '正在放置方块…',
  'looking for {thing}…': '正在寻找{thing}…',
  'looking around…': '正在四处张望…',
  'gearing up…': '正在整理装备…',
  'having a snack…': '正在吃点东西…',
  'sleeping…': '正在睡觉…',
  'fighting {target}…': '正在与{target}战斗…',
  'fighting…': '正在战斗…',
  'crafting {item}…': '正在制作{item}…',
  'crafting…': '正在制作…',
  'smelting…': '正在熔炼…',
  'rummaging through chests…': '正在翻箱子…',
  'dropping items…': '正在丢弃物品…',
  'reading a sign…': '正在读告示牌…',
  'fiddling with something…': '正在摆弄东西…',
  'adventuring…': '正在冒险…',

  // ── stores (chess / draw / voice / wizard) ─────────────────────────────
  'Chess is not available in this build yet.': '当前版本还不支持国际象棋。',
  'Draw! is not available in this build yet.': '当前版本还不支持 Draw! 游戏。',
  'Sign in to use voice calls.': '请登录后使用语音通话。',
  "You've used this week's credits. Upgrade or top up to keep calling.":
    '本周额度已用完。升级或充值后才能继续通话。',
  "You've hit today's usage cap. It resets tomorrow.": '已达到今日使用上限。明天会自动重置。',
  'Voice service is not available right now.': '语音服务暂时不可用。',
  'This voice is not in your ElevenLabs library. Add it there, or pick a different voice.':
    '这个声音不在你的 ElevenLabs 声音库中。请先在那里添加它，或选择其他声音。',
  'No microphone was found. Connect one and try again.': '没有找到麦克风。请连接后重试。',
  'Microphone access is blocked by Windows. In Settings, open Privacy & security > Microphone, turn on microphone access and "Let desktop apps access your microphone", then try again.':
    '麦克风访问被 Windows 阻止。请在系统设置中打开「隐私和安全性 > 麦克风」，开启麦克风访问以及「允许桌面应用访问你的麦克风」，然后重试。',
  'Microphone access was blocked. Allow it and try again.': '麦克风访问被拒绝。请允许后重试。',
  'Voice call failed to start. Try again in a moment.': '语音通话启动失败。请稍后再试。',
  'Detection failed': '检测失败',
  'Install failed': '安装失败',

  // ── App.tsx banners ────────────────────────────────────────────────────
  'Verify your email to publish companions or buy credits. Check your inbox for a link from Sei.':
    '验证邮箱后才能发布伙伴或购买额度。请在收件箱中查找来自 Sei 的链接。',
  'Your system has no keyring, so Sei is storing your sign-in less securely. Install gnome-keyring or kwallet for full protection.':
    '你的系统没有密钥环，Sei 只能以较低的安全性保存你的登录信息。安装 gnome-keyring 或 kwallet 可获得完整保护。',

  // ── Image pickers (background / portrait) ──────────────────────────────
  'Pick an image file (PNG/JPG/WebP).': '请选择图片文件（PNG/JPG/WebP）。',
  'Failed to set the background.': '设置背景失败。',
  'Failed to remove the background.': '移除背景失败。',
  'Background preview': '背景预览',
  'None': '无',
  'NONE': '无',
  'Working…': '处理中…',
  'Change': '更换',
  'Upload': '上传',
  'Remove': '移除',
  'Could not decode the picked file as an image.': '无法将所选文件解码为图片。',
  'Could not encode the image.': '无法编码这张图片。',
  'Picture is too big (max 4096x4096).': '图片太大（最大 4096x4096）。',
  'File too large (max 4MB after resize).': '文件太大（缩放后最大 4MB）。',
  'File looks empty.': '文件似乎是空的。',
  'Only PNG, JPEG, or WebP images are accepted.': '只接受 PNG、JPEG 或 WebP 图片。',
  'Could not open that image.': '无法打开这张图片。',
  'Could not get this image under 500KB. Try a simpler picture.':
    '无法将这张图片压缩到 500KB 以内。请换一张更简单的图片。',
  'Failed to apply portrait.': '应用头像失败。',
  'Failed to remove portrait.': '移除头像失败。',
  'Change profile picture': '更换头像',
  'Add profile picture': '添加头像',
  'Card image preview': '卡片图片预览',
  'Picture is too big (max 1024×1024).': '图片太大（最大 1024×1024）。',
  'File too large (max 500KB after resize).': '文件太大（缩放后最大 500KB）。',

  // ── KnowledgeDropZone ──────────────────────────────────────────────────
  'Upload knowledge files': '上传知识文件',
  'Reading files…': '正在读取文件…',
  'Drop to upload': '松开即可上传',
  '.md, .txt, .text, .docx (max 512 KB each)': '.md、.txt、.text、.docx（每个最大 512 KB）',

  // ── FeedbackRewardCard ─────────────────────────────────────────────────
  'Daily feedback limit reached. Try again tomorrow.': '已达到今日反馈上限。请明天再试。',
  'Sign in to submit feedback.': '请登录后提交反馈。',
  'Feedback could not be sent. Check your connection and try again.':
    '反馈发送失败。请检查网络连接后重试。',
  "This week's credits are reset. Thank you for the feedback.":
    '本周额度已重置。感谢你的反馈。',
  'Feedback sent. The reward was already claimed on this account.':
    '反馈已发送。此账户已经领取过该奖励。',
  'What do you not like about Sei? As a thank you, your weekly usage limit will be reset immediately.':
    '你对 Sei 有什么不满意的地方？作为感谢，你的每周使用上限将立即重置。',
  'Tell us what to fix or improve': '告诉我们该修复或改进什么',
  'Feedback': '反馈',
  'Reply to my email': '回复到我的邮箱',
  'Sending…': '发送中…',
  'Submit and reset my credits': '提交并重置我的额度',

  // ── ProviderSelect ─────────────────────────────────────────────────────
  'Choose a model provider': '选择模型提供商',
  'Model provider': '模型提供商',

  // ── SkinEditor / SkinUploadZone / UsernameSearchField / SkinPreview3d ──
  'Letters, digits, and underscores only, max 16 characters.':
    '只能使用字母、数字和下划线，最多 16 个字符。',
  'Skin setup not complete': '皮肤设置尚未完成',
  'Your skin won’t show in Minecraft until you set up skins on this computer.':
    '在这台电脑上完成皮肤设置之前，皮肤不会在 Minecraft 中显示。',
  'Set up skins': '设置皮肤',
  'Edit skin': '编辑皮肤',
  'Skin & username': '皮肤与用户名',
  'In-game username': '游戏内用户名',
  'This is the name other players see above the bot. Any text works in offline LAN worlds.':
    '这是其他玩家在伙伴头顶看到的名字。离线局域网世界中任意文本都可以。',
  '{other} also joins as "{name}". In a world, two characters with the same in-game name share one inventory and location: connect one after the other and the second inherits the first\'s items and spot. Give one a different name to keep them separate.':
    '{other} 也会以「{name}」的名字加入。在同一个世界里，两个游戏内同名的角色会共享同一份背包和位置：先后连接时，后进入的会继承先进入者的物品和位置。请给其中一个改个名字以便区分。',
  'Skin source': '皮肤来源',
  'Upload PNG': '上传 PNG',
  'Search MC': '搜索 MC',
  'Applying...': '应用中...',
  'Apply skin': '应用皮肤',
  'Skin removed': '皮肤已移除',
  'Click again to remove': '再次点击以移除',
  'Remove skin': '移除皮肤',
  'Stop the bot before changing skin. Skin applies on next connect.':
    '更换皮肤前请先停止伙伴。皮肤将在下次连接时生效。',
  'Pick an upload or search a username first.': '请先上传皮肤或搜索一个用户名。',
  "Skin applied. It'll show up the next time the bot connects.":
    '皮肤已应用。伙伴下次连接时就会显示。',
  'Drop a 64x64 PNG here, or click to browse': '将 64x64 的 PNG 拖到这里，或点击浏览',
  'Files stay on your computer.': '文件只保存在你的电脑上。',
  'No Minecraft account named {name}. Check the spelling.':
    '没有名为 {name} 的 Minecraft 账户。请检查拼写。',
  'Mojang is rate-limiting lookups. Wait a minute and try again.':
    'Mojang 正在限制查询频率。请稍等一分钟再试。',
  "That doesn't look like a Minecraft username. Use letters, digits, and underscores only.":
    '这看起来不像 Minecraft 用户名。请只使用字母、数字和下划线。',
  "Couldn't reach Mojang. Check your connection and try again.":
    '无法连接 Mojang。请检查网络连接后重试。',
  'MOJANG USERNAME': 'MOJANG 用户名',
  'e.g. Notch': '例如 Notch',
  'Mojang username': 'Mojang 用户名',
  'Searching...': '搜索中...',
  'Look up': '查询',
  "Found {name}'s current skin.": '已找到 {name} 当前的皮肤。',
  'Loading preview...': '预览加载中...',
  '3D preview unavailable. Showing 2D thumbnail.': '3D 预览不可用。已显示 2D 缩略图。',
  "3D preview of {name}'s skin": '{name} 的皮肤 3D 预览',

  // ── VoicePicker ────────────────────────────────────────────────────────
  'Could not load the voice list.': '无法加载声音列表。',
  'Sample unavailable right now.': '示例暂时不可用。',
  'Stop {name} sample': '停止 {name} 的声音示例',
  'Play {name} sample': '播放 {name} 的声音示例',
  'Voice': '声音',
  'Auto: let Sei pick': '自动：让 Sei 挑选',
  'A voice that fits their personality, never one another companion already uses. Recommended.':
    '一个符合其个性的声音，绝不会与其他伙伴重复。推荐。',
  'No voice': '无声音',
  'A silent companion. They chat by text and stay quiet on voice calls.':
    '一个安静的伙伴。只用文字聊天，语音通话时保持沉默。',
  'Sign in to play the current voice sample. Picking a voice still works.':
    '登录后才能播放当前声音示例。选择声音不受影响。',
  'Current voice': '当前声音',
  'current voice': '当前声音',
  'Assigned from an earlier voice pool.': '来自较早的声音池。',
  'Voice group': '声音分组',
  'Feminine': '女性',
  'Masculine': '男性',
  'Neutral': '中性',
  'Tune the voice': '调整声音',
  'Pick a voice to tune it.': '先选择一个声音再进行调整。',
  'Sign in to hear tuned samples.': '登录后才能试听调整后的示例。',
  'Pitch': '音高',
  'Reset': '重置',
  'Higher or lower voice. Speaking pace stays the same.': '声音更高或更低。语速保持不变。',
  'Calmness': '平稳度',
  'Higher is steadier and more even. Lower is more dramatic.':
    '越高越平稳均匀，越低越富有戏剧性。',

  // ── Small components (BrowseCard, IdTag, InfoTip, chrome, buttons) ─────
  'Open {name}': '打开 {name}',
  'Public ID {id}': '公开 ID {id}',
  'Public ID · #{id}': '公开 ID · #{id}',
  'More info': '更多信息',
  'Expand {label}': '展开{label}',
  'Expand': '展开',
  'Minimize': '最小化',
  'Maximize': '最大化',
  'Restore': '还原',
  '{value} percent': '{value}%',
  'Sign in with Google': '使用 Google 登录',
  'Sign up with Google': '使用 Google 注册',
  'Continue with Google': '通过 Google 继续',
  'Companion': '伙伴',
  'You': '你',
};
