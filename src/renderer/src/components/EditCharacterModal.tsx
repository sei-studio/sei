/**
 * EditCharacterModal — inline edit for a character's name, persona
 * source, AND the expanded long-form prompt. Also houses destructive
 * actions (Delete, Reset memory) in a footer Danger section: Delete is
 * gated through DeleteConfirmModal; Reset memory uses an inline two-
 * click confirm.
 *
 * 260516-0yw:
 *  - The description field is dropped entirely; persona prompt is renamed
 *    to PERSONA SOURCE (the short user blurb).
 *  - A collapsible EXPANDED PROMPT section shows the LLM-generated long
 *    form prompt. Default collapsed; Copy button writes to clipboard.
 *  - Save runs the main-process LLM expansion call (typical 3–8s);
 *    button text becomes "Generating persona…" while in flight.
 *  - sei.saveCharacter now returns the persisted Character; we
 *    refreshCharacter from the store to pick up persona.expanded.
 *
 * 260517-frz: the expanded prompt is now MANUALLY EDITABLE.
 *  - The collapsible section renders a textarea (not a <pre>) so the
 *    user can override the LLM expansion directly.
 *  - Save decides per change whether to regenerate from source or write
 *    the user's expanded text verbatim:
 *      • expanded edited                 → write verbatim (skipExpansion=true)
 *      • only source edited              → regenerate (skipExpansion=false)
 *      • both edited                     → expanded wins (skipExpansion=true)
 *      • neither edited (name-only save) → write verbatim (skipExpansion=true)
 *  - A "Regenerate from source" button explicitly forces a fresh LLM
 *    expansion using the current source, throwing away manual edits.
 *
 * Validation:
 *  - name must be non-empty trimmed
 *  - persona.source must be non-empty trimmed
 *
 * Pattern lifted from LanModal/DeleteConfirmModal for backdrop + ESC handling.
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useDataStore } from '../lib/stores/useDataStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { Button } from './Button';
import { PercentBar } from './PercentBar';
import { TextField } from './TextField';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { PortraitImagePicker } from './PortraitImagePicker';
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
  const [personaSource, setPersonaSource] = useState<string>(character.persona.source ?? '');
  const [personaExpanded, setPersonaExpanded] = useState<string>(character.persona.expanded ?? '');
  const [portraitImage, setPortraitImage] = useState<string | null>(character.portrait_image);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [regenerating, setRegenerating] = useState<boolean>(false);
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);
  const [confirmingReset, setConfirmingReset] = useState<boolean>(false);
  const [resetting, setResetting] = useState<boolean>(false);
  const [resetDone, setResetDone] = useState<boolean>(false);
  const [expandedOpen, setExpandedOpen] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  // Streaming persona-expansion progress (shown during a regenerate or a
  // source-only Save). `activeRequestId` gates ticks to this modal's own call.
  const [expansion, setExpansion] = useState<{ pct: number; label: string } | null>(null);
  const activeRequestId = useRef<string | null>(null);

  useEffect(() => {
    const off = sei.onExpansionProgress((ev) => {
      if (ev.requestId !== activeRequestId.current) return;
      setExpansion({ pct: Math.round(ev.fraction * 100), label: ev.section });
    });
    return off;
  }, []);

  const originalSource = character.persona.source ?? '';
  const originalExpanded = character.persona.expanded ?? '';
  const sourceDirty = personaSource !== originalSource;
  const expandedDirty = personaExpanded !== originalExpanded;

  const removeCharacter = useDataStore((s) => s.removeCharacter);
  const navigate = useUiStore((s) => s.navigate);

  const isDefault = character.is_default;

  // ESC closes (matches LanModal/DeleteConfirmModal behavior).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const onSave = async (): Promise<void> => {
    const trimmedSource = personaSource.trim();
    if (!trimmedSource) {
      setError('Persona source cannot be empty.');
      return;
    }
    setSaving(true);
    setError(null);
    // Name lives outside this modal now (inline edit next to the title on
    // CharacterPage). 260517-frz: decide regenerate vs. verbatim-write based
    // on which fields the user touched. If they touched `expanded`, edits
    // win (skipExpansion=true). If only `source`, regenerate. If neither,
    // skip — no reason to burn an API call.
    const skipExpansion = expandedDirty || !sourceDirty;
    const draft: Character = {
      ...character,
      persona: {
        source: trimmedSource,
        // When regenerating, main overwrites this. When skipping, this is
        // exactly what gets persisted.
        expanded: personaExpanded,
      },
      portrait_image: portraitImage,
    };
    // Only a regenerating save (skipExpansion=false) runs the LLM, so only then
    // do we route + show streaming progress.
    let requestId: string | undefined;
    if (!skipExpansion) {
      requestId = crypto.randomUUID();
      activeRequestId.current = requestId;
      setExpansion({ pct: 0, label: 'Starting' });
    }
    try {
      const persisted = await sei.saveCharacter(draft, { skipExpansion, expansionRequestId: requestId });
      await useDataStore.getState().refreshCharacter(character.id);
      onSaved?.(persisted);
      onClose();
    } catch (err) {
      const msg = (err as Error)?.message ?? 'Failed to save.';
      // eslint-disable-next-line no-console
      console.error('[EditCharacterModal] saveCharacter failed', err);
      setError(msg);
      setSaving(false);
      activeRequestId.current = null;
      setExpansion(null);
    }
  };

  /**
   * 260517-frz: explicit regenerate — force the main-process LLM expansion
   * using the CURRENT source field (not the saved one). Updates the
   * expanded textarea with the fresh result so the user can review and
   * adjust before pressing Save. Does NOT persist on its own.
   */
  const onRegenerate = async (): Promise<void> => {
    const trimmedSource = personaSource.trim();
    if (!trimmedSource) {
      setError('Persona source cannot be empty.');
      return;
    }
    setRegenerating(true);
    setError(null);
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    setExpansion({ pct: 0, label: 'Starting' });
    const draft: Character = {
      ...character,
      persona: { source: trimmedSource, expanded: '' },
    };
    try {
      const persisted = await sei.saveCharacter(draft, { skipExpansion: false, expansionRequestId: requestId });
      await useDataStore.getState().refreshCharacter(character.id);
      setPersonaExpanded(persisted.persona.expanded ?? '');
    } catch (err) {
      const msg = (err as Error)?.message ?? 'Failed to regenerate.';
      // eslint-disable-next-line no-console
      console.error('[EditCharacterModal] regenerate failed', err);
      setError(msg);
    } finally {
      setRegenerating(false);
      activeRequestId.current = null;
      setExpansion(null);
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
      await navigator.clipboard.writeText(personaExpanded);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // No-op — clipboard may be unavailable in some contexts.
    }
  };

  const hasExpanded = personaExpanded.trim().length > 0;
  const busy = saving || regenerating;

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
            <label className={styles.label}>CARD IMAGE</label>
            <PortraitImagePicker
              characterId={character.id}
              value={portraitImage}
              onChange={setPortraitImage}
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

          {/* 260516-0yw / 260517-frz: collapsible editable expanded-prompt */}
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
              <span>EXPANDED PROMPT{expandedDirty ? ' • edited' : ''}</span>
            </button>
            {expandedOpen ? (
              hasExpanded ? (
                <>
                  <div className={styles.expandedActions}>
                    <span className={styles.expandedHelp}>
                      Edit directly to override the auto-expansion, or regenerate from source.
                    </span>
                    <button
                      type="button"
                      className={styles.regenerateBtn}
                      onClick={() => void onRegenerate()}
                      disabled={busy || personaSource.trim() === ''}
                    >
                      {regenerating ? 'Regenerating…' : 'Regenerate from source'}
                    </button>
                  </div>
                  <div className={styles.expandedBody}>
                    <button
                      type="button"
                      className={styles.expandedCopy}
                      onClick={() => void onCopyExpanded()}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <textarea
                      className={styles.expandedTextarea}
                      value={personaExpanded}
                      onChange={(e) => setPersonaExpanded(e.target.value)}
                      spellCheck={false}
                      disabled={busy}
                      aria-label="Expanded persona prompt"
                    />
                  </div>
                </>
              ) : (
                <div className={styles.expandedHint}>
                  Save the character to generate the expanded prompt, then edit here.
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
                  disabled={resetting || busy}
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
                  disabled={busy}
                >
                  Delete character
                </button>
              </div>
            </div>
          ) : null}

          {expansion ? (
            <div className={styles.field} aria-live="polite">
              <label className={styles.label}>
                EXPANDING PERSONA: {expansion.label} · {expansion.pct}%
              </label>
              <PercentBar
                value={expansion.pct}
                size="sm"
                label={`Expanding persona: ${expansion.label}, ${expansion.pct} percent`}
              />
            </div>
          ) : null}

          {error ? <div className={styles.error}>{error}</div> : null}

          <div className={styles.footer}>
            <Button kind="quiet" size="md" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              kind="primary"
              size="md"
              onClick={() => void onSave()}
              disabled={busy}
            >
              {saving
                ? (expandedDirty || !sourceDirty ? 'Saving…' : 'Generating persona…')
                : 'Save'}
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
