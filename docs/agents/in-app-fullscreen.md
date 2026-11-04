# In-app fullscreen for game surfaces

The fullscreen control on a game surface means **in-app**, not OS window
fullscreen (260728: it used to call `window:fullscreen-toggle`, which took over
the whole display and was awkward to undo). It gives the mounted game every
pixel the app window has: the IconRail goes, the chat goes, and (260729) the
ChatTopBar goes too — the top bar's own load-bearing buttons (call, end) live
in the game's bottom chrome row (`GameChromeRow`), so nothing up there is
needed while it is hidden.

State is `useUiStore.gameFullscreen`, and the rule for any NEW game surface is:

- the mounted surface OWNS the flag: it sets it, and **clears it on unmount**
  (`useEffect(() => () => setFullscreen(false), [])`). That is why
  `App.tsx`'s `railHidden` needs no per-view test and the rail can never stay
  hidden after the game is gone;
- games hosted in the chat screen's game area get it for free through
  `GameSurface`; a full-page game route (Draw!) mounts `GameChromeRow` itself;
- a full-page game route hides the chat by virtue of being a route, so it
  keeps the IconRail by DEFAULT and only drops it in fullscreen. Do not add the
  route to `railHidden` — that is for onboarding-style ritual surfaces.

The `windowFullscreenToggle` / `windowIsFullscreen` IPC still exists on the
preload bridge but no renderer surface calls it.

**The game/chat split (260917).** Three rules in `ChatScreen`:
- A game DASHBOARD with no user-dragged split sizes the game area to its
  content (`.gameFit`: `height: auto`, capped at the column minus a 200px
  chat band), so the Stardew / DST / Minecraft dashboards never scroll
  internally at a normal window height. The dashboards were laid out for the
  full picture and at the old 62% default their `.body` grids hid the bottom
  rows. Chess and the launch panels keep an explicit default, now
  `min(72%, calc(100% - 240px))` (was 62% / 280px), because they paint
  absolute art that needs a definite height. A dragged split turns the fit
  off; double-click on the handle restores it.
- The drag handle goes ALL THE WAY DOWN: fewer than `SPLIT_COLLAPSE_CHAT_PX`
  (96px) of chat left snaps into the existing expanded state (the same one
  the "V" toggles) instead of leaving a sliver, and dragging back up leaves
  it. The old 220px chat floor is gone.
- The composer dock is IN-FLOW below the message list, not floating over it.
  The floating dock's window-coloured band went transparent over a custom app
  background, so the conversation showed under and beside the message box;
  in-flow, the list is clipped where the dock begins and the background can
  still show through. `MiniTile` measures `[data-chat-composer]` by rect, so
  it is unaffected.
`?dashshot=chat|chatdst` mounts a dashboard inside the real ChatScreen (a
Proxy over the stub bridge answers whatever the screen asks) for checking
any of this in a plain tab.
