/** Filled by the localization sweep. See ../zh.ts for the dictionary rules. */
export const ZH_MODALS: Record<string, string> = {
  // ── AcceptToSModal ──
  'Review Sei’s Terms': '请查看 Sei 的条款',
  'We have published a Privacy Policy and Terms of Service. Please review and accept to continue.':
    '我们已发布隐私政策和服务条款。请查看并接受后继续。',
  'Open Terms of Service': '打开服务条款',
  'Open Privacy Policy': '打开隐私政策',
  'I have read and agree to both': '我已阅读并同意以上两项',
  'Accepting…': '接受中…',
  'Accept and continue': '接受并继续',

  // ── ApiKeySetupModal ──
  'Use your own API key': '使用你自己的 API 密钥',
  'Pick a provider and paste a key. Sei runs on your key instead of playtime.':
    '选择一个服务商并粘贴密钥。Sei 将使用你的密钥运行，而不消耗游玩时长。',
  'Paste your {provider} API key': '粘贴你的 {provider} API 密钥',
  'API key': 'API 密钥',
  'API key cannot be empty.': 'API 密钥不能为空。',
  "Couldn't save your key. Try again.": '密钥保存失败，请重试。',
  'Saving…': '保存中…',
  'Save & switch': '保存并切换',

  // ── BotCrashModal ──
  'Connection lost': '连接已断开',
  'Something went wrong and {name} disconnected. Sorry about that.':
    '出了点问题，{name} 已断开连接。非常抱歉。',
  'Crash reports are turned off, so nothing was sent. You can turn them on in Settings to help us fix issues like this.':
    '崩溃报告已关闭，因此未发送任何内容。你可以在设置中开启，帮助我们修复此类问题。',
  'A crash report was sent automatically and we will work on a fix. You can turn off crash reports in Settings.':
    '崩溃报告已自动发送，我们会尽快修复。你可以在设置中关闭崩溃报告。',
  'Summon again': '再次召唤',
  'Your companion': '你的伙伴',

  // ── CreationLimitModal ──
  'Daily limit reached': '已达今日上限',
  'You’ve reached your limit for companion creation today. Come back tomorrow.':
    '你今天创建伙伴的次数已达上限。明天再来吧。',
  'Resets {when}': '将于 {when} 重置',
  'Got it': '知道了',

  // ── CrossLaunchConfirmModal ──
  'Switch games': '切换游戏',
  '{from} is still running. End it and start {to}?':
    '{from} 仍在进行中。要结束它并开始 {to} 吗？',
  'End and start': '结束并开始',

  // ── DeleteAccountModal ──
  'Delete your Sei account?': '删除你的 Sei 账户？',
  'Cloud-side, this removes your companions, shared listings, credit ledger, and uploaded skin & portrait files within 30 days.':
    '云端方面，这将在 30 天内删除你的伙伴、共享列表、积分账本以及上传的皮肤和头像文件。',
  "Local-side, your companions on this machine, your bot's memory, and any cloud companions you've opened locally are untouched.":
    '本地方面，这台电脑上的伙伴、机器人的记忆，以及你在本地打开过的云端伙伴都不会受影响。',
  'To confirm, type {email} below.': '请在下方输入 {email} 以确认。',
  'Type {email} to confirm account deletion': '输入 {email} 以确认删除账户',
  "Couldn't reach the account-deletion service. Try again.":
    '无法连接账户删除服务，请重试。',
  "Couldn't delete the account. Try again.": '无法删除账户，请重试。',
  'Keep my account': '保留我的账户',
  'Deleting…': '删除中…',
  'Delete account': '删除账户',
  'Account scheduled for deletion. Signing you out…': '账户已安排删除。正在退出登录…',

  // ── DeleteConfirmModal / UnbindConfirmModal ──
  'Unbind {name}?': '解除与 {name} 的羁绊？',
  "This permanently removes their persona, description, and saved memory. You can't undo this.":
    '这将永久删除其人设、描述和已保存的记忆。此操作无法撤销。',
  'Unbind {name}': '解绑 {name}',
  '{name} will be released from your party. Their memories stay with them.':
    '{name} 将离开你的队伍。它们的记忆会随身保留。',

  // ── DmcaContactModal ──
  'DMCA Designated Agent': 'DMCA 指定代理人',
  'To report copyright infringement on a Sei companion, send a written DMCA notice to our designated agent at:':
    '如需举报 Sei 伙伴上的版权侵权行为，请向我们的指定代理人发送书面 DMCA 通知：',
  "Our agent's full statutory contact details (name, mailing address, phone) are published in the public US Copyright Office Designated Agent Directory and on our Terms of Service page.":
    '我们代理人的完整法定联系信息（姓名、邮寄地址、电话）已发布于美国版权局指定代理人公共目录以及我们的服务条款页面。',
  'Open USCO directory listing': '打开 USCO 目录条目',
  'Open Terms §7': '打开条款第 7 节',

  // ── EditCharacterModal ──
  'Edit companion': '编辑伙伴',
  'Basic': '基本',
  'Appearance': '外观',
  'Voice': '声音',
  'Persona': '人设',
  'Games': '游戏',
  'Danger': '危险操作',
  'Name': '名称',
  'Companion name': '伙伴名称',
  'Description': '描述',
  'For you and other players': '给你和其他玩家看的',
  'Card image': '卡片图片',
  'Skin': '皮肤',
  'Image and skin changes apply immediately.': '图片和皮肤的更改会立即生效。',
  'How they sound on voice calls. Changes save when you press Done.':
    '语音通话中的声音效果。按下完成后保存更改。',
  'Persona edit mode': '人设编辑模式',
  'Standard': '标准',
  'Advanced': '高级',
  'Regenerate or discard your changes first': '请先重新生成或放弃你的更改',
  'Switch to standard mode': '切换到标准模式',
  'Switching to Standard regenerates the persona from your source, discarding your manual prompt edits. This uses one generation.':
    '切换到标准模式会根据你的人设来源重新生成人设，并放弃你手动编辑的提示词。这会消耗一次生成次数。',
  'Keep editing': '继续编辑',
  'Regenerating…': '重新生成中…',
  'Regenerate & switch': '重新生成并切换',
  'Persona source': '人设来源',
  "A short description; the model expands it into the companion's voice and behavior.":
    '一段简短描述；模型会将其扩展为伙伴的语气和行为。',
  'Raw prompt': '原始提示词',
  'The exact prompt sent to the model each turn. Editing here overrides the standard framework (voice rules and all).':
    '每回合发送给模型的确切提示词。在此编辑会覆盖标准框架（包括语气规则等）。',
  'Copied': '已复制',
  'Copy': '复制',
  'Raw expanded prompt': '原始扩展提示词',
  'Chess': '国际象棋',
  'How {name} plays in the chess minigame. Left on auto, strength and style are decided from the persona the first time you play.':
    '{name} 在国际象棋小游戏中的棋风。保持自动时，棋力和风格会在你第一次对局时根据人设决定。',
  'Chess profile mode': '国际象棋配置模式',
  'Auto': '自动',
  'Custom': '自定义',
  'Strength: Elo {elo}': '棋力：Elo {elo}',
  '400 barely knows the rules; 900 casual; 1400 club player; 2000 fierce.':
    '400 勉强懂规则；900 休闲玩家；1400 俱乐部水平；2000 高手。',
  'Play style': '棋风',
  'Aggressive, loves flashy sacrifices, sulks when losing...':
    '激进，喜欢华丽的弃子战术，输棋时会闹脾气...',
  'Chess play style': '国际象棋棋风',
  "Reset wipes this companion's memory of you and starts fresh. Unbinding removes the companion permanently and cannot be undone.":
    '重置会清除这位伙伴对你的记忆并重新开始。解绑会永久移除该伙伴，且无法撤销。',
  'Memory reset': '记忆已重置',
  'Resetting…': '重置中…',
  'Reset memory': '重置记忆',
  'Unbind companion': '解绑伙伴',
  'Expanding persona: {label} · {pct}%': '人设扩展中：{label} · {pct}%',
  'Expanding persona: {label}, {pct} percent': '人设扩展中：{label}，{pct}%',
  'Starting': '开始中',
  'Unsaved persona changes. Open Persona to apply or discard.':
    '有未保存的人设更改。请打开人设页应用或放弃。',
  'Saved': '已保存',
  'Regenerate to apply, or discard.': '重新生成以应用，或放弃更改。',
  'Discard': '放弃',
  'Regenerate': '重新生成',
  'Save to apply, or discard.': '保存以应用，或放弃更改。',
  'Name cannot be empty.': '名称不能为空。',
  'Failed to save.': '保存失败。',
  'Failed to save image.': '图片保存失败。',
  'Failed to save voice settings.': '语音设置保存失败。',
  'Persona source cannot be empty.': '人设来源不能为空。',
  'Failed to regenerate.': '重新生成失败。',
  'Failed to delete. Try again.': '删除失败，请重试。',
  'Failed to reset memory.': '记忆重置失败。',

  // ── FactoryResetConfirmModal ──
  'Factory reset Sei?': '将 Sei 恢复出厂设置？',
  "This deletes everything Sei keeps on this device: every companion, their memories and chat history, your settings, your sign-in, and any saved API keys. Data stored in your cloud account is not touched. Sei will restart like a fresh install. This can't be undone.":
    '这将删除 Sei 在这台设备上保存的所有内容：所有伙伴及其记忆和聊天记录、你的设置、登录信息，以及已保存的 API 密钥。云端账户中的数据不受影响。Sei 将像全新安装一样重启。此操作无法撤销。',
  'Factory reset failed.': '恢复出厂设置失败。',
  'Erasing…': '清除中…',
  'Erase everything': '清除所有内容',

  // ── FeedbackModal ──
  'Submit feedback': '提交反馈',
  "Tell us anything you like or don't like! We read all comments within 24 hrs.":
    '告诉我们你喜欢或不喜欢的任何地方！我们会在 24 小时内阅读所有留言。',
  'Feedback': '反馈',
  'What should we improve?': '我们应该改进什么？',
  'Daily feedback limit reached. Try again tomorrow.': '已达每日反馈上限，请明天再试。',
  'Sign in to submit feedback.': '请登录后提交反馈。',
  'Feedback could not be sent. Check your connection and try again.':
    '反馈发送失败。请检查网络连接后重试。',
  'Feedback sent': '反馈已发送',
  'Thank you. We read all comments within 24 hrs.':
    '谢谢！我们会在 24 小时内阅读所有留言。',
  'Email (optional, leave blank to stay anonymous)': '邮箱（可选，留空则匿名）',
  'Email, optional': '邮箱（可选）',
  'Sending…': '发送中…',
  'Submit': '提交',

  // ── GamesPickerModal ──
  'Play together': '一起玩',
  'About {name}': '关于 {name}',
  'SOON': '敬请期待',
  'Suggest a game': '建议一个游戏',
  'Game': '游戏',
  'What game should we add?': '我们应该添加什么游戏？',

  // ── HardStopModal ──
  'Too many requests': '请求过于频繁',
  "Sei's servers are limiting requests right now, so your companion has to sit this one out. This does not use up any of your credits. You can try again after {when}.":
    'Sei 的服务器目前正在限制请求，你的伙伴只能先休息一下。这不会消耗你的任何积分。你可以在 {when} 之后重试。',
  "Sei's servers are limiting requests right now, so your companion has to sit this one out. This does not use up any of your credits. You can try again in a little while.":
    'Sei 的服务器目前正在限制请求，你的伙伴只能先休息一下。这不会消耗你的任何积分。请稍后再试。',
  'Usage limit reached': '已达使用上限',
  "You've used this week's allowance. It refreshes {when}. Upgrade for a bigger weekly allowance, or top up to keep playing now.":
    '你已用完本周额度。额度将于 {when} 刷新。升级可获得更高的每周额度，或充值以立即继续游玩。',
  "You've used this week's allowance. Upgrade for a bigger weekly allowance, or top up to keep playing now.":
    '你已用完本周额度。升级可获得更高的每周额度，或充值以立即继续游玩。',
  'Top up': '充值',
  'Upgrade': '升级',
  '{weekday} at {time}': '{weekday} {time}',

  // ── ImportLocalProfileModal ──
  'Bring your companion to this account?': '要把你的伙伴带到这个账户吗？',
  'You set up 1 companion before signing in. Bring it, along with your memories together, into this account, or start fresh.':
    '你在登录前已设置了 1 位伙伴。把它连同你们共同的回忆带进这个账户，或重新开始。',
  'You set up {count} companions before signing in. Bring them, along with your memories together, into this account, or start fresh.':
    '你在登录前已设置了 {count} 位伙伴。把它们连同你们共同的回忆带进这个账户，或重新开始。',
  'Bring your existing setup into this account, or start fresh.':
    '把你现有的设置带进这个账户，或重新开始。',
  'Importing…': '导入中…',
  'Start fresh': '重新开始',
  'Bring it over': '带过来',

  // ── KnowledgeModal / CompactKnowledgeModal ──
  "{name}'s knowledge": '{name} 的知识',
  'Knowledge': '知识',
  'You can manually add things for the AI to know here. The AI has a separate internal memory storage.':
    '你可以在这里手动添加想让 AI 知道的内容。AI 另有独立的内部记忆存储。',
  'No knowledge yet. Upload files or add text context.':
    '还没有知识。上传文件或添加文本内容。',
  'This entry could not be read.': '无法读取此条目。',
  'Edit {title}': '编辑 {title}',
  'Edit': '编辑',
  'Confirm delete {title}': '确认删除 {title}',
  'Delete {title}': '删除 {title}',
  'Click again to delete': '再次点击以删除',
  'Delete?': '删除？',
  ' · compacted': ' · 已压缩',
  ' · text': ' · 文本',
  '1 entry, {kb} KB total': '1 个条目，共 {kb} KB',
  '{count} entries, {kb} KB total': '{count} 个条目，共 {kb} KB',
  ' · large knowledge can slow down replies on calls and in games':
    ' · 知识内容过多可能拖慢通话和游戏中的回复',
  'Add text context': '添加文本内容',
  'Edit knowledge': '编辑知识',
  'Title': '标题',
  'Knowledge title': '知识标题',
  'Content': '内容',
  'Knowledge content': '知识内容',
  'Compact memory?': '压缩记忆？',
  "We detected a large amount of files ({kb} KB), which can slow down the AI's responses on calls and in games. We can compress them for you if you'd like.":
    '我们检测到较大的文件量（{kb} KB），这可能拖慢 AI 在通话和游戏中的回复。如果你愿意，我们可以为你压缩。',
  "Only Sei's copy is compressed. The original files on your computer are not changed.":
    '只会压缩 Sei 保存的副本。你电脑上的原始文件不会被更改。',
  'Keep files as they are': '保持文件原样',
  'Compress and create': '压缩并创建',

  // ── LanHostWarningModal ──
  'Vanilla Minecraft detected': '检测到原版 Minecraft',
  'Modded Minecraft detected': '检测到模组版 Minecraft',
  'Lunar Client detected': '检测到 Lunar 客户端',
  'Your world is hosted from Lunar Client. {name} can join and play normally, but Lunar does not load the skin mod, so {name} may appear with a default Minecraft skin.':
    '你的世界由 Lunar 客户端托管。{name} 可以正常加入并游玩，但 Lunar 不会加载皮肤模组，因此 {name} 可能会以默认 Minecraft 皮肤显示。',
  'To see custom skins, host the world from an install set up in skin setup (Settings).':
    '要显示自定义皮肤，请从皮肤设置（在设置中）配置过的安装启动并托管世界。',
  "Your world is running vanilla Minecraft without Sei's skin mod. {name} can join and play normally, but will appear with a default Minecraft skin.":
    '你的世界运行的是未安装 Sei 皮肤模组的原版 Minecraft。{name} 可以正常加入并游玩，但会以默认 Minecraft 皮肤显示。',
  'To see custom skins, run skin setup (Settings) and host the world from the Sei profile.':
    '要显示自定义皮肤，请运行皮肤设置（在设置中），并从 Sei 配置启动世界。',
  'Your world is running {loader} with {count} mods. {name} joins as a vanilla player: client-side mods like minimaps are fine, but mods that add new blocks or items may stop {name} from joining.':
    '你的世界运行的是 {loader}，共 {count} 个模组。{name} 会以原版玩家身份加入：小地图等客户端模组没有问题，但添加新方块或物品的模组可能会导致 {name} 无法加入。',
  'Your world is running {loader}. {name} joins as a vanilla player: client-side mods like minimaps are fine, but mods that add new blocks or items may stop {name} from joining.':
    '你的世界运行的是 {loader}。{name} 会以原版玩家身份加入：小地图等客户端模组没有问题，但添加新方块或物品的模组可能会导致 {name} 无法加入。',
  'a mod loader': '模组加载器',
  'If the join fails, try a world without server-side mods.':
    '如果加入失败，请尝试没有服务端模组的世界。',
  "Don't show this again": '不再显示',
  'Summon anyway': '仍然召唤',

  // ── LanNotOpenModal ──
  "Couldn't reach your world": '无法连接到你的世界',
  "{name} couldn't join because no open LAN world was found. To fix it:":
    '{name} 无法加入，因为没有找到已开放的局域网世界。解决方法：',
  'Open your world in Minecraft Java.': '在 Minecraft Java 版中打开你的世界。',
  'Press Esc and choose Open to LAN.': '按 Esc，选择「对局域网开放」。',
  'Click Start LAN World.': '点击「创建局域网世界」。',
  'Return to Sei and try the summon again.': '回到 Sei，再次尝试召唤。',
  'The world must be running on this computer or another computer on the same network. Once it is open to LAN, Sei finds it automatically.':
    '世界必须运行在这台电脑或同一网络中的另一台电脑上。开放到局域网后，Sei 会自动找到它。',
  'Try again': '再试一次',

  // ── McSetupModal ──
  'Minecraft setup': 'Minecraft 设置',
  'Minecraft setup topics': 'Minecraft 设置主题',
  'Connecting to world': '连接到世界',
  'Viewing AI skin': '查看 AI 皮肤',
  'Open world detected': '检测到已开放的世界',
  'Unavailable on this network': '此网络不可用',
  'No open world': '没有开放的世界',
  'Launch Minecraft and open your singleplayer world.': '启动 Minecraft，打开你的单人世界。',
  'Press ESC, then choose Open to LAN.': '按 ESC，选择「对局域网开放」。',
  'Return to Sei and press Launch.': '回到 Sei，按下启动。',
  'Searching for an open LAN world…': '正在搜索已开放的局域网世界…',
  'Companions have their own Minecraft skins, so they look right when they join your world. Seeing those skins in your game takes a quick one-time setup for your Minecraft install. You can also run it later from Settings under Custom skins.':
    '伙伴拥有自己的 Minecraft 皮肤，加入你的世界时才能显示正确的样子。要在游戏中看到这些皮肤，需要对你的 Minecraft 安装进行一次快速的一次性设置。你也可以稍后在设置的自定义皮肤中运行。',
  'Open skin setup': '打开皮肤设置',

  // ── MigrateLocalCharsModal ──
  'Upload local companions?': '上传本地伙伴？',
  'These companions are saved on this machine only. Upload any to your cloud party to use them on other devices.':
    '这些伙伴只保存在这台电脑上。上传到你的云端队伍后即可在其他设备上使用。',
  'Memory currently cannot be transferred to other devices.':
    '目前记忆无法转移到其他设备。',
  'Loading…': '加载中…',
  "Couldn't fetch your cloud party, so we can't tell which of these are already synced. Uploading is safe (duplicates are ignored), but some rows may already be in your cloud party.":
    '无法获取你的云端队伍，因此无法判断哪些已经同步。上传是安全的（重复项会被忽略），但其中一些可能已在你的云端队伍中。',
  'No local-only companions.': '没有仅限本地的伙伴。',
  'Maybe later': '以后再说',
  'Upload selected': '上传所选',
  'Uploading…': '上传中…',

  // ── NoticesInboxModal ──
  'Inbox': '收件箱',
  'No notices yet.': '暂无通知。',
  'Notices': '通知',
  'Unread': '未读',

  // ── OAuthInterstitialModal ──
  'Continue in your browser': '请在浏览器中继续',
  "We've opened a browser tab to finish signing in with Google. Come back when you're done; this window updates automatically.":
    '我们已打开一个浏览器标签页来完成 Google 登录。完成后回到这里，此窗口会自动更新。',
  'This will close on its own in {seconds}s.': '此窗口将在 {seconds} 秒后自动关闭。',
  'Cancel sign-in': '取消登录',
  'Signed in. One moment…': '已登录。请稍候…',
  "Sign-in didn't finish": '登录未完成',
  'Looks like the browser tab was closed. Try again, and finish the Google flow in the tab that opens.':
    '浏览器标签页似乎被关闭了。请重试，并在打开的标签页中完成 Google 登录流程。',
  "Couldn't reach Google": '无法连接 Google',
  "Sei couldn't connect to Google's sign-in. Check your internet and try again.":
    'Sei 无法连接 Google 登录服务。请检查网络后重试。',
  'That took a little too long': '耗时有点太久了',
  'The sign-in link expired. Try again; it stays valid for about a minute.':
    '登录链接已过期。请重试；链接有效期约为一分钟。',
  'Google declined the sign-in': 'Google 拒绝了此次登录',
  "Google didn't approve the sign-in. You can try again or use email and password instead.":
    'Google 未批准此次登录。你可以重试，或改用邮箱和密码。',
  "Couldn't open the sign-in helper": '无法启动登录辅助程序',
  'Something else on your machine is using the port Sei needs. Close it and try again, or use email and password.':
    '你电脑上的其他程序占用了 Sei 需要的端口。请关闭它后重试，或改用邮箱和密码。',
  'Sign-in hit a snag': '登录遇到了点问题',
  "Sei finished the Google step but couldn't set up your session. Try again; this usually works on the second attempt.":
    'Sei 已完成 Google 步骤，但无法建立你的会话。请重试；通常第二次尝试就会成功。',
  'Cancelled': '已取消',
  'Sign-in cancelled.': '登录已取消。',

  // ── OfflineRetryModal ──
  "You're offline": '你已离线',
  'Sei couldn’t reach the cloud to check your account. You can keep playing locally — cloud features like character sync will reconnect once you’re back online.':
    'Sei 无法连接云端以检查你的账户。你可以继续在本地游玩，等你重新联网后，角色同步等云端功能会自动重连。',
  'Still can’t connect. Check your internet connection and try again.':
    '仍然无法连接。请检查网络连接后重试。',
  'Continue offline': '离线继续',
  'Retrying…': '重试中…',

  // ── PortraitCropModal ──
  'Crop your image': '裁剪你的图片',
  'Drag to reposition. Scroll or use the slider to zoom.':
    '拖动以调整位置。滚动或使用滑块进行缩放。',
  'Zoom': '缩放',
  'Working…': '处理中…',
  'Use photo': '使用照片',

  // ── ReportCompanionModal ──
  'Sexual content involving minors': '涉及未成年人的色情内容',
  'Sexual or explicit content': '色情或露骨内容',
  'Hate or harassment': '仇恨或骚扰',
  'Violence or self harm': '暴力或自残',
  'Copyright infringement': '版权侵权',
  'Impersonation': '冒充他人',
  'Spam or misleading': '垃圾信息或误导内容',
  'Other': '其他',
  'Daily report limit reached. Try again tomorrow.': '已达每日举报上限，请明天再试。',
  'Sign in to report a companion.': '请登录后举报伙伴。',
  'Report could not be sent. Check your connection and try again.':
    '举报发送失败。请检查网络连接后重试。',
  'Report sent': '举报已发送',
  'Thank you. We review reports within 24 hours and remove companions that break the rules.':
    '谢谢！我们会在 24 小时内审核举报，并移除违反规则的伙伴。',
  'Report {name}': '举报 {name}',
  'What is wrong with this companion? Select all that apply.':
    '这位伙伴有什么问题？请选择所有适用项。',
  'Details (required for Other)': '详情（选择「其他」时必填）',
  'Details (optional)': '详情（可选）',
  'Anything that helps us review faster': '任何有助于我们更快审核的信息',
  'Report details': '举报详情',
  'Submit report': '提交举报',

  // ── ResetAllMemoriesConfirmModal / ResetMemoryConfirmModal ──
  'Reset all companion memories?': '重置所有伙伴的记忆？',
  'This permanently wipes saved chat history and playtime for 1 companion on this device. Persona, portrait, and skin are kept. This can’t be undone.':
    '这将永久清除这台设备上 1 位伙伴已保存的聊天记录和游玩时长。人设、头像和皮肤会保留。此操作无法撤销。',
  'This permanently wipes saved chat history and playtime for all {count} companions on this device. Persona, portrait, and skin are kept. This can’t be undone.':
    '这将永久清除这台设备上全部 {count} 位伙伴已保存的聊天记录和游玩时长。人设、头像和皮肤会保留。此操作无法撤销。',
  'Reset all memories': '重置所有记忆',
  "Reset {name}'s memory?": '重置 {name} 的记忆？',
  'This will reset everything this companion remembers about you, including your chat history. It will not reset their in-game inventory and location within a world. Please reset manually or create a new world to start fresh.':
    '这将重置这位伙伴关于你的所有记忆，包括聊天记录。但不会重置它在世界中的游戏物品栏和位置。请手动重置，或创建一个新世界重新开始。',

  // ── SetNewPasswordModal ──
  'Password updated': '密码已更新',
  "You can sign in with your new password next time. You're all set for now.":
    '下次可以用新密码登录。现在一切就绪。',
  'Back to Sei': '返回 Sei',
  'Choose a new password': '设置新密码',
  'Enter a new password for your Sei account. At least {min} characters.':
    '为你的 Sei 账户输入新密码。至少 {min} 个字符。',
  'New password': '新密码',
  'At least {min} characters': '至少 {min} 个字符',
  'Confirm password': '确认密码',
  'Re-enter your new password': '再次输入新密码',
  'Password must be at least {min} characters.': '密码长度至少为 {min} 个字符。',
  "Those passwords don't match.": '两次输入的密码不一致。',
  'Save new password': '保存新密码',

  // ── SetupWizardModal ──
  'Set up Minecraft skins': '设置 Minecraft 皮肤',
  'Back to settings': '返回设置',
  'Set up later': '以后再设置',
  'Begin': '开始',
  "Sei can give each companion a custom skin and username inside your Minecraft world. We'll install a small mod (CustomSkinLoader) into your Minecraft profile. Takes about a minute.":
    'Sei 可以让每位伙伴在你的 Minecraft 世界中拥有自定义皮肤和用户名。我们会向你的 Minecraft 配置安装一个小模组（CustomSkinLoader）。大约需要一分钟。',
  'Looking for Minecraft installs': '正在查找 Minecraft 安装',
  'Scanning your Minecraft launcher and CurseForge instances. This stays on your computer.':
    '正在扫描你的 Minecraft 启动器和 CurseForge 实例。这些操作只在你的电脑上进行。',
  "We couldn't find Minecraft": '没有找到 Minecraft',
  'Open settings': '打开设置',
  "Sei looked in the usual places and didn't find a Minecraft install. Install Minecraft from minecraft.net or the CurseForge app, then re-run this wizard from Settings.":
    'Sei 在常见位置查找后没有发现 Minecraft 安装。请从 minecraft.net 或 CurseForge 应用安装 Minecraft，然后从设置中重新运行此向导。',
  'Pick which installs to enable': '选择要启用的安装',
  'Sei will install Fabric Loader and CustomSkinLoader into each install you select. Already-modded CurseForge instances get only the mod jar.':
    'Sei 会向你选择的每个安装中安装 Fabric Loader 和 CustomSkinLoader。已装模组的 CurseForge 实例只会安装模组 jar。',
  'Setting up your installs': '正在设置你的安装',
  "Downloading Fabric Loader and CustomSkinLoader. Don't close Minecraft if it's open.":
    '正在下载 Fabric Loader 和 CustomSkinLoader。如果 Minecraft 已打开，请不要关闭它。',
  "One install couldn't finish": '有一个安装未能完成',
  'Continue anyway': '仍然继续',
  '{name} hit an error: {message}. The other installs are ready. You can re-run setup for this one later from Settings.':
    '{name} 遇到错误：{message}。其他安装已就绪。你可以稍后从设置中为它重新运行设置。',
  'One install': '一个安装',
  'an unknown error': '未知错误',
  'Setup finished with issues': '设置完成，但有问题',
  'All set': '一切就绪',
  'Finish setup': '完成设置',
  'Some installs skipped': '部分安装已跳过',
  "Some installs didn't finish, but the rest are ready. Open Minecraft, pick the {profile} profile from the launcher dropdown, and start your world. You can re-run setup for the others from Settings.":
    '部分安装未完成，但其余已就绪。打开 Minecraft，从启动器下拉菜单中选择 {profile} 配置并进入你的世界。你可以从设置中为其余安装重新运行设置。',
  'Open Minecraft, pick the {profile} profile from the launcher dropdown, and start your world. Companions will appear with their chosen skin and username.':
    '打开 Minecraft，从启动器下拉菜单中选择 {profile} 配置并进入你的世界。伙伴会以他们选择的皮肤和用户名出现。',
  'Linked 1 mod.': '已关联 1 个模组。',
  'Linked {count} mods.': '已关联 {count} 个模组。',
  'Linked 1 mod, excluded {excluded} (wrong MC version or unreadable metadata).':
    '已关联 1 个模组，排除 {excluded} 个（MC 版本不符或元数据不可读）。',
  'Linked {count} mods, excluded {excluded} (wrong MC version or unreadable metadata).':
    '已关联 {count} 个模组，排除 {excluded} 个（MC 版本不符或元数据不可读）。',
  'Show excluded mods': '显示被排除的模组',
  'targets MC {version}': '目标 MC 版本为 {version}',
  'wrong MC version': 'MC 版本不符',
  'metadata unreadable': '元数据不可读',
  'no mod metadata': '没有模组元数据',
  'read error': '读取错误',

  // ── SignInModal ──
  'Sign in to Sei': '登录 Sei',
  'Create your Sei account': '创建你的 Sei 账户',
  'Signing in…': '登录中…',
  'Creating account…': '创建账户中…',
  'Sign In': '登录',
  'Create Account': '创建账户',
  'New here? Create an account': '新用户？创建账户',
  'Already have an account? Sign in': '已有账户？登录',
  "That doesn't look like a valid email address.": '这看起来不是有效的邮箱地址。',
  'Enter your email above, then tap "Forgot your password?"':
    '请先在上方输入邮箱，再点击「忘记密码？」',
  'Check your email': '查看你的邮箱',
  'We sent a verification link to {email}. Open it on this device to finish signing in.':
    '我们已向 {email} 发送验证链接。请在这台设备上打开它以完成登录。',
  'You can close this window. Once you click the link, Sei signs you in automatically.':
    '你可以关闭此窗口。点击链接后，Sei 会自动为你登录。',
  "If an account exists for {email}, we've sent a password reset link. Open it on this device to choose a new password.":
    '如果 {email} 对应的账户存在，我们已发送密码重置链接。请在这台设备上打开它以设置新密码。',
  'You can close this window. Once you click the link, Sei prompts you for a new password.':
    '你可以关闭此窗口。点击链接后，Sei 会提示你设置新密码。',
  'Sign in to {action}': '登录以{action}',
  'Email': '邮箱',
  'Password': '密码',
  'At least 8 characters': '至少 8 个字符',
  'Date of birth': '出生日期',
  'Month of birth': '出生月份',
  'Day of birth': '出生日',
  'Year of birth': '出生年份',
  'Month': '月',
  'Day': '日',
  'Year': '年',
  'I agree to the Terms of Service and Privacy Policy': '我同意服务条款和隐私政策',
  'I agree to the {tos} and {privacy}': '我同意{tos}和{privacy}',
  'Terms of Service': '服务条款',
  'Privacy Policy': '隐私政策',
  'Forgot your password?': '忘记密码？',
  'or': '或',
  'Sign up with Google': '使用 Google 注册',
  'Sign in with Google': '使用 Google 登录',

  // ── SignOutConfirmModal ──
  'Sign out will stop your bot. Continue?': '退出登录将停止你的机器人。要继续吗？',
  'Sign out?': '退出登录？',
  'Signing out…': '正在退出…',
  'Sign out': '退出登录',
  'Your local characters, memory, and saved API key stay on this machine.':
    '你的本地角色、记忆和已保存的 API 密钥都会留在这台电脑上。',
  'Stay signed in': '保持登录',

  // ── SummonConflictModal ──
  'Name already in use': '名称已被占用',
  "{attempted} wants to join as {username}, but {conflict} is already in the world under that name. Minecraft won't let two players share a username.":
    '{attempted} 想以 {username} 的身份加入，但 {conflict} 已经以这个名字在世界中了。Minecraft 不允许两名玩家共用同一个用户名。',
  'Give one of them a different in-game username (on its companion page, under Skin) and try again.':
    '请给其中一位换一个游戏内用户名（在其伙伴页面的皮肤栏下），然后重试。',

  // ── SwitchBackendConfirmModal ──
  'Switch to managed billing?': '切换到托管计费？',
  'Switch to your own API key?': '切换到你自己的 API 密钥？',
  'Sei will stop using your local API key and route through our managed cloud, billed to your subscription or credits. This applies to a running bot right away. You can switch back any time.':
    'Sei 将停止使用你本地的 API 密钥，改为通过我们的托管云服务运行，费用计入你的订阅或积分。正在运行的机器人会立即生效。你可以随时切换回来。',
  'Sei will stop using managed cloud credits and route through the API key stored on this device. This applies to a running bot right away. Your subscription keeps renewing until you cancel it.':
    'Sei 将停止使用托管云积分，改为使用这台设备上保存的 API 密钥。正在运行的机器人会立即生效。你的订阅在取消前会继续续费。',
  'Switching…': '切换中…',
  'Switch to cloud': '切换到云端',
  'Switch to my key': '切换到我的密钥',

  // ── TopUpModal ──
  'Buy extra credits': '购买额外积分',
  'Extra credits do not expire and do not reset. Your companions use your weekly allowance first, then these.':
    '额外积分不会过期也不会重置。你的伙伴会先使用每周额度，然后再使用这些积分。',
  'Buy': '购买',

  // ── UnsupportedVersionModal ──
  'Minecraft version not supported': '不支持的 Minecraft 版本',
  "{name} couldn't join.": '{name} 无法加入。',
  'To switch to a supported version:': '切换到受支持版本的方法：',
  'This world is running Minecraft {version}, which is not supported yet. Sei supports Java versions up to {latest}.':
    '这个世界运行的是 Minecraft {version}，暂不支持。Sei 支持的 Java 版本最高为 {latest}。',
  'This world runs a Minecraft version that is not supported yet. Sei supports Java versions up to {latest}.':
    '这个世界运行的 Minecraft 版本暂不支持。Sei 支持的 Java 版本最高为 {latest}。',
  'Open the Minecraft launcher and go to the Installations tab.':
    '打开 Minecraft 启动器，进入「安装」选项卡。',
  'Create or select an installation on {version} or another supported version.':
    '创建或选择 {version} 或其他受支持版本的安装。',
  'Open your world from that installation.': '从该安装打开你的世界。',
  'Alternatively, run the skin setup in Sei settings. It installs our modded Fabric version of Minecraft, which is supported and shows character skins.':
    '或者，在 Sei 设置中运行皮肤设置。它会安装我们的 Fabric 模组版 Minecraft，该版本受支持并能显示角色皮肤。',
  'Minecraft may not open worlds saved on a newer version. If your world will not open, create a new world on the supported version and play there.':
    'Minecraft 可能无法打开在更新版本中保存的世界。如果你的世界无法打开，请在受支持的版本上创建一个新世界游玩。',

  // ── UpdatePopup ──
  'Update': '更新',
  'Update available': '有可用更新',
  'Sei {latest} is ready. You’re on {current}.':
    'Sei {latest} 已就绪。你当前的版本是 {current}。',
  'Later': '以后再说',
  'Update now': '立即更新',
  'Downloading update…': '正在后台下载更新…',
  'Downloading update, {percent} percent': '正在下载更新，{percent}%',
  'Update ready': '更新已就绪',
  'Restart Sei to apply it.': '重启 Sei 即可应用。',
  'Restart now': '立即重启',
  'Applying the update. Sei will restart in a moment…':
    '正在应用更新。Sei 稍后将重启…',
  'What’s new in {version}': '{version} 版本更新内容',
};
