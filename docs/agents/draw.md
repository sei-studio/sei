# Draw! minigame (260727)

Turn-based sketch guessing, launched from the "Play together" tiles. **Mutually
exclusive with a Minecraft summon and with chess** per character (the shared
`lib/gameLaunch.ts` gate).

- **Shape:** always `ROUNDS` (3) rounds (the intro game below is the one
  exception); the 1-5 setup chooser was removed
  260728, since it is a choice nobody has the information to make before their
  first game and does not want to make again after it. MIN/MAX survive only as
  the bounds main clamps an incoming `drawStart` to. Each ROUND is two
  TURNS: the player draws while the character guesses, then the character draws
  while the player guesses. Every turn is capped at `TURN_MS` (3 min) and ends
  early the instant the guesser says the word. Contract:
  `src/shared/drawIpc.ts`. Before each of the PLAYER's turns a `'pick'` phase
  offers `WORD_CHOICES` (3) words and the turn clock does not start until they
  choose (`beginTurn` sets the phase, `startDrawingPhase` arms the clock, and
  `pickDrawWord` is the only thing between them). The character is dealt its
  word directly, so `wordChoices` in the pushed state never reveals anything it
  drew. "Play again" returns to the setup screen (`drawNewGame`) rather than
  restarting in place, so the player lands somewhere they can stop.
- **The intro game (260929).** Real usage: 12 of 18 games abandoned, 4 at 0
  turns about 70s into the player's own first drawing turn. So until a
  player has watched the character's intro turn end
  (`UserConfig.draw_intro_done`, main-owned, set by `markIntroSeen` in
  `endTurn` on a guess or timeout of the first drawer's turn, NOT on game
  completion: quitting during their own turn after it still retires the
  intro, else a player who always left there got the intro forever), the
  game is the intro: `INTRO_ROUNDS` (1) round, and the CHARACTER draws first
  (`Session.firstDrawer`), with one system line telling the player to type
  guesses. Main decides it when the session is created and says so in
  `DrawGameState.intro`, so the setup copy matches; Start keeps the setup
  screen's verdict, and "Play again" or a Start after `Session.introSeen`
  is always a normal game (a quit or the credit wall during the character's
  turn leaves the intro in place). Turn order lives in `turnOrder.ts`
  (`nextTurn` / `isLastTurn`): never test "the character just drew" for
  game over again. The contract block says the character goes first only
  in the intro. Model-facing intro text (`introModelText`) names the
  player, or says "the player" when no name is set; never "they".
- **Turn analytics (260929).** `draw_turn_ended {round, rounds, turn_number,
  drawer, phase: pick|drawing, outcome: guessed|timeout|abandoned|
  account_switch|credit_wall, turn_ms, strokes, guesser_lines, intro,
  paused}` fires when a turn resolves AND for the turn that was live when
  the game was quit, switched away from or ended at the credit wall (a
  `pick` row = the player never chose a word). `turn_ms` on a
  guessed turn is the guess latency. Not a session event (no `duration_ms`).
  `draw_game_started/_ended` also carry `intro` and `first_drawer`, and
  `_ended` the `phase` it stopped in.
- **The chat log is a PROMPT, and it used to leak (260728).** Every system line
  is replayed verbatim into the character's next call, so
  `"Round 1 of 3. Your turn to draw: horn."` did two things at once: handed the
  GUESSER the answer, and read as second-person instruction to the model, which
  is why the character believed it had drawn the player's words and
  misattributed whole rounds. Fixed with `DrawChatMessage.modelText` — an
  optional third-person, secret-free wording that `renderChat` prefers and the
  renderer ignores. **Any new system line written in the second person, or
  naming a live word, MUST carry one.** `drawPrompts.test.ts` pins this. The
  same call sites also now get an explicit `roundsRecap` (who drew what, who
  got it) in all three turn blocks, because chat only ever implies attribution.
- **The instructions go BELOW the chat log, and every block ends on the role
  (260728).** The recap above was not enough on its own, because the chat
  sections were appended to the END of each turn block and they are the biggest
  thing in it: the last text the model read before answering was chat from the
  PREVIOUS turn. Live capture: the character guessed the player's drawing
  correctly, and its turn-end line was "hehe ok you're reading these too fast,
  that's not fair" — a drawer's frame, continued straight out of the banter
  sitting at the bottom of the prompt, while `YOU GOT IT` sat 2000 tokens above
  it. `contextSections()` now emits recap + chat (chronological) FIRST, and each
  block closes on one line naming the role ("Right now: you are GUESSING..."),
  pinned by `drawPrompts.test.ts`. Applies to any new turn kind.
- **Game surfaces do not get the chat baseline (260728).** `buildSystemBlocks`
  takes `surface: 'chat' | 'game'`; Draw! and chess pass `'game'`, which swaps
  `CHAT_BASELINE` for `GAME_SURFACE_BASELINE` (`promptLibrary.js`) and drops two
  chat-only tails: the timestamped-messages note and the Minecraft
  connection/`launch()` status block. The old prompt told a character sitting at
  a canvas "This is a text chat, not a game... your text output IS the message
  the player reads, like a real person texting", and it showed: it talked about
  the player "reading" its drawing and said "waiting for you to read this lol"
  mid-turn. It was also being briefed on a `launch` tool no game surface passes.
  Backseat and voice stay on `'chat'`.
- **Two things that baseline swap broke, and their fixes (260728).** Worth
  knowing before writing any new surface baseline. (1) `CHAT_BASELINE` ended
  with "like a real person texting", and that was the ONLY thing in the whole
  prompt telling the model its output was unformatted. The replacement said
  "not like someone texting", and Haiku started emphasising its guesses ("is it
  a **hearing aid**?") to match the markdown of the prompt around it.
  `GAME_SURFACE_BASELINE` now bans markup outright AND `plainLine()`
  (`src/main/chat/plainLine.ts`) strips it on the way out, the same
  deterministic backstop the bot has had since 260615 in `postProcessSay`.
  Wired into Draw!'s three emit points; chess, backseat and chat still pass
  markup through. (2) The role sentence that closes every turn block names the
  player, so the LAST thing the model read was their name in the third person,
  and it began calling them by name in chat instead of "you". Fixed in the same
  recency slot: the closer now carries "say you, never their name", and the
  contract block repeats it.
- **The drawer's own word never reaches chat.** `saysWord` (the tolerant
  redaction pattern asked as a question) drops the line WHOLE for both sides and
  posts a system line in its place; the character additionally reads "you are
  drawing it, not guessing it, do not respond". The old behaviour patched the
  word to `[...]` in place, which still pointed at exactly where the answer went
  and read as a bug rather than as the game stepping in.
- **Guessing is literal, not semantic.** `matchesWord` (`guessMatch.ts`) is
  whole-word containment in any sentence, forgiving only case/punctuation, a
  trailing plural on either side, and a closed-up two-word answer ("hotdog").
  Fuzzy matching was rejected deliberately: the guesser cannot tell why a
  near-miss counted. `redactWord` is the backstop that keeps the DRAWER from
  handing the round away.
- **Own canvas, no dependency.** tldraw's SDK is not free, Excalidraw is far
  too heavy, and `perfect-freehand` gives variable width where the game wants
  one thickness. The real requirement was a stroke DATA model (needed for the
  stroke eraser, snapshots, playback and export), so it is hand-rolled:
  `drawRender.ts` is the single painter shared by the live canvas, the snapshot
  the character looks at, and the gallery PNG.
- **The character's GUESSING turn** rides a 500ms poll over a PURE policy in
  `guessSchedule.ts` (3 strokes since the last dispatch, or 10s; never within
  5s of the previous guess COMPLETING; single flight). "At most one queued
  guess" needs no queue: strokes drawn during an in-flight call leave the
  counter high and the single dispatch that follows resets it. Two edge cases
  are load-bearing and tested: an UNCHANGED canvas never reaches the model (the
  snapshot PNG is hashed), and a LONG single stroke still triggers (the
  snapshot includes the in-progress stroke, so no committed stroke is needed).
- **The character's DRAWING turn** is a real tool-use thread on `s.draw.thread`
  carried across hops, NOT a fresh call per hop. A picture needs more strokes
  than one response returns (the model stops on `tool_use`), and without the
  thread it re-starts the picture every hop, because "you have drawn 4 strokes"
  says nothing about WHERE. The `pen` tool is adapted from tldraw's
  agent-template `PenAction` (MIT), narrowed to `{intent, points, style,
  closed}` — no colour, no fill, no ids, since black-at-one-thickness is all
  either player gets.
- **The drawer gets EYES, rationed (260728).** It used to draw blind: the
  guesser was sent a real snapshot every few seconds and the drawer got the
  sentence "3/16 strokes used". So it could not tell that its picture was two
  overlapping blobs filling a tenth of the page, and it stopped after three
  strokes with two minutes left because it believed it was done. Now a hop woken
  by a player line attaches a snapshot of the character's OWN canvas
  (`selfLookNote`), rationed like the guess scheduler: only when the player just
  said something, and never twice inside `SELF_LOOK_COOLDOWN_MS` (12s). It comes
  with a `clear` tool (wipe and start again, `MAX_CLEARS` 2 per turn, bumping
  `DrawGameState.clearSeq` so the renderer drops its locally revealed strokes
  without ending the turn) because a model that cannot pick a stroke to erase
  needs all-or-nothing. The stroke guidance is a FLOOR now ("at least 6, do not
  stop before the outline and the main internal structure exist"); it used to
  read "16 at most, and fewer is usually better", which is a ceiling plus a nudge
  downward, and the character took it. A clear is a promise to redraw IN THE
  SAME TURN, and relying on the model to keep that promise down a long thread
  kept failing live (260728's single blank-nudge hop was not enough either). So
  260729 ports the web engine's RESTART design: a clear that is not followed by
  a redraw in the same response RESETS the drawing thread, and the next call
  opens fresh on a `DrawRestart` block ("the page is blank, start again")
  carrying the wiped attempt's own stroke `intent` strings so it draws the word
  a DIFFERENT way instead of the same picture twice. The engine also wipes a
  failed picture itself (auto-clear: `AUTO_CLEAR_WRONG_GUESSES` 6 wrong lines,
  once per turn, only past `AUTO_CLEAR_MIN_STROKES` and with
  `AUTO_CLEAR_MIN_LEFT_MS` left) — waiting for the model to decide to clear was
  measured optimistic. A text-only response on a BLANK canvas (cleared or
  never-drawn) gets a bounded corrective hop (`blankNudges` <= 2, reset per
  wipe) folded into the next user note before the turn may park.
- **The drawing turn has an idle backup (260729, from the web).** A parked
  runner (done, or out of strokes) used to wake ONLY on player chat, so a
  silent player meant the character sat on a three-stroke picture for the rest
  of the turn — the "no changes to drawing for 30 seconds" bug. The AI turn's
  free poll slot hosts `tickDrawIdle`: after `DRAW_IDLE_NUDGE_MS` (30s) of
  quiet (not inside the last `DRAW_IDLE_FLOOR_MS` 20s), the runner re-enters
  with `idleNudge`, which bypasses the park conditions for exactly one hop,
  attaches fresh eyes on its own canvas, and says "they have not guessed it
  yet: add the giveaway detail or clear and draw it differently". The
  guesser-side `UNCHANGED_NUDGE_MS` also dropped 30s -> 10s (equal to the time
  trigger) so a paused player still hears something every ~10s.
- **The game is the referee (260729, from the web).** Live, the character told
  the player a wrong guess was right ("yes! that's it!") and invented a round
  change, because nothing said the engine adjudicates. `drawContractBlock` now
  states it (never declare a guess correct, never write a `[game]`-prefixed
  line), the drawing turn restates it, the pending-chat note says every line
  already failed the check, and `isFakeGameLine` drops fabricated `[game]`
  lines at all three emit points as the backstop.
- **The character's lines wait for their strokes (260729, from the web).**
  Main pushes chat the instant the model emits it, but stroke reveal plays at
  hand speed, so "you've got all the parts there" used to land while the canvas
  was two strokes in. `DrawCanvas` exposes a playback-barrier seam
  (`DrawCanvasControl.queueBarrier`): DrawScreen holds each of the character's
  drawing-turn lines behind a barrier queued at arrival, released when playback
  reaches it. Barriers FIRE on turn reset rather than vanish, so a held line
  can never leak.
- **Chat routing + voice calls (260729).** While a Draw! game is live
  (`drawing`/`turn-end`), `chat:send` routes into `drawService.handlePlayerChat`
  exactly as chess does — which is also how a line DICTATED on a live voice
  call lands in the game as a guess. The reply comes back over the draw:state
  push, so the handler returns `{replies: [], streamed: true}`. On a live call
  every line the character says in the game is additionally pushed as a
  `voice: true` chat message (`speakOnCall`) — spoken by the renderer, never
  rendered, and deliberately NOT persisted (the per-line game chat stays out of
  the transcript). Calls are NOT exclusive with games: `isGameSurfaceOpen`
  (callLaunch.ts) and CallMiniBar's `gameActive` both count Draw! and backseat,
  so the phone starts the call in place and ending the game returns to the
  fullscreen call view.
- **Game chrome (260729).** The Draw! page carries the same universal bottom
  button row as the chat-hosted surfaces: `GameChromeRow`, extracted from
  GameSurface — fullscreen toggle, the call cluster (or the phone chip that
  starts a call when none is running), and the unified end "x" with the
  end-game confirm. The old top-right corner fullscreen/x buttons are gone.
- **Mid-turn hops re-state the address rule (260728).** The drawing turn's
  opening block closes on "say you, never their name", but by hop five that
  line is thousands of tokens up the thread and recency wins (the same failure
  contextSections exists for): live, mid-drawing scratchpad lines like
  referring to the player as "they" landed in chat. Every hop's user note now
  ends on the address rule + "you have NO private channel", the contract block
  bans "they/them" and inner monologue outright, and both turn-block closers
  say `never their name or "they"`.
- **Humanization** (`strokeHumanize.ts`) resamples, offsets along the normal by
  smooth noise, overshoots the end, and samples playback timing. It is seeded
  from the stroke id and therefore DETERMINISTIC — the gallery and the exported
  PNG must redraw exactly what the player watched appear.
- **Streamed playback:** strokes leave on `draw:ai-stroke` as their tool_use
  block completes, so the first stroke is on the player's canvas seconds before
  the model has finished the picture. `strokes` in the pushed state is
  deliberately NOT authoritative during the character's turn (main knows the
  whole picture early); the renderer reveals from the push and snaps to state
  at turn end. Same idea as the chess reveal gate, without the ack.
- **`word` is never sent to the guesser.** `visibleWord()` returns it only
  while the local player is drawing, or once the turn has ended.
- **Continuity (260728):** both turn kinds offer `remember()` (tool_result note
  on the drawing turn's loop, honored inline on the single-shot guessing turn),
  and `finishGame` writes one play row naming the words each side drew, then
  fires `foldIfDue`. The per-line game chat is deliberately never persisted.
  See the continuity contract below.
- **UI:** `src/renderer/src/components/draw/` + `useDrawStore`. It is a
  full-page ROUTE (`{kind:'draw'}`, IconRail KEPT; only in-app fullscreen drops
  it), not a chat-screen aside,
  because the game wants canvas-beside-chat and a white handdrawn register.
  `draw.module.css` is a **deliberate, documented exception** to the
  tokens.css rule: it declares a scoped palette on `.root` instead. Three rules
  hold the surface together, and each one was a bug before it was a rule
  (260728):
  - **ONE INK.** Black on white and nothing between. No hairlines, no dimmed
    captions, no soft placeholder, no green "correct" text. Anything that needs
    to recede does it by being small or by being said once. The only
    non-monochrome value is `--accent`, and it is a highlighter that only ever
    sits BEHIND black text.
  - **TWO SIZES.** `--fs-title` and `--fs-body` are the whole handwritten
    scale. That face has no weights to grade with, so a third size reads as a
    mistake rather than as hierarchy. The typed half (Roboto Mono, Apache-2.0,
    self-hosted, Draw!-only) is a separate voice at one much smaller size
    (`--fs-typed`), used for the game's own apparatus: round counter, clock,
    system lines, speaker names. Both faces use ordinary letter casing.
  - **ONE PEN.** Every line is `--hand-stroke`, republished by `DrawCanvas` onto
    the surface ROOT (not its own parent) so the rules, chat box and buttons
    track the canvas scale instead of drifting onto a static fallback. Nothing
    may use `text-decoration: underline` (use `SquiggleUnderline`), a CSS
    border, or a native control that draws its own track — an
    `<input type=range>` is why the round chooser is gone. `-webkit-text-stroke`
    corrects the TITLE only: applying it to body text was tried and reverted,
    because at 22px it does not read as a heavier pen, it reads as bold.
  - **THE START PAGE DOODLES ARE VECTORS, NOT IMAGES.** They are shown at three
    different sizes (crown small, shrimp and horse large), and a scaled bitmap
    scales its line weight with it, which lands three different pen widths on a
    page whose whole premise is one pen. So `doodles.ts` holds their
    CENTRELINES, generated by `scripts/trace-doodles.py` (threshold, Zhang-Suen
    thinning, spur pruning, graph walk, Ramer-Douglas-Peucker), and `Doodle.tsx`
    draws them with `vector-effect: non-scaling-stroke` so `stroke-width` means
    screen px: geometry scales, stroke does not, and the width is
    `--hand-stroke` like everything else. Two traps that cost real time and are
    worth knowing before touching that script: `Image.convert('L')` DISCARDS
    alpha, so a transparent-background source reads as solid ink and the trace
    comes back as the bounding box; and an 8-connected skeleton has redundant
    diagonal shortcuts that look like junctions, which shreds every stroke into
    crumbs the length filter then deletes. Both are handled and commented.
  - **THE YELLOW IS A HIGHLIGHTER.** `--accent` only ever sits BEHIND black,
    never as a text colour, and its shape is `SquiggleHighlight` (a rough,
    bleeding blob, `rect` or `ellipse`) rather than a CSS background. A filled
    rectangle is the one shape this surface does not draw. It is always mounted
    and revealed with opacity, because `:hover` cannot mount a component and
    re-seeding the shape per pointer-entry makes it crawl. Anything that must
    stay readable on top of it needs `.btnLabel` — a bare text node has no box
    to raise above an absolutely-positioned sibling. On a winning guess the
    swipe sits behind the WORD, not the sentence (260728): main locates it
    (`findWordMatch` in `guessMatch.ts`, the same token walk as `matchesWord`
    with raw-text spans) and ships `DrawChatMessage.correctRange`; the
    whole-line swipe survives only as the fallback when the span is missing.
- **The saved PNG is a square share tile,** not a screenshot of the page: a
  big centred lowercase `draw!` on the yellow highlighter blob (260729; the
  web tile says `draw! with sui` because it fronts one character — the app
  tile stays just `draw!`), a row per player with the art scaled to whatever
  fits 2 x rounds cells, `sei.gg/draw` bottom right, and NO score (the same
  reasoning that keeps results out of the play row). Cell size is the smaller
  of the width-fit and height-fit, which is what stops one round producing two
  enormous cells. The on-screen gallery matches (260729, from the web): no
  header, scores in the row names, guessed words on the highlighter, cells a
  flex row hugging height-driven art (a 1fr grid left a moat of slack). The
  bug that motivated the redesign: the gallery reused the game view's `.score`
  class, whose `height: 100%` made a one-line paragraph swallow the page and
  starve the `flex: 1 1 0` rows to zero — the "empty gallery". It previously rendered a magnified crop of each
  drawing's corner: `paintStrokes` resets the transform outright, so a caller
  that translated first had its translate discarded and got clipped to where it
  meant to paint. Pass `PaintOpts.translate` instead of translating first.
  "Save to Downloads" confirms with an in-page popup (260728): "Saved!", the tile
  itself, and an x button. It is anchored to `.gallery` (position: relative) so
  the paper-toned backdrop never covers the IconRail, and it opens only after
  the file is actually on disk — `useDrawStore.saveGallery` resolves the
  written path (null on failure) precisely so the popup cannot claim a save
  that did not happen.
- **A single drawing saves too (260801, ported from the web).** Clicking a
  gallery cell composes `composeCellPng` — the same square sheet, pen and
  credit line as the game tile, carrying ONE drawing large with the caption
  "according to {name}, this is a {word}." on two lines, the word on the
  highlighter. The game tile is a set of thumbnails, so the one round somebody
  actually wants to post came out of it at a fraction of the resolution. Two
  details are load-bearing: the caption arrives from the component ALREADY
  localized but with `{word}` still in it (the composer has to know where the
  word sits to put the highlighter behind it alone, and `t` lives in React);
  and the drawer is named, not "you", because the file is made to leave this
  machine — the same reason the exported game tile's rows use real names while
  the on-screen sheet says "you". The popup is now shared: the whole-game save
  opens it as a confirmation ("Saved!"), a clicked cell opens it as a preview
  with the save still to offer. An empty round is inert, not a button that
  does nothing, and the affordance on a played one is the cursor alone (a
  hover tint would be a second ink).
