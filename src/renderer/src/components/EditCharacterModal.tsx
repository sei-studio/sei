/**
 * EditCharacterModal — inline edit for a character's name and persona
 * source. Also houses destructive actions (Delete, Reset memory) in a
 * footer Danger section: Delete is gated through DeleteConfirmModal;
 * Reset memory uses an inline two-click confirm.
 *
 * 260516-0yw:
 *  - The description field is dropped entirely; persona prompt is renamed
 *    to PERSONA SOURCE (the short user blurb).
 *  - A collapsible "EXPANDED PROMPT (read-only)" section shows the
 *    LLM-generated long-form prompt. Default collapsed; Copy button
 *    writes to clipboard. When persona.expanded is empty, a hint is
 *    shown instead of the preview.
 *  - Save runs the main-process LLM expansion call (typical 3–8s);
 *    button text becomes "Generating persona…" while in flight.
 *  - sei.saveCharacter now returns the persisted Character; we
 *    refreshCharacter from the store to pick up persona.expanded.
 *
 * Validation:
 *  - name must be non-empty trimmed
 *  - persona.source must be non-empty trimmed
 *
 * Pattern lifted from LanModal/DeleteConfirmModal for backdrop + ESC handling.
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
  const [personaSource, setPersonaSource] = useState<string>(character.persona.source ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);
  const [confirmingReset, setConfirmingReset] = useState<boolean>(false);
  const [resetting, setResetting] = useState<boolean>(false);
  const [resetDone, setResetDone] = useState<boolean>(false);
  const [expandedOpen, setExpandedOpen] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

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
    const trimmedSource = personaSource.trim();
    if (!trimmedName) {
      setError('Name cannot be empty.');
      return;
    }
    if (!trimmedSource) {
      setError('Persona source cannot be empty.');
      return;
    }
    setSaving(true);
    setError(null);
    // Send the SOURCE (not expanded) — main will regenerate `expanded`
    // from the new source using the prior expansion as voice-continuity
    // reference, then return the persisted Character.
    const draft: Character = {
      ...character,
      name: trimmedName,
      persona: {
        source: trimmedSource,
        expanded: character.persona.expanded, // ignored by main; expandAndSaveCharacter rewrites it
      },
    };
    try {
      const persisted = await sei.saveCharacter(draft);
      // refreshCharacter re-fetches from main into the store. The returned
      // `persisted` already has the new expanded prompt, but going through
      // the store's refresh path keeps the same single source-of-truth
      // shape with the rest of the UI.
      await useDataStore.getState().refreshCharacter(character.id);
      onSaved?.(persisted);
      onClose();
    } catch (err) {
      const msg = (err as Error)?.message ?? 'Failed to save.';
      // eslint-disable-next-line no-console
      console.error('[EditCharacterModal] saveCharacter failed', err);
      setError(msg);
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

  const onCopyExpanded = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(character.persona.expanded ?? '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // No-op — clipboard may be unavailable in some contexts.
    }
  };

  const hasExpanded = (character.persona.expanded ?? '').trim().length > 0;

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
            <label className={styles.label}>PERSONA SOURCE</label>
            <TextField
              value={personaSource}
              onChange={setPersonaSource}
              multiline
              rows={4}
              aria-label="Persona source"
            />
          </div>

          {/* 260516-0yw: collapsible read-only expanded-prompt preview */}
          <div className={styles.expandedSection}>
            <button
              type="button"
              className={styles.expandedToggle}
              onClick={() => setExpandedOpen((v) => !v)}
              aria-expanded={expandedOpen}
            >
              <span className={styles.expandedCaret} aria-hidden="true">
                {expandedOpen ? '▾' : '▸'}
              </span>
              <span>EXPANDED PROMPT (read-only)</span>
            </button>
            {expandedOpen ? (
              hasExpanded ? (
                <div className={styles.expandedBody}>
                  <button
                    type="button"
                    className={styles.expandedCopy}
                    onClick={() => void onCopyExpanded()}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <pre className={styles.expandedPre}>{character.persona.expanded}</pre>
                </div>
              ) : (
                <div className={styles.expandedHint}>
                  Save the character to generate the expanded prompt.
                </div>
              )
            ) : null}
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
              {saving ? 'Generating persona…' : 'Save'}
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
