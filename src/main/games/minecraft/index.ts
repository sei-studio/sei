/**
 * Minecraft game module (M0, 260908): a thin wrapper over what main already
 * had â€” lanWatcher (world detection), effectiveMcUsername (naming) and the
 * cached LAN port + MOTD (join target). No behavior change; this is the
 * registry shape the supervisor and the world:* channels dispatch on.
 */
import { effectiveMcUsername, type Character } from '../../../shared/characterSchema';
import type { LanState } from '../../../shared/ipc';
import type { WorldState, MinecraftJoinTarget } from '../../../shared/gameIpc';
import { watchLan } from '../../lanWatcher';
import type { GameModule, GameJoinContext } from '../index';

/**
 * 261027 lazy skins: the longest a launch waits for the character's first
 * Gemini skin (the proxy's 60 s image timeout plus the local mapping). The
 * generation keeps running past it and applies for the next join.
 */
export const SKIN_PREPARE_WAIT_MS = 75_000;

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
        // mc_username is no longer collected in the GUI (260605) â€” it stays in
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
    // 261027 lazy skins: a character still on its creation placeholder gets
    // its Gemini skin before it joins, so CustomSkinLoader fetches the real
    // one. Every launch path (panel, chat/voice launch() tool) reaches the
    // supervisor, which awaits this before the summon deadline starts.
    // Bounded, never throws, adds nothing to the join target; any failure
    // just means the painted skin.
    async prepareJoin({ characterId }) {
      try {
        const { ensureMinecraftSkin } = await import('../../skinGeneration');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SKIN_PREPARE_WAIT_MS);
        });
        await Promise.race([ensureMinecraftSkin(characterId).then(() => undefined), timeout]);
        clearTimeout(timer);
      } catch (err) {
        console.warn(`[sei] minecraft prepareJoin skin step failed: ${(err as Error).message}`);
      }
      return null;
    },
    // install: undefined in M0 â€” the skin-setup wizard stays where it is.
  };
}




