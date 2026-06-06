# Sei Desktop Launcher

_Started 2026-05-07 19:47 UTC_

---

## User

We will design a minimalist desktop launcher for Sei, a mod that lets AI players with custom personas join your game. Currently Sei only works in Minecraft. Think like a CurseForge desktop app like interface. The workflow is Player launches MC singleplayer world → open to LAN → open Sei and select persona → press Summon in Sei. 

We need the following windows:
1. onboarding: one question at a time, player enters MC username, preferred name, selects model provider and enter API key. 
2. home: a list of AI characters the user has created, each showing image + name card over it. hover over shows summon button. start with only a default persona called Sui which i will provide. have a card with big plus symbol on it to add a character
3. add character: one question at a time, persona name, persona description. 
4. character page: when user clicks AI character card in home. shows character name, description, play info (last launched, playtime, creation date), image, summon button.
5. side bar on the left shows icons. bottom shows settings icon to re-onboard. top shows home button. under home button is minecraft logo, and under minecraft logo is a + button which would let users add other games. when clicked, that should just say other games coming soon.
5. logo is just "Sei" in 8bit font

Have system light and dark mode. Light mode should use warm offwhite, claude design colors. Dark mode should use dark grey. Use minimalist modern sans serif font. Titles eg character name should use 8bit font but use it sparingly.

## Assistant

_[tool: copy_starter_component]_

_[tool: copy_starter_component]_

_[tool: read_file]_

_[tool: update_todos]_

I'll build this now. Starting with declaring my system: warm Claude-aligned palette (off-white #FAF9F5, accents #C96442) for light mode, dark grey #1A1A1A surfaces for dark mode. **Geist** sans-serif for body, **Press Start 2P** for the "Sei" wordmark and character titles only. The macOS window chrome stays minimal — I'll skip the colored Tahoe sidebar from the starter and roll a 72px icon rail that matches our aesthetic.

For the Minecraft icon I'll use a generic green/brown pixel-block (no logo/wordmark) labeled "MC" to avoid recreating trademarked branding.

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Built **Sei Launcher** — a minimalist desktop launcher for the Minecraft AI-persona mod.

**Design system declared:** warm Claude-aligned palette (off-white `#F5F2EA`, surface `#FAF9F5`, accent `#C96442`) for light mode; soft dark grey (`#0E0E0E` → `#2A2A2A`) for dark mode. **Geist** sans for body, **Press Start 2P** sparingly on the "Sei" wordmark and character titles. Custom 64px icon rail (no Tahoe glass).

**What's in:**
- **Onboarding** (5 steps, one question each): welcome → MC username → preferred name → provider picker (Anthropic/OpenAI/Google/Local) → API key
- **Home**: character grid with **Sui** (default, procedurally-generated pixel portrait) + dashed "New character" card. Hover any card → Summon button overlays
- **Add character** (2 questions): name → persona description
- **Character page**: pixel portrait, big Summon button, persona description, last-launched / playtime / created stat tiles, model status row
- **Sidebar**: 8-bit "Sei" wordmark · home icon · pixel block (Minecraft) · `+` (other games → "coming soon" screen) · theme toggle · settings (re-onboard)
- **System theme**: respects `prefers-color-scheme` by default, plus manual toggle
- **Tweaks panel**: theme mode, accent color (5 options), LAN banner toggle, demo reset

Drop in a real Sui portrait whenever you have it — replace the `PixelPortrait` call inside `CharacterCard` / `CharacterPage` with an `<img>` and pass it as a per-character `image` field.

## User

Make it less wordy. Minimalist. Presenting the user with one main sentence at a time. Remove subtitles / full sentence descriptions like "A handful of questions ...". Also remove the "4 questions any model provider etc". You get the point, do this for everything.

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

Trimmed copy across the launcher:

- **Onboarding** — removed all hints, eyebrows, the welcome chip row, and the local-mode helper paragraph. Each step now shows just the question.
- **Add character** — dropped both hints and the tip/char-count footer.
- **Home** — removed the "Minecraft · username" eyebrow, the "Tip:" preamble, and "Open to LAN:" label. Just the IP and arrow remain.
- **Character page** — removed tagline subtitle and "Powered by / tokens per message" detail.
- **Settings** — pure rows, no descriptions.
- **Coming soon** — just the line.
- **Toast** — only "Summoning X…".

## User

Make all edges sharp instead of rounded. The localhost:25565 should be replaced with connected/not connected. Clicking it should give instructions on how to open LAN "To summon a character into your world..." . If not connected and player presses summon, it should open the same instructios on opening LAN. Remove the "Open your world to LAN before summoning" line. Make side logos bigger. And remove the shaded selection indicator just keep the orange bar. Move the close/minimize/fullscreen buttons to top left

## Assistant

_[tool: snip]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: run_script]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: read_file]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: run_script]_

_[tool: snip]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: update_todos]_

_[tool: done]_

_[tool: fork_verifier_agent]_

_[tool: update_todos]_

Wired the LAN connection state end-to-end:

- **Summon now requires "Open to LAN"** — clicking Summon (anywhere) when disconnected pops a modal explaining the LAN step (Esc → Open to LAN → Copy IP), with a "Mark as connected" action.
- **Home banner** flips between two states: dashed amber "Open to LAN to summon" when disconnected, solid green "Connected · 192.168.1.42:54123" with copy-IP when live.
- **Tweaks** now has a "Toggle LAN connection" demo button so you can flip the state without dismissing the modal.
- Removed the standalone LAN-banner toggle (it's implicit in the connected state now).

## User

Verifier agent check completed

## Assistant

_[tool: grep]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: snip]_

_[tool: done]_

Fixed the LAN wiring the verifier flagged:

- `HomeScreen` now receives `connected` + `onOpenLan` (not the dead `showLanBanner`)
- `<window.LanModal>` is mounted inside `AppWindow` and toggles via `lanModalOpen`
- Removed the orphaned `Show LAN tip banner` tweak and its default
- Added `connected` / `lanModalOpen` to app state; `summon()` and the home status pill both open the modal when disconnected

Clicking the "Not connected" pill (or Summon) now actually surfaces the LAN instructions modal, and "Mark as connected" flips the pill green with the IP.

## User

Apply comment

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: run_script]_

_[tool: done]_

Replaced the Play icon on the Summon button with a four-point sparkle (with a smaller secondary sparkle) — applied to both the character page and hover-summon on cards.

## User

Apply comment

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: snip]_

Centered the rail icons across the full 72px width and bumped each one up a notch — Sei wordmark to 20px, Home/MC/+/Theme/Settings icons to 26–34px.

## User

Separate persona prompt (for model prompt) and character description (for users). Remove the Sei logo from the sidebar. Add a loading screen which just shows the Sei color (recolor it, currently its black on transparent background). Also update text at the top to just say "Sei" not "Sei Minecraft". Finally, use these colors appropriately, change the emphasis colors that we're using

Dark theme
#191C21
#7AA9Ed (light blue)
Light theme
#f4C2AA (light beige)
#FDFEFF

Also explain how youre generating the pixel images for characters

## Assistant

_[tool: list_files]_

_[tool: image_metadata]_

_[tool: view_image]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: snip]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: snip]_

_[tool: copy_files]_

_[tool: str_replace_edit]_

Now updating index.html with new color tokens:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now ui.jsx — remove sidebar wordmark and update accent shadow:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Done — here's a summary of the changes:

**Color system** — swapped both themes:
- **Light:** `#FDFEFF` window, `#F4C2AA` accent (warm beige), darker text on near-white surfaces
- **Dark:** `#191C21` window, `#7AA9ED` accent (light blue), with deep blue-grey surfaces
- Updated `--accent-soft`, `--accent-strong`, button hover shadows, and ambient wallpaper tints to match

**Title bar** — now just says **"Sei"** with no subtitle in any view.

**Sidebar** — removed the "Sei" wordmark from the top of the rail; Home is now the first thing.

**Loading screen** — new `LoadingScreen` overlay that boots the app for ~1.6s before onboarding. Shows the uploaded `sei_logo_small.png` recolored to `var(--accent)` via CSS `mask-image` (so it picks up the theme accent automatically — beige in light, blue in dark), with a gentle pulse + three blinking dots. Also exposed as a "Show loading screen" button in Tweaks.

**Persona prompt vs description** — these are now two distinct fields:
- **Description** — user-facing flavour bio shown in the "Description" card on the character page
- **Persona prompt** — model-facing system instruction, shown in a separate accent-bordered card labelled "Sent to {model}", rendered in monospace
- Add-character flow is now **3 steps** (Name → Description → Persona prompt) with eyebrow labels "Shown to you" / "Sent to the model"
- Sui ships with both fields populated

---

**How the pixel character images are generated**

They're not images — they're rendered live by the `PixelPortrait` component (in `ui.jsx`). Per character:

1. **Seed.** The character's `id + name` string is hashed (FNV-1a) into a 32-bit integer.
2. **Deterministic RNG.** That hash seeds an xorshift PRNG, so the same character always produces the same sprite.
3. **Grid.** A 12×12 grid is filled left-to-right, top-to-bottom. Only the left half is generated; the right half is mirrored — that's what gives every portrait facial symmetry.
4. **Regions.** Different rows use different fill rules: the top 2 rows are sky (empty), rows 2–6 are the "head" (denser fill, picks from the lighter end of the palette), rows 7+ are the "body" (picks from the darker end).
5. **Palette.** Each character has a hand-picked 6-color palette (sky, sky-2, head accents, body accents, body-dark) — for new characters the palette is selected deterministically from a list of 6 by hashing the name.
6. **Eyes.** Two fixed dark pixels are stamped at row 4, columns 3 and 8 so every face has visible eyes regardless of the random fill.
7. **Render.** Each cell is an absolutely-positioned `<div>` sized to `size/12` px, layered over a vertical gradient using palette[0] → palette[1] for the sky.

So they're basically symmetric procedural Minecraft-skin-style avatars — 100% deterministic from the seed, no image assets, scale-independent.

## User

Verifier agent check completed

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

Fixed — the tweak default was pinned to the old orange and overriding the per-theme `--accent`. Set the tweak accent default to `null`, made the override skip cleanly when unset (and remove the property so the theme's CSS variable takes over), and refreshed the Tweaks accent swatches per theme with `null` as the first "Theme default" option.

## User

Apply comment

## Assistant

_[tool: snip]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: snip]_

Replaced the "Sei" text on the welcome screen with the recolored pixel logo (`SeiPixelMark`), inline-flex aligned with "Welcome to" so the baselines sit level.

## User

Make sure that the bottom of the text and image are lined up on same y level.

## User

Make sure that the bottom of the text and image are lined up on same y level, with same height

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: snip]_

Aligned: `SeiPixelMark` now accepts `height` (or `width`), the welcome title uses `align-items: flex-end` with `lineHeight: 1` on text spans, and the logo height is set to ~22px to match the h1's cap height — so the bottom of "Welcome to" and the bottom of the Sei mark sit on the same baseline.

## User

Theyre not aligned because Welcome to text is aligned center not aligned bottom for height, whereas Sei letters span entire image height

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: done]_

Switched to `align-items: baseline` so the text's letter baseline aligns with the image's bottom edge. The Sei mark's letters now sit on the same baseline as "Welcome to," with matching ~22px letter height.

## User

Switch sans serif font to Noto Sans

## Assistant

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: snip]_

Switched to Noto Sans across the app.

## User

Center welcome to sei and remove the outline around the enter text boxes. Just an underline. Also remove examples for everything except API key

## Assistant

_[tool: snip]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: snip]_

Done:

- **Welcome screen** centered (added `centered` prop to `QuestionShell` → `text-align: center`)
- **TextField** is now a borderless underline (1.5px bottom border that turns accent-colored on focus, no surrounding box or focus ring)
- Cleared all `e.g.` / example placeholders except the **API key** field, which keeps `sk-ant-...` and `http://localhost:11434`

## User

Make persona prompt hidden in edit persona instead of being publicly displayed

## Assistant

_[tool: snip]_

_[tool: grep]_

_[tool: read_file]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: snip]_

The persona prompt card now collapses to just its header by default with a `Show` / `Hide` toggle on the right; the accent left-border only appears when expanded, and the eyebrow shows "Hidden" until you reveal it.

