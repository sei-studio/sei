/**
 * Small popups the profile rows open (261107, profile v0.7). Each wraps an
 * existing editor unchanged; they only give it a modal of its own so a row
 * opens just its thing instead of the whole edit modal.
 */
import React from 'react';
import { useT } from '../../lib/i18n';
import { useDataStore } from '../../lib/stores/useDataStore';
import type { Character } from '@shared/characterSchema';
import { cloudAvatarOf } from '@shared/characterSchema';
import { Button } from '../Button';
import { ModalShell, ModalFooter } from '../ModalShell';
import { SkinEditor } from '../SkinEditor';
import { AvatarPane } from '../avatar/AvatarPane';
import { AvatarLibraryPicker, AvatarLibraryTiles } from '../avatar/AvatarLibraryTiles';

/** Minecraft skin + in-game username (the edit modal's Skin editor). */
export function SkinEditModal({ character, onClose }: { character: Character; onClose: () => void }): React.ReactElement {
  const t = useT();
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  return (
    <ModalShell title={t('Minecraft skin')} width={720} escClose scrimClose onClose={onClose}>
      <SkinEditor character={character} onChanged={() => void refreshCharacter(character.id)} compact />
      <ModalFooter>
        <Button kind="primary" size="md" onClick={onClose}>
          {t('Done')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}

/** The avatar library: the owner manages it, everyone else picks which public one plays. */
export function AvatarsModal({
  character,
  manage,
  onClose,
}: {
  character: Character;
  manage: boolean;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  return (
    <ModalShell title={t('Avatars')} width={640} escClose scrimClose onClose={onClose}>
      {manage ? (
        <AvatarLibraryTiles characterId={character.id} characterShared={character.shared} />
      ) : (
        <AvatarLibraryPicker characterId={character.id} />
      )}
      <ModalFooter>
        <Button kind="primary" size="md" onClick={onClose}>
          {t('Done')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}

/** The floating avatar: Static (frame, always bright) or Live2D. */
export function FloatingAvatarModal({ character, onClose }: { character: Character; onClose: () => void }): React.ReactElement {
  const t = useT();
  return (
    <ModalShell title={t('Floating avatar')} width={560} escClose scrimClose onClose={onClose}>
      <AvatarPane characterId={character.id} cloudAvatar={cloudAvatarOf(character)} showPicker={false} />
      <ModalFooter>
        <Button kind="primary" size="md" onClick={onClose}>
          {t('Done')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
