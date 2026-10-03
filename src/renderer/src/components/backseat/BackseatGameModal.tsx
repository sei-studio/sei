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
 *   2. PICK, when the game has a lookup provider: "what are we playing?",
 *      asked by the companion. Entirely optional (skip). What was picked
 *      crosses to main as ids only; main fetches the details itself and puts
 *      them in the prompt.
 *
 * Then it hands over to ShareScreenModal with the selection. For a game with
 * `autoShare` that is not a picker any more (261004): it checks Screen
 * Recording, then starts the call and WAITS for the game's window, capturing
 * it on its own (useBackseatStore.startWatch).
 *
 * 261004 redesign of PICK (Shawn: "too much text and corporate, not
 * immersive"). The companion asks in their own voice (CompanionLine), the
 * games are a grid of big 16:9 screenshots, and tapping one picks it and moves
 * straight on: no Continue button, no description card. The companion reacts
 * to the pick for a beat while the modal leaves, which is the transition into
 * the call. Every state (searching, no results, offline, bad link) is the
 * companion's line rather than a grey sentence.
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
import { CloseIcon, SearchIcon } from '../icons';
import { useT } from '../../lib/i18n';
import { CompanionLine, prefersReducedMotion } from './CompanionLine';
import styles from './BackseatGameModal.module.css';

export interface BackseatGameModalProps {
  characterId: string;
  gameId: string;
}

type Step = 'intro' | 'pick';

/** How long the companion's reaction to a pick plays before the hand-over. */
export const PICK_BEAT_MS = 700;
const PICK_BEAT_REDUCED_MS = 250;

export function BackseatGameModal({
  characterId,
  gameId,
}: BackseatGameModalProps): React.ReactElement | null {
  const t = useT();
  const def = backseatGame(gameId);
  const closeModal = useUiStore((s) => s.closeModal);
  const openModal = useUiStore((s) => s.openModal);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId)) ?? null;
  const companionName = character?.name ?? t('Your companion');

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
      gameName={def.name}
      character={character}
      companionName={companionName}
      onClose={closeModal}
      onDone={(picked, source) => void proceed(picked, source)}
    />
  );
}

/** What the companion is saying, which is also the step's whole state line. */
export type Mood =
  | { kind: 'ask' }
  | { kind: 'searching' }
  | { kind: 'results'; fallback: boolean }
  | { kind: 'none' }
  | { kind: 'error'; code: 'bad_link' | 'not_found' | 'network' }
  | { kind: 'offline' }
  | { kind: 'picked'; name: string };

export function PickStep({
  gameId,
  gameName,
  character,
  companionName,
  onClose,
  onDone,
}: {
  gameId: string;
  gameName: string;
  character: { id: string; name: string; portrait_image?: string | null } | null;
  companionName: string;
  onClose: () => void;
  onDone: (picked: BackseatGameInfo | null, source: BackseatGameSource) => void;
}): React.ReactElement {
  const t = useT();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [popular, setPopular] = useState<BackseatGameInfo[] | null>(null);
  const [results, setResults] = useState<BackseatGameInfo[] | null>(null);
  const [mood, setMood] = useState<Mood>({ kind: 'ask' });
  const [picked, setPicked] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  // The latest request wins: a slow search must not overwrite a newer one.
  const seq = useRef(0);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (doneTimer.current) clearTimeout(doneTimer.current);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await sei.backseatGamePopular(gameId);
        if (!alive) return;
        setPopular(list);
        if (list.length === 0) setMood((m) => (m.kind === 'ask' ? { kind: 'offline' } : m));
      } catch {
        if (!alive) return;
        setPopular([]);
        setMood((m) => (m.kind === 'ask' ? { kind: 'offline' } : m));
      }
    })();
    return () => {
      alive = false;
    };
  }, [gameId]);

  /** Pick a game: the companion reacts, then the step hands over. */
  const pick = (game: BackseatGameInfo, source: BackseatGameSource): void => {
    if (picked !== null) return;
    seq.current += 1; // a search still in flight must not land over the pick
    setPicked(game.universeId);
    setMood({ kind: 'picked', name: game.name });
    // Warm main's details cache for the session prompt; it looks the game up
    // itself at start either way, so a failure here changes nothing.
    void sei.backseatGameDetails(gameId, game.universeId).catch(() => null);
    const beat = prefersReducedMotion() ? PICK_BEAT_REDUCED_MS : PICK_BEAT_MS;
    doneTimer.current = setTimeout(() => {
      setLeaving(true);
      doneTimer.current = setTimeout(() => onDone(game, source), prefersReducedMotion() ? 0 : 180);
    }, beat);
  };

  const submit = async (raw?: string): Promise<void> => {
    const input = (raw ?? query).trim();
    if (!input || picked !== null) return;
    const id = ++seq.current;
    setBusy(true);
    setMood({ kind: 'searching' });
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
    setMood(out.mood);
  };

  const clear = (): void => {
    seq.current += 1;
    setQuery('');
    setBusy(false);
    setResults(null);
    setMood(popular && popular.length === 0 ? { kind: 'offline' } : { kind: 'ask' });
  };

  const line = moodLine(mood, t, gameName);

  const list = results ?? popular;
  const fromResults = results !== null;

  return (
    <ModalShell
      title={null}
      width={760}
      scrimClose
      onClose={onClose}
      panelClassName={`${styles.panel} ${leaving ? styles.leaving : ''}`}
      aria-label={t('What are we playing?')}
    >
      <div className={styles.head}>
        <CompanionLine
          character={character}
          name={companionName}
          line={line}
          size={60}
        />
      </div>

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

      <div className={`${styles.grid} ${busy ? styles.gridBusy : ''}`} aria-busy={list === null || busy}>
        {list === null
          ? Array.from({ length: 8 }, (_, i) => <span key={i} className={styles.skeleton} />)
          : list.length === 0
            ? // Nothing to show (offline): an empty shelf keeps the step's
              // shape, and the companion's line says what to do instead.
              Array.from({ length: 8 }, (_, i) => (
                <span key={i} className={styles.ghost} aria-hidden="true" />
              ))
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
 * An error keeps whatever cards were showing. No results also keeps the
 * popular games up (results: null), so there is still something to tap while
 * the companion suggests pasting a link.
 */
export function resolveOutcome(res: BackseatGameResolveResult): {
  pick?: BackseatGameInfo;
  /** undefined = leave the cards as they are. */
  results?: BackseatGameInfo[] | null;
  mood: Mood;
} {
  if (res.kind === 'game') return { pick: res.game, mood: { kind: 'picked', name: res.game.name } };
  if (res.kind === 'error') return { mood: { kind: 'error', code: res.code } };
  if (res.results.length === 0) return { results: null, mood: { kind: 'none' } };
  return { results: res.results, mood: { kind: 'results', fallback: !!res.fallback } };
}

/** The companion's line for a mood. Short, in their voice, no em dashes. */
export function moodLine(
  mood: Mood,
  t: (en: string, params?: Record<string, string | number>) => string,
  gameName: string,
): string {
  switch (mood.kind) {
    case 'ask':
      return t('What are we playing?');
    case 'searching':
      return t('Hmm, let me look...');
    case 'results':
      return mood.fallback
        ? t('{game} search is busy. Any of these?', { game: gameName })
        : t('Any of these?');
    case 'none':
      return t("Can't find that one. Try pasting the game's link?");
    case 'error':
      return mood.code === 'bad_link'
        ? t("That's not a {game} game link.", { game: gameName })
        : mood.code === 'not_found'
          ? t("Hmm, that game doesn't seem to exist.")
          : t("I can't reach {game} right now. We can just skip this!", { game: gameName });
    case 'offline':
      return t("I can't load games right now. Paste a link or just skip!");
    case 'picked':
      return t("Ooh, {game}! Let's go.", { game: mood.name });
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
      aria-label={count ? `${game.name}, ${t('{count} playing', { count })}` : game.name}
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
            {Array.from(game.name.replace(/^[^\p{L}\p{N}]+/u, ''))[0]?.toUpperCase() ?? '?'}
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
      <span className={styles.name}>{game.name}</span>
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
