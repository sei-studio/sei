/**
 * TutorialOverlay — Sui's guided tour of the real app (260728).
 *
 * Mounted by App.tsx whenever useTutorialStore.active. Renders a dark scrim
 * over the LIVE UI with a spotlight hole cut around the current step's target
 * (found via [data-tutorial="<key>"] attributes on the real components), Sui
 * in the bottom-left corner (flipped sprites, mouth flapping while her line
 * types), and a "> Skip tutorial" escape in the bottom-right.
 *
 * Two kinds of step:
 *   interactive — the hole is genuinely open (the scrim is four panels around
 *                 the target), so the player really clicks the real button;
 *                 the step advances by WATCHING the result (route change,
 *                 modal open), not the click itself.
 *   blocked     — a fifth transparent panel covers the hole, so the target is
 *                 highlighted but inert; clicking anywhere advances.
 *
 * Targets are re-measured on a 250ms tick while active (layout shifts,
 * navigation, panel animation). A step whose target never appears renders a
 * full scrim — the text still reads fine, and the click still advances.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useTutorialStore, type TutorialStep } from '../../lib/stores/useTutorialStore';
import { DEFAULT_CHARACTER_UUIDS } from '@shared/defaultCharacters';
import styles from './TutorialOverlay.module.css';

/** The base sprites face LEFT, so the left corner uses the -flipped variants
 * (facing right) and the right corner uses the base art (facing left) — Sui
 * always looks toward the content. */
const SUI_SPRITES = {
  left: {
    stand: './img/onboard/sui-stand-flipped.png',
    talk: './img/onboard/sui-talk-flipped.png',
  },
  right: { stand: './img/onboard/sui-stand.png', talk: './img/onboard/sui-talk.png' },
} as const;

interface StepDef {
  /** [data-tutorial] keys; first is the spotlight hole, the rest get rings. */
  targets: string[];
  /** Open hole (real clicks reach the target) vs blocked highlight. */
  interactive: boolean;
  /** Whether clicking the scrim advances (blocked steps only). */
  advanceOnClick: boolean;
  /** Spotlight padding override (default PAD). Edge-to-edge targets set 0 so
   * the padded ring does not bleed onto their neighbours. */
  pad?: number;
}

const STEPS: Record<TutorialStep, StepDef> = {
  meet: { targets: [], interactive: false, advanceOnClick: true },
  // The tour lands on the reveal page (260729), so say-hi spotlights the
  // "Say hello" button and advances when the chat route opens.
  sayhi: { targets: ['say-hello'], interactive: true, advanceOnClick: false },
  texting: { targets: ['composer', 'call-btn'], interactive: false, advanceOnClick: true },
  games: { targets: ['games-btn'], interactive: true, advanceOnClick: false },
  tiles: { targets: ['games-modal'], interactive: false, advanceOnClick: true },
  // 260803. Ordering matters and was worked out from the routes, not guessed:
  // 'games' and 'tiles' both happen on the CHAT screen (the games picker is a
  // modal over it), so the chat header, and the backseat button in it, is
  // still mounted. 'tiles' used to close that modal and navigate to Home in one
  // advance; that navigation moved down to this step, so 'tiles' now only
  // closes the popup and the chat header is uncovered and measurable here.
  // Putting this step after 'terminal' instead would have pointed the spotlight
  // at a button that does not exist on Home, which degrades silently to a full
  // scrim with no highlight.
  //
  // Blocked, like 'texting' and 'tiles': the button opens the share-screen
  // picker, and a tour that lands the player in a source list is over.
  backseat: { targets: ['backseat-btn'], interactive: false, advanceOnClick: true },
  // The Home party-wall panels are edge-to-edge, so the default PAD would
  // bleed the ring onto the character panel left of the empty slot; pad 0
  // keeps the highlight inside the slot.
  terminal: {
    targets: ['empty-slot', 'rail-home'],
    interactive: false,
    advanceOnClick: true,
    pad: 0,
  },
  settings: { targets: ['theme-group'], interactive: false, advanceOnClick: true },
  sui: { targets: ['sui-card'], interactive: false, advanceOnClick: true },
  bye: { targets: [], interactive: false, advanceOnClick: true },
};

const PAD = 8;

type Box = { top: number; left: number; width: number; height: number };

function sameBoxes(a: Box[], b: Box[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => {
    const o = b[i];
    return (
      Math.abs(r.top - o.top) < 1 &&
      Math.abs(r.left - o.left) < 1 &&
      Math.abs(r.width - o.width) < 1 &&
      Math.abs(r.height - o.height) < 1
    );
  });
}

/** Same lightweight typewriter as the onboarding scene. */
function useTypewriter(text: string): { shown: string; done: boolean } {
  const [n, setN] = useState(0);
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
    setN(0);
    const t = setInterval(() => {
      setN((cur) => (cur >= textRef.current.length ? cur : cur + 1));
    }, 22);
    return () => clearInterval(t);
  }, [text]);
  return { shown: text.slice(0, n), done: n >= text.length };
}

export function TutorialOverlay(): React.ReactElement | null {
  const active = useTutorialStore((s) => s.active);
  const step = useTutorialStore((s) => s.step);
  const characterId = useTutorialStore((s) => s.characterId);
  const setStep = useTutorialStore((s) => s.setStep);
  const end = useTutorialStore((s) => s.end);

  const modal = useUiStore((s) => s.modal);
  const view = useUiStore((s) => s.view);
  const navigate = useUiStore((s) => s.navigate);
  const closeModal = useUiStore((s) => s.closeModal);
  const setHomeTab = useUiStore((s) => s.setHomeTab);
  const characters = useDataStore((s) => s.characters);

  const [closing, setClosing] = useState(false);

  const companion = characters.find((c) => c.id === characterId);
  const hasSui = characters.some((c) => c.id === DEFAULT_CHARACTER_UUIDS.sui);

  // Translated at render through the subscribed translator (no useMemo: the
  // record is nine short strings, and memoizing on the translator's identity
  // would recompute every render anyway). The companion's name rides t()'s
  // {name} interpolation so each line stays one dictionary key.
  const tt = useT();
  const lines: Record<TutorialStep, string> = {
    meet: tt(
      "Meet {name}, they're your new unique AI companion. Only you are connected to them.",
      { name: companion?.name ?? tt('them') },
    ),
    sayhi: tt("Let's say hi to them!"),
    texting: tt("Here's where you can text and call them. Looks familiar, right?"),
    games: tt('This is how you play games together. Here, try clicking it.'),
    tiles: tt(
      "Just click a tile to launch the game. I'm working hard to add new games. Remember to check every week!",
    ),
    backseat: tt(
      'This is Backseat, a new feature. You can share your game, movie, or even work for your companion to watch live! I recommend doomscrolling together, hehe.',
    ),
    terminal: tt(
      'This is your main terminal. You can connect with up to four AIs here. Just click an empty slot to awaken.',
    ),
    settings: tt(
      "This is settings. You can change the app's colors and add a custom background here. Make yourself at home!",
    ),
    sui: tt("Did I mention? I'm here too! If you ever wanna play with me, I'd be really happy!"),
    bye: tt("Anyways, that's all from me. Welcome to Sei!"),
  };

  const def = STEPS[step];
  const tw = useTypewriter(active ? lines[step] : '');

  // ── Target measurement loop ────────────────────────────────────────────
  const [boxes, setBoxes] = useState<Box[]>([]);
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const measure = (): void => {
      const found: Box[] = [];
      for (const key of def.targets) {
        const el = document.querySelector(`[data-tutorial="${key}"]`);
        if (!el) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          found.push({ top: r.top, left: r.left, width: r.width, height: r.height });
        }
      }
      setBoxes((prev) => (sameBoxes(prev, found) ? prev : found));
      // Blocked steps cover their targets with a transparent panel, which
      // stops the pointer but not keyboard focus (the chat composer
      // autofocuses), so drop focus or the player can still type into it.
      if (!def.interactive) {
        const ae = document.activeElement;
        if (ae instanceof HTMLElement && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
          ae.blur();
        }
      }
      timer = window.setTimeout(measure, 250);
    };
    measure();
    return () => window.clearTimeout(timer);
  }, [active, def]);

  // ── Watchers: interactive steps advance on the RESULT of the action ────
  // say-hi spotlights the reveal page's "Say hello" button and advances when
  // the chat route actually opens.
  useEffect(() => {
    if (active && step === 'sayhi' && view.kind === 'chat') setStep('texting');
  }, [active, step, view, setStep]);
  useEffect(() => {
    if (!active) return;
    if (step === 'games' && modal?.kind === 'games-picker') setStep('tiles');
  }, [active, step, modal, setStep]);

  // The theme group may sit below the fold of the Settings scroll; bring it
  // into view once it mounts (poll briefly — the route just changed).
  useEffect(() => {
    if (!active || step !== 'settings') return;
    let tries = 0;
    const t = window.setInterval(() => {
      tries += 1;
      const el = document.querySelector('[data-tutorial="theme-group"]');
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        window.clearInterval(t);
      } else if (tries >= 20) {
        window.clearInterval(t);
      }
    }, 100);
    return () => window.clearInterval(t);
  }, [active, step]);

  const finish = useCallback(() => {
    setClosing(true);
    closeModal();
    setTimeout(() => {
      setClosing(false);
      end();
    }, 450);
  }, [closeModal, end]);

  const advance = useCallback(() => {
    if (!tw.done) return; // let the line finish (a click mid-type is a misfire)
    switch (step) {
      case 'meet':
        setStep('sayhi');
        break;
      case 'texting':
        setStep('games');
        break;
      case 'tiles':
        // Close the popup only. The next step spotlights the chat header
        // underneath it, so the navigation to Home that used to happen here
        // moved to that step.
        closeModal();
        setStep('backseat');
        break;
      case 'backseat':
        setHomeTab('home');
        navigate({ kind: 'home' });
        setStep('terminal');
        break;
      case 'terminal':
        navigate({ kind: 'settings' });
        setStep('settings');
        break;
      case 'settings':
        setHomeTab('home');
        navigate({ kind: 'home' });
        setStep(hasSui ? 'sui' : 'bye');
        break;
      case 'sui':
        setStep('bye');
        break;
      case 'bye':
        finish();
        break;
      default:
        break;
    }
  }, [step, tw.done, setStep, closeModal, setHomeTab, navigate, hasSui, finish]);

  // Enter advances like a click (advance() already no-ops mid-typewriter).
  // Ignore presses aimed at a real control so form/button semantics survive.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.tagName === 'BUTTON')
      ) {
        return;
      }
      if (def.advanceOnClick) advance();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, def, advance]);

  // ── Which corner Sui stands in ─────────────────────────────────────────
  // She defaults to bottom-left; when her corner (sprite + bubble) would sit
  // over a spotlighted target she walks to the bottom-right (and faces back
  // toward the content). Both candidate footprints are tested with the SAME
  // measured size, so the choice is deterministic and cannot oscillate.
  const cornerRef = useRef<HTMLDivElement | null>(null);
  const [side, setSide] = useState<'left' | 'right'>('left');
  useEffect(() => {
    if (!active) return;
    const el = cornerRef.current;
    if (!el || boxes.length === 0) {
      setSide('left');
      return;
    }
    const r = el.getBoundingClientRect();
    const margin = 16;
    const candidate = (left: number): Box => ({
      top: window.innerHeight - r.height,
      left,
      width: r.width,
      height: r.height,
    });
    const overlaps = (c: Box): boolean =>
      boxes.some((b) => {
        const bt = b.top - PAD;
        const bl = b.left - PAD;
        const br = b.left + b.width + PAD;
        const bb = b.top + b.height + PAD;
        return c.left < br && c.left + c.width > bl && c.top < bb && c.top + c.height > bt;
      });
    const leftHit = overlaps(candidate(margin));
    const rightHit = overlaps(candidate(window.innerWidth - margin - r.width));
    // Neither side clear (e.g. a full-width composer): stay left.
    setSide(leftHit && !rightHit ? 'right' : 'left');
  }, [active, boxes]);

  // Sui mouth flap while the line types.
  const [flip, setFlip] = useState(false);
  useEffect(() => {
    if (tw.done) {
      setFlip(false);
      return;
    }
    const t = setInterval(() => setFlip((f) => !f), 240);
    return () => clearInterval(t);
  }, [tw.done]);

  if (!active) return null;

  const hole = boxes.length > 0 ? boxes[0] : null;
  // Per-step pad override for the primary hole/ring (secondary rings keep
  // PAD): edge-to-edge targets like the Home panels need 0 or the padded
  // ring visibly overlaps their neighbours.
  const pad = def.pad ?? PAD;
  const holePadded: Box | null = hole
    ? {
        top: hole.top - pad,
        left: hole.left - pad,
        width: hole.width + pad * 2,
        height: hole.height + pad * 2,
      }
    : null;

  const scrimClick = def.advanceOnClick ? advance : undefined;

  return (
    <div className={closing ? `${styles.root} ${styles.closing}` : styles.root}>
      {holePadded ? (
        <>
          {/* Four panels around the hole. */}
          <div
            className={styles.scrim}
            style={{ top: 0, left: 0, right: 0, height: Math.max(0, holePadded.top) }}
            onClick={scrimClick}
          />
          <div
            className={styles.scrim}
            style={{
              top: holePadded.top,
              left: 0,
              width: Math.max(0, holePadded.left),
              height: holePadded.height,
            }}
            onClick={scrimClick}
          />
          <div
            className={styles.scrim}
            style={{
              top: holePadded.top,
              left: holePadded.left + holePadded.width,
              right: 0,
              height: holePadded.height,
            }}
            onClick={scrimClick}
          />
          <div
            className={styles.scrim}
            style={{ top: holePadded.top + holePadded.height, left: 0, right: 0, bottom: 0 }}
            onClick={scrimClick}
          />
          {/* Blocked steps: a clear cover keeps the highlighted target inert. */}
          {!def.interactive ? (
            <div
              className={styles.holeCover}
              style={holePadded}
              onClick={scrimClick}
            />
          ) : null}
          <div className={styles.ring} style={holePadded} />
          {/* Secondary targets get a ring on top of the scrim (visible, dimmed). */}
          {boxes.slice(1).map((b, i) => (
            <div
              key={i}
              className={`${styles.ring} ${styles.ringSecondary}`}
              style={{
                top: b.top - PAD,
                left: b.left - PAD,
                width: b.width + PAD * 2,
                height: b.height + PAD * 2,
              }}
            />
          ))}
        </>
      ) : (
        <div className={styles.scrimFull} onClick={scrimClick} />
      )}

      <button className={styles.skip} onClick={finish}>
        {'> ' + tt('Skip tutorial')}
      </button>

      <div
        ref={cornerRef}
        className={
          side === 'right' ? `${styles.suiCorner} ${styles.suiCornerRight}` : styles.suiCorner
        }
      >
        <div className={styles.suiSprite}>
          <img
            src={SUI_SPRITES[side].stand}
            alt=""
            draggable={false}
            style={{ opacity: flip ? 0 : 1 }}
          />
          <img
            src={SUI_SPRITES[side].talk}
            alt=""
            draggable={false}
            style={{ opacity: flip ? 1 : 0 }}
          />
        </div>
        <div className={styles.bubble} onClick={def.advanceOnClick ? advance : undefined}>
          {tw.shown}
          {!tw.done ? <span className={styles.caret} /> : null}
        </div>
      </div>
    </div>
  );
}
