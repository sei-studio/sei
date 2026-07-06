# UI Redesign: "Party" concept merge

Source mockup: sei-roster-concept.html ("Party concept v3"). This document is the
authoritative spec for the redesign. Rule: this is a merge, not a migration.
Every existing feature stays; the mockup supplies the visual language and a
small number of new surfaces (party wall home, chat presence panel, awaken
view). When the mockup and the app disagree on a feature, the app's feature
wins and gets restyled. When unsure, pick the most minimal design: least text,
fewest elements.

## 1. Design language (all agents must follow exactly)

Palette, fonts, spacing tokens are unchanged (tokens.css already matches the
mockup). The changes are typographic voice, button language, and component
shapes.

### Buttons (Button.tsx CSS rewrite, API unchanged)
The mono/uppercase/tracked button language is retired. New language, from
mockup `.btn`:

- Base: `font-family: var(--sans); font-weight: 600; regular case; border: 1px solid var(--border-strong); color: var(--text-2); background: none; sharp corners`.
  Hover: `border-color: var(--accent); color: var(--accent); background: var(--accent-soft)`.
- `primary` and `accent` kinds: accent fill, `color: var(--accent-text)`, hover `background: var(--accent-strong)`. The notched clip-path is removed. `accent` stays as an alias of `primary` (call sites unchanged).
- `ghost`: the new base bordered style above.
- `quiet`: borderless, `color: var(--muted)`, hover accent. Unchanged concept.
- `danger`: bordered like ghost, text `var(--red-strong)` at rest with red-tinted border, hover full red (border+text+red-soft bg). Keeps the destructive affordance at rest.
- Sizes: sm = 5px 12px / 12px; md = 7px 14px / 13px; lg = 10px 24px / 14px. Height comes from padding, not fixed height.
- No text-transform anywhere. Button children render as written (sentence case).

### Type ramp
- Display: Oswald 600 for names, screen titles, section h3s, modal titles.
- Body: Rajdhani, 13 to 15px.
- Mono micro-label (`.label` in mockup): mono 10.5px, letter-spacing .04em, NO uppercase transform. `.u-lbl` in global.css is restyled to this. Existing uppercase strings in JSX should be rewritten to sentence case where touched.
- IdTag: mono 10.5px, letter-spacing .08em, color `--muted-2`, NO border, NO background fill (mockup `.idtag` is plain text). IdTag.module.css updated centrally.

### New shared primitives (built centrally, in components/)
- `ModalShell` (`components/ModalShell.tsx`): scrim `rgba(4, 7, 15, 0.72)`, z-index 1000 default (prop for higher tiers: 1100 stacked, 1200 recovery), panel `background: var(--bg2); border: 1px solid var(--border-strong); padding: 20px; display:flex; column; gap: 12px;` default width 380px (prop), `--shadow-pop`, global `fade-up` animation, Oswald 600 18px title, optional Esc/scrim-click dismiss props. All modals migrate onto it.
  - Footer convention: text-level dismiss (quiet kind, label "Cancel" or "Close") + one primary or danger CTA, right-aligned.
- `Toggle` (`components/Toggle.tsx`): mockup `.toggle` pill switch, 34x19, `role="switch"`, knob slides, on = accent fill. Replaces On/Off button pairs.
- `Seg` (`components/Seg.tsx`): mockup `.seg` segmented control, bordered row of sans 12px buttons, active = accent-soft bg + accent text. Replaces aria-pressed ghost-button groups.
- `Presence` (`components/Presence.tsx`): dot + label line. See section 2.
- `GatherPixels` (`components/GatherPixels.tsx`): the 5x5 gathering-pixels mark (dormant slots, awaken hero). Port of the mockup's GPX patterns and cycle animation, reduced-motion safe.

### Modals
All modals use ModalShell. Standard copy: dismiss label "Cancel" (or "Close"
for info-only), CTA sentence case. z-index tiers: 1000 base, 1100 stacked-above
(OAuth, AutoRenewal, UpdatePopup, ApiKeySetup), 1200 recovery
(SetNewPassword). Scrim and panel styling come from ModalShell only.

### Do not
- No text-transform: uppercase on new UI. No letter-spacing beyond .08em except where retained deliberately.
- No literal hex/px colors; tokens only.
- No new fonts, no border-radius except circles (sockets, avatars, toggle) and the existing PercentBar pill.
- Do not remove features to match the mockup (sort selects, load-more, sync pills, banners, error states all stay).
- Both themes must read. Light theme maps automatically through tokens.

## 2. Presence model (new, shared)

### Categories
Computed per character in `renderer/src/lib/presence.ts`:

- `in-game`: `summons[id].kind === 'online'`. Label "In your world". Green dot with glow.
- `connecting`: `summons[id].kind === 'connecting'`. Label "Connecting…". Accent dot, pulse.
- `new`: no `last_chatted` and no `last_launched` (never interacted). Label "New". Accent dot with glow.
- `online`: last interaction (max of last_chatted, last_launched + live message timestamps) within 10 minutes. Label "Online". Green dot, no glow.
- `idle`: otherwise. Label "Idle". Hollow dot (transparent, 1px muted border).

`usePresence(characterId)` hook returns `{ category, label }` and re-renders on
a 60s ticker so online decays to idle without navigation.

### In-game action line
When in-game, the roster line (home panel lastline, chat presence panel "now"
line) shows the companion's current action instead of the last chat message.

New plumbing (see section 5): bot emits `{ type: 'action', name, args }` on
tool dispatch; supervisor forwards; renderer stores
`actions: Record<characterId, { name; args; ts }>` in useDataStore.

`renderer/src/lib/actionVerb.ts` maps tool name + args to a short present
progressive phrase:
- follow/come: "following you…"
- goto: "heading somewhere…"
- gather: "gathering {item}…" (fallback "gathering…")
- dig: "digging…"
- build: "building…"
- place: "placing blocks…"
- find: "looking for {thing}…"
- equip: "gearing up…"
- consume: "having a snack…"
- sleep: "sleeping…"
- attack: "fighting…"
- container ops: "rummaging through chests…"
- unknown/none: "exploring…"

### Last-line preview
Home panels show the last chat line ("Name: text" / "You: text") without
opening the chat. New IPC `chat:previews` returns
`Record<characterId, { role, text, ts }>` (main reads the tail of each chat
file). Renderer caches in useChatStore (or a small roster store) and updates
from the existing `chat:message` push plus own sends.

## 3. Window chrome

- `src/main/windowChrome.ts`: default 1180x720 (was 1180x760), minimum 1000x560 (was 1180x760 floor). Window stays resizable.
- `MacosWindow.module.css`: min-width 1000, min-height 560.
- Drag strip, rail fill, traffic-light branches, HUD grain: unchanged.

## 4. Per-surface spec (keep / change / add / remove)

### 4.1 IconRail (rework, owned by orchestrator)
Keep: order (home, world, divider, character cluster, plus, spacer, playtime,
settings), tooltips, sort order, prefetch on hover, badge logic, cloud-switch
prompt (moves onto ModalShell), active gating by homeTab.
Change:
- Character buttons become mockup sockets: 40px circular face, `--border-strong` ring. Summoned (online or connecting) = 2px green pulsing ring (`@keyframes pulse` opacity). Selected = accent double ring (`box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent)`).
- Plus button becomes the dormant socket: circular, dashed-feel accent ring at 40% alpha, plus glyph, hover accent + accent-soft fill. Navigates to the new awaken view.
- Active nav indicator: 3px left accent bar (was 2px).
- Nav icons swapped to the mockup set where they differ: world globe, playtime spark, settings cog (SVGs in the mockup, lines 496 to 520).

### 4.2 Home: party wall (CharactersScreen HomeGrid rewrite)
The 4-slot card grid becomes the mockup party wall: full-height flex panels,
one per slot.
- Panel: full-bleed portrait art (portrait_image cover, else PixelPortrait large) with saturate(.72) brightness(.88) at rest, scale+full color on hover; bottom scrim; info block bottom-left: name (Oswald 30px), Presence line.
- Hover/focus expands the panel (`flex 1.65` vs siblings .84) and reveals `.more`: lastline (last chat message, or action verb when in-game, or "Matched with you {relative date}." when new) + action row: [Message primary] [Play ghost]. New companions get [Say hello primary] instead of Message.
- Panel click and Message go to chat (preserving charsOpenPrepare). Play opens the games-picker modal (stopPropagation).
- Empty slots render as dormant panels: GatherPixels mark + "Awaken" label, click routes to awaken view. All 4 slots always render (n companions + 4-n dormant).
- Removed: the greeting header ("Welcome back, X!"), the card grid, CharacterCard usage on home (CharacterCard stays for any other consumers until the sweep confirms none). has_been_welcomed logic may stay dormant, do not delete config plumbing.
- Keep: home filter rules, sort, cloud-only placeholder slots (render as a panel with muted state and no actions besides open), per-slot error overlay (restyle as a small red mono line inside the panel), CreationLimitModal gate, SignInModal gate for unique.

### 4.3 Awaken view (new screen, replaces AddCompanionChooserModal)
New `view.kind: 'awaken'`, rail visible. Mockup view-awaken:
- Header row: quiet "← Back" to home.
- Body split: left hero button "Be matched" (GatherPixels lg, Oswald 34px h2, "Meet a companion made for you.", primary Begin) which runs the existing unique gates (signed-in + cloud backend, else SignInModal; prefs gate to profile-questions or unique-gender).
- Right column: "Create your own" ("Design every detail yourself.") to add-character screen; "Invite from World" ("Companions made by others.") to world tab.
- AddCompanionChooserModal is retired; all its openers route to awaken. CreationLimit check runs before entering (same as today's handleAddClick).

### 4.4 World tab (WorldGrid restyle)
Keep: search input, sort select (A-Z / Newest), Load more, skeleton cards,
empty and error states, prefetch, paging, defaults-as-world-entries.
Change:
- Top bar: search left (mockup .search style); slots indicator right: "{4-n} slots open" / "Party full" (mono muted); sort select sits next to search, restyled to match.
- Cards (BrowseCard): 3:4 aspect `wcard` style: art block (portrait cover) + meta below (name Oswald 16px + IdTag inline, "by {creator}" 12px muted). Hover overlay with a centered button: "Invite" (primary) when a slot is open and not in library, adds directly to library (same IPC path as CharacterPage "Add to library"); disabled "In your party" when already added; disabled "Party full" when 4 slots used. Card body click still opens the character profile preview.

### 4.5 Chat (ChatScreen)
Keep: back button, header avatar + name + IdTag, play-together icon, voice
icon (stub toast), message grouping, day separators, copy/reply hover actions,
quoted replies, typing line, empty state, Enter/Shift+Enter, realistic typing.
Change:
- Composer becomes the mockup box: `--bg2` fill, `--border-strong` border, input + accent send glyph. Send button may stay conditional on draft.
- Header name becomes a toggle (name + IdTag) that opens/closes the presence side panel.
- Remove the header profile (UserIcon) button; profile is reached from the presence panel.
- Day separators and timestamps restyled to the mockup (mono micro-labels, hairline rules).
Add: presence side panel (mockup pres-panel): collapsible 260px right column
(width transition), containing portrait art block with fade, name + IdTag,
kind line ("Companion"), Presence line, "now" line (action verb when in-game,
else blank), action stack: [Play or Disconnect] [Voice call] [Full profile].
Clicking a message author name shows that resident's card (companion or user;
user card shows name + "Human", no actions). Same card toggles closed.
Default state: open.

### 4.6 Character profile (CharacterPage)
Keep: full-bleed right portrait + scrim layout, back button, name + IdTag,
Report for foreign chars, status line while online/connecting/errored, share
toggle (restyled to mockup Toggle + "Public"/"Private" label), view-only
gating, cache-on-demand, publish flow and share confirm modal (onto
ModalShell), not-found stub.
Change:
- Back label: "← Back".
- Origin chip under the name (mockup .chip): unique = "Matched", custom = "Created by you", world = "Invited", default = "Sei".
- Tabs renamed and recomposed:
  - "Description": persona/description card (mockup .persona; quote style for non-editable, bordered card + Edit button for editable, Edit opens EditCharacterModal). Below, kv rows (mockup .kv-row): Bonded = created date, Played = playtime, Last launch = last_launched, Memory = current world label if cheap, else omit, with a Reset button (opens ResetMemoryConfirmModal). No proactiveness here.
  - "Game": skin preview (SkinPreview3d, cleaned up: preview + caption "This is how they appear in your world." + Edit skin for editable) plus the Proactiveness control (ProactivenessBar with label).
- Deploy row pinned bottom: [Play primary, flex 1] (opens games picker; label "Disconnect" danger-style swap when online) + [Release danger] (opens DeleteConfirmModal for owned, UnbindConfirmModal for world-added). Gear button and gear menu retired; world-preview keeps only "Add to library".
- Stats grid, PERSONA SOURCE eyebrow, rotate toggle: folded into the above (source rotate stays inside the editable persona card header if trivially portable, else dropped in favor of EditCharacterModal).

### 4.7 Settings (SettingsScreen)
Keep every row and behavior. Recompose to mockup rhythm: centered 560px
column, Oswald 600 16px group h3 (sentence case), rows
`label | value | control` with hairline bottom borders, Seg and Toggle
primitives.
Groups and rows:
- Profile: portrait picker + name field.
- Account (signed-in): email + Sign out; Playtime row ("~Xh left" + Add primary to credits) for cloud users; Resend verification; Account ID + copy; Migrate local companions; Export data.
- AI: Backend seg [Cloud | My key] (drives SwitchBackendConfirmModal); when local: Provider row, API key row.
- Minecraft: Custom skins + Run setup; Visual gameplay seg [Off | On-demand | Continuous].
- Appearance: Theme seg [Dark | Light | System]; Realistic typing Toggle; Developer console Toggle.
- About: Version row ("{v} · up to date" after check, else Check now button); Terms of Service; Privacy Policy; DMCA.
- Danger: Reset all memories; Delete account. Red bordered danger buttons.
Theme gains the System option (theme.ts already supports 'system').

### 4.8 Playtime (CreditsScreen) and Receipt
Keep: refresh polling, claim/purchase/subscribe flows, consent modal, renewal
notes, manage billing, checkout waiting modal, dollar carve-out, back button.
Change to mockup pt layout:
- Hero: "{pct}%" Oswald 46px + small "left", 10px accent bar. Sub-line for renewal/end date. Keep the small refresh affordance.
- "Add playtime" h3 + 3 plan cards (mockup .plan): name 13px muted, price Oswald 28px with small unit, estimate line, bottom-anchored button. Plans keep real names Encounter / Quest / Party and current button state machines. Active plan = accent border.
- Foot: [Manage billing ghost] + disclaimer 12px muted-2.
- ReceiptScreen: restyle onto the same column (Oswald title, bordered tile, primary Back to Sei); drop the 8px radius.

### 4.9 Play modal (GamesPickerModal + GameAboutModal)
GamesPicker becomes the mockup play-modal on ModalShell: title "Play with
{name}", Minecraft game-row (small block icon, name, sub-line with LAN/world
status dot, Connect primary / Disconnect danger), a disabled "More games /
Soon" row, small info button on the Minecraft row keeps GameAboutModal
reachable, Close text button. attemptSummon flow, LanModal deferral, skin
prompt: unchanged.

### 4.10 Entry surfaces (auth, onboarding, wizard, unique flow)
Light-touch restyle only; flows untouched:
- QuestionShell: title moves to Oswald 600 28px; hint/body 14px; footer uses new Button language; StepDots unchanged.
- AuthChoiceScreen and SignInModal: panel and inputs pick up the new language automatically; align paddings to 20px grid; Google button untouched (brand-exempt).
- SetupWizardModal / WizardStepShell / McInstall rows: pixel "STEP n / 4" becomes mono micro-label; rows and pills keep function.
- ProfileQuestions / UniqueGender tiles: bordered tiles, accent-soft when selected (already close); Oswald titles.
- UniqueCasting / UniqueReveal: Oswald headline, otherwise as-is.
- ActivityPicker / ComingSoon: Oswald titles, new buttons, drop the pixel-font eyebrow (mono micro-label instead).
- VoiceCallScreen / MinimizedCall / SummonedWidget: restyle labels and buttons to new language; keep behavior. SummonedWidget status line uses Presence styles.

### 4.11 Modal sweep
Every modal listed in the component inventory moves onto ModalShell with the
standard footer. Copy is preserved except case normalization. Special cases:
- AcceptToS, SetNewPassword, OAuthInterstitial: keep their dismiss suppression via ModalShell props.
- EditCharacterModal: keeps its 920x640 two-column layout inside a ModalShell scrim; internal sections restyled (Oswald section h3s, new buttons).
- UpdatePopup: onto ModalShell, keeps PercentBar and changelog.
- IconRail's inline cloud prompt: becomes a ModalShell confirm.

## 5. New data plumbing (bot action + chat previews)

### Bot current action
- `src/shared/ipc.ts`: extend `BotLifecycle` with `{ type: 'action'; name: string; args?: Record<string, unknown> }`; new push channel `bot:action` with payload `{ characterId, name, args, ts }`; renderer api `onBotAction`.
- `src/bot/brain/orchestrator.js`: in the long-runner dispatch path (where `inflight.start({name, args})` runs), call the existing lifecycle emitter with the action payload. Emit only for world-acting tools (skip say/remember/forget/end_loop). Include a cleared action on loop end (`{ type: 'action', name: null }`) so the verb does not stick.
- `src/bot/index.js`: pass an emit hook into the orchestrator wiring (same pattern as chat).
- `src/main/botSupervisor.ts`: forward `action` lifecycle to a new `onBotAction` callback; `src/main/ipc.ts` pushes `bot:action` to the window. Clear on disconnect/idle.
- `useDataStore`: `actions: Record<string, { name: string | null; args?: any; ts: number }>`, updated by the push, cleared when the summon goes idle.

### Chat previews
- `src/main/chat/chatStore.ts`: `readLast(characterId)` helper.
- New IPC `chat:previews` (request: character id list or all; response: `Record<id, { role, text, ts }>`), registered in main ipc.
- Renderer: `useChatStore.previews` + `loadPreviews()`, kept fresh by the existing `chat:message` push and local sends. Home panels read it.

## 6. Execution plan and file ownership

Foundation (orchestrator, before fan-out): plan doc, windowChrome sizing,
MacosWindow css floor, Button css rewrite, global.css label changes, IdTag
restyle, ModalShell, Toggle, Seg, Presence, GatherPixels, presence.ts,
actionVerb.ts, shared/ipc.ts type + channel additions, useDataStore actions
field, useChatStore previews field (renderer stubs so agents can build against
them), icons additions.

Agent lanes (parallel, file-disjoint):
- A `roster`: CharactersScreen.* (HomeGrid party wall + WorldGrid), HomeScreen.module.css, BrowseCard.*, AddCard (retire from home), new AwakenScreen.*, useUiStore 'awaken' view kind, App.tsx route, AddCompanionChooserModal retirement.
- B `chat`: ChatScreen.*, presence panel, VoiceCallScreen.*, MinimizedCall.*, SummonedWidget.*, GamesPickerModal.*, GameAboutModal.*, LanModal.*, SummonConflictModal.*.
- C `profile`: CharacterPage.*, EditCharacterModal.*, SkinEditor.*, SkinPreview3d.*, ProactivenessBar.*.
- D `settings`: SettingsScreen.* only.
- E `billing`: CreditsScreen.*, ReceiptScreen.*, UsageBar.*, HardStopModal.*, AutoRenewalConsentModal.*, PreCtaDisclosure.*, UpdatePopup.*.
- F `entry`: AuthChoiceScreen.*, OnboardingScreen, QuestionShell.*, StepDots, SkinSetupScreen.*, ActivityPickerScreen.*, ComingSoonScreen.*, ProfileQuestionsScreen.*, UniqueGender/Casting/Reveal, SetupWizardModal.*, WizardStepShell.*, McInstallList/Row, InstallProgressList, SignInModal.*, GoogleSignInButton (no-op), OAuthInterstitialModal.*, SetNewPasswordModal.*, AcceptToSModal.*.
- G `plumbing`: bot action event + chat previews (src/bot, src/main, shared/ipc.ts implementation side), per section 5.
- H `modals`: remaining confirm modals onto ModalShell: DeleteConfirm, ResetMemory, Unbind, SignOut, ResetAll, SwitchBackend, SkinSetupPrompt, DeleteAccount, CreationLimit, Dmca, MigrateLocalChars, ImportLocalProfile, OfflineRetry, ApiKeySetup, PortraitCropModal.

Orchestrator owns after fan-out: IconRail rework (sockets), consistency audit,
UI-DESIGN-SYSTEM.md update, typecheck, tests, visual verification.

## 7. Acceptance checklist

- Window opens at 1180x720; nothing clips at 1000x560.
- Home is the party wall; hover expands panels; presence lines correct for all five categories; in-game shows the action verb; dormant slots gather pixels and route to awaken.
- Rail sockets show green pulse for summoned, accent ring for selected, dormant plus socket.
- Chat has the boxed composer and a working presence panel; author-name clicks swap the card.
- Profile has Description / Game tabs per section 4.6.
- Settings, Playtime, World, entry surfaces restyled with zero feature loss.
- Every modal uses ModalShell; one scrim color; three z tiers; footer convention holds.
- No text-transform uppercase in new CSS; no literal colors; light theme readable.
- typecheck + existing tests pass.
