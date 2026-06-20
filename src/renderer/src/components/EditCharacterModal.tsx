/**
 * EditCharacterModal — sidebar-organized editor for an owned character.
 *
 * Layout: a left nav (Basic / Appearance / Persona) beside a scrolling content
 * pane. Destructive actions (Reset memory, Delete) live in the sidebar footer.
 *
 *  - BASIC      — name + human-facing description. (Moved off CharacterPage,
 *                 which is now read-only.) Persisted with skipExpansion.
 *  - APPEARANCE — card image upload + skin selection/preview. (Skin editing
 *                 moved here from the character page's Skin tab, which is now
 *                 read-only.) Both apply immediately (no modal Save).
 *  - PERSONA    — two modes:
 *      • Standard: persona SOURCE + PROACTIVENESS + a Regenerate button.
 *        Changing either marks the persona dirty; to leave you must Regenerate
 *        (re-runs the expander, persists) or Discard. Regenerate counts against
 *        the existing persona-expansion rate limit.
 *      • Advanced: the raw expanded prompt sent to the LLM, edited verbatim
 *        (Save writes it as-is, skipExpansion). The user can drop the
 *        proactiveness framework etc.
 *      Switching Advanced → Standard regenerates from source (discarding manual
 *      edits), because Standard assumes expanded == expansion(source, tier).
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
import { ResetMemoryConfirmModal } from './ResetMemoryConfirmModal';
import { PortraitImagePicker } from './PortraitImagePicker';
import { SkinEditor } from './SkinEditor';
import { PROACTIVENESS_LEVELS, getProactiveness } from '../lib/proactiveness';
import type { Character } from '@shared/characterSchema';
import styles from './EditCharacterModal.module.css';

export type EditSection = 'basic' | 'appearance' | 'persona';
type PersonaMode = 'standard' | 'advanced';

export interface EditCharacterModalProps {
  character: Character;
  onClose: () => void;
  onSaved?: (updated: Character) => void;
  /** Which sidebar section to open on mount. Defaults to 'basic'. */
  initialSection?: EditSection;
}

export function EditCharacterModal({
  character,
  onClose,
  onSaved,
  initialSection = 'basic',
}: EditCharacterModalProps): React.ReactElement {
  const [section, setSection] = useState<EditSection | 'danger'>(initialSection);
  const [personaMode, setPersonaMode] = useState<PersonaMode>('standard');

  // ── Edit state ──────────────────────────────────────────────────────
  const [name, setName] = useState<string>(character.name ?? '');
  const [description, setDescription] = useState<string>(character.description ?? '');
  const [portraitImage, setPortraitImage] = useState<string | null>(character.portrait_image);
  const [personaSource, setPersonaSource] = useState<string>(character.persona.source ?? '');
  const [personaExpanded, setPersonaExpanded] = useState<string>(character.persona.expanded ?? '');
  const [proactiveness, setProactiveness] = useState<number>(getProactiveness(character));

  // ── Baselines (last persisted values) — drive the dirty flags. Updated
  //    after each successful persist; NOT reset by prop changes. ──────────
  const [savedName, setSavedName] = useState<string>(character.name ?? '');
  const [savedDescription, setSavedDescription] = useState<string>(character.description ?? '');
  const [savedSource, setSavedSource] = useState<string>(character.persona.source ?? '');
  const [savedExpanded, setSavedExpanded] = useState<string>(character.persona.expanded ?? '');
  const [savedProactiveness, setSavedProactiveness] = useState<number>(getProactiveness(character));

  const [error, setError] = useState<string | null>(null);
  const [savingBasic, setSavingBasic] = useState<boolean>(false);
  const [basicSaved, setBasicSaved] = useState<boolean>(false);
  const [regenerating, setRegenerating] = useState<boolean>(false);
  const [savingAdvanced, setSavingAdvanced] = useState<boolean>(false);
  const [confirmSwitch, setConfirmSwitch] = useState<boolean>(false);
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState<boolean>(false);
  const [resetting, setResetting] = useState<boolean>(false);
  const [resetDone, setResetDone] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [expansion, setExpansion] = useState<{ pct: number; label: string } | null>(null);
  const activeRequestId = useRef<string | null>(null);

  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  const removeCharacter = useDataStore((s) => s.removeCharacter);
  const navigate = useUiStore((s) => s.navigate);
  const isDefault = character.is_default;

  useEffect(() => {
    const off = sei.onExpansionProgress((ev) => {
      if (ev.requestId !== activeRequestId.current) return;
      setExpansion({ pct: Math.round(ev.fraction * 100), label: ev.section });
    });
    return off;
  }, []);

  // ── Dirty flags ─────────────────────────────────────────────────────
  const basicDirty = name.trim() !== savedName.trim() || description.trim() !== savedDescription.trim();
  const sourceDirty = personaSource !== savedSource;
  const proactivenessDirty = proactiveness !== savedProactiveness;
  const standardDirty = sourceDirty || proactivenessDirty;
  const expandedDirty = personaExpanded !== savedExpanded;
  const personaDirty = personaMode === 'standard' ? standardDirty : expandedDirty;
  const busy = savingBasic || regenerating || savingAdvanced;

  // Closing is blocked while persona has un-applied changes — the user must
  // Regenerate / Save them or Discard. Basic edits auto-save on close.
  const canClose = !personaDirty && !busy;

  const requestClose = async (): Promise<void> => {
    if (!canClose) return;
    if (basicDirty) {
      const ok = await persistBasic();
      if (!ok) return;
    }
    onClose();
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && canClose) void requestClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canClose, basicDirty, name, description]);

  // ── Persistence helpers ─────────────────────────────────────────────
  const persistBasic = async (): Promise<boolean> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name cannot be empty.');
      return false;
    }
    setSavingBasic(true);
    setError(null);
    const descTrim = description.trim();
    const draft: Character = { ...character, name: trimmed, description: descTrim === '' ? null : descTrim };
    try {
      const persisted = await sei.saveCharacter(draft, { skipExpansion: true });
      await refreshCharacter(character.id);
      setSavedName(trimmed);
      setSavedDescription(descTrim);
      setBasicSaved(true);
      window.setTimeout(() => setBasicSaved(false), 1500);
      onSaved?.(persisted);
      return true;
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to save.');
      return false;
    } finally {
      setSavingBasic(false);
    }
  };

  const persistPortrait = async (ref: string | null): Promise<void> => {
    setPortraitImage(ref);
    setError(null);
    try {
      const persisted = await sei.saveCharacter({ ...character, portrait_image: ref }, { skipExpansion: true });
      await refreshCharacter(character.id);
      onSaved?.(persisted);
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to save image.');
    }
  };

  /** Re-run the expander from the current source + proactiveness, persist, and
   *  sync the expanded text. Consumes one persona-expansion (rate-limited). */
  const regenerate = async (): Promise<boolean> => {
    const trimmedSource = personaSource.trim();
    if (!trimmedSource) {
      setError('Persona source cannot be empty.');
      return false;
    }
    setRegenerating(true);
    setError(null);
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    setExpansion({ pct: 0, label: 'Starting' });
    const draft: Character = {
      ...character,
      persona: { source: trimmedSource, expanded: '' },
      metadata: { ...(character.metadata ?? {}), proactiveness },
    };
    try {
      const persisted = await sei.saveCharacter(draft, { skipExpansion: false, expansionRequestId: requestId });
      await refreshCharacter(character.id);
      const nextExpanded = persisted.persona.expanded ?? '';
      setPersonaExpanded(nextExpanded);
      setSavedExpanded(nextExpanded);
      setSavedSource(trimmedSource);
      setSavedProactiveness(proactiveness);
      onSaved?.(persisted);
      return true;
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to regenerate.');
      return false;
    } finally {
      setRegenerating(false);
      activeRequestId.current = null;
      setExpansion(null);
    }
  };

  /** Advanced-mode save: write the hand-edited expanded prompt verbatim. */
  const saveAdvanced = async (): Promise<void> => {
    setSavingAdvanced(true);
    setError(null);
    const draft: Character = {
      ...character,
      persona: { source: savedSource, expanded: personaExpanded },
    };
    try {
      const persisted = await sei.saveCharacter(draft, { skipExpansion: true });
      await refreshCharacter(character.id);
      setSavedExpanded(personaExpanded);
      onSaved?.(persisted);
    } catch (err) {
      setError((err as Error)?.message ?? 'Failed to save.');
    } finally {
      setSavingAdvanced(false);
    }
  };

  // ── Persona mode switching ──────────────────────────────────────────
  const goAdvanced = (): void => {
    if (standardDirty) return; // gated — regenerate or discard first
    setPersonaMode('advanced');
  };

  const requestStandard = (): void => {
    if (personaMode === 'standard') return;
    if (expandedDirty) {
      // Manual edits would be discarded by a regenerate — confirm first.
      setConfirmSwitch(true);
      return;
    }
    setPersonaMode('standard');
  };

  const confirmSwitchToStandard = async (): Promise<void> => {
    setConfirmSwitch(false);
    const ok = await regenerate();
    if (ok) setPersonaMode('standard');
  };

  const discardStandard = (): void => {
    setPersonaSource(savedSource);
    setProactiveness(savedProactiveness);
    setError(null);
  };

  const discardAdvanced = (): void => {
    setPersonaExpanded(savedExpanded);
    setError(null);
  };

  // ── Destructive actions ─────────────────────────────────────────────
  const onConfirmDelete = async (): Promise<void> => {
    setConfirmingDelete(false);
    try {
      await sei.deleteCharacter(character.id);
      removeCharacter(character.id);
      navigate({ kind: 'home' });
    } catch (err) {
      console.error('[EditCharacterModal] deleteCharacter failed', err);
      setError('Failed to delete. Try again.');
    }
  };

  // Reset now goes through the shared confirmation popup (explains it can't
  // touch in-game inventory/location). The button opens it; this runs on confirm.
  const doResetMemory = async (): Promise<void> => {
    setResetConfirmOpen(false);
    setResetting(true);
    setError(null);
    try {
      await sei.resetMemory(character.id);
      setResetDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset memory.');
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
      /* clipboard may be unavailable */
    }
  };

  const NAV: { key: EditSection | 'danger'; label: string }[] = [
    { key: 'basic', label: 'Basic' },
    { key: 'appearance', label: 'Appearance' },
    { key: 'persona', label: 'Persona' },
    ...(!isDefault ? [{ key: 'danger' as const, label: 'Danger' }] : []),
  ];

  return (
    <>
      <div
        className={styles.scrim}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-character-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) void requestClose();
        }}
      >
        <div className={styles.modal}>
          {/* ── Sidebar ── */}
          <aside className={styles.sidebar}>
            <h2 id="edit-character-title" className={styles.title}>
              Edit character
            </h2>
            <nav className={styles.nav}>
              {NAV.map((n) => (
                <button
                  key={n.key}
                  type="button"
                  className={`${styles.navItem} ${section === n.key ? styles.navItemActive : ''}`}
                  onClick={() => setSection(n.key)}
                  aria-current={section === n.key}
                >
                  {n.label}
                </button>
              ))}
            </nav>
          </aside>

          {/* ── Content pane ── */}
          <section className={styles.pane}>
            <div className={styles.paneScroll}>
              {section === 'basic' ? (
                <>
                  <div className={styles.field}>
                    <label className={styles.label}>NAME</label>
                    <TextField value={name} onChange={setName} aria-label="Character name" />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>DESCRIPTION</label>
                    <p className={styles.paneHint}>For you and other players</p>
                    <TextField
                      value={description}
                      onChange={setDescription}
                      multiline
                      rows={4}
                      aria-label="Description"
                    />
                  </div>
                </>
              ) : null}

              {section === 'appearance' ? (
                <>
                  <div className={styles.subSection}>
                    <label className={styles.label}>CARD IMAGE</label>
                    <PortraitImagePicker
                      characterId={character.id}
                      value={portraitImage}
                      onChange={(ref) => void persistPortrait(ref)}
                    />
                  </div>
                  <div className={styles.subSection}>
                    <label className={styles.label}>SKIN</label>
                    <SkinEditor character={character} onChanged={() => void refreshCharacter(character.id)} />
                  </div>
                  <span className={styles.appearanceNote}>Image and skin changes apply immediately.</span>
                </>
              ) : null}

              {section === 'persona' ? (
                <>
                  <div className={styles.modeTabs} role="tablist" aria-label="Persona edit mode">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={personaMode === 'standard'}
                      className={personaMode === 'standard' ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
                      onClick={requestStandard}
                      disabled={busy}
                    >
                      Standard
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={personaMode === 'advanced'}
                      className={personaMode === 'advanced' ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
                      onClick={goAdvanced}
                      disabled={busy || standardDirty}
                      title={standardDirty ? 'Regenerate or discard your changes first' : undefined}
                    >
                      Advanced
                    </button>
                  </div>

                  {confirmSwitch ? (
                    <div className={styles.confirmBanner} role="alertdialog" aria-label="Switch to standard mode">
                      <span className={styles.confirmBannerText}>
                        Switching to Standard regenerates the persona from your source and proactiveness,
                        discarding your manual prompt edits. This uses one generation.
                      </span>
                      <div className={styles.confirmBannerActions}>
                        <Button kind="quiet" size="sm" onClick={() => setConfirmSwitch(false)} disabled={busy}>
                          Keep editing
                        </Button>
                        <Button kind="accent" size="sm" onClick={() => void confirmSwitchToStandard()} disabled={busy}>
                          {regenerating ? 'Regenerating…' : 'Regenerate & switch'}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {personaMode === 'standard' ? (
                    <>
                      <div className={styles.field}>
                        <label className={styles.label}>PERSONA SOURCE</label>
                        <p className={styles.paneHint}>
                          A short description; the model expands it into the character&apos;s voice and behavior.
                        </p>
                        <TextField
                          value={personaSource}
                          onChange={setPersonaSource}
                          multiline
                          rows={5}
                          aria-label="Persona source"
                        />
                      </div>
                      <div className={styles.field}>
                        <label className={styles.label}>PROACTIVENESS</label>
                        <div className={styles.proactivenessPicker} role="radiogroup" aria-label="Proactiveness level">
                          {PROACTIVENESS_LEVELS.map((lvl) => (
                            <button
                              key={lvl.value}
                              type="button"
                              role="radio"
                              aria-checked={proactiveness === lvl.value}
                              title={lvl.blurb}
                              className={`${styles.proactivenessStep} ${proactiveness === lvl.value ? styles.proactivenessStepOn : ''}`}
                              onClick={() => setProactiveness(lvl.value)}
                              disabled={busy}
                            >
                              {lvl.label}
                            </button>
                          ))}
                        </div>
                        <span className={styles.proactivenessHelp}>
                          {PROACTIVENESS_LEVELS[proactiveness]?.blurb}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className={styles.field}>
                      <label className={styles.label}>RAW PROMPT</label>
                      <p className={styles.paneHint}>
                        The exact prompt sent to the model each turn. Editing here overrides the standard
                        framework (proactiveness, voice rules, and all).
                      </p>
                      <div className={styles.expandedBody}>
                        <button type="button" className={styles.expandedCopy} onClick={() => void onCopyExpanded()}>
                          {copied ? 'Copied' : 'Copy'}
                        </button>
                        <textarea
                          className={styles.expandedTextarea}
                          value={personaExpanded}
                          onChange={(e) => setPersonaExpanded(e.target.value)}
                          spellCheck={false}
                          disabled={busy}
                          aria-label="Raw expanded prompt"
                        />
                      </div>
                    </div>
                  )}
                </>
              ) : null}

              {section === 'danger' && !isDefault ? (
                <div className={styles.dangerPane}>
                  <p className={styles.dangerHint}>
                    Reset wipes this character&apos;s memory of you and starts fresh. Deleting removes the
                    character permanently and cannot be undone.
                  </p>
                  <div className={styles.dangerRow}>
                    <Button
                      kind="ghost"
                      size="md"
                      onClick={() => setResetConfirmOpen(true)}
                      disabled={resetting || busy}
                    >
                      {resetDone ? 'Memory reset' : resetting ? 'Resetting…' : 'Reset memory'}
                    </Button>
                    <Button kind="danger" size="md" onClick={() => setConfirmingDelete(true)} disabled={busy}>
                      Delete character
                    </Button>
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
            </div>

            {/* ── Pane footer (contextual actions) ── */}
            <div className={styles.footer}>
              {personaDirty && section !== 'persona' ? (
                <span className={styles.footerHint}>Unsaved persona changes — open Persona to apply or discard.</span>
              ) : null}
              {section === 'basic' ? (
                <>
                  {basicSaved ? <span className={styles.savedTag}>Saved</span> : null}
                  <Button kind="quiet" size="md" onClick={() => void requestClose()} disabled={!canClose}>
                    Close
                  </Button>
                  <Button kind="primary" size="md" onClick={() => void persistBasic()} disabled={!basicDirty || busy}>
                    {savingBasic ? 'Saving…' : 'Save'}
                  </Button>
                </>
              ) : null}

              {section === 'appearance' || section === 'danger' ? (
                <Button kind="primary" size="md" onClick={() => void requestClose()} disabled={!canClose}>
                  Done
                </Button>
              ) : null}

              {section === 'persona' ? (
                personaMode === 'standard' ? (
                  <>
                    {standardDirty ? (
                      <span className={styles.footerHint}>Regenerate to apply, or discard.</span>
                    ) : null}
                    {standardDirty ? (
                      <Button kind="quiet" size="md" onClick={discardStandard} disabled={busy}>
                        Discard
                      </Button>
                    ) : (
                      <Button kind="quiet" size="md" onClick={() => void requestClose()} disabled={!canClose}>
                        Close
                      </Button>
                    )}
                    <Button
                      kind="accent"
                      size="md"
                      onClick={() => void regenerate()}
                      disabled={busy || !standardDirty || personaSource.trim() === ''}
                    >
                      {regenerating ? 'Regenerating…' : 'Regenerate'}
                    </Button>
                  </>
                ) : (
                  <>
                    {expandedDirty ? (
                      <span className={styles.footerHint}>Save to apply, or discard.</span>
                    ) : null}
                    {expandedDirty ? (
                      <Button kind="quiet" size="md" onClick={discardAdvanced} disabled={busy}>
                        Discard
                      </Button>
                    ) : (
                      <Button kind="quiet" size="md" onClick={() => void requestClose()} disabled={!canClose}>
                        Close
                      </Button>
                    )}
                    <Button
                      kind="primary"
                      size="md"
                      onClick={() => void saveAdvanced()}
                      disabled={busy || !expandedDirty}
                    >
                      {savingAdvanced ? 'Saving…' : 'Save'}
                    </Button>
                  </>
                )
              ) : null}
            </div>
          </section>
        </div>
      </div>

      {confirmingDelete ? (
        <DeleteConfirmModal
          characterName={character.name}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void onConfirmDelete()}
        />
      ) : null}
      {resetConfirmOpen ? (
        <ResetMemoryConfirmModal
          characterName={character.name}
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={() => void doResetMemory()}
        />
      ) : null}
    </>
  );
}
