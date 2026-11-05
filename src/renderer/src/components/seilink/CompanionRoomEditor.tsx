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
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RoomEditor, type RoomTogetherCtx } from './RoomEditor';
import { RoomTogether } from './RoomTogether';
import { ipcRoomEditorSource } from './roomEditorSource';
import type { EditorOpenedFrom } from '@shared/seilinkTelemetry';
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

export interface CompanionRoomEditorProps {
  characterId: string;
  onClose: () => void;
  /** Where the editor was opened from (analytics). */
  openedFrom?: EditorOpenedFrom;
}

export default function CompanionRoomEditor({ characterId, onClose, openedFrom = 'other' }: CompanionRoomEditorProps): React.ReactElement {
  const t = useT();
  const source = useMemo(() => ipcRoomEditorSource(characterId), [characterId]);
  const telemetry = useMemo(() => ({ openedFrom }), [openedFrom]);
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
      onClose={onClose}
      telemetry={telemetry}
      avatarNote={avatarNote}
      together={resident && token && name ? together : undefined}
    />
  );
}
