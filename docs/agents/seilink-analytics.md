# WorldLink analytics (261105)

WorldLink was called SeiLink until 261106; the event names keep `seilink_*`.

What WorldLink (her room as the live wallpaper) reports, and which question
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
| `seilink_ended` | every stop (single choke point) | reason (261106 v6 adds `link_failed`: the WorldLink intro's link failed after the host had started, so it was stopped), duration_ms, attached, restarts, failure_class?, session_ms, shown, first_frame_ms, not_shown_reason?, the whole-session health props, all counters, facts | One row per session: how it ran and how it ended |

Counters (on `seilink_ended`, per window on `seilink_health`): `clicks`,
`double_clicks`, `chat_open_focused|reopened|deferred|unknown`,
`reattaches`, `reattach_<cause>`, `host_hangs`, `unverified_frames`,
`verify_fail_<reason>`, `sleeps`, `resumes`, `locks`, `unlocks`,
`poke_<outcome>`, `idle_due`, `idle_skip_<reason>`, `idle_attempted`,
`idle_shown`, `idle_none_<why>`, `expressions` (261105: desktop lines that
carried a face for her avatar), `react_shown`, `react_skip_<reason>`
(261105: room edit reactions), and 261110: `press_tap`, `press_drag`,
`press_long` (every completed press on her, so taps that turned into drags
show), `press_near_miss` (a press within 48 px of her box but outside it),
`gpu_process_gone`, `voice_lines` (call lines of hers relayed to the room),
`voice_levels` (lines whose real audio level reached the room).

261110 facts (on the facts props): `gpu_status` (Chromium's
`gpu_compositing` status from a closed set, e.g. `enabled`,
`disabled_software`, `unavailable_software`, else `other`), `refresh_hz`
(bucket `60`, `75`, `90_100`, `120`, `144`, `gt_150`, `lt_55`, `unknown`),
`facts_when` (`start`, `first_frame`, `gpu_update`, `display`). The
start-time `gpu` read comes before the GPU process is up and said `off` on a
PC that composites on the GPU; the facts are sent again 500 ms after the
first frame and on Chromium's gpu-info-update (at most every 5 s).

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
| `seilink_entry` | every WorldLink entry click | character_id, source `button`/`gear`/`tour`/`dock`, action `sheet`/`move_in`/`edit`/`move_out`/`replay_intro` | Which entry point people use |
| `seilink_intro` | the intro shows (`shown`), and how it ended (`completed`/`skipped`/`aborted`; since 261106 v6 `aborted` = closed from the WorldLink failure line, and the v6 intro runs 30 s or longer so duration_bucket is mostly `gt20s`: use `seilink_intro_link.total_ms`) | character_id, action, trigger `first_link`/`replay`, style `aurora` (the only one since 261106 v3; `bloom`/`tide` earlier that day, `holo`/`glitch`/`tunnel` before), mood `eclipse` (261106 v4: the only colour mood; `accretion`/`nebula` were sent on 261106 v3 builds only), end_on `plain_dark`/`plain_light`/`room` (what it settled into), reduced_motion, entry; on the end: beat `tunnel`/`link`/`port`/`linked` (where it ended), duration_bucket `lt3s`/`3_6s`/`6_9s`/`9_12s`/`12_20s`/`gt20s`, host `ok`/`failed`/`pending`/`none` | Do people watch it, where they skip, does the host keep up |
| `seilink_intro_link` | once per intro, when it ends (or is unmounted): how the WorldLink status lines went (261106 v6, `lib/seilink/worldLink.ts` linkReport) | outcome `success` (the success line landed)/`failed` (the failure line showed and was closed)/`abandoned` (skipped or closed before either), failure `offline`/`network`/`timeout`/`bake_failed`/`install`/`http`/`auth`/`host`/`error` (failed only), trigger, reduced_motion, lines_shown (0 to 9), line_1_ms .. line_9_ms (how long each line was on screen), total_ms, slowest (the milestone that took longest after the one before: `sent`/`answered`/`running`/`baked`/`installed`/`host`) + slowest_ms, anima_start (her bake's `AnimaStage` when the intro started, or `none`). No character id, no text | Is the link fast enough, which stage is slow, how often it fails and why |
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
| `seilink_setup_step` | each time a step comes up (`shown`), Next (`completed`), Skip (`skipped`), Back (`back`). 261107: the `login` step after Done: `shown`, "Turn on" (`completed`), "Not now" (`skipped`), the editor closed on it unanswered (`closed`) | character_id, step `room`/`colours`/`furniture`/`extras`/`login`, action, resumed (inside a resumed run), index (1-based position in this pack's steps; not on `login`), changed (completed only: did the room change on that step); `login` answers only: enabled, kept_default (the preselected "Turn on" was taken), ok (the OS took it) | Per-step completion and skip rates; login step shown vs answered, default kept vs turned down |

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
| `requested` | the first POST /anima/v1/request for her this run | trigger `move_in_sheet`/`editor`/`host_start`/`host_restore`/`portrait_changed`, state (the proxy's first answer), created (this call queued a new bake) | How often WorldLink opens lead to a bake |
| `ready` | her face set is on disk and in use | trigger, from_cache (no bake was waited on), source `disk`/`cloud_cache`/`baked`, wait_ms (from the request), pack_mb? | How long people wait for her look |
| `deferred` | the proxy held the bake | reason `budget`/`user_cap`, trigger, wait_ms | Budget switch and weekly cap hits |
| `no_pack` | her portrait cannot become a face set (final for that portrait) | trigger, wait_ms | Portraits that stay on the fallback |
| `failed` | the bake, the download or the install failed | reason (the bake's, or `network`/`poll_timeout`/`hash_mismatch`/`bad_archive`/`bad_entry`/`too_big`/`no_manifest`/`download`/`bad_reply`/`http_<n>`), trigger | Breakage |
| `unavailable` | the proxy will not bake her | reason `not_configured`/`no_portrait`/`portrait_unreadable`/`moderation`/`not_found` (no cloud row)/`forbidden`, trigger | Characters that cannot get a look |
| `skipped` | nothing was asked | reason `offline`/`signed_out`, trigger | Signed-out and offline WorldLink use |
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

## Open at login (261107)

Main-side, `src/shared/openAtLogin.ts` lists the closed sets.

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_login_item_changed` | the setting changed: by the user (`setup`/`settings`) or found off in the OS at launch (`os`). `setup` is the step after the guided room setup (261107, preselected on: enabled true = the default kept, false = "Not now"); builds before it sent `move_in` (the move-in sheet switch, retired) | enabled, surface `setup`/`settings`/`os`, ok, platform | Opt-in rate per surface, how often people turn it off in the OS |
| `seilink_login_item_failed` | registering, removing or reading the item threw, or the read-back did not match | failure_class `register_threw`/`unregister_threw`/`read_threw`/`readback_mismatch`/`requires_approval`/`not_found`, phase `set`/`sync`, enabled, platform, 261110: os_state `on`/`off`/`disabled`/..., launch_items (count, 9 = 9 or more), target_kind `velopack_stub`/`velopack_current`/`exe` (Windows) | Does registration work per OS |
| `seilink_login_launch` | a login launch after its startup restore | outcome `room`/`nothing_to_show` (quiet quit), opened (the window was shown before that) | Do login launches bring her back |
| `seilink_login_launch_opened` | a login launch's window first shown | via `room`/`dock`/`second_launch`/`other`, after_ms | Do people open Sei from her room after a login |

`app_opened` carries `login_launch` (true for a login launch), so normal and
login starts can be told apart.

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

## Setup pass (261110, product call 261110)

`src/shared/seilinkSetupTelemetry.ts` owns these; main's analytics:track
rebuilds the props with `sanitizeSeilinkSetupTrack` (closed enums, a capped
count, the character id). `seilink_minimize_windows` is sent by main itself
(`stageFlow.handleMinimizeOthers`).

| Event | When | Props | Answers |
|---|---|---|---|
| `seilink_setup_call` | the Call button by the room editor's talk box | character_id, outcome `started`/`consent_shown`/`install_started`/`installed`/`install_failed`/`declined`/`error`, guided (the guided setup was open), gate `ready`/`installing`/`consent` (the voice module when pressed) | Do people call her while setting up; how often the voice module is in the way |
| `seilink_live_hint` | the "{name} lives on your desktop now" card (once per account, until dismissed) | character_id, action `shown`/`dismissed` (Got it)/`minimized` (Minimize other windows / Hide other apps)/`show_desktop` (the window went hidden while it was up: Win+D), surface `intro_end` (over the first link's last frame)/`app_window` (in the app after a move-in without the intro), os `mac`/`windows`/`linux` | Is the card read; how people get to the desktop |
| `seilink_minimize_windows` | "Minimize other windows" ran (main) | outcome `ok`/`failed`/`unsupported`, windows (how many were minimized, Windows only, capped at 50), surface `live_card`/`other`, os | Does the minimize work per platform |
| `seilink_placement_guide` | the first drop of a dragged item, per kind of place, per editor session | mode `outline` (the outlined areas that replaced the blur), cls `floor`/`surface`/`wall`, placed (true: the item was dropped) | Sanity check that the outline guide shows |

`seilink_movein_sheet` also carries `notice: 'beta_v1'` since 261110: the
sheet's bullets became one short beta notice.
