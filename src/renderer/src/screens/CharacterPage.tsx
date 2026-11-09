/**
 * CharacterPage — full-bleed character detail (the "Summoning Terminal").
 *
 * Layout (profile v0.7 "Option A", product call 261107): the portrait bleeds
 * off the RIGHT edge behind a left-to-right scrim, with its corner "view full
 * art" button. The left column carries a quiet back crumb, the name + IdTag,
 * one meta line (Bonded / Played / Last launch), the section tabs (Look,
 * Voice, Personality, Games, Sharing or WorldLink, Danger zone) and the
 * active tab's rows, with Chat + Play (or Invite to party) pinned at the
 * bottom.
 *
 * Tabs are real tabs: only the active one renders, and it scrolls inside its
 * own area, so one section never scrolls into the next. The rows
 * (components/profile/ProfileSettings.tsx) are label + value + action; every
 * action opens the existing editor or popup, which this page owns. Who may
 * use which row is lib/profileRows.ts. The old settings gear and its menu
 * are gone; each of its items is a row now.
 *
 * This page is STATIC info only. Minecraft connect/disconnect controls live
 * exclusively in the chat's game surface (McLaunchPanel Launch / the
 * GameSurface end "x"); there is no live status line or session timer here.
 * "Chat" routes to the chat page; "Play" routes to chat AND opens the
 * Minecraft surface (launch panel, or the live dashboard when the bot is
 * already online) and never reflects game state.
 *
 * Source: docs/design/UI-REDESIGN-PARTY.md §4.6 (frame), 261107 (rows).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useT, t as tGlobal } from '../lib/i18n';
import { useUiStore } from '../lib/stores/useUiStore';
import { resolvedScheme } from '../lib/theme';
import { useDataStore } from '../lib/stores/useDataStore';
import { useChatStore } from '../lib/stores/useChatStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { movedInId, useSeilinkStore } from '../lib/stores/useSeilinkStore';
import { Button } from '../components/Button';
import { ModalShell, ModalFooter } from '../components/ModalShell';
import { PixelPortrait } from '../components/PixelPortrait';
import { EditCharacterModal, type EditSection } from '../components/EditCharacterModal';
import { SignInModal } from '../components/SignInModal';
import { IdTag } from '../components/IdTag';
import { AddCount } from '../components/AddCount';
import { useBrowseStore } from '../lib/stores/useBrowseStore';
import { ResetMemoryConfirmModal } from '../components/ResetMemoryConfirmModal';
import { UnbindConfirmModal } from '../components/UnbindConfirmModal';
import { KnowledgeModal } from '../components/KnowledgeModal';
import { PortraitVersionsModal } from '../components/PortraitVersionsModal';
import { RegenHint, useRegenHint } from '../components/RegenHint';
import { DeleteConfirmModal } from '../components/DeleteConfirmModal';
import { ReportCompanionModal } from '../components/ReportCompanionModal';
import { SharedVoiceChoice } from '../components/SharedVoiceChoice';
import { ProfileSettings } from '../components/profile/ProfileSettings';
import { AvatarsModal, FloatingAvatarModal, SkinEditModal } from '../components/profile/ProfileModals';
import { formatDate } from '../lib/formatDate';
import { requestGameLaunch, openGame } from '../lib/gameLaunch';
import { BackIcon, FullscreenIcon } from '../components/icons';
import { pickPalette } from '../lib/portraitPalettes';
import { portraitSrc } from '../lib/portraitSrc';
import {
  profileAccess,
  profileKind,
  profileTabs,
  resolveProfileTab,
  sharingTabLabel,
  takeRequestedProfileTab,
  trackProfileActionClicked,
  trackProfileTabViewed,
  trackProfileTooltipOpened,
  type ProfileAction,
  type ProfileTab,
} from '../lib/profileRows';
import type { Character } from '@shared/characterSchema';
import { NO_VOICE_ID, ownVoiceOf, sharedVoiceIdOf } from '@shared/voiceIds';
import { sharedVoiceMetadataToSave } from '../lib/sharedVoice';
import { voicePitchRate } from '@shared/voicePitch';
import styles from './CharacterPage.module.css';

/** Tab labels (English keys, translated at render). */
const TAB_LABEL: Record<ProfileTab, string> = {
  look: 'Look',
  voice: 'Voice',
  personality: 'Personality',
  games: 'Games',
  sharing: 'Sharing',
  danger: 'Danger zone',
};

function fmtMs(ms: number): string {
  if (ms <= 0) return '-';
  if (ms < 60_000) return tGlobal('{n}s', { n: Math.floor(ms / 1000) });
  if (ms < 3_600_000) return tGlobal('{n}m', { n: Math.floor(ms / 60_000) });
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? tGlobal('{h}h {m}m', { h, m }) : tGlobal('{n}h', { n: h });
}

export interface CharacterPageProps {
  id: string;
}

/**
 * Wireframe shown while a not-yet-cached character downloads (or on the first
 * paint before the mount effect resolves). Mirrors the real page frame — a
 * portrait block bleeding off the right, name / chip / description / kv / deploy
 * bars on the left — static grey blocks (260705: no shimmer sweep), so the wait
 * reads as intentional instead of a blank flash. Keeps a working Back crumb so
 * the user is never stranded.
 */
function CharacterPageSkeleton({ onBack }: { onBack: () => void }): React.ReactElement {
  const t = useT();
  return (
    <div className={styles.root} aria-busy="true" aria-label={t('Loading companion')}>
      <div className={styles.portraitLayer} aria-hidden="true">
        <div className={styles.skelPortrait} />
        <div className={styles.dScrim} />
      </div>
      <main className={styles.content}>
        <div className={styles.crumb}>
          <Button kind="quiet" size="sm" icon={<BackIcon size={13} />} onClick={onBack}>
            {t('Back')}
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
  const t = useT();
  const navigate = useUiStore((s) => s.navigate);
  // 261110: opened from the World tab (Back returns to World, not a chat) =
  // show the World card's library add count beside the name. The number is
  // the one the World page already fetched; no extra request.
  const openedFromWorld = useUiStore((s) => s.homeTab === 'world' && s.chatReturnId !== id);
  const worldAddCount = useBrowseStore(
    (s) => s.entries.find((e) => e.id === id)?.addCount ?? null,
  );
  const characters = useDataStore((s) => s.characters);
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  const authState = useAuthStore((s) => s.state);
  const setUpgradeFraming = useAuthStore((s) => s.setUpgradeFraming);
  const setPendingShareIntent = useAuthStore((s) => s.setPendingShareIntent);
  const upgradeFraming = useAuthStore((s) => s.upgradeFraming);

  const character: Character | undefined = characters.find((c) => c.id === id);
  const [editing, setEditing] = useState<boolean>(false);
  const [editSection, setEditSection] = useState<EditSection>('basic');
  // The tab the player picked (null = the first one). The shown tab is
  // resolved against the tabs this companion has (resolveProfileTab).
  const [wantedTab, setWantedTab] = useState<ProfileTab | null>(() => takeRequestedProfileTab());
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
  // 260725 Knowledge popup.
  const [knowledgeOpen, setKnowledgeOpen] = useState<boolean>(false);
  // 260909 Card image popup (versions + regenerate + upload); `regenerate`
  // starts a regeneration as soon as it opens (the row's Regenerate button).
  const [cardImage, setCardImage] = useState<{ regenerate: boolean } | null>(null);
  // 261107 profile rows' own popups.
  const [skinEditOpen, setSkinEditOpen] = useState<boolean>(false);
  const [avatarsOpen, setAvatarsOpen] = useState<{ manage: boolean } | null>(null);
  const [floatingOpen, setFloatingOpen] = useState<boolean>(false);
  // Bumped when a popup that changes a row's value closes, so the row re-reads it.
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  // 261104 SeiLink (M4): the WorldLink rows exist only while SeiLink is on
  // (a supported install or the dev flag; no setting since 261105). The
  // move-in sheet and the room editor are SeilinkFlowHost's (App.tsx).
  const seilinkOn = useSeilinkStore((s) => s.availability?.enabled === true);
  const livingId = useSeilinkStore((s) => movedInId(s.status));
  // The room editor closing may have changed her room: re-read the Room row.
  const seilinkFlowOpen = useSeilinkStore((s) => s.flow !== null);
  const flowWasOpen = useRef(false);
  useEffect(() => {
    if (flowWasOpen.current && !seilinkFlowOpen) bumpRefresh();
    flowWasOpen.current = seilinkFlowOpen;
  }, [seilinkFlowOpen, bumpRefresh]);
  const [shareConfirm, setShareConfirm] = useState<'going_public' | 'going_private' | null>(null);
  // 261019 — "Others will hear" choice in the publish confirm, shown only when
  // the voice is the author's own ElevenLabs voice. null = the close Sei
  // voice main rolls for adopters; seeded from metadata.voiceShared each time
  // the confirm opens.
  const [shareVoice, setShareVoice] = useState<string | null>(null);
  useEffect(() => {
    if (shareConfirm === 'going_public') setShareVoice(sharedVoiceIdOf(character?.metadata));
    // Seed on open only; later metadata refreshes must not reset the pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareConfirm]);
  // Set when a publish attempt is blocked on a missing description: we open the
  // edit modal at Basic, and resume the publish once the modal closes with a
  // description present.
  const [needsDescription, setNeedsDescription] = useState<boolean>(false);
  // 260729 — full-art popup (the corner expand button over the portrait).
  const [artOpen, setArtOpen] = useState<boolean>(false);
  const [artSaving, setArtSaving] = useState<boolean>(false);
  const [artSavedTo, setArtSavedTo] = useState<string | null>(null);

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

  // ── Library-state hooks (hoisted above the early-return for stable count) ──
  const addedDefaultIds = useLibraryStateStore((s) => s.addedDefaultIds);
  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const refreshLibraryState = useLibraryStateStore((s) => s.refresh);

  // ── Who this companion is to the player, and which rows / tabs it gets ──
  // Null-safe (the character may still be loading) so the hooks below can sit
  // above the early returns. Rules: lib/profileRows.ts.
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  const kind = character ? profileKind(character, currentUserId) : 'custom';
  const isDefault = character?.is_default === true;
  // 260703 procgen: defaults are opt-in on Home — a default NOT in
  // added_default_ids shows "Add to library" instead of the Play CTA.
  const isRemovedDefault = !!character && isDefault && !addedDefaultIds.has(character.id);
  // A character with a cloud owner that isn't the current user is foreign /
  // view-only. This holds for SIGNED-OUT users too (currentUserId === null).
  const isForeignOwned = kind === 'world';
  const isWorldPreview = !!character && isForeignOwned && !addedWorldIds.has(character.id);
  const isAddedFromWorld = !!character && isForeignOwned && addedWorldIds.has(character.id);
  // World-preview / removed-default entries aren't in the library yet — no
  // memory to reset and nothing to release.
  const isPreview = isWorldPreview || isRemovedDefault;
  const access = profileAccess({
    kind,
    inLibrary: !!character && !isPreview,
    seilinkOn,
    movedInHere: livingId === id,
    ownVoice: !!ownVoiceOf(character?.metadata),
    noVoice: character?.metadata?.voiceId === NO_VOICE_ID,
  });
  const tabs = profileTabs(access);
  const tab = resolveProfileTab(tabs, wantedTab);

  // profile_tab_viewed: on open and on every tab change (and a new companion).
  useEffect(() => {
    if (!character) return;
    trackProfileTabViewed(tab, kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, character?.id, kind]);
  // profile_tooltip_opened: once per key per companion visit.
  const tipsSeen = useRef<{ id: string; keys: Set<string> }>({ id, keys: new Set() });
  const onTipOpen = useCallback(
    (key: string): void => {
      if (tipsSeen.current.id !== id) tipsSeen.current = { id, keys: new Set() };
      if (tipsSeen.current.keys.has(key)) return;
      tipsSeen.current.keys.add(key);
      trackProfileTooltipOpened(key);
    },
    [id],
  );

  // 261107: the one-time "Not happy with the look? Regenerate" hint, on the
  // Look tab's card image Regenerate button (rules in lib/regenHintPref.ts).
  // Any other tab counts as covered: it does not show there and is not used up.
  const regenHint = useRegenHint({
    character,
    pageOverlayOpen:
      tab !== 'look' ||
      editing ||
      knowledgeOpen ||
      cardImage !== null ||
      skinEditOpen ||
      avatarsOpen !== null ||
      floatingOpen ||
      artOpen ||
      resetConfirmOpen ||
      releaseConfirmOpen ||
      shareConfirm !== null ||
      showSignIn ||
      showReport,
    leaving,
  });

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
              ? t(
                  "Couldn't load this companion. You may be offline, or the companion may have been deleted.",
                )
              : t('Companion not found.')}
          </p>
          <Button kind="primary" size="md" onClick={() => navigate({ kind: 'home' })}>
            {t('Back to home')}
          </Button>
        </div>
      );
    }
    return <CharacterPageSkeleton onBack={() => navigate({ kind: 'home' })} />;
  }

  // Only user-created ('custom') companions are editable: built-ins, World
  // companions and Awakened ('unique') ones show their rows locked
  // (lib/profileRows.ts). Kept for the publish flow's description gate.
  const viewOnly = kind !== 'custom';
  const theme: 'light' | 'dark' = resolvedScheme();
  const palette = pickPalette(character.id + character.name, theme);
  // Per-character accent tint for the portrait bloom.
  const tint = palette[2] ?? palette[1] ?? 'var(--accent)';

  const openEdit = (section: EditSection): void => {
    setEditSection(section);
    setEditing(true);
  };

  // "Chat" routes to the chat page; "Play" routes to chat AND opens the
  // Minecraft game surface (the launch panel, or the live dashboard when the
  // bot is already online). Both are static: connection control lives in the
  // game surface, never on this page. Play rides the shared cross-launch
  // gate so a live chess/screen-share session confirms before it swaps.
  const handleChatClick = (): void => {
    navigate({ kind: 'chat', characterId: id });
  };
  const handlePlayClick = (): void => {
    requestGameLaunch(id, { id: 'minecraft', name: 'Minecraft' }, () =>
      openGame(id, 'minecraft'),
    );
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
      // The description gate only applies where the user can actually satisfy
      // it. A non-editable kind has no editor to open, so demanding one would
      // be a dead end; an Awakened companion is always cast with a description
      // anyway (buildDescription in uniqueGeneration), so this is a fallback.
      if (!hasDescription && !viewOnly) {
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
      // Store the "Others will hear" pick before publishing so the cloud row
      // the moderation sync uploads already carries it.
      if (target && ownVoiceOf(character.metadata)) {
        const latest = (await sei.getCharacter(character.id)) ?? character;
        const metadata = sharedVoiceMetadataToSave(latest.metadata, shareVoice);
        if (metadata) {
          await sei.saveCharacter({ ...latest, metadata }, { skipExpansion: true });
          // Kept even if the publish then fails: the page label shows it.
          await refreshCharacter(character.id);
        }
      }
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
      // The memory-dir wipe also deleted the chat transcript — evict the
      // renderer cache so the chat screen refetches (empty) instead of
      // showing the wiped conversation from the loaded-once cache.
      useChatStore.getState().evictLocal(character.id);
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
          : t("Couldn't add this companion. Please try again."),
      );
    }
  };

  const onAction = (action: ProfileAction): void => {
    trackProfileActionClicked(action, tab, kind);
    // The card's Regenerate is the hint's own outcome when the hint is up.
    if (action === 'regenerate_card') regenHint.regenerate();
  };

  const selectTab = (next: ProfileTab): void => {
    if (next === tab) return;
    // Leaving Look with the hint up: the player moved on without using it.
    if (regenHint.show) regenHint.dismiss('outside');
    setWantedTab(next);
  };

  // Arrow keys move between tabs (WAI-ARIA tabs, automatic activation).
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const i = tabs.indexOf(tab);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    selectTab(tabs[next]);
    document.getElementById(`profile-tab-${tabs[next]}`)?.focus();
  };

  const tabLabel = (key: ProfileTab): string =>
    key === 'sharing' ? t(sharingTabLabel(access)) : t(TAB_LABEL[key]);

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

      {/* Expand the full art (260729) — only when there is real portrait art
          to show (the procedural sprite has nothing to save). */}
      {portraitSrc(character.portrait_image) ? (
        <button
          type="button"
          className={styles.artExpandBtn}
          onClick={() => {
            setArtSavedTo(null);
            setArtOpen(true);
          }}
          aria-label={t('View full art')}
          data-tip={t('View full art')}
          data-tip-edge="right"
        >
          <FullscreenIcon size={16} />
        </button>
      ) : null}

      <main className={`${styles.content} ${leaving ? styles.contentLeaving : ''}`}>
        <div className={styles.crumb}>
          <Button kind="quiet" size="sm" icon={<BackIcon size={13} />} onClick={closePage}>
            {t('Back')}
          </Button>
        </div>

        <header className={styles.head}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{character.name}</h1>
            {character.public_id ? <IdTag id={character.public_id} size="md" /> : null}
            {openedFromWorld ? <AddCount count={worldAddCount} variant="page" /> : null}
            {kind === 'builtin' ? <span className={styles.kindChip}>{t('Built-in')}</span> : null}
          </div>
          {/* One meta line (was three stat boxes). "Bonded" only reads right
              once the companion is in your library; a preview shows when it
              was made. */}
          <dl className={styles.meta}>
            <div className={styles.metaItem}>
              <dt>{isPreview ? t('Created') : t('Bonded')}</dt>
              <dd>{formatDate(character.created)}</dd>
            </div>
            <div className={styles.metaItem}>
              <dt>{t('Played')}</dt>
              <dd>{fmtMs(character.playtime_ms)}</dd>
            </div>
            <div className={styles.metaItem}>
              <dt>{t('Last launch')}</dt>
              <dd>{formatDate(character.last_launched)}</dd>
            </div>
          </dl>
        </header>

        <div
          className={styles.tabs}
          role="tablist"
          aria-label={t('Companion settings')}
          onKeyDown={onTabKeyDown}
        >
          {tabs.map((key) => (
            <button
              key={key}
              id={`profile-tab-${key}`}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls="profile-tabpanel"
              tabIndex={tab === key ? 0 : -1}
              className={`${tab === key ? styles.tabActive : styles.tab} ${key === 'danger' ? styles.tabDanger : ''}`}
              onClick={() => selectTab(key)}
            >
              {tabLabel(key)}
            </button>
          ))}
        </div>

        {/* Only the active tab renders; it scrolls inside this area. */}
        <div
          id="profile-tabpanel"
          className={styles.panel}
          role="tabpanel"
          aria-labelledby={`profile-tab-${tab}`}
          data-tab={tab}
        >
          <ProfileSettings
            key={`${character.id}:${tab}`}
            character={character}
            access={access}
            tab={tab}
            onAction={onAction}
            onTipOpen={onTipOpen}
            openEdit={openEdit}
            openCardImage={(regenerate) => setCardImage({ regenerate })}
            openKnowledge={() => setKnowledgeOpen(true)}
            openSkinEdit={() => setSkinEditOpen(true)}
            openAvatars={(manage) => setAvatarsOpen({ manage })}
            openFloating={() => setFloatingOpen(true)}
            onToggleShared={onToggleShared}
            shareToggleDisabled={
              shareConfirm !== null || (authState.kind !== 'signed_in' && character.shared)
            }
            onResetMemory={onResetMemoryClick}
            onUnbind={() => setReleaseConfirmOpen(true)}
            onReport={() => setShowReport(true)}
            refreshKey={refreshKey}
            regenHint={
              regenHint.show ? (
                <RegenHint
                  placement="below"
                  onClose={() => regenHint.dismiss('close')}
                  onOutside={() => regenHint.dismiss('outside')}
                  onRegenerate={() => {
                    regenHint.regenerate();
                    setCardImage({ regenerate: true });
                  }}
                />
              ) : null
            }
          />
        </div>

        {/* Deploy row — Chat + Play, pinned to the bottom. Both buttons are
            static routes; neither reflects game state. */}
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
              {t('Invite to party')}
            </Button>
          ) : (
            <>
              <Button
                kind="primary"
                size="lg"
                className={styles.deployBig}
                onClick={handleChatClick}
                data-tutorial="chat-cta"
              >
                {t('Chat')}
              </Button>
              <Button
                kind="accent"
                size="lg"
                className={styles.deployBig}
                onClick={handlePlayClick}
              >
                {t('Play')}
              </Button>
            </>
          )}
        </div>
      </main>

      {editing ? (
        <EditCharacterModal
          character={character}
          initialSection={editSection}
          only
          onClose={onEditClose}
          notice={
            needsDescription
              ? t(
                  'Going public needs a description. Add one, then close this window to continue publishing {name}.',
                  { name: character.name },
                )
              : undefined
          }
        />
      ) : null}
      {knowledgeOpen ? (
        <KnowledgeModal
          characterId={character.id}
          characterName={character.name}
          onClose={() => {
            setKnowledgeOpen(false);
            bumpRefresh();
          }}
        />
      ) : null}
      {cardImage ? (
        <PortraitVersionsModal
          characterId={character.id}
          characterName={character.name}
          autoRegenerate={cardImage.regenerate}
          allowUpload={access.cardUpload}
          onClose={() => {
            setCardImage(null);
            bumpRefresh();
          }}
        />
      ) : null}
      {skinEditOpen ? <SkinEditModal character={character} onClose={() => setSkinEditOpen(false)} /> : null}
      {avatarsOpen ? (
        <AvatarsModal character={character} manage={avatarsOpen.manage} onClose={() => setAvatarsOpen(null)} />
      ) : null}
      {floatingOpen ? <FloatingAvatarModal character={character} onClose={() => setFloatingOpen(false)} /> : null}
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
      {artOpen ? (
        <ModalShell
          title={null}
          width={720}
          escClose
          scrimClose
          onClose={() => setArtOpen(false)}
          aria-label={t('{name} full art', { name: character.name })}
        >
          <img
            className={styles.artModalImg}
            src={portraitSrc(character.portrait_image) ?? undefined}
            alt={t('{name} full art', { name: character.name })}
            draggable={false}
          />
          {artSavedTo ? (
            <p className={styles.artSavedNote}>{t('Saved to {path}', { path: artSavedTo })}</p>
          ) : null}
          <ModalFooter>
            <Button kind="quiet" size="md" onClick={() => setArtOpen(false)}>
              {t('Close')}
            </Button>
            <Button
              kind="accent"
              size="md"
              disabled={artSaving}
              onClick={() => {
                setArtSaving(true);
                setArtSavedTo(null);
                sei
                  .charsExportPortrait(id)
                  .then((p) => setArtSavedTo(p))
                  .catch(() => setArtSavedTo(null))
                  .finally(() => setArtSaving(false));
              }}
            >
              {artSaving ? t('Saving...') : t('Save')}
            </Button>
          </ModalFooter>
        </ModalShell>
      ) : null}

      {shareConfirm ? (
        <ModalShell
          title={null}
          width={shareConfirm === 'going_public' && ownVoiceOf(character.metadata) ? 460 : 420}
          escClose={sharePhase !== 'working'}
          scrimClose={sharePhase !== 'working'}
          onClose={closeShareModal}
          aria-label={t('Sharing')}
        >
          {sharePhase === 'working' ? (
            <>
              <h3 className={styles.confirmTitle}>
                {shareConfirm === 'going_public' ? t('Publishing…') : t('Updating…')}
              </h3>
              <p className={styles.confirmBody}>
                {shareConfirm === 'going_public'
                  ? t('Uploading your companion and checking it against our content guidelines.')
                  : t('Making your companion private.')}
              </p>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label={shareConfirm === 'going_public' ? t('Publishing') : t('Updating')}
              >
                <div className={styles.progressIndeterminate} />
              </div>
            </>
          ) : sharePhase === 'success' ? (
            <>
              <h3 className={`${styles.confirmTitle} ${styles.confirmTitleOk}`}>
                {shareConfirm === 'going_public'
                  ? t('Your companion is now public')
                  : t('Your companion is now private')}
              </h3>
              <p className={styles.confirmBody}>
                {shareConfirm === 'going_public'
                  ? t('Other players can find and invite it from the World tab.')
                  : t('It is no longer visible in the World tab.')}
              </p>
              <ModalFooter>
                <Button kind="primary" size="md" onClick={closeShareModal}>
                  {t('Done')}
                </Button>
              </ModalFooter>
            </>
          ) : sharePhase === 'error' ? (
            <>
              <h3 className={`${styles.confirmTitle} ${styles.confirmTitleError}`}>
                {shareConfirm === 'going_public'
                  ? t("Couldn't publish")
                  : t("Couldn't update sharing")}
              </h3>
              <p className={`${styles.confirmBody} ${styles.confirmErrorBody}`} role="alert">
                {shareError ?? t('Something went wrong. Please try again.')}
              </p>
              <ModalFooter>
                <Button kind="quiet" size="md" onClick={closeShareModal}>
                  {t('Close')}
                </Button>
                <Button
                  kind={shareConfirm === 'going_public' ? 'accent' : 'primary'}
                  size="md"
                  onClick={() => {
                    void onConfirmShareToggle();
                  }}
                >
                  {t('Try again')}
                </Button>
              </ModalFooter>
            </>
          ) : (
            <>
              <h3 className={styles.confirmTitle}>
                {shareConfirm === 'going_public'
                  ? t('Allow other players to invite your companion?')
                  : t('Make this companion private?')}
              </h3>
              <p className={styles.confirmBody}>
                {shareConfirm === 'going_public'
                  ? t('Companion memory will not be shared.')
                  : t('Other players will no longer be able to invite your companion. Are you sure?')}
              </p>
              {shareConfirm === 'going_public' && ownVoiceOf(character.metadata) ? (
                <div className={styles.confirmVoice}>
                  <SharedVoiceChoice
                    characterId={character.id}
                    value={shareVoice}
                    onChange={setShareVoice}
                    pitch={voicePitchRate(character)}
                  />
                </div>
              ) : null}
              <ModalFooter>
                <Button kind="quiet" size="md" onClick={closeShareModal}>
                  {t('Cancel')}
                </Button>
                <Button
                  kind={shareConfirm === 'going_public' ? 'accent' : 'primary'}
                  size="md"
                  onClick={() => {
                    void onConfirmShareToggle();
                  }}
                >
                  {shareConfirm === 'going_public' ? t('Make public') : t('Make private')}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalShell>
      ) : null}
    </div>
  );
}
