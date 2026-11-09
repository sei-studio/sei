/**
 * MoveInSheet (261104, SeiLink M4): "Move {name} onto your desktop".
 *
 * Shown from the companion page's gear menu (and the SeiLink button, the
 * tour) the first time a companion moves in (she has no saved room yet), and
 * whenever moving her in would move someone else out. It has:
 *  - one line on her room: 261106 (first-link v3), she starts on a plain
 *    background with no room (plainRoomState: black or white with the OS
 *    theme), and the room is set up together, step by step, once she is on
 *    the desktop (main/seilink/decorateOffer.ts, the editor's guided setup);
 *    a companion with a saved room keeps it as she left it. (Until 261106 a
 *    first room was picked here from the three presets, then a blank white
 *    room with a chair; the editor's Room step has the rooms.)
 *  - three short lines on what moving in means (wallpaper, pauses when
 *    covered, click her to chat, the dock);
 *  - Move in: saves the plain background when it is her first, then starts the
 *    host. Main swaps out whoever lived there (one companion at a time).
 *
 *  - "Open on login" is not asked here (product call 261107): it is a step
 *    after the guided room setup (RoomEditor, lib/seilink/loginStep.ts).
 *
 * A companion whose room is saved and nobody else moved in skips the sheet
 * (needsMoveInSheet, lib/seilink/moveIn.ts); the page starts the host directly.
 */
import React, { useEffect, useRef, useState } from 'react';
import { plainRoomState, type RoomPresetId, type RoomState } from '@shared/seilinkRoom';
import type { SeilinkPack } from '@shared/seilinkPack';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import { ModalShell, ModalFooter } from '../ModalShell';
import { moveInFailed } from '../../lib/seilink/moveIn';
import { useAnimaLook } from '../../lib/seilink/useAnimaLook';
import { SEILINK_MOVEIN_SHEET_EVENT, type MoveInAction, type MoveInFail, type MoveInReason } from '@shared/seilinkTelemetry';
import type { SeilinkEntrySource } from '@shared/seilinkIntroTelemetry';
import { startSeilinkHost } from '../../lib/seilink/seilinkFlow';
import styles from './MoveInSheet.module.css';

/**
 * Her first room: the plain background (no room yet), in the cozy pack's
 * frame when it is here (where she stands), else the first pack's. Null with
 * no packs at all (nothing to draw her in).
 */
export function firstRoomState(packs: readonly SeilinkPack[]): { state: RoomState; plain: true } | null {
  const pack = packs.find((p) => p.id === 'cozy') ?? packs[0];
  return pack ? { state: plainRoomState(pack.manifest), plain: true } : null;
}

export interface MoveInSheetViewProps {
  name: string;
  /** Who lives on the desktop now and moves out (null = nobody). */
  otherName: string | null;
  /** Her first room (she starts on a plain background); false = she has a room, it stays as she left it. */
  firstRoom: boolean;
  busy: boolean;
  /** Her room is still loading (Move in waits for it). */
  loading?: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** 261105: her face set is being baked or downloaded (a quiet line, nothing on failure). */
  preparingLook?: boolean;
}

export function MoveInSheetView(p: MoveInSheetViewProps): React.ReactElement {
  const t = useT();
  return (
    <ModalShell title={t('Move {name} onto your desktop', { name: p.name })} width={560} onClose={p.busy ? undefined : p.onCancel}>
      {/* 261110 (product call 261110): one short notice, no bullets. What the
          room does on the desktop is shown when it goes live (LiveCard). */}
      <div className={styles.notice} data-movein-notice="beta_v1">
        <span className={styles.beta}>{t('Beta')}</span>
        <p className={styles.noticeText}>{t('WorldLink is a beta feature that puts {name} in a virtual space on your desktop.', { name: p.name })}</p>
      </div>
      {p.otherName ? (
        <p className={styles.line}>{t('{other} moves out first. One companion lives on the desktop at a time.', { other: p.otherName })}</p>
      ) : null}
      {p.preparingLook ? (
        <p className={styles.preparing} role="status">
          {t("Preparing {name}'s look…", { name: p.name })}
        </p>
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
        <Button kind="primary" size="md" disabled={p.busy || p.loading === true} onClick={p.onConfirm}>
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
  /** Why the page showed the sheet (analytics). */
  reason?: MoveInReason;
  /** 261105: how the person got here (analytics: the SeiLink button, the gear menu, the tour, the dock). */
  entry?: SeilinkEntrySource;
  onClose: () => void;
}

export function MoveInSheet({ characterId, name, otherName, reason, entry, onClose }: MoveInSheetProps): React.ReactElement {
  const t = useT();
  const [packs, setPacks] = useState<SeilinkPack[] | null>(null);
  const [saved, setSaved] = useState<{ saved: boolean; preset: RoomPresetId } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 261105: SeiLink opened for her: her face set gets ready in the background while she moves in.
  const look = useAnimaLook(characterId, 'move_in_sheet');
  // Analytics (261105), shape only: shown once loaded, then confirmed, failed (once per class) or dismissed.
  const openedAt = useRef(Date.now());
  const sent = useRef(new Set<string>());
  const firstRoom = saved ? !saved.saved : true;
  const first = packs ? firstRoomState(packs) : null;
  const report = (
    action: MoveInAction,
    extra: { error_class?: MoveInFail; packs?: number; first?: boolean; preset?: RoomPresetId | null; plain?: boolean } = {},
  ): void => {
    const key = action === 'failed' ? `failed:${extra.error_class}` : action;
    if (sent.current.has(key) || (action !== 'failed' && action !== 'shown' && (sent.current.has('confirmed') || sent.current.has('dismissed')))) return;
    sent.current.add(key);
    const isFirst = extra.first ?? firstRoom;
    const plain = extra.plain ?? (isFirst && first?.plain === true);
    try {
      sei.track(SEILINK_MOVEIN_SHEET_EVENT, {
        character_id: characterId,
        action,
        reason: reason ?? null,
        preset: extra.preset !== undefined ? extra.preset : isFirst ? (first?.state.preset ?? null) : (saved?.preset ?? null),
        // Until 261106 the first room was picked here; it then started blank (blank_room), now plain (plain_room).
        pick_room: isFirst,
        swap: otherName !== null,
        preset_changed: false,
        // 261110: the one-line beta notice in place of the bulleted sheet.
        notice: 'beta_v1',
        ms_open: Date.now() - openedAt.current,
        ...(plain ? { plain_room: true } : {}),
        ...(entry ? { entry } : {}),
        ...(extra.packs !== undefined ? { packs_available: extra.packs } : {}),
        ...(extra.error_class ? { error_class: extra.error_class } : {}),
      });
    } catch {
      /* analytics must never disrupt the sheet */
    }
  };

  useEffect(() => {
    let dead = false;
    void Promise.all([sei.seilinkPacks?.() ?? Promise.resolve([]), sei.seilinkRoomGet?.(characterId) ?? Promise.resolve(null)]).then(
      ([list, room]) => {
        if (dead) return;
        setPacks(list);
        const was = room ? { saved: room.saved === true, preset: room.state.preset } : { saved: false, preset: 'cozy' as RoomPresetId };
        setSaved(was);
        const f = firstRoomState(list);
        report('shown', { packs: list.length, first: !was.saved, preset: was.saved ? was.preset : (f?.state.preset ?? null), plain: !was.saved && f?.plain === true });
      },
      () => {
        if (dead) return;
        setPacks([]);
        report('shown', { packs: 0 });
      },
    );
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  const confirm = async (): Promise<void> => {
    if (!sei.seilinkHostStart) return;
    setBusy(true);
    setError(null);
    let stage: MoveInFail = 'save_failed';
    try {
      const room = firstRoom ? first : null;
      if (room && sei.seilinkRoomSet) await sei.seilinkRoomSet(characterId, room.state);
      stage = 'start_failed';
      // 261105: the first move-in on this account plays the first-link intro alongside the start.
      // 261106: a plain first room ends on the desktop with the set-it-up-together offer (seilinkFlow).
      const status = await startSeilinkHost(characterId, { firstRoom, entry: entry ?? 'gear', fresh: room?.plain === true });
      if (!status || moveInFailed(status)) {
        report('failed', { error_class: status?.state === 'unsupported' ? 'unsupported' : 'start_failed' });
        setError(t('Could not move in. Try again.'));
        setBusy(false);
        return;
      }
      report('confirmed');
      onClose();
    } catch {
      report('failed', { error_class: stage });
      setError(t('Could not move in. Try again.'));
      setBusy(false);
    }
  };

  return (
    <MoveInSheetView
      name={name}
      otherName={otherName}
      firstRoom={firstRoom}
      busy={busy}
      loading={packs === null || saved === null}
      error={error}
      onCancel={() => {
        report('dismissed');
        onClose();
      }}
      onConfirm={() => void confirm()}
      preparingLook={look === 'preparing'}
    />
  );
}

export default MoveInSheet;
