/**
 * Build, device and provider facts stamped on every analytics event (261031,
 * T278 / scale plan C7 + PostHog audit fixes 1-2).
 *
 * Pure (no electron, no fs) so every rule here is unit-tested in
 * analyticsContext.test.ts. analytics.ts feeds it the live values.
 *
 *   channel        stable | beta | test | dev. `dev` = unpackaged. A packaged
 *                  build is stable or beta ONLY when release.yml baked that
 *                  channel in (SEI_RELEASE_CHANNEL, electron.vite.config.ts);
 *                  any other packaged build (a local `npm run dist:*`, the
 *                  winpack / Velopack spike workflows, a dry run) is `test`.
 *                  The baked value cannot claim stable for a prerelease
 *                  version: v0.7.0-beta.1 is beta whatever the env said.
 *   send gate      events leave the machine only from stable/beta builds,
 *                  unless SEI_ANALYTICS_DEV=1 is set at runtime (the dev and
 *                  test channel tags then keep them filterable). Before this,
 *                  dev launches and spike builds wrote ~90 fake persons into
 *                  production PostHog in October.
 *   device id      a salted sha256 of the device-global id (auth/deviceId.ts).
 *                  Never the raw id: that one gates trial claims server-side.
 *   rollout bucket 0..99 from the same raw id under a different salt, stable
 *                  per device. For staged features and comparing cohorts; it
 *                  is NOT the updater's per-version staging bucket.
 *   ai_provider    cloud | chatgpt | byok | ollama | unset, the same mapping
 *                  as the bot's llmMetaFromConfig, so every surface (not just
 *                  mc_session_actions) says which AI it ran on. `backend`
 *                  lumped ChatGPT, own key and Ollama together as "local".
 *   model_family   a closed enum derived from the model id (claude, gpt,
 *                  llama, qwen, ...). The raw id never ships: an Ollama model
 *                  name is whatever the user typed.
 */
import { createHash, randomBytes } from 'node:crypto';

export type ReleaseChannel = 'stable' | 'beta' | 'test' | 'dev';

/**
 * The baked channel arrives as a tagged string (`sei-channel=stable`) so a
 * release can grep its bundle for it: release.yml fails a tag build whose
 * dist/main lacks the tag, the same guard it runs for SEI_WIN_PUBLISHER.
 */
export const CHANNEL_TAG_PREFIX = 'sei-channel=';

/** Parse the baked tag. Anything unexpected reads as '' (no channel baked). */
export function parseBakedChannel(raw: string | undefined | null): string {
  const s = (raw ?? '').trim();
  if (!s.startsWith(CHANNEL_TAG_PREFIX)) return '';
  const v = s.slice(CHANNEL_TAG_PREFIX.length);
  return v === 'stable' || v === 'beta' || v === 'test' ? v : '';
}

/** A semver prerelease part: 0.7.0-beta.1 → 'beta.1', 0.7.0 → ''. */
function prerelease(version: string): string {
  const core = version.split('+')[0];
  const i = core.indexOf('-');
  return i < 0 ? '' : core.slice(i + 1);
}

export function resolveChannel(input: { packaged: boolean; baked: string; version: string }): ReleaseChannel {
  if (!input.packaged) return 'dev';
  const pre = prerelease(input.version);
  if (input.baked === 'stable') return pre ? (pre.startsWith('beta') ? 'beta' : 'test') : 'stable';
  if (input.baked === 'beta') return pre.startsWith('beta') ? 'beta' : 'test';
  return 'test';
}

/** True when `SEI_ANALYTICS_DEV=1` (or `true`) is set: send from dev/test builds. */
export function devAnalyticsFlag(env: Record<string, string | undefined>): boolean {
  const v = (env.SEI_ANALYTICS_DEV ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** The hard send gate: stable and beta builds, or any build with the dev flag. */
export function analyticsSendAllowed(channel: ReleaseChannel, devFlag: boolean): boolean {
  return devFlag || channel === 'stable' || channel === 'beta';
}

const DEVICE_SALT = 'sei-analytics-device-v1:';
const ROLLOUT_SALT = 'sei-rollout-v1:';

/** The analytics device id: 32 hex chars of a salted sha256 of the raw device id. */
export function analyticsDeviceId(rawDeviceId: string): string {
  return createHash('sha256').update(DEVICE_SALT + rawDeviceId.trim().toLowerCase()).digest('hex').slice(0, 32);
}

/** Stable 0..99 bucket for this device. */
export function deviceRolloutBucket(rawDeviceId: string): number {
  const h = createHash('sha256').update(ROLLOUT_SALT + rawDeviceId.trim().toLowerCase()).digest();
  return h.readUInt32BE(0) % 100;
}

/**
 * A UUIDv7 (RFC 9562): 48-bit ms timestamp, version 7, random rest. PostHog
 * reads `$session_id` as a v7 to place the session in time, so a v4 there
 * would be dropped from its sessions table.
 */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  const ts = BigInt(Math.max(0, Math.floor(now)));
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── AI provider ──────────────────────────────────────────────────────────────

export type AiProviderKind = 'cloud' | 'chatgpt' | 'byok' | 'ollama' | 'unset';

/** Closed model-family enum; first match wins, so order matters (gpt-oss before gpt). */
const MODEL_FAMILIES: ReadonlyArray<[string, RegExp]> = [
  ['claude', /claude|haiku|sonnet|opus/],
  ['gpt_oss', /gpt-oss/],
  ['gpt', /(^|[/:-])(gpt|chatgpt|o[1-9])([-.:]|$)|gpt-?\d/],
  ['gemini', /gemini/],
  ['gemma', /gemma/],
  ['llama', /llama/],
  ['qwen', /qwen|qwq/],
  ['deepseek', /deepseek/],
  ['mistral', /mistral|mixtral|ministral|magistral|codestral|devstral/],
  ['grok', /grok/],
  ['phi', /(^|[/:-])phi/],
  ['glm', /glm/],
  ['kimi', /kimi|moonshot/],
  ['sonar', /sonar/],
  ['command', /command|cohere/],
];

export function modelFamily(model: string | null | undefined): string | null {
  const m = (model ?? '').trim().toLowerCase();
  if (!m) return null;
  for (const [family, re] of MODEL_FAMILIES) if (re.test(m)) return family;
  return 'other';
}

/** The slice of UserConfig the provider props need. */
export interface ProviderConfigSlice {
  provider?: string | null;
  provider_config?: Record<string, unknown> | null;
}

export interface ProviderProps {
  ai_provider: AiProviderKind;
  /** The configured provider enum ('anthropic', 'openai', 'ollama', ...), 'sei_cloud', or 'unset'. */
  llm_provider: string;
  model_family: string | null;
}

/** Same keys the bot's llmMetaFromConfig reports on mc_session_actions. */
export function providerProps(
  backendKind: 'local' | 'cloud-proxy',
  onboarded: boolean,
  cfg: ProviderConfigSlice | null,
  defaultModels: Readonly<Record<string, string>>,
): ProviderProps {
  if (backendKind === 'cloud-proxy') return { ai_provider: 'cloud', llm_provider: 'sei_cloud', model_family: 'claude' };
  if (!onboarded) return { ai_provider: 'unset', llm_provider: 'unset', model_family: null };
  const provider = typeof cfg?.provider === 'string' && /^[a-z0-9_]{1,24}$/.test(cfg.provider) ? cfg.provider : 'anthropic';
  const entry = cfg?.provider_config?.[provider];
  const picked =
    entry && typeof entry === 'object' && typeof (entry as { model?: unknown }).model === 'string'
      ? ((entry as { model: string }).model as string)
      : '';
  const model = picked.trim() || defaultModels[provider] || '';
  const kind: AiProviderKind = provider === 'ollama' ? 'ollama' : provider === 'chatgpt' ? 'chatgpt' : 'byok';
  return { ai_provider: kind, llm_provider: provider, model_family: modelFamily(model) };
}

export type PlanProp = 'free' | 'quest' | 'party' | 'none' | 'unknown';

// ── Purchases ───────────────────────────────────────────────────────────────

export type PlanTierProp = 'free' | 'quest' | 'party';

/** What one signed-in credits snapshot (proxyClient.creditsGet) says about the plan. */
export interface PlanSnapshot {
  userId: string;
  plan: PlanTierProp;
  /** Extra (top-up) credits granted in total, display credits. */
  extraTotal: number;
}

export interface DetectedPurchase {
  /** subscription = free to paid, upgrade = a higher tier, topup = more extra credits. */
  kind: 'subscription' | 'upgrade' | 'topup';
  tier: PlanTierProp;
  from_tier: PlanTierProp;
  /** Top-ups only: the credits the pack added (the pack size, never a price). */
  credits_added?: number;
}

const TIER_RANK: Record<PlanTierProp, number> = { free: 0, quest: 1, party: 2 };

/**
 * A purchase the app can see: two snapshots of the SAME account in a row,
 * where the tier went up or the top-up total grew. Polar's webhook writes the
 * grant server-side and the app only learns of it from its next credits read
 * (a focus refresh after the browser checkout), so this is "the app learned
 * of a completed purchase", not the payment itself. The first snapshot of a
 * process or of an account has no baseline and never counts. A downgrade or a
 * renewal is not a purchase.
 */
export function detectPurchase(prev: PlanSnapshot | null, next: PlanSnapshot): DetectedPurchase | null {
  if (!prev || prev.userId !== next.userId) return null;
  if (TIER_RANK[next.plan] > TIER_RANK[prev.plan]) {
    return { kind: prev.plan === 'free' ? 'subscription' : 'upgrade', tier: next.plan, from_tier: prev.plan };
  }
  const added = Math.round(next.extraTotal - prev.extraTotal);
  if (Number.isFinite(added) && added > 0) {
    return { kind: 'topup', tier: next.plan, from_tier: prev.plan, credits_added: added };
  }
  return null;
}

let processSession: string | null = null;

/** This process's analytics session id (UUIDv7), shared by analytics and crash reporting. */
export function processSessionId(): string {
  processSession ??= uuidv7();
  return processSession;
}

/** The channel tag release.yml baked into this bundle, '' when none. */
export function bakedChannel(): string {
  return parseBakedChannel(import.meta.env.SEI_RELEASE_CHANNEL);
}
