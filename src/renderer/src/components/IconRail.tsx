/**
 * IconRail / Sidebar — Discord-style vertical sidebar.
 *
 * B3 refactor of the prior fixed-icon rail. New layout top→bottom:
 *   1. Home pill (RosterIcon — 2×2 grid) — active when view ∈ {home, character, add-character}
 *   2. Compass / World icon — sits directly under Home (mockup Sidebar parity).
 *      Opens the World tab (sets homeTab='world' then navigate home); active
 *      while the World tab is selected.
 *   3. Thin divider
 *   4. Scrollable 44px circular character avatars sorted by last_launched desc,
 *      then created desc. Active when view.kind==='character' && id matches.
 *   5. Round + button — navigates to add-character
 *   6. Flex spacer
 *   7. Credits/Cloud icon — StarIcon (4-point) in BOTH states for consistent
 *      rail iconography; only the click target differs:
 *        - cloud-proxy → navigate credits
 *        - local + signed in   → SwitchBackendConfirmModal → flip to cloud-proxy
 *          directly (NO sign-in re-prompt — the user already has a session).
 *        - local + signed out  → inline "Switch to cloud?" confirm dialog →
 *          SignInModal; once signed in the switch completes automatically.
 *   8. Settings icon
 *
 * Removed: Minecraft button, Add-game (Plus → coming-soon) button.
 * Scrollbar hidden on the avatar cluster; only the avatar cluster scrolls.
 *
 * Source: B3 spec; D-34 (no Minecraft branding in rail); UI-SPEC §Component
 * Inventory → IconRail/Sidebar (updated by B3 sub-task).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './IconRail.module.css';
import {
  CompassIcon,
  RosterIcon,
  PlusIcon,
  SettingsIcon,
  StarIcon,
} from './icons';
import { PixelPortrait } from './PixelPortrait';
import { Button } from './Button';
import { SignInModal } from './SignInModal';
import { SwitchBackendConfirmModal } from './SwitchBackendConfirmModal';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { useBrowseStore } from '../lib/stores/useBrowseStore';
import { pickPalette } from '../lib/portraitPalettes';
import { portraitSrc } from '../lib/portraitSrc';
import {
  tokensRemainingToPlaytime,
  DEFAULT_TOKENS_PER_MIN,
  VISION_MULTIPLIER,
} from '../lib/playtimeEstimate';

/**
 * Tooltip hover state lifted to the IconRail component so it can render a
 * SINGLE position:fixed tooltip outside any overflow:hidden / scroll
 * container. Discord-style tooltips inside .avatarCluster (overflow-y: auto)
 * were getting clipped on the x-axis because CSS forces the perpendicular
 * overflow when one axis is auto/scroll — position:absolute children can't
 * escape that without JS-driven positioning.
 *
 * Each rail button calls setHover with the label + the y-anchor of its
 * vertical center (so the tooltip lines up regardless of where in the scroll
 * container the button sits). The shared tooltip is rendered once near the
 * end of the IconRail JSX.
 */
interface TooltipState { label: string; y: number }

type SetHover = (s: TooltipState | null) => void;

function attachHover(
  el: HTMLElement | null,
  label: string,
  setHover: SetHover,
): void {
  if (!el) return;
  const r = el.getBoundingClientRect();
  setHover({ label, y: r.top + r.height / 2 });
}

interface RailButtonProps {
  active?: boolean;
  onClick?: () => void;
  title?: string;
  badge?: boolean;
  muted?: boolean;
  /** When true, omit the active-bar so circular avatars can carry their own focus ring. */
  noActiveBar?: boolean;
  /** Optional warm-up fired on hover / focus (e.g. prefetch the World grid). */
  onHoverStart?: () => void;
  setHover: SetHover;
  children: React.ReactNode;
}

function RailButton({
  active,
  onClick,
  title,
  badge,
  muted,
  noActiveBar,
  onHoverStart,
  setHover,
  children,
}: RailButtonProps): React.ReactElement {
  const cls = [
    styles.railButton,
    active ? styles.active : '',
    muted ? styles.muted : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      onClick={onClick}
      aria-label={title}
      className={cls}
      type="button"
      onMouseEnter={(e) => {
        if (title) attachHover(e.currentTarget, title, setHover);
        onHoverStart?.();
      }}
      onMouseLeave={() => setHover(null)}
      onFocus={(e) => {
        if (title) attachHover(e.currentTarget, title, setHover);
        onHoverStart?.();
      }}
      onBlur={() => setHover(null)}
    >
      {active && !noActiveBar && <span className={styles.activeBar} aria-hidden="true" />}
      {children}
      {badge && <span className={styles.badge} aria-hidden="true" />}
    </button>
  );
}

/**
 * Single avatar in the scrollable character cluster. Uses the character's
 * portrait_image when present (rendered as a circular <img>), otherwise
 * a 44px PixelPortrait inside a circular clip.
 */
interface AvatarButtonProps {
  characterId: string;
  characterName: string;
  portraitImage: string | null;
  active: boolean;
  onClick: () => void;
  theme: 'light' | 'dark';
  setHover: SetHover;
}

function AvatarButton({
  characterId,
  characterName,
  portraitImage,
  active,
  onClick,
  theme,
  setHover,
}: AvatarButtonProps): React.ReactElement {
  const palette = useMemo(
    () => pickPalette(characterId + characterName, theme),
    [characterId, characterName, theme],
  );
  const cls = [styles.avatarButton, active ? styles.avatarActive : ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      aria-label={characterName}
      onMouseEnter={(e) => attachHover(e.currentTarget, characterName, setHover)}
      onMouseLeave={() => setHover(null)}
      onFocus={(e) => attachHover(e.currentTarget, characterName, setHover)}
      onBlur={() => setHover(null)}
    >
      {/*
        Wrapper enforces the circular crop. Browsers honor `border-radius`
        on <img>, but non-square portraits with `object-fit:cover` + the
        `image-rendering: pixelated` rule have shown inconsistent clipping
        in some Electron builds. A wrapping div with `overflow: hidden`
        is the bulletproof crop.
      */}
      <span className={styles.avatarClip} aria-hidden="true">
        {portraitImage ? (
          <img
            src={portraitSrc(portraitImage)!}
            alt=""
            width={44}
            height={44}
            className={styles.avatarImg}
          />
        ) : (
          <PixelPortrait
            seed={characterId + characterName}
            palette={palette}
            size={44}
            className={styles.avatarImg}
            aria-label={characterName}
          />
        )}
      </span>
    </button>
  );
}

export function IconRail(): React.ReactElement {
  const view = useUiStore((s) => s.view);
  const navigate = useUiStore((s) => s.navigate);
  const setHomeTab = useUiStore((s) => s.setHomeTab);
  const characters = useDataStore((s) => s.characters);
  const authState = useAuthStore((s) => s.state);
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  const remainingTokens = useCreditsStore((s) => s.remaining_tokens);
  const aiBackendKind = useCreditsStore((s) => s.ai_backend_kind);
  // Phase 15 (D-07): shrink the rail's "Playtime · ~Xh" figure via VISION_MULTIPLIER
  // when idle auto-look is ON (heavier usage). Read the toggle from UserConfig.
  // The playtime branch only renders for cloud-proxy users (the `aiBackendKind ===
  // 'cloud-proxy'` gate below), so D-11 holds — BYO/local users never see this.
  const [autoRenderOn, setAutoRenderOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void sei.getConfig().then((c) => {
      if (!cancelled) setAutoRenderOn(c.vision_auto_render === true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // 260602-hbr: flat DEFAULT_TOKENS_PER_MIN multiplier (no per-user rate);
  // Phase 15 D-07 scales it up when auto-look is on so the figure shrinks.
  const playtimeRate = autoRenderOn
    ? DEFAULT_TOKENS_PER_MIN * VISION_MULTIPLIER
    : DEFAULT_TOKENS_PER_MIN;
  const playtimeDisplay = tokensRemainingToPlaytime(remainingTokens, playtimeRate).display;

  // B3 — local confirm dialog for the cloud-icon click when the user is on
  // the local backend. Two-button "Switch to cloud?" panel that, on
  // continue, opens the existing SignInModal. Component-level state keeps
  // this self-contained (no global modal needed).
  const [showCloudPrompt, setShowCloudPrompt] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  // Already-signed-in user switching BYOK → cloud: the backend-switch confirm
  // (same modal Settings uses). No sign-in re-prompt — they have a session.
  const [showSwitchConfirm, setShowSwitchConfirm] = useState(false);
  // Set when a signed-OUT user takes the "Switch to cloud" path: after they
  // finish signing in we complete the switch automatically (see effect below).
  const [pendingCloudAfterSignIn, setPendingCloudAfterSignIn] = useState(false);
  const [hoverTip, setHoverTip] = useState<TooltipState | null>(null);

  // Flip the AI backend to cloud-proxy (the canonical switch SettingsScreen
  // uses), refresh the credits store so the rail swaps to the Playtime icon +
  // unlocks the credits surface, then land on it.
  const switchToCloud = useCallback(async (): Promise<void> => {
    await sei.proxyConfigure('cloud-proxy');
    await useCreditsStore.getState().refresh();
    navigate({ kind: 'credits' });
  }, [navigate]);

  // Complete a "switch to cloud" that was waiting on sign-in: once the user is
  // signed in, flip the backend without a second prompt. Guarded by the
  // pending flag (set only by the signed-out cloud path) so an unrelated
  // sign-in never triggers an unwanted backend switch.
  useEffect(() => {
    if (pendingCloudAfterSignIn && currentUserId) {
      setPendingCloudAfterSignIn(false);
      setShowSignIn(false);
      void switchToCloud();
    }
  }, [pendingCloudAfterSignIn, currentUserId, switchToCloud]);

  // Cloud-icon click on the LOCAL backend. Signed-in users go straight to the
  // backend-switch confirm (the bug fix: never re-prompt for sign-in when a
  // session already exists); signed-out users get the sign-in path.
  const handleCloudClick = (): void => {
    if (currentUserId) setShowSwitchConfirm(true);
    else setShowCloudPrompt(true);
  };

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  // Home pill is active when the user is on home (Home tab specifically — the
  // World sub-tab is its own surface and the rail's home icon should NOT light
  // up when the compass-driven World tab is selected), on an individual
  // character, or on the add-character flow.
  const homeTab = useUiStore((s) => s.homeTab);
  const homeActive =
    (view.kind === 'home' && homeTab === 'home') ||
    view.kind === 'character' ||
    view.kind === 'add-character';
  // World tab is its own surface — the compass nav (now directly under Home,
  // mockup Sidebar parity) lights up while it's selected.
  const worldActive = view.kind === 'home' && homeTab === 'world';

  // Filter to the user's home library — same rule HomeGrid uses so the rail
  // and the Home grid never diverge. Bundled defaults are shown unless the
  // user has removed them from their library via the gear menu. Foreign
  // chars are hidden unless the user added them from the World tab
  // (UserConfig.added_world_ids).
  const removedDefaultIds = useLibraryStateStore((s) => s.removedDefaultIds);
  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const homeCharacters = useMemo(() => {
    return characters.filter((c) => {
      if (c.is_default === true) return !removedDefaultIds.has(c.id);
      if (currentUserId && c.owner != null && c.owner !== currentUserId) {
        return addedWorldIds.has(c.id);
      }
      return true;
    });
  }, [characters, currentUserId, removedDefaultIds, addedWorldIds]);

  // Stable sort: last_launched desc (nulls last), then created desc.
  const sortedCharacters = useMemo(() => {
    const copy = homeCharacters.slice();
    copy.sort((a, b) => {
      const aLast = a.last_launched ?? '';
      const bLast = b.last_launched ?? '';
      if (aLast !== bLast) {
        // Most-recently-launched first; empty strings (never launched) sort last.
        if (!aLast) return 1;
        if (!bLast) return -1;
        return bLast.localeCompare(aLast);
      }
      const aCreated = a.created ?? '';
      const bCreated = b.created ?? '';
      return bCreated.localeCompare(aCreated);
    });
    return copy;
  }, [homeCharacters]);

  const handleCompassClick = (): void => {
    setHomeTab('world');
    navigate({ kind: 'home' });
  };

  return (
    <>
      <nav className={styles.rail} aria-label="Primary">
        <div className={styles.cluster}>
          <RailButton
            active={homeActive}
            onClick={() => {
              setHomeTab('home');
              navigate({ kind: 'home' });
            }}
            title="Home"
            setHover={setHoverTip}
          >
            <RosterIcon size={22} />
          </RailButton>
          {/* World nav — directly under Home (mockup Sidebar parity). */}
          <RailButton
            active={worldActive}
            onClick={handleCompassClick}
            title="World"
            // Warm the World grid's first page while the pointer is still on
            // the icon, so the public characters are already loaded by the time
            // the tab opens instead of popping in after the local/default ones.
            onHoverStart={() => void useBrowseStore.getState().prefetch()}
            setHover={setHoverTip}
          >
            <CompassIcon size={22} />
          </RailButton>
        </div>

        <div className={styles.divider} aria-hidden="true" />

        {/*
          Avatar cluster: scrollable column of character circles followed by
          the round + (new) button. Keeping plus inside this cluster — and
          shrinking the cluster to content height — means it sits RIGHT under
          the last character instead of being pushed to the bottom of the rail
          by a flex spacer. (The World/compass nav moved up under Home.)
        */}
        <div className={styles.avatarCluster}>
          {sortedCharacters.map((c) => (
            <AvatarButton
              key={c.id}
              characterId={c.id}
              characterName={c.name}
              portraitImage={c.portrait_image}
              active={view.kind === 'character' && view.id === c.id}
              onClick={() => navigate({ kind: 'character', id: c.id })}
              theme={theme}
              setHover={setHoverTip}
            />
          ))}
          <button
            type="button"
            className={`${styles.circleButton} ${view.kind === 'add-character' ? styles.circleActive : ''}`}
            onClick={() => navigate({ kind: 'add-character' })}
            aria-label="New character"
            onMouseEnter={(e) => attachHover(e.currentTarget, 'New character', setHoverTip)}
            onMouseLeave={() => setHoverTip(null)}
            onFocus={(e) => attachHover(e.currentTarget, 'New character', setHoverTip)}
            onBlur={() => setHoverTip(null)}
          >
            <PlusIcon size={22} />
          </button>
        </div>

        <div className={styles.spacer} />

        <div className={styles.cluster}>
          {aiBackendKind === 'cloud-proxy' ? (
            <RailButton
              active={view.kind === 'credits'}
              onClick={() => navigate({ kind: 'credits' })}
              title={`Playtime · ${playtimeDisplay}`}
              setHover={setHoverTip}
            >
              <StarIcon size={22} />
            </RailButton>
          ) : (
            <RailButton
              onClick={handleCloudClick}
              title="Switch to cloud"
              setHover={setHoverTip}
            >
              {/* Same StarIcon as the cloud-proxy branch — consistent rail
                  iconography; only the click target differs (local → the
                  "Switch to cloud?" prompt). */}
              <StarIcon size={22} />
            </RailButton>
          )}
          <RailButton
            active={view.kind === 'settings'}
            onClick={() => navigate({ kind: 'settings' })}
            title="Settings"
            setHover={setHoverTip}
          >
            <SettingsIcon size={22} />
          </RailButton>
        </div>
      </nav>

      {/*
        Single shared floating tooltip. Lives outside the rail so it isn't
        clipped by .avatarCluster's overflow-y: auto (CSS forces overflow-x
        to clip when overflow-y is auto/scroll, so position:absolute children
        of the cluster were getting truncated on the right). position:fixed
        anchors to the viewport; we drop it ~88px from the left edge (rail
        width 80 + 8px gap) so the visual offset matches every button.
      */}
      {hoverTip ? (
        <div
          className={styles.railTooltipFloat}
          role="tooltip"
          style={{ top: hoverTip.y }}
        >
          {hoverTip.label}
        </div>
      ) : null}

      {showCloudPrompt ? (
        <div className={styles.scrim} role="dialog" aria-modal="true" aria-labelledby="cloud-prompt-title">
          <div className={styles.cloudPrompt}>
            <h2 id="cloud-prompt-title" className={styles.cloudPromptTitle}>Switch to cloud?</h2>
            <p className={styles.cloudPromptBody}>
              Sign in to use Sei&apos;s hosted AI. You keep your local characters either way.
            </p>
            <div className={styles.cloudPromptActions}>
              <Button
                kind="quiet"
                size="md"
                onClick={() => setShowCloudPrompt(false)}
              >
                Not now
              </Button>
              <Button
                kind="accent"
                size="md"
                onClick={() => {
                  setShowCloudPrompt(false);
                  setShowSignIn(true);
                  // Once sign-in lands, the effect above flips us to cloud.
                  setPendingCloudAfterSignIn(true);
                }}
              >
                Continue
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {showSignIn ? (
        <SignInModal
          framingLabel={null}
          onClose={() => setShowSignIn(false)}
        />
      ) : null}

      {/* Signed-in BYOK → cloud switch (no sign-in re-prompt). Same confirm
          modal Settings uses; on confirm we flip the backend live + land on
          the Playtime/credits screen. */}
      {showSwitchConfirm ? (
        <SwitchBackendConfirmModal
          direction="cloud-proxy"
          onCancel={() => setShowSwitchConfirm(false)}
          onConfirm={async () => {
            await switchToCloud();
            setShowSwitchConfirm(false);
          }}
        />
      ) : null}
    </>
  );
}
