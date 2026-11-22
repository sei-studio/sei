# Playtime page (261110)

The rail's star opens **Playtime** (`view.kind === 'credits'`,
`screens/PlaytimeScreen.tsx`). It holds every AI, model and voice choice the
app has. Settings keeps one row, "Brain, voice and plan", that opens it (web
search stays in Settings under Games & search; the "Link ChatGPT" sign-in row
stays in Settings > Account because it is an account setting).

## Tabs

| Tab | Setup | Not in use | In use |
|---|---|---|---|
| Sei | `ai_backend_kind: 'cloud-proxy'` | one line + Switch to Sei (sign-in first when signed out) + Manage billing for paid plans | `SeiPlanTab` (CreditsScreen.tsx: usage, plans, billing) + the optional ElevenLabs key row |
| ChatGPT | `local` + `provider: 'chatgpt'` | one line + the official Continue with ChatGPT button (`ChatgptPlanSettings compact`) | Brain: Using ChatGPT plan, model, Disconnect, our count of plan replies this week with 7-day bars, Manage usage (chatgpt.com). Voice panel |
| My keys | `local` + any other provider | one line + Switch to my keys | Brain: provider, model, masked key. This week / This month spend, spend per day, the monthly alert. Voice panel |

- The page opens on `view.tab` when a deep link set it, else on
  `playtimeTabForSetup(backend, provider)` (`lib/playtimeTabs.ts`). An unknown
  backend (main has not reported) opens Sei and marks no tab active.
- Every switch goes through `SwitchBackendConfirmModal` (one heads-up line,
  plus the renew note for a paid Sei plan). `applySwitch` in PlaytimeScreen
  is the only switch path: ChatGPT sets the provider first, then
  `proxyConfigure('local')`; My keys off the ChatGPT plan resets the provider
  to anthropic and clears the key slot; Sei is `proxyConfigure('cloud-proxy')`.
- Deep links: the credit wall (`HardStopModal`) goes to `tab: 'chatgpt'` or
  `'mykeys'`; the plan offer, the startup popup action and the usage-limit
  popup go to `tab: 'chatgpt', useChatgptPlan: true` (the one-shot intent,
  `chatgptPlanIntentStep`); the spend alert goes to `'mykeys'`.
- No percent meter and no reset time for the ChatGPT plan: OpenAI does not
  tell us the plan's remaining usage. The reply count is ours.

## Usage ledger (replies and own-key spend)

- `shared/llmUsage.ts` (pure): normalizes every provider's usage shape
  (Anthropic, OpenAI Responses, chat completions, Gemini), prices it from
  public vendor list prices (`MODEL_PRICES`, longest id prefix, `vendor/`
  dropped), summarizes 7 days and the calendar month, and decides the alert
  (`shouldFireSpendAlert`). A model with no price shows tokens, never $0.
  Ollama is free; the ChatGPT plan is never priced.
- `main/usage/llmUsageLedger.ts`: one `llm-usage.json` per profile (per-day,
  per provider|model totals, 62 days kept). Writes are serialized and
  registered with `trackScopedWrite` (tests that remove the profile dir must
  `drainScopedWrites()` first). Fed by `withUsageMeter` (main's own
  providers: chat surface, persona expansion) and by the bot's
  `meterProvider` through the `llm-usage` port message (botSupervisor).
  Cloud calls are never recorded: the proxy's ledger is the truth there.
- The renderer reads it through `sei.usageSummary()` (`useUsageStore`, every
  60 s while the page is open).
- Spend alert: `spend_alert_enabled` + `spend_alert_usd` (config). After each
  own-key record, main fires once per calendar month per amount
  (`spend_alert_fired_month` + `spend_alert_fired_usd`: raising the amount
  re-arms it), pushes `usage:spend-alert` and the renderer shows
  `SpendAlertBanner` (a NoticeLine). It only warns; nothing is paused.
- 261120 (`main/capNotices.ts`, also the credit wall): main keeps the alert
  until the banner is dismissed (`usage:spend-alert-pending` / `-ack`), so a
  window opened after it fired (macOS with no window, a reload) still shows
  it, and when the app window is not in front it posts an OS notification
  (Electron Notification; Windows needs `app.setAppUserModelId('com.sei.app')`,
  set in index.ts) plus a Dock bounce / taskbar flash. Dev check:
  `SEI_DEV_CAP_NOTICE=spend|wall` (+ `SEI_DEV_CAP_NOTICE_HIDE=1`), unpackaged
  only. Packaged check of the wall: `scripts/cap-wall-stub.mjs` +
  `SEI_PROXY_URL`.

## Voice

`components/playtime/VoicePanel.tsx`, on the ChatGPT and My keys tabs:
- ChatGPT: On this device / ElevenLabs key. Sei voices (signed in) and its
  "Free this week" row are built but hidden behind
  `SEI_VOICES_FOR_CHATGPT_ENABLED` (`shared/ttsEngine.ts`, false), see below.
- My keys: On this device / ElevenLabs key / Fish Audio key.
- Sei tab (cloud): the optional ElevenLabs key (only for voices in the user's
  own ElevenLabs account and the Voice Library tile; Sei's pool voices and
  STT never use it), then one collapsed "Advanced" line
  (`components/playtime/CloudVoiceAdvanced.tsx`, 261120): Voice provider (Sei
  voices, default, or Fish Audio) and the Fish Audio key. Stored as
  `cloud_tts_provider`; main's `fishOnCloud` sends a cloud line to Fish ONLY
  when it is 'fish' (tts_engine / local_tts_model never do, privacy). Fish
  cannot be picked without a saved key; removing the key goes back to Sei
  voices; a failed Fish line is spoken by Sei's voices with the
  `fish-cloud-fallback` notice. Fish usage is on the user's own key.
- "On this device" carries its engine (Fast / Kokoro) as a small inline
  select, never a row of its own. Kokoro and SenseVoice download first.
- **Sei voices with the ChatGPT plan** is OFF (`SEI_VOICES_FOR_CHATGPT_ENABLED`
  false, review 261110): the proxy does not meter voice yet, and a ChatGPT-plan
  user never spends the Sei allowance, so it would be unlimited cloud speech at
  our cost. While off, `seiVoicesActive` is false for every config, so a saved
  `tts_engine: 'sei'` reads as the ElevenLabs engine and `resolveSpeakRoute`
  never returns the proxy route on the ChatGPT plan (pinned in
  `main/voice/elevenLabsKeyStore.test.ts`). Turn it on only together with proxy
  voice metering. When on, it is client-only (`tts_engine: 'sei'`,
  `seiVoicesActive` in `shared/ttsEngine.ts`): `resolveSpeakRoute` sends
  speech through the proxy's `/tts/speech` with the account JWT, which the
  proxy already accepts for any signed-in user. Voice metering on the proxy
  is off today; when it is on, speech draws from the same weekly allowance
  as the Sei plan and a spent allowance answers 402. A refusal (no credits, rate limit, no session, failure) speaks
  the line on the device instead and posts the `sei-voices-fallback` notice
  (`seiVoicesFallbackReason`, paused for a while after an allowance or rate
  refusal). No proxy change was needed.
- "Free this week" (flag on only) shows what is left of the existing weekly allowance
  (the credits store, the same number the Sei tab shows).
- Top-up tiles and the voice plan card are behind `VOICE_PLAN_UI_ENABLED`
  (false). No billing products exist for them.
- **Voice Library voices on Sei cloud (261119).** In the voice picker a
  cloud user (not BYOK, not on-device voices: `libraryPasteShown`) pastes an
  ElevenLabs Voice Library link or voice id. Main
  (`main/voice/libraryVoices.ts`) calls the proxy's
  `/tts/library-voice/lookup|add|:id` routes with the JWT; the proxy checks
  the voice (standard rate, no live moderation, long notice period, not
  delisted, allowed category), adds it to Sei's ElevenLabs account and lets
  `/tts/speech` play it for everyone, metered like a pool voice. The pick is
  stored as `metadata.voiceLibrary` {name, gender} (`shared/voiceIds.ts`);
  `assignedVoiceId` honours it for adopters too (no owner check). When the
  proxy refuses it at synthesis (retired after long idle, or removed),
  `tts.ts` retries once with `libraryVoiceStandInId` (same gender pool voice),
  posts the `library-voice-unavailable` notice and skips the voice for 10
  minutes; the picker's current row says it is gone. Preview clips come only
  from the URL the proxy returned (`isAllowedPreviewUrl`). Rejections are
  reason codes with one line of copy each (`libraryReasonCopy`). Events,
  shape only: `library_voice_rejected` {reason, stage},
  `library_voice_add_attempted`, `library_voice_added` {already},
  `library_voice_unavailable_shown`, `library_voice_fallback`. Screens:
  `?dashshot=voicekey&part=picker` (+`&lib=rejected|removed`).

## Analytics

All through `sei.track`; `main/analytics.ts` files them under the `credits` surface.

| Event | Props | When |
|---|---|---|
| `playtime_tab_viewed` | `tab`, `is_active_setup` | a tab is shown (once per tab and setup) |
| `playtime_backend_switch` | `from`, `to`, `result` (`ok` / `failed` / `cancelled`) | a switch finishes or the confirm is cancelled |
| `chatgpt_usage_link_clicked` | | Manage usage on the ChatGPT tab |
| `voice_trial_state` | `state` (`shown` + `left_pct`; `used_up` / `fallback` + `reason`) | the free Sei-voices meter is shown; a call falls back to device voices (both only with the flag on) |
| `spend_alert_toggled` | `enabled`, `limit_usd` | the alert toggle or amount changes |
| `spend_alert_fired` | `limit_usd`, `provider_kind` | main fires the monthly alert |
| `playtime_voice_advanced_opened` | `provider` | the Sei tab's Voice > Advanced line is opened |
| `playtime_cloud_voice_provider_switched` | `to` (`sei` / `fish`), `via` (`choice` / `key_removed`) | the cloud voice provider changes |
| `playtime_cloud_voice_provider_blocked` | `reason` (`no_key`) | Fish Audio picked with no key saved |
| `fish_key_saved` / `fish_key_removed` | `surface` (`cloud` / `mykeys`), `replaced` | the Fish Audio key row |
| `voice_fish_cloud_spoke` | `stage` (`clip` / `stream`) | main: first cloud line Fish spoke this run |
| `voice_fish_cloud_failed` | `reason` (FishFailureReason), `stage` | main: a cloud Fish line fell back to Sei voices (once per class per run) |

## Checks

- Screenshots: `?dashshot=playtime` (`components/DevPlaytimeShot.tsx`) with
  `&setup=sei|chatgpt|mykeys`, `&tab=`, `&gpt=` (ChatGPT state), `&voice=`,
  `&engine=`, `&key=`, `&alert=`, `&banner=1`, `&signedout=1`,
  `&part=settings`, `&lang=`.
- Tests: `shared/llmUsage.test.ts`, `main/usage/llmUsageLedger.test.ts`,
  `lib/playtimeTabs.test.ts`, `lib/playtimeDeepLinks.test.ts`, and the
  moved contracts in `screens/SettingsScreen.test.tsx`.




