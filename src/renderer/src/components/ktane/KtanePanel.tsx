/**
 * KtanePanel (261115): KTANE expert mode in the chat game area.
 *
 * The game itself runs on the player's own screen; this panel only starts the
 * session (and the call it is meant for), shows what the companion has
 * written down about the bomb (its bomb_notes, pushed from main), and starts
 * a new bomb. It ends from GameSurface's "x" like every other surface.
 * Values the companion wrote (ports, module names) are shown as written.
 */
import React from 'react';
import { useKtaneStore, isKtaneLive } from '../../lib/stores/useKtaneStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { startOrOpenCall } from '../../lib/callLaunch';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import type { KtaneSheet } from '@shared/ktaneSheet';
import styles from './KtanePanel.module.css';

export const BOMB_MANUAL_URL = 'https://www.bombmanual.com/';

export interface KtanePanelProps {
  characterId: string;
}

function useOnCall(characterId: string): boolean {
  return useVoiceStore(
    (s) => s.participants.includes(characterId) && (s.status === 'live' || s.status === 'connecting'),
  );
}

export function KtanePanel({ characterId }: KtanePanelProps): React.ReactElement {
  const t = useT();
  const name = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? '');
  const session = useKtaneStore((s) => (isKtaneLive(s, characterId) ? s.sessions[characterId] : null));
  const starting = useKtaneStore((s) => s.starting[characterId] === true);
  const error = useKtaneStore((s) => s.error[characterId] ?? null);
  const onCall = useOnCall(characterId);

  const begin = async (withCall: boolean): Promise<void> => {
    const ok = await useKtaneStore.getState().start(characterId, 'panel', onCall);
    if (ok && withCall && !onCall) startOrOpenCall(characterId);
  };

  const credit = (
    <button type="button" className={styles.credit} onClick={() => void sei.openExternal(BOMB_MANUAL_URL)}>
      {t('Manual by Steel Crate Games, free at bombmanual.com')}
    </button>
  );

  if (!session) {
    return (
      <div className={styles.panel}>
        <div className={styles.intro}>
          <div className={styles.title}>Keep Talking and Nobody Explodes</div>
          <p className={styles.lede}>
            {t('Play the game on your screen as the Defuser. {name} has the manual but cannot see the bomb, so read out what you see.', { name })}
          </p>
          <div className={styles.actions}>
            <Button kind="primary" onClick={() => void begin(true)} disabled={starting}>
              {onCall ? t('Start') : t('Start call')}
            </Button>
            {!onCall ? (
              <Button kind="quiet" onClick={() => void begin(false)} disabled={starting}>
                {t('Type instead')}
              </Button>
            ) : null}
          </div>
          {error ? <p className={styles.error}>{error}</p> : null}
        </div>
        {credit}
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.sheetHead}>
        <div className={styles.title}>{t("{name}'s notes", { name })}</div>
        <div className={styles.bomb}>{t('Bomb {n}', { n: session.sheet.bomb })}</div>
      </div>
      <NotesGrid sheet={session.sheet} />
      <p className={styles.lede}>
        {t('Tell {name} what is on the bomb. Start with the serial number or the first module.', { name })}
      </p>
      <div className={styles.actions}>
        <Button kind="soft" size="sm" onClick={() => void useKtaneStore.getState().newBomb(characterId)}>
          {t('New bomb')}
        </Button>
        {!onCall ? (
          <Button kind="primary" size="sm" onClick={() => startOrOpenCall(characterId)}>
            {t('Start call')}
          </Button>
        ) : null}
      </div>
      {credit}
    </div>
  );
}

function NotesGrid({ sheet }: { sheet: KtaneSheet }): React.ReactElement {
  const t = useT();
  const unknown = t('not asked yet');
  const none = t('none');
  const rows: [string, string][] = [
    [t('Serial'), sheet.serial ?? unknown],
    [t('Batteries'), sheet.batteries === null ? unknown : String(sheet.batteries)],
    [
      t('Indicators'),
      sheet.indicators === null
        ? unknown
        : sheet.indicators.length
          ? sheet.indicators.map((i) => `${i.lit ? '●' : '○'} ${i.label}`).join('  ')
          : none,
    ],
    [t('Ports'), sheet.ports === null ? unknown : sheet.ports.length ? sheet.ports.join(', ') : none],
    [t('Strikes'), String(sheet.strikes)],
    [t('Working on'), sheet.module ?? none],
    [t('Solved'), sheet.solved.length ? sheet.solved.join(', ') : none],
  ];
  return (
    <dl className={styles.grid}>
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className={styles.key}>{k}</dt>
          <dd className={styles.value}>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
