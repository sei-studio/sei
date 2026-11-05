/**
 * The room editor for one companion, over IPC (261104, editor pass). The
 * companion page loads this lazily behind the SeiLink dev flag, so nothing
 * of the editor ships in the main chunk or shows without the flag.
 *
 * 261105 (T335): tells main when the editor session opens and ends (unmount,
 * or the window going away), so she can say one line about what changed
 * (main/seilink/roomReaction.ts diffs her saved room; nothing is sent here).
 *
 * 261105 (T336): for the companion who moved in, the editor is shared with
 * her (RoomTogether): her bubble, the talk box, her edits, the call pill. The
 * session token ties the editor's room syncs and her edit events together.
 *
 * 261106 (first-link flow): with `desktop` the editor opens ON the desktop.
 * Once it has mounted (it already covers the window), it asks main for the
 * desktop stage (main/seilink/desktopStage.ts): the window becomes the whole
 * primary display, above the desktop icons, drawing her room where the
 * wallpaper draws it. Closing steps aside (`reveal`): the window hides or
 * minimizes and the desktop shows her room with the icons back on top. A
 * refused stage (native fullscreen, an error) keeps the editor in the app
 * window, the same editor (analytics `surface`).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RoomEditor, type RoomTogetherCtx } from './RoomEditor';
import { RoomTogether } from './RoomTogether';
import { ipcRoomEditorSource } from './roomEditorSource';
import type { EditorOpenedFrom, EditorSurface } from '@shared/seilinkTelemetry';
import { useT } from '../../lib/i18n';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useAnimaLook } from '../../lib/seilink/useAnimaLook';
import { sei } from '../../lib/ipcClient';
import { movedInId, useSeilinkStore } from '../../lib/stores/useSeilinkStore';

function sessionToken(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** One open and one close per mount, whichever of unmount and pagehide comes first. */
function useEditorSession(characterId: string): string {
  const [token, setToken] = useState('');
  useEffect(() => {
    const token = sessionToken();
    setToken(token);
    let open = true;
    const send = (phase: 'open' | 'close'): void => {
      try {
        sei.seilinkEditorSession?.(phase, token, characterId);
      } catch {
        /* her reaction is a nicety; the editor never depends on it */
      }
    };
    const close = (): void => {
      if (!open) return;
      open = false;
      send('close');
    };
    send('open');
    window.addEventListener('pagehide', close);
    return () => {
      window.removeEventListener('pagehide', close);
      close();
    };
  }, [characterId]);
  return token;
}

/** Let the editor mount and lay out before the window changes size under it. */
const STAGE_DELAY_MS = 120;

/**
 * The desktop stage for the editor: entered once mounted, left when it closes
 * (with reveal) or unmounts some other way (without: the app comes back).
 * Returns the surface it is on and the close that steps aside first.
 */
function useDesktopStage(desktop: boolean, characterId: string, openedFrom: EditorOpenedFrom, onClose: () => void): [EditorSurface, () => void] {
  const [surface, setSurface] = useState<EditorSurface>('app');
  const staged = useRef(false);
  const closing = useRef(false);
  useEffect(() => {
    if (!desktop || !sei.seilinkStage) return;
    let dead = false;
    // A timer, not a frame: a hidden window (the dock opened this) draws no frames until the stage shows it.
    const id = window.setTimeout(() => {
      void sei.seilinkStage?.({ action: 'enter', purpose: 'editor', characterId, openedFrom }).then(
        (r) => {
          if (!r.ok) return;
          if (dead) {
            void sei.seilinkStage?.({ action: 'exit', reveal: false });
            return;
          }
          staged.current = true;
          setSurface('desktop');
        },
        () => {},
      );
    }, STAGE_DELAY_MS);
    return () => {
      dead = true;
      window.clearTimeout(id);
      if (staged.current && !closing.current) {
        staged.current = false;
        void sei.seilinkStage?.({ action: 'exit', reveal: false });
      }
    };
  }, [desktop, characterId, openedFrom]);
  const close = useCallback(() => {
    if (!staged.current) {
      onClose();
      return;
    }
    if (closing.current) return;
    closing.current = true;
    staged.current = false;
    // Step aside first (the window goes while the editor still covers it), then unmount.
    const exit = sei.seilinkStage?.({ action: 'exit', reveal: true }) ?? Promise.resolve(null);
    void exit.catch(() => null).then(() => onClose());
  }, [onClose]);
  return [surface, close];
}

export interface CompanionRoomEditorProps {
  characterId: string;
  onClose: () => void;
  /** Where the editor was opened from (analytics). */
  openedFrom?: EditorOpenedFrom;
  /** 261106: open on the desktop (the desktop stage), for the companion who lives there. */
  desktop?: boolean;
}

export default function CompanionRoomEditor({ characterId, onClose, openedFrom = 'other', desktop = false }: CompanionRoomEditorProps): React.ReactElement {
  const t = useT();
  const source = useMemo(() => ipcRoomEditorSource(characterId), [characterId]);
  const [surface, close] = useDesktopStage(desktop, characterId, openedFrom, onClose);
  const telemetry = useMemo(() => ({ openedFrom, surface }), [openedFrom, surface]);
  // 261105: SeiLink opened for her: her face set gets ready in the background while the room is set up.
  const look = useAnimaLook(characterId, 'editor');
  const token = useEditorSession(characterId);
  const name = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? '');
  const avatarNote = look === 'preparing' && name ? t("Preparing {name}'s look…", { name }) : null;
  // Only the companion who lives on the desktop shares the editor (main checks the same before anything is said).
  const resident = useSeilinkStore((s) => Boolean(s.availability?.enabled) && movedInId(s.status) === characterId);
  const together = useCallback(
    (ctx: RoomTogetherCtx) => <RoomTogether ctx={ctx} token={token} characterId={characterId} name={name} />,
    [token, characterId, name],
  );
  return (
    <RoomEditor
      source={source}
      characterId={characterId}
      onClose={close}
      telemetry={telemetry}
      avatarNote={avatarNote}
      together={resident && token && name ? together : undefined}
    />
  );
}
