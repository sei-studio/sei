import { z } from 'zod'
import { readFileSync } from 'fs'

// Brain-side config — game-agnostic. The persona, anthropic, llm, and memory
// branches live here; game-specific fields nest under `adapter.<kind>.*`.
//
// The top-level fields `host`, `port`, `auth`, `username`,
// `minecraft_version`, `pathfinder_timeout_ms`, `follow_range` are under
// `adapter.minecraft.*` (not top-level). No backwards-compat shim is provided
// per CLAUDE.md — existing config.json files MUST be updated (the CLI's `sei
// config` flow will rewrite them when re-run, or the loader auto-migrates
// legacy top-level keys at parse time below).

// Adapter sub-tree: minecraft fields. Keep names aligned with the
// pre-refactor top-level shape so call sites only need to update the
// access path, not the field names.
const MinecraftAdapterSchema = z.object({
  host: z.string(),
  port: z.number().int().min(0).optional(),
  auth: z.enum(['offline', 'microsoft']),
  username: z.string(),
  version: z.string().default('auto'),
  reconnect_delay_ms: z.number().int().min(0).default(5000),
  pathfinder_timeout_ms: z.number().int().min(1000).default(12000),
  follow_range: z.number().int().min(1).default(3),
  // Leading-edge throttle window for combat-hit → sei:attacked emission. The
  // FIRST hit fires a reaction immediately; further hits within the window are
  // suppressed so a sustained beating (mob hits land every ~250-500ms) does not
  // re-fire the LLM faster than it can answer. Must comfortably exceed typical
  // Haiku round-trip (~1.5-3s) or every attack reaction gets preempt-aborted
  // before it can speak/act — the combat livelock (Sui frozen + silent while
  // taking damage) seen in the 2026-06-19 playlogs. 0 disables (test escape).
  attack_react_throttle_ms: z.number().int().min(0).default(3500),
  // Reflex evasion micro-controller (Phase 17, D-05). A ~20 Hz physicsTick
  // survival loop (behaviors/reflex.js) that evades incoming damage BEFORE it
  // lands — arrow sidestep, creeper goal-owning flee, melee circle-strafe. It
  // runs entirely on the adapter side (never enters fsm.js). These seven keys
  // are read via the `mc = config?.adapter?.minecraft ?? config ?? {}` slice.
  reflex_enabled: z.boolean().default(true),
  // physicsTick fires at 20 TPS; 50 ms documents the cadence (the loop binds to
  // the event, not a timer). 0 keeps the documented default tick budget.
  reflex_tick_ms: z.number().int().min(0).default(50),
  // Arm the arrow-dodge when a skeleton is within this radius (its ~16-block
  // shoot range) and react to any incoming arrow ray regardless of distance.
  arrow_watch_blocks: z.number().int().min(0).default(16),
  // Closest-approach miss distance (blocks) below which an incoming arrow ray
  // triggers a sidestep. Non-int (sub-block precision) → no `.int()`.
  arrow_miss_threshold: z.number().min(0).default(1.2),
  // Enter creeper flee at this distance (margin over the 3-block / 30-tick
  // ignite so the bot breaks contact before the fuse swells).
  creeper_flee_enter_blocks: z.number().int().min(0).default(8),
  // Exit creeper flee once the creeper is beyond this distance. Enter < exit
  // gives hysteresis so the bot does not oscillate at the boundary.
  creeper_flee_exit_blocks: z.number().int().min(0).default(12),
  // Melee kite band centre (blocks): strafe to hold ~2.5-4 blocks just outside
  // a melee mob's reach. Non-int → no `.int()`.
  melee_kite_blocks: z.number().min(0).default(4.5),
  // Head-look ("gaze", behaviors/gaze.js): cosmetic, LLM-uninvolved tracking of
  // the owner — full yaw+pitch when idle and within range, pitch-only tracking
  // while moving toward them (follow/goTo) so the pathfinder keeps yaw.
  gaze_enabled: z.boolean().default(true),
  // Idle gaze range (blocks). 96 = 6 chunks per the feature request.
  gaze_range_blocks: z.number().int().min(0).default(96),
  // Re-aim cadence (ms) for the gaze controller's plain interval loop. Cosmetic
  // head movement only — no need for reflex.js's ~20 Hz physicsTick cost.
  gaze_tick_ms: z.number().int().min(0).default(250),
  // ── Survival micro-controllers (behaviors/survival.js) ──────────────────
  // A second ~20 Hz physicsTick loop, sibling of the reflex loop, covering the
  // two failure modes reflex.js does NOT: automatic drowning swim-up and a
  // critical-HP flee. Owns its own goal-ownership flags (bot._seiSurvivalActive
  // etc.) disjoint from reflex's; creeper-flee (_seiReflexActive) always wins.
  survival_enabled: z.boolean().default(true),
  // Oxygen (0-20). Engage the swim-up at/below `enter`; disengage at/above
  // `exit` (enter < exit gives hysteresis so we don't flicker at the surface).
  oxygen_flee_enter: z.number().int().min(0).default(10),
  oxygen_flee_exit: z.number().int().min(0).default(18),
  // If the ascent hasn't gained height after this long, treat the top as blocked
  // and swim horizontally toward the nearest air pocket.
  survival_blocked_ms: z.number().int().min(0).default(3000),
  // Critical-HP retreat (health is 0-20). Force-flee the nearest hostile when
  // health <= enter AND a hostile is within the enter radius; keep fleeing until
  // health > exit OR no hostile remains within the (larger) exit radius.
  critical_hp_enter: z.number().min(0).default(6),
  critical_hp_exit: z.number().min(0).default(10),
  critical_hostile_enter_blocks: z.number().min(0).default(8),
  critical_hostile_exit_blocks: z.number().min(0).default(16),
  // GoalInvert(GoalFollow(mob, N)) flee radius — how far to break away to.
  critical_flee_range: z.number().min(0).default(14),
  // Player-knockback stagger window (ms). When a PLAYER hits the bot, combat.js
  // opens this window during which reflex.js, follow.js, and attack.js pursuit
  // stop asserting movement controls so the server knockback impulse plays out
  // visibly instead of being walked off within a tick or two. 0 disables. Kept
  // short so normal movement resumes almost immediately after the shove.
  player_stagger_ms: z.number().int().min(0).default(350),
})

const AdapterSchema = z.object({
  kind: z.literal('minecraft').default('minecraft'),
  minecraft: MinecraftAdapterSchema,
})

export const ConfigSchema = z.object({
  // chat_mode: 'chat' (default) — only `say()` lines reach Minecraft chat.
  // 'full' — assistant `text` (private scratch) ALSO reaches chat with a
  // `[think] ` prefix so the player can watch the bot's reasoning in real
  // time. Default keeps existing config.json files (which lack the field)
  // on the prior behavior.
  chat_mode: z.enum(['chat', 'full']).default('chat'),
  // "Realistic typing" (Appearance & feel toggle, bridged from
  // UserConfig.realistic_typing by botSupervisor). When true, the bot pauses to
  // "read" the player's message (scaled to its length) before replying, then
  // staggers the say() line as if typing it (scaled to the say length) — the
  // same pacing as the in-app chat. Default true; the CLI/standalone path
  // inherits it when config.json omits the field.
  realistic_typing: z.boolean().default(true),
  player_username: z.string(),
  // LAN world MOTD (level name) from discovery, used as a human label for the
  // world registry / MEMORY.md section headers. Optional — falls back to spawn
  // coords when absent (e.g. the broadcast carried no MOTD).
  lan_motd: z.string().nullable().default(null),
  // Friendly name the LLM addresses the player by. Substituted in chat events
  // and convo memory in place of the raw MC username so the bot never speaks
  // the player's gamertag. Falls back to player_username when empty.
  player_display_name: z.string().default(''),
  // 260516-0yw: `backstory` retired in favor of `expanded` — the LLM-generated
  // long-form persona prompt produced at character-save time by
  // src/main/personaExpansion.ts. No backwards-compat shim (per CLAUDE.md
  // "no backwards-compat hacks") — configs missing `persona.expanded` will
  // fail Zod parsing explicitly so the user re-saves the character in the GUI.
  persona: z.object({
    name: z.string().min(1),
    expanded: z.string(),
    // Author-set proactiveness dial (0–2: Passive / Reactive / Agentic).
    // Drives a shared leveled directive injected into the heartbeat block each
    // loop (see prompts.js PROACTIVENESS_DIRECTIVES), the idle-tick CADENCE
    // (IDLE_CADENCE_MS — 10min / 1min / 5s), AND the UI bar. Distinct from
    // goal-completion: a Passive bot still executes accepted standing orders to
    // completion, it just never initiates. Default 1 (Reactive) so configs
    // predating the dial behave sensibly. Legacy value 3 (old "Driven") is
    // remapped to 2 (Agentic) at the read boundary in src/bot/index.js.
    proactiveness: z.number().int().min(0).max(2).default(1),
  }),
  anthropic: z.object({
    // Phase 13-15 (D-40 sub-delivery a): api_key is no longer strictly required
    // when `cloudMode` is set. The bot routes through the Sei proxy with the
    // Supabase JWT in `cloudMode.authToken` and the SDK is constructed with
    // `apiKey: null` (anthropicClient.js buildSdkOptions). BYOK callers still
    // need a non-empty key. The cross-field invariant is enforced via .refine.
    api_key: z.string().default(''),                                        // required by .refine when cloudMode absent
    model: z.string().default('claude-haiku-4-5'),                          // family alias → latest Haiku 4.5 snapshot (no dated pin to drift; see personaExpansion.ts EXPANSION_MODEL)
    // 260610: 20s → 12s. This budget is the player-visible worst-case
    // silence when the backend misbehaves (healthy calls run 1-3s; a slow
    // first call with a full cache write plus anthropicClient's one capped
    // rescue retry still fits comfortably).
    timeout_ms: z.number().int().min(1000).default(12_000),
    // Extended thinking budget. 0 disables. 1024 is the API minimum; thinking
    // adds latency to every call without changing what the model says aloud,
    // since assistant text blocks ARE the chat channel now (see orchestrator).
    // Default off; flip to 1024+ if you want a private scratchpad before tool
    // dispatch.
    thinking_budget_tokens: z.number().int().min(0).default(0),
    // When present, anthropicClient constructs the SDK with
    // {baseURL, authToken, apiKey:null} and routes through the cloud proxy.
    // baseURL points at the public proxy endpoint (https://api.sei.gg);
    // authToken is the user's Supabase access_token. Refresh via
    // anthropic.setAuthToken() from the bot's parentPort {type:'jwt'} handler.
    cloudMode: z.object({
      baseURL: z.string().url(),
      authToken: z.string().min(1),
    }).optional(),
  }).refine(
    (a) => a.cloudMode != null || (a.api_key != null && a.api_key.length > 0),
    { message: 'anthropic.api_key is required when cloudMode is not set' },
  ),
  llm: z.object({
    rate_limit_per_min: z.number().int().min(1).default(30),
    debounce_ms: z.number().int().min(0).default(500),
    max_hops: z.number().int().min(1).default(5),
    // Optional MANUAL override of the idle-tick interval. When absent (the
    // normal case) the cadence is derived from the proactiveness tier in
    // src/bot/brain/index.js (idleCadenceMs: Passive 10min / Reactive 1min /
    // Agentic 5s). Set this only to pin a fixed interval regardless of tier.
    idle_fallback_ms: z.number().int().min(1000).optional(),
    // Phase 14: which provider services the bot loop. Defaults to 'anthropic'
    // so configs predating this phase still boot unchanged. The Anthropic
    // path also covers the Sei cloud proxy (`anthropic.cloudMode`).
    provider: z.enum([
      'anthropic', 'openai', 'gemini', 'grok', 'openrouter', 'ollama',
      'deepseek', 'mistral', 'together', 'groq', 'fireworks',
      'cerebras', 'perplexity',
    ]).default('anthropic'),
    // Per-provider config. Only the active provider's block is required to
    // be populated; the others can stay default-empty.
    providers: z.object({
      openai:     z.object({ api_key: z.string().default(''), model: z.string().default('gpt-4o-mini'),                                       base_url: z.string().url().optional() }).default({}),
      gemini:     z.object({ api_key: z.string().default(''), model: z.string().default('gemini-2.0-flash'),                                  base_url: z.string().url().optional() }).default({}),
      grok:       z.object({ api_key: z.string().default(''), model: z.string().default('grok-2-latest'),                                     base_url: z.string().url().optional() }).default({}),
      openrouter: z.object({ api_key: z.string().default(''), model: z.string().default('anthropic/claude-haiku-4-5'),                        base_url: z.string().url().optional() }).default({}),
      deepseek:   z.object({ api_key: z.string().default(''), model: z.string().default('deepseek-chat'),                                     base_url: z.string().url().optional() }).default({}),
      mistral:    z.object({ api_key: z.string().default(''), model: z.string().default('mistral-small-latest'),                              base_url: z.string().url().optional() }).default({}),
      together:   z.object({ api_key: z.string().default(''), model: z.string().default('meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'),       base_url: z.string().url().optional() }).default({}),
      groq:       z.object({ api_key: z.string().default(''), model: z.string().default('llama-3.3-70b-versatile'),                           base_url: z.string().url().optional() }).default({}),
      fireworks:  z.object({ api_key: z.string().default(''), model: z.string().default('accounts/fireworks/models/llama-v3p3-70b-instruct'), base_url: z.string().url().optional() }).default({}),
      cerebras:   z.object({ api_key: z.string().default(''), model: z.string().default('llama-3.3-70b'),                                     base_url: z.string().url().optional() }).default({}),
      perplexity: z.object({ api_key: z.string().default(''), model: z.string().default('sonar'),                                              base_url: z.string().url().optional() }).default({}),
      ollama:     z.object({ model: z.string().default('llama3.1'),                                                                            base_url: z.string().default('http://localhost:11434') }).default({}),
    }).default({}),
  }).default({}),
  // PLAYER.md tracks the other player's identity (uuid, mc_username, names).
  // MEMORY.md is the bot's append-only long-term memory written via
  // remember()/forget() and shown in full to every loop.
  memory: z.object({
    player_md_path: z.string().default('./memory/PLAYER.md'),
    memory_md_path: z.string().default('./memory/MEMORY.md'),
    // HEARTBEAT.md holds active goals / standing orders, surfaced (with the
    // proactiveness directive) into every loop so multi-step goals survive a
    // loop ending after one step. Written via setGoal()/clearGoal().
    heartbeat_md_path: z.string().default('./memory/HEARTBEAT.md'),
    // worlds.json holds the per-character registry of LAN worlds joined (stable
    // number + fingerprint + label), so memories can be segmented by world and
    // the snapshot can tell the bot which world it's in. See memory/worlds.js.
    worlds_json_path: z.string().default('./memory/worlds.json'),
    // Per-loop tool-use chain bound. This is a RUNAWAY BACKSTOP, not an
    // execution budget: a single dispatch (chat / idle / action-complete) may
    // chain this many LLM turns — including the 10s action-tick monitors that
    // fire while a long-runner is suspended — before being force-closed. 30 was
    // far too low for genuine agentic play (a long gather alone ticks ~6/min, so
    // a multi-step burst hit it routinely); raised to an effectively-unlimited
    // backstop that only trips on a true infinite spin. Set to 0 to disable the
    // cap entirely (no ceiling). The graceful close (orchestrator
    // gracefulCapClose) aborts the in-flight action and asks for one wrap-up line.
    iteration_cap: z.number().int().min(0).default(300),
    seed_memory_budget_bytes: z.number().int().min(256).default(8192),
    // Small: goals are terse, and a big heartbeat would crowd the snapshot.
    seed_heartbeat_budget_bytes: z.number().int().min(128).default(2048),
    seed_player_budget_bytes: z.number().int().min(256).default(1024),
    spawn_settle_delay_ms: z.number().int().min(0).default(500),
    // MEMORY.md compaction trigger: after a successful remember(), if the
    // on-disk file exceeds this byte count, an async Haiku compaction is
    // fired (single-flight). Default sits below seed_memory_budget_bytes so
    // compaction runs before the seed-read truncation kicks in.
    compaction_trigger_bytes: z.number().int().min(512).default(4096),
  }).default({}),
  // In-game vision knobs. Every field is `.default(...)` and the block itself
  // `.default({})`, so existing config.json files that lack a `vision` key
  // parse UNCHANGED (no shim, matching the project's no-backwards-compat-hack
  // stance).
  //
  // mode is the user-facing Looking tier:
  //   'off'        — no pictures; the look tool is not registered.
  //   'on-demand'  — the model can call look()/explore(); no automatic views.
  //   'continuous' — on-demand PLUS an automatic view rides an existing LLM turn
  //                  on a fixed cadence (_PASSIVE_FRAME_INTERVAL_TURNS in the
  //                  orchestrator). Legacy 'passive'/'active' collapse to this.
  //
  // resolution_px is the SINGLE enforcement point of VIS-06's 512×512 ceiling:
  // `.max(512)` here means ConfigSchema.parse REJECTS any larger value, and the
  // downscale/JPEG-encode path (15-01/15-04) reads this cap, so no render can
  // ever exceed it. Default 256 (D-03: aggressive downscale — the model only
  // needs general shapes, not detail). 260705: the old explicit_cap_per_hour
  // knob was removed along with the proxy's vision_hourly gate — explicit
  // renders are metered by the credit ledger like any other turn (existing
  // config.json files carrying the key still parse; Zod strips unknown keys).
  vision: z.object({
    mode: z.preprocess(
      (v) => (v === 'passive' || v === 'active' ? 'continuous' : v),
      z.enum(['off', 'on-demand', 'continuous']),
    ).default('on-demand'),
    image_quality: z.number().min(0.1).max(1).default(0.4),          // "image quality" (D-03)
    resolution_px: z.number().int().min(64).max(512).default(256),   // D-03 ~256; VIS-06 ≤512 HARD CEILING
  }).default({}),
  adapter: AdapterSchema,
})

/**
 * Hoist legacy top-level minecraft fields into adapter.minecraft.* if the
 * caller hasn't already supplied an `adapter` object. This is NOT a
 * backwards-compat shim — it is a one-shot migration applied at parse time
 * so the first run after upgrade still boots. The CLI's `sei config` flow
 * is expected to rewrite config.json with the new shape on next save.
 */
function migrateLegacyAdapterFields(raw) {
  if (raw.adapter && raw.adapter.minecraft) return raw
  const mc = {}
  const moveKey = (k, dst = k) => { if (raw[k] !== undefined) { mc[dst] = raw[k] } }
  moveKey('host')
  moveKey('port')
  moveKey('auth')
  moveKey('username')
  moveKey('minecraft_version', 'version')
  moveKey('reconnect_delay_ms')
  moveKey('pathfinder_timeout_ms')
  moveKey('follow_range')
  if (Object.keys(mc).length === 0) return raw
  return { ...raw, adapter: { kind: 'minecraft', minecraft: mc } }
}

export function loadConfig(path = './config.json', overrides = {}) {
  let raw = JSON.parse(readFileSync(path, 'utf-8'))
  // Allow ANTHROPIC_API_KEY env var to satisfy the required anthropic.api_key field.
  if (!raw.anthropic?.api_key) {
    raw.anthropic = { ...(raw.anthropic ?? {}), api_key: process.env.ANTHROPIC_API_KEY ?? '' }
  }
  raw = migrateLegacyAdapterFields(raw)
  if (overrides.host != null) {
    raw.adapter = raw.adapter ?? { kind: 'minecraft', minecraft: {} }
    raw.adapter.minecraft = { ...raw.adapter.minecraft, host: overrides.host }
  }
  if (overrides.port != null) {
    raw.adapter = raw.adapter ?? { kind: 'minecraft', minecraft: {} }
    raw.adapter.minecraft = { ...raw.adapter.minecraft, port: overrides.port }
  }
  if (overrides.motd != null && String(overrides.motd).trim()) {
    raw.lan_motd = String(overrides.motd).trim()
  }
  return ConfigSchema.parse(raw)
}
