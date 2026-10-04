/**
 * BackseatGameModal (260929): what a backseat game tile (Roblox) opens.
 *
 * A backseat game is not a surface of its own. It is the ordinary screen share
 * with three extras, and this modal is the first two:
 *
 *   1. INTRO, once per game per account (backseatGamePref): the tile leads
 *      into a screen share, and a player who clicked "Roblox" expecting the
 *      companion to join their game needs to be told that first. Either
 *      button retires it.
 *   2. PICK, when the game has a lookup provider: which game you are about
 *      to play. Entirely optional (skip). What was picked crosses to main as
 *      ids only; main fetches the details itself and puts them in the prompt.
 *
 * Then it hands over to ShareScreenModal with the selection. For a game with
 * `autoShare` that is not a picker any more (261004): it checks Screen
 * Recording, then starts the call and WAITS for the game's window, capturing
 * it on its own (useBackseatStore.startWatch).
 *
 * PICK (261004 redesign, Shawn: "too much text and corporate"; then 261004
 * again: "remove the profile pic and message line, just put play Roblox").
 * A plain "Play Roblox" title, a search pill, and the games as a grid of big
 * 16:9 screenshots. Tapping one picks it: the card lights up for a beat and
 * the step moves straight on, with no Continue button and no description.
 * No results, a bad link and being offline are one plain line in the grid
 * area; search results need no header.
 *
 * Search is run on Enter only, never per keystroke: Roblox's search endpoint
 * allows about one request a minute per address, so as-you-type search would
 * spend that minute on "jai" and answer "jailbreak" from the fallback pool.
 * A pasted link resolves the moment it is pasted (no rate limit there) and
 * counts as picking that game.
 *
 * Analytics: `backseat_game_selected {game, has_specific_game, source}` where
 * source is link | search | popular | skip. The typed text is never sent;
 * the picked game's universe id is.
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useUiStore } from '../../lib/stores/useUiStore';
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
import { CloseIcon, SearchIcon } from '../icons';
import { useT } from '../../lib/i18n';
import { prefersReducedMotion } from './CompanionLine';
import { cleanGameTitle } from './gameTitle';
import styles from './BackseatGameModal.module.css';

export interface BackseatGameModalProps {
  characterId: string;
  gameId: string;
}

type Step = 'intro' | 'pick';

/** How long the tapped card stays highlighted before the step leaves. */
export const PICK_HIGHLIGHT_MS = 400;
/** The same beat with reduced motion: no lift, so only the ring needs seeing. */
export const PICK_HIGHLIGHT_REDUCED_MS = 150;
/** The panel's fade-out (.leaving) before the share step takes over. */
const LEAVE_MS = 180;

/** From the tap to the hand-over: the highlight, then the panel's fade. */
export function pickHandoffMs(reduced: boolean): { highlight: number; leave: number } {
  return reduced
    ? { highlight: PICK_HIGHLIGHT_REDUCED_MS, leave: 0 }
    : { highlight: PICK_HIGHLIGHT_MS, leave: LEAVE_MS };
}

export function BackseatGameModal({
  characterId,
  gameId,
}: BackseatGameModalProps): React.ReactElement | null {
  const t = useT();
  const def = backseatGame(gameId);
  const closeModal = useUiStore((s) => s.closeModal);
  const openModal = useUiStore((s) => s.openModal);

  const [step, setStep] = useState<Step>(() =>
    backseatGameIntroSeen(gameId) ? 'pick' : 'intro',
  );

  /** Hand over to the share step. Stops a share already running for this
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
      gameName={t(def.name)}
      onClose={closeModal}
      onDone={(picked, source) => void proceed(picked, source)}
    />
  );
}

/** What the grid area says instead of cards. null = show the cards. */
export type Notice =
  | { kind: 'none' }
  | { kind: 'error'; code: 'bad_link' | 'not_found' | 'network' }
  | { kind: 'offline' };

export function PickStep({
  gameId,
  gameName,
  onClose,
  onDone,
}: {
  gameId: string;
  /** The game's display name, already translated. */
  gameName: string;
  onClose: () => void;
  onDone: (picked: BackseatGameInfo | null, source: BackseatGameSource) => void;
}): React.ReactElement {
  const t = useT();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [popular, setPopular] = useState<BackseatGameInfo[] | null>(null);
  const [results, setResults] = useState<BackseatGameInfo[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  // The latest request wins: a slow search must not overwrite a newer one.
  const seq = useRef(0);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await sei.backseatGamePopular(gameId);
        if (!alive) return;
        setPopular(list);
        if (list.length === 0) setNotice((n) => n ?? { kind: 'offline' });
      } catch {
        if (!alive) return;
        setPopular([]);
        setNotice((n) => n ?? { kind: 'offline' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [gameId]);

  /** Pick a game: its card lights up for a beat, then the step hands over. */
  const pick = (game: BackseatGameInfo, source: BackseatGameSource): void => {
    if (picked !== null) return;
    seq.current += 1; // a search still in flight must not land over the pick
    setPicked(game.universeId);
    setBusy(false);
    setNotice(null);
    // Warm main's details cache for the session prompt; it looks the game up
    // itself at start either way, so a failure here changes nothing.
    void sei.backseatGameDetails(gameId, game.universeId).catch(() => null);
    const ms = pickHandoffMs(prefersReducedMotion());
    timers.current.push(
      setTimeout(() => {
        setLeaving(true);
        timers.current.push(setTimeout(() => onDone(game, source), ms.leave));
      }, ms.highlight),
    );
  };

  const submit = async (raw?: string): Promise<void> => {
    const input = (raw ?? query).trim();
    if (!input || picked !== null) return;
    const id = ++seq.current;
    setBusy(true);
    let res: BackseatGameResolveResult;
    try {
      res = await sei.backseatGameResolve(gameId, input);
    } catch {
      res = { kind: 'error', code: 'network' };
    }
    if (id !== seq.current) return;
    setBusy(false);
    const out = resolveOutcome(res);
    if (out.pick) {
      setResults([out.pick]);
      pick(out.pick, 'link');
      return;
    }
    if (out.results !== undefined) setResults(out.results);
    setNotice(out.notice);
  };

  const clear = (): void => {
    seq.current += 1;
    setQuery('');
    setBusy(false);
    setResults(null);
    setNotice(popular && popular.length === 0 ? { kind: 'offline' } : null);
  };

  const list = results ?? popular;
  const fromResults = results !== null;
  const message = notice ? noticeLine(notice, t, gameName) : null;

  return (
    <ModalShell
      title={t('Play {game}', { game: gameName })}
      width={760}
      scrimClose
      onClose={onClose}
      panelClassName={`${styles.panel} ${leaving ? styles.leaving : ''}`}
    >
      <form
        className={styles.pill}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SearchIcon size={17} />
        <input
          className={styles.pillInput}
          value={query}
          onChange={(e) => {
            const v = e.target.value;
            setQuery(v);
            if (!v.trim()) clear();
          }}
          onPaste={(e) => {
            // A pasted game link is the whole answer: resolve it right away.
            const pasted = e.clipboardData.getData('text');
            if (looksLikeLink(pasted)) {
              e.preventDefault();
              setQuery(pasted.trim());
              void submit(pasted);
            }
          }}
          placeholder={t('Search or paste a link')}
          aria-label={t('Search {game} games or paste a link', { game: gameName })}
          spellCheck={false}
          autoFocus
          disabled={picked !== null}
        />
        {busy ? (
          <span className={styles.spinner} aria-hidden="true" />
        ) : query ? (
          <button type="button" className={styles.pillClear} onClick={clear} aria-label={t('Clear')}>
            <CloseIcon size={15} />
          </button>
        ) : null}
      </form>

      <div className={`${styles.gridWrap} ${busy ? styles.gridBusy : ''}`}>
        <div
          className={styles.grid}
          aria-busy={(list === null && !message) || busy}
        >
          {message
            ? // Nothing to tap: empty slots keep the step's shape, and the
              // line over them says why.
              Array.from({ length: 8 }, (_, i) => (
                <span key={i} className={styles.slot} aria-hidden="true" />
              ))
            : list === null || list.length === 0
              ? Array.from({ length: 8 }, (_, i) => <span key={i} className={styles.skeleton} />)
              : list.map((g, i) => (
                <GameCard
                  key={g.universeId}
                  game={g}
                  index={i}
                  state={picked === null ? 'idle' : picked === g.universeId ? 'picked' : 'dimmed'}
                  onPick={() => pick(g, fromResults ? 'search' : 'popular')}
                />
              ))}
        </div>
        {message ? (
          <p className={styles.notice} role="status">
            {message}
          </p>
        ) : null}
      </div>

      <div className={styles.foot}>
        <button
          type="button"
          className={styles.skip}
          onClick={() => onDone(null, 'skip')}
          disabled={picked !== null}
        >
          {t('Skip')}
        </button>
      </div>
    </ModalShell>
  );
}

/**
 * What a search or link lookup does to the step. A resolved link is a pick.
 * Results replace the cards. No results and errors put a line in the grid
 * area (clearing the search brings the popular games back).
 */
export function resolveOutcome(res: BackseatGameResolveResult): {
  pick?: BackseatGameInfo;
  /** undefined = leave the cards as they are. */
  results?: BackseatGameInfo[] | null;
  notice: Notice | null;
} {
  if (res.kind === 'game') return { pick: res.game, notice: null };
  if (res.kind === 'error') return { notice: { kind: 'error', code: res.code } };
  if (res.results.length === 0) return { results: null, notice: { kind: 'none' } };
  return { results: res.results, notice: null };
}

/** The grid area's line when there are no cards. Short and plain. */
export function noticeLine(
  notice: Notice,
  t: (en: string, params?: Record<string, string | number>) => string,
  gameName: string,
): string {
  switch (notice.kind) {
    case 'none':
      return t("No games found. Try pasting the game's link.");
    case 'error':
      return notice.code === 'bad_link'
        ? t("That's not a {game} game link.", { game: gameName })
        : notice.code === 'not_found'
          ? t("Couldn't find that game.")
          : t("Can't reach {game} right now.", { game: gameName });
    case 'offline':
      return t("Can't reach {game} right now.", { game: gameName });
  }
}

/** One game: its 16:9 screenshot, its name over it, players online. */
function GameCard({
  game,
  index,
  state,
  onPick,
}: {
  game: BackseatGameInfo;
  index: number;
  state: 'idle' | 'picked' | 'dimmed';
  onPick: () => void;
}): React.ReactElement {
  const t = useT();
  const [thumbFailed, setThumbFailed] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);
  const thumb = !thumbFailed ? game.thumbnailUrl : undefined;
  const icon = !iconFailed ? game.iconUrl : undefined;
  const count = game.playing !== undefined && game.playing > 0 ? compact(game.playing) : null;
  // The caption drops the store tags and emoji ("[🎃] Adopt Me!" reads
  // "Adopt Me!"); the full store title stays in the hover tooltip.
  const name = cleanGameTitle(game.name);
  return (
    <button
      type="button"
      className={[
        styles.card,
        state === 'picked' ? styles.cardPicked : '',
        state === 'dimmed' ? styles.cardDimmed : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ animationDelay: `${Math.min(index, 11) * 35}ms` }}
      onClick={onPick}
      disabled={state !== 'idle'}
      title={game.name !== name ? game.name : undefined}
      aria-label={count ? `${name}, ${t('{count} playing', { count })}` : name}
    >
      <span className={styles.art}>
        {thumb ? (
          <img
            className={styles.thumb}
            src={thumb}
            alt=""
            draggable={false}
            loading="lazy"
            onError={() => setThumbFailed(true)}
          />
        ) : icon ? (
          // No screenshot: the square icon, blurred to fill behind itself.
          <>
            <img className={styles.iconFill} src={icon} alt="" draggable={false} aria-hidden="true" />
            <img
              className={styles.iconMid}
              src={icon}
              alt=""
              draggable={false}
              onError={() => setIconFailed(true)}
            />
          </>
        ) : (
          <span className={styles.blank} style={{ ['--hue' as string]: String(hue(game.name)) }}>
            {Array.from(name.replace(/^[^\p{L}\p{N}]+/u, ''))[0]?.toUpperCase() ?? '?'}
          </span>
        )}
      </span>
      <span className={styles.shade} aria-hidden="true" />
      {count ? (
        <span className={styles.count} aria-hidden="true">
          <span className={styles.liveDot} />
          {count}
        </span>
      ) : null}
      <span className={styles.name}>{name}</span>
    </button>
  );
}

/** A stable hue per name, for the placeholder card. */
function hue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/** 1234 -> "1.2K", 1234567 -> "1.2M". Numbers only, so no translation. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
