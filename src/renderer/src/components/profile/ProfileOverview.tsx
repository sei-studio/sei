/**
 * ProfileOverview (product call 261110): what a player sees first on a
 * companion they do not own (a built-in like Sui, or someone else's World
 * companion). It leads with who it is, not with settings rows:
 *
 *   - ProfileIntro: the description (the creator's words, boxed as user
 *     text, see UserText) and its voice, with a play button (VoiceSample:
 *     the bundled clip, no TTS spend, for every pool voice). The page passes
 *     it as `intro`, at the top of this tab.
 *   - a quiet Report link for someone else's companion.
 *
 * The big portrait is the page's art, and its public avatars open from a
 * button on the portrait's corner (ProfileAvatars). The name, share code,
 * creator and created date are the page header. There is no games list:
 * every companion plays every game (profile v3). Nothing here edits the
 * companion: an owner's controls never show on a companion you do not own.
 * The few settings that are yours for it live on the "Your settings" and
 * More tabs (ProfileSettings).
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import type { Character } from '@shared/characterSchema';
import type { AvatarItem } from '@shared/avatarLibrary';
import type { CharacterOverviewInfo } from '@shared/ipc';
import { NO_VOICE_ID, ownVoiceOf } from '@shared/voiceIds';
import { FlagIcon } from '../icons';
import { useVoiceLabel } from './ProfileSettings';
import { UserText } from './UserText';
import { VoiceSampleButton, type SampleResult } from './VoiceSample';
import styles from './ProfileOverview.module.css';

export interface ProfileIntroProps {
  character: Character;
  /** chars:overview-info; null while loading or when it failed. */
  info: CharacterOverviewInfo | null;
  onSample: (r: SampleResult) => void;
}

/** The description, then the voice line (play button + who it sounds like). */
export function ProfileIntro(p: ProfileIntroProps): React.ReactElement {
  const { character } = p;
  const description = character.description?.trim() || '';
  // Someone else's own ElevenLabs voice cannot play for you: the label names
  // the Sei voice you hear instead (the sample plays that one too).
  const label = useVoiceLabel(character, { borrowed: !!ownVoiceOf(character.metadata) });
  const silent = character.metadata?.voiceId === NO_VOICE_ID;
  return (
    <div className={styles.intro} data-ov="intro">
      {description ? <UserText text={description} lines={6} size="lg" data-ov="description" /> : null}
      <div className={styles.voice} data-ov="voice">
        {silent ? null : (
          <VoiceSampleButton character={character} sampleVoiceId={p.info?.sampleVoiceId} onResult={p.onSample} />
        )}
        <span className={styles.voiceLabel}>{label}</span>
      </div>
    </div>
  );
}

export interface ProfileOverviewProps {
  character: Character;
  /** Show the Report link (someone else's companion). */
  canReport: boolean;
  onReport: () => void;
  /** ProfileIntro, which this tab leads with. */
  intro?: React.ReactNode;
}

export function ProfileOverview(p: ProfileOverviewProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  return (
    <div className={styles.overview} data-overview="true">
      {p.intro ?? null}
      {p.canReport ? (
        <button
          type="button"
          className={styles.report}
          onClick={p.onReport}
          aria-label={t('Report {name}', { name: character.name })}
        >
          <FlagIcon size={12} />
          <span>{t('Report')}</span>
        </button>
      ) : null}
    </div>
  );
}

// ── Avatars: a corner button on the portrait + a small popover ───────────

/** Its avatars from the library; [] until read. */
function useAvatarList(characterId: string): AvatarItem[] {
  const [avatars, setAvatars] = useState<{ id: string; list: AvatarItem[] } | null>(null);
  useEffect(() => {
    let live = true;
    void sei
      .avatarLibraryList(characterId)
      .then((v) => {
        if (live) setAvatars({ id: characterId, list: v?.list?.avatars ?? [] });
      })
      .catch(() => {});
    const off = sei.onAvatarLibrary?.((u) => {
      if (u.characterId === characterId) setAvatars({ id: characterId, list: u.view?.list?.avatars ?? [] });
    });
    return () => {
      live = false;
      off?.();
    };
  }, [characterId]);
  return avatars && avatars.id === characterId ? avatars.list : [];
}

const POP_GAP = 8;
const POP_MARGIN = 8;

export interface ProfileAvatarsButtonProps {
  character: Character;
  /** The portrait corner's button look (CharacterPage .artExpandBtn). */
  className: string;
  onOpen?: () => void;
}

/**
 * The portrait corner's Avatars button (profile v3, replacing the Overview's
 * Avatars shelf): opens a small popover above it with the companion's
 * public avatars beyond the card image (which the portrait already is) as
 * picture tiles, and is not shown when there are none.
 */
export function ProfileAvatarsButton({ character, className, onOpen }: ProfileAvatarsButtonProps): React.ReactElement | null {
  const t = useT();
  const popId = useId();
  const avatars = useAvatarList(character.id);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setOpen(false), [character.id]);

  // Right above the corner (its right edge on the corner's), inside the window.
  useLayoutEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    const el = popRef.current;
    if (!btn || !el) return;
    const anchor = (btn.closest('[data-art-corner]') as HTMLElement | null) ?? btn;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const left = Math.max(POP_MARGIN, Math.min(r.right - w, window.innerWidth - w - POP_MARGIN));
    el.style.left = `${Math.round(left)}px`;
    el.style.bottom = `${Math.round(window.innerHeight - r.top + POP_GAP)}px`;
    el.style.visibility = 'visible';
    el.focus();
  }, [open]);

  // Closes on a click outside, Escape (focus back on the button) or a resize.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    const onResize = (): void => setOpen(false);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // The card image is the portrait itself: the popover shows the others.
  const extra = avatars.filter((a) => a.source !== 'card');
  if (extra.length === 0) return null;
  const label = t('Avatars');
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-haspopup="dialog"
        data-tip={open ? undefined : label}
        data-tip-edge="right"
        data-avatars-btn="true"
      >
        <AvatarsIcon size={16} />
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              id={popId}
              role="dialog"
              aria-label={label}
              tabIndex={-1}
              className={styles.avatarsPop}
              style={{ visibility: 'hidden' }}
              data-avatars-pop="true"
            >
              <ul className={styles.avatarTiles}>
                {extra.map((a) => {
                  const kindLabel = a.kind === 'live2d' ? 'Live2D' : a.kind === 'rig' ? t('Rigged model') : t('Image');
                  // Most avatars arrive without a name: the tile is the
                  // picture (or its kind), with a caption only when named.
                  return (
                    <li key={a.id} className={styles.avatar} title={a.name ?? kindLabel}>
                      <span className={styles.avatarArt}>
                        {a.kind === 'portrait' && a.url ? (
                          <img src={a.url} alt={a.name ?? kindLabel} draggable={false} />
                        ) : (
                          <span className={styles.avatarKind}>{kindLabel}</span>
                        )}
                      </span>
                      {a.name ? <span className={styles.avatarName}>{a.name}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Two stacked portrait cards: the companion's avatars. */
function AvatarsIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x={8} y={3} width={13} height={16} rx={1.5} />
      <path d="M5 7v12.5A1.5 1.5 0 0 0 6.5 21H16" />
      <circle cx={14.5} cy={9} r={2.4} />
      <path d="M11 16a3.5 3.5 0 0 1 7 0" />
    </svg>
  );
}
