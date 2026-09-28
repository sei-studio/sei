/**
 * Why a live game session ended (260929), as analytics props.
 *
 * `bot_session_ended` used to carry no reason at all, so a player pressing
 * Stop looked exactly like the bot being kicked, and 10 of 36 Minecraft users
 * in a month had sub-minute sessions nobody could explain. The supervisor now
 * stamps `endReason` (and, for a kick, a short `kickCode`) on the terminal
 * status; this module turns that status into event props. Pure, so the
 * mapping is pinned in sessionEnd.test.ts.
 *
 * Only shape, never content: the error CLASS (an enum), never its message,
 * and the kick CODE (see kickReasonCode in src/bot/adapter/minecraft/connect.js),
 * never the server's kick text.
 */
import type { BotStatus, SessionEndReason } from '../shared/ipc';

const REASONS: ReadonlySet<SessionEndReason> = new Set<SessionEndReason>([
  'user_stop',
  'companion_quit',
  'app_quit',
  'account_switch',
  'kicked',
  'world_closed',
  'disconnected',
  'credits_depleted',
  'rate_limited',
  'crash',
  'error',
  'bot_exit',
  'unknown',
]);

/** A kick code is a short lowercase token; anything else is dropped. */
const KICK_CODE_RE = /^[a-z0-9_.]{1,40}$/;

export interface SessionEndProps {
  reason: SessionEndReason;
  /** ErrorClass of a session that ended on an error. */
  error_class?: string;
  /** Short kick code ('kicked', 'name_taken', 'modded', 'other', ...). */
  kick_code?: string;
}

function isReason(r: unknown): r is SessionEndReason {
  return typeof r === 'string' && REASONS.has(r as SessionEndReason);
}

function errorEndReason(status: Extract<BotStatus, { kind: 'error' }>): SessionEndReason {
  if (isReason(status.endReason)) return status.endReason;
  // No explicit reason from the bot: fall back on the error class.
  switch (status.error) {
    case 'CLOUD_CREDITS_DEPLETED':
      return 'credits_depleted';
    case 'DAILY_LIMIT_REACHED':
      return 'rate_limited';
    case 'MODDED_HOST_REJECTED':
      return 'kicked';
    case 'LAN_NOT_OPEN':
      return 'disconnected';
    case 'BOT_CRASH':
      return 'crash';
    default:
      return status.midSession === true ? 'crash' : 'error';
  }
}

/**
 * Props for the terminal status that closed a live session. An account
 * teardown overrides a plain stop (the switch drives `supervisor.stop()`), but
 * never an error, which says more.
 */
export function sessionEndProps(
  status: BotStatus,
  ctx: { accountTeardown?: boolean } = {},
): SessionEndProps {
  if (status.kind === 'error') {
    const props: SessionEndProps = { reason: errorEndReason(status), error_class: status.error };
    const kick =
      typeof status.kickCode === 'string' && KICK_CODE_RE.test(status.kickCode)
        ? status.kickCode
        : status.error === 'MODDED_HOST_REJECTED'
          ? 'modded'
          : undefined;
    if (kick) props.kick_code = kick;
    return props;
  }
  if (ctx.accountTeardown) return { reason: 'account_switch' };
  const r = status.kind === 'idle' ? status.endReason : undefined;
  return { reason: isReason(r) ? r : 'unknown' };
}

/**
 * Did the session end in a FAILURE after the bot had joined? Any terminal
 * error does (kick loop, lost world, crash, cloud stop); a stop, a quit or a
 * clean exit does not. These also fire `bot_session_failed`.
 */
export function isSessionFailure(status: BotStatus): boolean {
  return status.kind === 'error' && status.transient !== true;
}
