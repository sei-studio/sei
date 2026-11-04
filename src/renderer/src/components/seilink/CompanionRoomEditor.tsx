/**
 * The room editor for one companion, over IPC (261104, editor pass). The
 * companion page loads this lazily behind the SeiLink dev flag, so nothing
 * of the editor ships in the main chunk or shows without the flag.
 */
import React, { useMemo } from 'react';
import { RoomEditor } from './RoomEditor';
import { ipcRoomEditorSource } from './roomEditorSource';
import type { EditorOpenedFrom } from '@shared/seilinkTelemetry';

export interface CompanionRoomEditorProps {
  characterId: string;
  onClose: () => void;
  /** Where the editor was opened from (analytics). */
  openedFrom?: EditorOpenedFrom;
}

export default function CompanionRoomEditor({ characterId, onClose, openedFrom = 'other' }: CompanionRoomEditorProps): React.ReactElement {
  const source = useMemo(() => ipcRoomEditorSource(characterId), [characterId]);
  const telemetry = useMemo(() => ({ openedFrom }), [openedFrom]);
  return <RoomEditor source={source} characterId={characterId} onClose={onClose} telemetry={telemetry} />;
}
