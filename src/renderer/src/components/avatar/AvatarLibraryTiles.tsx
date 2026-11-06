/**
 * Avatar library tiles (261106), the "Avatars" block of the edit modal's
 * Appearance section. One tile per server-stored avatar (her card image, any
 * extra portraits, Live2D/rig models), each with a public/private lock and a
 * default pick. Design: docs/agents/avatar-library.md.
 *
 * The public rule (a public character keeps at least one public avatar) is
 * enforced by the server; here the last public lock is disabled with a
 * tooltip so the user never hits the refusal. Opening the block runs the
 * owner sync (card image and a local model not uploaded yet go up).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import { PlusIcon, StarIcon, TrashIcon } from '../icons';
import {
  isLastPublicLock,
  type AvatarItem,
  type AvatarLibraryError,
  type AvatarLibraryResult,
  type AvatarLibraryView,
} from '@shared/avatarLibrary';
import styles from './AvatarLibraryTiles.module.css';

export interface AvatarLibraryTilesProps {
  characterId: string;
  /** Her public flag as the app knows it: a change re-reads the library (the server may have published an avatar). */
  characterShared?: boolean;
}

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';
const MODEL_ACCEPT = '.zip,application/zip';

function LockGlyph({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x={5} y={11} width={14} height={9} rx={1.5} />
      {open ? <path d="M8 11V8a4 4 0 0 1 7.5-2" /> : <path d="M8 11V8a4 4 0 0 1 8 0v3" />}
    </svg>
  );
}

const ERROR_TEXT: Partial<Record<AvatarLibraryError, string>> = {
  offline: "You're offline. Avatar changes need a connection.",
  signed_out: 'Sign in to change avatars.',
  too_big: 'That file is too big.',
  too_many: 'This companion has the most avatars it can hold. Delete one first.',
  quota: 'Your avatar storage is full. Delete an avatar first.',
  last_public: 'A public companion needs at least one public avatar.',
  not_shareable: 'This avatar did not pass review, so it cannot be public.',
  card_avatar: 'The card image stays an avatar. Change the card image instead.',
  bad_content: 'That file is not a supported image or model.',
  bad_kind: 'That file is not a supported image or model.',
  import_failed: 'That model could not be read. Check it is a Live2D or rig zip.',
  rate_limited: 'Too many changes at once. Try again in a minute.',
};

export function AvatarLibraryTiles({ characterId, characterShared }: AvatarLibraryTilesProps): React.ReactElement | null {
  const t = useT();
  const [view, setView] = useState<AvatarLibraryView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AvatarLibraryError | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const first = useRef(true);

  useEffect(() => {
    let live = true;
    const sync = first.current;
    first.current = false;
    void window.sei
      .avatarLibraryList(characterId, sync ? { sync: true } : { fresh: true })
      .then((v) => {
        if (live) setView(v);
      })
      .catch(() => {});
    const off = window.sei.onAvatarLibrary((u) => {
      if (u.characterId === characterId) setView(u.view);
    });
    return () => {
      live = false;
      off();
    };
  }, [characterId, characterShared]);

  const run = useCallback(
    async (key: string, op: () => Promise<AvatarLibraryResult>) => {
      setBusy(key);
      setError(null);
      try {
        const r = await op();
        if (r.ok) setView(r.view);
        else {
          setError(r.error);
          // A refusal still means the tiles may be stale: show the truth.
          void window.sei.avatarLibraryList(characterId, { fresh: true }).then(setView).catch(() => {});
        }
      } catch {
        setError('server');
      } finally {
        setBusy(null);
      }
    },
    [characterId],
  );

  const onFile = (kind: 'image' | 'model') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const bytes = await file.arrayBuffer();
    if (kind === 'image') {
      const name = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 80) || null;
      await run('add', () => window.sei.avatarLibraryAddImage(characterId, bytes, name));
    } else {
      await run('add', () => window.sei.avatarLibraryAddModel(characterId, bytes));
    }
  };

  if (!view) return <p className={styles.hint}>{t('Loading avatars…')}</p>;
  if (view.state === 'none' || !view.list) {
    return <p className={styles.hint}>{t('Avatars are stored once this companion is saved to your account.')}</p>;
  }
  const list = view.list;
  const max = list.limits?.max_per_character ?? 8;
  const full = list.avatars.length >= max;

  const kindLabel = (a: AvatarItem): string =>
    a.kind === 'live2d' ? 'Live2D' : a.kind === 'rig' ? t('Rigged model') : t('Image');

  return (
    <div className={styles.wrap}>
      <p className={styles.hint}>
        {t('How they appear in SeiLink and on calls. Public avatars are shared with everyone who adds this companion.')}
      </p>
      <div className={styles.grid} role="list">
        {list.avatars.map((a) => {
          const isDefault = a.id === list.default_id;
          const lastPublic = isLastPublicLock(list, a);
          const lockLabel = lastPublic
            ? t('A public companion needs at least one public avatar.')
            : a.is_public
              ? t('Public. Click to make private.')
              : t('Private. Click to make public.');
          const tileBusy = busy === a.id;
          return (
            <div key={a.id} role="listitem" className={`${styles.tile} ${isDefault ? styles.tileDefault : ''}`} aria-busy={tileBusy}>
              <div className={styles.thumb}>
                {a.kind === 'portrait' && a.url ? (
                  <img src={a.url} alt="" className={styles.img} draggable={false} />
                ) : (
                  <span className={styles.kindMark}>{kindLabel(a)}</span>
                )}
                {a.moderation === 'pending' || a.moderation === 'needs_review' ? (
                  <span className={styles.tag}>{t('In review')}</span>
                ) : a.moderation === 'flagged' ? (
                  <span className={`${styles.tag} ${styles.tagBad}`}>{t('Hidden')}</span>
                ) : a.source === 'card' ? (
                  <span className={styles.tag}>{t('Card image')}</span>
                ) : null}
                {isDefault ? <span className={styles.defaultChip}>{t('Default')}</span> : null}
                {a.source !== 'card' ? (
                  <button
                    type="button"
                    className={styles.del}
                    aria-label={t('Delete avatar')}
                    title={t('Delete avatar')}
                    disabled={busy !== null}
                    onClick={() => void run(a.id, () => window.sei.avatarLibraryRemove(characterId, a.id))}
                  >
                    <TrashIcon size={12} />
                  </button>
                ) : null}
              </div>
              <div className={styles.bar}>
                <span className={styles.lockWrap}>
                  <button
                    type="button"
                    className={`${styles.icon} ${a.is_public ? styles.on : ''}`}
                    aria-label={lockLabel}
                    aria-pressed={a.is_public}
                    aria-disabled={lastPublic || busy !== null}
                    onClick={() => {
                      if (lastPublic || busy !== null) return;
                      void run(a.id, () => window.sei.avatarLibrarySetFlags(characterId, a.id, { is_public: !a.is_public }));
                    }}
                  >
                    <LockGlyph open={a.is_public} />
                  </button>
                  <span className={styles.tip} role="tooltip">
                    {lockLabel}
                  </span>
                </span>
                <span className={styles.name} title={a.name ?? kindLabel(a)}>
                  {a.name ?? kindLabel(a)}
                </span>
                <button
                  type="button"
                  className={`${styles.icon} ${isDefault ? styles.on : ''}`}
                  aria-label={isDefault ? t('Default avatar') : t('Make default')}
                  title={isDefault ? t('Default avatar') : t('Make default')}
                  aria-pressed={isDefault}
                  disabled={busy !== null}
                  onClick={() => {
                    if (!isDefault) void run(a.id, () => window.sei.avatarLibrarySetFlags(characterId, a.id, { is_default: true }));
                  }}
                >
                  <StarIcon size={13} />
                </button>
              </div>
            </div>
          );
        })}
        {!full ? (
          <div className={styles.addTile} role="listitem">
            <button type="button" className={styles.add} disabled={busy !== null} onClick={() => imageInput.current?.click()}>
              <PlusIcon size={14} />
              <span>{t('Add image')}</span>
            </button>
            <button type="button" className={styles.add} disabled={busy !== null} onClick={() => modelInput.current?.click()}>
              <PlusIcon size={14} />
              <span>{t('Add model')}</span>
            </button>
          </div>
        ) : null}
      </div>
      {busy === 'add' ? <p className={styles.hint}>{t('Uploading…')}</p> : null}
      {error ? (
        <p className={styles.err} role="alert">
          {t(ERROR_TEXT[error] ?? 'Something went wrong with avatars. Try again.')}
        </p>
      ) : null}
      <input ref={imageInput} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => void onFile('image')(e)} />
      <input ref={modelInput} type="file" accept={MODEL_ACCEPT} hidden onChange={(e) => void onFile('model')(e)} />
    </div>
  );
}

/**
 * The viewer's own pick (261106), on the character page's Avatar tab: for a
 * character someone else made public with more than one public avatar, pick
 * which one plays for you. Owners manage avatars in the edit modal instead.
 */
export function AvatarLibraryPicker({ characterId }: { characterId: string }): React.ReactElement | null {
  const t = useT();
  const [view, setView] = useState<AvatarLibraryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AvatarLibraryError | null>(null);

  useEffect(() => {
    let live = true;
    void window.sei
      .avatarLibraryList(characterId, { sync: true })
      .then((v) => {
        if (live) setView(v);
      })
      .catch(() => {});
    const off = window.sei.onAvatarLibrary((u) => {
      if (u.characterId === characterId) setView(u.view);
    });
    return () => {
      live = false;
      off();
    };
  }, [characterId]);

  const list = view?.list;
  if (!list || list.is_owner || list.avatars.length < 2) return null;

  const pick = async (id: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await window.sei.avatarLibraryPick(characterId, id);
      if (r.ok) setView(r.view);
      else setError(r.error);
    } catch {
      setError('server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <p className={styles.hint}>{t('Pick which avatar plays for you.')}</p>
      <div className={styles.grid} role="radiogroup" aria-label={t('Avatars')}>
        {list.avatars.map((a) => {
          const on = a.id === view!.effective_id;
          const label = a.kind === 'live2d' ? 'Live2D' : a.kind === 'rig' ? t('Rigged model') : t('Image');
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`${styles.tile} ${styles.pickTile} ${on ? styles.tileDefault : ''}`}
              disabled={busy}
              onClick={() => {
                if (!on) void pick(a.id === list.default_id ? null : a.id);
              }}
            >
              <span className={styles.thumb}>
                {a.kind === 'portrait' && a.url ? (
                  <img src={a.url} alt="" className={styles.img} draggable={false} />
                ) : (
                  <span className={styles.kindMark}>{label}</span>
                )}
              </span>
              <span className={styles.bar}>
                <span className={styles.name}>{a.id === list.default_id ? t('Default avatar') : (a.name ?? label)}</span>
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p className={styles.err} role="alert">
          {t(ERROR_TEXT[error] ?? 'Something went wrong with avatars. Try again.')}
        </p>
      ) : null}
    </div>
  );
}
