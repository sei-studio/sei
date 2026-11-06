/**
 * RegenHint (261107): the one-time "Not happy with the look? Regenerate"
 * coachmark on a companion's profile. The rules (once per player, who is
 * eligible, what suppresses it, analytics) live in lib/regenHintPref.ts.
 *
 * It sits inside the profile's settings-gear wrapper and hangs ABOVE the gear
 * with its tail pointing down at it, because "Card image" (versions +
 * Regenerate) lives in that gear's menu. The card's own Regenerate button
 * opens the card image popup directly.
 *
 * Dismissed by: its close button, its Regenerate button, or a press anywhere
 * else (the gear included: the menu then opens as usual). Escape counts as the
 * close button. If the page goes away while it is up, that is reported as
 * 'outside': the player moved on without using it.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';
import { sei } from '../lib/ipcClient';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useTutorialStore } from '../lib/stores/useTutorialStore';
import { useFirstMomentStore } from '../lib/stores/useFirstMomentStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useSeilinkStore } from '../lib/stores/useSeilinkStore';
import { portraitSrc } from '../lib/portraitSrc';
import {
  isRegenHintEligible,
  markRegenHintSeen,
  regenHintSeen,
  shouldShowRegenHint,
  trackRegenHintDismissed,
  trackRegenHintRegenerateClicked,
  trackRegenHintShown,
  type RegenHintDismissHow,
} from '../lib/regenHintPref';
import type { Character } from '@shared/characterSchema';
import { CloseIcon, SparkleIcon } from './icons';
import styles from './RegenHint.module.css';

/** Let the page's slide-in (0.5s) finish before the card appears. */
const SHOW_DELAY_MS = 700;

export interface RegenHintController {
  show: boolean;
  dismiss: (how: RegenHintDismissHow) => void;
  /** The card's Regenerate: count it, retire the hint. The caller opens the popup. */
  regenerate: () => void;
}

/**
 * The hint's state for one profile. Called above CharacterPage's early
 * returns, so `character` may still be undefined.
 */
export function useRegenHint(input: {
  character: Character | undefined;
  /** Any of the page's own popups or the gear menu is open. */
  pageOverlayOpen: boolean;
  leaving: boolean;
}): RegenHintController {
  const { character } = input;
  const authState = useAuthStore((s) => s.state);
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  const tutorialActive = useTutorialStore((s) => s.active);
  const firstMomentLive = useFirstMomentStore(
    (s) => s.status === 'armed' || s.status === 'greeting' || s.status === 'ready',
  );
  const appModalOpen = useUiStore((s) => s.modal !== null);
  const seilinkOpen = useSeilinkStore((s) => s.flow !== null || s.intro !== null);

  // Per account: an account switch re-reads the flag.
  const [seen, setSeen] = useState<boolean>(regenHintSeen);
  useEffect(() => {
    setSeen(regenHintSeen());
  }, [currentUserId]);

  const hasPortrait = !!portraitSrc(character?.portrait_image);
  const ownedAndSignedIn =
    !!character &&
    isRegenHintEligible({ character, currentUserId, hasPortrait, regensLeft: 1 });

  // Regenerations left, read only while the hint could still show here.
  const characterId = character?.id ?? null;
  const [regens, setRegens] = useState<{ id: string; left: number } | null>(null);
  useEffect(() => {
    if (seen || !ownedAndSignedIn || !characterId) return;
    let cancelled = false;
    void sei
      .charsPortraitVersions(characterId)
      .then((st) => {
        if (cancelled || !st) return;
        setRegens({ id: characterId, left: Math.max(0, st.regenLimit - st.regenCount) });
      })
      .catch(() => {
        /* unknown = not eligible this time */
      });
    return () => {
      cancelled = true;
    };
  }, [seen, ownedAndSignedIn, characterId]);
  const regensLeft = regens && regens.id === characterId ? regens.left : null;

  const eligible =
    !!character && isRegenHintEligible({ character, currentUserId, hasPortrait, regensLeft });
  const candidate = shouldShowRegenHint({
    seen,
    eligible,
    tutorialActive,
    firstMomentLive,
    overlayOpen: input.pageOverlayOpen || appModalOpen || seilinkOpen,
    leaving: input.leaving,
  });

  // null = not up; a number = when it went up.
  const [shownAt, setShownAt] = useState<number | null>(null);
  const shownRef = useRef<{ at: number } | null>(null);
  const kindRef = useRef<{ kind: string; left: number }>({ kind: 'custom', left: 0 });
  useEffect(() => {
    if (!candidate || shownAt !== null || !character || regensLeft === null) return;
    const kind = character.kind ?? 'custom';
    const left = regensLeft;
    const timer = window.setTimeout(() => {
      // Used up the moment it shows: once per player, ever.
      markRegenHintSeen();
      const at = Date.now();
      shownRef.current = { at };
      kindRef.current = { kind, left };
      setShownAt(at);
      trackRegenHintShown(kind, left);
    }, SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [candidate, shownAt, character, regensLeft]);

  const dismiss = useCallback((how: RegenHintDismissHow): void => {
    const shown = shownRef.current;
    if (!shown) return;
    shownRef.current = null;
    setShownAt(null);
    setSeen(true);
    trackRegenHintDismissed(how, Date.now() - shown.at);
  }, []);

  const regenerate = useCallback((): void => {
    if (!shownRef.current) return;
    trackRegenHintRegenerateClicked(kindRef.current.kind, kindRef.current.left);
    dismiss('regenerate');
  }, [dismiss]);

  // Leaving the page with the hint up: the player moved on without using it.
  useEffect(
    () => () => {
      const shown = shownRef.current;
      if (!shown) return;
      shownRef.current = null;
      trackRegenHintDismissed('outside', Date.now() - shown.at);
    },
    [],
  );

  return { show: shownAt !== null, dismiss, regenerate };
}

export interface RegenHintProps {
  onClose: () => void;
  onOutside: () => void;
  onRegenerate: () => void;
}

/** The card. Render it inside the anchor's position:relative wrapper. */
export function RegenHint({ onClose, onOutside, onRegenerate }: RegenHintProps): React.ReactElement {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  // Centre the tail on the anchor (the wrapper is exactly the gear button).
  const [tailRight, setTailRight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement;
    if (!anchor) return;
    setTailRight(anchor.getBoundingClientRect().width / 2);
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, onOutside]);

  return (
    <div ref={ref} className={styles.hint} role="dialog" aria-label={t('Not happy with the look?')}>
      <span
        className={styles.tail}
        aria-hidden="true"
        style={tailRight !== null ? { right: `calc(${tailRight}px + var(--regen-hint-overhang) - 7px)` } : undefined}
      />
      <div className={styles.row}>
        <span className={styles.icon} aria-hidden="true">
          <SparkleIcon size={14} />
        </span>
        <p className={styles.line}>{t('Not happy with the look?')}</p>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t('Close')}>
          <CloseIcon size={14} />
        </button>
      </div>
      <button type="button" className={styles.regen} onClick={onRegenerate}>
        {t('Regenerate')}
      </button>
    </div>
  );
}
