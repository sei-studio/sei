# PNGTuber Remix models (`.pngRemix`, 261122 spike)

A person can bring a PNGTuber Remix model into WorldLink and Sei draws it
directly: no Live2D conversion, no rig baking. The room editor's avatar
upload takes a `.pngRemix` file next to the Live2D `.zip`. Main reads the
save once, keeps Sei's own plain spec plus the layer PNGs, and the renderer
plays that spec.

| Piece | File |
|---|---|
| Safe Godot Variant decoder | `src/shared/pngremix/godotVariant.ts` |
| Model reader (save to spec) | `src/shared/pngremix/pngRemix.ts` |
| Import + store | `src/main/avatar/avatarStore.ts` `importPngRemix`, `isPngRemixUpload` |
| Import analytics | `src/main/avatar/pngRemixImport.ts` |
| Motion + drawing | `src/renderer/src/lib/pngremix/pngRemixRig.ts` |
| View (mouth, blink, emotion, fit) | `src/renderer/src/lib/pngremix/PngRemixView.tsx` |
| Test encoder for synthetic saves | `src/shared/pngremix/__fixtures__/godotEncode.ts` |

## The file

A `.pngRemix` is what Godot 4's `FileAccess.store_var(dict, true)` writes:
a u32 length, then one Variant, a Dictionary. Three save generations exist
and all are read:

| Generation | How to tell | Images | Positions |
|---|---|---|---|
| `v14` (1.4.3 and later) | `image_manager_data` is an array | once, in `image_manager_data[].runtime_texture` (PNG bytes), sprites point at them by `image_id` | `position` per state |
| `v13` (1.3.x, early 1.4) | `version` key, no image manager | each sprite's `img` (PNG bytes) | `global_position` per state, `position` is stale |
| `legacy` (unversioned) | neither | `img` as a base64 string | as v13; bounce settings sit at the top of `settings_dict` |

### What we read

- `sprites_array[]`: `sprite_id`, `parent_id`, `sprite_name`, `sprite_type`
  (`Sprite2D`, `WiggleApp` = appendage, `Comment` = dropped), `image_id` or
  `img`, `is_asset`, `was_active_before`, `rest_mode` (4 = still), and per
  state: `visible`, `position`, `offset`, `rotation`, `scale`, `z_index`,
  `colored` (modulate), `tint` (self modulate), `clip`, `flip_sprite_h/v`,
  `should_blink` + `open_eyes`, `should_talk` + `open_mouth`,
  `ignore_bounce`, `physics`, `hframes`/`vframes`/`frame`, the wobble and
  drag keys (`xAmp`, `xFrq`, `yAmp`, `yFrq`, `rot_frq`, `rot_degree`,
  `rLimitMin/Max`, `dragSpeed`, `stretchAmount`, `rdragStr`,
  `should_rotate`, `should_rot_speed`, the `mo_` copies when
  `shared_movement` is off), `folder`, and for appendages `wiggle_segm`,
  `segm_length`, `width`, `wiggle_curve`, `appendage_angle`, `auto_wag`,
  `wag_*`, `tile`, `flip_h/v`.
- `settings_dict`: `states[]` (count, `current_mc_anim` / `current_mo_anim`,
  `mouth_closed` / `mouth_open` one-shots, `state_param_mc` / `_mo` bounce
  numbers, `should_squish` + `squish_amount`), `blink_speed`,
  `blink_chance`, `should_delta`, legacy bounce keys.
- `input_array[].state_name`: state names (empty or numeric names become
  "State N"; duplicates get " (2)").

Old saves: the stored `position` is stale and the old app placed sprites by
`global_position` in a 1280x720 canvas centred on (640, 360). The reader
subtracts that centre and turns each state's global position back into a
parent-relative one, top down (inverse of the parent's attach transform).

### What we ignore

Hotkeys and input events, mouse and controller follow, meshes, shaders and
normal maps, lights, effects and particles, darken, advanced lip sync, the
background colour, `blink_chance` (Sei's own Blinker drives blinks), saved
window and camera settings. Anything not listed above is dropped.

## Safety

The file is untrusted. The rules:

- Godot can store whole Objects inside a Variant, and an Object can carry a
  script. `godotVariant.ts` never builds an Object: it walks past one only if
  its class is on a short allow-list (`InputEvent*`, `*Shape2D`, which Remix
  saves for hotkeys and click shapes) and rejects the whole file if any
  Object has a non-null `script`, if a class is not on the list, if a typed
  container is typed by a script, or if a Callable or Signal appears.
- Every count is checked against the bytes left before a loop starts;
  nesting depth (64), total values (2M) and string length (1 MB) are capped;
  nothing reads past the buffer; unknown type tags fail.
- The reader caps the file (64 MB), layers (512), states (64), images (512),
  each image side (8192) and total pixels (96M). Images must be static PNGs
  (APNG and anything else is skipped and counted), and main runs each one
  through the avatar store's image check again before writing.
- Only plain JSON (`pngremix.json`) and the PNG bytes are written. The
  original file is not kept. Image paths are generated (`img/N.png`), never
  taken from the file.
- The renderer validates the stored spec (`validatePngRemixSpec`: format,
  counts, parents before children, image refs and paths) before drawing.
- A PNGTuber model stays on the device: the shared avatar library never
  uploads one (`avatarLibraryClient.ts` skips `kind: 'pngremix'`).

Failures carry a closed code (`PngRemixErrorCode`): `too_big`,
`not_pngremix`, `unsafe`, `malformed`, `too_many`, `no_layers`,
`image_too_large`; a failed import keeps the previous avatar.

## Rendering

The manifest is an ordinary avatar manifest with `kind: 'pngremix'`,
`entry: 'pngremix.json'`, `expressions` = the state names, and `emotions`
mapped from state names by the usual keyword table (`mapEmotions`, which
also knows `smug` and `laugh` for happy). AvatarView picks PngRemixView by
kind; RoomAvatar treats it like the other imported models (`live2d` / `rig`)
with the figure drawn whole, standing on the slot's bottom edge.

Per layer the rig follows Remix's node chain: sprite transform, blink and
talk visibility, the wobble/drag/rotation/stretch modifier, then the image
at its offset with flips and tint. Children hang under the parent's image
node, so they inherit flips and offset. Container motion follows
`SpritesContainer.gd`: bounce under gravity (`Bouncy` relaunches; one-shot
bounces on mouth open and close), wobble, float, squish, and the squash on
blink. Motion ticks in seconds (`should_delta`) or per frame at 60.
Appendages are drawn as a textured strip along a curling centre line with
auto wag.

- Mouth: talk layers switch on the speech level (open above 0.16, closed
  once it has been under 0.08 for 60 ms). A slow envelope kept the mouth
  open through syllable gaps, so the raw level is used.
- Blink: `motion/organic.ts` Blinker; eyes count as closed past half lid.
- Emotion: the line's emotion picks a state by name, held for the line and
  half its length again, then back to the first state (Live2D timing). An
  emotion that arrives while the model loads applies when it is ready.
- Fit: contain on the first state's rest bounds. `motionHeadroom()` (the
  highest bounce or float) is kept free: bottom-anchored, the rest pose
  sinks by it (up to a quarter of the height) so a bounce peaks where the
  fit put it and the bust's cut edge stays below the floor.
- The host div carries `data-mouth` and `data-eyes` (written on change) for
  shot scripts and tests.

Not supported (draws without it): mouse and controller follow, meshes,
shaders, normal maps, lights, effects, sprite-sheet animation (the saved
frame is shown), appendage physics (wag only), appendage tile mode 1
(drawn stretched), clip groups use the parent image's alpha only and keep
their own z order inside the group.

## Analytics

`seilink_pngremix_import` (main, one per import attempt): `result` `ok` /
`fail`, `reason` (a `PngRemixErrorCode` or `store_failed`), `mb`, and on
success `generation`, count buckets for `layers` / `states` / `images` /
`skipped_images`, `emotions_mapped`, `appendages`. Never a name. The editor
session counts a failed PNGTuber upload as `avatar_fail_pngremix_failed`,
and the shown `avatar_kind` can now be `pngremix`. See seilink-analytics.md.

## Testing

Real models are never checked in (their licenses bar redistribution), so
the tests build synthetic saves with the test encoder:
`godotVariant.test.ts` (plain values, every rejection), `pngRemix.test.ts`
(all three generations, global position rebuild, refusals),
`avatarStore.test.ts` (import, keep-on-failure), `pngRemixImport.test.ts`
(event shape) and the library guard in `avatarLibraryClient.test.ts`.

Room shots in a plain browser tab: the dev stub parses a file in the page
with `?seilink=1&...&use=imported&pngremix=<url of a .pngRemix>`
(`pngremixemo=happy:1` maps an emotion to a state index, `emotion=happy`
sets the line's emotion, `speak=1` talks), e.g.
`scripts/seilink-room-shots.mjs --serve <dir with models> --query
'stage=desktop&use=imported&speak=1&pngremix={SERVE}/model.pngRemix'`.
