/**
 * Playtime page tabs (261110, product call 261110): Sei (the Sei plan on
 * the cloud), ChatGPT (the user's ChatGPT plan as the brain) and My keys
 * (own API keys or a local model). Pure, so the selection rules are tested
 * without React.
 */

export type PlaytimeTab = 'sei' | 'chatgpt' | 'mykeys';

export const PLAYTIME_TABS: readonly PlaytimeTab[] = ['sei', 'chatgpt', 'mykeys'];

/**
 * The tab that matches the current setup, where the page opens: the cloud
 * (or a backend main has not reported yet) is Sei; the local backend is
 * ChatGPT when the ChatGPT plan is the provider, otherwise My keys.
 */
export function playtimeTabForSetup(
  backend: 'cloud-proxy' | 'local' | null | undefined,
  provider: string | null | undefined,
): PlaytimeTab {
  if (backend !== 'local') return 'sei';
  return provider === 'chatgpt' ? 'chatgpt' : 'mykeys';
}

/** Whether `tab` is the setup in use right now (the active tab gets the dashboard). */
export function isActiveSetupTab(
  tab: PlaytimeTab,
  backend: 'cloud-proxy' | 'local' | null | undefined,
  provider: string | null | undefined,
): boolean {
  if (backend !== 'cloud-proxy' && backend !== 'local') return false;
  return playtimeTabForSetup(backend, provider) === tab;
}
