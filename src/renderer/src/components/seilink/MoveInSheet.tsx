/**
 * MoveInSheet (261104, SeiLink M4): "Move {name} onto your desktop".
 *
 * Shown from the companion page's gear menu the first time a companion moves
 * in (she has no saved room yet), and whenever moving her in would move
 * someone else out. It has:
 *  - a room picker (one card per room pack that exists; a preset without a
 *    pack is shown disabled, "Soon", like the editor). Hidden when she
 *    already has a room: it stays as she left it;
 *  - three short lines on what moving in means (wallpaper, pauses when
 *    covered, click her to chat, the dock);
 *  - Move in: saves the picked room when it is new, then starts the host.
 *    Main swaps out whoever lived there (one companion at a time).
 *
 * A companion whose room is saved and nobody else moved in skips the sheet
 * (needsMoveInSheet, lib/seilink/moveIn.ts); the page starts the host directly.
 */
import React, { useEffect, useState } from 'react';
import { defaultRoomState, ROOM_PRESET_IDS, type RoomPresetId } from '@shared/seilinkRoom';
import { seilinkResolver, type SeilinkPack } from '@shared/seilinkPack';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { roomThumb } from '../../lib/seilink/roomThumbs';
import { Button } from '../Button';
import { ModalShell, ModalFooter } from '../ModalShell';
import { CheckIcon } from './roomEditorIcons';
import { moveInFailed, ROOM_PRESET_LABEL } from '../../lib/seilink/moveIn';
import styles from './MoveInSheet.module.css';

function PresetThumb({ pack }: { pack: SeilinkPack }): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    roomThumb(pack.manifest, defaultRoomState(pack.id), { time: 'day', resolve: seilinkResolver(pack), width: 320, rev: pack.rev }).then(
      (u) => !dead && setUrl(u),
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [pack]);
  return url ? <img className={styles.cardImg} src={url} alt="" draggable={false} /> : <span className={styles.cardWait} />;
}

export interface MoveInSheetViewProps {
  name: string;
  /** Who lives on the desktop now and moves out (null = nobody). */
  otherName: string | null;
  /** Packs that exist, or null while loading. */
  packs: SeilinkPack[] | null;
  /** Show the room picker (her first room). */
  pickRoom: boolean;
  preset: RoomPresetId | null;
  onPick: (id: RoomPresetId) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function MoveInSheetView(p: MoveInSheetViewProps): React.ReactElement {
  const t = useT();
  return (
    <ModalShell title={t('Move {name} onto your desktop', { name: p.name })} width={560} onClose={p.busy ? undefined : p.onCancel}>
      {p.pickRoom ? (
        <section className={styles.rooms} aria-label={t('Pick a room')}>
          <h3 className={styles.heading}>{t('Pick a room')}</h3>
          <div className={styles.cards}>
            {ROOM_PRESET_IDS.map((id) => {
              const pack = p.packs?.find((x) => x.id === id) ?? null;
              const on = p.preset === id;
              return (
                <button
                  key={id}
                  type="button"
                  className={on ? `${styles.card} ${styles.cardOn}` : styles.card}
                  aria-pressed={on}
                  disabled={!pack || p.busy}
                  onClick={() => p.onPick(id)}
                >
                  <span className={styles.cardArt}>
                    {pack ? <PresetThumb pack={pack} /> : <span className={styles.cardWait} />}
                    {on ? (
                      <span className={styles.cardCheck}>
                        <CheckIcon size={12} />
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.cardLabel}>
                    {t(ROOM_PRESET_LABEL[id])}
                    {p.packs && !pack ? <span className={styles.soon}>{t('Soon')}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : (
        <p className={styles.line}>{t("{name}'s room stays as you left it.", { name: p.name })}</p>
      )}
      <ul className={styles.points}>
        <li>{t('{name} lives on your wallpaper, behind your windows and icons.', { name: p.name })}</li>
        <li>{t('The room pauses while windows cover it.')}</li>
        <li>{t('Click {name} to chat. The dock in the room edits it, mutes desktop lines, or moves {name} out.', { name: p.name })}</li>
      </ul>
      {p.otherName ? (
        <p className={styles.line}>{t('{other} moves out first. One companion lives on the desktop at a time.', { other: p.otherName })}</p>
      ) : null}
      {p.error ? (
        <p className={styles.error} role="alert">
          {p.error}
        </p>
      ) : null}
      <ModalFooter>
        <Button kind="quiet" size="md" disabled={p.busy} onClick={p.onCancel}>
          {t('Not now')}
        </Button>
        <Button kind="primary" size="md" disabled={p.busy || (p.pickRoom && !p.preset)} onClick={p.onConfirm}>
          {p.busy ? t('Moving in') : t('Move in')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}

export interface MoveInSheetProps {
  characterId: string;
  name: string;
  otherName: string | null;
  onClose: () => void;
}

export function MoveInSheet({ characterId, name, otherName, onClose }: MoveInSheetProps): React.ReactElement {
  const t = useT();
  const [packs, setPacks] = useState<SeilinkPack[] | null>(null);
  const [saved, setSaved] = useState<{ saved: boolean; preset: RoomPresetId } | null>(null);
  const [preset, setPreset] = useState<RoomPresetId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    void Promise.all([sei.seilinkPacks?.() ?? Promise.resolve([]), sei.seilinkRoomGet?.(characterId) ?? Promise.resolve(null)]).then(
      ([list, room]) => {
        if (dead) return;
        setPacks(list);
        const was = room ? { saved: room.saved === true, preset: room.state.preset } : { saved: false, preset: 'cozy' as RoomPresetId };
        setSaved(was);
        const usable = list.some((x) => x.id === was.preset) ? was.preset : (list[0]?.id ?? null);
        setPreset(usable);
      },
      () => !dead && setPacks([]),
    );
    return () => {
      dead = true;
    };
  }, [characterId]);

  const pickRoom = saved ? !saved.saved : true;

  const confirm = async (): Promise<void> => {
    if (!sei.seilinkHostStart) return;
    setBusy(true);
    setError(null);
    try {
      if (pickRoom && preset && sei.seilinkRoomSet) await sei.seilinkRoomSet(characterId, defaultRoomState(preset));
      const status = await sei.seilinkHostStart(characterId, { firstRoom: pickRoom });
      if (moveInFailed(status)) {
        setError(t('Could not move in. Try again.'));
        setBusy(false);
        return;
      }
      onClose();
    } catch {
      setError(t('Could not move in. Try again.'));
      setBusy(false);
    }
  };

  return (
    <MoveInSheetView
      name={name}
      otherName={otherName}
      packs={packs}
      pickRoom={pickRoom}
      preset={preset}
      onPick={setPreset}
      busy={busy}
      error={error}
      onCancel={onClose}
      onConfirm={() => void confirm()}
    />
  );
}

export default MoveInSheet;
