/**
 * ChatgptPlanBadge â€” "Using ChatGPT plan" + Manage usage, under the chat
 * composer (261017, issue #46). OpenAI's UI guidelines ask for this near the
 * composer or model selector whenever requests run on the user's plan.
 * Renders nothing unless the active local provider is the ChatGPT plan and
 * the active account can use it.
 */
import React from 'react';
import { CHATGPT_USAGE_URL } from '@shared/chatgptPlan';
import { useT } from '../lib/i18n';
import { sei } from '../lib/ipcClient';
import { chatgptReady, useChatgptStore } from '../lib/stores/useChatgptStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { ChatgptLogo } from './ChatgptLogo';
import styles from './ChatgptPlanBadge.module.css';

export function ChatgptPlanBadge(): React.ReactElement | null {
  const t = useT();
  const provider = useUiStore((s) => s.llmProvider);
  const status = useChatgptStore((s) => s.status);
  if (provider !== 'chatgpt' || !chatgptReady(status)) return null;
  return (
    <div className={styles.badge}>
      <ChatgptLogo size={12} />
      <span>{status?.usageLimited ? t('ChatGPT plan usage limit reached') : t('Using ChatGPT plan')}</span>
      <button type="button" className={styles.link} onClick={() => void sei.openExternal(CHATGPT_USAGE_URL)}>
        {t('Manage usage')}
      </button>
    </div>
  );
}




