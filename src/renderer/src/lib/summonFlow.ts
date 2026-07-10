/**
 * Shared summon-attempt flow.
 *
 * Both CharacterPage (deploy bar) and CharactersScreen (grid card) trigger a
 * summon, and both must run the same two gates in the same order:
 *
 *   1. First-summon skin-setup nudge — the FIRST time a user who has never
 *      completed skin setup tries to summon any character, show a one-time
 *      "run skin setup" prompt. This fires BEFORE the LAN "not connected"
 *      instruction (a user with no open world should be told about skins
 *      first). Gated by WizardState.hasRunOnce (have they ever set up) AND a
 *      profile-scoped wizard:prompt-shown flag (have we already nudged them),
 *      so it appears at most once per account. Skin setup is needed in BOTH
 *      cloud and local mode, so this is not gated on ai_backend_kind.
 *
 *   2. LAN gate — if connected, summon immediately; otherwise stash the
 *      pending id and open the LAN "open your world" modal, which auto-resumes
 *      the summon when LAN flips to connected (LanModal, D-56).
 *
 * Centralised here (rather than duplicated per screen) so the gate order and
 * the show-once bookkeeping live in one place. `proceedSummon` is exported so
 * the skin-setup prompt's "skip for now" button can resume the normal flow.
 */

import { sei } from './ipcClient';
import { effectiveMcUsername } from '@shared/characterSchema';
import { lanHostWarning, type LanHost, type LanHostWarning } from '@shared/ipc';
import { useUiStore } from './stores/useUiStore';
import { useDataStore } from './stores/useDataStore';

/**
 * 260709 — pre-summon host-compatibility disclaimer bookkeeping. Session-scoped
 * on purpose: the disclaimer is a heads-up, not a gate, so once the user has
 * seen (and summoned past) it for a given warning kind we stay quiet until the
 * next app launch. Not persisted — a modded world is worth one reminder per
 * session, zero per click.
 */
const acknowledgedHostWarnings = new Set<LanHostWarning>();

/** Called by the disclaimer's "Summon anyway" so this session stops asking. */
export function acknowledgeHostWarning(kind: LanHostWarning): void {
  acknowledgedHostWarnings.add(kind);
}

/**
 * The summon itself + post-summon navigation. Shared by the direct path and
 * the disclaimer modal's "Summon anyway" resume.
 */
export function launchSummon(id: string, fromChat: boolean): void {
  void sei.summon(id).catch(() => {
    // Errors surface via onStatus → BotStatus.error; the model row owns display.
  });
  useUiStore.getState().navigate(fromChat ? { kind: 'chat', characterId: id } : { kind: 'character', id });
}

/**
 * Summon behind the host-compatibility disclaimer. If the detected host
 * warrants a warning the user has not yet acknowledged this session, open the
 * disclaimer modal (which resumes via launchSummon on "Summon anyway");
 * otherwise summon straight away. Used by both the direct summon path
 * (proceedSummon) and the LanModal auto-resume, so neither can skip the gate.
 */
export function summonWithHostGate(id: string, fromChat: boolean, host: LanHost | undefined): void {
  const warning = lanHostWarning(host);
  if (warning && host && !acknowledgedHostWarnings.has(warning)) {
    useUiStore.getState().openModal({ kind: 'lan-host-warning', characterId: id, warning, host, fromChat });
    return;
  }
  launchSummon(id, fromChat);
}

/**
 * Multi-summon guard. Two bots cannot share an in-game username — the world
 * kicks the second with `multiplayer.disconnect.name_taken`. If a
 * currently-summoned (online or connecting) character already uses the target's
 * effective MC username, open the conflict popup and return true (refuse). The
 * supervisor has an authoritative backstop for the click-twice race; this is
 * the user-facing surface on the common path. Case-insensitive to match MC.
 */
function blockedByUsernameConflict(id: string): boolean {
  const { characters, summons } = useDataStore.getState();
  const target = characters.find((c) => c.id === id);
  if (!target) return false;
  const targetName = effectiveMcUsername(target).toLowerCase();
  const conflict = characters.find((c) => {
    if (c.id === id) return false;
    const st = summons[c.id]?.kind;
    if (st !== 'online' && st !== 'connecting') return false;
    return effectiveMcUsername(c).toLowerCase() === targetName;
  });
  if (!conflict) return false;
  useUiStore.getState().openModal({
    kind: 'summon-conflict',
    attemptedName: target.name,
    conflictName: conflict.name,
    username: effectiveMcUsername(target),
  });
  return true;
}

/**
 * Run the LAN gate and summon. Always navigates to the character page on the
 * connected path — harmless when the caller is already on that page
 * (CharacterPage) and matches the CharactersScreen card behavior.
 */
export async function proceedSummon(id: string): Promise<void> {
  const ui = useUiStore.getState();
  // 260703: gate on a FRESH LAN read, not the store snapshot. The background
  // poll damps open→closed transitions (OPEN_MISS_TOLERANCE), so a world that
  // actually closed can keep reporting 'open' in the store for up to ~4s — long
  // enough that a summon click would fire sei.summon(id) into a dead port and
  // surface a connection error instead of the "open your world" LAN modal. The
  // fresh check reads live ground truth; fall back to the store snapshot if the
  // IPC fails. (A false 'closed' here self-heals: the LanModal auto-resumes the
  // pending summon when the next poll flips back to open.) checkNow also
  // refreshes main's cached LAN state, so the port the actual summon reads is
  // fresh too.
  const lan = await sei.lanCheckNow().catch(() => useDataStore.getState().lan);
  // Task 6 — if this summon was launched from THIS character's chat (the games
  // popup opens over the chat view), keep the user in that chat once the bot
  // joins rather than yanking them to the profile page. The floating widget +
  // summon toast still surface the live session from anywhere.
  const view = ui.view;
  const fromChat = view.kind === 'chat' && view.characterId === id;
  if (lan.kind === 'open') {
    // 260709 — compatibility disclaimer: a modded (Forge/NeoForge/Fabric) or
    // Lunar host gets a one-time heads-up before the first summon of the
    // session. The modal's "Summon anyway" acknowledges and resumes via
    // launchSummon; Cancel simply drops the attempt.
    summonWithHostGate(id, fromChat, lan.host);
    return;
  }
  ui.setPendingSummon(id);
  // Remember the origin so the LanModal auto-resume lands back in chat too.
  ui.setPendingSummonReturnToChat(fromChat);
  ui.openModal({ kind: 'lan', mode: 'searching' });
}

/**
 * Entry point for a summon attempt. Shows the one-time skin-setup nudge if
 * warranted; otherwise falls straight through to {@link proceedSummon}. Never
 * blocks the summon on the nudge — any IPC failure degrades to the normal flow.
 */
export async function attemptSummon(id: string): Promise<void> {
  // Refuse + popup if this character's in-game name collides with a live one.
  if (blockedByUsernameConflict(id)) return;
  try {
    const { shown } = await sei.wizardPromptShown('get');
    if (!shown) {
      const wiz = await sei.getWizardState();
      if (!wiz.hasRunOnce) {
        // First summon for a user who has never set up skins — nudge once,
        // then never auto-show again (they can re-run setup from Settings).
        await sei.wizardPromptShown('set');
        useUiStore.getState().openModal({ kind: 'skin-setup-prompt', characterId: id });
        return;
      }
    }
  } catch {
    // Best-effort — never let the nudge bookkeeping block a summon.
  }
  await proceedSummon(id);
}
