/**
 * EditCharacterModal — inline edit for a character's name, description, and
 * persona prompt.
 *
 * Pattern lifted from LanModal/DeleteConfirmModal for backdrop + ESC handling
 * (no portal — same approach as the existing modals).
 *
 * Validation:
 *  - name must be non-empty trimmed
 *  - persona_prompt must be non-empty trimmed
 *  - description may be empty
 *
 * On Save: sei.saveCharacter({...character, name, description, persona_prompt})
 *  → useDataStore.refreshCharacter(id) → onClose().
 *
 * Source: quick task 260508-mun (CharacterPage restructure + Edit modal).
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useDataStore } from '../lib/stores/useDataStore';
import { Button } from './Button';
import { TextField } from './TextField';
import type { Character } from '@shared/characterSchema';
import styles from './EditCharacterModal.module.css';

export interface EditCharacterModalProps {
  character: Character;
  onClose: () => void;
  onSaved?: (updated: Character) => void;
}

export function EditCharacterModal({
  character,
  onClose,
  onSaved,
}: EditCharacterModalProps): React.ReactElement {
  const [name, setName] = useState<string>(character.name);
  const [description, setDescription] = useState<string>(character.description ?? '');
  const [personaPrompt, setPersonaPrompt] = useState<string>(character.persona_prompt ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  // ESC closes (matches LanModal/DeleteConfirmModal behavior).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const onSave = async (): Promise<void> => {
    const trimmedName = name.trim();
    const trimmedPersona = personaPrompt.trim();
    if (!trimmedName) {
      setError('Name cannot be empty.');
      return;
    }
    if (!trimmedPersona) {
      setError('Persona prompt cannot be empty.');
      return;
    }
    setSaving(true);
    setError(null);
    const updated: Character = {
      ...character,
      name: trimmedName,
      description: description, // preserve user whitespace
      persona_prompt: personaPrompt,
    };
    try {
      await sei.saveCharacter(updated);
      await useDataStore.getState().refreshCharacter(character.id);
      onSaved?.(updated);
      onClose();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[EditCharacterModal] saveCharacter failed', err);
      setError('Failed to save. Try again.');
      setSaving(false);
    }
  };

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-character-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.modal}>
        <h2 id="edit-character-title" className={styles.title}>
          Edit character
        </h2>

        <div className={styles.field}>
          <label className={styles.label}>NAME</label>
          <TextField
            value={name}
            onChange={setName}
            autoFocus
            aria-label="Character name"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>DESCRIPTION</label>
          <TextField
            value={description}
            onChange={setDescription}
            multiline
            rows={3}
            aria-label="Character description"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>PERSONA PROMPT</label>
          <TextField
            value={personaPrompt}
            onChange={setPersonaPrompt}
            multiline
            rows={12}
            monospace
            aria-label="Persona prompt"
          />
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.footer}>
          <Button kind="quiet" size="md" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            kind="primary"
            size="md"
            onClick={() => void onSave()}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
