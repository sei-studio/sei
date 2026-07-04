# Procgen companion model (260703)

Goal: migrate the app to a procedurally generated companion ownership model. Spec source: TEMP-GOAL-FILE.md (repo root). Full brief covers 7 items: 4-slot home, three companion types, system generation pipeline, soulcaster-1, character page gating, local vs cloud gating, 4-char public IDs.

## Decisions (user-confirmed)

1. IDs are additive. Characters and users keep internal UUIDs. Cloud assigns a 4-char [A-Z0-9] `public_id` (characters) and `handle` (profiles) via insert triggers. Replacing `auth.users.id` was rejected: it fights the JWT `sub` claim, roughly 15 FK tables, RLS predicates, and storage-path policies.
2. Nano banana (Gemini image) runs behind a new proxy route `POST /generate/image`, JWT-gated, key in Fly secrets. The client never holds the Gemini key.
3. Slot rules: fresh installs start with 4 empty slots. Bundled defaults (Sui/Lyra/Marv) move to the World tab and are invited via `added_default_ids`. Existing libraries with more than 4 characters show the 4 most recently used; extras stay on disk but off the Home grid.
4. Type names: Unique (system-generated) / Custom (user-created) / World (invited from public library). Internal enum `kind: 'unique' | 'custom' | 'world'`.

## Architecture

- Contracts commit (sei@procgen c85bfda): `CharacterKindSchema`, `Character.kind`, `Character.public_id`, `MAX_COMPANION_SLOTS = 4`, `UserPreferencesSchema` (`companion_age_range`, `art_style`), `UserConfig.user_profile`, `UserConfig.added_default_ids`, IPC `gen:start` / `gen:progress` / `prefs:get` / `prefs:save`.
- soulcaster (new sibling repo ~/slop/sei-studio/soulcaster): two-stage sheet generator. Stage 1 is a non-LLM randomizer over fixed option tables (background weighted human/elf/beastkin/robot, 22 hair colors, personality seeds) so variety does not depend on LLM sampling. Stage 2 sends prefilled fields plus user preferences to an injected `llm` function and returns a Zod-validated character sheet with an image_prompt. Installed in sei as a file: dependency, alongside img2skin (skin-gen repo).
- Generation pipeline (main process, cloud mode only): guards (signed-in, slot cap, daily quota) -> castSoul via the proxy /free route (Haiku) -> parallel { proxy /generate/image -> portrait apply -> img2skin --branch fallback -> skin apply } and { persona expansion via existing expandPersona }. Save kind 'unique', shared false, cloud-mirrored via the existing sync queue; public_id fetched back best-effort. Image failure degrades to no portrait/skin; it never fails the generation.
- Proxy (sei-proxy@procgen): /generate/image route (image_daily bucket, 10/day), migrations for characters.public_id, characters.kind, profiles.handle, user_preferences (own-only RLS). Files only; nothing deployed yet.
- Renderer: 4-slot non-scroll Home, 3-tile add chooser, gender -> casting progress -> reveal screens, first-sign-in questionnaire (age range, art style), CharacterPage editability gated on kind === 'custom', public_id tag beside names in chat/profile.

## Out of scope this pass

- Re-roll / re-meet on a bad generation (one generation per slot; free a slot by removing).
- Art style example images in the questionnaire (names only for now).
- Publishing unique characters to World (they stay private; the existing publish path applies later).
- Proxy deploy and Supabase migration push (manual step after review).

## Execution

Contracts by the orchestrating session; then four parallel agents: sei-proxy backend, soulcaster package, sei main process (worktree branch procgen-main), sei renderer (worktree branch procgen-renderer). Merge order: procgen-main, then procgen-renderer, then typecheck, tests, review.
