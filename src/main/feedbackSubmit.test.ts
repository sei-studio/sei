import { describe, it, expect, vi } from 'vitest';
import { submitFeedbackTracked } from './feedbackSubmit';

// 260926: feedback_submitted used to fire on every call. 12 events against 5
// stored rows in 30 days: 7 lost sends were counted as received.
describe('submitFeedbackTracked', () => {
  it('fires feedback_submitted only on success', async () => {
    const track = vi.fn();
    const res = await submitFeedbackTracked(
      { body: 'x', claimReward: true },
      { submit: async () => ({ ok: true, usage_reset: true, already_claimed: false }), track },
    );
    expect(res.ok).toBe(true);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('feedback_submitted', { reward_claim: true });
  });

  it('fires feedback_failed with code, status and reason on a failed send', async () => {
    const track = vi.fn();
    const res = await submitFeedbackTracked(
      { body: 'x' },
      { submit: async () => ({ ok: false, code: 'PROXY_NETWORK', status: 525, reason: 'http_error' }), track },
    );
    expect(res).toEqual({ ok: false, code: 'PROXY_NETWORK', status: 525, reason: 'http_error' });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('feedback_failed', {
      code: 'PROXY_NETWORK',
      status: 525,
      reason: 'http_error',
      reward_claim: false,
    });
    expect(track).not.toHaveBeenCalledWith('feedback_submitted', expect.anything());
  });

  it('fills null for a failure without a status (signed out)', async () => {
    const track = vi.fn();
    await submitFeedbackTracked({ body: 'x' }, { submit: async () => ({ ok: false, code: 'PROXY_NO_SESSION' }), track });
    expect(track).toHaveBeenCalledWith('feedback_failed', { code: 'PROXY_NO_SESSION', status: null, reason: null, reward_claim: false });
  });

  it('fires feedback_failed and rethrows when the submit throws', async () => {
    const track = vi.fn();
    await expect(
      submitFeedbackTracked({ body: 'x' }, { submit: async () => { throw new Error('boom'); }, track }),
    ).rejects.toThrow('boom');
    expect(track).toHaveBeenCalledWith('feedback_failed', expect.objectContaining({ code: 'EXCEPTION' }));
    expect(track).not.toHaveBeenCalledWith('feedback_submitted', expect.anything());
  });
});
