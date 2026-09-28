/**
 * BackseatGameModal (260929): what a backseat game tile (Roblox) opens.
 *
 * A backseat game is not a surface of its own. It is the ordinary screen share
 * with three extras, and this modal is the first two:
 *
 *   1. INTRO, once per game per account (backseatGamePref): the tile leads
 *      into a screen share, and a player who clicked "Roblox" expecting the
 *      companion to join their game needs to be told that before a window
 *      picker appears. Either button retires it.
 *   2. PICK, when the game has a lookup provider: "which game are you
 *      playing?" by pasted link or search, with a popular list underneath.
 *      Entirely optional (Skip). What was picked crosses to main as ids only;
 *      main fetches the details itself and puts them in the prompt.
 *
 * Then it hands over to ShareScreenModal with the selection, which preselects
 * the game's window and passes the selection into the share. From there the
 * flow is the normal backseat share, unchanged.
 *
 * Search is run on submit only (Enter or the Search button), never per
 * keystroke: Roblox's search endpoint allows about one request a minute per
 * address, and main answers from the popular list when it is rate limited.
 * A pasted link is the reliable path and the copy says so.
 *
 * Analytics: `backseat_game_selected {game, has_specific_game, source}` where
 * source is link | search | popular | skip. The typed text is never sent;
 * the picked game's universe id is.
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useBackseatStore } from '../../lib/stores/useBackseatStore';
import { backseatGameIntroSeen, markBackseatGameIntroSeen } from '../../lib/backseatGamePref';
import {
  backseatGame,
  looksLikeLink,
  type BackseatGameInfo,
  type BackseatGameResolveResult,
  type BackseatGameSelection,
  type BackseatGameSource,
} from '../../../../shared/backseatGames';
import { ModalShell, ModalFooter } from '../ModalShell';
import { Button } from '../Button';
import { TextField } from '../TextField';
import { useT } from '../../lib/i18n';
import styles from './BackseatGameModal.module.css';

export interface BackseatGameModalProps {
  characterId: string;
  gameId: string;
}

type Step = 'intro' | 'pick';

/** Where the list under the search box came from. */
type ListKind = 'popular' | 'results';

export function BackseatGameModal({
  characterId,
  gameId,
}: BackseatGameModalProps): React.ReactElement | null {
  const t = useT();
  const def = backseatGame(gameId);
  const closeModal = useUiStore((s) => s.closeModal);
  const openModal = useUiStore((s) => s.openModal);
  const companionName =
    useDataStore((s) => s.characters.find((c) => c.id === characterId)?.name) ??
    t('Your companion');

  const [step, setStep] = useState<Step>(() =>
    backseatGameIntroSeen(gameId) ? 'pick' : 'intro',
  );

  /** Hand over to the share picker. Stops a share already running for this
   *  companion first: the new one replaces it, and main would end the old
   *  session anyway, but the renderer's capture must not be left running. */
  const proceed = async (
    picked: BackseatGameInfo | null,
    source: BackseatGameSource,
  ): Promise<void> => {
    if (!def) return;
    sei.track('backseat_game_selected', {
      game: def.id,
      has_specific_game: picked !== null,
      source,
      universe_id: picked?.universeId ?? null,
    });
    const sel: BackseatGameSelection = {
      gameId: def.id,
      ...(picked ? { universeId: picked.universeId } : {}),
    };
    const bs = useBackseatStore.getState();
    if (bs.sharingFor === characterId) await bs.stopSharing();
    openModal({ kind: 'share-screen', characterId, game: sel });
  };

  // A game with no lookup provider goes straight from the intro to the share.
  const skipPick = !def?.lookup;
  useEffect(() => {
    if (def && step === 'pick' && skipPick) void proceed(null, 'skip');
    // Runs when the step lands on 'pick'; proceed is stable enough for this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, skipPick]);

  if (!def) return null;

  if (step === 'intro') {
    const finishIntro = (next: 'continue' | 'close'): void => {
      markBackseatGameIntroSeen(def.id);
      if (next === 'close') closeModal();
      else setStep('pick');
    };
    return (
      <ModalShell title={t(def.name)} width={440} onClose={() => finishIntro('close')}>
        <div className={styles.intro}>
          <div className={styles.introArt} style={{ backgroundImage: `url(${def.image})` }} />
          <p className={styles.introText}>{t(def.introCopy)}</p>
        </div>
        <ModalFooter>
          <Button kind="quiet" size="md" onClick={() => finishIntro('close')}>
            {t('Not now')}
          </Button>
          <Button size="md" onClick={() => finishIntro('continue')}>
            {t('Continue')}
          </Button>
        </ModalFooter>
      </ModalShell>
    );
  }

  if (skipPick) return null;

  return (
    <PickStep
      gameId={def.id}
      gameName={def.name}
      companionName={companionName}
      onClose={closeModal}
      onDone={(picked, source) => void proceed(picked, source)}
    />
  );
}

function PickStep({
  gameId,
  gameName,
  companionName,
  onClose,
  onDone,
}: {
  gameId: string;
  gameName: string;
  companionName: string;
  onClose: () => void;
  onDone: (picked: BackseatGameInfo | null, source: BackseatGameSource) => void;
}): React.ReactElement {
  const t = useT();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [popular, setPopular] = useState<BackseatGameInfo[] | null>(null);
  const [results, setResults] = useState<BackseatGameInfo[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ game: BackseatGameInfo; source: BackseatGameSource } | null>(
    null,
  );
  // The latest request wins: a slow search must not overwrite a newer one.
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await sei.backseatGamePopular(gameId);
        if (alive) setPopular(list);
      } catch {
        if (alive) setPopular([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [gameId]);

  /** Pick a game and fill in its details (genre, description) in place. */
  const pick = (game: BackseatGameInfo, source: BackseatGameSource): void => {
    setPicked({ game, source });
    if (game.genre !== undefined || game.description !== undefined) return;
    const id = ++seq.current;
    void (async () => {
      try {
        const full = await sei.backseatGameDetails(gameId, game.universeId);
        if (full && id === seq.current) {
          setPicked((cur) =>
            cur && cur.game.universeId === full.universeId
              ? { game: { ...cur.game, ...full, iconUrl: full.iconUrl ?? cur.game.iconUrl }, source }
              : cur,
          );
        }
      } catch {
        /* the card just shows what it has */
      }
    })();
  };

  const submit = async (): Promise<void> => {
    const input = query.trim();
    if (!input || busy) return;
    const id = ++seq.current;
    setBusy(true);
    setError(null);
    setNote(null);
    let res: BackseatGameResolveResult;
    try {
      res = await sei.backseatGameResolve(gameId, input);
    } catch {
      res = { kind: 'error', code: 'network' };
    }
    if (id !== seq.current) return;
    setBusy(false);
    if (res.kind === 'game') {
      setResults(null);
      pick(res.game, 'link');
      return;
    }
    if (res.kind === 'error') {
      setError(
        res.code === 'bad_link'
          ? t('That link is not a {game} game link. Copy the link from the game page.', {
              game: gameName,
            })
          : res.code === 'not_found'
            ? t('Could not find that game. Check the link and try again.')
            : t('Could not reach {game} right now. You can skip this and play anyway.', {
                game: gameName,
              }),
      );
      return;
    }
    setResults(res.results);
    if (res.fallback) {
      setNote(
        t(
          '{game} search is busy right now, so these are matches from popular games. Pasting the game link always works.',
          { game: gameName },
        ),
      );
    }
  };

  const listKind: ListKind = results ? 'results' : 'popular';
  const list = results ?? popular;
  const linkish = looksLikeLink(query);

  return (
    <ModalShell
      title={t('Which {game} game are you playing?', { game: gameName })}
      width={520}
      onClose={onClose}
    >
      <div className={styles.root}>
        <p className={styles.sub}>
          {t('Optional. {name} will know a bit about it before you start.', {
            name: companionName,
          })}
        </p>

        {picked ? (
          <div className={styles.picked}>
            <GameIcon game={picked.game} large />
            <div className={styles.pickedBody}>
              <span className={styles.pickedName}>{picked.game.name}</span>
              <span className={styles.meta}>
                {[
                  picked.game.creator ? t('by {creator}', { creator: picked.game.creator }) : null,
                  picked.game.genre ?? null,
                  picked.game.playing !== undefined
                    ? t('{count} playing', { count: compact(picked.game.playing) })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {picked.game.description ? (
                <span className={styles.pickedDesc}>{picked.game.description}</span>
              ) : null}
            </div>
            <Button kind="quiet" size="sm" onClick={() => setPicked(null)}>
              {t('Change')}
            </Button>
          </div>
        ) : (
          <>
            <div className={styles.searchRow}>
              <div className={styles.field}>
                <TextField
                  value={query}
                  onChange={(v) => {
                    setQuery(v);
                    if (!v.trim()) {
                      setResults(null);
                      setNote(null);
                      setError(null);
                    }
                  }}
                  onEnter={() => void submit()}
                  placeholder={t('Paste a {game} link or search by name', { game: gameName })}
                  aria-label={t('Paste a {game} link or search by name', { game: gameName })}
                  autoFocus
                />
              </div>
              <Button
                kind="ghost"
                size="md"
                onClick={() => void submit()}
                disabled={!query.trim() || busy}
              >
                {busy ? t('Searching...') : linkish ? t('Look up') : t('Search')}
              </Button>
            </div>

            {error ? <p className={styles.error}>{error}</p> : null}
            {note ? <p className={styles.note}>{note}</p> : null}

            <div className={styles.listHead}>
              {listKind === 'results' ? t('Results') : t('Popular right now')}
            </div>
            <div className={styles.list}>
              {list === null ? (
                <p className={styles.empty}>{t('Loading...')}</p>
              ) : list.length === 0 ? (
                <p className={styles.empty}>
                  {listKind === 'results'
                    ? t('No games found. Try pasting the game link instead.')
                    : t('Could not load popular games. You can still paste a link.')}
                </p>
              ) : (
                list.map((g) => (
                  <button
                    key={g.universeId}
                    type="button"
                    className={styles.row}
                    onClick={() => pick(g, listKind === 'results' ? 'search' : 'popular')}
                  >
                    <GameIcon game={g} />
                    <span className={styles.rowBody}>
                      <span className={styles.rowName}>{g.name}</span>
                      <span className={styles.meta}>
                        {[
                          g.creator ? t('by {creator}', { creator: g.creator }) : null,
                          g.playing !== undefined
                            ? t('{count} playing', { count: compact(g.playing) })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>
      <ModalFooter>
        <Button kind="quiet" size="md" onClick={() => onDone(null, 'skip')}>
          {t('Skip')}
        </Button>
        <Button
          size="md"
          disabled={!picked}
          onClick={() => picked && onDone(picked.game, picked.source)}
        >
          {t('Continue')}
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}

function GameIcon({
  game,
  large,
}: {
  game: BackseatGameInfo;
  large?: boolean;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const cls = `${styles.icon} ${large ? styles.iconLarge : ''}`;
  if (!game.iconUrl || failed) {
    return (
      <span className={`${cls} ${styles.iconBlank}`} aria-hidden="true">
        {game.name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className={cls}
      src={game.iconUrl}
      alt=""
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** 1234 -> "1.2K", 1234567 -> "1.2M". Numbers only, so no translation. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
