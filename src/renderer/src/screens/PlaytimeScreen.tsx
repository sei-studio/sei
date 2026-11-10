/**
 * PlaytimeScreen: the Playtime page (261110, product call 261110): one page
 * for what runs the companions and what it costs, in three tabs.
 *
 * - Sei: the Sei plan on the cloud (SeiPlanTab, CreditsScreen.tsx).
 * - ChatGPT: the user's ChatGPT plan as the brain (components/playtime/ChatgptTab).
 * - My keys: own API keys or a local model (components/playtime/MyKeysTab).
 *
 * The page opens on the tab matching the current setup (lib/playtimeTabs.ts)
 * unless a deep link names one (view.tab). The tab in use shows its
 * dashboard; the other two show one line and the switch. Every switch goes
 * through SwitchBackendConfirmModal (a one-line heads-up), then the same
 * calls Settings used: provider first, then proxyConfigure, then a credits
 * refresh so the rail and the hard-stop surfaces follow.
 *
 * All AI and model config moved here from Settings (mock 06): the backend
 * switch, the ChatGPT plan rows, the BYOK provider / key / model rows and
 * Voice. Settings keeps one "Brain, voice and plan" row that opens this page.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { UserConfig } from '@shared/characterSchema';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import { useUiStore } from '../lib/stores/useUiStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useChatgptStore } from '../lib/stores/useChatgptStore';
import { useUsageStore } from '../lib/stores/useUsageStore';
import { chatgptPlanIntentStep } from '../lib/chatgptPlanIntent';
import { PLAYTIME_TABS, isActiveSetupTab, playtimeTabForSetup, type PlaytimeTab } from '../lib/playtimeTabs';
import { Button } from '../components/Button';
import { SignInModal } from '../components/SignInModal';
import { SwitchBackendConfirmModal } from '../components/SwitchBackendConfirmModal';
import { ChatgptTab } from '../components/playtime/ChatgptTab';
import { MyKeysTab } from '../components/playtime/MyKeysTab';
import { ElevenKeyRow } from '../components/playtime/ElevenKeyRow';
import { SeiPlanTab } from './CreditsScreen';
import styles from './PlaytimeScreen.module.css';

const TAB_LABELS: Record<PlaytimeTab, string> = { sei: 'Sei', chatgpt: 'ChatGPT', mykeys: 'My keys' };

export function PlaytimeScreen(): React.ReactElement {
  const t = useT();
  const viewTab = useUiStore((s) => (s.view.kind === 'credits' ? s.view.tab ?? null : null));
  const chatgptPlanIntent = useUiStore((s) => s.view.kind === 'credits' && s.view.useChatgptPlan === true);
  const backend = useCreditsStore((s) => s.ai_backend_kind);
  const plan = useCreditsStore((s) => s.plan);
  const authState = useAuthStore((s) => s.state);
  const signedIn = authState.kind === 'signed_in';
  const chatgptStatus = useChatgptStore((s) => s.status);
  const loadUsage = useUsageStore((s) => s.load);

  // The page's copy of the profile config (provider, models, voice choices).
  const [cfg, setCfg] = useState<UserConfig | null>(null);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const [error, setError] = useState<string | null>(null);
  const reloadCfg = useCallback(async (): Promise<UserConfig | null> => {
    try {
      const c = await sei.getConfig();
      setCfg(c);
      return c;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    void reloadCfg();
  }, [reloadCfg, backend]);

  /** Read-modify-write of the whole config from the latest copy; false on failure. */
  const persist = useCallback(
    async (fn: (c: UserConfig) => UserConfig): Promise<boolean> => {
      const base = cfgRef.current ?? (await reloadCfg());
      if (!base) return false;
      const next = fn(base);
      cfgRef.current = next;
      setCfg(next);
      try {
        await sei.saveConfig(next);
        setError(null);
        return true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[Playtime] saveConfig failed', err);
        cfgRef.current = base;
        setCfg(base);
        setError(t('Failed to save. Try again.'));
        return false;
      }
    },
    [reloadCfg, t],
  );

  // Usage numbers (ChatGPT replies, own-key spend): on open, then each minute.
  useEffect(() => {
    void loadUsage();
    const id = window.setInterval(() => void loadUsage(), 60_000);
    return () => window.clearInterval(id);
  }, [loadUsage]);

  const backendKnown = backend === 'cloud-proxy' || backend === 'local';
  const provider = cfg?.provider ?? null;
  const setupTab = backendKnown && cfg ? playtimeTabForSetup(backend, provider) : null;

  // The open tab: a deep link's, else the setup's once it is known.
  const [tab, setTab] = useState<PlaytimeTab | null>(viewTab);
  useEffect(() => {
    if (viewTab) setTab(viewTab);
  }, [viewTab]);
  useEffect(() => {
    if (tab === null && setupTab) setTab(setupTab);
  }, [tab, setupTab]);
  const pickTab = (next: PlaytimeTab): void => {
    setTab(next);
    const v = useUiStore.getState().view;
    if (v.kind === 'credits' && v.tab && v.tab !== next) useUiStore.setState({ view: { ...v, tab: next } });
  };

  const activeHere = tab !== null && !!cfg && isActiveSetupTab(tab, backend, provider);
  const tracked = useRef<string | null>(null);
  useEffect(() => {
    if (!tab || !setupTab) return;
    const key = `${tab}|${setupTab}`;
    if (tracked.current === key) return;
    tracked.current = key;
    sei.track('playtime_tab_viewed', { tab, is_active_setup: tab === setupTab });
  }, [tab, setupTab]);

  // ── Switching ──
  const [pendingSwitch, setPendingSwitch] = useState<PlaytimeTab | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [seiAfterSignIn, setSeiAfterSignIn] = useState(false);

  const applySwitch = useCallback(
    async (target: PlaytimeTab): Promise<void> => {
      const from = setupTab ?? 'unknown';
      try {
        const base = cfgRef.current ?? (await reloadCfg());
        if (!base) throw new Error('config unavailable');
        if (target === 'chatgpt') {
          // Provider first, so the running bot's live switch (and the next
          // summon) resolve the ChatGPT plan, never the old provider.
          if (base.provider !== 'chatgpt') {
            const ok = await persist((c) => ({ ...c, provider: 'chatgpt', provider_config: c.provider_config ?? {} }));
            if (!ok) throw new Error('save failed');
          }
          if (backend !== 'local') await sei.proxyConfigure('local');
        } else if (target === 'mykeys') {
          if (base.provider === 'chatgpt') {
            // Off the ChatGPT plan: the key slot may hold another vendor's
            // key, so it is cleared with the provider change (Settings rule).
            const ok = await persist((c) => ({ ...c, provider: 'anthropic', provider_config: c.provider_config ?? {} }));
            if (!ok) throw new Error('save failed');
            await sei.saveApiKey('').catch(() => undefined);
          }
          if (backend !== 'local') await sei.proxyConfigure('local');
        } else {
          const r = await sei.proxyConfigure('cloud-proxy');
          if (!r.ok) throw new Error(r.code);
        }
        await reloadCfg();
        await useCreditsStore.getState().refresh();
        sei.track('playtime_backend_switch', { from, to: target, result: 'ok' });
        setError(null);
        setTab(target);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[Playtime] switch failed', err);
        sei.track('playtime_backend_switch', { from, to: target, result: 'failed' });
        setError(t("Couldn't switch. Try again."));
      }
    },
    [backend, persist, reloadCfg, setupTab, t],
  );

  const askSwitch = (target: PlaytimeTab): void => {
    if (target === 'sei' && !signedIn) {
      // Sei needs an account: signing in is the confirmation.
      setSeiAfterSignIn(true);
      setSignInOpen(true);
      return;
    }
    setPendingSwitch(target);
  };

  // A sign-in started by "Switch to Sei" completes the switch.
  useEffect(() => {
    if (!seiAfterSignIn || !signedIn) return;
    setSeiAfterSignIn(false);
    setSignInOpen(false);
    void applySwitch('sei');
  }, [seiAfterSignIn, signedIn, applySwitch]);

  // view.useChatgptPlan (the plan offer, the startup popup, a wall action):
  // signed in already, now switch through the same path as the tab's button.
  // One-shot: cleared as soon as the answer is known (chatgptPlanIntent.ts).
  useEffect(() => {
    if (!chatgptPlanIntent) return;
    const step = chatgptPlanIntentStep(!!cfg, chatgptStatus, backend);
    if (step === 'wait') return;
    useUiStore.setState({ view: { kind: 'credits', tab: 'chatgpt' } });
    setTab('chatgpt');
    if (step === 'drop') return;
    if (step === 'confirm-cloud') setPendingSwitch('chatgpt');
    else if (cfg?.provider !== 'chatgpt') setPendingSwitch('chatgpt');
  }, [chatgptPlanIntent, cfg, chatgptStatus, backend]);

  const handleManage = async (): Promise<void> => {
    const res = await useCreditsStore.getState().cancelSubscription();
    if (!res.ok) setError(t("Couldn't open billing. Try again in a moment."));
  };

  return (
    <div className={styles.root}>
      <div className={styles.col}>
        <header className={styles.header}>
          <h1 className={styles.title}>{t('Playtime')}</h1>
          <div className={styles.tabs} role="tablist" aria-label={t('Playtime')}>
            {PLAYTIME_TABS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                data-testid={`playtime-tab-${id}`}
                className={tab === id ? `${styles.tab} ${styles.tabOn}` : styles.tab}
                onClick={() => pickTab(id)}
              >
                {id === 'mykeys' ? t(TAB_LABELS[id]) : TAB_LABELS[id]}
              </button>
            ))}
          </div>
        </header>

        {error ? (
          <p className={`${styles.note} ${styles.noteError}`} role="alert">
            {error}
          </p>
        ) : null}

        {tab === 'sei' && cfg && backendKnown ? (
          activeHere ? (
            <>
              <SeiPlanTab />
              <section className={styles.section} aria-label={t('Voice')}>
                <h3 className={styles.sectionTitle}>{t('Voice')}</h3>
                <div className={styles.panel}>
                  <ElevenKeyRow mode="cloud-optional" />
                </div>
              </section>
            </>
          ) : (
            <div className={styles.invite} data-testid="sei-invite">
              <p className={styles.inviteLine}>{t('Sei runs the brain and the voices. No keys needed.')}</p>
              <Button kind="primary" size="md" onClick={() => askSwitch('sei')}>
                {t('Switch to Sei')}
              </Button>
              {signedIn && plan !== 'free' ? (
                <Button kind="quiet" size="sm" onClick={() => void handleManage()}>
                  {t('Manage billing')}
                </Button>
              ) : null}
            </div>
          )
        ) : null}

        {tab === 'chatgpt' && cfg && backendKnown ? (
          <ChatgptTab
            active={activeHere}
            cfg={cfg}
            persist={persist}
            signedIn={signedIn}
            onUsePlan={() => askSwitch('chatgpt')}
          />
        ) : null}

        {tab === 'mykeys' && cfg && backendKnown ? (
          <MyKeysTab
            active={activeHere}
            cfg={cfg}
            persist={persist}
            signedIn={signedIn}
            onSwitch={() => askSwitch('mykeys')}
          />
        ) : null}
      </div>

      {pendingSwitch ? (
        <SwitchBackendConfirmModal
          direction={pendingSwitch === 'sei' ? 'cloud-proxy' : 'local'}
          via={pendingSwitch === 'chatgpt' ? 'chatgpt' : undefined}
          onCancel={() => {
            sei.track('playtime_backend_switch', { from: setupTab ?? 'unknown', to: pendingSwitch, result: 'cancelled' });
            setPendingSwitch(null);
          }}
          onConfirm={async () => {
            await applySwitch(pendingSwitch);
            setPendingSwitch(null);
          }}
        />
      ) : null}

      {signInOpen ? (
        <SignInModal
          framingLabel={null}
          // Also called on a successful sign-in, before the auth push may
          // land, so the pending switch stays armed (it dies with the page).
          onClose={() => setSignInOpen(false)}
        />
      ) : null}
    </div>
  );
}
