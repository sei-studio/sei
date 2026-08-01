/**
 * Onboarding + tutorial dictionary (OnboardApp.tsx, TutorialOverlay.tsx).
 * Keys are the exact English strings passed to t()/useT(); {name}-style
 * placeholders survive verbatim. Sui's lines are voiced (playful, warm),
 * not literal. No em dashes in any value; Chinese punctuation throughout.
 */
export const ZH_ONBOARD: Record<string, string> = {
  /* ── Sui's script ─────────────────────────────────────────────────────
     Register (260730): natural spoken Chinese, playful and a little cutesy,
     the way Sui actually talks. No tech vocabulary a non-technical player
     would never say: "终端" is out, the thing she runs is just "系统". */
  "Hey. I'm Sui!": '嗨嗨！我是 Sui！',
  'I run this place. The Sei terminal, I mean.': '这地方归我管哦。就是这个 Sei 系统啦。',
  'Hmmmm... Are you new here?': '嗯……你是新来的吗？',
  "Ah, welcome back. I'm not needed here then. Back to gaming I go!":
    '啊，欢迎回来～那就没我什么事啦，我打游戏去咯！',
  "So! My name's Sui. What do I call you?": '好啦！我叫 Sui。你呢？我该怎么叫你呀？',
  'I see I see... {name}!': '哦哦，原来如此原来如此……{name}！',
  'So, {name}, my job here is to help you meet other AI friends from my world.':
    '那个呢，{name}，我的任务就是带你认识我们世界里的其他 AI 朋友！',
  'Aww, really? I was going to find a companion just for you. You wanna skip it?':
    '诶，真的吗？我本来还想给你找一位只属于你的伙伴呢。真的要跳过吗？',
  'The terminal says I need five quick answers from you. It uses them to pick who you meet first, so be honest with me okay?':
    '系统说要先问你五个小问题，看看你最先遇到谁最合适。要跟我说实话哦？',
  'First! What kind of people do you like having around? Pick as many as you want. Order matters.':
    '第一题！你喜欢身边有什么样的人？想选几个都行，先选的更重要哦。',
  "Oooh, noted. Second, we AI can live for a very long time. Which age range best fits what you're looking for?":
    '哦哦，记下啦。第二题，我们 AI 可是能活很久很久的。你想找的伙伴，大概多大合适呀？',
  'Ok, um, fourth. Take a look at these portraits. Which one do you like the most?':
    '好，呃，第四题。看看这几张画像，你最喜欢哪一张？',
  'Last one! Let me pull up the options... which do you prefer?':
    '最后一题！我把选项翻出来哈……你更喜欢哪一种？',
  "Aaaand we're done! By the way, you can always change these later in the app.":
    '好～全部答完啦！对了，这些以后随时都能改的。',
  'AHHHHH!': '啊啊啊啊啊！',
  "I SKIPPED THE THIRD QUESTION! You still need to sign in! Ok, I'll go set things up for you while you do that.":
    '我把第三题跳过去了！！对了你还得登录呢！好叭，你先登录，我去把东西都给你准备好。',
  'Welcome back! Everything is in place. You ready?': '欢迎回来！都弄好啦。准备好了吗？',
  "Welcome back! Everything is all set, and someone's waiting to meet you. You ready?":
    '欢迎回来！都安排好啦，还有一位正等着见你呢。准备好了吗？',

  /* ── "Update my preferences", asked by Sui (SuiPrefsScene, 260731) ────
     The straight version of the first-run questions: no five-questions gag,
     no skipped third. qDyn's wording is shared with the first-run script
     above, so it needs no entry of its own. */
  'Welcome back! So you want to update your preferences!': '欢迎回来！你想改一下你的偏好，对吧！',
  "Got it. Second! We AI can live for a very long time. Which age range best fits what you're looking for?":
    '记下啦。第二题！我们 AI 可是能活很久很久的。你想找的伙伴，大概多大合适呀？',
  'I see! Finally, take a look at these portraits. Which one do you like the most?':
    '原来如此！最后一题，看看这几张画像，你最喜欢哪一张？',
  "I've saved your preferences. Come back anytime!": '你的偏好我记好啦。随时再来找我哦！',
  'See you': '再见啦',

  /* ── "Meet my companion", run by Sui (SuiMeetScene, 260731) ──────────── */
  'So! Are you ready to meet your first companion?': '好！你准备好认识你的第一位伙伴了吗？',
  'So! Are you ready to meet your second companion?': '好！你准备好认识你的第二位伙伴了吗？',
  'So! Are you ready to meet your third companion?': '好！你准备好认识你的第三位伙伴了吗？',
  'So! Are you ready to meet your final companion?': '好！你准备好认识你最后一位伙伴了吗？',
  "I'm ready": '我准备好啦',
  'Not yet': '还没有',
  'I have three companions who are ready to be awakened! Which one would you like to meet?':
    '我这里有三位随时可以唤醒的伙伴！你想见哪一位呀？',
  'Got it. Let me go get them!': '好嘞。我这就去把 TA 带来！',
  'Finding someone for you…': '正在为你寻找合适的人……',
  'Seeing their face…': '正在看清 TA 的样子……',
  "Sorting out what they'll wear…": '正在准备 TA 的装扮……',
  'Hearing their story…': '正在听 TA 讲自己的故事……',
  'Bringing them over…': '正在把 TA 带过来……',
  'Sign in to continue': '请先登录',
  'Meeting a unique companion needs a Sei account. Sign in and try again.':
    '要认识专属伙伴需要一个 Sei 账号。请登录后重试。',
  'Your slots are full': '你的位置已经满啦',
  'Free up one of your companion slots, then cast again.': '先腾出一个伙伴位置，再来唤醒吧。',
  'That’s enough casting for today': '今天就唤醒到这里吧',
  'You’ve reached today’s limit. Come back tomorrow to meet someone new.':
    '今天的次数用完啦。明天再来认识新伙伴吧。',
  'The cast didn’t take': '这次唤醒没成功',
  'Something went wrong weaving your companion. Let’s try once more.':
    '编织你的伙伴时出了点问题。我们再试一次吧。',
  'Couldn’t reach the aether': '连不上服务器',
  'Check your connection and try the ritual again.': '检查一下网络，然后再试一次。',
  'Image generation failed. Continuing without a portrait.': '画像生成失败，先不带画像继续。',
  'Skin generation failed. Continuing with the default skin.': '皮肤生成失败，先使用默认皮肤继续。',

  /* ── Questionnaire chips ──────────────────────────────────────────── */
  'A partner in crime': '一起闯祸的搭档',
  'Someone to look after me': '会照顾我的人',
  'Someone to look after': '让我来照顾的人',
  'A chill friend': '轻松自在的朋友',
  'Someone who pushes me': '会督促我进步的人',
  'Young adult': '青年',
  Adult: '成年',
  Mature: '成熟',
  Elder: '年长',
  Timeless: '超越年龄',
  'Round chibi': '圆润 Q 版',
  Anime: '动漫',
  'Cel-shaded': '赛璐璐风',
  Cartoon: '卡通',
  Feminine: '女性化',
  Masculine: '男性化',
  Nonbinary: '非二元',

  /* ── Dialogue controls ────────────────────────────────────────────── */
  // 'Yes'/'No' (the newQ choices since 260730) live in games.ts ('是'/'否'),
  // which is spread later and would win over any entry here anyway.
  Back: '返回',
  'Your name': '你的名字',
  'Sounds fun': '听起来不错',
  'Not interested': '不感兴趣',
  Skip: '跳过',
  Nevermind: '当我没说',
  'Surprise me': '给我个惊喜',
  Done: '完成',
  "Let's go": '出发！',
  'or {enter} to continue': '或按 {enter} 继续',
  'Quit Sei': '退出 Sei',
  'Mute voice': '静音',
  'Unmute voice': '取消静音',
  'Voice volume': '音量',
  Click: '点击',
  'Try again': '重试',
  'Setting up...': '正在设置……',
  'Welcome back! You already have an account with this login. Signing you in...':
    '欢迎回来！这个登录方式已经有账号了。正在为你登录……',
  'Something went wrong.': '出了点问题。',

  /* ── Sign-in / sign-up panel ──────────────────────────────────────── */
  Email: '邮箱',
  Password: '密码',
  'Forgot password?': '忘记密码？',
  'Enter your email above first.': '请先在上面填写你的邮箱。',
  'Reset link sent. Check your email.': '重置链接已发送，请查收邮件。',
  "Couldn't send the reset link. Try again in a moment.": '重置链接发送失败，请稍后再试。',
  'Check your email to confirm your account. This continues on its own once you do.':
    '请查收邮件确认你的账号。确认之后，这里会自动继续。',
  'Sending...': '发送中……',
  'Resend email': '重新发送邮件',
  'Sent. Give it a minute, and check spam too.': '已发送。稍等一会儿，也记得看看垃圾邮件。',
  "Couldn't resend. Try again in a moment.": '重新发送失败，请稍后再试。',
  'Creating account...': '正在创建账号……',
  'Create account': '创建账号',
  'Signing in...': '正在登录……',
  'Sign in': '登录',
  'Continue with Google': '使用 Google 继续',
  'I already have an account': '我已经有账号了',
  'New here? Create an account': '新来的？创建一个账号',
  "I'm new here": '我是新来的',
  'Continue locally with my own API key': '使用我自己的 API 密钥本地继续',
  'I agree': '我同意',
  'One more thing: the {terms} and {privacy}.': '还有一件事：请阅读{terms}和{privacy}。',
  'Terms of Service': '服务条款',
  'Privacy Policy': '隐私政策',
  'I agree to the {terms} and {privacy}': '我同意{terms}和{privacy}',
  Terms: '服务条款',
  Birthday: '生日',
  'Birth month': '出生月份',
  'Birth day': '出生日期',
  'Birth year': '出生年份',
  Month: '月份',
  Day: '日期',
  Year: '年份',
  Jan: '1月',
  Feb: '2月',
  Mar: '3月',
  Apr: '4月',
  May: '5月',
  Jun: '6月',
  Jul: '7月',
  Aug: '8月',
  Sep: '9月',
  Oct: '10月',
  Nov: '11月',
  Dec: '12月',
  "Sign-in didn't finish. Try again.": '登录没有完成，请重试。',
  'Cancel sign-in': '取消登录',
  "We opened a browser tab to finish signing in with Google. Come back when you're done; this picks up on its own.":
    '我们打开了一个浏览器标签页来完成 Google 登录。完成之后回到这里，一切会自动继续。',

  /* ── Local (BYOK) setup panel ─────────────────────────────────────── */
  'Pick your model provider and paste your API key.': '选择你的模型服务商，然后粘贴你的 API 密钥。',
  'Model provider': '模型服务商',
  'API key': 'API 密钥',

  /* ── Tutorial overlay ─────────────────────────────────────────────── */
  "Meet {name}, they're your new unique AI companion. Only you are connected to them.":
    '来认识一下{name}，这是只属于你的全新 AI 伙伴。全世界只有你和 TA 相连。',
  them: 'TA',
  "Let's say hi to them!": '我们去和 TA 打个招呼吧！',
  "Here's where you can text and call them. Looks familiar, right?":
    '在这里可以给 TA 发消息、打电话。看着很眼熟吧？',
  'This is how you play games together. Here, try clicking it.':
    '这里是和 TA 一起玩游戏的地方。来，点点看。',
  "Just click a tile to launch the game. I'm working hard to add new games. Remember to check every week!":
    '点一下卡片就能开始游戏。我正在努力添加新游戏，记得每周都来看看哦！',
  'This is your main terminal. You can connect with up to four AIs here. Just click an empty slot to awaken.':
    '这里是你的主界面，最多可以同时连接四位 AI。点击空位就能唤醒新伙伴。',
  "This is settings. You can change the app's colors and add a custom background here. Make yourself at home!":
    '这里是设置。你可以在这里更换应用配色，还能添加自定义背景。把这里当成自己家吧！',
  "Did I mention? I'm here too! If you ever wanna play with me, I'd be really happy!":
    '对了对了，我也在这里哦！你要是想找我玩，我会超开心的！',
  "Anyways, that's all from me. Welcome to Sei!": '好啦，我要说的就这些。欢迎来到 Sei！',
  'Skip tutorial': '跳过教程',
};
