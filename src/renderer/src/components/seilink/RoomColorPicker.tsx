/**
 * The room editor's custom colour (261105 colour pass, T333, product feedback: "add
 * color picker for everything where there's color selection"). The last cell
 * of every colour row is a custom swatch that opens this popover: a
 * saturation / brightness square, a hue slider, a hex field and the recent
 * row (lib/seilink/colorPick.ts).
 *
 *  - Live: a drag previews in the room once per frame (frameThrottle), under
 *    the row's gesture key, so the whole drag is ONE undo step; pointer up
 *    ends the gesture and remembers the colour in the recent row.
 *  - The popover is portalled into the nearest `[data-color-host]` (the
 *    editor's side column, so it fades with the panel while an item is
 *    dragged) or the editor root, positioned under its swatch (above when
 *    there is no room below), and follows the swatch when the panel scrolls.
 *  - Closes on Escape (focus back on the swatch) and on a pointer down
 *    outside it. The editor's own keys ignore events from inside it.
 *  - Glass like the editor's panels, 2px corners, no border lines.
 */
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../lib/i18n';
import { frameThrottle, hexToHsv, hsvToHex, parseHex, rememberRecentColor, useRecentColors, type Hsv } from '../../lib/seilink/colorPick';
import type { ColorPickKind } from '@shared/seilinkTelemetry';
import styles from './RoomColorPicker.module.css';


export interface ColorPickTelemetry {
  pickerOpened(): void;
  picked(kind: ColorPickKind): void;
}

const noop: ColorPickTelemetry = { pickerOpened() {}, picked() {} };
export const ColorPickTelemetryContext = createContext<ColorPickTelemetry>(noop);
export const useColorPickTelemetry = (): ColorPickTelemetry => useContext(ColorPickTelemetryContext);

export interface CustomColorProps {
  /** The colour the row shows now. */
  value: string;
  /** True when that colour is not one of the row's presets (the swatch then shows it). */
  active: boolean;
  /** Undo gesture key for live preview (one key per row). */
  gesture: string;
  /** A colour: with a gesture key while she drags, null for a one-off pick. */
  onTint(hex: string, gesture: string | null): void;
  onGestureEnd(): void;
  label?: string;
}

/** The custom swatch and its popover. */
export function CustomColor({ value, active, gesture, onTint, onGestureEnd, label }: CustomColorProps): React.ReactElement {
  const t = useT();
  const tele = useColorPickTelemetry();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const name = label ?? t('Custom color');
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={active ? `${styles.custom} ${styles.customOn}` : styles.custom}
        style={active ? ({ ['--custom' as string]: value } as React.CSSProperties) : undefined}
        aria-label={name}
        title={name}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-checked={active}
        role="radio"
        data-custom-color=""
        onClick={() => {
          if (!open) tele.pickerOpened();
          setOpen((o) => !o);
        }}
      >
        {!active && (
          <svg className={styles.plus} viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 2.5v7M2.5 6h7" />
          </svg>
        )}
      </button>
      {open && btn.current && (
        <ColorPopover
          anchor={btn.current}
          value={value}
          gesture={gesture}
          label={name}
          onTint={onTint}
          onGestureEnd={onGestureEnd}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) btn.current?.focus();
          }}
        />
      )}
    </>
  );
}

const POP_W = 236;
const GAP = 10;
const EDGE = 8;

function ColorPopover({
  anchor,
  value,
  gesture,
  label,
  onTint,
  onGestureEnd,
  onClose,
}: {
  anchor: HTMLElement;
  value: string;
  gesture: string;
  label: string;
  onTint(hex: string, gesture: string | null): void;
  onGestureEnd(): void;
  onClose(refocus: boolean): void;
}): React.ReactElement | null {
  const t = useT();
  const tele = useColorPickTelemetry();
  const recent = useRecentColors();
  const host = useMemo(() => (anchor.closest('[data-color-host]') ?? anchor.closest('[data-room-editor]') ?? document.body) as HTMLElement, [anchor]);
  const pop = useRef<HTMLDivElement>(null);
  const sv = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;
  const [text, setText] = useState(value.slice(1));
  const shown = hsvToHex(hsv);
  /** A pick in progress (drag, keys, typing): its last colour, remembered when it ends. */
  const pending = useRef<string | null>(null);

  // Follow the row's colour when it changes from outside (undo, a preset swatch).
  useEffect(() => {
    if (value.toLowerCase() !== hsvToHex(hsvRef.current)) setHsv((cur) => hexToHsv(value, cur.h));
    setText(value.slice(1));
  }, [value]);

  // The row's callbacks change every render; the throttle is made once and reads the latest through refs.
  const tintRef = useRef(onTint);
  tintRef.current = onTint;
  const endRef = useRef(onGestureEnd);
  endRef.current = onGestureEnd;
  const key = `${gesture}:custom`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const live = useMemo(() => frameThrottle<string>((hex) => tintRef.current(hex, keyRef.current)), []);
  useEffect(() => () => live.cancel(), [live]);

  const set = useCallback(
    (next: Hsv) => {
      setHsv(next);
      const hex = hsvToHex(next);
      setText(hex.slice(1));
      pending.current = hex;
      live.push(hex);
    },
    [live],
  );

  /** End of one pick: the preview is committed as one undo step and remembered. */
  const finish = useCallback(() => {
    live.flush();
    const hex = pending.current;
    pending.current = null;
    endRef.current();
    if (hex) {
      rememberRecentColor(hex);
      tele.picked('custom');
    }
  }, [live, tele]);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const close = useCallback(
    (refocus: boolean) => {
      finishRef.current();
      onClose(refocus);
    },
    [onClose],
  );

  // ── place it under its swatch, inside the window ──
  const place = useCallback(() => {
    const el = pop.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const ph = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = a.right - POP_W + 6;
    left = Math.max(EDGE, Math.min(vw - EDGE - POP_W, left));
    let top = a.bottom + GAP;
    if (top + ph > vh - EDGE) top = Math.max(EDGE, a.top - GAP - ph);
    setPos((p) => {
      const next = { left: Math.round(left - h.left), top: Math.round(top - h.top) };
      return p && p.left === next.left && p.top === next.top ? p : next;
    });
  }, [anchor, host]);

  useLayoutEffect(() => {
    place();
    const onMove = (): void => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [place]);

  // Focus the square once it is placed (keyboard users can work it straight away).
  const focused = useRef(false);
  useEffect(() => {
    if (pos && !focused.current) {
      focused.current = true;
      sv.current?.focus({ preventScroll: true });
    }
  }, [pos]);

  // Outside pointer down closes it (the swatch toggles it itself).
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (!target || pop.current?.contains(target) || anchor.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchor, close]);

  // ── pointer: drag in the square or along the hue bar ──
  const drag = (kind: 'sv' | 'hue') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.focus({ preventScroll: true });
    const at = (ev: { clientX: number; clientY: number }): void => {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      const y = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      const cur = hsvRef.current;
      set(kind === 'sv' ? { h: cur.h, s: x, v: 1 - y } : { ...cur, h: x * 360 });
    };
    at(e);
    const move = (ev: PointerEvent): void => at(ev);
    const up = (): void => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      finishRef.current();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  // ── keys ──
  const onSvKey = (e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = d[e.key];
    if (!m) return;
    e.preventDefault();
    const cur = hsvRef.current;
    set({ h: cur.h, s: Math.max(0, Math.min(1, cur.s + m[0])), v: Math.max(0, Math.min(1, cur.v + m[1])) });
  };
  const onHueKey = (e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? 15 : 3;
    const cur = hsvRef.current;
    const h = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? cur.h - step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? cur.h + step : e.key === 'Home' ? 0 : e.key === 'End' ? 359 : null;
    if (h === null) return;
    e.preventDefault();
    set({ ...cur, h: Math.max(0, Math.min(359.9, h)) });
  };
  const onKeyUp = (e: React.KeyboardEvent): void => {
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') finishRef.current();
  };
  const onRootKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  // ── hex field ──
  const commitText = (): void => {
    const hex = parseHex(text);
    if (!hex) {
      setText(shown.slice(1));
      return;
    }
    if (hex !== shown) {
      setHsv((cur) => hexToHsv(hex, cur.h));
      pending.current = hex;
      tintRef.current(hex, keyRef.current);
    }
    finishRef.current();
    setText(hex.slice(1));
  };

  const pickRecent = (hex: string): void => {
    live.cancel();
    pending.current = null;
    setHsv((cur) => hexToHsv(hex, cur.h));
    tintRef.current(hex, null);
    rememberRecentColor(hex);
    tele.picked('recent');
  };

  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const node = (
    <div
      ref={pop}
      className={styles.pop}
      style={pos ? { left: pos.left, top: pos.top, width: POP_W } : { visibility: 'hidden', left: 0, top: 0, width: POP_W }}
      role="dialog"
      aria-label={label}
      data-color-picker=""
      onKeyDown={onRootKey}
    >
      <div
        ref={sv}
        className={styles.sv}
        style={{ ['--hue' as string]: `hsl(${hsv.h} 100% 50%)` }}
        tabIndex={0}
        role="slider"
        aria-label={t('Saturation and brightness')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`${t('Saturation')} ${pct(hsv.s)}, ${t('Brightness')} ${pct(hsv.v)}`}
        onPointerDown={drag('sv')}
        onKeyDown={onSvKey}
        onKeyUp={onKeyUp}
      >
        <span className={styles.svThumb} style={{ left: pct(hsv.s), top: pct(1 - hsv.v), background: shown }} />
      </div>
      <div
        ref={hue}
        className={styles.hue}
        tabIndex={0}
        role="slider"
        aria-label={t('Hue')}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        onPointerDown={drag('hue')}
        onKeyDown={onHueKey}
        onKeyUp={onKeyUp}
      >
        <span className={styles.hueThumb} style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} />
      </div>
      <div className={styles.hexRow}>
        <span className={styles.preview} style={{ background: shown }} />
        <label className={styles.hexField}>
          <span className={styles.hash}>#</span>
          <input
            className={styles.hexInput}
            value={text}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            aria-label={t('Hex color')}
            onChange={(e) => setText(e.target.value.replace(/^#/, '').slice(0, 6))}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitText();
              }
            }}
          />
        </label>
      </div>
      {recent.length > 0 && (
        <div className={styles.recent}>
          <span className={styles.recentLabel}>{t('Recent')}</span>
          <div className={styles.recentRow} role="group" aria-label={t('Recent colors')}>
            {recent.map((hex) => (
              <button
                key={hex}
                type="button"
                className={hex === shown ? `${styles.recentDot} ${styles.recentOn}` : styles.recentDot}
                style={{ background: hex }}
                aria-label={hex}
                title={hex}
                onClick={() => pickRecent(hex)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
  return createPortal(node, host);
}
