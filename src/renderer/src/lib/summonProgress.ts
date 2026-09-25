import type { BotStatus } from '@shared/ipc';
import { t as defaultT } from './i18n';

/**
 * 260926: the launch button's in-flight label. A summon is 'connecting' from
 * the click until summon-ready, and on Windows the bot's cold boot alone
 * measured 20s+, so one flat "Connecting..." read as a hang. The supervisor
 * tags the status with a stage: 'starting' while the bot process boots,
 * 'joining' once it has booted and is joining the world. A status without a
 * stage (older main, other games) reads as 'starting'.
 */
export function connectingLabel(
  summon: BotStatus | undefined | null,
  tr: (key: string, params?: Record<string, string | number>) => string = defaultT,
): string {
  if (summon?.kind === 'connecting' && summon.stage === 'joining') return tr('Joining your world...');
  return tr('Starting companion...');
}
