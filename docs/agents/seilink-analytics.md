# SeiLink analytics (261105)

What SeiLink (her room as the live wallpaper) reports, and which question
each event answers. Shape only, like every surface
(`instrumenting-surfaces.md`): closed enums, counts, durations, buckets and
the character id. Never a line's text, a file name, a path, a model name or
an error message.

- Main sends the host and lifecycle events (`src/main/seilink/host/seilinkHost.ts`,
  `desktopLines.ts`, `seilinkErrors.ts`). The pure parts (the shown
  watchdog, the health sampler, re-attach causes, buckets) are in
  `host/hostTelemetry.ts` and tested there.
- The renderer sends the editor and move-in events through `sei.track`. Main's
  `analytics:track` handler rebuilds their props with `sanitizeSeilinkTrack`
  (`src/shared/seilinkTelemetry.ts`), so a renderer bug cannot add a field.
  The editor's counting is the pure `EditorSessionTracker` in the same file,
  fed by `lib/seilink/editorAnalytics.ts`.
- None of these count as playtime (not in `SESSION_EVENTS`).
- Dev launches send nothing unless `SEI_ANALYTICS_DEV=1`. Filter
  `packaged = true` when reading.

## Did it show

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_started` | first attach of a session | character_id, layout, attach_ms, restored | Did the host attach, how fast |
| `seilink_shown` | first frame that is verified in place, not hidden, not covered and not paused (once per session) | first_frame_ms (from the start), attach_ms, attach_mode `progman`/`workerw`/`mac_desktop_level`/`fake`, late, covered_at_start, paused_at_start, restored, restarts, display_count, scale_factor, resolution, gpu, hw_accel | Did people actually see her, how long it took |
| `seilink_not_shown` | 20 s after the start with no shown frame (once) | reason `no_hello`/`no_attach`/`attach_failed`/`no_frame`/`window_hidden`/`not_verified`/`wallpaper_occluded_at_start`/`paused_at_start`, waited_ms, failure_class?, verify_reasons?, attach_mode, last_failure?, the facts above | "Wallpaper not showing": at which stage it stopped |
| `seilink_verify_failed` | a check after attach found the window out of place (once per reason set) | reasons (closed set, comma list), trigger, shown | Explorer, display or z-order drift after a good attach |
| `seilink_reattached` | the host re-attached (first 3 per cause per session) | cause `explorer_restart`/`display_change`/`session_change`/`resume`/`periodic_check`/`window_lost`/`host_restart`/`other`, detail `shell_lost`/`workerw_lost`/`parent_lost`/`z_order`/`size_mismatch`/`level_drift`/`window_gone`/`host_crash`/`host_hung`/`host_recycled`/`other`, attach_ms, shown, session_ms | Why it had to re-attach |
| `seilink_attach_failed` | an attach failed (once per class) | failure_class, reattach, from_host | Which native step fails |
| `seilink_unavailable` | Move in on an install where the addon is missing or the OS is unsupported (once per reason per run) | reason, restored | Who tried and could not |

`seilink_shown` waits for an uncover: a room covered at start sends
`not_shown` at 20 s with `wallpaper_occluded_at_start`, then `shown` with
`late: true` when the desktop is first seen.

## Health

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_health` | every 30 min of a live session | window_ms, fps_p50, fps_p95, fps_p5, fps_samples (visible time only), visible_pct, covered_pct, paused_pct, detached_pct, heartbeat_misses, mem_mb_max, mem_bucket, dropped_frames_est, cpu_avg, plus the counters below for that window, session_ms, shown, facts | Long sessions: does it stay smooth and small |
| `seilink_ended` | every stop (single choke point) | reason, duration_ms, attached, restarts, failure_class?, session_ms, shown, first_frame_ms, not_shown_reason?, the whole-session health props, all counters, facts | One row per session: how it ran and how it ended |

Counters (on `seilink_ended`, per window on `seilink_health`): `clicks`,
`double_clicks`, `chat_open_focused|reopened|deferred|unknown`,
`reattaches`, `reattach_<cause>`, `host_hangs`, `unverified_frames`,
`verify_fail_<reason>`, `sleeps`, `resumes`, `locks`, `unlocks`,
`poke_<outcome>`, `idle_due`, `idle_skip_<reason>`, `idle_attempted`,
`idle_shown`, `idle_none_<why>`, `expressions` (261105: desktop lines that
carried a face for her avatar), `react_shown`, `react_skip_<reason>`
(261105: room edit reactions).

## Interaction

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_poke` | a double click on her (a refusal repeats quietly for 60 s) | outcome `ok`/`limited`/`free_plan`/`free_cap`/`over_limit`/`no_plan`/`rate_limited`/`occupied`/`busy`/`not_live`/`not_shown`/`silence`/`no_room`/`aborted`/`error`/`depleted`, latency_ms, budget `own`/`paid`/`free`/`none` | Do pokes work, how fast, why not |
| `seilink_room_reaction` | a companion editor session for the desktop resident ended (one per session; nothing for an untouched StrictMode remount) | outcome `shown`/`skipped`, reason `no_change`/`cooldown`/`budget`/`on_call`/`in_game`/`busy`/`not_live`/`silence`/`error`, changes (bucket `0`/`1`/`2`/`3-5`/`6-10`/`11+`), latency_ms (shown), budget `own`/`paid`/`free`/`none` | Does she react to room edits, how fast, why not |
| `seilink_live_line` | decorating together: a live line was due (each skip reason once per session) | outcome `shown`/`skipped`, reason `not_resident`/`on_call`/`in_game`/`cap`/`busy`/`cooldown`/`budget`/`silence`/`error`, changes (bucket), latency_ms (shown), budget | Does she comment while you decorate, why not |
| `seilink_her_edit` | she used decorate (main, surface `chat`/`call`) or the player answered it (editor, outcome `undone`/`tried`) | outcome `applied`/`suggested`/`rejected`/`undone`/`tried`, changes (bucket), rejected (bucket), surface `chat`/`call`/`editor` | Does she decorate, do people keep it |
| `seilink_editor_talk` | a message from the editor's talk box | outcome `sent`/`limit`/`error` | Is the talk box used, how often the cap blocks it |
| `seilink_line_shown` | a bubble line shows | kind poke/idle/react, chars, expression `tag`/`lexicon`/`none` (261105: where her face for the line came from) | How much she talks on the desktop, and how often her face changes with it |
| `seilink_dock_action` | a dock button | action edit/deafen/moveout, deafened? | Dock use |

Idle lines: a "due window" opens when her gap has passed. `idle_due` counts
windows, `idle_skip_<reason>` (cap, covered, paused, deafened, away, busy,
occupied, free_plan, free_cap, over_limit, no_plan) counts each reason once
per window, `idle_attempted` / `idle_shown` / `idle_none_<why>` count tries.
Live lines (decorating together): `live_shown`, `live_skip_<reason>`.

## Move in

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_movein_sheet` | sheet loaded (`shown`), Move in worked (`confirmed`), a try failed (`failed`, once per class), Not now (`dismissed`) | action, reason `first_room`/`swap`/`retry`, preset, pick_room (261106: true = her first room, there is no picker any more), swap, preset_changed (always false since 261106), blank_room (261106: the first room is the blank one), plain_room (261106 v3: she starts on the plain background), packs_available (shown), ms_open, error_class `start_failed`/`save_failed`/`unsupported`/`error`, entry `button`/`gear`/`tour`/`dock` (261105: how the person got here) | Sheet funnel |
| `seilink_moved_in` | host started for her (not a restore) | swapped, preset, first_room, blank_room (261106: the blank first room was created), plain_room + plain_tone `dark`/`light`/`unknown` (261106 v3: she spawned on the plain background, in which OS theme) | Move-ins; plain spawns by theme |
| `seilink_moved_out` | she moved out | via app/dock | Move-outs |

## Entry, first-link intro, tour (261105, T337)

Shapes in `src/shared/seilinkIntroTelemetry.ts`, rebuilt in main by
`sanitizeSeilinkIntroTrack`. There is no settings toggle event any more
(`seilink_setting_toggled` went with the Labs section).

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_entry` | every SeiLink entry click | character_id, source `button`/`gear`/`tour`/`dock`, action `sheet`/`move_in`/`edit`/`move_out`/`replay_intro` | Which entry point people use |
| `seilink_intro` | the intro shows (`shown`), and how it ended (`completed`/`skipped`/`aborted`) | character_id, action, trigger `first_link`/`replay`, style `aurora` (the only one since 261106 v3; `bloom`/`tide` earlier that day, `holo`/`glitch`/`tunnel` before), mood `accretion`/`nebula`/`eclipse` (261106 v3, the space colour mood), end_on `plain_dark`/`plain_light`/`room` (what it settled into), reduced_motion, entry; on the end: beat `tunnel`/`link`/`port`/`linked` (where it ended), duration_bucket `lt3s`/`3_6s`/`6_9s`/`9_12s`/`12_20s`/`gt20s`, host `ok`/`failed`/`pending`/`none` | Do people watch it, where they skip, does the host keep up |
| `seilink_tour` | the guide's tour: `offered`, `sure`, `not_now` (snoozed true on the first, false when it retires), `completed` (the sheet opens), `dropped` (Skip tutorial) | action, audience `new`/`existing`, offer_n (1 or 2), snoozed?, step `offer`/`button`/`room` (dropped) | Tour funnel and snooze outcome |

## First room on the desktop (261106)

Main captures these itself (`main/seilink/decorateOffer.ts`,
`main/seilink/stageFlow.ts`), so there is no renderer sanitizer for them.

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_decorate_offer` | the desktop shows her on the plain background (or the earlier blank room): the offer goes up (`shown`), is answered (`accepted` / `declined`), times out after 10 min (`expired`), ends because she moved out or the room was decorated another way (`closed`), or is not made (`skipped`) | character_id, action, via `intro`/`move_in`, line `her`/`ui` (did she ask in her own line, or the dock in UI copy), line_outcome (ui only: why her line did not come, `budget`/`busy`/`not_live`/`occupied`/`error`/`timeout`/...), wait_ms (shown), ms_open (answers), reason `not_live`/`not_blank`/`already`/`disabled` (skipped) | Offer shown, accepted, declined; how often the budget silences her |
| `seilink_desktop_stage` | the main window steps out over the desktop (`entered`), back (`exited`), could not (`failed`), or stepped aside without it (`revealed`) | character_id, action, purpose `intro`/`editor`/`move_in`, opened_from (editor), reveal + staged_ms + ok (exited), error_class `native_fullscreen`/`busy`/`failed`/`no_window`/`disabled`/`timeout` (the renderer did not ask for the stage within 4 s of the dock's push) | Does the on-desktop editor open, how long it stays, failure classes per platform |

### Guided setup (261106 v3)

Sent by RoomEditor through `sei.track` only when it has `telemetry` (the
companion editor), sanitized in main by `sanitizeSeilinkIntroTrack`
(shared/seilinkIntroTelemetry.ts). Never a colour, item or room choice.

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_setup` | a guided run opens (`started`, or `resumed` when a run was left unfinished), Done is pressed (`finished`), or the editor closes before Done (`abandoned`: close, Escape, Not now) | character_id, action, step (the step on screen: where it was finished or abandoned), surface `desktop`/`app`, plain (she was still on the plain background when it opened), steps_completed, steps_skipped, steps_total, ms_open, opened_from (the editor session's list) | Setup funnel; where people drop; how many resume |
| `seilink_setup_step` | each time a step comes up (`shown`), Next (`completed`), Skip (`skipped`), Back (`back`) | character_id, step `room`/`colours`/`furniture`/`extras`, action, resumed (inside a resumed run), index (1-based position in this pack's steps), changed (completed only: did the room change on that step) | Per-step completion and skip rates |

Plain spawns: `seilink_moved_in` with plain_room, by plain_tone. Setup
started per plain spawn: `seilink_setup` started (plain true) over those.

The editor session also carries `surface` (below): `desktop` when it was on
the stage. Desktop editor opened = `seilink_desktop_stage` entered with
purpose `editor` (by opened_from); closed = exited; saved = the session's
`saves` with surface `desktop`.

## Her look (anima face sets, 261105)

One event, `seilink_anima`, from main (`src/main/anima/animaClient.ts`), with
`phase`. Each phase is sent once per character (and trigger, kind or pack)
per app run.

| phase | When | Props | Answers |
|---|---|---|---|
| `requested` | the first POST /anima/v1/request for her this run | trigger `move_in_sheet`/`editor`/`host_start`/`host_restore`/`portrait_changed`, state (the proxy's first answer), created (this call queued a new bake) | How often SeiLink opens lead to a bake |
| `ready` | her face set is on disk and in use | trigger, from_cache (no bake was waited on), source `disk`/`cloud_cache`/`baked`, wait_ms (from the request), pack_mb? | How long people wait for her look |
| `deferred` | the proxy held the bake | reason `budget`/`user_cap`, trigger, wait_ms | Budget switch and weekly cap hits |
| `no_pack` | her portrait cannot become a face set (final for that portrait) | trigger, wait_ms | Portraits that stay on the fallback |
| `failed` | the bake, the download or the install failed | reason (the bake's, or `network`/`poll_timeout`/`hash_mismatch`/`bad_archive`/`bad_entry`/`too_big`/`no_manifest`/`download`/`bad_reply`/`http_<n>`), trigger | Breakage |
| `unavailable` | the proxy will not bake her | reason `not_configured`/`no_portrait`/`portrait_unreadable`/`moderation`/`not_found` (no cloud row)/`forbidden`, trigger | Characters that cannot get a look |
| `skipped` | nothing was asked | reason `offline`/`signed_out`, trigger | Signed-out and offline SeiLink use |
| `shown` | a RoomAvatar settled on a kind | avatar_kind `live2d`/`rig`/`facepack`/`portrait`/`placeholder`, surface `desktop`/`editor`, anima_state `idle`/`preparing`/`ready` | What people actually see |

## Room editor

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_editor_session` | the editor closes, or the window goes away with it open (one per session; a drag is one edit) | opened_from `gear`/`dock`/`move_in`/`button`/`tour`/`offer` (261106)/`other`, surface `desktop`/`app` (261106: on the desktop stage or in the window), duration_ms, preset, preset_end, first_panel, panels_opened, `panel_<avatar/room/fabrics/furniture/items>`, edits, `edit_<type>`, undos, saves, save_failures, avatar_upload_start/ok/fail, `avatar_fail_<not_zip/too_big/import_failed>`, dirty_at_close, outcome `saved`/`no_changes`/`discarded`, errors; 261105 catalog: `edit_pattern_change`/`edit_accent_change`/`edit_light_colour`/`edit_light_cycle`, patterned_at_close, accents_at_close, cycling_lights_at_close, particle_parts_at_close, particles_on, last_pattern (a code pattern, a painted tile id, `plain` or `other`); 261105 colour pass: preset_color_picks (a preset swatch or the automatic second colour), custom_color_picks (one per finished custom pick: a drag, a typed hex, a key run), recent_color_picks, picker_opens, custom_colors_at_close (tinted parts whose colour is not one of their presets). Never a colour value | Do people edit, what they change, do they save; do patterns and light colours get used |
| (on `seilink_editor_session`) | 261105 (T336), only when the editor was shared with the resident | together, on_call_at_open, live_lines, call_pictures, call_picture_skipped_unchanged, call_picture_rate_limited, her_edits_applied/suggested/rejected/undone/tried, talk_messages, talk_blocked. Her edits are not counted in `edits` / `edit_<type>` | Decorating together usage |
| `seilink_editor_error` | first time per kind per session | kind `load_failed`/`no_packs`/`save_failed`/`avatar_import_failed`, opened_from | Editor breakage |

Edit types (`classifyEdit`, a diff of two history entries):
`swap_component`, `view_change`, `recolour`, `remove_slot`, `add_item`,
`move_item`, `scale_item`, `flip_item`, `recolour_item`, `layer_item`,
`delete_item`, `preset_change`, `time_of_day`, `avatar_change`.
261105: `pattern_change` (slot or item), `accent_change` (the second
pattern colour), `light_colour` (a recolour of a slot the editor names as a
light, via `setLightSlots`; other slots stay `recolour`), `light_cycle` (the
colour cycle turned on or off). There is no separate particles toggle: an
optional slot whose part shows particles (forest fireflies) counts as a
swap or removal, and `particle_parts_at_close` / `particles_on` give the
state at close.

## Errors

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_pack_error` | a pack folder exists but cannot be used (once per pack, source and class per run) | pack_id, source, error_class `manifest_missing`/`manifest_too_big`/`manifest_unreadable`/`manifest_invalid`/`id_mismatch`/`file_missing` | Broken room packs in the field |
| `seilink_room_error` | the room store could not write or read (once per op and class per 10 min) | op write/read, error_class `bad_id`/`pack_missing`/`account_switching`/`permission`/`disk_full`/`busy`/`not_found`/`read_only`/`invalid`/`other` | Lost room edits |

## What it cannot see

- A host that dies before its first heartbeat shows only as
  `seilink_not_shown` (`no_hello`) plus host restarts.
- Whether the chat window that a click opened was actually seen (only the
  open path is known).
- Displays other than the one she lives on.
- fps while macOS App Nap throttles the host reads as low fps, not as a pause.
