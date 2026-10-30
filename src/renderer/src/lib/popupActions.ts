/**
 * Startup popup actions, renderer side (261029).
 *
 * A popup page's button is a link to https://sei.gg/popup/_action/<name>.
 * Main intercepts the click (popupFrameGuards.ts), checks the name against
 * POPUP_ACTIONS (src/shared/popupActions.ts) and pushes it here;
 * StartupPopup closes the popup and calls runPopupAction. The name is checked
 * again on this side, and a name without a case below does nothing.
 *
 * Each action reuses the path the app's own button for the same thing takes,
 * so a popup can never do anything the user could not do with one click in
 * the app.
 *
 *   chatgpt-plan  Settings, scrolled to the ChatGPT plan row (view.focus),
 *                 then whatever that row's own button would do right now:
 *                 - not signed in to ChatGPT: start "Continue with ChatGPT"
 *                   (the browser sign-in; Settings shows the "finish in your
 *                   browser" line with Cancel), and once it succeeds run the
 *                   same "Use ChatGPT plan" switch the row runs;
 *                 - signed in but plan use was declined at that sign-in:
 *                   the sign-in again with plan use asked for
 *                   (enablePlan, the row's "Turn on ChatGPT plan"), and the
 *                   switch only if it then really is on;
 *                 - signed in, plan not in use: the "Use ChatGPT plan" switch
 *                   (view.useChatgptPlan: the cloud -> local confirm, or just
 *                   the provider pick on the local backend). Nothing switches
 *                   away from Sei credits without that confirm;
 *                 - already using the plan, or a sign-in already running:
 *                   only show the row.
 *
 * One action at a time (the in-flight latch below), so a double click cannot
 * start two browser sign-ins.
 */
import type { ChatgptStatus } from '@shared/chatgptPlan';
import { isPopupAction } from '@shared/popupActions';
import { chatgptReady, useChatgptStore } from './stores/useChatgptStore';
import { useUiStore } from './stores/useUiStore';

/** What the chatgpt-plan action does, given the plan status and provider. */
export type ChatgptPlanStep =
  /** Already in use, or a sign-in is already running: just show the row. */
  | { kind: 'show' }
  /** Signed in with plan usage: run the "Use ChatGPT plan" switch. */
  | { kind: 'switch' }
  /** Start the sign-in the visible button would start. */
  | { kind: 'sign-in'; opts?: { accountId?: string | null; enablePlan?: boolean } };

/**
 * Pure: mirror what the ChatGPT row in Settings offers for this status (see
 * ChatgptPlanSettings). `provider` is the local provider in use
 * (useUiStore.llmProvider), 'chatgpt' when the plan is already picked.
 */
export function planChatgptPlanAction(status: ChatgptStatus | null, provider: string | null): ChatgptPlanStep {
  if (status?.signingIn) return { kind: 'show' };
  const usingPlan = provider === 'chatgpt';
  if (chatgptReady(status)) return usingPlan ? { kind: 'show' } : { kind: 'switch' };
  const acc = status?.accounts.find((a) => a.id === status.activeId) ?? null;
  // Signed in, but plan use was not turned on at that sign-in: only a sign-in
  // that asks for plan use again can fix that (a plain one re-approves the
  // same scopes and leaves the plan off). The row's "Turn on ChatGPT plan".
  if (acc?.signedIn) return { kind: 'sign-in', opts: { accountId: acc.id, enablePlan: true } };
  if (!usingPlan || !acc) return { kind: 'sign-in' };
  // The plan is picked but its account's sign-in ended: sign that one in again.
  return { kind: 'sign-in', opts: { accountId: acc.id } };
}

/**
 * Longest an action holds the in-flight latch. The latch is released when
 * the action settles; this only frees it if a sign-in never settles. By then
 * main reports the sign-in as running (status.signingIn), which
 * planChatgptPlanAction turns into "only show the row".
 */
export const POPUP_ACTION_LATCH_MS = 120_000;

/**
 * Set from the first moment an action starts, before any await: a double
 * click on the page's button sends the action twice, and the second one must
 * not start a second browser sign-in (main's signIn aborts the first). The
 * store's status.signingIn only turns true after main's push, too late.
 */
let inFlight: ReturnType<typeof setTimeout> | null = null;

/** Tests only: drop the latch. */
export function _resetPopupActionLatch(): void {
  if (inFlight) clearTimeout(inFlight);
  inFlight = null;
}

async function runChatgptPlan(): Promise<void> {
  const ui = useUiStore.getState();
  const chatgpt = useChatgptStore.getState();
  // The host loads the status at mount; a popup can beat that load.
  if (!chatgpt.status) await chatgpt.load();
  const step = planChatgptPlanAction(useChatgptStore.getState().status, ui.llmProvider);
  ui.navigate({ kind: 'settings', focus: 'chatgpt-plan', ...(step.kind === 'switch' ? { useChatgptPlan: true } : {}) });
  if (step.kind !== 'sign-in') return;
  const res = await useChatgptStore.getState().signIn(step.opts);
  // Like the row's own button: a sign-in that worked goes on to the switch.
  // Only while the player is still on Settings (one who wandered off during
  // the browser step keeps their place and finds the "Use ChatGPT plan"
  // button on the row), and only if plan use really is on now: a sign-in that
  // came back with it declined again has nothing to switch to, and leaves no
  // switch intent waiting for a plan that is not coming.
  const now = useUiStore.getState();
  const readyNow = chatgptReady(useChatgptStore.getState().status);
  if (res?.ok && readyNow && now.view.kind === 'settings' && now.llmProvider !== 'chatgpt') {
    now.navigate({ kind: 'settings', useChatgptPlan: true });
  }
}

/**
 * Run a popup action by name. Returns whether the name was an action this
 * build knows (unknown names do nothing). Never throws.
 */
export async function runPopupAction(name: unknown): Promise<boolean> {
  if (!isPopupAction(name)) return false;
  // One at a time: a second click while the first is still running is a
  // known action that does nothing.
  if (inFlight) return true;
  const latch = setTimeout(() => {
    if (inFlight === latch) inFlight = null;
  }, POPUP_ACTION_LATCH_MS);
  inFlight = latch;
  try {
    switch (name) {
      case 'chatgpt-plan':
        await runChatgptPlan();
        return true;
      default:
        return false;
    }
  } catch {
    // The store calls already swallow their errors; this is a backstop so a
    // popup click can never surface an unhandled rejection.
    return true;
  } finally {
    clearTimeout(latch);
    if (inFlight === latch) inFlight = null;
  }
}
