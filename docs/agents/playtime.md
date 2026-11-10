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
  own-key record, main fires once per calendar month
  (`spend_alert_fired_month`), pushes `usage:spend-alert` and the renderer
  shows `SpendAlertBanner` (a NoticeLine). It only warns; nothing is paused.

## Voice

`components/playtime/VoicePanel.tsx`, on the ChatGPT and My keys tabs:
- ChatGPT: Sei voices (signed in) / On this device / ElevenLabs key.
- My keys: On this device / ElevenLabs key / Fish Audio key.
- "On this device" carries its engine (Fast / Kokoro) as a small inline
  select, never a row of its own. Kokoro and SenseVoice download first.
- **Sei voices with the ChatGPT plan** is client-only (`tts_engine: 'sei'`,
  `seiVoicesActive` in `shared/ttsEngine.ts`): `resolveSpeakRoute` sends
  speech through the proxy's `/tts/speech` with the account JWT, which the
  proxy already accepts for any signed-in user. Voice metering on the proxy
  is off today; when it is on, speech draws from the same weekly allowance
  as the Sei plan and a spent allowance answers 402. A refusal (no credits, rate limit, no session, failure) speaks
  the line on the device instead and posts the `sei-voices-fallback` notice
  (`seiVoicesFallbackReason`, paused for a while after an allowance or rate
  refusal). No proxy change was needed.
- "Free this week" shows what is left of the existing weekly allowance
  (the credits store, the same number the Sei tab shows).
- Top-up tiles and the voice plan card are behind `VOICE_PLAN_UI_ENABLED`
  (false). No billing products exist for them.

## Analytics

All through `sei.track`; `main/analytics.ts` files them under the `credits` surface.

| Event | Props | When |
|---|---|---|
| `playtime_tab_viewed` | `tab`, `is_active_setup` | a tab is shown (once per tab and setup) |
| `playtime_backend_switch` | `from`, `to`, `result` (`ok` / `failed` / `cancelled`) | a switch finishes or the confirm is cancelled |
| `chatgpt_usage_link_clicked` | | Manage usage on the ChatGPT tab |
| `voice_trial_state` | `state` (`shown` + `left_pct`; `used_up` / `fallback` + `reason`) | the free Sei-voices meter is shown; a call falls back to device voices |
| `spend_alert_toggled` | `enabled`, `limit_usd` | the alert toggle or amount changes |
| `spend_alert_fired` | `limit_usd`, `provider_kind` | main fires the monthly alert |

## Checks

- Screenshots: `?dashshot=playtime` (`components/DevPlaytimeShot.tsx`) with
  `&setup=sei|chatgpt|mykeys`, `&tab=`, `&gpt=` (ChatGPT state), `&voice=`,
  `&engine=`, `&key=`, `&alert=`, `&banner=1`, `&signedout=1`,
  `&part=settings`, `&lang=`.
- Tests: `shared/llmUsage.test.ts`, `main/usage/llmUsageLedger.test.ts`,
  `lib/playtimeTabs.test.ts`, `lib/playtimeDeepLinks.test.ts`, and the
  moved contracts in `screens/SettingsScreen.test.tsx`.
