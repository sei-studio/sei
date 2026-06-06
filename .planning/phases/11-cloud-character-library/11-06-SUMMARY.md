---
phase: 11
plan: 06
subsystem: portrait-pipeline
tags: [portrait, image-validation, canvas-resize, ipc, schema-refinement]
requires:
  - 11-03  # CharacterSchema UUID id + paths.portraitPath helper
  - skinImageUtil.parsePngIhdr  # reused for PNG dim check
provides:
  - src/main/portraitImageUtil.ts (validatePortrait)
  - src/main/portraitStore.ts (applyPortrait, removePortrait)
  - IPC chars:apply-portrait + chars:remove-portrait
  - CharacterSchema.portrait_image data-URL refinement
affects:
  - src/renderer/src/components/PortraitImagePicker.tsx (no more base64 data URLs)
  - src/renderer/src/screens/AddCharacterScreen.tsx (picker is characterId-bound)
  - src/renderer/src/components/EditCharacterModal.tsx (picker is characterId-bound)
tech-stack:
  added: []
  patterns:
    - "canvas.toBlob + chunked btoa for renderer-side image re-encode"
    - "main-side defense-in-depth re-validation via portraitImageUtil.validatePortrait"
    - "z.string().uuid() path-traversal gate (T-11-06-03)"
key-files:
  created:
    - src/main/portraitImageUtil.ts
    - src/main/portraitImageUtil.test.ts
    - src/main/portraitStore.ts
    - src/main/portraitStore.test.ts
  modified:
    - src/shared/characterSchema.ts (data: refinement)
    - src/shared/ipc.ts (chars.applyPortrait / chars.removePortrait + RendererApi)
    - src/preload/index.ts (charsApplyPortrait / charsRemovePortrait bindings)
    - src/main/ipc.ts (handlers + UUID-only Zod gate)
    - src/renderer/src/components/PortraitImagePicker.tsx (canvas resize + IPC)
    - src/renderer/src/screens/AddCharacterScreen.tsx (characterId prop, no double-save)
    - src/renderer/src/components/EditCharacterModal.tsx (characterId prop)
decisions:
  - "Portrait bytes cross IPC as base64 (mirrors skin.apply); main re-validates and atomic-writes to <userData>/portraits/<uuid>.png"
  - "Renderer canvas-resize always re-encodes to PNG (drops JPEG/WebP source format) so the on-disk file extension is stable"
  - "Picker requires a persisted characterId; AddCharacterScreen mounts it only after step 1 creates the character"
metrics:
  duration: "~7 min"
  tasks_completed: 3
  files_created: 4
  files_modified: 7
  tests_added: 14
  tests_passing: 63 / 63
  completed: 2026-05-21
---

# Phase 11 Plan 06: Portrait Pipeline File-on-Disk Summary

Moved portrait images out of inline base64 data URLs and onto disk under
`<userData>/portraits/<uuid>.png`, with magic-byte + size + PNG-dim validation
at the main-process trust boundary and a Zod refinement preventing future
data-URL regressions. Unblocks Plan 11-07's cloud Storage upload — Postgres
rows no longer carry base64 image data (Pitfall 2).

## What Changed

### Task 1 — `portraitImageUtil.validatePortrait`

- New module `src/main/portraitImageUtil.ts` (49 lines).
- Magic-byte gate: accepts PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), WebP
  (`52 49 46 46 ... 57 45 42 50`).
- 500 KB pre-decode byte cap (D-28) blocks decompression bombs (T-11-06-02).
- PNG dim check reuses `skinImageUtil.parsePngIhdr` (1024×1024 cap, D-28).
- 4 named error sentinels: `PORTRAIT_TOO_LARGE`, `PORTRAIT_TOO_SHORT`,
  `PORTRAIT_BAD_MAGIC`, `PORTRAIT_TOO_LARGE_DIM`.
- 9 vitest cases (`src/main/portraitImageUtil.test.ts`) cover all 7 plan
  behaviors plus the 1024×1024 boundary and the height-dimension case.

### Task 2 — `portraitStore` + IPC

- New module `src/main/portraitStore.ts` exporting `applyPortrait` and
  `removePortrait`.
- Uses the existing `atomicWrite` + `withFileLock` brain helpers and
  writes to `paths.portraitPath(uuid)`.
- Defense-in-depth: re-validates bytes via `validatePortrait` BEFORE
  writing — main is the trust boundary.
- IPC channel `chars:apply-portrait` accepts
  `{ characterId, bytesBase64, format }`, validates characterId via
  `z.string().uuid()` (T-11-06-03 path-traversal defense — characterId is
  a filesystem path component).
- Companion channel `chars:remove-portrait` for the "Remove" button.
- 5 vitest cases (`src/main/portraitStore.test.ts`): round-trip, bad-magic
  rejection, missing-character rejection, removal unlink, ENOENT tolerance.

### Task 3 — Renderer canvas-resize + schema refinement

- `PortraitImagePicker.tsx` rewritten (~210 lines): no more base64 data URLs.
  Picks a file → decodes to `<img>` → redraws to `<canvas>` at
  min(originalDim, 1024) preserving aspect → `canvas.toBlob('image/png')` →
  chunked-`btoa` base64 → `sei.charsApplyPortrait(...)` → stores the returned
  path reference in `onChange`.
- Picker now requires a `characterId` prop. AddCharacterScreen wires step 2
  to mount the picker only after step 1 has persisted the character (so the
  id exists). EditCharacterModal passes the existing `character.id`.
- `CharacterSchema.portrait_image` gains a Zod refinement rejecting any
  string starting with `data:` (D-28 + Pitfall 2 — Postgres TOAST bloat
  prevention + permanent regression net).
- AddCharacterScreen's `persistPortrait` no longer double-saves the
  character — the picker already writes the JSON via main; we only refresh
  the local store.
- User-facing error mapping: `PORTRAIT_*` sentinels become friendly copy
  (e.g. "Only PNG, JPEG, or WebP images are accepted.").

## Deviations from Plan

- **[Rule 3 — Blocking issue] AddCharacterScreen no longer double-saves
  the character.** The plan's must-haves implied a transparent change, but
  the picker now invokes `sei.charsApplyPortrait` which itself calls
  `saveCharacter` inside main. The pre-existing `persistPortrait` would
  have run a second `saveCharacter` with the same field value — at best
  redundant, at worst overwriting any out-of-band edits. Replaced the
  second save with `refreshCharacter`.
- **[Rule 2 — Critical functionality] Friendly error mapping in the
  picker.** The plan's renderer side referred to "renderer maps to copy"
  in the error vocabulary docblock but didn't include the mapping code.
  Added a small `prettifyError` helper so users see real prose instead
  of `PORTRAIT_TOO_LARGE: 524289 > 512000`.
- Plan said the picker should use the source image's encoded MIME type
  (PNG/JPEG/WebP) on send. The renderer canvas only produces PNG via
  `toBlob('image/png', ...)`, so the picker always sends `format: 'png'`.
  Acceptable per the plan note "always re-encode to PNG since renderer
  canvases produce PNG by default."

## Acceptance Verification

Task 1 grep gates:
- `export function validatePortrait`: 1 match ✓
- `PORTRAIT_MAX_BYTES = 500 * 1024`: 1 match ✓
- `PORTRAIT_MAX_DIM = 1024`: 1 match ✓
- `PNG_MAGIC|JPEG_MAGIC|WEBP_RIFF`: 6 matches (≥3) ✓
- `npx vitest run src/main/portraitImageUtil.test.ts`: 9/9 passing ✓

Task 2 grep gates:
- `IpcChannel.chars.applyPortrait` in `src/main/ipc.ts`: 1 match ✓
- `chars:apply-portrait` in `src/shared/ipc.ts`: 1 match ✓
- `charsApplyPortrait|applyPortrait` in `src/preload/index.ts`: 1 line ≥1 ✓
- `validatePortrait` in `src/main/portraitStore.ts`: 4 matches ✓
- `npx vitest run src/main/portraitStore.test.ts`: 5/5 passing ✓

Task 3 grep gates:
- `toBlob|canvas` in `PortraitImagePicker.tsx`: 9 matches ≥1 ✓
- `charsApplyPortrait|applyPortrait` in `PortraitImagePicker.tsx`: 2 matches ✓
- `data:` literal in `PortraitImagePicker.tsx`: 0 matches ✓
- `startsWith('data:')` in `characterSchema.ts`: 1 match ✓
- `1024` in `PortraitImagePicker.tsx`: 5 matches ≥1 ✓

Full-suite tests: 63/63 passing (`npx vitest run`).

Typecheck: 0 new errors. Baseline pre-existing errors
(`src/main/auth/loopbackPkce.ts(83,57)`,
`src/main/auth/supabaseClient.test.ts(19,58)`) unchanged — out of scope for
this plan.

## Threat Model Coverage

| Threat ID | Disposition | Where mitigated |
|-----------|-------------|-----------------|
| T-11-06-01 (polyglot file) | mitigate | `validatePortrait` magic-byte check at main; renderer canvas re-encode also strips embedded payloads |
| T-11-06-02 (decompression bomb) | mitigate | 500 KB pre-decode byte cap (D-28); renderer canvas resizes to ≤1024² before send |
| T-11-06-03 (path traversal via characterId) | mitigate | `z.string().uuid()` Zod gate in `IpcChannel.chars.applyPortrait` handler — UUID regex blocks all traversal vectors |
| T-11-06-04 (TOAST bloat from base64) | mitigate | Schema refinement rejects `data:` prefix; picker never produces one |
| T-11-06-05 (cross-user portrait leak) | accept | Local cache under `<userData>` — same trust model as v0.1.1 |

## Deferred Issues

None for this plan. Plan 11-19 will resolve the path reference
`<uuid>.png` to an actual displayable URL (currently the renderer's
`<img src="<uuid>.png">` will silently fall back to `PixelPortrait`'s
procedural rendering via the existing `onError` handler — acceptable
interim per plan must-have).

## Commits

| Task | Type | Hash | Subject |
| ---- | ---- | ---- | ------- |
| 1 (RED) | test | 4403d61 | add failing tests for portraitImageUtil validatePortrait |
| 1 (GREEN) | feat | 5584166 | implement portraitImageUtil.validatePortrait (D-28) |
| 2 (RED) | test | f83ef7f | add failing tests for portraitStore.applyPortrait |
| 2 (GREEN) | feat | 8ebc80b | wire portraitStore + chars:apply-portrait IPC channel |
| 3 | feat | 7842258 | canvas-resize PortraitImagePicker + data: refinement on schema |

## Self-Check: PASSED

- `src/main/portraitImageUtil.ts`: FOUND
- `src/main/portraitImageUtil.test.ts`: FOUND
- `src/main/portraitStore.ts`: FOUND
- `src/main/portraitStore.test.ts`: FOUND
- Commit 4403d61: FOUND
- Commit 5584166: FOUND
- Commit f83ef7f: FOUND
- Commit 8ebc80b: FOUND
- Commit 7842258: FOUND
