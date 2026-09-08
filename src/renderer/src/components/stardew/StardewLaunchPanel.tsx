/**
 * StardewLaunchPanel (game adapters M1, 260908): the Stardew Valley launch
 * surface in the chat game aside, mounted through GAME_SURFACES while the
 * bot is offline. Three states (plan section 4.2), driven by two stores:
 *
 *   Set up      useStardewStore.state.ready is false: the install card
 *               (detected path, "Install SMAPI + Sei's helper"), the running
 *               install's stage + percent, the failure copy, and on Windows
 *               the one-time Steam achievements note with a copy button.
 *   Waiting     ready, but useDataStore.worlds.stardew is not open: "Open
 *               your farm" with a "Launch Stardew Valley (with Sei)" button;
 *               the watcher auto-resumes a pending summon when it opens.
 *   Launch      the farm is open: the farm line, the companion's in-game
 *               name, and the Launch button (shared summon flow).
 *
 * GamePackCard sits above the card: the pack (the built mod) must be on
 * disk before the install can copy it.
 */
import React, { useEffect, useState } from 'react';
import { effectiveStardewName } from '../../lib/stardewName';
import { steamLaunchOption } from '@shared/stardewIpc';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useStardewStore } from '../../lib/stores/useStardewStore';
import { attemptSummon } from '../../lib/summonFlow';
import { requestGameLaunch } from '../../lib/gameLaunch';
import { ERROR_COPY } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { PercentBar } from '../PercentBar';
import { GamePackCard } from '../games/GamePackCard';
import { progressLine, installErrorCopy, achievementsNoteSeen, markAchievementsNoteSeen } from './stardewCopy';
import styles from './StardewLaunchPanel.module.css';

/** Same renderer-relative art the picker tile uses (public/img). */
const ART = './img/game-stardew.jpg';

export interface StardewLaunchPanelProps {
  characterId: string;
}

export function StardewLaunchPanel({ characterId }: StardewLaunchPanelProps): React.ReactElement {
  const t = useT();
  const summon = useDataStore((s) => s.summons[characterId]);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const world = useDataStore((s) => s.worlds.stardew);
  const install = useStardewStore((s) => s.state);
  const progress = useStardewStore((s) => s.progress);
  const installing = useStardewStore((s) => s.installing);
  const installError = useStardewStore((s) => s.installError);
  const launching = useStardewStore((s) => s.launching);
  const lastLaunch = useStardewStore((s) => s.lastLaunch);
  const refresh = useStardewStore((s) => s.refresh);
  const runInstall = useStardewStore((s) => s.install);
  const launchGame = useStardewStore((s) => s.launchGame);
  const init = useStardewStore((s) => s.init);
  const [noteSeen, setNoteSeen] = useState(achievementsNoteSeen);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const off = init();
    void refresh();
    return off;
  }, [init, refresh]);

  const connecting = summon?.kind === 'connecting';
  const summonFail = summon?.kind === 'error' ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH) : null;
  const inGameName = character ? effectiveStardewName(character) : '';
  // worlds.stardew is typed as the cross-game union; narrow to the farm shape.
  const farm = world && world.game === 'stardew' && world.kind === 'open' ? world : null;
  const open = farm !== null;
  const ready = install?.ready === true;

  const summonNow = (): void => {
    requestGameLaunch(characterId, { id: 'stardew', name: 'Stardew Valley' }, () => void attemptSummon(characterId, 'stardew'));
  };

  const copyLaunchOption = async (): Promise<void> => {
    if (!install?.gamePath) return;
    try {
      await navigator.clipboard.writeText(steamLaunchOption(install.gamePath));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable: the text is selectable */
    }
  };

  const dismissNote = (): void => {
    markAchievementsNoteSeen();
    setNoteSeen(true);
  };

  let card: React.ReactNode;
  if (!install) {
    card = (
      <section className={styles.card} aria-live="polite">
        <p className={styles.cardBody}>{t('Checking your Stardew Valley install...')}</p>
      </section>
    );
  } else if (!install.gamePath) {
    card = (
      <section className={styles.card} role="status">
        <h3 className={styles.cardTitle}>{t('Stardew Valley was not found')}</h3>
        <p className={styles.cardBody}>{t('Install Stardew Valley (Steam or GOG) on this computer, then check again. We looked in:')}</p>
        {install.candidates.slice(0, 4).map((p) => (
          <p key={p} className={styles.path}>{p}</p>
        ))}
        <div className={styles.actions}>
          <Button kind="ghost" size="sm" onClick={() => void refresh()}>{t('Check again')}</Button>
        </div>
      </section>
    );
  } else if (!ready) {
    const line = progressLine(progress);
    const err = installErrorCopy(installError);
    card = (
      <section className={styles.card} aria-live="polite" data-state={installing ? 'installing' : 'setup'}>
        <h3 className={styles.cardTitle}>{t('Set up Stardew Valley for Sei')}</h3>
        <p className={styles.cardBody}>
          {install.smapiInstalled
            ? t("SMAPI is installed. Sei's helper mod still needs to be added to your game, a few seconds of setup.")
            : t("This installs SMAPI, the mod loader Stardew Valley uses (about 12 MB, from its official release), and adds Sei's helper mod to your game. One-time setup; the game must be closed.")}
        </p>
        <p className={styles.path}>{install.gamePath}</p>
        {installing ? (
          <>
            <div className={styles.stage}>{t(line.key, { pct: line.pct ?? 0 })}</div>
            <PercentBar value={line.pct ?? 0} size="md" hideLabel label={t('Setup progress, {pct} percent', { pct: line.pct ?? 0 })} />
          </>
        ) : null}
        {err && !installing ? (
          <>
            <p className={styles.failLine} role="alert">{t(err.copy)}</p>
            {err.detail ? <p className={styles.path}>{err.detail}</p> : null}
          </>
        ) : null}
        <div className={styles.actions}>
          <Button kind="primary" size="md" disabled={installing} onClick={() => void runInstall()}>
            {installing ? t('Setting up...') : install.smapiInstalled ? t("Add Sei's helper") : t("Install SMAPI + Sei's helper")}
          </Button>
          <Button kind="quiet" size="md" disabled={installing} onClick={() => void refresh()}>{t('Check again')}</Button>
        </div>
      </section>
    );
  } else if (!open) {
    const noSave = world?.kind === 'game_running_no_save';
    card = (
      <section className={styles.card} aria-live="polite" data-state="waiting">
        <h3 className={styles.cardTitle}>{noSave ? t('Load your farm') : t('Open your farm')}</h3>
        <p className={styles.cardBody}>
          {noSave
            ? t('Stardew Valley is running. Load the farm you want to play on; your companion joins as soon as it is open.')
            : t('Start Stardew Valley with Sei, load your farm, and press Launch. Sei keeps looking for your farm while you do.')}
        </p>
        {!noSave ? (
          <div className={styles.actions}>
            <Button kind="primary" size="md" disabled={launching} onClick={() => void launchGame()}>
              {launching ? t('Starting...') : t('Launch Stardew Valley (with Sei)')}
            </Button>
          </div>
        ) : null}
        {lastLaunch && !lastLaunch.launched && lastLaunch.message ? (
          <p className={styles.cardBody}>{lastLaunch.message.replace(/^[A-Z_]+:\s*/, '')}</p>
        ) : null}
        {install.platform === 'win32' && !noteSeen ? (
          <div className={styles.note}>
            <p className={styles.noteText}>
              {t('Started this way, Steam achievements do not unlock. To keep them, add this launch option to Stardew Valley in Steam (Properties, Launch Options):')}
            </p>
            <p className={styles.code}>{steamLaunchOption(install.gamePath)}</p>
            <div className={styles.actions}>
              <Button kind="ghost" size="sm" onClick={() => void copyLaunchOption()}>{copied ? t('Copied') : t('Copy')}</Button>
              <Button kind="quiet" size="sm" onClick={dismissNote}>{t('Got it')}</Button>
            </div>
          </div>
        ) : null}
      </section>
    );
  } else {
    card = (
      <section className={styles.card} data-state="launch">
        <h3 className={styles.cardTitle}>{farm?.label}</h3>
        <p className={styles.cardBody}>{t('Your farm is open. Press Launch and {name} walks in beside you.', { name: inGameName })}</p>
      </section>
    );
  }

  return (
    <div className={styles.panel} style={{ backgroundImage: `url(${ART})` }} aria-label="Stardew Valley">
      <div className={styles.scrim} aria-hidden="true" />
      <div className={styles.content}>
        <h2 className={styles.title}>Stardew Valley</h2>
        <GamePackCard game="stardew" />
        {card}
        {ready ? (
          <>
            <Button kind="accent" size="lg" disabled={connecting} onClick={summonNow}>
              {connecting ? t('Connecting...') : t('Launch')}
            </Button>
            {inGameName ? <p className={styles.nameLine}>{t('In game as {name}', { name: inGameName })}</p> : null}
          </>
        ) : null}
        {summonFail ? (
          <p className={styles.summonFail} role="alert">{t(summonFail)}</p>
        ) : null}
      </div>
    </div>
  );
}
