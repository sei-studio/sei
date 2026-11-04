# Guided first moment (260926)

A new player's first session ends in their companion's chat, with the
companion greeting first and one concrete next step under the greeting. Before
this, onboarding landed on Home: 24% of new installs never used any surface.

- **Who gets it.** `firstMomentCompanion(res, suiId)` (`lib/firstMoment.ts`)
  in `App.tsx` `handleOnboardComplete`, only on the `res.tutorial` branch (a
  NEW player; the returning-user / `accountHasProfile` route passes
  `tutorial:false` and never arms). The companion is the generated one, else
  Sui. Every backend works: the greeting is the ordinary first-meeting turn on
  `buildLlmProvider()`.
- **Flow.** `useFirstMomentStore.arm(id)` starts a Minecraft install probe.
  The tutorial still runs; its end (`TutorialOverlay.finish` ->
  `enterFirstMoment()`) navigates to that companion's chat instead of Home.
  `useChatStore.load()` on the empty transcript asks `greetingOptions` (waits
  at most `MC_PROBE_WAIT_MS` for the probe) and passes
  `chatOpened(id, {firstMoment: {primary}})`; main adds
  `thoughtFirstMoment(primary)` after `THOUGHT_FIRST_MEETING`, so the greeting
  (which already knows `preferred_name`) ends on the invitation. After the
  whole greeting is revealed the store goes `ready` and `ChatScreen` renders
  `FirstMomentCard` at the end of the message list (hidden while the tour is
  active or a game is open). The full tour opens the chat at its say-hi step,
  so the greeting can land mid-tour; the card waits for the tour to end.
- **Buttons reuse existing paths.** Chess and Minecraft go through
  `requestGameLaunch` + `openGame` (the Play together tiles), Backseat through
  `requestGameLaunch` + the top bar's cold `share-screen` picker (confirming a
  source starts the call too), the call through `startOrOpenCall`.
- **What leads (261023).** Backseat leads ("Show me your game"), then
  Minecraft when offered, then chess, then the call. Minecraft leads instead
  when a LAN world is open, and is offered at all only then or when an install
  was detected. Backseat is left off (and chess leads) only when the vision
  probe says the model cannot see images (`visionBlocked`, same rule as the
  top bar button). Why: on fresh 0.6.8 installs (10-10..10-22, n=307 real) the
  card led with chess for 255 of 258 people and chess was tapped 13 times;
  Backseat was the first activity for 80 people (Minecraft 27, chess 15)
  without being on the card, and /ai-backseat-gamer is the top download page
  after the home page. 20 people
  finished onboarding and never used anything; 14 of them saw the card and
  left without tapping it (~/suisei/reports/onboarding-funnel-2026-10-23.md).
  `thoughtFirstMoment('backseat')` makes the greeting invite a screen share.
  Primary styling is borderless: an art tile lifts on `--shadow-pop`, an icon
  tile takes the accent fill.
  "Not now", any tile, or the player typing a message instead (`typed`)
  retires the card for the session. Nothing persists; an account scope change
  resets the store. LAN state is read from main at planning time (the state
  main's greeting turn sees), falling back to the renderer's cached copy.
- **Failure is silent.** An existing transcript, a chat already loaded this
  app session (`already_loaded`), a message typed before the card was up
  (`typed_first`), an empty greeting, a thrown greeting call or a planning
  error settles the store as `failed`: the plain chat, no card, no error.
  Main pushes the greeting's thoughts only after `prepareChatTurn` succeeds,
  so a failed prep cannot leave "a button will appear" queued for the
  player's first message. The one-time games tip is held back while the
  moment is pending or showing (`shouldShowGamesTip.firstMomentLive`).
- **Analytics (shape only, renderer `sei.track`):** `first_moment_shown
  {primary, minecraft_offered, backseat_offered, companion: sui|generated}`,
  `first_moment_action {action: backseat|chess|minecraft|call|dismiss|typed,
  primary, ms_since_shown}`, `first_moment_fallback {reason}`. Not session events, so
  nothing to add to `SESSION_EVENTS`.
- **Verify in a tab:** `?dashshot=chatfirst` (Backseat + Minecraft + chess +
  call), `&nomc=1` (no Minecraft), `&lan=1` (Minecraft leads), `&novision=1`
  (text-only model: chess leads, no Backseat). The harness greeting is
  a stub; the live greeting's wording is the model's.
