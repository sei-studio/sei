# ITEM 9 — Default Skin Rendering Diagnosis

## Reproduction

1. Fresh install (or wipe `<userData>/skins/`).
2. Open the SkinEditor for any bundled default — Sui, Lyra, or Clawd.
3. Observe: the 3D preview shows a Steve silhouette (the skin server
   responds 404, the renderer's `<SkinPreview3d>` falls back to Steve).
4. Summon the bot for any bundled default. The bot connects but wears
   the Steve fallback skin in-game (CustomSkinLoader hits the local skin
   server, gets 404, defaults to Steve/Alex).
5. Custom (user-created) characters with an uploaded or username-search
   skin render correctly — only defaults are broken.

## Root Cause

`src/main/skinStore.ts:54` — `bundledSkinPath(personaId)` constructs the
path as:

```ts
path.join(__dirname, '..', '..', 'resources', 'skins', `${personaId}.png`)
```

Where `personaId` is the persona's UUID (e.g.
`bbf5b66f-2f0f-4918-a953-a2cf66d5a586`). The actual file on disk is
`resources/skins/sui.png` — slug-named, not UUID-named.

The Phase 11 slug→UUID migration (Plan 11-05) renamed defaults from
`sui.json` → `<sui-uuid>.json` and seeded `DEFAULT_CHARACTER_UUIDS` in
`src/main/defaultCharacters.ts`. The accompanying docblock comment in
`defaultCharacters.ts:49-50` PROMISED a UUID→slug reverse lookup in
`bundledSkinPath` to keep the bundled-asset paths slug-named:

> bundledSkinPath in skinStore.ts (Plan 11-05 caller) does a reverse
> lookup from UUID to slug to resolve resources/skins/<slug>.png.

But the implementation never landed — `bundledSkinPath` just interpolates
the UUID directly, which resolves to a non-existent file. `resolveSkinPng`
catches the ENOENT and returns null → the skin server returns 404 → the
preview + in-game render both fall back to Steve.

This bug has been latent since Plan 11-05 because (a) custom-character
skins don't hit this code path, and (b) no one tested default skins
end-to-end with the new UUID file layout until the user reported it.

The bundled JSON files (`resources/default-characters/{sui,lyra,clawd}.json`)
DO carry a `slug` field (`"slug": "sui"`, etc.), and `CharacterSchema`
preserves it (line 84: `slug: z.string().nullable().default(null)`), so
the slug is already available on the parsed `Character` object — the fix
just needs to use it.

This matches diagnosis hypothesis **#5** from the plan:
> "Naming mismatch: `resources/default-characters/sui.json` references
> `./img/sui.png` (line 13). But the skinStore expects `resources/skins/sui.png`.
> If the bundled path is `resources/default-characters/img/sui.png` but the
> code looks under `resources/skins/sui.png`, that's the bug."

The user's specific manifestation is a variant: the bundled PNG exists at
`resources/skins/sui.png`, but `bundledSkinPath` looks for
`resources/skins/<UUID>.png` — a UUID-vs-slug mismatch, not a directory
mismatch.

## Fix

`src/main/skinStore.ts:bundledSkinPath()` — change the signature to
accept a Character (or look up the character by UUID) so we can read
the `slug` field, and use the slug to construct the resource path:

```ts
export function bundledSkinPath(character: Character): string | null {
  const slug = character.slug ?? slugFromUuid(character.id);
  if (!slug) return null;
  // ... path.join(..., 'resources', 'skins', `${slug}.png`)
}
```

`resolveSkinPng()` already has the `character` object in scope (line 73),
so the call site update is trivial: `bundledSkinPath(character)` instead
of `bundledSkinPath(character.id)`.

`slugFromUuid()` is a defensive fallback for the case where a legacy
default row on disk has `slug: null` (older builds where the slug field
was unknown / stripped). It does a reverse lookup against
`DEFAULT_CHARACTER_UUIDS` to recover the slug.

Add a regression test in `src/main/skinStore.test.ts` that asserts
`resolveSkinPng(suiCharacter)` returns the byte-equal contents of
`resources/skins/sui.png`.

## Sanity Checks

```bash
# (1) Assets exist where the new path will look:
ls resources/skins/{sui,lyra,clawd}.png
# → all three present.

# (2) Bundled JSON carries the slug field:
grep '"slug"' resources/default-characters/*.json
# → sui.json:  "slug": "sui",
# → lyra.json: "slug": "lyra",
# → clawd.json:"slug": "clawd",

# (3) electron-builder packages resources/skins/** under asar.unpacked:
grep -A3 asarUnpack electron-builder.* 2>/dev/null
# → expect resources/skins/** OR resources/** in the unpacked list
```
