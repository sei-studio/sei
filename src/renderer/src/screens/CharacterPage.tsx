/**
 * CharacterPage — full-bleed character detail (the "Summoning Terminal").
 *
 * Layout (Party redesign §4.6): the portrait bleeds off the RIGHT edge behind a
 * left-to-right scrim; a left content panel carries a quiet back crumb, an
 * Oswald name + IdTag, the public/private share row (own chars),
 * the live status line, Description / Game tabs, and a bottom deploy row
 * (Play/Disconnect + a settings gear menu holding Reset memory and Unbind).
 * All prior functionality is preserved — persona /
 * description display + rotate, share toggle + multi-phase confirm, edit,
 * add/remove-from-library, report, cache-on-demand, reset memory, and the model
 * status row.
 *
 * Source: .planning/design/UI-REDESIGN-PARTY.md §4.6.
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { useChatStore } from '../lib/stores/useChatStore';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { Presence } from '../components/Presence';
import { ModalShell, ModalFooter } from '../components/ModalShell';
import { PixelPortrait } from '../components/PixelPortrait';
import { EditCharacterModal, type EditSection } from '../components/EditCharacterModal';
import { SignInModal } from '../components/SignInModal';
import { IdTag } from '../components/IdTag';
import { SkinEditor } from '../components/SkinEditor';
import { ResetMemoryConfirmModal } from '../components/ResetMemoryConfirmModal';
import { UnbindConfirmModal } from '../components/UnbindConfirmModal';
import { DeleteConfirmModal } from '../components/DeleteConfirmModal';
import { ReportCompanionModal } from '../components/ReportCompanionModal';
import { ProactivenessBar } from '../components/ProactivenessBar';
import { getProactiveness } from '../lib/proactiveness';
import { formatDate } from '../lib/formatDate';
import { BackIcon, GearIcon, RotateIcon } from '../components/icons';
import { pickPalette } from '../lib/portraitPalettes';
import { ERROR_COPY } from '../lib/errors';
import type { Character } from '@shared/characterSchema';
import type { BotStatus } from '@shared/ipc';
import styles from './CharacterPage.module.css';

// Stable "not summoned" fallback for the per-character status selector. A
// module const (not an inline literal) keeps the zustand selector referentially
// stable so an absent entry doesn't re-render the page on every store change.
const NOT_SUMMONED: BotStatus = { kind: 'idle', characterId: '' };

function fmtMs(ms: number): string {
  if (ms <= 0) return '-';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtUptime(uptimeMs: number): string {
  if (uptimeMs < 1000) return '0s';
  if (uptimeMs < 60_000) return `${Math.floor(uptimeMs / 1000)}s`;
  if (uptimeMs < 3_600_000) {
    const m = Math.floor(uptimeMs / 60_000);
    const s = Math.floor((uptimeMs % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(uptimeMs / 3_600_000);
  const m = Math.floor((uptimeMs % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

export interface CharacterPageProps {
  id: string;
}

type CharacterTab = 'description' | 'game';

/**
 * Wireframe shown while a not-yet-cached character downloads (or on the first
 * paint before the mount effect resolves). Mirrors the real page frame — a
 * portrait block bleeding off the right, name / chip / description / kv / deploy
 * bars on the left — static grey blocks (260705: no shimmer sweep), so the wait
 * reads as intentional instead of a blank flash. Keeps a working Back crumb so
 * the user is never stranded.
 */
function CharacterPageSkeleton({ onBack }: { onBack: () => void }): React.ReactElement {
  return (
    <div className={styles.root} aria-busy="true" aria-label="Loading companion">
      <div className={styles.portraitLayer} aria-hidden="true">
        <div className={styles.skelPortrait} />
        <div className={styles.dScrim} />
      </div>
      <main className={styles.content}>
        <div className={styles.crumb}>
          <Button kind="quiet" size="sm" icon={<BackIcon size={13} />} onClick={onBack}>
            Back
          </Button>
        </div>
        <div className={styles.skelTitle} aria-hidden="true" />
        <div className={styles.skelBlock} aria-hidden="true">
          <div className={styles.skelLine} />
          <div className={styles.skelLine} />
          <div className={`${styles.skelLine} ${styles.skelLineShort}`} />
        </div>
        <div className={styles.skelKv} aria-hidden="true">
          <div className={styles.skelKvRow} />
          <div className={styles.skelKvRow} />
          <div className={styles.skelKvRow} />
        </div>
        <div className={styles.skelDeploy} aria-hidden="true">
          <div className={styles.skelBtn} />
          <div className={styles.skelBtnSm} />
        </div>
      </main>
    </div>
  );
}

export function CharacterPage({ id }: CharacterPageProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const characters = useDataStore((s) => s.characters);
  // This page's character status only (multi-summon). All the downstream
  // checks (`summon.kind === 'online' && summon.characterId === id`, the
  // uptime line, isConnecting) now resolve per-character automatically.
  const summon = useDataStore((s) => s.summons[id] ?? NOT_SUMMONED);
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  const authState = useAuthStore((s) => s.state);
  const setUpgradeFraming = useAuthStore((s) => s.setUpgradeFraming);
  const setPendingShareIntent = useAuthStore((s) => s.setPendingShareIntent);
  const upgradeFraming = useAuthStore((s) => s.upgradeFraming);

  const character: Character | undefined = characters.find((c) => c.id === id);
  const [editing, setEditing] = useState<boolean>(false);
  const [editSection, setEditSection] = useState<EditSection>('basic');
  const [tab, setTab] = useState<CharacterTab>('description');
  const [preparing, setPreparing] = useState<boolean>(false);
  // Flips true once the cache-miss mount effect has concluded (downloaded, or
  // tried and still nothing). Distinguishes "still loading → skeleton" from
  // "genuinely not here → not-found text" so neither state flashes the other.
  const [resolved, setResolved] = useState<boolean>(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  // 260703 procgen: inline failure line for the Add-to-library CTA (e.g. the
  // main-process slot-limit backstop) — a silent no-op reads as a broken button.
  const [addError, setAddError] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState<boolean>(false);
  // 260706 — in-app report form (replaces the old mailto:dmca@sei.gg link).
  const [showReport, setShowReport] = useState<boolean>(false);
  const [shareError, setShareError] = useState<string | null>(null);
  // The publish/unpublish modal is multi-phase: the user confirms, then the
  // modal STAYS OPEN showing progress, then a success or error-with-reason
  // state (the reason is the message thrown by chars:set-shared, e.g. a
  // moderation rejection).
  const [sharePhase, setSharePhase] = useState<'confirm' | 'working' | 'success' | 'error'>(
    'confirm',
  );
  const [resetConfirmOpen, setResetConfirmOpen] = useState<boolean>(false);
  // Unbind = remove from library / delete. World-added chars unbind; owned
  // chars delete. Which confirm modal renders is chosen by isAddedFromWorld.
  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState<boolean>(false);
  // Settings (gear) popup in the deploy row — holds Reset memory + Unbind.
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);
  // Own-character details card defaults to the DESCRIPTION when one exists,
  // otherwise the persona source. The rotate toggle still switches between them.
  const [paneTab, setPaneTab] = useState<'persona' | 'description'>(
    () => ((character?.description ?? '').trim() !== '' ? 'description' : 'persona'),
  );
  const [shareConfirm, setShareConfirm] = useState<'going_public' | 'going_private' | null>(null);
  // Set when a publish attempt is blocked on a missing description: we open the
  // edit modal at Basic, and resume the publish once the modal closes with a
  // description present.
  const [needsDescription, setNeedsDescription] = useState<boolean>(false);

  // ── Exit animation (mirror of the enter slide) ────────────────────────────
  // The page enters with a slide (.content → detailIn) + portrait rise (.dPic →
  // picRise). To play the reverse on close we keep the page mounted briefly:
  // `leaving` swaps in the *Leaving classes (detailOut / picFall), then we
  // navigate home after the animation duration. EXIT_MS must match the CSS
  // (detailOut / picFall = 0.25s).
  const EXIT_MS = 250;
  const [leaving, setLeaving] = useState<boolean>(false);
  const leaveTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    },
    [],
  );
  const closePage = (): void => {
    if (leaving) return;
    setLeaving(true);
    // Phase 18/19: when this page was opened FROM a chat (the chat header's
    // Profile button set chatReturnId), the back crumb returns to that chat
    // instead of home. Decide the destination now, then clear the marker.
    const ui = useUiStore.getState();
    const returnToChat = ui.chatReturnId === id;
    if (returnToChat) ui.setChatReturnId(null);
    leaveTimer.current = window.setTimeout(
      () => navigate(returnToChat ? { kind: 'chat', characterId: id } : { kind: 'home' }),
      EXIT_MS,
    );
  };

  // ── Live uptime ticker (hoisted above the early-return for stable hook count) ──
  // The supervisor emits the 'online' status ONCE; there is no periodic re-emit,
  // so without a local clock the status line would sit frozen at "0s" for the
  // whole session. We derive a live uptime from the session's absolute
  // startedAtMs (Date.now() - startedAtMs) and re-render every second so
  // "Connected · Xs" counts up — correct even if the page is opened mid-session.
  const onlineForThisChar = summon.kind === 'online' && summon.characterId === id;
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!onlineForThisChar) return;
    setNowMs(Date.now());
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [onlineForThisChar]);

  // ── Library-state hooks (hoisted above the early-return for stable count) ──
  const addedDefaultIds = useLibraryStateStore((s) => s.addedDefaultIds);
  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const refreshLibraryState = useLibraryStateStore((s) => s.refresh);

  // T-04-37 + Phase 11 plan 19: rehydrate / cache-on-demand on mount.
  useEffect(() => {
    if (character) return;
    let cancelled = false;
    // Fresh attempt for this id — clear any prior error/resolved so a re-nav to
    // a different missing character shows the skeleton, not a stale not-found.
    setPrepareError(null);
    setResolved(false);
    void (async () => {
      try {
        await refreshCharacter(id);
      } catch {
        // ignore — fall through to charsOpenPrepare
      }
      if (cancelled) return;
      const stillMissing = !useDataStore.getState().characters.some((c) => c.id === id);
      if (!stillMissing) return;
      setPreparing(true);
      try {
        await sei.charsOpenPrepare(id);
        if (cancelled) return;
        await refreshCharacter(id);
      } catch (err) {
        if (cancelled) return;
        setPrepareError((err as Error).message);
      } finally {
        if (!cancelled) {
          setPreparing(false);
          setResolved(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, character, refreshCharacter]);

  // Background "check for updates" on open. The rehydrate effect above only
  // downloads when the character is MISSING locally; an already-cached foreign
  // or default character would otherwise never re-check the cloud. This runs
  // once per id: it asks main to refresh the local cache from cloud (no-op for
  // characters the user authors) and, if anything changed, pulls the new
  // prompt / image / description into the store. Silent — no preparing spinner,
  // so a stale cloud round-trip never blanks the page; the cached copy shows
  // immediately and updates in place. Memory is untouched by the main-side refresh.
  const updateCheckedRef = useRef<string | null>(null);
  useEffect(() => {
    if (updateCheckedRef.current === id) return;
    updateCheckedRef.current = id;
    const present = useDataStore.getState().characters.some((c) => c.id === id);
    if (!present) return; // cache-miss download is handled by the effect above
    let cancelled = false;
    void (async () => {
      try {
        await sei.charsOpenPrepare(id);
        if (cancelled) return;
        await refreshCharacter(id);
      } catch {
        // offline / transient — keep showing the cached copy
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, refreshCharacter]);

  // Default the details card to the description when one exists (re-evaluated
  // per character — navigation reuses this component, so the useState
  // initializer alone wouldn't update on an id change or a late load).
  useEffect(() => {
    setPaneTab((character?.description ?? '').trim() !== '' ? 'description' : 'persona');
  }, [character?.id]);

  if (!character) {
    // A download error, or a concluded attempt that turned up nothing → the
    // actionable text surface with a way home. Otherwise (first paint or a
    // download in flight) → a wireframe skeleton so the wait reads as
    // intentional instead of a blank flash or a bare "Downloading…" line.
    if (prepareError || (resolved && !preparing)) {
      return (
        <div className={styles.notFound}>
          <p>
            {prepareError
              ? "Couldn't load this companion. You may be offline, or the companion may have been deleted."
              : 'Companion not found.'}
          </p>
          <Button kind="primary" size="md" onClick={() => navigate({ kind: 'home' })}>
            Back to home
          </Button>
        </div>
      );
    }
    return <CharacterPageSkeleton onBack={() => navigate({ kind: 'home' })} />;
  }

  const isDefault = character.is_default;
  // 260703 procgen: defaults are opt-in on Home — a default NOT in
  // added_default_ids shows "Add to library" instead of the Play CTA.
  const isRemovedDefault = isDefault && !addedDefaultIds.has(character.id);
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  // A character with a cloud owner that isn't the current user is foreign /
  // view-only. This now holds for SIGNED-OUT users too (currentUserId === null):
  // a local user opening a World character must view it read-only, not see edit
  // controls and the publish toggle (item 5). Legacy null-owner local chars
  // stay editable for everyone.
  const isForeignOwned = !isDefault && !!character.owner && character.owner !== currentUserId;
  // 260703 procgen (spec item 5): only user-created ('custom') characters are
  // editable. System-generated 'unique' companions — even ones the user owns —
  // are NOT editable (remove / reset-memory only), exactly like foreign-owned
  // World characters. `kind` defaults to 'custom', so every pre-existing
  // character stays editable. This folds into the existing viewOnly guard so
  // all the edit surfaces hide behind one predicate.
  const isNonEditableKind = character.kind !== 'custom';
  const viewOnly = isDefault || isForeignOwned || isNonEditableKind;
  const isWorldPreview = isForeignOwned && !addedWorldIds.has(character.id);
  const isAddedFromWorld = isForeignOwned && addedWorldIds.has(character.id);
  // World-preview / removed-default entries aren't in the library yet — no
  // memory to reset and nothing to release.
  const isPreview = isWorldPreview || isRemovedDefault;
  const themeAttr = document.documentElement.getAttribute('data-theme');
  const theme: 'light' | 'dark' = themeAttr === 'dark' ? 'dark' : 'light';
  const palette = pickPalette(character.id + character.name, theme);
  // Per-character accent tint for the portrait bloom.
  const tint = palette[2] ?? palette[1] ?? 'var(--accent)';

  const isActive = summon.kind === 'online' && summon.characterId === id;
  const isErrored = summon.kind === 'error' && summon.characterId === id;
  const isConnecting = summon.kind === 'connecting';

  const openEdit = (section: EditSection): void => {
    setEditSection(section);
    setEditing(true);
  };

  const handleSummonClick = (): void => {
    // Connected OR still connecting → this button is "Disconnect": clear the
    // entry optimistically (instant, like the floating widget) then stop.
    if (isActive || isConnecting) {
      useDataStore.getState().setStatus({ kind: 'idle', characterId: id });
      void sei.stop(id);
      return;
    }
    // "Play" opens the game picker; each game tile launches through the shared
    // summonFlow (skin-setup nudge → LAN gate). Keeps CharacterPage and
    // CharactersScreen in lockstep on the same entry point.
    openModal({ kind: 'games-picker', characterId: id });
  };

  const onToggleShared = (): void => {
    if (!character) return;
    if (character.is_default) return; // D-22 belt-and-suspenders
    setShareError(null);
    setSharePhase('confirm');
    if (authState.kind !== 'signed_in') {
      setUpgradeFraming('share this companion');
      setPendingShareIntent({ characterId: character.id, createdAt: Date.now() });
      setShowSignIn(true);
      return;
    }
    if (!character.shared) {
      const hasDescription = (character.description ?? '').trim().length > 0;
      if (!hasDescription) {
        // Description is edited in the modal now — open it at Basic and resume
        // the publish when the modal closes with a description present.
        setNeedsDescription(true);
        setEditSection('basic');
        setEditing(true);
        return;
      }
      setShareConfirm('going_public');
      return;
    }
    setShareConfirm('going_private');
  };

  const onConfirmShareToggle = async (): Promise<void> => {
    if (!character || !shareConfirm) return;
    const target = shareConfirm === 'going_public';
    // Keep the modal open and switch it into its progress state — the user
    // watches it work and sees the outcome in place.
    setSharePhase('working');
    setShareError(null);
    try {
      await sei.charsSetShared({ id: character.id, shared: target });
      await refreshCharacter(character.id);
      setSharePhase('success');
    } catch (err) {
      // err.message carries the real reason (e.g. the moderation friendly
      // message) — surface it verbatim instead of a generic retry string.
      setShareError((err as Error).message);
      setSharePhase('error');
    }
  };

  const closeShareModal = (): void => {
    setShareConfirm(null);
    setSharePhase('confirm');
    setShareError(null);
  };

  /**
   * Modal close handler. If a publish attempt was blocked on a missing
   * description, resume it once the modal closes with a description present
   * (read the freshest character from the store — the modal refreshed it).
   */
  const onEditClose = (): void => {
    setEditing(false);
    if (!needsDescription) return;
    setNeedsDescription(false);
    const latest = useDataStore.getState().characters.find((c) => c.id === id);
    if (latest && (latest.description ?? '').trim() !== '') {
      setSharePhase('confirm');
      setShareConfirm('going_public');
    }
  };

  // Reset memory opens a confirmation popup (reset is irreversible and does NOT
  // touch in-game inventory/location — the modal copy says so).
  const onResetMemoryClick = (): void => {
    setResetConfirmOpen(true);
  };

  const doResetMemory = async (): Promise<void> => {
    setResetConfirmOpen(false);
    if (!character) return;
    try {
      await sei.resetMemory(character.id);
      // Reset deletes the chat transcript too — drop the renderer's cached
      // messages/preview so an open chat doesn't keep showing erased history.
      await useChatStore.getState().clear(character.id);
      await refreshCharacter(character.id);
    } catch (err) {
      console.error('[CharacterPage] resetMemory failed', err);
    }
  };

  // Release runs after the confirm modal is accepted. World-added chars unbind
  // (drop from the library); owned chars delete permanently. Defaults in a Home
  // slot delete + refresh library state (restorable from the World tab).
  const doRelease = async (): Promise<void> => {
    setReleaseConfirmOpen(false);
    if (!character) return;
    try {
      if (isAddedFromWorld) {
        await sei.charsRemoveFromLibrary(character.id);
        useDataStore.getState().removeCharacter(character.id);
        await refreshLibraryState();
      } else {
        await sei.deleteCharacter(character.id);
        if (character.is_default) {
          await refreshLibraryState();
        } else {
          useDataStore.getState().removeCharacter(character.id);
        }
      }
      navigate({ kind: 'home' });
    } catch (err) {
      console.error('[CharacterPage] release failed', err);
    }
  };

  const onAddToLibraryClick = async (): Promise<void> => {
    if (!character) return;
    // Adding a World (foreign) character to your library needs an account —
    // it writes to the user's cloud library. Prompt sign-in with the same
    // modal the share flow uses (item 5). Re-adding a bundled default is
    // local-only and needs no account, so it falls through.
    if (isWorldPreview && authState.kind !== 'signed_in') {
      setUpgradeFraming('invite this companion to your party');
      setShowSignIn(true);
      return;
    }
    setAddError(null);
    try {
      if (character.is_default) {
        await sei.charsRestoreDefault(character.id);
      } else if (isWorldPreview) {
        await sei.charsAddToLibrary(character.id);
      } else {
        return;
      }
      await refreshLibraryState();
    } catch (err) {
      console.error('[CharacterPage] add to library failed', err);
      // Surface the failure (e.g. the slot-limit backstop) instead of a
      // silent no-op — the handler messages are already user-readable.
      setAddError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't add this companion. Please try again.",
      );
    }
  };

  // GUI-05: status label uses centralized ERROR_COPY, not raw summon.message.
  // Live-ticked uptime from the session start, so the label counts up instead
  // of sticking at the emit-time "0s".
  const liveUptimeMs = summon.kind === 'online' ? Math.max(0, nowMs - summon.startedAtMs) : 0;
  const errorLabel =
    summon.kind === 'error' && summon.characterId === id
      ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH)
      : '';
  // The resting/idle status is intentionally not shown — the status line only
  // appears when there's a live state to report (online / connecting / errored).
  const showStatusRow = isActive || isConnecting || isErrored;

  return (
    <div className={styles.root}>
      {/* Portrait bleeds off the right edge behind a left-to-right scrim. */}
      <div className={styles.portraitLayer} aria-hidden="true">
        <div
          className={styles.portraitTint}
          style={{ background: `radial-gradient(70% 90% at 70% 30%, ${tint}4d, transparent 66%)` }}
        />
        <PixelPortrait
          seed={character.id + character.name}
          palette={palette}
          size={520}
          portraitImage={character.portrait_image}
          className={`${styles.dPic} ${leaving ? styles.dPicLeaving : ''}`}
          style={{ width: '100%', height: '100%' }}
        />
        <div className={styles.dScrim} />
      </div>

      <main className={`${styles.content} ${leaving ? styles.contentLeaving : ''}`}>
        <div className={styles.crumb}>
          <Button kind="quiet" size="sm" icon={<BackIcon size={13} />} onClick={closePage}>
            Back
          </Button>
        </div>

        <div className={styles.titleRow}>
          <h1 className={styles.title}>{character.name}</h1>
          {character.public_id ? <IdTag id={character.public_id} size="md" /> : null}
          {isForeignOwned ? (
            <button
              type="button"
              className={styles.reportLink}
              onClick={() => setShowReport(true)}
              aria-label={`Report ${character.name}`}
            >
              Report
            </button>
          ) : null}
        </div>

        {/* Public/private share row (own chars only) — Toggle + label. */}
        {!viewOnly ? (
          <div className={styles.shareRow}>
            <Toggle
              on={character.shared}
              onChange={() => onToggleShared()}
              disabled={shareConfirm !== null || (authState.kind !== 'signed_in' && character.shared)}
              aria-label={
                character.shared
                  ? 'Companion is public. Turn off to make private.'
                  : 'Companion is private. Turn on to make public.'
              }
            />
            <span className={styles.shareLabel}>
              {character.shared ? 'Public: others can invite' : 'Private'}
            </span>
          </div>
        ) : null}

        {/* Live status line (online / connecting / errored). */}
        {showStatusRow ? (
          <div className={styles.statusRow}>
            {isErrored ? (
              <>
                <span className={styles.errDot} />
                <span className={styles.statusLabel}>{errorLabel}</span>
                <button type="button" className={styles.tryAgain} onClick={handleSummonClick}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <Presence
                  category={isConnecting ? 'connecting' : 'in-game'}
                  label={isConnecting ? 'Connecting…' : 'In your world'}
                />
                {isActive ? <span className={styles.uptime}>{fmtUptime(liveUptimeMs)}</span> : null}
              </>
            )}
          </div>
        ) : null}

        {/* Tabs (mockup .pf-tab underline). */}
        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'description'}
            className={tab === 'description' ? styles.tabActive : styles.tab}
            onClick={() => setTab('description')}
          >
            Description
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'game'}
            className={tab === 'game' ? styles.tabActive : styles.tab}
            onClick={() => setTab('game')}
          >
            Game
          </button>
        </div>

        {tab === 'description' ? (
          <div className={styles.pane}>
            {viewOnly ? (
              // Non-editable chars (system-generated uniques, World invites,
              // defaults) get the same boxed description card as customs
              // (260705: recovered from the dev-branch layout; a bare italic
              // quote read as unstyled).
              <div className={styles.persona}>
                <div className={styles.personaHead}>
                  <span className="u-lbl">Description</span>
                </div>
                <div className={styles.personaBody}>
                  {character.description?.trim() ||
                    character.persona.source?.trim() ||
                    'No description provided.'}
                </div>
              </div>
            ) : (
              <div className={styles.personaBlock}>
                <div className={styles.persona}>
                  <div className={styles.personaHead}>
                    <span className="u-lbl">
                      {paneTab === 'persona' ? 'Persona' : 'Description'}
                    </span>
                    <button
                      type="button"
                      className={styles.rotateBtn}
                      onClick={() =>
                        setPaneTab(paneTab === 'persona' ? 'description' : 'persona')
                      }
                      aria-label={
                        paneTab === 'persona' ? 'Switch to description' : 'Switch to persona'
                      }
                    >
                      <RotateIcon size={13} />
                    </button>
                  </div>
                  <div className={styles.personaBody}>
                    {paneTab === 'persona'
                      ? character.persona.source || '–'
                      : character.description?.trim() || 'No description yet.'}
                  </div>
                </div>
                <Button
                  kind="ghost"
                  size="sm"
                  onClick={() => openEdit(paneTab === 'persona' ? 'persona' : 'basic')}
                >
                  Edit
                </Button>
              </div>
            )}

            {/* Boxed stat cells (260705: recovered from the dev-branch layout,
                which framed these as cards instead of hairline kv rows). */}
            <div className={styles.stats}>
              <div className={styles.stat}>
                <div className={`u-lbl ${styles.statEyebrow}`}>Bonded</div>
                <div className={styles.statValue}>{formatDate(character.created)}</div>
              </div>
              <div className={styles.stat}>
                <div className={`u-lbl ${styles.statEyebrow}`}>Played</div>
                <div className={styles.statValue}>{fmtMs(character.playtime_ms)}</div>
              </div>
              <div className={styles.stat}>
                <div className={`u-lbl ${styles.statEyebrow}`}>Last launch</div>
                <div className={styles.statValue}>{formatDate(character.last_launched)}</div>
              </div>
              {/* Reset memory moved into the deploy row's settings (gear) menu. */}
            </div>
          </div>
        ) : (
          <div className={styles.pane}>
            <SkinEditor
              character={character}
              onChanged={() => void refreshCharacter(id)}
              viewOnly
              compact
              previewCaption="This is how they appear in your world."
              onEditSkin={viewOnly ? undefined : () => openEdit('appearance')}
            />
            <div className={styles.proactRow}>
              <span className="u-lbl">Proactiveness</span>
              <ProactivenessBar level={getProactiveness(character)} size="md" showLabel block />
            </div>
          </div>
        )}

        {/* Deploy row — Play / Disconnect + settings gear, pinned to the bottom. */}
        {addError ? (
          <p className={styles.addError} role="alert">
            {addError}
          </p>
        ) : null}
        <div className={styles.deploy}>
          {isPreview ? (
            <Button
              kind="accent"
              size="lg"
              className={styles.deployBig}
              onClick={() => {
                void onAddToLibraryClick();
              }}
            >
              Invite to party
            </Button>
          ) : (
            <>
              <Button
                kind={isActive ? 'danger' : 'accent'}
                size="lg"
                className={styles.deployBig}
                disabled={isConnecting}
                onClick={handleSummonClick}
              >
                {isActive ? 'Disconnect' : isConnecting ? 'Connecting…' : 'Play'}
              </Button>
              <div className={styles.settingsWrap} ref={settingsRef}>
                <Button
                  kind="ghost"
                  size="lg"
                  aria-haspopup="menu"
                  aria-expanded={settingsOpen}
                  aria-label="Companion settings"
                  onClick={() => setSettingsOpen((o) => !o)}
                >
                  <GearIcon size={18} />
                </Button>
                {settingsOpen ? (
                  <div className={styles.settingsMenu} role="menu" aria-label="Companion settings">
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.settingsItem}
                      onClick={() => {
                        setSettingsOpen(false);
                        onResetMemoryClick();
                      }}
                    >
                      Reset memory
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={`${styles.settingsItem} ${styles.settingsItemDanger}`}
                      onClick={() => {
                        setSettingsOpen(false);
                        setReleaseConfirmOpen(true);
                      }}
                    >
                      Unbind
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </main>

      {editing ? (
        <EditCharacterModal
          character={character}
          initialSection={editSection}
          onClose={onEditClose}
        />
      ) : null}
      {resetConfirmOpen ? (
        <ResetMemoryConfirmModal
          characterName={character.name}
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={() => {
            void doResetMemory();
          }}
        />
      ) : null}
      {releaseConfirmOpen ? (
        isAddedFromWorld ? (
          <UnbindConfirmModal
            characterName={character.name}
            onCancel={() => setReleaseConfirmOpen(false)}
            onConfirm={() => {
              void doRelease();
            }}
          />
        ) : (
          <DeleteConfirmModal
            characterName={character.name}
            onCancel={() => setReleaseConfirmOpen(false)}
            onConfirm={() => {
              void doRelease();
            }}
          />
        )
      ) : null}
      {showReport ? (
        <ReportCompanionModal
          characterName={character.name}
          characterPublicId={character.public_id ?? undefined}
          onClose={() => setShowReport(false)}
        />
      ) : null}
      {showSignIn ? (
        <SignInModal
          framingLabel={upgradeFraming}
          onClose={() => {
            setShowSignIn(false);
            if (useAuthStore.getState().state.kind !== 'signed_in') {
              setPendingShareIntent(null);
            }
          }}
        />
      ) : null}
      {shareConfirm ? (
        <ModalShell
          title={null}
          width={420}
          escClose={sharePhase !== 'working'}
          scrimClose={sharePhase !== 'working'}
          onClose={closeShareModal}
          aria-label="Sharing"
        >
          {sharePhase === 'working' ? (
            <>
              <h3 className={styles.confirmTitle}>
                {shareConfirm === 'going_public' ? 'Publishing…' : 'Updating…'}
              </h3>
              <p className={styles.confirmBody}>
                {shareConfirm === 'going_public'
                  ? 'Uploading your companion and checking it against our content guidelines.'
                  : 'Making your companion private.'}
              </p>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label={shareConfirm === 'going_public' ? 'Publishing' : 'Updating'}
              >
                <div className={styles.progressIndeterminate} />
              </div>
            </>
          ) : sharePhase === 'success' ? (
            <>
              <h3 className={`${styles.confirmTitle} ${styles.confirmTitleOk}`}>
                {shareConfirm === 'going_public'
                  ? 'Your companion is now public'
                  : 'Your companion is now private'}
              </h3>
              <p className={styles.confirmBody}>
                {shareConfirm === 'going_public'
                  ? 'Other players can find and invite it from the World tab.'
                  : 'It is no longer visible in the World tab.'}
              </p>
              <ModalFooter>
                <Button kind="primary" size="md" onClick={closeShareModal}>
                  Done
                </Button>
              </ModalFooter>
            </>
          ) : sharePhase === 'error' ? (
            <>
              <h3 className={`${styles.confirmTitle} ${styles.confirmTitleError}`}>
                {shareConfirm === 'going_public' ? "Couldn't publish" : "Couldn't update sharing"}
              </h3>
              <p className={`${styles.confirmBody} ${styles.confirmErrorBody}`} role="alert">
                {shareError ?? 'Something went wrong. Please try again.'}
              </p>
              <ModalFooter>
                <Button kind="quiet" size="md" onClick={closeShareModal}>
                  Close
                </Button>
                <Button
                  kind={shareConfirm === 'going_public' ? 'accent' : 'primary'}
                  size="md"
                  onClick={() => {
                    void onConfirmShareToggle();
                  }}
                >
                  Try again
                </Button>
              </ModalFooter>
            </>
          ) : (
            <>
              <h3 className={styles.confirmTitle}>
                {shareConfirm === 'going_public'
                  ? 'Allow other players to invite your companion?'
                  : 'Make this companion private?'}
              </h3>
              <p className={styles.confirmBody}>
                {shareConfirm === 'going_public'
                  ? 'Companion memory will not be shared.'
                  : 'Other players will no longer be able to invite your companion. Are you sure?'}
              </p>
              <ModalFooter>
                <Button kind="quiet" size="md" onClick={closeShareModal}>
                  Cancel
                </Button>
                <Button
                  kind={shareConfirm === 'going_public' ? 'accent' : 'primary'}
                  size="md"
                  onClick={() => {
                    void onConfirmShareToggle();
                  }}
                >
                  {shareConfirm === 'going_public' ? 'Make public' : 'Make private'}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalShell>
      ) : null}
    </div>
  );
}
