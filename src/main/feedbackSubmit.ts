/**
 * The feedback:submit IPC body, with its analytics (260926).
 *
 * `feedback_submitted` used to fire after every call, including the ones
 * where the proxy send failed: 12 events against 5 stored rows in the 30
 * days to 260926, i.e. 7 submissions from 5 people lost during the 09-03
 * cert outage while the dashboard counted them as received. Now the success
 * event fires only on `ok`, and every failure fires `feedback_failed` with
 * the error code, the HTTP status when the proxy answered, and which step
 * failed. Shape only, never the feedback text.
 *
 * 261109: the Suggest-a-game form adds `form: 'suggest_game'` and
 * `game_hint_shown` (did its "already works in Sei" hint show before the
 * send) to both events. Other forms send neither, as before. These two are
 * analytics only: proxyClient.feedbackSubmit builds the proxy body itself
 * and never forwards them.
 *
 * Pure (deps injected) so the event contract is unit-testable without
 * Electron's ipcMain.
 */
export interface FeedbackArgs {
  body: string;
  email?: string;
  claimReward?: boolean;
  form?: 'suggest_game';
  gameHintShown?: boolean;
}

export type FeedbackResult =
  | { ok: true; usage_reset: boolean; already_claimed: boolean }
  | { ok: false; code: string; status?: number; reason?: string };

export interface FeedbackDeps {
  submit: (args: FeedbackArgs) => Promise<FeedbackResult>;
  track: (event: string, props?: Record<string, string | number | boolean | null>) => void;
}

export async function submitFeedbackTracked(args: FeedbackArgs, deps: FeedbackDeps): Promise<FeedbackResult> {
  const rewardClaim = args.claimReward === true;
  const formProps: Record<string, string | boolean> = args.form
    ? { form: args.form, game_hint_shown: args.gameHintShown === true }
    : {};
  let res: FeedbackResult;
  try {
    res = await deps.submit(args);
  } catch (err) {
    deps.track('feedback_failed', { code: 'EXCEPTION', status: null, reason: 'exception', reward_claim: rewardClaim, ...formProps });
    throw err;
  }
  if (res.ok) {
    deps.track('feedback_submitted', { reward_claim: rewardClaim, ...formProps });
  } else {
    deps.track('feedback_failed', {
      code: res.code,
      status: res.status ?? null,
      reason: res.reason ?? null,
      reward_claim: rewardClaim,
      ...formProps,
    });
  }
  return res;
}
