/**
 * Playtime > ChatGPT (261110, product call 261110; mocks 02 and 03).
 *
 * Not in use: one line and the official Continue with ChatGPT button
 * (ChatgptPlanSettings compact: the sign-in also links the ChatGPT identity
 * to a signed-in Sei account, main's connectPlan), or "Use ChatGPT plan"
 * once an account is connected. Either way the switch goes through the
 * page's confirm.
 *
 * In use: Brain (Using ChatGPT plan, the model, Disconnect, OUR count of
 * plan replies this week with 7-day bars, and Manage usage on chatgpt.com:
 * OpenAI does not tell us the plan's remaining usage, so there is no meter
 * and never a reset time) and Voice. A plan that cannot run right now
 * (signed out, plan use off, paused, blocked) shows ChatgptPlanSettings'
 * recovery rows instead of the Brain panel.
 */
import React from 'react';
import type { UserConfig } from '@shared/characterSchema';
import { CHATGPT_USAGE_URL, pickDefaultChatgptModel } from '@shared/chatgptPlan';
import { DEFAULT_MODELS } from '@shared/llmCatalog';
import { EMPTY_LEDGER, summarizeUsage } from '@shared/llmUsage';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { chatgptReady, useChatgptStore } from '../../lib/stores/useChatgptStore';
import { useUsageStore } from '../../lib/stores/useUsageStore';
import { Button } from '../Button';
import { ChatgptLogo } from '../ChatgptLogo';
import { ChatgptPlanSettings, chatgptPlanDisclosure } from '../ChatgptPlanSettings';
import { InfoTip } from '../InfoTip';
import { MiniBars, ModelSelect, Row } from './PlaytimeParts';
import { VoicePanel } from './VoicePanel';
import styles from '../../screens/PlaytimeScreen.module.css';

export interface ChatgptTabProps {
  active: boolean;
  cfg: UserConfig | null;
  persist: (fn: (c: UserConfig) => UserConfig) => Promise<boolean>;
  signedIn: boolean;
  /** Open the switch confirm (the plan is connected and ready). */
  onUsePlan: () => void;
}

export function ChatgptTab({ active, cfg, persist, signedIn, onUsePlan }: ChatgptTabProps): React.ReactElement {
  const t = useT();
  const status = useChatgptStore((s) => s.status);
  const signOut = useChatgptStore((s) => s.signOut);
  const summary = useUsageStore((s) => s.summary);

  if (!active) {
    return (
      <div className={styles.invite} data-testid="chatgpt-invite">
        <p className={styles.inviteLine}>
          {t('Use your ChatGPT Plus or Pro plan in Sei.')}{' '}
          <InfoTip label={t('About the ChatGPT plan')} text={chatgptPlanDisclosure(t)} />
        </p>
        <ChatgptPlanSettings active={false} compact onUsePlan={onUsePlan} />
      </div>
    );
  }

  const activeAcc = status?.accounts.find((a) => a.id === status.activeId) ?? null;
  const healthy = chatgptReady(status) && !status?.usageLimited && !status?.blockedCode;

  const stored = (() => {
    const entry = (cfg?.provider_config as Record<string, unknown> | undefined)?.chatgpt;
    const m = entry && typeof entry === 'object' ? (entry as { model?: unknown }).model : undefined;
    return typeof m === 'string' && m.trim() ? m.trim() : undefined;
  })();
  const model = stored ?? (status?.models.length ? pickDefaultChatgptModel(status.models) : DEFAULT_MODELS.chatgpt);
  const onPickModel = (id: string): void => {
    void persist((c) => {
      const pc = { ...((c.provider_config as Record<string, unknown> | undefined) ?? {}) };
      const prev = pc.chatgpt;
      pc.chatgpt = { ...(prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {}), model: id };
      return { ...c, provider_config: pc };
    });
  };

  const usage = summary ?? summarizeUsage(EMPTY_LEDGER, new Date());
  const replies = usage.chatgptRepliesWeek;
  const perDay = usage.days.map((d) => d.chatgptReplies);

  return (
    <>
      <section className={styles.section} aria-label={t('Brain')}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>{t('Brain')}</h3>
          {activeAcc?.signedIn ? (
            <span className={styles.aside} title={activeAcc.label}>
              {activeAcc.label}
            </span>
          ) : null}
        </div>
        {healthy && activeAcc ? (
          <div className={styles.panel}>
            <Row
              testId="chatgpt-in-use"
              label={
                <>
                  <ChatgptLogo size={18} />
                  {t('Using ChatGPT plan')}
                </>
              }
            >
              <ModelSelect provider="chatgpt" value={model} enabled onPick={onPickModel} />
              <Button kind="quiet" size="sm" disabled={status?.signingIn === true} onClick={() => void signOut(activeAcc.id)}>
                {t('Disconnect')}
              </Button>
            </Row>
            <Row
              testId="chatgpt-replies"
              label={
                <span>
                  {t('{n, plural, one {# reply} other {# replies}}', { n: replies })}{' '}
                  <span className={styles.muted}>{t('this week')}</span>
                </span>
              }
            >
              <MiniBars values={perDay} label={t('Replies per day')} />
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  sei.track('chatgpt_usage_link_clicked');
                  void sei.openExternal(CHATGPT_USAGE_URL);
                }}
              >
                {t('Manage usage')}
              </button>
            </Row>
          </div>
        ) : (
          <div className={styles.panel} data-testid="chatgpt-recover">
            <ChatgptPlanSettings active onUsePlan={() => undefined} />
          </div>
        )}
      </section>
      {cfg ? <VoicePanel mode="chatgpt" cfg={cfg} persist={persist} signedIn={signedIn} /> : null}
    </>
  );
}
