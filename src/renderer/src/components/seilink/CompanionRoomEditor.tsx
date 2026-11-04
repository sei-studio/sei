/**
 * The room editor for one companion, over IPC (261104, editor pass). The
 * companion page loads this lazily behind the SeiLink dev flag, so nothing
 * of the editor ships in the main chunk or shows without the flag.
 */
import React, { useMemo } from 'react';
import { RoomEditor } from './RoomEditor';
import { ipcRoomEditorSource } from './roomEditorSource';

export interface CompanionRoomEditorProps {
  characterId: string;
  onClose: () => void;
}

export default function CompanionRoomEditor({ characterId, onClose }: CompanionRoomEditorProps): React.ReactElement {
  const source = useMemo(() => ipcRoomEditorSource(characterId), [characterId]);
  return <RoomEditor source={source} characterId={characterId} onClose={onClose} />;
}
