# China compatibility + BYOK-everywhere (v0.7 stream) — 260816

Goal: a mainland-China user can browse/adopt cloud characters, bring their own
LLM key, use local STT/TTS, and text/call/play (chess, Draw!, backseat,
Minecraft) fully in local mode. Supported-region cloud users see zero behavior
change (one sanctioned exception: zh-UI cloud users get SenseVoice as the local
STT fallback instead of Whisper).

Research grounding (agents, 260816): MiniMax/Alibaba lead hosted zh TTS (not in
scope this stream); DeepSeek current lineup is `deepseek-v4-flash` /
`deepseek-v4-pro` (legacy `deepseek-chat` alias DISCONTINUED 2026-07-24); V4
thinking mode requires `reasoning_content` round-trip in tool loops (we send
`thinking: {type:'disabled'}` instead); Hugging Face is hard-blocked in CN,
GitHub release assets unreliable, jsDelivr dead; api.sei.gg (Cloudflare) is
reachable-degraded from CN and `GET https://api.sei.gg/cdn-cgi/trace` returns
`loc=CC` (verified; sei.gg apex is Vercel-direct and has no trace endpoint).

## Decisions (user-confirmed 260816)

- Provider list: **anthropic, openai, deepseek, qwen (new), gemini, grok,
  ollama, openrouter**. Dropped providers (mistral, together, groq, fireworks,
  cerebras, perplexity) are GRANDFATHERED: existing configs keep working,
  hidden from the picker unless currently selected.
- Local TTS optimizes for reliability/lightweight over naturalness ("local
  Azure-voice register is fine"). en+zh, male+female each. Engine per research
  (Piper-class; see W3).
- Persona expansion/soulcast for local users runs on the user's BYOK provider.
  Portrait generation stays on the proxy free endpoint where a JWT exists;
  signed-out local creation falls back to the procedural portrait (proxy-side
  anonymous access is a separate sei-proxy follow-up, not this stream).
- FULL onboarding restored for local users: questionnaire answers persisted,
  companion generated (BYOK soulcast via vendored soulcaster prompts),
  full tutorial with the created character.
- Mirrors: models + updater feed on R2 behind `dl.sei.gg` (zone already on
  Cloudflare; free egress).
- Region gate: **client-side, at signup/login only.** Detection =
  `api.sei.gg/cdn-cgi/trace` `loc=`, FAIL OPEN. Blocklist = CN, HK, MO +
  Anthropic-unsupported ∪ Polar-unsupported (embedded constant). Popup: "Our
  servers do not currently support your region. Please continue with local
  mode." (+zh). Existing signed-in sessions untouched. Signed-out cloud
  character Browse keeps working (verified: browse path is anonymous through
  the /supabase proxy).
- System-locale detect: any `zh-*` in `app.getPreferredSystemLanguages()` →
  `ui_language: 'zh'`, ONLY when the user has never explicitly chosen
  (absent field). All other locales stay English.

## Latent bug this stream fixes

The Settings provider picker writes `UserConfig.provider`/`provider_config`
and NOTHING reads them: botSupervisor's init payload omits llm config
entirely, so the bot always runs Anthropic (`src/bot/index.js` fills the llm
sub-tree from Zod defaults). The 13-provider factory was reachable only from
the deleted CLI. W2 wires it for real.

## Architecture: one provider layer, two consumers

New `src/main/llm/` (TypeScript port/extension of `src/bot/brain/llm/`),
implementing the bot's `call()` contract plus what main needs:

```
buildProvider(cfg) -> {
  call({systemBlocks, tools, messages, signal, timeoutMs, maxTokens,
        stopSequences, toolChoice, images-ok, onTextDelta?, onContentBlock?})
    -> {toolUses, text, content, usage, stopReason}   // content: ALWAYS a
       // synthesized anthropic-shaped assistant block array, so tool loops
       // can push it back verbatim (non-Anthropic adapters must fabricate it)
  capabilities: {vision, cached, local, streaming}
  model, kind
}
```

- `cloud-proxy` backend keeps the EXACT current Anthropic-SDK path — zero
  change for cloud users, including cache_control breakpoints.
- `local` + anthropic: current path (streaming, caching) unchanged.
- `local` + openai-compat (openai/deepseek/qwen/grok/openrouter/ollama +
  grandfathered): SSE streaming with text deltas surfaced and tool_calls
  buffered to completion; `stop` mapping; `tool_choice` function mapping;
  cache_control stripped (blocks joined; ordering preserved for implicit
  prefix caching); normalized stopReason ('max_tokens' etc.) and usage.
- gemini: non-streaming v1 (voice sentences arrive at hop end — accepted
  degradation), schema sanitize + idToName reconstruction as in the bot.
- DeepSeek: default `deepseek-v4-flash`, `thinking:{type:'disabled'}`
  extra body, first-token timeout allowance (provider-level timeoutMs floor
  60s — DeepSeek queues instead of 429ing at CN peak; never fast-retry).
- Qwen (new, also added to bot factory): DashScope compatible-mode,
  default base `https://dashscope.aliyuncs.com/compatible-mode/v1` (CN),
  intl override via base_url. Default model `qwen3-max` (verify at impl).

Call-site port order (from the 260816 call-site map; see agent report):
trivial (continuity fold, memoryCompaction adapter, knowledgeStore compact,
chatService one-shots) → medium (chess runner, voice one-shots, chessProfile
forced-tool with JSON fallback) → hard (chat streaming turn, Draw! drawing
thread [stroke streaming Anthropic-only, per-hop reveal elsewhere], backseat).
personaExpansion: provider-generic streaming via the same layer; local
BYOK fetches /free/prompts when signed-in, else uses vendored soulcaster
prompt fallback.

Vision is a PER-MODEL property surfaced as `llmVisionCapable` (config-derived,
not bot-session-derived): static catalog in `src/shared/llmCatalog.ts` +
per-provider heuristics; cloud mode → always true. Renderer gates: games
picker Draw! tile (tileLocked + reason popup), ChatTopBar backseat button,
CallControls share pill; main-side hard block in drawService/backseatService
image calls (renderer gates are bypassable).

## Config/IPC contracts (written first, by hand — agents consume)

- `UserConfig.provider_config[provider] = {model?, base_url?}` (shape now
  enforced; already allow-listed in configStore).
- `UserConfig.stt_engine: 'scribe' | 'whisper' | 'sensevoice'` (extends
  existing field).
- `UserConfig.tts_engine: 'elevenlabs' | 'local'` (new; absent = elevenlabs).
- `UserConfig.tts_local_voices: Record<'en-f'|'en-m'|'zh-f'|'zh-m', boolean>`
  — which packs are downloaded (renderer cache is authoritative; this mirrors
  for UI).
- IPC: `llm:list-models` (per-provider /models fetch + curated merge),
  `llm:test` (1-token probe, returns ok/typed error), `region:status`
  (cached trace lookup), plus tts/stt selection channels as needed.
- Character voice: every character KEEPS `metadata.voiceId` (ElevenLabs).
  Local-TTS mapping: voiceId → gender via voiceAssign VOICES/LEGACY metadata
  → local voice by (gender, chat language); `voicePitch` applies through the
  existing pitchBus; EL picker hidden for local non-EL users (pitch/speed
  only).

## Workstreams

- W1 provider layer + call-site ports (blocked on contracts) — the big one.
- W2 bot wiring: supervisor init payload carries llm config; provider list
  reduction + grandfather; qwen; deepseek fixes (also in bot factory).
- W3+W4 local speech (MERGED — one runtime): sherpa-onnx-node (Apache-2.0,
  prebuilt N-API platform packages, no electron-rebuild) hosts BOTH local TTS
  and SenseVoice STT in main (utilityProcess if it conflicts with
  onnxruntime-node in-process — spike first; chess already loads
  onnxruntime-node in main). transformers.js CANNOT run SenseVoice (no
  export exists); Whisper stays on the existing renderer worker unchanged.
  TTS voice slots (researched 260816, licenses verified):
    en-f + en-m  vits-piper-en_US-libritts_r-medium (CC BY 4.0, ~78 MB,
                 904 speakers; curate one f + one m id; joe-medium CC0 as
                 en-m alternate)
    zh-f         vits-icefall-zh-aishell3 (Apache-2.0, 30 MB; curate a
                 female speaker id)
    zh-m         vits-piper-zh_CN-chaowen-medium (CC0, int8 13 MB + 2 MB
                 g2pW lexicon; pitch analysis says male ~151 Hz — CONFIRM BY
                 EAR before ship; aishell3 male id as same-runtime fallback)
    zh STT       SenseVoice-small int8 (~155 MB; FunASR model license —
                 maintainers state commercial OK; legal read owed)
  Piper's own engine is GPL now (archived rhasspy/piper → OHF piper1-gpl)
  — we never ship the piper ENGINE, only the voice onnx files run under
  sherpa-onnx. espeak-ng data inside the piper-voice path is GPL-3 like our
  existing Stockfish WASM; noted for license review. Models download from
  dl.sei.gg mirror FIRST (k2-fsa GitHub releases are CN-unreliable), main-
  side to <userData>/speech-models/ with progress IPC. Local TTS output
  rides the existing clip pipeline; voicePitch/speed apply via pitchBus
  playbackRate. Kokoro-multi-lang-v1_1 int8 (140 MB, Apache) is a future
  opt-in quality tier, not v1 (not realtime on weak CPUs).
- W5 Settings UI: model picker + Test; TTS/STT sections; download popups
  ((free) label, "Download? (XX MB)" — reuse VoiceCallScreen installOverlay
  pattern, lifted into a shared component).
- W6 onboarding: ProviderSelect (8) replaces the hardcoded LocalSetupPanel
  list; model select + test; STT/TTS steps; restore prefsSave +
  local generateUnique; locale detect on launch.
- W7 region gate (authHandlers + AuthPanel/SignInModal surfaces; OnboardApp
  uses its native panel vocabulary, not ModalShell).
- W8 mirrors: R2 + dl.sei.gg; upload models; client fallback (origin →
  mirror; mirror-first when region=CN); electron-updater mirror feed +
  release CI upload.
- W9 vision gating (after W1's capability plumbing).
- W10 integration: trace all user types through all surfaces; tests; zh
  dictionary sweep; cloud no-regression check.

## User-type trace matrix (W10 exit criteria)

| User | chat | voice call | chess | Draw! | backseat | Minecraft | create |
|---|---|---|---|---|---|---|---|
| Cloud, supported region | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged |
| Local Anthropic BYOK | ✓ | ✓ (EL BYOK or local TTS) | ✓ | ✓ | ✓ | ✓ | BYOK expand + portrait* |
| Local DeepSeek BYOK | ✓ | ✓ | ✓ | gated off (no vision) | gated off | ✓ | BYOK expand |
| Local qwen/openai/etc | ✓ | ✓ | ✓ | per-model vision | per-model | ✓ | BYOK |
| CN user (local) | ✓ | ✓ local TTS/STT, mirrored models | ✓ (mirrored Maia) | per-model | per-model | ✓ | BYOK |
| CN user trying cloud | blocked at signup/login with popup; Browse still works | | | | | | |

*portrait: proxy free endpoint when signed-in; procedural otherwise.

## Non-goals this stream

MiniMax/hosted zh TTS (separate decision), proxy-side changes (anonymous free
endpoints, geo enforcement), Paddle/MoR payment migration, PostHog relay,
WeChat auth, hosted zh ASR.

## W8 infra checklist (blocked on Cloudflare access — Chrome ext offline 260817)

Client + CI are DONE and merged; the following account-side steps remain.
Owner: Ouen (token/secret steps must be done by a human; Claude does not
handle credentials). Claude can drive the dashboard steps via Chrome when
the extension is connected.

1. Cloudflare dash → R2 → create bucket `sei-dl` (location: auto/APAC).
2. Bucket → Settings → Custom Domains → attach `dl.sei.gg` (zone sei.gg is
   already on this account; this auto-creates the DNS record + cert).
3. Create R2 API token (Object Read & Write, scoped to `sei-dl`), then:
   gh secret set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
   on sei-studio/sei (mirror-release.yml consumes them).
4. One-time asset uploads (rclone/aws-cli with that token, or dashboard):
   - /chess/maia3-5m.onnx            (from cce-1 model-v1 release asset)
   - /hf/onnx-community/whisper-tiny.en/resolve/main/**  (transformers.js
     layout — mirror the exact files the pipeline fetches: config.json,
     tokenizer*, onnx/{encoder_model_q*,decoder_model_merged_q*}.onnx etc.)
   - /hf/onnx-community/whisper-base/resolve/main/**
   - /speech/<packs>  — FINAL LIST PENDING W3+W4 (sherpa-onnx packs:
     libritts_r en, aishell3 zh-f, chaowen zh-m, sensevoice-small int8)
   - /updates/ — no manual upload; mirror-release.yml populates on the next
     published release once secrets exist.
5. Verify from a CN vantage (GreatFire Analyzer or a CN node) that
   https://dl.sei.gg/chess/maia3-5m.onnx serves.

### W8 amendments from the W3+W4 landing (260817)
- Speech pack uploads must match `src/main/speech/packs.ts` EXACTLY — note
  the zh-m pack is chaowen **int8** (~14 MB), not the fp32 archive staged in
  mirror-out/; re-stage or the mirror leg 404s (origin fallback covers it
  meanwhile).
- SenseVoice asset pinned to `int8-2025-09-09`; an A/B against
  `int8-2024-07-17` is OWED (2025-09-09 showed garbled EN + constant yue tag
  on its own test wavs). If 2024 wins, packs.ts + mirror both change.
- Ear-checks owed before ship: chaowen sid 0 (male by F0 ~162 Hz, unheard),
  aishell3 8 kHz register acceptability.
- mac x64 artifact ships WITHOUT local speech unless CI force-installs
  sherpa-onnx-darwin-x64 (npm cpu-gating on arm64 runners) — release CI
  change owed, noted in electron-builder.yml.

## W6 landing notes (260817)

Shipped: OnboardApp's local path is a four-step wizard (provider+key → model
list + Test → STT → TTS) and then runs the FULL onboarding arc (prefsSave +
generateUnique + full tutorial). generateUnique now runs in local mode:
sheet via the vendored soulcaster castSoul over src/main/llm, persona via
expandPersona's BYOK path; the model persists in
`provider_config[provider].model` (read by both src/main/llm and the bot
supervisor's init payload). Deliberate degradations, all in-code-commented:
- Portrait/skin (and the public_id fetch-back) are JWT-authed proxy routes,
  so a SIGNED-OUT local cast saves portraitless (procedural portrait) with
  owner null, and emits NO portrait/skin stage ticks — which means the
  in-app SuiMeetScene bar creeps to ~70% before the ok result lands (the
  completion transition covers it; cosmetic only).
- The local sheet uses the VENDORED soulcaster prompts (a local user may be
  signed out; /free/soulcast is unreachable) — prompt improvements reach
  local users on a client ship.
- The wizard's key step saves the API key before config exists (the model
  list needs it); an abandoned wizard leaves a stray key and no config,
  which is harmless and matches ApiKeySetupModal's ordering.
- Local-TTS onboarding downloads the packs for the CURRENT UI language
  (zh → both gendered zh packs, en → the one en pack); other packs come
  later via Settings / the VOICE_PACK_MISSING re-offer.

## W10 landing notes (260817)

Trace matrix walked; fixes landed on this branch (each with tests where the
seam was pinnable):

- Keyless ollama now summons: the supervisor's 260703 hasApiKey guard skipped
  for provider 'ollama' in both _summon and the cloud-to-local switchBackend
  advisory (chat already worked; Minecraft was the blocked surface). The
  ApiKeySetupModal and legacy OnboardingScreen also stopped demanding a key
  for ollama (Settings and the W6 wizard already allowed it).
- The bot init payload now ships the SHARED catalog default model when the
  user never picked one, instead of omitting it and letting the bot's older
  Zod defaults run a different model in Minecraft than every other surface
  (gpt-4o-mini vs gpt-5-mini, grok-2 vs grok-4). Anthropic default is
  identical on both sides, so BYOK byte parity holds.
- The provider-switch key wipe is real now: saveApiKey('') used to be
  rejected by the IPC min(1) schema and swallowed by the renderer's
  best-effort catch, leaving the old vendor's key on disk and sending it to
  the new provider (opaque 401). '' now means CLEAR, implemented as an
  unlink (apiKeyStore.clearApiKey) because hasApiKey() is file-existence
  based.
- Cloud no-regression repairs: the maia model download was unconditionally
  mirror-first for every region (now origin-first unless regionStatus says
  blocked, matching the whisper host loop); the updater's background and
  startup check paths flipped onto the mirror feed on isMissingReleaseArtifacts
  (a release-shape condition, not a network failure) which the manual path
  had always filtered.
- SPEECH_RUNTIME_FAILED now surfaces as a call caption (was total silence on
  e.g. a mac x64 build without the sherpa platform package). zh entry added.
- Legacy re-onboarding no longer wipes provider_config (it submitted {}
  wholesale, discarding model/base_url overrides).
- zh residue: PROVIDER_LABELS now render through t() (zh entries for
  'Ollama (local)' and 'Qwen (Alibaba)'); the duplicate
  'The download failed...' key moved to common.ts (the zh.ts inline spread
  was shadowing the games value); useBackseatStore's three share-error
  strings wrapped in t() with zh entries.

## Ship checklist (compiled by W10, 260817)

Infra and uploads (human or Chrome-driven; blocked on Cloudflare access):
- [x] R2 bucket `sei-dl` (APAC) + `dl.sei.gg` custom domain — DONE 260817
      via dashboard + wrangler OAuth. STILL OWED: scoped API token + the
      three gh secrets (user-only step; exact commands given in chat).
      Why: every mirror path in the client 404s until this exists.
- [x] One-time asset uploads — DONE 260817: all 29 files (chess, both
      whisper HF layouts, 4 speech packs), zero errors, maia sha256
      round-trip verified over dl.sei.gg.
      Why: the mirror leg otherwise 404s and CN users fall back to the hosts
      that are blocked for them.
- [x] chaowen int8 re-stage — DONE 260817: exact 14,011,298-byte archive
      staged and uploaded; fp32 removed.
      Why: packs.ts pins the int8 name and exact byte count; the staged fp32
      file will never be served as anything the client accepts.
- [ ] Verify https://dl.sei.gg/chess/maia3-5m.onnx from a CN vantage.
      Why: the whole point of the mirror; unverified means CN chess is
      still broken at ship.

Speech quality gates (before ship):
- [ ] SenseVoice A/B: `int8-2025-09-09` (pinned) vs `int8-2024-07-17`.
      Why: 2025-09-09 showed garbled EN + a constant yue tag on its own test
      wavs; if 2024 wins, packs.ts AND the mirror upload both change.
- [ ] Ear-check chaowen sid 0 (male by F0 ~162 Hz, never heard by a human)
      and aishell3's 8 kHz register acceptability.
      Why: the zh voice slots ship on pitch analysis alone today;
      AISHELL3_MALE_REGISTER_SID = 40 is the in-code fallback if chaowen
      fails.
- [ ] License reads: SenseVoice FunASR model license (maintainers say
      commercial OK; legal read owed) and chaowen CC0 verification.
      Why: shipping a pack we cannot legally redistribute is a recall.

Release CI:
- [ ] Force-install `sherpa-onnx-darwin-x64` on the mac dist leg (npm
      cpu-gates the optional dep on arm64 runners; noted in
      electron-builder.yml).
      Why: without it the mac x64 artifact ships with local speech that
      cannot load. W10 made the failure a visible caption instead of
      silence, but the fix is the CI install.

Client follow-ups (code, not this branch):
- [ ] Backend-switch port message carries no llm section: a live bot
      switched cloud-to-local mid-session flips to Anthropic BYOK
      regardless of the configured provider; only a re-summon picks up
      deepseek/qwen/etc.
      Why: rare path (live summon + backend switch), but it silently runs
      the wrong provider until re-summon.
- [ ] Settings shows a pack as Ready on a machine where sherpa cannot load
      (readiness is disk-only). A one-shot runtime probe gating the
      'Local (free)' option would close it.
      Why: a user can download 166 MB that can never play.
- [ ] speech pack downloads are mirror-first for ALL regions (deliberate,
      documented in mirrors.ts, 8s mirror connect budget). Decide whether
      to region-gate like whisper/maia now that regionDetect exists in main.
      Why: non-CN users pay up to 8s + R2 egress for every pack while the
      bucket also serves them fine; consistency question, not a bug.
- [ ] removePack does not evict live sherpa engine caches (model memory
      leaks for the rest of the run; UI and calls stay correct because
      tts.ts re-checks packReady per clip). Orphaned `<pack>.extracting`
      dirs are only swept on the next attempt for that same pack (a crash
      mid-SenseVoice-extract can strand ~1 GB).
      Why: hygiene; neither corrupts state.
- [ ] The whole speech archive + decompressed tar are held in RAM during
      extract (~166 MB + expansion for SenseVoice).
      Why: fine on typical machines, worth a streaming extract if low-end
      CN hardware complains.
- [ ] Per-call latency notes from the cloud parity review: buildLlmProvider
      reads config twice per call (once itself, once inside buildChatSdk);
      voice tts reads config once per spoken clip; the dial path awaits
      speechPackStatus with no timeout. None change behavior; a loadConfig
      memo would erase them.
      Why: measurable I/O on hot paths; harmless today.
- [ ] Region gate: the email-code (OTP) redeem and password-reset paths are
      renderer-gated only (the blocked panel removes the links, but main's
      authoritative gate does not cover verifyOtp). Decide whether that is
      by design (existing account holders are deliberately ungated) and
      comment it, or gate it.
      Why: the one session-minting path the authoritative backstop misses.
- [ ] Re-derive the blocklist against Anthropic's supported-countries page:
      the embedded complement yields 13 codes and commonly-listed absences
      (SD, SS, SO, LY, ER, CF, ML, NI, ZW) are missing. Under-inclusive
      fails open (safe direction), but the list claims a source.
      Why: the constant's documented derivation should be reproducible.

Proxy-side (separate repo, out of this stream by decision):
- [ ] Anonymous /free portrait+skin endpoints so a signed-out local cast is
      not portraitless.
      Why: the W6 wizard's documented degradation; the fix is server-side.
- [ ] Soulcaster prompt drift: local casts use the VENDORED prompts;
      improvements reach local users only on a client ship. Consider a
      versioned prompt fetch when signed in.
      Why: quality divergence grows over time.

Resolved by W10 (recorded so nobody re-files them): the hasApiKey/ollama
summon block, the bot-vs-catalog default model divergence, the maia
mirror-first regression, the phantom saveApiKey('') wipe, silent
SPEECH_RUNTIME_FAILED, re-onboarding provider_config wipe, PROVIDER_LABELS /
duplicate-key / backseat-store zh gaps.
