# Call scenes + the backdrop toggle (260730)

A voice call has two views now, switched by the mountain pill beside
mute/deafen (`CallControls`, opt-in via props so GameSurface's in-game cluster
keeps its original three): the avatar tiles, or the character filling the
window. Sui is the first and currently only character with a real SCENE (her
onboarding grass field); everyone else's backdrop is their own art.

- **Scenes are DATA, not a special case.** `src/shared/callScene.ts` is the
  descriptor (backdrop layers split `back`/`front` with the actor sandwiched
  between, plus actor poses `idle`/`talk`/`walk`, rest position, entrance);
  `renderer/src/lib/callScenes.ts` is the registry + resolver + pure geometry;
  `components/call/CallScene.tsx` is the generic renderer. The whole point of
  the seam is that user-authored scenes only have to produce a descriptor —
  `resolveCallScene` starts reading `character.metadata` and nothing else
  changes. Every visual slot is one `ScenePaint` union (`images` cycled on a
  timer, or a `video`), so "scene image/video" and "talking animation
  image/video" are the same thing to the renderer.
- **Every pose degrades.** Only `idle` is required: no `walk` fades in at the
  rest position, no `talk` stands and speaks. The customization UI will let
  people upload one image and nothing else, and that has to work.
- **The `back`/`front` split is load-bearing.** Sui stands ON the ground art
  but BEHIND the grass tufts, which is what makes her read as in the field
  rather than pasted on it. Any scene with foreground detail needs the seam.
- **SCALE LOCK,** inherited from `onboard/OnboardScene.tsx` and for the same
  reason: layers and sprite live in ONE fixed-aspect stage that covers the
  window bottom-anchored, so both scale by one factor. Sui's 66% width is not
  framing taste, it is the size at which her line weight matches the layer
  art's. All descriptor positions are stage FRACTIONS, never px.
- **The choreography, and why the order matters.** The backdrop is up the
  instant the call view mounts (pressing call must land you somewhere; waiting
  on a connection would make the scene read as a loading screen). The character
  waits off-stage and walks on when the call goes LIVE, so the walk reads as
  her answering. Her first line waits until she has ARRIVED — otherwise she
  greets you from off-screen mid-stride.
  Only a call that is ALREADY LIVE at mount may skip the entrance. The first
  cut tested "status is not connecting", which meant every dial skipped it and
  she was simply drawn standing: pressing call mounts the screen and dials from
  an effect, and child effects run before the parent's, so the store still says
  `idle` for one tick. For the same reason the error/idle release must fire on a
  TRANSITION, not on the mount value.
- **`speakingId` now means AUDIBLE, not queued (260730).** It used to be set
  when a line reached the audio queue's playhead, which for a streamed clip is
  before the TTS request has even been sent: the whole synthesis round trip sat
  between the signal and the first sample. Every visible sign of speech in the
  app was therefore early — the avatar rings on all five call surfaces, the
  caption, and (where it became impossible to ignore) the scene's talking
  animation. `useVoiceStore` now publishes the START of speech from the queue's
  `onAudible` callback, which already existed for the barge-in grace window and
  now carries the speaker and the line; only the STOP still comes from
  `onSpeakingChange`. The dictation half-duplex hold deliberately stays on the
  SLOT (see the comment there) — the synthesis gap must keep the stiffer barge
  bar. So: anything the player SEES follows `onAudible`; anything arbitrating
  the microphone follows the playhead.
- **The greeting gate reuses the buffer that already existed.**
  `useVoiceStore.introHold` (+ `setIntroHold`) extends the `'connecting'`
  buffering window that `flushPendingCompanionLines` already drains; the
  greeting is still fired at dial time and generated during the ring, nothing
  is regenerated or dropped. THREE layers keep a scene bug from muting a call:
  `CallScene`'s timer backs up its own `transitionend`, `CallSceneHost` drops
  the hold on error/idle/unmount, and `setIntroHold(true)` arms an
  `INTRO_HOLD_CAP_MS` (8s) auto-release.
- **No scene? The character's art,** full-bleed, painted `cover` and draggable
  vertically (`CallBackdrop` + the pure maths in `lib/callBackdrop.ts`). One
  `cover` rule covers both pane shapes: on a wide window a portrait is
  width-driven and overflows vertically (the "fit to width, drag up and down"
  case), and in a narrow split column it flips to height-driven and simply
  fills instead of letterboxing. Drag maps px→`background-position-y` % through
  the real overflow so the art tracks the cursor 1:1. Characters with no
  uploaded art fall back to their procedural portrait as pixelated wallpaper.
- **Group calls never get a scene** (a scene stages ONE actor): they always get
  split art, one equal column per participant, with the non-speaker dimmed
  since the portraits that used to say who is talking are gone. Adding a
  participant to a live scene call unmounts the scene into the split, and the
  unmount releases the intro hold.
- **The preference is per-character and SPARSE.** `UserConfig.call_backdrop` is
  a `Record<characterId, boolean>` keyed on the DIALED character
  (`participants[0]`), hydrated into `useUiStore.callBackdropByCharacter`. An
  absent key means "never chosen", which is NOT false: a character with a scene
  opens in it, everyone else opens on the tiles. Writing false for every
  character on first call would flatten that, which is why the Zod field has no
  `.default({})` either.
- **Chrome hides in backdrop mode.** Name, status and the control pills
  collapse into one bar revealed on pointer-proximity to the bottom edge (the
  same reveal GameSurface uses), always shown while not live so a ringing or
  failed call is never un-hangupable. Captions and the STT-fallback offer stay
  visible — an accessibility aid you have to hover to read is not one.
  `.stageBackdrop` sets `isolation: isolate` because positioned children paint
  above static siblings, so without a stacking context the art would cover the
  captions it sits behind. The bar has **no panel behind it** — a box cuts a
  rectangle out of the picture the mode exists to show. What separates it from
  the art instead is a drop-shadow plus a theme-INDEPENDENT treatment for
  anything sitting on top: `CallControls`' `onArt` variant (fixed dark scrim,
  white icons, hang-up keeps its red) and white chrome text. The theme's own
  colours are chosen against the app's surface, so on art they fail one way in
  light and the other way in dark. Same reasoning the share view uses when it
  paints its own chrome over someone else's screen.
