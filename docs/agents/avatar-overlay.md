# Avatar overlay (260804, grew out of the 260706 "call overlay")

The always-on-top overlay window is now the companion's desktop presence:
static portrait tiles or a per-character Live2D model, shown per
`avatar_mode` in UserConfig: `'off' | 'activity' | 'always'` ('activity' =
any live surface: call, chess, Draw!, backseat, MC summon; 'always' falls
back to the LAST-INTERACTED companion — the Home wall's `lastInteractionAt`
recency, not the open chat, so switching chats never swaps the desk
companion). The field is OPTIONAL with no default;
**read it only through `effectiveAvatarMode`** (characterSchema), which folds
the deprecated `call_overlay_enabled` boolean (`true` → `'activity'`) so old
configs keep their overlay without a migration. The player's own tile is
GONE; the overlay is AI-only. Design doc: `docs/design/avatar-v06-260804.md`.

- **Window** (`src/main/callOverlay.ts`): click-through by default with
  `setIgnoreMouseEvents(true, {forward: true})` so hover still reaches the
  page where the OS forwards (Win/mac only). Hover ALSO comes from main's
  cursor poll (261029): it pushes the pointer in window-local DIPs over
  `avatar:overlay-pointer-state` (every sample while inside, one on leave),
  and the renderer ORs it with DOM hover (`overlayChromeVisible`) and
  hit-tests the button column (`pointerOverRect`) to request clicks, all in
  `src/shared/overlayPointer.ts`. Never gate the chrome on DOM hover alone:
  the 261028 report (Live2D user, pencil never appeared) was forwarding not
  reaching the page, and the pencil is the only way into edit mode; Linux
  had no pencil at all before this. Interaction is
  split into VIEW and EDIT modes (260805; camera rework + per-region
  interactivity 260806): view cannot resize — hover shows the chrome buttons
  bottom-right, raised one button height off the bottom edge (pencil with
  the hold-to-drag move button above it, plus mute + captions while a
  call/backseat is live) and, for STATIC tiles only, the outline (a Live2D
  companion stays frameless until edit mode); clicking the pencil enters
  edit mode, where it becomes a tick and the window/character controls
  split: the corner handles are the ONLY way to resize the window
  (`avatar:overlay-resize`), the hold-to-drag button (both modes) is the
  ONLY way to move it, and the wheel + drag over a Live2D tile act on the
  CHARACTER instead — a per-character camera (zoom to half body/face, pan
  within the tile) streamed over `avatar:overlay-camera` and persisted in
  `avatar_overlay.cameras` (Live2DView applies it on top of the contain fit,
  in tile fractions so a framing survives resizes). **The character herself
  is click-through like the caption window** (260806): real clicks
  (`avatar:overlay-interactive`) are requested only while the pointer is
  over the chrome BUTTON COLUMN (a 160 ms leave-delay keeps the flag from
  flapping at its edge) or for the whole edit mode, so a click over the
  tile lands on whatever is under her. That is also why the drag button is
  ordinary chrome streaming screen deltas (`avatar:overlay-move`, mirrors
  the caption window's move) and NOT `-webkit-app-region: drag` — an
  app-region swallows pointer events, which would blind the column's
  enter/leave tracking. The window is
  **`resizable: false`**:
  a frameless resizable window keeps invisible OS resize-frame regions along
  its edges — exactly where the corner handles sit — and a click there is
  window-frame interaction (macOS ACTIVATED the app; the frame fought the
  handles' CSS cursor). All programmatic resizing is setBounds, which
  ignores `resizable`; the corner handles stream BOTH tile axes (free-form
  since 260807: `avatar_overlay.width` beside `size`, absent = square), so
  the window resizes into any rectangle — the Live2D tile contain-fits it,
  static portrait tiles stay square at the smaller axis. Both overlay windows also set
  **`acceptFirstMouse: true`** (260806): without it, the FIRST click into the
  window while Sei is not the active macOS app is an activation click — it
  raised the main Sei window and never reached the handle. Geometry persists in
  `UserConfig.avatar_overlay`, written by MAIN only (not renderer-settable).
  **Every SETTLED bounds change is clamped fully inside the matched display's
  work area** (`clampToWorkArea`, 260819: creation, display change, the resize
  stream, move END; the caption window's move end matches) — geometry
  persisted on a big monitor otherwise landed the window off-screen or bigger
  than a small screen, and off-screen chrome on a click-through window is
  unrecoverable by mouse. The move STREAM itself stays unclamped so a drag
  can cross displays 1:1 under the pointer; persisted tile sizes keep their
  requested values, so the full size comes back on a bigger monitor.
  `setContentProtection(true)` keeps the overlay out of every screen capture
  (including Sei's own backseat share), unless `UserConfig.avatar_in_captures`
  is on (260807) — the share picker's "Show avatar in screen recordings"
  toggle, OFF by default, applied to both overlay windows live from the
  `config:save` handler via `setAvatarCaptureVisible`. It is ONE switch because
  the underlying flag is one: `NSWindowSharingNone` / `WDA_EXCLUDEFROMCAPTURE`
  are per-window and drop the window from EVERY capture path, so "visible to
  OBS, hidden from backseat" is not expressible. Turning it on therefore means
  a companion sharing an ENTIRE SCREEN sees her own tile (a window share cannot
  contain another window, so that path is unaffected) and her blink/lip-sync
  can trip the colour jolt arm, whose 4x3 block split is exactly the scale of
  the tile. The alternatives, if that ever needs solving properly: mask the
  overlay rect out of `captureWorker.ts`'s cell AND thumb draws, or keep her
  off the shared display entirely (second monitor) and let OBS window-capture
  her. `backgroundThrottling: false` so
  Live2D animates under a fullscreen game. Tile size is CSS off the window
  height (`--tile`), so main's sizing and the renderer's layout cannot drift.
- **Call buttons + captions window (260806).** While `onCall` (voice call
  live/connecting or a backseat share; pushed by CallOverlayPusher with
  `muted` and the `lastSpoken` line), the overlay's chrome column grows a
  mute button (relayed `avatar:overlay-mute` → main broadcasts
  `avatar:mute-request` → the pusher flips `useUiStore.callMuted`, the mic's
  single source of truth, and the icon updates via the state re-push) and a
  captions button. Captions toggle a SECOND overlay window
  (`src/main/captionOverlay.ts`, `?captions=1` → `CaptionOverlay.tsx`): white
  companion lines over a darkened box, riding the same `voice:overlay-state`
  pushes (main enriches the renderer-pushed state with `cameras` +
  `captionsOn` before forwarding). The caption window is click-through ALWAYS
  outside edit mode (no hover chrome, plain `setIgnoreMouseEvents(true)` — the
  cursor works on whatever is under it); the avatar overlay's pencil relays
  edit mode over `avatar:overlay-editing`, which makes it interactive: corner
  handles resize, drag anywhere moves, +/- buttons step the font. The font
  size is FIXED by design — a line that does not fit is broken into chunks
  (`lib/avatar/captionChunks.ts`, pure + tested, CJK counted double) and paged
  at reading speed, so a bigger font just pages more often. The caption
  FOLLOWS THE VOICE (260806): chunks advance only while the speaker is
  audible, the linger after speech is short (1.5 s), and a confirmed barge-in
  clears `lastSpoken` outright (useVoiceStore onBargeIn) so an interrupted
  line's caption vanishes with the audio instead of paging on. Captions are
  OFF by default (main-side `enabled = false` until toggled). Edit mode also
  SUBSTITUTES for the live call in the caption window's show condition
  (260806): with captions enabled, entering edit brings the box up with its
  placeholder even off-call, so it can be positioned and sized before any
  call exists. Geometry + font + enabled persist in
  `UserConfig.avatar_captions` (MAIN-owned, like `avatar_overlay`).
- **Per-character prefs** (`UserConfig.avatar_prefs`, sparse like
  call_backdrop): `frame` ('circle' | 'square') + `always_bright` (kills the
  talking indicator: no idle dim, no ring) + `tab` (which profile sub-tab,
  Static or Live2D, was last chosen). Deliberately NOT in
  `character.metadata` — metadata cloud-syncs verbatim and is not editable on
  foreign characters. Edited from the profile's third tab (CharacterPage →
  Avatar → Static), which writes read-modify-write through `saveConfig`.
- **Live2D store** (`src/main/avatar/avatarStore.ts`): a model ZIP imports
  into `<profileRoot>/avatars/<id>/` (manifest.json + extracted tree),
  LOCAL-ONLY — nothing rides metadata, a character adopted elsewhere just
  falls back to the portrait tile. **Cloud seam (260819, upload side not
  built yet):** `cloudAvatarOf` in characterSchema reads an optional
  `metadata.avatar = {url, size_bytes}` descriptor (https only; malformed =
  null). When present and nothing is imported locally, the profile's Live2D
  tab swaps the upload box for a user-uploaded-content disclaimer (many free
  Live2D models forbid commercial use, so the copy must say Sei is not
  affiliated + point at Report; 'live2d' is a report reason, mirrored in the
  proxy's `REPORT_REASONS`) and a "Download (xx MB)" button — `avatar:
  download` resolves the URL from the character row IN MAIN (the renderer
  only names the character) and runs the fetched zip through the same import
  pipeline. The upload state carries a give-credit-in-your-description line
  for third-party avatars. Import NORMALIZES the stored model3.json
  because real VTuber exports ship expressions the settings never reference
  and sometimes no EyeBlink group (both measured on the first test model):
  it registers every `*.exp3.json`, ensures the EyeBlink group, maps
  expression names → the closed `AvatarEmotion` set by bilingual filename
  keywords (泪→sad, 害羞→shy, ...), and rejects traversal/junk entries. Zip
  filenames decode GBK-first (VTube Studio on Chinese Windows; cp437 is the
  spec fiction). **Every stored path is renamed ASCII-safe and all settings
  refs (Moc/Textures/Physics/Pose/DisplayInfo/UserData/Expressions/Motions)
  are rewritten to match** (`buildSafePathMap`): the plugin's FileLoader
  compares `encodeURI(webkitRelativePath)` against RAW refs, so any name
  encodeURI changes — non-ASCII, even a space — fails its existence check
  and the model refuses to load (measured: the moc3 itself "doesn't exist").
  Display names (manifest.name, expression Names) keep the originals, which
  is what the emotion table keys on. manifest `version: 2` marks a renamed
  store; `getAvatarManifest` lazily re-runs the same normalization over a
  v1 store's on-disk tree so early imports heal in place.
  Delete/remove-from-library/profile-import handle the dir like
  `knowledge/`.
- **Simple rig avatars (260817).** The same import flow accepts a second zip
  kind: `rig.json` + aligned full-canvas PNG layers (the chibi-rig pipeline's
  output, `~/slop/sei-studio/chibi-rig`), for characters without a real
  Cubism model. Detection is by content — no model3.json with a Moc but a
  rig.json present — and the manifest carries `kind: 'rig'` (absent =
  'live2d'); `parseRigSpec` in avatarStore validates the spec and the same
  ASCII-safe rename rewrites its refs. Rendering: hosts use
  `lib/avatar/AvatarView.tsx` (picks by manifest kind), never Live2DView
  directly; `lib/rig/RigView.tsx` is a 2d-canvas runtime implementing blink
  (160 ms triangle), the same speaking/levelRef mouth drive as Live2D (two
  open/closed patches with vertical squash), Live2DView's gaze
  (wander/cursor alternation + constant-speed glide) mapped to a head-group
  pixel translation, and damped spring followers for hair layers
  (`physics: {k, c}` per layer — hair chases the head, overshoots,
  re-converges at rest). Everything downstream (participant `live2d` flag,
  lip-sync level arming, cursor polling, overlay camera) works unchanged
  because the flag just means "has an imported avatar". Rigs have no
  expressions, so emotion/accessory plumbing no-ops on them.
- **Rendering** (`src/renderer/src/lib/live2d/`): pixi.js 7 +
  `pixi-live2d-display-lipsyncpatch` (cubism4), ALL dynamically imported.
  The proprietary Cubism 5 Core is fetched at build time by
  `scripts/fetch-live2d-core.mjs` into `src/renderer/public/live2d/`
  (gitignored — its license permits shipping it in the app, not committing
  it); `loadCubismCore()` script-injects it before the plugin import. Models
  load as in-memory `File[]` over IPC (`avatar:model-files`) — no custom
  protocol, no file:// fetches — with the manifest's entry file sorted FIRST:
  the loader picks its settings file by
  `find(name.endsWith("model.json") || name.endsWith("model3.json"))`, and
  VTube Studio extras like `items_pinned_to_model.json` match that sniff, so
  unsorted readdir order picked the wrong "settings" nondeterministically. Idle life: SDK breath/sway/blink run free on
  a motionless model (the EyeBlink group is why import guarantees it), plus
  gaze. **Gaze alternates between wander and following the real cursor**
  (260806): every 6-14 s it re-picks (45% cursor when the feed is fresh) —
  wander keeps the 2.6-7.5 s saccade cadence with correlated small steps +
  rare larger glances (full-range jumps every few hundred ms read as
  TWITCHING, the 260805 report); cursor-follow rides main's cheap
  `screen.getCursorScreenPoint()` poll (120 ms, armed whenever the overlay
  window is up since 261029 because it also feeds hover; the gaze push
  below is still sent only while a Live2D tile shows), pushed normalized
  around the window center over
  `avatar:overlay-cursor-state` — only the overlay window receives it, so
  the profile preview just wanders. **The focusController is fed a per-frame
  GLIDING target with `instant=true`, never a stepped one** — the SDK's
  FocusController pursues its target at constant speed (~5.3 units/s,
  decelerating only on arrival), so the old direct saccade retargets (mean
  ~5 s) yanked the face ahead for about a second mid-drift: the "jitters
  every ~5 seconds" report. The glide is CONSTANT SPEED (0.9 units/s, easing
  only in the last 0.06 units — 260806, was a 450 ms time constant: at
  constant TIME a big glance whips and a small one crawls; at constant speed
  travel time scales with distance) and is the sole focusController writer,
  which also makes the wander/cursor mode switches glide. The mouth and the gaze are written
  INSIDE a wrapped `motionManager.update` so the SDK layers blink/breath/
  physics after them in the same frame.
- **Lip sync**: TTS plays in the MAIN window, so `avatarLevelTap.ts` samples
  the clip there (RMS envelope, ~25 Hz) and relays `{id, level}` via
  `avatar:overlay-level`. **An element can only ever have ONE
  MediaElementSourceNode** — the tap reuses pitchBus's node when the clip is
  pitch-shifted (`pitchSourceFor`) and builds its own only otherwise, and it
  is armed by the pusher ONLY while a shown participant is actually Live2D
  (rerouting rate-1 clips through WebAudio is not free). No levels arriving
  while `speaking` is true → the tile pseudo-envelopes rather than freezing.
- **Expressions at speech time**: `classifyEmotion` (bilingual lexicon,
  `lib/avatar/emotion.ts`) runs on the line at first-audible
  (lastSpoken/lastSpokenId), ships in the overlay push, maps through the
  manifest's emotion table, and lives for 150% of its line: it holds while
  the line plays and lingers half the line's duration after it ends
  (EXPRESSION_LINGER_FRACTION), refreshed early by the next emotive line —
  never a fixed clock, so a quip flashes and a story holds. Deliberately not
  LLM-driven in v1 (tags would touch every surface's prompt contract); the
  upgrade replaces that one call site. Two fixes make it actually visible
  (260806): (1) an unmapped emotion borrows a mapped neighbor
  (`resolveEmotionExpression`, `EMOTION_FALLBACKS` — happy↔excited,
  surprised→excited, love→happy; negative emotions never substitute) because
  real VTuber exports rarely ship a happy/surprised face and those are the two
  classifications casual talk fires most — without the fallback the face
  almost never changed; (2) after the decay-reset, Live2DView writes
  `currentExpression = defaultExpression` on the ExpressionManager, because
  the plugin's `resetExpression` deliberately keeps `currentExpression` and
  `setExpression` refuses the current name — so the SAME emotion twice in a
  row (i.e. most sessions: happy, decay, happy) applied once and then never
  again. Both verified in the browser harness against the real model.
- **Accessory toggles (260806)**: the emotion-UNMAPPED expressions are item
  toggles (Snow Bear Girl: hat, phone, mic, controller, coat), now flippable
  per character from the profile Avatar → Live2D tab and persisted as
  `manifest.accessories` (`avatar:set-accessory` → `setAvatarAccessory`; main
  broadcasts the manifest on `avatar:manifest-state` so live views re-apply
  without reloading). They CANNOT ride the expressionManager (it holds ONE
  expression; the next emotion would knock the hat state off), so
  Live2DView resolves each toggled expression's exp3 params to ABSOLUTE
  targets against the model's parameter defaults
  (`lib/avatar/accessoryParams.ts`, pure + tested; Add/Multiply/Overwrite
  composed in order) and writes them every frame inside the wrapped
  `motionManager.update`, like the mouth. Two details are load-bearing:
  Cubism params persist frame to frame, so a toggle-OFF must write the
  dropped params back to their defaults once or the item sticks forever;
  and the v1→v2 manifest heal carries `accessories` over while a fresh
  import resets them (new model, new names). Sui's model ships "1 帽"
  (Key1 hat -1, Key22 crown +1): toggled ON = the author's no-hat crown look.
- **Pusher** (`components/CallOverlayPusher.tsx`): mode + activity stores →
  `computeAvatarIds` (pure, tested) → `voice:overlay-set`. Zod in
  `main/ipc.ts` must name every participant field the overlay renders
  (undeclared keys are STRIPPED — the backseat gridSmall lesson).
