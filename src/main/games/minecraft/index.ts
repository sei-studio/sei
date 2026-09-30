/**
 * Minecraft game module (M0, 260908): a thin wrapper over what main already
 * had — lanWatcher (world detection), effectiveMcUsername (naming) and the
 * cached LAN port + MOTD (join target). No behavior change; this is the
 * registry shape the supervisor and the world:* channels dispatch on.
 */
import { effectiveMcUsername, type Character } from '../../../shared/characterSchema';
import type { LanState } from '../../../shared/ipc';
import type { WorldState, MinecraftJoinTarget } from '../../../shared/gameIpc';
import { watchLan } from '../../lanWatcher';
import type { GameModule, GameJoinContext } from '../index';

const tag = (lan: LanState): WorldState => ({ game: 'minecraft', ...lan });

export function createMinecraftGameModule(): GameModule {
  let latest: LanState = { kind: 'closed' };
  let handle: ReturnType<typeof watchLan> | null = null;
  return {
    id: 'minecraft',
    displayName: 'Minecraft',
    effectiveUsername: (character: Character) => effectiveMcUsername(character),
    // Compared case-insensitively to match MC's username handling: two bots
    // sharing a username get the second kicked with `name_taken`.
    collides: (a, b) => a.toLowerCase() === b.toLowerCase(),
    watcher: {
      start({ onUpdate }) {
        if (handle) return;
        handle = watchLan({
          onUpdate: (state) => {
            latest = state;
            onUpdate(tag(state));
          },
          staleMs: 3000,
        });
      },
      async checkNow() {
        // checkNow's emit path also refreshes `latest` (via onUpdate) when the
        // state changed; return the raw fresh read regardless.
        const fresh = await handle?.checkNow();
        if (fresh) latest = fresh;
        return tag(latest);
      },
      stop() {
        handle?.stop();
        handle = null;
      },
    },
    getWorldState: () => tag(latest),
    getJoinTarget(ctx: GameJoinContext): MinecraftJoinTarget | null {
      if (latest.kind !== 'open') return null;
      return {
        port: latest.port,
        motd: latest.motd ?? null,
        // mc_username is no longer collected in the GUI (260605) — it stays in
        // the DB but may be empty; the bot derives player recognition from
        // preferred_name when it is absent.
        mc_username: (ctx.userConfig.mc_username ?? '').trim(),
        skinServerBaseUrl: ctx.skinServerBaseUrl,
      };
    },
    joinTargetMissingError: {
      error: 'LAN_NOT_OPEN',
      message: 'No LAN world detected. Open one to LAN in Minecraft.',
    },
    // install: undefined in M0 — the skin-setup wizard stays where it is.
  };
}
