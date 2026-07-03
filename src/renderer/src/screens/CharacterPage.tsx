/**
 * CharacterPage — full-bleed character detail (the "Summoning Terminal").
 *
 * Layout (mockup ui.jsx CharacterDetail): the portrait bleeds off the RIGHT
 * edge behind a left-to-right scrim; a left content panel carries the back
 * crumb, an Oswald name, the live status line, the public/private toggle,
 * Details/Skin tabs, the persona/description card + stats, and a bottom deploy
 * bar (Summon CTA + gear). All prior functionality is preserved verbatim —
 * inline name + description editors, share toggle + confirm, gear menu,
 * add/remove-from-library, report, cache-on-demand, and the model status row.
 *
 * Source: .planning/UI-DESIGN-SYSTEM.md §Screens → Character detail;
 *         04-UI-SPEC.md §CharacterPage; D-49..D-53; quick task 260508-mun.
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { attemptSummon } from '../lib/summonFlow';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { Button } from '../components/Button';
import { PixelPortrait } from '../components/PixelPortrait';
import { EditCharacterModal, type EditSection } from '../components/EditCharacterModal';
import { SignInModal } from '../components/SignInModal';
import { SkinEditor } from '../components/SkinEditor';
import { ResetMemoryConfirmModal } from '../components/ResetMemoryConfirmModal';
import { ProactivenessBar } from '../components/ProactivenessBar';
import { getProactiveness } from '../lib/proactiveness';
import { BackIcon, GearIcon, RotateIcon, SparkleIcon } from '../components/icons';
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

function fmtDate(iso: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '-';
  }
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

type CharacterTab = 'details' | 'skin';

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
  const [tab, setTab] = useState<CharacterTab>('details');
  const [preparing, setPreparing] = useState<boolean>(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState<boolean>(false);
  const [shareError, setShareError] = useState<string | null>(null);
  // The publish/unpublish modal is multi-phase: the user confirms, then the
  // modal STAYS OPEN showing progress, then a success or error-with-reason
  // state (the reason is the message thrown by chars:set-shared, e.g. a
  // moderation rejection).
  const [sharePhase, setSharePhase] = useState<'confirm' | 'working' | 'success' | 'error'>(
    'confirm',
  );
  const [gearMenuOpen, setGearMenuOpen] = useState<boolean>(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState<boolean>(false);
  const gearWrapRef = useRef<HTMLDivElement | null>(null);
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
  // "Online · Xs" counts up — correct even if the page is opened mid-session.
  const onlineForThisChar = summon.kind === 'online' && summon.characterId === id;
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!onlineForThisChar) return;
    setNowMs(Date.now());
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [onlineForThisChar]);

  // ── Library-state hooks (hoisted above the early-return for stable count) ──
  const removedDefaultIds = useLibraryStateStore((s) => s.removedDefaultIds);
  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const refreshLibraryState = useLibraryStateStore((s) => s.refresh);

  useEffect(() => {
    if (!gearMenuOpen) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      const node = gearWrapRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setGearMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [gearMenuOpen]);

  // T-04-37 + Phase 11 plan 19: rehydrate / cache-on-demand on mount.
  useEffect(() => {
    if (character) return;
    let cancelled = false;
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
        if (!cancelled) setPreparing(false);
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
    if (preparing) {
      return (
        <div className={styles.notFound}>
          <p>Downloading companion from cloud…</p>
        </div>
      );
    }
    return (
      <div className={styles.notFound}>
        <p>
          {prepareError
            ? "Couldn't load this companion. You may be offline, or the companion may have been deleted."
            : 'Companion not found.'}
        </p>
        <Button kind="primary" size="md" onClick={() => navigate({ kind: 'home' })}>
          Back to Home
        </Button>
      </div>
    );
  }

  const isDefault = character.is_default;
  const isRemovedDefault = isDefault && removedDefaultIds.has(character.id);
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  // A character with a cloud owner that isn't the current user is foreign /
  // view-only. This now holds for SIGNED-OUT users too (currentUserId === null):
  // a local user opening a World character must view it read-only, not see edit
  // controls and the publish toggle (item 5). Legacy null-owner local chars
  // stay editable for everyone.
  const isForeignOwned =
    !isDefault &&
    !!character.owner &&
    character.owner !== currentUserId;
  const viewOnly = isDefault || isForeignOwned;
  const isWorldPreview = isForeignOwned && !addedWorldIds.has(character.id);
  const isAddedFromWorld = isForeignOwned && addedWorldIds.has(character.id);
  const themeAttr = document.documentElement.getAttribute('data-theme');
  const theme: 'light' | 'dark' = themeAttr === 'dark' ? 'dark' : 'light';
  const palette = pickPalette(character.id + character.name, theme);
  // Per-character accent tint for the portrait bloom (mockup d-bg radial).
  const tint = palette[2] ?? palette[1] ?? 'var(--accent)';

  const isActive = summon.kind === 'online' && summon.characterId === id;
  const isErrored = summon.kind === 'error' && summon.characterId === id;
  const isConnecting = summon.kind === 'connecting';

  const handleSummonClick = (): void => {
    // Connected OR still connecting → this button is "Disconnect": clear the
    // entry optimistically (instant, like the floating widget) then stop.
    if (isActive || isConnecting) {
      useDataStore.getState().setStatus({ kind: 'idle', characterId: id });
      void sei.stop(id);
      return;
    }
    // "Play together" opens the game picker; each game tile launches through
    // the shared summonFlow (skin-setup nudge → LAN gate). Keeps CharacterPage
    // and CharactersScreen in lockstep on the same entry point.
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

  const onGearClick = (): void => {
    if (!viewOnly) {
      setEditSection('basic');
      setEditing(true);
      return;
    }
    setGearMenuOpen((v) => !v);
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

  // Gear → "Reset memory" opens a confirmation popup (reset is irreversible and
  // does NOT touch in-game inventory/location — the modal copy says so).
  const onResetMemoryClick = (): void => {
    setGearMenuOpen(false);
    setResetConfirmOpen(true);
  };

  const doResetMemory = async (): Promise<void> => {
    setResetConfirmOpen(false);
    if (!character) return;
    try {
      await sei.resetMemory(character.id);
      await refreshCharacter(character.id);
    } catch (err) {
      console.error('[CharacterPage] resetMemory failed', err);
    }
  };

  const onRemoveFromLibraryClick = async (): Promise<void> => {
    setGearMenuOpen(false);
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
      console.error('[CharacterPage] deleteCharacter failed', err);
    }
  };

  const onAddToLibraryClick = async (): Promise<void> => {
    if (!character) return;
    // Adding a World (foreign) character to your library needs an account —
    // it writes to the user's cloud library. Prompt sign-in with the same
    // modal the share flow uses (item 5). Re-adding a bundled default is
    // local-only and needs no account, so it falls through.
    if (isWorldPreview && authState.kind !== 'signed_in') {
      setUpgradeFraming('add this companion to your library');
      setShowSignIn(true);
      return;
    }
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
    }
  };

  // GUI-05: status label uses centralized ERROR_COPY, not raw summon.message.
  // Live-ticked uptime from the session start, so the label counts up instead
  // of sticking at the emit-time "0s".
  const liveUptimeMs = summon.kind === 'online' ? Math.max(0, nowMs - summon.startedAtMs) : 0;
  const modelLabel = isActive
    ? `Connected · ${fmtUptime(liveUptimeMs)}`
    : summon.kind === 'error' && summon.characterId === id
      ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH)
      : isConnecting
        ? 'Connecting…'
        : 'Ready';
  const modelDotColor = isErrored ? 'var(--red)' : isConnecting ? 'var(--warn)' : 'var(--green)';
  // The resting "Ready" status is intentionally not shown — the status line
  // only appears when there's a live state to report (online / connecting /
  // errored).
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
          <Button
            kind="quiet"
            size="sm"
            icon={<BackIcon size={14} />}
            onClick={closePage}
          >
            All companions
          </Button>
        </div>

        <div className={styles.titleRow}>
          <h1 className={styles.title}>{character.name}</h1>
          {isForeignOwned ? (
            <button
              type="button"
              className={styles.reportLink}
              onClick={() => {
                const subject = `Report companion: ${character.name}`;
                const body =
                  `Companion ID: ${character.id}\n` +
                  `Companion name: ${character.name}\n\n` +
                  `Reason (CSAM / hate speech / copyright / other):\n\n` +
                  `Details:\n\n`;
                const href =
                  `mailto:dmca@sei.gg?subject=${encodeURIComponent(subject)}` +
                  `&body=${encodeURIComponent(body)}`;
                void sei.openExternal(href);
              }}
              aria-label={`Report ${character.name}`}
            >
              Report
            </button>
          ) : null}
        </div>

        {/* Live status line (mockup d-status) — dot + tracked label. Hidden in
            the resting/idle state so no "Ready" label shows. */}
        {showStatusRow ? (
          <div className={styles.modelRow}>
            <span className={styles.modelDot} style={{ background: modelDotColor }} />
            <span className={styles.modelLabel}>{modelLabel}</span>
            {isErrored ? (
              <button type="button" className={styles.tryAgain} onClick={handleSummonClick}>
                TRY AGAIN
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Public/private toggle (hidden for defaults + foreign-owned). */}
        {!viewOnly ? (
          <div className={styles.sharedToggleRow}>
            <button
              type="button"
              className={`${styles.sharedToggle} ${
                character.shared ? styles.sharedToggleOn : styles.sharedToggleOff
              }`}
              onClick={() => { void onToggleShared(); }}
              disabled={
                shareConfirm !== null ||
                (authState.kind !== 'signed_in' && character.shared)
              }
              aria-pressed={character.shared}
              aria-label={
                character.shared
                  ? 'Companion is public. Click to make private.'
                  : 'Companion is private. Click to make public.'
              }
              title={
                authState.kind === 'signed_in'
                  ? character.shared
                    ? 'Visible in the public companion library. Click to make private.'
                    : 'Hidden from the public library. Click to share.'
                  : 'Sign in to share this companion with the community.'
              }
            >
              <span
                className={`${styles.sharedDot} ${
                  character.shared ? styles.sharedDotOn : styles.sharedDotOff
                }`}
                aria-hidden="true"
              />
              <span className={styles.sharedLabel}>
                {character.shared ? 'Public' : 'Private'}
              </span>
            </button>
          </div>
        ) : null}

        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'details'}
            className={tab === 'details' ? styles.tabActive : styles.tab}
            onClick={() => setTab('details')}
          >
            Details
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'skin'}
            className={tab === 'skin' ? styles.tabActive : styles.tab}
            onClick={() => setTab('skin')}
          >
            Skin
          </button>
        </div>

        <div className={styles.panel}>
          {tab === 'details' ? (
            <>
              <div className={styles.card}>
                {(() => {
                  // Read-only display. Own characters can toggle between the
                  // persona source and the public description; editing lives in
                  // the Edit modal now. Foreign/default chars show description only.
                  const showingPersona = !viewOnly && paneTab === 'persona';
                  return (
                    <>
                      <div className={styles.cardEyebrow}>
                        {showingPersona ? 'PERSONA SOURCE' : 'DESCRIPTION'}
                        {!viewOnly ? (
                          <button
                            type="button"
                            className={styles.cardEyebrowRotate}
                            onClick={() =>
                              setPaneTab(paneTab === 'persona' ? 'description' : 'persona')
                            }
                            aria-label={
                              paneTab === 'persona'
                                ? 'Switch to description'
                                : 'Switch to persona'
                            }
                          >
                            <RotateIcon size={14} />
                          </button>
                        ) : null}
                      </div>

                      {showingPersona ? (
                        <div className={styles.cardBody}>{character.persona.source || '-'}</div>
                      ) : (
                        <div className={styles.cardBody}>
                          {character.description?.trim() ||
                            (viewOnly ? 'No description provided.' : 'No description yet.')}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>

              <div className={styles.stats}>
                <div className={`${styles.stat} ${styles.statWide}`}>
                  <div className={styles.statEyebrow}>PROACTIVENESS</div>
                  <div className={styles.statValue}>
                    <ProactivenessBar
                      level={getProactiveness(character)}
                      size="md"
                      showLabel
                      block
                    />
                  </div>
                </div>
                <div className={styles.stat}>
                  <div className={styles.statEyebrow}>LAST LAUNCHED</div>
                  <div className={styles.statValue}>{fmtDate(character.last_launched)}</div>
                </div>
                <div className={styles.stat}>
                  <div className={styles.statEyebrow}>TOTAL PLAYTIME</div>
                  <div className={styles.statValue}>{fmtMs(character.playtime_ms)}</div>
                </div>
                <div className={styles.stat}>
                  <div className={styles.statEyebrow}>CREATED</div>
                  <div className={styles.statValue}>{fmtDate(character.created)}</div>
                </div>
              </div>
            </>
          ) : (
            <SkinEditor
              character={character}
              onChanged={() => void refreshCharacter(id)}
              viewOnly
              compact
            />
          )}
        </div>

        {/* Deploy bar — Summon CTA + gear, pinned to the bottom of the panel. */}
        <div className={styles.foot}>
          {isRemovedDefault || isWorldPreview ? (
            <Button
              kind="accent"
              size="lg"
              fullWidth
              className={styles.deployBtn}
              icon={<SparkleIcon size={14} />}
              onClick={() => { void onAddToLibraryClick(); }}
            >
              Add to library
            </Button>
          ) : (
            <Button
              kind={isActive || isConnecting ? 'ghost' : 'accent'}
              size="lg"
              fullWidth
              className={styles.deployBtn}
              icon={isActive || isConnecting ? null : <SparkleIcon size={14} />}
              onClick={handleSummonClick}
            >
              {isActive || isConnecting ? 'Disconnect' : 'Play together'}
            </Button>
          )}
          <div className={styles.gearWrap} ref={gearWrapRef}>
            <button
              type="button"
              className={styles.gearBtn}
              onClick={onGearClick}
              aria-label={viewOnly ? 'Companion options' : 'Edit companion'}
              aria-haspopup={viewOnly ? 'menu' : undefined}
              aria-expanded={viewOnly ? gearMenuOpen : undefined}
            >
              <GearIcon size={18} />
            </button>
            {viewOnly && gearMenuOpen ? (
              <div className={styles.gearMenu} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={styles.gearMenuItem}
                  onClick={() => { void onResetMemoryClick(); }}
                >
                  Reset memory
                </button>
                {!isWorldPreview ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.gearMenuItem}
                    onClick={() => { void onRemoveFromLibraryClick(); }}
                  >
                    Remove from library
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
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
          onConfirm={() => { void doResetMemory(); }}
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
        <div
          className={styles.confirmScrim}
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-confirm-title"
          onClick={(e) => {
            // Don't let a stray backdrop click abandon an in-flight publish.
            if (e.target === e.currentTarget && sharePhase !== 'working') closeShareModal();
          }}
        >
          <div className={styles.confirmModal}>
            {sharePhase === 'working' ? (
              <>
                <h2 id="share-confirm-title" className={styles.confirmTitle}>
                  {shareConfirm === 'going_public' ? 'Publishing…' : 'Updating…'}
                </h2>
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
                <h2
                  id="share-confirm-title"
                  className={`${styles.confirmTitle} ${styles.confirmTitleOk}`}
                >
                  {shareConfirm === 'going_public'
                    ? 'Your companion is now public'
                    : 'Your companion is now private'}
                </h2>
                <p className={styles.confirmBody}>
                  {shareConfirm === 'going_public'
                    ? 'Other players can find and connect it from the public library.'
                    : 'It is no longer visible in the public library.'}
                </p>
                <div className={styles.confirmActions}>
                  <Button kind="primary" size="md" onClick={closeShareModal}>
                    Done
                  </Button>
                </div>
              </>
            ) : sharePhase === 'error' ? (
              <>
                <h2
                  id="share-confirm-title"
                  className={`${styles.confirmTitle} ${styles.confirmTitleError}`}
                >
                  {shareConfirm === 'going_public' ? "Couldn't publish" : "Couldn't update sharing"}
                </h2>
                <p className={`${styles.confirmBody} ${styles.confirmErrorBody}`} role="alert">
                  {shareError ?? 'Something went wrong. Please try again.'}
                </p>
                <div className={styles.confirmActions}>
                  <Button kind="quiet" size="md" onClick={closeShareModal}>
                    Close
                  </Button>
                  <Button
                    kind={shareConfirm === 'going_public' ? 'accent' : 'primary'}
                    size="md"
                    onClick={() => { void onConfirmShareToggle(); }}
                  >
                    Try again
                  </Button>
                </div>
              </>
            ) : (
              <>
                <h2 id="share-confirm-title" className={styles.confirmTitle}>
                  {shareConfirm === 'going_public'
                    ? 'Allow other players to connect your companion?'
                    : 'Make this companion private?'}
                </h2>
                <p className={styles.confirmBody}>
                  {shareConfirm === 'going_public'
                    ? 'Companion memory will not be shared.'
                    : 'Other players will no longer be able to connect your companion. Are you sure?'}
                </p>
                <div className={styles.confirmActions}>
                  <Button kind="quiet" size="md" onClick={closeShareModal}>
                    Cancel
                  </Button>
                  <Button
                    kind={shareConfirm === 'going_public' ? 'accent' : 'primary'}
                    size="md"
                    onClick={() => { void onConfirmShareToggle(); }}
                  >
                    {shareConfirm === 'going_public' ? 'Make public' : 'Make private'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
