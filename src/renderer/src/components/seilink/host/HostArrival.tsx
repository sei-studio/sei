/**
 * Her arrival on the wallpaper (261119, product call (261119)). Main decides
 * the mode (main/seilink/host/arrival.ts, rules in shared/seilinkEntrance.ts);
 * this draws it around her avatar:
 *
 *  - wait:  her look is still being made. In her place, one quiet status line
 *           in the intro's style, typed in with cycling dots ("Inviting
 *           {name}…"); it is her click area, and a click lets her in now.
 *           `quiet` (the wait passed LINK_TIMEOUT_MS): the same line, dimmer.
 *  - hold:  nothing (the app has not stepped aside yet), and no click area.
 *  - enter: her avatar mounts unseen; once it has resolved what to show (and
 *           the desktop is visible: frames are running) she comes in with the
 *           intro's arrival (lib/seilink/entrance.ts), then the page says so.
 *  - show:  she is just there; the page says so once her avatar resolved.
 *
 * The avatar element is the same in enter and show, so the switch to show
 * after her entrance never remounts her.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { SeilinkArrival } from '@shared/seilinkEntrance';
import { useT } from '../../../lib/i18n';
import { entranceKeyframes, entranceMs } from '../../../lib/seilink/entrance';
import { typedAt, type Typed } from '../../../lib/seilink/typing';
import styles from './SeilinkHost.module.css';

/** Her avatar has this long to resolve what it shows before she comes in anyway. */
const RESOLVE_MAX_MS = 2500;
/** After it resolved, this long for its first picture to paint. */
const SETTLE_MS = 300;
const RESOLVE_POLL_MS = 100;
/** The waiting line ticks this often while it types, then at the dots' pace. */
const TYPE_TICK_MS = 33;
const DOT_TICK_MS = 200;

export interface ArrivedReport {
  played: boolean;
  reduced: boolean;
  kind: string | null;
}

export interface HostArrivalProps {
  arrival: SeilinkArrival;
  name: string;
  /** Her slot's height in px (the waiting line sits at her chest, the rise is 2% of it). */
  height: number;
  /** The frame cap now: 0 while the desktop is covered, locked or asleep (her entrance waits for it). */
  fps: number;
  /** Dev preview: a fixed reduced-motion answer. */
  reduced?: boolean;
  onArrived(r: ArrivedReport): void;
  children: React.ReactNode;
}

function prefersReduced(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

export function HostArrival(props: HostArrivalProps): React.ReactElement {
  const { arrival } = props;
  if (arrival.mode === 'wait') return <WaitingLine name={props.name} height={props.height} quiet={arrival.quiet === true} fps={props.fps} />;
  // Her click area is the line or her avatar: in hold there is none (a zero box), so the desktop gets the clicks.
  if (arrival.mode === 'hold') return <span data-seilink-hit="" className={styles.arrivalNone} />;
  return <Her {...props} />;
}

function Her(props: HostArrivalProps): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [started, setStarted] = useState(props.arrival.mode === 'show');
  const enter = props.arrival.mode === 'enter';
  const visible = props.fps > 0;
  const onArrived = useRef(props.onArrived);
  onArrived.current = props.onArrived;
  // Once per arrival: the switch to show after her entrance must not report her again.
  const reported = useRef(false);
  const cb = useRef((r: ArrivedReport): void => {
    if (reported.current) return;
    reported.current = true;
    onArrived.current(r);
  });
  const reducedProp = props.reduced;
  const height = props.height;

  useEffect(() => {
    if (reported.current) return;
    // Covered: wait until the desktop shows (nobody would see her come in).
    if (enter && !visible) return;
    let dead = false;
    let anim: Animation | null = null;
    const t0 = performance.now();
    const kindNow = (): string | null => {
      const k = ref.current?.querySelector('[data-avatar-kind]')?.getAttribute('data-avatar-kind') ?? null;
      return k && k !== 'loading' ? k : null;
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const go = (): void => {
      if (dead) return;
      const kind = kindNow();
      if (!enter) {
        cb.current({ played: false, reduced: false, kind });
        return;
      }
      const reduced = reducedProp ?? prefersReduced();
      const el = ref.current;
      setStarted(true);
      if (!el || typeof el.animate !== 'function') {
        cb.current({ played: false, reduced, kind });
        return;
      }
      anim = el.animate(entranceKeyframes(height, reduced), { duration: entranceMs(reduced), easing: 'linear', fill: 'backwards' });
      anim.onfinish = () => {
        if (!dead) cb.current({ played: true, reduced, kind: kindNow() ?? kind });
      };
    };
    const poll = (): void => {
      if (dead) return;
      if (kindNow() || performance.now() - t0 >= RESOLVE_MAX_MS) timer = setTimeout(go, kindNow() ? SETTLE_MS : 0);
      else timer = setTimeout(poll, RESOLVE_POLL_MS);
    };
    poll();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      // A mode change mid-entrance (her session ended) drops it; she stays as she is.
      anim?.finish();
    };
    // The entrance runs once per arrival; height changes during it do not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enter, visible]);

  return (
    <div ref={ref} className={styles.arrivalHer} style={started ? undefined : { opacity: 0 }}>
      {props.children}
    </div>
  );
}

/** The waiting line: typed in like the intro's status lines, then its dots cycle until her look lands. */
function WaitingLine(props: { name: string; height: number; quiet: boolean; fps: number }): React.ReactElement {
  const t = useT();
  const text = t('Inviting {name}…', { name: props.name });
  const reduced = prefersReduced();
  const [line, setLine] = useState<Typed>(() => typedAt(text, 0, reduced));
  const start = useRef(performance.now());
  const running = props.fps > 0;

  useEffect(() => {
    start.current = performance.now();
  }, [text]);

  useEffect(() => {
    // Covered or asleep: the line holds still (no timers while nobody can see it).
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      const s = typedAt(text, performance.now() - start.current, reduced);
      setLine(s);
      if (reduced) return;
      timer = setTimeout(tick, s.done ? DOT_TICK_MS : TYPE_TICK_MS);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [text, running, reduced]);

  return (
    <div className={styles.arrivalWait} style={{ marginBottom: Math.round(props.height * 0.42) }}>
      <p data-seilink-hit="" className={props.quiet ? `${styles.arrivalLine} ${styles.arrivalQuiet}` : styles.arrivalLine} aria-hidden="true">
        <span>{line.typed}</span>
        <span style={{ opacity: line.freshIn }}>{line.fresh}</span>
        <span className={styles.arrivalRest}>{line.rest}</span>
        <span>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ opacity: i < line.dots ? 1 : 0 }}>
              {line.dot ?? ''}
            </span>
          ))}
        </span>
      </p>
      <span className={styles.arrivalLive} role="status">
        {text}
      </span>
    </div>
  );
}
