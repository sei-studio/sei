/**
 * The "Use ChatGPT plan" switch intent (view.useChatgptPlan, 261023): Credits,
 * the plan offer and the startup popup's chatgpt-plan action sign in, then
 * land on Settings with it so the switch runs through Settings' own path.
 *
 * 261029 review: the intent is one-shot. It used to wait for a ready plan, so
 * a sign-in that came back with plan use declined left it set; it then fired
 * on some later status push (or hung around for the rest of the session).
 * Now it waits only for what is still loading, and is dropped once the
 * answer is known, run or not.
 */
import type { ChatgptStatus } from '@shared/chatgptPlan';
import { chatgptReady } from './stores/useChatgptStore';

export type ChatgptPlanIntentStep =
  /** Config, plan status or backend mode not known yet: keep the intent. */
  | 'wait'
  /** Clear the intent and do nothing (the plan cannot run). */
  | 'drop'
  /** Clear it and open the cloud -> local confirm (billing changes). */
  | 'confirm-cloud'
  /** Clear it and pick ChatGPT as the local provider. */
  | 'pick-local';

export function chatgptPlanIntentStep(
  cfgLoaded: boolean,
  status: ChatgptStatus | null,
  backend: 'cloud-proxy' | 'local' | null | undefined,
): ChatgptPlanIntentStep {
  if (!cfgLoaded || !status || (backend !== 'cloud-proxy' && backend !== 'local')) return 'wait';
  if (!chatgptReady(status)) return 'drop';
  return backend === 'cloud-proxy' ? 'confirm-cloud' : 'pick-local';
}
