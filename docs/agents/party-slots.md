# Party slots and the party-full hint (261124)

The party holds `MAX_COMPANION_SLOTS` (4, `shared/characterSchema.ts`)
companions. Membership is one rule, `countsAsHomeSlot` (renderer:
`isHomeCharacter` in `lib/homeLibrary.ts`; main: `libraryCharacterCount`), so
the Home wall, the rail, the World header and main's backstop count the same
set. Main refuses a create or library add past the cap with
`You can only have 4 companions. Remove one to make room.` (`ipc.ts`
`SLOT_LIMIT_REACHED_MESSAGE`, `uniqueGeneration.ts` `slot_limit`).

## Freeing a slot

Unbind lives on a companion's page, Danger tab (Unbind for a World
companion, delete for your own; each keeps its confirm modal). Feedback
261123 ("can't figure out how to remove companions to try others") showed new
players never find it, so every surface that says the party is full carries a
**Free a slot** text button (`components/PartyFullHint.tsx`):

- `FreeSlotButton` opens `FreeSlotPicker`: the party, rail order. Picking one
  calls `openForUnbind` (`lib/partyFull.ts`): `requestProfileFocus('danger')`
  and navigate to that companion's page, which opens on its Danger tab
  (Reset memory, Unbind; product call 261124 renamed it from More and moved
  Sharing to the bottom of Look). Nothing is unbound by the picker.
  `CharacterPage` is keyed by id in `App.tsx` so the focus is read again when
  the picker opens a second profile from a first one.
- `PartyFullHint` is the one-line form ("Your party is full. Unbind a
  companion to make room." + Free a slot) for surfaces where an add failed.

| Surface (`surface`) | Where | What shows |
|---|---|---|
| `world` | World tab header (`CharactersScreen`) | "Party full" + Free a slot |
| `invite` | Invite to party on a World companion or removed built-in (`CharacterPage`) | the hint line. Pre-checked in the renderer (no IPC), main's error mapped by `isPartyFullError` |
| `create` | Creating a companion (`AddCharacterScreen`, main's backstop) | the hint line |
| `cast` | Sui's unique cast refused with `slot_limit` (`SuiMeetScene`) | Free a slot replaces Try again |
| `import_notice` | Own-key import notice over the app (`App.tsx` Banner `action`) | the line + Free a slot |
| `import_modal` | Import modal when main refused for a full party | the line + Free a slot (a pick also closes the modal) |
| `import_settings` | Settings, "Companions from before you signed in" | helper + Free a slot |

The rail's + is hidden when the party is full (IconRail, 260731b), so Awaken
is not reachable then; main's backstop and the `create` / `cast` lines cover
a race.

## Analytics

All through `sei.track`, shape only (`lib/partyFull.ts`).

| Event | Props | When |
|---|---|---|
| `party_full_shown` | `surface` | a party-full line or button rendered (once per surface per app run) |
| `party_full_free_slot_tapped` | `surface` | Free a slot pressed |
| `party_full_slot_picked` | `surface` | a companion picked in the picker (their page opens on Unbind) |
| `party_full_unbind` | `surface`, `tapped`, `picked` (the unbound one is the one the picker opened), `secs_since_shown` | the first Unbind (or delete) confirmed after a party-full line this run |

Funnel: shown -> tapped -> picked -> unbind. `party_full_unbind` with
`tapped: false` is a player who found Unbind on their own after seeing the
line. The import-specific `local_import_party_full` (lib/localImportTrack.ts)
still fires alongside.

## Checks

- Screenshots: `node scripts/party-full-shots.mjs --out <dir> [--query
  theme=light&lang=ru]` (shots: world, invite, picker, picked, notice,
  settings), using `?dashshot=screen&screen=world|worldprofile&full=1`
  (DevWorldShot), `&partyfull=1` and `&localimport=full` (DevScreenShot).
- Tests: `lib/partyFull.test.ts`, `components/PartyFullHint.test.tsx`.
