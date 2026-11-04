/**
 * The room editor for one companion, over IPC (261104, editor pass). The
 * companion page loads this lazily behind the SeiLink dev flag, so nothing
 * of the editor ships in the main chunk or shows without the flag.
 */
import React, { useMemo } from 'react';
import { RoomEditor } from './RoomEditor';
import { ipcRoomEditorSource } from './roomEditorSource';
import type { EditorOpenedFrom } from '@shared/seilinkTelemetry';
import { useT } from '../../lib/i18n';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useAnimaLook } from '../../lib/seilink/useAnimaLook';

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
  const name = useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name ?? '');
  const avatarNote = look === 'preparing' && name ? t("Preparing {name}'s look…", { name }) : null;
  return <RoomEditor source={source} characterId={characterId} onClose={onClose} telemetry={telemetry} avatarNote={avatarNote} />;
}
