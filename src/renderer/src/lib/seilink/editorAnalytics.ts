/**
 * Room editor analytics (261105), shape only. One seilink_editor_session per
 * editor session, sent when the editor closes (or the window goes away with it
 * open), plus seilink_editor_error the first time each kind of failure happens
 * in a session. Counting lives in the pure EditorSessionTracker
 * (@shared/seilinkTelemetry); this hook feeds it the editor's state.
 *
 * Only the companion editor (CompanionRoomEditor) passes `telemetry`; the dev
 * preview and the screenshot harness send nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isDirty, type EditHistory } from '@shared/seilinkEdit';
import {
  EditorSessionTracker,
  SEILINK_EDITOR_ERROR_EVENT,
  SEILINK_EDITOR_SESSION_EVENT,
  type AvatarUploadFail,
  type EditorError,
  type EditorOpenedFrom,
  type EditorPanel,
  type RoomShapeAtClose,
} from '@shared/seilinkTelemetry';
import type { RoomSlotId } from '@shared/seilinkRoom';
import { sei } from '../ipcClient';

export interface EditorTelemetry {
  openedFrom: EditorOpenedFrom;
  characterId?: string;
}

/** StrictMode mounts, unmounts and mounts again: an untouched session this short is that, not a real open. */
export const THROWAWAY_SESSION_MS = 250;

function track(event: string, props: Record<string, string | number | boolean | null>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics must never disrupt the editor */
  }
}

export interface EditorAnalyticsInput {
  history: EditHistory | null;
  panel: EditorPanel | null;
  saving: 'idle' | 'saving' | 'saved' | 'error';
  loadError: boolean;
  packsEmpty: boolean;
  /** 261105: slots whose recolour is a light colour (lightSlotsOf the current pack). */
  lightSlots?: ReadonlySet<RoomSlotId>;
  /** 261105: the room's shape at close (roomShapeOf), read when the session ends. */
  shape?: () => RoomShapeAtClose | undefined;
}

export interface EditorAnalytics {
  avatarUpload(stage: 'start' | 'ok' | 'fail', reason?: AvatarUploadFail): void;
}

export function useEditorAnalytics(telemetry: EditorTelemetry | null | undefined, input: EditorAnalyticsInput): EditorAnalytics {
  const on = !!telemetry;
  const openedFrom = telemetry?.openedFrom ?? 'other';
  const characterId = telemetry?.characterId ?? null;
  const [session] = useState(() => ({ tracker: new EditorSessionTracker(openedFrom, Date.now()), at: Date.now() }));
  const historyRef = useRef(input.history);
  historyRef.current = input.history;
  const shapeRef = useRef(input.shape);
  shapeRef.current = input.shape;

  const error = useCallback(
    (kind: EditorError) => {
      if (on && session.tracker.error(kind)) track(SEILINK_EDITOR_ERROR_EVENT, { kind, opened_from: openedFrom, character_id: characterId });
    },
    [on, session, openedFrom, characterId],
  );

  useEffect(() => {
    if (on) session.tracker.history(input.history);
  }, [on, session, input.history]);

  useEffect(() => {
    if (on && input.lightSlots) session.tracker.setLightSlots(input.lightSlots);
  }, [on, session, input.lightSlots]);

  useEffect(() => {
    if (on) session.tracker.panel(input.panel);
  }, [on, session, input.panel]);

  useEffect(() => {
    if (!on) return;
    if (input.saving === 'saved') session.tracker.saved(true);
    else if (input.saving === 'error') {
      session.tracker.saved(false);
      error('save_failed');
    }
  }, [on, session, input.saving, error]);

  useEffect(() => {
    if (input.loadError) error('load_failed');
  }, [input.loadError, error]);
  useEffect(() => {
    if (input.packsEmpty) error('no_packs');
  }, [input.packsEmpty, error]);

  useEffect(() => {
    if (!on) return;
    const finish = (): void => {
      const now = Date.now();
      if (!session.tracker.touched && now - session.at < THROWAWAY_SESSION_MS) return;
      const h = historyRef.current;
      let shape: RoomShapeAtClose | undefined;
      try {
        shape = shapeRef.current?.();
      } catch {
        shape = undefined;
      }
      const props = session.tracker.finish(now, h ? isDirty(h) : false, characterId, shape);
      if (props) track(SEILINK_EDITOR_SESSION_EVENT, props);
    };
    window.addEventListener('pagehide', finish);
    return () => {
      window.removeEventListener('pagehide', finish);
      finish();
    };
  }, [on, session, characterId]);

  const avatarUpload = useCallback(
    (stage: 'start' | 'ok' | 'fail', reason?: AvatarUploadFail) => {
      if (!on) return;
      session.tracker.avatarUpload(stage, reason);
      if (stage === 'fail' && reason === 'import_failed') error('avatar_import_failed');
    },
    [on, session, error],
  );

  return { avatarUpload };
}
