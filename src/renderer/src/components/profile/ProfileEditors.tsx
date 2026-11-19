/**
 * ProfileEditors (261119): the inline editors on your own companion's
 * profile tabs. The tabs are the edit surface; the old Edit companion popup
 * (its own sidebar of Basic / Appearance / Voice / Persona / Games / Danger)
 * repeated them and is gone (product call 261119).
 *
 *  - Voice tab:        VoiceEditor (the voice picker with Tune the voice, the
 *                      Fish Audio pick, and "Others will hear" for an own
 *                      ElevenLabs voice).
 *  - Personality tab:  AboutEditor (name + description) and PersonaEditor
 *                      (Standard: source + Regenerate; Advanced: the raw
 *                      prompt + Save).
 *  - Games tab:        ChessEditor (Auto / Custom, Elo, play style).
 *
 * Save model (the popup's rules, made inline):
 *  - Every editor holds its edits as a local draft and shows a save bar
 *    (Discard + Save, or Discard + Regenerate) only while the draft differs
 *    from what is stored. Nothing uploads while the player is still trying
 *    voices or typing. Validation is the popup's: a name cannot be empty,
 *    a Standard persona source cannot be empty.
 *  - Switching tabs keeps every draft (the page keeps all tabs mounted).
 *  - Leaving the page saves the Voice, Name and description, and Chess
 *    drafts, as the popup saved Voice and Basic when it closed. A persona
 *    draft is kept unsaved (Regenerate spends a generation, so it needs the
 *    player's press) and comes back with its save bar when the page reopens.
 *    See lib/profileEditDrafts.ts.
 *  - A field the player has not touched always shows the stored value, so a
 *    save made elsewhere (the publish step's "Others will hear") shows here.
 *
 * Analytics: the first change in an editor reports its row's edit action
 * (edit_voice, edit_about, edit_persona, edit_chess, the actions the popup's
 * openers reported) and a stored save reports save_voice / save_about /
 * save_persona / save_chess (profile_action_clicked).
 */
import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useCreditsStore } from '../../lib/stores/useCreditsStore';
import {
  aboutDiffers,
  aboutFromCharacter,
  aboutToSave,
  chessDiffers,
  chessFromCharacter,
  chessMetadataToSave,
  personaModeOf,
  voiceDiffers,
  voiceFromCharacter,
  voiceMetadataToSave,
  type AboutDraft,
  type ChessDraft,
  type PersonaMode,
  type VoiceDraft,
} from '../../lib/characterEdits';
import { editDraftEpoch, getEditDraft, setEditDraft, type DraftSection } from '../../lib/profileEditDrafts';
import type { ProfileAction } from '../../lib/profileRows';
import { localTtsModel } from '@shared/ttsEngine';
import type { Character } from '@shared/characterSchema';
import { Button } from '../Button';
import { PercentBar } from '../PercentBar';
import { TextField } from '../TextField';
import { VoicePicker } from '../VoicePicker';
import { FishVoiceOverride, type FishVoicePick } from '../FishVoiceOverride';
import { SharedVoiceChoice } from '../SharedVoiceChoice';
import { RowLabel } from './ProfileRow';
import styles from './ProfileEditors.module.css';

export interface EditorProps {
  character: Character;
  /** Reports an analytics action (the page adds the tab and companion kind). */
  onAction: (action: ProfileAction) => void;
  onTipOpen: (key: string) => void;
}

/** How long the "Saved" mark shows after a save. */
const SAVED_MS = 1500;

/** Re-read the character into the store after a save. */
async function refresh(id: string): Promise<void> {
  await useDataStore.getState().refreshCharacter(id);
}

/** The stored row, falling back to the page's copy (never save a stale copy over a newer one). */
async function latestOf(character: Character): Promise<Character> {
  return (await sei.getCharacter(character.id)) ?? character;
}

/**
 * Keeps a dirty draft past the editor unmounting (leaving the page), and
 * runs `save` on it when the section saves on leave. `pending()` returns the
 * dirty draft, or null when there is nothing unsaved.
 */
function useKeepOnLeave<D>(
  characterId: string,
  section: DraftSection,
  pending: () => D | null,
  save: ((draft: D) => Promise<boolean>) | null,
): void {
  const latest = useRef({ pending, save });
  latest.current = { pending, save };
  useEffect(() => {
    const epochAtMount = editDraftEpoch();
    return () => {
      // The account changed (lib/scopeReset.ts cleared the drafts): this
      // unmount is that change's own navigation, so nothing is written.
      if (editDraftEpoch() !== epochAtMount) return;
      const draft = latest.current.pending();
      setEditDraft(characterId, section, draft);
      const run = latest.current.save;
      if (draft === null || !run) return;
      void run(draft).then(
        (ok) => {
          if (ok && getEditDraft(characterId, section) === draft) setEditDraft(characterId, section, null);
        },
        () => {
          /* kept as a draft: it comes back unsaved next time */
        },
      );
    };
  }, [characterId, section]);
}

/** Reports `action` once per editing session (until the next save or discard). */
function useFirstEdit(onAction: (a: ProfileAction) => void, action: ProfileAction): { touch: () => void; reset: () => void } {
  const started = useRef(false);
  return {
    touch: () => {
      if (started.current) return;
      started.current = true;
      onAction(action);
    },
    reset: () => {
      started.current = false;
    },
  };
}

/** A brief "Saved" mark. */
function useSavedFlash(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return [
    shown,
    () => {
      setShown(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setShown(false), SAVED_MS);
    },
  ];
}

/** One editor on a tab: the row's label on the left, its fields and save bar in the value column (the row grid). */
function EditorBlock({
  rowId,
  label,
  tip,
  tipKey,
  onTipOpen,
  children,
  footer,
}: {
  rowId: string;
  label: string;
  tip?: string;
  tipKey?: string;
  onTipOpen: (key: string) => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  return (
    <section className={styles.block} data-row={rowId} data-editor="true" aria-labelledby={`editor-${rowId}-label`}>
      <div className={styles.labelCell}>
        <RowLabel id={`editor-${rowId}-label`} label={label} tip={tip} tipKey={tipKey} onTipOpen={onTipOpen} />
      </div>
      <div className={styles.body}>
        {children}
        {footer}
      </div>
    </section>
  );
}

/**
 * The save bar: shown only while there is something to save (or a save is
 * running), plus a brief Saved mark afterwards.
 */
function SaveBar({
  dirty,
  busy,
  saved,
  hint,
  onDiscard,
  onSave,
  saveLabel,
  busyLabel,
  saveKind = 'primary',
  saveDisabled,
}: {
  dirty: boolean;
  busy: boolean;
  saved: boolean;
  hint: string;
  onDiscard: () => void;
  onSave: () => void;
  saveLabel: string;
  busyLabel: string;
  saveKind?: 'primary' | 'accent';
  saveDisabled?: boolean;
}): React.ReactElement | null {
  const t = useT();
  if (!dirty && !busy) {
    return saved ? (
      <div className={styles.saveBar} role="status">
        <span className={styles.savedTag}>{t('Saved')}</span>
      </div>
    ) : null;
  }
  return (
    <div className={styles.saveBar} data-save-bar="true">
      <span className={styles.saveHint}>{hint}</span>
      <Button kind="quiet" size="sm" onClick={onDiscard} disabled={busy}>
        {t('Discard')}
      </Button>
      <Button kind={saveKind} size="sm" onClick={onSave} disabled={busy || saveDisabled}>
        {busy ? busyLabel : saveLabel}
      </Button>
    </div>
  );
}

// ── Voice ─────────────────────────────────────────────────────────────────

/** One voice save on top of the latest stored row (the popup's persistVoiceSettings). */
async function saveVoice(character: Character, draft: VoiceDraft): Promise<void> {
  const latest = await latestOf(character);
  const metadata = voiceMetadataToSave(character.id, latest.metadata, draft);
  await sei.saveCharacter({ ...latest, metadata }, { skipExpansion: true });
  await refresh(character.id);
}

export function VoiceEditor({ character, onAction, onTipOpen }: EditorProps): React.ReactElement {
  const t = useT();
  const saved = voiceFromCharacter(character);
  const [draft, setDraft] = useState<VoiceDraft | null>(() => getEditDraft<VoiceDraft>(character.id, 'voice'));
  const value = draft ?? saved;
  const dirty = draft !== null && voiceDiffers(draft, saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedShown, flashSaved] = useSavedFlash();
  const first = useFirstEdit(onAction, 'edit_voice');

  // Local voices (W5, 260817): BYOK with tts_engine 'local' hides the
  // ElevenLabs list and keeps the stored voiceId untouched underneath.
  // 261103: Fish Audio as the local voice, and this companion's own pick.
  const aiBackendKind = useCreditsStore((s) => s.ai_backend_kind);
  const [localTtsPref, setLocalTtsPref] = useState<boolean>(false);
  const [fishPref, setFishPref] = useState<boolean>(false);
  const [fishVoice, setFishVoice] = useState<FishVoicePick | null>(null);
  useEffect(() => {
    let live = true;
    void sei
      .getConfig()
      .then((c) => {
        if (!live) return;
        setLocalTtsPref(c.tts_engine === 'local');
        setFishPref(localTtsModel(c) === 'fish');
        const own = c.fish_voice_overrides?.[character.id];
        setFishVoice(own ? { id: own.id, name: own.name } : null);
      })
      .catch(() => {
        /* non-fatal: the full picker stays */
      });
    return () => {
      live = false;
    };
  }, [character.id]);
  const localTtsMode = aiBackendKind === 'local' && localTtsPref;
  const fishMode = localTtsMode && fishPref;

  // Functional, so two changes in one tick (a pick and its params) both land.
  const edit = (patch: Partial<VoiceDraft>): void => {
    first.touch();
    setDraft((cur) => ({ ...(cur ?? saved), ...patch }));
  };

  const persist = async (d: VoiceDraft): Promise<boolean> => {
    try {
      await saveVoice(character, d);
      onAction('save_voice');
      return true;
    } catch {
      return false;
    }
  };
  useKeepOnLeave(character.id, 'voice', () => (dirty ? draft : null), persist);

  const onSave = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await saveVoice(character, draft);
      onAction('save_voice');
      // Only the draft that was saved is cleared (a change made meanwhile stays).
      setDraft((cur) => (cur === draft ? null : cur));
      first.reset();
      flashSaved();
    } catch (err) {
      setError((err as Error)?.message ?? t('Failed to save voice settings.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorBlock
      rowId="voice"
      label={t('Voice')}
      onTipOpen={onTipOpen}
      footer={
        <SaveBar
          dirty={dirty}
          busy={saving}
          saved={savedShown}
          hint={t('Save to apply, or discard.')}
          onDiscard={() => {
            setDraft(null);
            setError(null);
            first.reset();
          }}
          onSave={() => void onSave()}
          saveLabel={t('Save')}
          busyLabel={t('Saving…')}
        />
      }
    >
      {localTtsMode ? (
        <p className={styles.hint}>
          {t(
            'Local voices are on: Sei picks a local voice that matches this companion. Tune the pitch here. Their ElevenLabs voice is kept for when you switch back.',
          )}
        </p>
      ) : null}
      <VoicePicker
        value={value.voiceId}
        valueOwn={value.voiceOwn}
        onChange={(voiceId, voiceOwn) => edit({ voiceId, voiceOwn })}
        params={value.params}
        onParamsChange={(params) => edit({ params })}
        localTtsMode={localTtsMode}
        previewCharacterId={character.id}
        pitchBypassed={fishMode && fishVoice !== null}
      />
      {fishMode ? <FishVoiceOverride characterId={character.id} value={fishVoice} onChange={setFishVoice} /> : null}
      {value.voiceOwn && value.voiceId && !localTtsMode ? (
        <div className={styles.sharedVoice}>
          <SharedVoiceChoice
            characterId={character.id}
            ownGender={value.voiceOwn.gender}
            value={value.voiceShared}
            onChange={(voiceShared) => edit({ voiceShared })}
            pitch={value.params.pitch ?? 1}
          />
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </EditorBlock>
  );
}

// ── Name and description ──────────────────────────────────────────────────

/** One name + description save (the popup's persistBasic). Throws 'empty_name' on an empty name. */
async function saveAbout(character: Character, draft: AboutDraft): Promise<void> {
  const fields = aboutToSave(draft);
  if (fields === 'empty_name') throw new Error('empty_name');
  const latest = await latestOf(character);
  await sei.saveCharacter({ ...latest, ...fields }, { skipExpansion: true });
  await refresh(character.id);
}

export function AboutEditor({
  character,
  onAction,
  onTipOpen,
  notice,
}: EditorProps & {
  /** Why the player was sent here (the publish step needs a description). */
  notice?: string | null;
}): React.ReactElement {
  const t = useT();
  const saved = aboutFromCharacter(character);
  const [draft, setDraft] = useState<AboutDraft | null>(() => getEditDraft<AboutDraft>(character.id, 'about'));
  const value = draft ?? saved;
  const dirty = draft !== null && aboutDiffers(draft, saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedShown, flashSaved] = useSavedFlash();
  const first = useFirstEdit(onAction, 'edit_about');

  // Functional, so two changes in one tick (a pick and its params) both land.
  const edit = (patch: Partial<AboutDraft>): void => {
    first.touch();
    setDraft((cur) => ({ ...(cur ?? saved), ...patch }));
  };

  const persist = async (d: AboutDraft): Promise<boolean> => {
    try {
      await saveAbout(character, d);
      onAction('save_about');
      return true;
    } catch {
      return false; // an empty name stays a draft
    }
  };
  useKeepOnLeave(character.id, 'about', () => (dirty ? draft : null), persist);

  const onSave = async (): Promise<void> => {
    if (!draft) return;
    if (aboutToSave(draft) === 'empty_name') {
      setError(t('Name cannot be empty.'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveAbout(character, draft);
      onAction('save_about');
      setDraft((cur) => (cur === draft ? null : cur));
      first.reset();
      flashSaved();
    } catch (err) {
      setError((err as Error)?.message ?? t('Failed to save.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorBlock
      rowId="about"
      label={t('Name and description')}
      onTipOpen={onTipOpen}
      footer={
        <SaveBar
          dirty={dirty}
          busy={saving}
          saved={savedShown}
          hint={t('Save to apply, or discard.')}
          onDiscard={() => {
            setDraft(null);
            setError(null);
            first.reset();
          }}
          onSave={() => void onSave()}
          saveLabel={t('Save')}
          busyLabel={t('Saving…')}
        />
      }
    >
      {notice ? <p className={styles.notice}>{notice}</p> : null}
      <div className={styles.field}>
        <span className={styles.label}>{t('Name')}</span>
        <TextField
          value={value.name}
          onChange={(name) => edit({ name })}
          disabled={saving}
          aria-label={t('Companion name')}
          aria-invalid={error !== null && value.name.trim() === ''}
        />
      </div>
      <div className={styles.field}>
        <span className={styles.label}>{t('Description')}</span>
        <p className={styles.hint}>{t('For you and other players')}</p>
        <TextField
          value={value.description}
          onChange={(description) => edit({ description })}
          multiline
          rows={3}
          disabled={saving}
          aria-label={t('Description')}
        />
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </EditorBlock>
  );
}

// ── Persona ───────────────────────────────────────────────────────────────

/** A persona draft kept past leaving the page (it is never applied on the way out). */
interface PersonaDraft {
  mode: PersonaMode;
  source: string | null;
  expanded: string | null;
}

/**
 * Persona, two modes (the popup's rules):
 *  - Standard: the persona SOURCE. A change shows Discard + Regenerate
 *    (re-runs the expander, counts against the persona-expansion limit).
 *  - Advanced: the raw prompt sent to the model, saved verbatim.
 *  Standard to Advanced is blocked while a Standard change is unapplied;
 *  Advanced to Standard with hand edits asks first, then regenerates from
 *  the source (discarding the edits), because Standard assumes
 *  expanded == expansion(source).
 */
export function PersonaEditor({ character, onAction, onTipOpen }: EditorProps): React.ReactElement {
  const t = useT();
  const [restored] = useState(() => getEditDraft<PersonaDraft>(character.id, 'persona'));
  const [mode, setMode] = useState<PersonaMode>(restored?.mode ?? personaModeOf(character));
  const [sourceDraft, setSourceDraft] = useState<string | null>(restored?.source ?? null);
  const [expandedDraft, setExpandedDraft] = useState<string | null>(restored?.expanded ?? null);
  const savedSource = character.persona.source ?? '';
  const savedExpanded = character.persona.expanded ?? '';
  const source = sourceDraft ?? savedSource;
  const expanded = expandedDraft ?? savedExpanded;
  const standardDirty = source !== savedSource;
  const expandedDirty = expanded !== savedExpanded;
  const dirty = mode === 'standard' ? standardDirty : expandedDirty;

  const [regenerating, setRegenerating] = useState(false);
  const [savingAdvanced, setSavingAdvanced] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expansion, setExpansion] = useState<{ pct: number; label: string } | null>(null);
  const [savedShown, flashSaved] = useSavedFlash();
  const activeRequestId = useRef<string | null>(null);
  const first = useFirstEdit(onAction, 'edit_persona');
  const busy = regenerating || savingAdvanced;

  useEffect(() => {
    const off = sei.onExpansionProgress?.((ev) => {
      if (ev.requestId !== activeRequestId.current) return;
      setExpansion({ pct: Math.round(ev.fraction * 100), label: ev.section });
    });
    return () => off?.();
  }, []);

  useKeepOnLeave<PersonaDraft>(
    character.id,
    'persona',
    () => (dirty ? { mode, source: sourceDraft, expanded: expandedDraft } : null),
    null,
  );

  /** Re-run the expander from the source and store it (one persona expansion). */
  const regenerate = async (): Promise<boolean> => {
    const trimmed = source.trim();
    if (!trimmed) {
      setError(t('Persona source cannot be empty.'));
      return false;
    }
    setRegenerating(true);
    setError(null);
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    setExpansion({ pct: 0, label: t('Starting') });
    try {
      const latest = await latestOf(character);
      await sei.saveCharacter(
        {
          ...latest,
          persona: { source: trimmed, expanded: '' },
          // Regenerating means the player is back on the standard framework.
          metadata: { ...(latest.metadata ?? {}), prompt_mode: 'standard' },
        },
        { skipExpansion: false, expansionRequestId: requestId },
      );
      await refresh(character.id);
      setSourceDraft(null);
      setExpandedDraft(null);
      onAction('save_persona');
      first.reset();
      flashSaved();
      return true;
    } catch (err) {
      setError((err as Error)?.message ?? t('Failed to regenerate.'));
      return false;
    } finally {
      setRegenerating(false);
      activeRequestId.current = null;
      setExpansion(null);
    }
  };

  /** Advanced: store the hand-edited raw prompt verbatim. */
  const saveAdvanced = async (): Promise<void> => {
    setSavingAdvanced(true);
    setError(null);
    try {
      const latest = await latestOf(character);
      await sei.saveCharacter(
        {
          ...latest,
          persona: { source: savedSource, expanded },
          // A hand-edited raw prompt means this companion is Advanced-managed now.
          metadata: { ...(latest.metadata ?? {}), prompt_mode: 'advanced' },
        },
        { skipExpansion: true },
      );
      await refresh(character.id);
      setExpandedDraft(null);
      onAction('save_persona');
      first.reset();
      flashSaved();
    } catch (err) {
      setError((err as Error)?.message ?? t('Failed to save.'));
    } finally {
      setSavingAdvanced(false);
    }
  };

  const goAdvanced = (): void => {
    if (standardDirty) return; // regenerate or discard first
    setMode('advanced');
  };

  const requestStandard = (): void => {
    if (mode === 'standard') return;
    if (expandedDirty) {
      setConfirmSwitch(true); // a regenerate would drop the hand edits: ask first
      return;
    }
    setMode('standard');
  };

  const confirmSwitchToStandard = async (): Promise<void> => {
    setConfirmSwitch(false);
    const ok = await regenerate();
    if (ok) setMode('standard');
  };

  const discard = (): void => {
    if (mode === 'standard') setSourceDraft(null);
    else setExpandedDraft(null);
    setError(null);
    first.reset();
  };

  const onCopyExpanded = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(expanded);
      setCopied(true);
      window.setTimeout(() => setCopied(false), SAVED_MS);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  return (
    <EditorBlock
      rowId="persona"
      label={t('Persona')}
      tip={t('The prompt that shapes how {name} talks and acts.', { name: character.name })}
      tipKey="persona"
      onTipOpen={onTipOpen}
      footer={
        mode === 'standard' ? (
          <SaveBar
            dirty={standardDirty}
            busy={regenerating}
            saved={savedShown}
            hint={t('Regenerate to apply, or discard.')}
            onDiscard={discard}
            onSave={() => void regenerate()}
            saveLabel={t('Regenerate')}
            busyLabel={t('Regenerating…')}
            saveKind="accent"
            saveDisabled={source.trim() === ''}
          />
        ) : (
          <SaveBar
            dirty={expandedDirty}
            busy={busy}
            saved={savedShown}
            hint={t('Save to apply, or discard.')}
            onDiscard={discard}
            onSave={() => void saveAdvanced()}
            saveLabel={t('Save')}
            busyLabel={regenerating ? t('Regenerating…') : t('Saving…')}
          />
        )
      }
    >
      <div className={styles.modeTabs} role="tablist" aria-label={t('Persona edit mode')}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'standard'}
          className={mode === 'standard' ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
          onClick={requestStandard}
          disabled={busy}
        >
          {t('Standard')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'advanced'}
          className={mode === 'advanced' ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
          onClick={goAdvanced}
          disabled={busy || standardDirty}
          title={standardDirty ? t('Regenerate or discard your changes first') : undefined}
        >
          {t('Advanced')}
        </button>
      </div>

      {confirmSwitch ? (
        <div className={styles.confirmBanner} role="alertdialog" aria-label={t('Switch to standard mode')}>
          <span className={styles.confirmText}>
            {t(
              'Switching to Standard regenerates the persona from your source, discarding your manual prompt edits. This uses one generation.',
            )}
          </span>
          <div className={styles.confirmActions}>
            <Button kind="quiet" size="sm" onClick={() => setConfirmSwitch(false)} disabled={busy}>
              {t('Keep editing')}
            </Button>
            <Button kind="accent" size="sm" onClick={() => void confirmSwitchToStandard()} disabled={busy}>
              {regenerating ? t('Regenerating…') : t('Regenerate & switch')}
            </Button>
          </div>
        </div>
      ) : null}

      {mode === 'standard' ? (
        <div className={styles.field}>
          <span className={styles.label}>{t('Persona source')}</span>
          <p className={styles.hint}>
            {t("A short description; the model expands it into the companion's voice and behavior.")}
          </p>
          <TextField
            value={source}
            onChange={(next) => {
              first.touch();
              setSourceDraft(next);
            }}
            multiline
            rows={5}
            disabled={busy}
            aria-label={t('Persona source')}
          />
        </div>
      ) : (
        <div className={styles.field}>
          <span className={styles.label}>{t('Raw prompt')}</span>
          <p className={styles.hint}>
            {t(
              'The exact prompt sent to the model each turn. Editing here overrides the standard framework (voice rules and all).',
            )}
          </p>
          <div className={styles.expandedBody}>
            <button type="button" className={styles.expandedCopy} onClick={() => void onCopyExpanded()}>
              {copied ? t('Copied') : t('Copy')}
            </button>
            <textarea
              className={styles.expandedTextarea}
              value={expanded}
              onChange={(e) => {
                first.touch();
                setExpandedDraft(e.target.value);
              }}
              spellCheck={false}
              disabled={busy}
              aria-label={t('Raw expanded prompt')}
            />
          </div>
        </div>
      )}

      {expansion ? (
        <div className={styles.field} aria-live="polite">
          <span className={styles.label}>
            {t('Expanding persona: {label} · {pct}%', { label: expansion.label, pct: expansion.pct })}
          </span>
          <PercentBar
            value={expansion.pct}
            size="sm"
            label={t('Expanding persona: {label}, {pct} percent', { label: expansion.label, pct: expansion.pct })}
          />
        </div>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </EditorBlock>
  );
}

// ── Chess ─────────────────────────────────────────────────────────────────

/** One chess save: write (or clear, for Auto) metadata.chess. */
async function saveChess(character: Character, draft: ChessDraft): Promise<void> {
  const latest = await latestOf(character);
  await sei.saveCharacter(
    { ...latest, metadata: chessMetadataToSave(latest.metadata, draft) },
    { skipExpansion: true },
  );
  await refresh(character.id);
}

export function ChessEditor({ character, onAction, onTipOpen }: EditorProps): React.ReactElement {
  const t = useT();
  const saved = chessFromCharacter(character);
  const [draft, setDraft] = useState<ChessDraft | null>(() => getEditDraft<ChessDraft>(character.id, 'chess'));
  const value = draft ?? saved;
  const dirty = draft !== null && chessDiffers(draft, saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedShown, flashSaved] = useSavedFlash();
  const first = useFirstEdit(onAction, 'edit_chess');

  // Functional, so two changes in one tick (a pick and its params) both land.
  const edit = (patch: Partial<ChessDraft>): void => {
    first.touch();
    setDraft((cur) => ({ ...(cur ?? saved), ...patch }));
  };

  const persist = async (d: ChessDraft): Promise<boolean> => {
    try {
      await saveChess(character, d);
      onAction('save_chess');
      return true;
    } catch {
      return false;
    }
  };
  useKeepOnLeave(character.id, 'chess', () => (dirty ? draft : null), persist);

  const onSave = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await saveChess(character, draft);
      onAction('save_chess');
      setDraft((cur) => (cur === draft ? null : cur));
      first.reset();
      flashSaved();
    } catch (err) {
      setError((err as Error)?.message ?? t('Failed to save.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorBlock
      rowId="chess"
      label={t('Chess')}
      tip={t('How {name} plays chess. On Auto, strength and style come from the persona.', { name: character.name })}
      tipKey="chess"
      onTipOpen={onTipOpen}
      footer={
        <SaveBar
          dirty={dirty}
          busy={saving}
          saved={savedShown}
          hint={t('Save to apply, or discard.')}
          onDiscard={() => {
            setDraft(null);
            setError(null);
            first.reset();
          }}
          onSave={() => void onSave()}
          saveLabel={t('Save')}
          busyLabel={t('Saving…')}
        />
      }
    >
      <div className={styles.modeTabs} role="radiogroup" aria-label={t('Chess profile mode')}>
        <button
          type="button"
          role="radio"
          aria-checked={!value.custom}
          className={!value.custom ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
          onClick={() => edit({ custom: false })}
          disabled={saving}
        >
          {t('Auto')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value.custom}
          className={value.custom ? `${styles.modeTab} ${styles.modeTabActive}` : styles.modeTab}
          onClick={() => edit({ custom: true })}
          disabled={saving}
        >
          {t('Custom')}
        </button>
      </div>
      {value.custom ? (
        <>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`chess-elo-${character.id}`}>
              {t('Strength: Elo {elo}', { elo: value.elo })}
            </label>
            <input
              id={`chess-elo-${character.id}`}
              className={styles.slider}
              type="range"
              min={400}
              max={2000}
              step={50}
              value={value.elo}
              disabled={saving}
              onChange={(e) => edit({ elo: Number(e.currentTarget.value) })}
            />
            <span className={styles.hint}>
              {t('400 barely knows the rules; 900 casual; 1400 club player; 2000 fierce.')}
            </span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>{t('Play style')}</span>
            <TextField
              value={value.style}
              onChange={(style) => edit({ style })}
              multiline
              rows={3}
              disabled={saving}
              placeholder={t('Aggressive, loves flashy sacrifices, sulks when losing...')}
              aria-label={t('Chess play style')}
            />
          </div>
        </>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </EditorBlock>
  );
}
