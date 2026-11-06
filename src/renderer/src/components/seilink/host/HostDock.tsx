/**
 * The SeiLink dock and her speech bubble, drawn by the room host page
 * (261104, M4).
 *
 * The dock is a small glass pill of three round buttons at the bottom of the
 * work area (above the taskbar or the Dock), beside her (dockPlace.ts): edit her room,
 * deafen (mute her idle lines; a reply to a double click still shows), and
 * move out. The room-editor design deck puts these shortcuts in "the bottom
 * dock" of the room itself, so it lives on the wallpaper next to her rather
 * than in the app or the tray.
 *
 * The page never gets DOM clicks (the room is behind the desktop icons), so
 * the dock reports its buttons' boxes (onButtons, part of the native click
 * area) and the host tells it which button was pressed (`press`). Move out
 * asks once more: the first press turns the button into "Move out?" for a
 * few seconds, a second press confirms. A short caption above the dock says
 * what a press did (there is no hover to explain an icon).
 *
 * 261106: the decorate-together offer (main/seilink/decorateOffer.ts). After
 * her first move-in into a blank room the dock swaps its icons for two text
 * buttons, "Decorate together" and "Not now". When she asked in her bubble
 * (`offer: 'her'`) the buttons are the answer; when her line did not come
 * (`prompt`) the dock asks itself, in a line above them. "Not now" leaves a
 * caption pointing at the brush, and the usual dock comes back. On the plain
 * background (first-link v3: no room yet) the offer is to set her room up
 * together ("Set up together"), which opens the editor's guided setup.
 *
 * Colours come from the room (RoomCanvas onOverlay: light room, light glass),
 * never the app theme. No border lines on buttons.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SeilinkBox, SeilinkDockAction, SeilinkDockButton, SeilinkDockOffer } from '@shared/seilinkHost';
import { useT } from '../../../lib/i18n';
import { BrushIcon, BubbleIcon, BubbleOffIcon, MoveOutIcon } from '../roomEditorIcons';
import { dockBottom, dockLeft } from '../../../lib/seilink/dockPlace';
import styles from './HostDock.module.css';

/** How long "Move out?" waits for the second press. */
export const MOVE_OUT_CONFIRM_MS = 4_000;
const CAPTION_MS = 2_600;
/** "Not now" leaves a longer caption: it says where decorating lives from now on. */
const LATER_CAPTION_MS = 5_000;

export interface DockPress {
  id: SeilinkDockAction;
  n: number;
}

export interface HostDockProps {
  workArea: SeilinkBox;
  /** Her box (page CSS px): the dock sits beside it. */
  her: SeilinkBox | null;
  /** Her seat's x (page CSS px): the dock centres under it when there is no room beside her. */
  anchorX: number;
  deafened: boolean;
  /** 261106: the decorate-together offer ('none' = the usual dock). */
  offer?: SeilinkDockOffer;
  /** Her name, for the offer's question. */
  name?: string;
  /** She is on the plain background (no room yet): the offer is to set the room up. */
  plain?: boolean;
  press: DockPress | null;
  onAction(action: SeilinkDockAction): void;
  onButtons(buttons: SeilinkDockButton[] | null): void;
  /** Dev / screenshots: start with move out asking. */
  initialConfirm?: boolean;
}

function sameButtons(a: SeilinkDockButton[] | null, b: SeilinkDockButton[] | null): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.id === y.id && Math.abs(x.x - y.x) < 1 && Math.abs(x.y - y.y) < 1 && Math.abs(x.w - y.w) < 1 && Math.abs(x.h - y.h) < 1;
  });
}

export function HostDock(props: HostDockProps): React.ReactElement {
  const { workArea, her, anchorX, deafened, press, onAction, onButtons } = props;
  const offer = props.offer ?? 'none';
  const t = useT();
  const [confirming, setConfirming] = useState(props.initialConfirm === true);
  const [caption, setCaption] = useState<{ text: string; ms: number } | null>(null);
  const [pressed, setPressed] = useState<SeilinkDockAction | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // A press from the host.
  const last = useRef<number>(0);
  useEffect(() => {
    if (!press || press.n === last.current) return;
    last.current = press.n;
    setPressed(press.id);
    if (press.id === 'moveout') {
      if (confirming) {
        setConfirming(false);
        onAction('moveout');
      } else {
        setConfirming(true);
      }
      return;
    }
    setConfirming(false);
    if (press.id === 'deafen') setCaption({ text: deafened ? t('Idle lines on') : t('Idle lines off'), ms: CAPTION_MS });
    else if (press.id === 'later')
      setCaption({ text: props.plain ? t('Set up the room anytime with the brush.') : t('Decorate anytime with the brush.'), ms: LATER_CAPTION_MS });
    else if (press.id === 'edit' || press.id === 'decorate') setCaption({ text: t('Opening the room editor'), ms: CAPTION_MS });
    onAction(press.id);
  }, [press, confirming, deafened, onAction, t, props.plain]);

  useEffect(() => {
    if (!pressed) return;
    const id = setTimeout(() => setPressed(null), 180);
    return () => clearTimeout(id);
  }, [pressed]);

  useEffect(() => {
    if (!confirming || props.initialConfirm) return;
    const id = setTimeout(() => setConfirming(false), MOVE_OUT_CONFIRM_MS);
    return () => clearTimeout(id);
  }, [confirming, props.initialConfirm]);

  useEffect(() => {
    if (!caption) return;
    const id = setTimeout(() => setCaption(null), caption.ms);
    return () => clearTimeout(id);
  }, [caption]);

  // Where it sits: beside her at the bottom of the work area. Placed by its
  // collapsed width, so "Move out?" grows it away from her instead of moving it.
  const restWidth = useRef(0);
  const rest = restWidth.current || width;
  const placed = dockLeft(workArea, her, anchorX, rest);
  // Left of her: grow leftwards, away from her.
  const left = her && placed + rest <= her.x ? placed - Math.max(0, width - rest) : placed;
  const bottom = dockBottom(workArea);

  // Report the buttons' boxes whenever they may have moved.
  const lastSent = useRef<SeilinkDockButton[] | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const w = root.getBoundingClientRect().width;
    if (!confirming) restWidth.current = w;
    if (Math.abs(w - width) >= 1) setWidth(w);
    const buttons: SeilinkDockButton[] = [];
    root.querySelectorAll<HTMLElement>('[data-dock]').forEach((el) => {
      const r = el.getBoundingClientRect();
      buttons.push({ id: el.dataset.dock as SeilinkDockAction, x: r.left, y: r.top, w: r.width, h: r.height });
    });
    const next = buttons.length ? buttons : null;
    if (sameButtons(next, lastSent.current)) return;
    lastSent.current = next;
    onButtons(next);
  });
  useEffect(() => () => onButtons(null), [onButtons]);

  const cls = (id: SeilinkDockAction, extra = ''): string => [styles.btn, extra, pressed === id ? styles.pressed : ''].filter(Boolean).join(' ');

  if (offer !== 'none') {
    return (
      <div ref={rootRef} className={styles.dockWrap} style={{ left, top: bottom }}>
        {offer === 'prompt' ? (
          <div className={styles.ask} role="status">
            {props.plain
              ? props.name
                ? t("Set up {name}'s room together?", { name: props.name })
                : t('Set up the room together?')
              : props.name
                ? t("Decorate {name}'s room together?", { name: props.name })
                : t('Decorate the room together?')}
          </div>
        ) : null}
        <div className={styles.dock}>
          <span data-dock="decorate" className={cls('decorate', styles.textBtn + ' ' + styles.primary)}>
            <BrushIcon size={16} />
            {props.plain ? t('Set up together') : t('Decorate together')}
          </span>
          <span data-dock="later" className={cls('later', styles.textBtn)}>
            {t('Not now')}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={styles.dockWrap} style={{ left, top: bottom }}>
      {caption ? (
        <div className={styles.caption} role="status">
          {caption.text}
        </div>
      ) : null}
      <div className={styles.dock}>
        <span data-dock="edit" className={cls('edit')} aria-label={t('Edit room')}>
          <BrushIcon size={18} />
        </span>
        <span data-dock="deafen" className={cls('deafen', deafened ? styles.off : '')} aria-label={deafened ? t('Turn idle lines on') : t('Mute idle lines')}>
          {deafened ? <BubbleOffIcon size={18} /> : <BubbleIcon size={18} />}
        </span>
        <span data-dock="moveout" className={cls('moveout', confirming ? styles.confirm : '')} aria-label={t('Move out')}>
          <MoveOutIcon size={18} />
          {confirming ? <span className={styles.confirmText}>{t('Move out?')}</span> : null}
        </span>
      </div>
    </div>
  );
}

// ── Her speech bubble ───────────────────────────────────────────────────────

/** How long a line stays up: long enough to read it. */
export function bubbleMs(text: string): number {
  return Math.max(3_500, Math.min(9_000, 2_500 + text.length * 60));
}

/** How long her mouth moves for it (about how long saying it would take). */
export function speakMs(text: string): number {
  return Math.max(1_200, Math.min(5_000, text.length * 55));
}

export function HostBubble({ text, her, workArea }: { text: string; her: SeilinkBox; workArea: SeilinkBox }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r && (Math.abs(r.width - size.w) >= 1 || Math.abs(r.height - size.h) >= 1)) setSize({ w: r.width, h: r.height });
  });
  // Above her head, kept on screen; under it near the top edge.
  const gap = 14;
  const cx = her.x + her.w / 2;
  const left = Math.max(workArea.x + 12, Math.min(cx - size.w / 2, workArea.x + workArea.w - size.w - 12));
  const above = her.y - gap - size.h;
  const top = above >= workArea.y + 12 ? above : her.y + gap;
  const tail = Math.max(16, Math.min(size.w - 16, cx - left));
  return (
    <div ref={ref} className={styles.bubble} style={{ left, top, visibility: size.w ? 'visible' : 'hidden', '--tail': `${tail}px` } as React.CSSProperties}>
      {text}
    </div>
  );
}
