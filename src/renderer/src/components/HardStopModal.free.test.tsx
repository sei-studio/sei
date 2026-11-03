/**
 * HardStopModal "Keep playing free" (261103, T307): a free player at the
 * credit wall also gets the ways to keep playing that cost Sei nothing, the
 * ChatGPT plan and their own API key or local model.
 *
 * Rendered with react-dom/server against seeded stand-ins for the two stores
 * (SSR reads a zustand store's INITIAL state, as in ChatgptPlanHost.test.tsx).
 * PlanButton is replaced by a stub that records its props, so a test can
 * "click" a button by calling the onClick the modal passed it.
 *
 * Invariants:
 *   F.1 — the options show for a free plan at the credit wall, and not for a
 *         rate limit or a subscriber's wall.
 *   F.2 — the ChatGPT option is hidden when the plan is already the provider
 *         in use, and when the region check said blocked.
 *   F.3 — each click tracks credit_wall_action with its own action, dismisses
 *         the popup FIRST, then routes: 'chatgpt' through the shared
 *         startChatgptPlan flow, 'own_key' to Settings at the AI Backend row.
 *   F.4 — the region check is the region:status pre-check and feeds the
 *         options; copy is plain (no em dash, never "friend") and translated.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  order: [] as string[],
  track: [] as Array<{ event: string; props: Record<string, unknown> }>,
  startRan: true,
  buttons: [] as Array<{ label: string; onClick?: () => void }>,
}));

vi.mock('../lib/ipcClient', () => ({
  sei: {
    platform: 'darwin',
    track: (event: string, props: Record<string, unknown>) => {
      h.order.push(`track:${String(props.action)}`);
      h.track.push({ event, props });
    },
    regionStatus: async () => ({ loc: null, blocked: false }),
  },
}));

vi.mock('../lib/popupActions', () => ({
  startChatgptPlan: async () => {
    h.order.push('startChatgptPlan');
    return h.startRan;
  },
}));

vi.mock('./PlanButton', () => ({
  PlanButton: (props: { children: React.ReactNode; onClick?: () => void }) => {
    h.buttons.push({ label: renderToStaticMarkup(<>{props.children}</>), onClick: props.onClick });
    return <button type="button">{props.children}</button>;
  },
}));

const credits: Record<string, unknown> = {};
const ui: Record<string, unknown> = {};
vi.mock('../lib/stores/useCreditsStore', async (orig) => {
  const real = await orig<typeof import('../lib/stores/useCreditsStore')>();
  Object.assign(credits, real.useCreditsStore.getState());
  return {
    ...real,
    useCreditsStore: Object.assign((sel: (s: typeof credits) => unknown) => sel(credits), { getState: () => credits }),
  };
});
vi.mock('../lib/stores/useUiStore', async (orig) => {
  const real = await orig<typeof import('../lib/stores/useUiStore')>();
  Object.assign(ui, real.useUiStore.getState());
  return { ...real, useUiStore: Object.assign((sel: (s: typeof ui) => unknown) => sel(ui), { getState: () => ui }) };
});

const { HardStopModal, wallFreeOptions } = await import('./HardStopModal');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'HardStopModal.tsx'), 'utf-8');
const ZH = readFileSync(resolve(__dirname, '../lib/i18n/zh/modals.ts'), 'utf-8');

const navigations: unknown[] = [];

function render(opts: { plan?: string; reason?: string; llmProvider?: string | null } = {}): string {
  h.buttons = [];
  Object.assign(credits, {
    hardStopActive: true,
    hardStopReason: opts.reason ?? 'depleted',
    plan: opts.plan ?? 'free',
    over_limit: true,
    resets_at: null,
    acknowledgeHardStop: () => {
      h.order.push('acknowledge');
      credits.hardStopActive = false;
    },
  });
  Object.assign(ui, {
    llmProvider: opts.llmProvider ?? null,
    navigate: (v: unknown) => {
      h.order.push('navigate');
      navigations.push(v);
    },
  });
  return renderToStaticMarkup(<HardStopModal />);
}

function button(label: string): { label: string; onClick?: () => void } {
  const b = h.buttons.find((x) => x.label.includes(label));
  if (!b) throw new Error(`no button "${label}" (have: ${h.buttons.map((x) => x.label).join(' | ')})`);
  return b;
}

beforeEach(() => {
  h.order = [];
  h.track = [];
  h.startRan = true;
  navigations.length = 0;
});

describe('HardStopModal: Keep playing free', () => {
  it('F.1: a free plan at the credit wall gets both options under Top up / Upgrade', () => {
    const html = render();
    expect(html).toContain('Keep playing free');
    expect(html).toContain('Use your ChatGPT plan');
    expect(html).toContain('Use your own API key or a local model');
    // Under the plan pair, and the pair is still there.
    expect(html.indexOf('Upgrade')).toBeLessThan(html.indexOf('Keep playing free'));
    expect(html).toContain('Top up');
  });

  it('F.1: no free options for a rate limit or a subscriber at the wall', () => {
    expect(render({ reason: 'rate_limited' })).not.toContain('Keep playing free');
    expect(render({ plan: 'quest' })).not.toContain('Keep playing free');
    expect(render({ plan: 'party' })).not.toContain('Keep playing free');
  });

  it('F.2: the ChatGPT option is hidden when the plan is already in use', () => {
    const html = render({ llmProvider: 'chatgpt' });
    expect(html).not.toContain('Use your ChatGPT plan');
    expect(html).toContain('Use your own API key or a local model');
  });

  it('F.2: wallFreeOptions: free credit wall only, ChatGPT left out only when already in use', () => {
    const base = { reason: 'depleted', plan: 'free' as const, llmProvider: null };
    expect(wallFreeOptions(base)).toEqual({ chatgpt: true, ownKey: true });
    expect(wallFreeOptions({ ...base, llmProvider: 'chatgpt' })).toEqual({ chatgpt: false, ownKey: true });
    expect(wallFreeOptions({ ...base, reason: 'rate_limited' })).toEqual({ chatgpt: false, ownKey: false });
    expect(wallFreeOptions({ ...base, plan: 'quest' })).toEqual({ chatgpt: false, ownKey: false });
    // Another local provider (anthropic, ollama) is not the plan: offer it.
    expect(wallFreeOptions({ ...base, llmProvider: 'ollama' }).chatgpt).toBe(true);
  });

  it('F.3: "Use your ChatGPT plan" tracks, dismisses first, then runs the shared flow', async () => {
    render();
    button('Use your ChatGPT plan').onClick?.();
    await Promise.resolve();
    expect(h.order.slice(0, 3)).toEqual(['track:chatgpt', 'acknowledge', 'startChatgptPlan']);
    expect(h.track).toHaveLength(1);
    expect(h.track[0].event).toBe('credit_wall_action');
    expect(h.track[0].props).toMatchObject({ action: 'chatgpt', reason: 'depleted' });
    expect(Object.keys(h.track[0].props).sort()).toEqual(['action', 'ms_open', 'reason']);
    // The flow navigates itself; nothing else does when it ran.
    expect(navigations).toEqual([]);
  });

  it('F.3: a ChatGPT flow already in flight still lands on the ChatGPT plan row', async () => {
    h.startRan = false;
    render();
    button('Use your ChatGPT plan').onClick?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(navigations).toEqual([{ kind: 'settings', focus: 'chatgpt-plan' }]);
  });

  it('F.3: "Use your own API key or a local model" tracks, dismisses first, then opens Settings at the backend row', () => {
    render();
    button('Use your own API key or a local model').onClick?.();
    expect(h.order).toEqual(['track:own_key', 'acknowledge', 'navigate']);
    expect(h.track[0].props).toMatchObject({ action: 'own_key', reason: 'depleted' });
    expect(navigations).toEqual([{ kind: 'settings', focus: 'ai-backend' }]);
  });

  it('F.4: the ChatGPT option is never hidden by region (the provider decides, like Settings)', () => {
    expect(SRC).not.toContain('regionStatus');
    expect(SRC).toContain('wallFreeOptions({ reason: hardStopReason, plan, llmProvider })');
    expect(SRC).toContain("export type WallAction = 'close' | 'topup' | 'upgrade' | 'chatgpt' | 'own_key';");
  });

  it('F.4: the new copy is plain and has a zh translation', () => {
    for (const s of ['Keep playing free', 'Use your own API key or a local model']) {
      expect(ZH).toContain(`'${s}':`);
      expect(s).not.toContain('—');
      expect(s.toLowerCase()).not.toContain('friend');
    }
    const section = SRC.slice(SRC.indexOf('data-testid="wall-free-options"'), SRC.indexOf('<ModalFooter>', SRC.indexOf('data-testid="wall-free-options"')));
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toContain('—');
  });
});
