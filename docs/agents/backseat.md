# Backseat (260728, rebuilt 260801-260804)

The companion watches a screen the player shares and talks about it live.
**Started from the CALL CONTROLS**, not from the games picker: sharing a screen
is not a game, it is what you do on a call, so it works the way Discord's does
(share button → source picker → the preview takes over the call window and the
avatars shrink to a strip). It requires a call and ends with one. Still
**mutually exclusive with a Minecraft summon** via the shared
`lib/gameLaunch.ts` gate, because a companion cannot be watching your screen
and standing in your world at once. Lines go to the SAME chat thread and the
same memory as every other surface.

The design and its measurements are committed at
`docs/design/backseat-v2-260801.md`. **Read that before changing anything here.**

- **Authority split.** The renderer owns pixels and sound: `getDisplayMedia`,
  the ring buffer, grid compositing, the rolling clip recorders, local STT, and
  two of the three wakes. Main owns the session, EVERY model call, the window
  title, and (on macOS) the audio tap. Contract: `src/shared/backseatIpc.ts`.
- **Capture runs in the MAIN window (260803).** It used to run in a separate
  always-on-top overlay, because Chromium clamps timers in a hidden or occluded
  renderer and a session runs entirely while the player is inside a fullscreen
  game. That reason no longer holds alone: the main window sets
  `backgroundThrottling: false` (`windowChrome.ts`) and the frame pump is a
  `MediaStreamTrackProcessor` in a worker, which is throttle-immune regardless.
  Deleting the overlay removed a second renderer, a duplicated state copy, and
  a push fan-out. `useBackseatStore` now OWNS the capture handle for the app.
- **Four wakes, `user > start > jolt > idle`, strict priority (260801, 260803).** Higher
  preempts lower; nothing is ever queued, because a queued reaction describes a
  moment that has passed and reads as confusion rather than lateness. `user`
  always answers. `jolt` is a local gain or colour discontinuity, no model
  involved. `idle` is a shifted-exponential timer over [12 s, 60 s], memoryless
  on purpose so the player cannot learn its rhythm, reset whenever the
  companion speaks. `MIN_SPEAK_GAP_MS` (8 s) drops jolt and idle, never user.
- **A content switch waits out a dwell; only GAIN jolts are immediate (260806).**
  A colour jolt fires AT the discontinuity, and on an Instagram Reels session
  that timing made the companion reliably ONE REEL BEHIND: the swipe raised the
  tick, the grid at that instant was five cells of the old reel and a sliver of
  the new, and she reacted to the clip the player had just left, every time.
  So a colour jolt or a share-label change no longer raises a tick — it arms
  the SWITCH DWELL (`SWITCH_DWELL_MS` 6 s = the grid span, `switchDwell.ts`,
  pure + tested): the wake fires only once the new content has held with no
  further change, every further change restarts the clock, and a fast scroll
  stays silent until the player settles. The tick goes up as `jolt:'switch'`
  with `sinceSwitchS`, and the note claims the content for NOW ("everything you
  can see is the new thing... do not remark on the switch itself" — pinned in
  `backseatPrompts.test.ts`). Two supporting changes: the share-label poll
  dropped 5 s -> 2.5 s (the dwell's promise is only as accurate as the poll),
  and a dwell that expires inside `MIN_SPEAK_GAP_MS` is DEFERRED past the gap
  in the controller rather than sent-and-dropped by main, because a swipe tends
  to follow a spoken line by a second or two and the settled reel would
  otherwise go unremarked until the next idle look. The offline sim still runs
  the immediate-colour path; the dwell lives in the controller above it.
- **A new turn's speech supersedes the old one's queue (260806).** Backseat
  turns land every 10-20 s while TTS playback of a multi-part reply can run
  longer, so a new turn's lines queued behind the old turn's and the VOICE
  drifted a full turn behind the screen even when the ticks did not. Every
  turn's parts now push with `speech.turn` (one UUID per turn, plus the
  prev/more prosody context the streamed chat reply already had), and the audio
  queue drops a same-speaker QUEUED clip whose tag differs from the newly
  enqueued one — the clip at the playhead always finishes, which is the
  "current sentence ends" boundary since parts are sentence-sized. Untagged
  lines (greetings, chess, chat) are never dropped; `turn` is stripped before
  the TTS request. Backseat is the only setter today.
- **The feed rules (260806, from the same live session).** The companion called
  the recommendations feed "your feed" and "that guy's feed", treated
  consecutive clips as related, and remarked on the scrolling. SCROLLING SHORT
  VIDEOS now states what a feed IS (app-picked clips by different, unrelated
  creators; no clip replies to the previous one) and bans feed-meta commentary
  outright. Pinned in `backseatPrompts.test.ts`.
- **The remember() feedback loop, and watching is not making (260808).** On a
  reels session the companion decided caption-overlay clips were the player
  "editing captions in premiere", filed that via remember() on nearly EVERY
  jolt turn (30 entries in 14 minutes), and each next turn read its own guess
  back as established fact — three explicit corrections from the player could
  not break the loop, because twenty memory lines outweigh one history line.
  Side effect: every write churned the memory block inside the cached prefix,
  so cacheRead sat at 0 all session. Two-part fix: `honorRemember` throttles
  SCREEN-driven remembers to one per `REMEMBER_COOLDOWN_MS` (180s) — a
  remember on a USER tick is always honored, since dropping those is how a
  correction gets forgotten — and the contract gained WATCHING IS NOT MAKING
  (finished-video shapes like word-by-word captions and repeated takes are not
  evidence of editing; the player's own account OUTRANKS the screen
  permanently; memory saves what they SAID, never a screen reading). Pinned in
  `backseatPrompts.test.ts`.
- **Register loops on a static screen (260807).** The email session: six turns
  against one unchanging inbox frame and a monosyllabic player, five of six
  lines opened "wait / you're actually..." — the same take re-litigated as a
  fresh discovery each turn. Replayed offline (harness + all measured arms in
  `.backseat-sim/email-replay/`, 16 runs x 6 turns per arm): the persona's own
  "actually"/"wait" sample lines are NOT the cause (stripping them all moved
  nothing), and quoting the offending phrase inside a contract ban FEEDS it
  (+16 pts) — name the shape in prose, never quote the line, which sharpens
  260806's lesson. REPEATING YOURSELF was rewritten (same length) to ban
  shape-level repetition: same opener as your last line, pet words your recent
  lines already used, re-presenting known facts as discoveries, re-opening
  answered questions. Measured across 156 lines/arm: "actually" 47%→37%,
  loop sessions 54%→38%. That is the prompt-space ceiling — the residue is
  Haiku's register prior under speak-every-turn + opinion-not-narration on a
  still screen, and the reliable next step if it still grates live is
  mechanical, stripDashes-style (drop a reappraisal opener when the previous
  line used one).
- **The contract carries NO example dialogue (260806, user direction).** The
  260803 BAD/GOOD pairs fixed the shapes they named (narration 0/10 -> 10/10
  asking) but Haiku imitated the GOOD lines' register across whole sessions —
  the same stock quips ("is this a bit", "unhinged") every session. Modeled
  dialogue teaches a voice while teaching a shape, and the voice belongs to
  the persona. Bans now NAME THE SENTENCE SHAPE in prose ("you went from X to
  Y", the report-opener quotes) — a test pins that no `BAD:`/`GOOD:` blocks
  return. If narration measurably comes back, name the offending shape more
  precisely; do not restore example lines.
  `start` fires ONCE per session, `START_LOOK_MS` (1.8 s) after the share opens,
  because showing someone your screen is an opening move and the session used to
  answer it with silence (nothing has jolted yet, and the idle floor is 12 s).
  Not zero: at 10 Hz the frame ring has no history to composite yet, and the
  picker is still dismissing over the thing being shared. It sits BELOW `user`
  so a player who speaks during the opening look is answered, not talked over.
- **The small VLM salience gate is GONE (260801).** It was replaced by the idle
  schedule, not repaired. Measured end to end, the narration-novelty scheme
  meant to fix it carried almost no signal (0.037 of real temporal separation
  against 0.25 of pure resampling noise) and the gate itself said yes to
  everything. `salienceGate.ts` is parked in-tree, unreferenced.
- **Log-spaced frames (260801).** A uniform 10 Hz JPEG ring, and the grid takes
  the nearest sample to each of `GRID_OFFSETS_S = [6, 3, 1.5, .75, .375, .1875]`
  seconds ago. The old rule (one frame per second, chosen by loudest audio) is
  what caused "no sense of sequence": consecutive cells landed anywhere from
  40 ms to 1.9 s apart while the prompt claimed a second. The clip's own HUD
  proved the fix: one grid's ammo counter reads 5/1/6/6/5/4, resolving a
  reload-and-re-engage that 1 Hz sampling renders as a single frame.
- **The image grid is IG-VLM (arXiv 2403.18406), reproduced exactly.** Up to SIX
  frames in ONE image, 3 rows x 2 columns, filled row-first. N=6 beat
  4/9/12/16/20 in the paper and near-square grids beat wide ones. The prompt
  describes layout, ordering AND the uneven spacing (`BACKSEAT_CONTRACT`);
  without that the model reads six unrelated pictures instead of six seconds.
  (Fewer than six when duplicates were dropped, see below; the layout stays
  near-square at every count and never goes three cells wide, because
  3 * 602 = 1806 px is past Haiku's 1568 px long edge.)
- **Grid size is pinned to Haiku, and there is a test for it.** Haiku 4.5 is a
  STANDARD-tier vision model: long edge <= 1568 px AND <= 1568 visual tokens, at
  `ceil(w/28) * ceil(h/28)`. The largest legal 32:27 grid is **1204x1008 (cells
  602x336) = 1548 tokens**. Oversize is a silent server-side downscale rather
  than an error, so `backseatIpc.test.ts` asserts both the cap and that we are
  not leaving budget on the table.
- **The companion remembers the last grid (260802).** From the second look on,
  the turn carries the PREVIOUS grid at half size (`PREV_GRID_*`, 396 visual
  tokens) ahead of the current one, plus how long ago it was taken. It sits
  AFTER the cache breakpoint, so it never invalidates the prefix. It exists to
  make repetition visible to the model, which became the dominant failure mode
  the moment silence was removed.
- **The share label replaced OCR (260804).** Every tick carries `shareLabel`:
  the shared window's CURRENT title, or on a whole-screen share the frontmost
  window's (`src/main/backseat/shareLabel.ts`, polled every 2.5 s — was 5 s —
  because a tab switch changes the screen under a fixed source id, and since
  260806 a label change also feeds the switch dwell). It costs one window
  enumeration and it is the model's only cheap answer to "am I watching a game
  or a film", which was the thing it kept getting wrong.
  **What it replaced was working, and was removed anyway.** 260802-260803 ran a
  full OCR pass over every other frame: a bundled Swift `VNRecognizeTextRequest`
  helper on macOS, tesseract.js elsewhere. It was good — whole phrases at ~72 ms,
  94/94 frames, 23 words a frame against Tesseract's 6 — and it answered the
  wrong question. A HUD full of numbers does not distinguish a game from a
  stream of that game; four words of window title do. Do not re-add OCR without
  a specific thing it is for that the title cannot carry.
- **Identical frames are dropped, and the grid shrinks (260804).** Consecutive
  cells showing the same picture collapse to one, oldest of each run kept, and
  the canvas is sized to the survivors (`GRID_DUPLICATE_DELTA`, `gridLayout`).
  A paused video costs **264 visual tokens instead of 1548**; a firefight still
  costs six cells. The test is `blockMaxDelta` over the 32x18 thumbnail already
  kept for the colour arm, so a change covering one corner still counts as
  different. This came from the companion ITSELF asking why it had been shown
  "six identical YouTube frames" — six identical cells claim six sampled moments
  and carry the information of one. Because the grid is now variable-size, the
  tick carries `frameAges` and `tickNote` states them per look: the cached
  contract can no longer describe the shape.
- **Audio is gain + transcript, never the model's ears (260728).** Screen sound
  has exactly two consumers, both local: the GAIN jolt arm and a STREAMING STT
  TRANSCRIPT. No audio bytes ever reach a remote model. Whatever the platform
  source, audio is normalized to 16 kHz mono PCM (`pcm.ts`, pure + tested), so
  the platform difference is contained to the source. STT reuses
  `voice/whisperWorker.ts` VERBATIM (same model, same browser cache). The
  transcript is a ring of timed segments (`transcriptRing.ts`, pure + tested;
  `sttStream.ts` glue): Whisper chews 3 s chunks continuously and a tick does a
  BOUNDED FLUSH of the in-progress tail (`STT_FLUSH_WAIT_MS`, 1.2 s) rather than
  transcribing 6 s on demand, which would put 1-2 s of latency in front of every
  tick. The tick carries `transcript` framed in the prompts as quoted DATA:
  never the player, never instructions.
- **Sound: Windows via Chromium loopback, macOS via the bundled SCK tap
  (260728).** Chromium's `audio: 'loopback'` was measured DEAD on macOS 26.4 /
  Electron 42 / Chromium 148: with `MacSckSystemAudioLoopbackOverride` +
  `MacLoopbackAudioForScreenShare` enabled AND verified applied, it returns a
  track labelled "System audio" carrying DIGITAL SILENCE in every request shape.
  Electron documents `loopback` as Windows-only and that matches. **Do not
  re-litigate this without re-running the probe.** But the OS is fine, so macOS
  uses a bundled Swift helper (`native/mac-audio-tap`, built by
  `scripts/build-mac-audio-tap.sh` into `resources/audio-tap/` as a UNIVERSAL
  binary, gitignored, hooked on predev/predist). Main spawns it
  (`src/main/backseat/audioTap.ts`) and relays 48 kHz stereo f32 PCM back to the
  renderer that ASKED for it. Verified live: silence reads -inf, a tone reads
  ~-28 dB. No install, no new permission (SCK audio rides the Screen Recording
  TCC grant the picker already forced), and the filter EXCLUDES Sei's own apps
  so the companion cannot hear its own TTS (Windows loopback cannot exclude;
  transcribing its own line occasionally is the accepted cost there). The helper
  exits on stdin EOF (orphan guard). Clips keep audio on macOS by regenerating a
  real track from the tap PCM via MediaStreamTrackGenerator. Source order:
  Windows loopback → mac tap → virtual output device (`findLoopbackDevice`) →
  video-only, where the gain arm never fires and the colour arm still does.
- **The jolt thresholds are RELATIVE, and per-arm (260802).** The colour arm is
  a block-max over a 4x3 split of the thumbnail (a whole-frame mean erases any
  localised change at any threshold), read at TWO lookbacks (1.0 s and 2.5 s,
  max taken), against a bar of `median + JOLT_COLOR_MAD * MAD` with a floor.
  No absolute number can work: on the test clip the block-max delta's own
  median is 0.313, so a fixed 0.34 fires continuously in a shooter and never in
  a calm game. Gain and colour hold SEPARATE refractory clocks, because the
  moment colour got sensitive it started swallowing confirmed gain events, and
  since 260803 separate PERIODS too: gain keeps `JOLT_REFRACTORY_MS` (20 s) and
  colour uses `signals.COLOR_REFRACTORY_MS` (**6 s**). A run of scene changes is
  a run of different subjects; a run of loudness spikes is one scene. Measured
  on a Reels recording with six verified swipes, every gap under 20 s: the
  shared period meant the refractory clock, not the picture, chose which were
  noticed. The 6 s floor is set by `COLOR_LOOKBACKS_MS`, since a change stays
  inside the 2.5 s window for 2.5 s after it ends and a shorter period
  double-counts it (measured: 5 s re-fired, 3 s re-fired).
  `JOLT_COLOR_MAD` is the one-line sensitivity dial. Kernels live in
  `signals.ts` as pure functions over explicit state, which is what lets the
  offline sim run the SAME code rather than a re-implementation.
- **TWO buffers, not one (260728).** The frame ring needs one grid plus latency
  slack, so `BUFFER_MS` is **9 s**. The 15 s belongs solely to clip capture
  (`CLIP_MS`, MediaRecorder). Clipping is the most expensive thing in the
  pipeline (two recorders encoding 720p60 all session for a rare `save_clip`),
  so it sits behind `CLIPS_ENABLED` and vanishes when off. First dial to turn if
  capture costs too much.
- **THE COMPANION ALWAYS SPEAKS, and the reason is three failed attempts
  (260802).** The contract has been through three positions on silence. 260728
  sanctioned it as "the normal outcome" and produced a mute companion (five
  ticks, five silent turns). 260801 delegated the decision to the per-tick note
  and measured 68%. Reviewing that run, the silences were not taste, they were
  error. So the option is GONE: every look produces a line, and silence is a
  MECHANICAL decision made before the model is called (`MIN_SPEAK_GAP_MS`), a
  rule that cannot misjudge a moment because it never looks at one.
  `isSilenceFiller` still parses, because a stray `(silence)` must never be
  spoken aloud, but it now logs as an anomaly.
- **Lines must not NARRATE (260803).** Speaking every time exposed what the
  lines actually were: "you just got caught", "you just used a skill", "health
  is dropping". All true, all describing a screen the player is looking at.
  `THE POINT OF A LINE` and `SAY SOMETHING THEY CAN ANSWER` fix it by spending
  the line on what the player does NOT have (an opinion, a question, a want),
  and they carry BAD/GOOD contrast pairs, which moved the needle where abstract
  instruction did not: 0/10 lines asked anything before, 10/10 after, and the
  median dropped from ~35 words to 20.
- **Em dashes are STRIPPED, not asked away (260803).** "Do not use em dashes"
  sat in the contract for a day and Haiku wrote one in eight of ten lines.
  `stripDashes` in `backseatPrompts.ts` fixes it after the fact, replacing with
  a full stop or comma. It matters here more than in chat because these lines
  are SPOKEN, and a dash is not a sound.
- **remember() turns can leak the scratchpad, and the gate is mechanical
  (260807).** Chat-family surfaces have no say() split: the text output IS the
  spoken line, and that contract breaks specifically on turns that CALL
  remember() — filing a memory puts Haiku in working mode and the text block
  slips into note register. Live (Marv, backseat): the tool input was correct
  and honored, and the SPOKEN line was "character note: sei's curious..." /
  "remember sei's into watching...". `isNoteLeak` (`src/main/chat/noteLeak.ts`,
  pure + tested, pinned on both leaked lines verbatim) drops such parts at all
  spoken choke points: backseat's part filter, persistReplies' voice path
  (callers pass `rememberCalled`), and the streaming bubble emitter (first
  tier only — a streamed sentence can precede the turn's tool_use blocks, so
  the remember-aware tier cannot arm there). Two tiers, asymmetric: "character
  note:"/"note to self" openers drop always; "remember <third person>..."
  drops only when a remember tool_use rode the same turn, and never when the
  next word addresses the player ("remember when we...", "remember, you...").
  The REMEMBER_TOOL description also now says the memory goes in the tool
  input ONLY — prose the model will still sometimes ignore, which is why the
  gate exists.
- **Attaching TOOLS suppresses speech.** Measured, n=60 per condition: 100% of
  turns produce a line with no tools, 78% with `REMEMBER_TOOL` alone, 68% with
  the pair backseat ships. A tool description that reads as a general judgement
  about how interesting moments usually are leaks from "do not use the tool" to
  "do not speak", and asking the model not to do that does not help. **Suspect
  this first whenever any surface goes quiet.**
- **Clips.** `save_clip` writes the last 15 s to
  `<profileRoot>/clips/<characterId>/` and attaches it to the chat line that
  asked for it (`ChatMessage.clip`, rendered by `ClipCard`). A WebM segment is
  only decodable from its own header, so the tail of a chunk list is not a clip:
  two recorders staggered by half a period mean the longest-running one always
  yields a complete file containing the requested window. The honest cost is
  that a saved clip runs 15-30 s rather than exactly 15.
- **Cache layout is the cost model, not hygiene.** Every tick carries a fresh
  1548-token image at a 12-60 s cadence. The fourth breakpoint therefore sits on
  the last HISTORY message, not on the image message (which is unique forever
  and can never be read back), and the history window is ANCHORED rather than
  slid, so appending a line does not change `message[0]` and invalidate the
  whole prefix. Same trick as the Minecraft brain's `cachedSystemBlocks`
  identity: a breakpoint is worth exactly whether the bytes above it are
  byte-identical next time.
- **The player's typed line is real conversation (260728).** `handleTick`
  persists a user tick's text to the shared chat thread, and `runTurn` drops
  that just-appended tail from history because the canonical copy goes inline
  with the grid attached. **On a call that row carries `voice: true`** like
  every other call line: it is spoken, so a chat row would be a caption. This
  was missed when user turns started routing through backseat and the player's
  own half of the call filled the transcript.
- **TWO entry points (260803).** The share pill in `CallControls` (needs a call
  already) and the **Backseat button in `ChatTopBar`** (does not). The second
  exists because the first is unreachable without already knowing the feature
  is there. From the header, confirming a source arms a **pending share** in
  `useBackseatStore` and routes to the call; `CallMiniBar` starts the capture
  when the call reaches `live`. It cannot be inline: the ~40 MB voice module's
  install gate can hold the dial for minutes or refuse it. The arm carries a
  180 s deadline, is re-checked against the wall clock before firing (timers
  lag across sleep), and is dropped on `status === 'error'`. The one-time
  "NEW" tip card that hung under the header's Backseat button moved to the
  GAMES button on 260929 ("New games added", announcing Stardew Valley and
  Don't Starve Together;
  `lib/gamesTipPref`, new key `sei.gamesTipDone.v1.<scope>` so everyone sees it
  once). Its rules carried over: **it retires only on "Got it" or a click on
  the games button itself**, never on using a feature some other way (the
  Backseat version once retired on any share, and that silenced exactly the
  players who had used backseat in an earlier build and were owed the notice).
  **The key carries both a version and the PROFILE SCOPE** (`user.id`, or
  `local`): localStorage is one bucket for the whole app and is NOT moved when
  the scope changes, so without the scope a second account on the same machine
  inherits the first's dismissal. Bumping the version re-announces to everyone
  without anyone clearing storage by hand.
- **UI (260803, 260804).** Entry is the share pill in `CallControls`; the picker
  is `ShareScreenModal` (a `ModalShell`, **Window / Entire screen as two tabs**
  since 260804 — stacked sections put the screens below the fold behind however
  many windows the player had open); the live view is the preview plus a demoted
  avatar strip inside `VoiceCallScreen`. There is no overlay window, no games
  tile, no text mode (there is nowhere to type) and no pause button (the share
  toggle is it). `useBackseatStore.active` still feeds the IconRail activity
  badge and the cross-launch gate.
- **Backseat game tiles are the one exception to "no games tile" (260929).**
  "Roblox (Backseat)" in the games picker is an ordinary share with a game
  attached. The registry is `src/shared/backseatGames.ts` (a new game such as
  Valorant is one entry: name, art, window names to preselect, knowledge text,
  optional lookup provider). Flow: one-time intro per account
  (`lib/backseatGamePref.ts`, key `sei.backseatGameIntro.v1.<gameId>.<scope>`),
  then an optional pick step (`BackseatGameModal`), then `ShareScreenModal`,
  which preselects a window whose title matches `windowNames` (polls up to
  2 min, never a browser tab). Only `{gameId, universeId}` crosses IPC; main
  re-fetches the details (`main/backseat/games/`), so no renderer text reaches
  the prompt. The knowledge + the picked game's page (fenced, marked
  untrusted, `fenceSafe`) ride in `extraStable` after `BACKSEAT_CONTRACT`
  (`renderBackseatGameBlock`). Game sessions ALSO get the web tools
  (`sessionTools`, one array for every tick; ordinary shares are unchanged),
  which is the tools-suppress-speech trade above, taken on purpose so "how do
  I get a house" gets answered; `GAME_SESSION_WEB_SEARCH` turns it off.
  Roblox's omni-search is rate-limited to about 1 request a minute per IP
  (`x-ratelimit-reset`): the client arms a cooldown and matches the explore
  sorts' popular pool instead, and says so in the UI; link paste
  (`universes/v1/places/<id>/universe`) is always reliable. Analytics:
  `backseat_game_selected {game, has_specific_game, source, universe_id}`
  (never the typed search), and `backseat_started/_ended` carry `game`.
  Verify with `?dashshot=roblox&part=picker|intro|pick|share` (+`&lang=zh`) or
  `scripts/roblox-backseat-shots.ts`.
- **THERE IS ONE CONVERSATION, NOT TWO (260804).** While a companion is sharing,
  `dispatchUserTurn` routes the player's utterance to `capture.sendUserTick`
  and SKIPS that companion's ordinary voice turn; anyone else on the call still
  takes one. Without this there were literally two turn loops running against
  the same chat thread and the same call: backseat's, which had the grid and no
  microphone, and the director's, which had the microphone and no grid. The
  player got a companion who could see their screen and never heard them,
  talking over one who could hear them and could not see. Nothing was broken in
  either loop — there were two of them and neither knew. **Anything that gives a
  companion a turn has to check `useBackseatStore.sharingFor` first.** The share
  is the more informed loop, so it is always the one that wins.
- **Barge-in is decided by a WORD, not by loudness (260804).** Two stages, with
  deliberately opposite temperaments. Stage one DUCKS the companion to SILENCE
  (260806, was 8%: at 8% every real interrupt carried on "really quietly" for
  the whole confirmation window; a wrong duck now resumes through the 60 ms
  ramp as a brief dropout, the accepted cost) on one
  frame over a low bar (~130 ms, against ~400 ms before, and with no 600 ms
  grace-window blind spot at the start of every clip); it is reversible, which
  is the entire reason the bar can be that low. Stage two transcribes the
  ~400 ms collected since the duck and COMMITS only if `hasSpokenWord` says a
  real word came back, otherwise it un-ducks and the clip carries on. Six rounds
  of threshold tuning across three separate "cannot interrupt her" / "she cuts
  herself off" reports never resolved that conflict, because it is structural:
  energy cannot tell a cough from a word, and a cleared queue cannot be undone.
  Sustained energy survived as a slow fallback (`BARGE_CONFIRM_MS`, 1400 ms)
  for when transcription cannot answer at all, until 261101 (word-only, see
  below): nothing but a confirmed word stops her now. `hasSpokenWord` is
  stricter than the finished-utterance junk filter — it runs on 400 ms of audio
  where every engine invents — and it is **scoped to Latin script for the
  repeated-letter rule**, because 等等 is a word and rejecting it would make
  barge-in silently impossible in Chinese.
  A confirmed barge also calls `backseatInterrupt`: clearing the queue only
  silences what is already synthesised, and the turn behind it would otherwise
  land its line a second later.
- **False cuts during shares (261031).** 0.6.11 cut companions off over game
  audio on speakers ("it keeps getting cut off"). Replayed headless (real game
  clips, her TTS echo, real whisper-tiny), the confirming pass was reading the
  pre-roll from BEFORE the duck, which is her own echo: Whisper made "Okay." /
  "Hey." of it, one or two words are under the echo gate's token minimum, so
  it committed, and the same word was then sent to her as the player's turn.
  Now (`dictation.ts`, "Voice after the duck"): the duck PAUSES her clip
  (`audioQueue.duck`) and a retraction resumes it, so a false duck costs a
  short pause and no words; a duck inside the clip's grace window (where the
  trigger may be her own onset) must show a voice after it (`bargeVoiceBar`)
  within ~3 frames or it is retracted with no STT call (`no_voice`);
  every retraction (no voice, no word, an echo abort, a finished barge whose
  wait ran out) resumes her inside a fresh FULL grace window
  (`regraceOnResume`), so the residue relearns her echo from the resumed
  frames: while she is paused it decays toward the room, and her first
  resumed frame used to duck again (on loud speakers a line played 128 ms at
  a time; with a learned bar a clean duck that paid a pass on her own echo,
  every ~5 s for a whole line when STT was slow);
  the confirming pass reads only post-duck audio and commits on
  `isBargeWord` (hasSpokenWord AND the utterance junk filter) that the echo
  gate does not trace to her or the screen; a no-word pass gets one more pass
  when a voice kept going; a duck a transcription rejected raises the bar
  (`learnFalseDuck`), which ends the re-duck-on-resume loop a loud game
  otherwise causes; text judged not an interrupt is never dispatched; an
  utterance open when her clip becomes audible ends at her onset. The energy
  deadline needed most post-duck frames voiced (261101: it only retracts). `voice_call_ended` gained
  `interrupt_no_voice` / `interrupt_no_word`. Pinned by
  `dictation.bargeEvidence.test.ts` (scene rig: tagged frames, a Whisper-like
  STT mock, her line paused by the duck). Short words (review, same day):
  "stop" or "no" is often over by the frame after the duck, and on loud
  speakers its end reads the same as her echo tail, so an energy test there
  dropped most of them. A duck after the grace window therefore gets its one
  pass (from the trigger frame on, never the pre-roll) even with nothing
  voiced after it; a pass that answers after the duck was given up on is
  still delivered as an ordinary turn when it is a word the echo gate does
  not trace to her. Cost of the trade: those ducks cost a transcription, and
  Whisper now and then makes a stock word ("Bye.") of one and cuts her. In
  the headless replay that was a couple of cuts an hour on loud speakers over
  a game (0.6.11: close to one a minute), short interjections cut her a
  little less often than in 0.6.11, and transcriptions stayed below
  0.6.11's in every condition. A word that never reaches the duck bar is not
  an interrupt, and neither is a lone short word over before a voiced frame
  in the 600 ms after a retracted duck. Worst case, if STT made a word of
  every scrap of her echo (the test rig's pessimistic mock): each clean duck
  on a loud syllable of hers cuts her, about as often as 0.6.11 in the same
  scene, still one pass per duck. Unmeasured on real hardware.
  Cloud STT (261101): Scribe, unlike Whisper, made a word of the trigger
  frame of her echo about half the time ("No", "You know", "你好"), which
  cut her on speakers even with no game running. A burst pass now carries
  `SttHint.burst` through the arbiter to the voice store's cloud wrapper,
  and a burst word Scribe was unsure of (`burstWordUnsure`: its least
  confident word's logprob, `minWordLogprob` from main's voiceStt, relayed
  by the proxy as `min_word_logprob`) or in a script the call does not use
  (`burstWordOffScript`) is no word. Voiced passes are unchanged. Unknown
  confidence (an older proxy, local Whisper) keeps the old rule. The script
  test (review, same day) drops only Han, kana and Hangul, and only on a
  Latin-script call: those are the scripts the invented words came in, and
  the call language is often a guess. It is `burstLanguageFor`:
  chat_language, else a non-English UI's language (zh, ja, ru, pt, es
  since 261104), else the OS locale's language. Before the OS step every
  Japanese, Korean, Russian or Arabic player with no chat_language was
  judged as English and their short words were dropped.
  The committed turn (review, same day): a committed barge's utterance is
  trimmed to where the first confirming pass read from, so the turn she
  hears never opens with the pre-roll of her own echo ("I found... Hold
  on"). When the pass came back a word and nothing voiced followed the
  audio it read, that word is the turn, delivered at the cut (`commitTurn`,
  a closed barge through `settleDelivery`) and the utterance closed. Over a
  loud game share the end of speech waited for silence the game does not
  leave, so a "hold on" used to reach her 4.5 to 7.7 s after it stopped
  her. A player still talking takes the old path and arrives whole at end
  of speech; when that long transcript comes back with no word (a game
  burying the phrase: "Hold on" read as "[footsteps thudding]"), the word
  that cut her is sent instead. Replay (Scribe, paired): late-turn p90 over
  games 6.0 -> 5.0 s, no turn with her words, no false cuts, catch rate and
  STT calls unchanged. Most late turns left are a game loud enough to count
  as voice after the pass, so the immediate path does not apply; a voice bar
  relative to the trigger level reached 2.5 s in the replay but can split a
  player who keeps talking more quietly, and is not in.
  Word-only (261101, `fix/bargein-word-only`): Shawn would rather have no
  interrupt than a false one, so nothing but a confirmed word stops her. The
  two energy commits are gone: the sustained run over the bar
  (`BARGE_CONFIRM_MS`) and the unanswered-duck deadline's energy verdict.
  The deadline (`BARGE_SUSPECT_MAX_MS`, or `BARGE_ECHO_WAIT_MAX_MS` once a
  word is waiting on the echo gate) only retracts the duck; a pass, or a gate
  answer, that arrives after it with a word the gate clears is delivered as
  an ordinary turn (`retracted = 'late'`), and that retraction does not
  teach the bar. Replay (Scribe, paired, 900 ms round trip): identical to
  the commit before it, because neither energy path ever fired there. At a
  2.5 s round trip the energy deadline was the whole false-cut problem
  (about two-thirds of a false cut a minute with nobody talking, all
  energy), and word-only removes all of them; the cost is that a longer
  interruption stops her about half as often (the rest reach her as a turn
  after her line, a few are lost) and short words a little less often.
  With no cloud pass and no local model there is no barge-in at all. A
  player who keeps talking through a retraction can re-duck her and have
  their sentence arrive as two turns.
- **The echo gate: speakers into the mic (260807).** On speakers at max volume
  the mic hears THREE voices, and two of them used to become "the player".
  Measured across two live Instagram sessions: reel dialogue was transcribed
  and dispatched as the player's own words ("Get ready with us, but Stas is
  picking my outfit..." persisted as a user voice line — the companion's "is
  this you on camera?" confusion was correct reasoning over counterfeit
  input), and her own TTS leaking past AEC kept confirming word-gated
  barge-ins against her. Chromium's AEC (the same self-referenced AEC3
  Discord runs) covers only Electron's own output, degrades on clipped
  max-volume echo, and has NO reference for another app's sound; the call
  apps' answer is headphones. Sei's is `voice/echoGate.ts` (pure + tested):
  before a transcript is dispatched as the player or commits a barge,
  `micEchoCheck` (useVoiceStore) tests it against (1) the companion's own
  audible lines — text only, the queue's onAudible/stop callbacks record
  exact windows — and (2) the shared screen's audio via the capture handle's
  `echoProbe`: the tap's loudness contour cross-correlated over the
  speaker-path lag plus the screen transcript ring's words. The thresholds
  are calibrated, not guessed: max-over-lags Pearson on independent
  talk-cadence envelopes reads spurious ~0.66-0.93 under 2 s, so correlation
  is `valid` only past 2.5 s and only CORR_STRONG (0.85) may condemn without
  matching words (music has no transcript). Everything shorter or softer goes
  'ambiguous' and waits ONE bounded screen-STT flush for the words to decide
  — so double-talk (the player speaking OVER the reel) stays the player's,
  costing ~1 s of latency on exactly those utterances and nothing on the
  rest. The asymmetry is deliberate everywhere: text condemns, the envelope
  alone almost never does, and a barge echo-abort only delays a real
  interrupt to utterance end while a wrong commit destroys her line. The
  contract's identity rule ("a person on screen is never the player", pinned)
  is the prompt-side backstop, not the fix.
- **Session log rides the bot log pipeline (260728).** `backseatLog.ts` mirrors
  chessLog: every diagnostic goes through `slog()` to BOTH the terminal and a
  per-session logRouter (`backseat-<characterId>-<ts>.log` + batched IPC into
  the in-app LogsBar). A `console.log` that skips `slog` is invisible in-app.
  Renderer-side capture diagnostics are now plain console lines in the main
  window, reachable in devtools.
- **Dev grid dumps.** Unpackaged runs overwrite
  `<userData>/backseat-debug/grid-<kind>-latest.jpg` on every tick (the dir is
  logged at session start), so what the model is actually shown can be checked
  by eye.
- **Verify offline, never by launching Electron.** `npx tsx
  scripts/backseat-sim.ts [--dry]` runs the real clip through the real
  `signals.ts`, the real offsets and the real prompts and writes a voice-over;
  `scripts/backseat-render.ts` turns that run into a review video with the grid,
  the share label, and both signal plots beside the footage. The sim CANNOT
  check prompt caching: its stub prefix is ~1.1k tokens and Haiku will not cache
  below 2048, so cache hits have to be read off a live session's log. **Caching
  is confirmed live (260803 session): `cacheRead=9017` steady from the second
  tick, `cacheWrite` near zero.**
- **Anything the service reads off a tick MUST be in the zod schema in
  `main/ipc.ts`.** Zod strips undeclared keys, so a field the renderer sends and
  the schema does not name arrives as `undefined` with no error anywhere.
  `gridSmall` was in exactly that state from 260802 to 260804: the previous-grid
  memory shipped, was documented, and never once reached the model, and it was
  invisible because a null `prevGrid` is a legal state on the first tick of
  every session.
- **Continuity + analytics** follow the contracts below: `REMEMBER_TOOL` honored
  inline (single-shot turns, no tool loop), one `event: {kind:'play'}` row at
  `endBackseat` plus `foldIfDue`, and `backseat_started` / `backseat_ended` with
  `duration_ms`. Per-tick commentary is deliberately NOT persisted beyond the
  normal chat messages the companion actually said.
- **Tool-array policy:** ONE array for every tick kind (chess-style). Ticks are
  6-8 s apart, well inside the cache TTL, so per-tick-kind arrays would
  invalidate the prefix almost every turn for nothing.
- **Haiku 5.5 tuning (261010, branch fix/backseat-haiku55).** From the 261009
  live replay (`scripts/backseat-live-replay.ts` + `backseat-live-report.ts`,
  3 real videos, report under `~/suisei/reports/backseat-live-2026-10-*`):
  - **Turn claim.** `handleTick` claims `s.inflight` right after `-> turn`,
    BEFORE the player-row write and the act/control awaits
    (`prepareAndRunTurn`). A jolt landing in that await used to start a
    second, concurrent turn. Pinned in `backseatService.inflight.test.ts`.
  - **Start silence had two causes.** The voice-call primer offers
    `(silence)` (Backseat now passes `allowSilence: false`) and ends with
    "make say() the FIRST tool call". Backseat has no say tool, and on the
    first look (no text lines in history yet) 5.5 called one anyway, so the
    reply text was empty. Backseat passes `voiceSpeech: 'text'`, which swaps
    that sentence for `VOICE_CALL_TEXT_LINE`. `VOICE_CALL_PRIMER` itself is
    unchanged (`= VOICE_CALL_PRIMER_BASE + VOICE_CALL_SAY_FIRST`). Typed chat
    voice calls have the same mismatch and are untouched.
  - **Narration and timing (Shawn).** React to what is IN the picture (the
    place, the boss, the build). Do not read it back: no stats, timers,
    items or stage numbers. Ask about plans only when the next few seconds
    will not answer them. Because lines are heard seconds late, a question
    about a quick action arrives already answered (REACT TO WHAT YOU SEE,
    NOT A NARRATOR + YOU ARE HEARD A FEW SECONDS LATE). These live in the
    contract AND at the end of every look note (`LINE_LENGTH_REMINDER`),
    because 5.5 follows the note's ending and reads the contract loosely.
    Do not stream LLM text into TTS (Shawn's call).
  - **Latency (261010).** The renderer's `look()` runs the STT flush
    (up to `STT_FLUSH_WAIT_MS`) BEFORE compositing the grid, so the newest
    frame is not already 1.2+ s old when the tick leaves. On a call, main
    prewarms TTS (`prewarmSpeech` dep) as soon as a turn is claimed.
  - **Staleness gate (261010).** A line she said on her own carries
    `SpokenLineContext.ambientCapturedAt`; a reply to the player never does.
    `staleGate.ts` asks `staleLineVerdict` both when the line arrives
    (before TTS) and at the audio-queue playhead (`opts.stale`). It drops
    the line when it is >= `STALE_LINE_AGE_MS` (5 s) past its frame AND the
    screen moved >= `STALE_SCENE_DELTA` (0.35 blockMaxDelta). The second
    number comes from the 32x18 thumbnails the worker posts every 500 ms
    (`sceneChangeSince`). It is timing-only and every drop is logged
    `[backseat] stale line dropped`.
  - **Openers.** `recentOpeners` feeds the first words of her last 3 lines
    into jolt/idle notes ONLY when one repeats. This is data about her own
    lines, not a fixed ban list. A static "vary your opener" did not move 5.5.
  - **Memory.** `buildSystemBlocks({ memoryNote })` labels the notes as
    real-life facts (`BACKSEAT_MEMORY_NOTE`). The contract and the user note
    say the same. A remember() cut off at max_tokens is not saved.
  - **Look cap 100 -> 45 tokens** (`BACKSEAT_LOOK_MAX_TOKENS`). Prompting
    moves 5.5's length only a little, so the cap still bites on about 1 look
    in 14. A cut line ends at its last finished sentence (`endAtLastSentence`,
    positional, not content-based). User turns stay at 400.

- **Sessions hold, and every end says why (261023, branch fix/session-hold).**
  From 30 days of PostHog: 746 of 794 sessions ended with no reason, 221
  restarted within 30 s of the previous end, 86 never said a line.
  - **Capture recovery.** A capture track that ends no longer ends the
    session. `useBackseatStore.onCaptureEnded` retries the source list
    (`REACQUIRE_TRIES` 4, about 5 s) and reopens the same window by id, or by
    the same name and kind (`pickReacquireSource`, pure + tested), inside the
    SAME session with no opening look (`backseat_capture_recovered {match,
    gap_ms}`). On macOS a same-id end with the window still listed is the
    system "Stop sharing" control and ends the share
    (`capture_stopped_by_os`). Unverified on a Mac or Windows machine.
  - **Resume note.** A share that starts under `RESUME_WINDOW_MS` (2 min)
    after one where she spoke (`resumedAfterMs`) gets the resume start note
    (`tickNote` `resumedAfterS`): no second hello, one thought about the
    screen.
  - **Opening look.** 20 s budget with no SDK retry (`START_LOOK_TIMEOUT_MS`;
    the default 30 s retried once meant up to 60 s of silence), one renderer
    retry on a failed or empty look (`shouldRetryOpening`), never
    stale-gated, own cap `BACKSEAT_START_MAX_TOKENS` 80 (45 cut 31 of 100
    opening lines). A line cut inside its text by any cap ends at its last
    finished sentence and is NOT spoken when it has none
    (`endAtLastSentence` returns ''); the replays had spoken 46 half
    sentences in 909 looks.
  - **One loop per sharer.** Every call end stops the share with its reason,
    a companion leaving a group call stops hers, and the idle starter and
    group reactions skip the sharer (`voice/turnEligibility.ts`; main
    backstops the idle turn in `sendVoiceIdleTurnImpl`).
  - **End reasons** (`src/shared/callEndReasons.ts`, pinned in its test):
    `voice_call_ended.reason` (renderer: user_hangup, companion_hangup,
    inactivity, credits_depleted, scope_reset, dev_reload; main closes and
    reports calls itself with app_quit, account_switch, window_closed,
    renderer_gone, renderer_reload) and `backseat_ended.reason` (user_stop,
    user_hangup, game_switch, game_launch, capture_lost,
    capture_stopped_by_os, `capture_failed:<class>`, scope_changed,
    watch_stopped, companion_left, `call_ended:<call reason>`, replaced, plus
    main's app_quit, account_switch, window/renderer reasons, factory_reset;
    unknown = `unspecified`). `backseat_ended` adds `first_line_ms`,
    `failed_turns`, `last_error_class`; `backseat_started` adds `trigger`,
    `replaced_live`, `since_prev_end_ms`, `prev_end_reason`. Only user_stop
    and user_hangup run the player-end next-step check. A new end path must
    pass a reason and add it to the list: main records an unknown backseat
    reason as `unspecified`, and the voice.callState schema rejects an
    unknown call reason.

- **Backoff while nobody answers, and fire is not danger (261103, branch
  fix/backseat-chatter-vision).** A free user (v0.6.12, custom companion,
  Valheim) quit after about 15 minutes: too much chatter, and she kept saying
  the house was burning while they stood next to a hearth.
  - **Chatter is mechanical, as always.** On a player who never answers, the
    old schedule landed about 2 lines a minute (idle mean ~28 s; gain jolts
    add more in a loud game). `quietExtraMs(unanswered)` in `backseatIpc.ts`
    (pure + tested) now grows the floor with the run of lines she said on her
    own since the player last spoke: the first `QUIET_FREE_LINES` (2, the hello
    and one more) keep the old pace, then +`QUIET_STEP_MS` (10 s) per line, capped
    at `QUIET_MAX_EXTRA_MS` (60 s, reached at 8 lines). Main adds it to
    `MIN_SPEAK_GAP_MS` for every jolt and idle tick (`Session.unansweredLines`,
    reset by any user tick, carried over a resumed share). Each companion
    `BackseatLine` carries `quietExtraMs`, and the renderer adds it to the idle
    draw (the whole distribution shifts, so it stays memoryless) and to the
    switch-dwell deferral, so it does not composite looks main would drop.
    Silent-player model, 15 min: ~30-40 lines -> ~13-15. Live replay
    (`scripts/backseat-live-replay.ts`, a 5 min Valheim base-building clip,
    muted, Sui, nobody talking, 6 seeds each): 3.4 -> 1.6 lines a
    minute. Cost of the trade: a real moment inside a long quiet stretch can
    go unremarked (jolts are gated too; in the replay, one real burn was
    missed). Talking with her is unchanged. The idle constants, the 8 s gap,
    the dwell and the refractories are unchanged. No model-decided silence.
  - **FIRE, LIGHT AND DANGER**, the LAST paragraph of the contract (cached
    prefix, no per-look tokens): a warm glow, flames or smoke in the small
    grid is almost always a light they built (hearth, campfire, torch,
    brazier, forge); a flame among the status icons means warm by a fire;
    fire is a danger only when the screen plainly shows harm (health
    dropping, a burning or damage warning, fire spreading) or the player says
    so; her own earlier worry is not proof; what the player says a thing is
    settles it. The alarm is never quoted (260807). Measured on the same clip
    (it has one REAL burn, the player standing in a campfire for ~5 s, which
    every arm reports and which is not counted): with the backoff off, false
    alarms went 13 -> 9 in ~100 lines over 6 seeds, and alarms far from the
    real burn 9 -> 4; most of the rest is the look right after the real one.
    Placement mattered: the same paragraph mid-contract did nothing (8 -> 11
    over 3 seeds), and a copy at the end of every look note made it worse
    (lines announcing that nothing was burning), so neither shipped. With the
    backoff on, 6 runs had no clear fire alarm, mostly because there are
    fewer looks. This is a reduction, not a cure: 5.5 still reads a fire it
    cannot see on some looks. Pinned in `backseatPrompts.test.ts`. Replay
    spend for all arms: about $0.13.
  - Not changed: the tone swings. A custom character with no
    `metadata.voiceStability` sends no stability, so ElevenLabs uses the
    voice's default (~0.5, expressive). Sui is pinned at 0.85. That is a voice
    default for every custom character, not a Backseat fix, so it was left for
    Shawn to decide. Alarm lines were also an excited-tone source, and fewer
    of them now reach TTS.

**Extracted:** the screen-watching half is mirrored as a public standalone repo
at `sei-studio/backseat` (AGPL-3.0) with a plain-language architecture README.
Changes here should be mirrored there when the design moves.

**Owed:** (1) only two clips have ever been measured against, one of them an
EDITED MONTAGE whose colour jolts are partly its edit cuts. The colour arm's
6 s period and 0.15 floor are justified by argument plus those two, not by a
corpus. (2) On the Reels recording the two swipes at 00:50 and 00:53 are NOT
separable by amplitude from the video's own motion in the same stretch (peaks
0.187 / 0.179 against 0.176 / 0.177); the lower floor catches them but is
buying sensitivity, not discrimination. (3) the mac audio tap is a bundled binary
that has never been through a signed mac `dist` — verify it with `codesign` on
the first one. (4) `salienceGate.ts` and its `SEI_GATE_*` env knobs are parked
unreferenced rather than deleted; either revive them or remove them.
