/**
 * useFirstMomentStore — the guided first moment's state (260926).
 *
 * Lifecycle, one companion, one app session:
 *
 *   arm(id)          App.tsx, when the Sui scene completes for a NEW player
 *                    (see firstMomentCompanion). Starts a Minecraft install
 *                    probe so the plan is ready by the time the chat opens.
 *   greetingOptions  useChatStore.load(), on the empty-transcript open that
 *                    fires the first-meeting greeting. Freezes the plan and
 *                    returns the chatOpened options that steer the greeting.
 *   greetingResult   the greeting landed (ready: the card may show) or it
 *                    did not (failed: the chat stays the normal chat, no
 *                    card, no error). Failures are silent to the player.
 *   markShown        the card actually rendered (fires first_moment_shown).
 *   act(action)      a button, "Not now", or the player typing instead
 *                    ('typed', from useChatStore.send) retires the card
 *                    (fires first_moment_action).
 *
 * Deliberately NOT persisted: it is a one-shot nudge for the first session,
 * and a quit before it shows simply means no card. The tutorial is the only
 * other thing that runs at this moment, and TutorialOverlay hands off to
 * enterFirstMoment() when it ends, so the tour lands in the companion's chat
 * rather than on Home.
 *
 * Analytics are shape only: which game led, whether Minecraft was offered,
 * which button, and timings. No chat text.
 */
import { create } from 'zustand';
import type { ChatOpenedOptions } from '@shared/ipc';
import { DEFAULT_CHARACTER_UUIDS } from '@shared/defaultCharacters';
import { sei } from '../ipcClient';
import { planFirstMoment, type FirstMomentAction, type FirstMomentPlan } from '../firstMoment';
import { useDataStore } from './useDataStore';
import { useUiStore } from './useUiStore';

export type FirstMomentStatus = 'armed' | 'greeting' | 'ready' | 'done' | 'failed';

/** How long the greeting waits on the Minecraft install probe before it
 *  plans without it (the probe then just counts as "not installed"). */
export const MC_PROBE_WAIT_MS = 1500;
/** How long planning waits on main's LAN state before using the cached copy. */
const LAN_READ_WAIT_MS = 500;

interface FirstMomentState {
  characterId: string | null;
  status: FirstMomentStatus | null;
  plan: FirstMomentPlan | null;
  /** When the card first rendered (ms epoch); null until then. */
  shownAt: number | null;
  arm: (characterId: string) => void;
  greetingOptions: (characterId: string) => Promise<ChatOpenedOptions | undefined>;
  greetingResult: (characterId: string, ok: boolean, reason?: string) => void;
  markShown: () => void;
  /** 'typed': the player wrote a message instead of clicking. */
  act: (action: FirstMomentAction | 'typed') => void;
  /** Forget everything: account scope changes (App.tsx) and tests. */
  reset: () => void;
}

/** The install probe started at arm(); resolves true when any Minecraft
 *  install was detected. Module-level so the store stays plain data. */
let mcProbe: Promise<boolean> | null = null;

function probeMcInstalled(): Promise<boolean> {
  try {
    return sei
      .detectMcInstalls()
      .then((r) => (r?.installs?.length ?? 0) > 0)
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    void p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(false);
      },
    );
  });
}

/** Whether a LAN world is open, asked of main (the state its greeting turn
 *  reads) rather than the renderer's pushed copy, which can lag it. Falls back
 *  to the cached copy when the ask fails or is slow. */
async function lanIsOpen(): Promise<boolean> {
  const cached = (): boolean => useDataStore.getState().lan?.kind === 'open';
  try {
    const fresh = await Promise.race([
      sei.getLanState(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LAN_READ_WAIT_MS)),
    ]);
    if (fresh && typeof fresh.kind === 'string') return fresh.kind === 'open';
  } catch {
    /* fall through to the cached copy */
  }
  return cached();
}

function track(event: string, props: Record<string, string | number | boolean | null>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics must never disrupt the flow */
  }
}

export const useFirstMomentStore = create<FirstMomentState>((set, get) => ({
  characterId: null,
  status: null,
  plan: null,
  shownAt: null,

  arm: (characterId) => {
    mcProbe = probeMcInstalled();
    set({ characterId, status: 'armed', plan: null, shownAt: null });
  },

  greetingOptions: async (characterId) => {
    const s = get();
    if (s.characterId !== characterId || s.status !== 'armed') return undefined;
    set({ status: 'greeting' });
    const [mcInstalled, lanOpen] = await Promise.all([
      mcProbe ? withTimeout(mcProbe, MC_PROBE_WAIT_MS) : Promise.resolve(false),
      lanIsOpen(),
    ]);
    const plan = planFirstMoment({ lanOpen, mcInstalled });
    // A reset or re-arm while the probe was pending wins.
    if (get().characterId !== characterId || get().status !== 'greeting') return undefined;
    set({ plan });
    return { firstMoment: { primary: plan.primary } };
  },

  greetingResult: (characterId, ok, reason) => {
    const s = get();
    if (s.characterId !== characterId || (s.status !== 'greeting' && s.status !== 'armed')) return;
    if (ok) {
      set({ status: 'ready' });
      return;
    }
    set({ status: 'failed' });
    track('first_moment_fallback', { reason: reason ?? 'no_greeting' });
  },

  markShown: () => {
    const s = get();
    if (s.status !== 'ready' || s.shownAt != null || !s.plan) return;
    set({ shownAt: Date.now() });
    track('first_moment_shown', {
      primary: s.plan.primary,
      minecraft_offered: s.plan.minecraft,
      companion: s.characterId === DEFAULT_CHARACTER_UUIDS.sui ? 'sui' : 'generated',
    });
  },

  act: (action) => {
    const s = get();
    if (s.status !== 'ready') return;
    set({ status: 'done' });
    track('first_moment_action', {
      action,
      primary: s.plan?.primary ?? null,
      ms_since_shown: s.shownAt != null ? Date.now() - s.shownAt : null,
    });
  },

  reset: () => {
    mcProbe = null;
    set({ characterId: null, status: null, plan: null, shownAt: null });
  },
}));

/**
 * The tour just ended (finished or skipped): take the player to the armed
 * companion's chat instead of leaving them on Home. The greeting fires there
 * if it has not already (the full tour opens the chat at its say-hi step; the
 * reduced tour never does). A failed greeting still lands here, just without
 * the card, which is the normal chat screen. Returns whether it navigated.
 */
export function enterFirstMoment(): boolean {
  const { characterId, status } = useFirstMomentStore.getState();
  if (!characterId || status == null || status === 'done') return false;
  const known = useDataStore.getState().characters.some((c) => c.id === characterId);
  if (!known) {
    // The seeded Sui never arrived (offline first run) or the companion is
    // gone: stay where the tour left the player.
    if (status === 'armed') useFirstMomentStore.getState().greetingResult(characterId, false, 'no_companion');
    return false;
  }
  useUiStore.getState().navigate({ kind: 'chat', characterId });
  return true;
}
