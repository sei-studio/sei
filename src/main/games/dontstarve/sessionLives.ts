/**
 * 261104: DST deaths and respawns for `bot_session_ended`. The bot posts
 * `{type:'dst-lives', respawns, deaths, lastDeathCause}` after every death
 * and respawn (src/bot/adapter/dontstarve/runtime.js postLives); main keeps
 * the newest per character and folds it into the end event once. Shape
 * only: the cause is a game id such as `darkness` or `spider`.
 */
import { DstLivesMessageSchema } from '../../../shared/dstIpc';

export interface DstLivesProps {
  respawns: number;
  deaths: number;
  last_death_cause?: string;
}

export interface DstLivesReporter {
  /** A raw port message; invalid ones are ignored. */
  note(characterId: string, raw: unknown): void;
  /** The session's props (zeros when nothing was reported), then forget it. */
  take(characterId: string): DstLivesProps;
}

export function createDstLivesReporter(): DstLivesReporter {
  const lives = new Map<string, DstLivesProps>();
  return {
    note(characterId, raw) {
      const parsed = DstLivesMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      const m = parsed.data;
      lives.set(characterId, {
        respawns: m.respawns,
        deaths: m.deaths,
        ...(m.lastDeathCause ? { last_death_cause: m.lastDeathCause } : {}),
      });
    },
    take(characterId) {
      const v = lives.get(characterId);
      lives.delete(characterId);
      return v ?? { respawns: 0, deaths: 0 };
    },
  };
}
