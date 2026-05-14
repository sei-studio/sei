/**
 * EditCharacterModal — inline edit for a character's name, description, and
 * persona prompt. Also houses destructive actions (Delete, Reset memory) in
 * a footer Danger section: Delete is gated through DeleteConfirmModal;
 * Reset memory uses an inline two-click confirm.
 *
 * Pattern lifted from LanModal/DeleteConfirmModal for backdrop + ESC handling.
 *
 * Validation:
 *  - name must be non-empty trimmed
 *  - persona_prompt must be non-empty trimmed
 *  - description may be empty
 *
 * On Save: sei.saveCharacter({...character, name, description, persona_prompt})
 *  → useDataStore.refreshCharacter(id) → onClose().
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useDataStore } from '../lib/stores/useDataStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from './Button';
import { TextField } from './TextField';
import { DeleteConfirmModal } from './DeleteConfirmModal';
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
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);
  const [confirmingReset, setConfirmingReset] = useState<boolean>(false);
  const [resetting, setResetting] = useState<boolean>(false);
  const [resetDone, setResetDone] = useState<boolean>(false);

  const removeCharacter = useDataStore((s) => s.removeCharacter);
  const navigate = useUiStore((s) => s.navigate);

  const isDefault = character.id === 'sui';

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

  const onConfirmDelete = async (): Promise<void> => {
    setConfirmingDelete(false);
    try {
      await sei.deleteCharacter(character.id);
      removeCharacter(character.id);
      navigate({ kind: 'home' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[EditCharacterModal] deleteCharacter failed', err);
      setError('Failed to delete. Try again.');
    }
  };

  const onResetMemoryClick = async (): Promise<void> => {
    if (!confirmingReset) {
      setConfirmingReset(true);
      return;
    }
    setResetting(true);
    setError(null);
    try {
      await sei.resetMemory(character.id);
      setConfirmingReset(false);
      setResetDone(true);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[EditCharacterModal] resetMemory failed', err);
      setError(err instanceof Error ? err.message : 'Failed to reset memory.');
      setConfirmingReset(false);
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
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

          {!isDefault ? (
            <div className={styles.danger}>
              <div className={styles.label}>DANGER</div>
              <div className={styles.dangerRow}>
                <button
                  type="button"
                  className={styles.resetBtn}
                  onClick={() => void onResetMemoryClick()}
                  disabled={resetting || saving}
                >
                  {resetDone
                    ? 'Memory reset'
                    : resetting
                      ? 'Resetting…'
                      : confirmingReset
                        ? 'Click again to confirm reset'
                        : 'Reset memory'}
                </button>
                <button
                  type="button"
                  className={styles.deleteBtn}
                  onClick={() => setConfirmingDelete(true)}
                  disabled={saving}
                >
                  Delete character
                </button>
              </div>
            </div>
          ) : null}

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

      {confirmingDelete ? (
        <DeleteConfirmModal
          characterName={character.name}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void onConfirmDelete()}
        />
      ) : null}
    </>
  );
}
