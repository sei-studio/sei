/**
 * Decorating her room together (261105, T336), the editor side. Drawn over
 * the room by RoomEditor's `together` render prop, only for the companion who
 * lives on the desktop.
 *
 *  - Sends the editor's unsaved room to main (debounced), so her live lines,
 *    talk-box turns and call turns see what the player sees.
 *  - Her bubble above her head: the newest companion line in her chat since
 *    the editor opened (a live line, a talk-box reply, a spoken call line),
 *    with typing dots while one is on its way.
 *  - The talk box: her normal chat turn (useChatStore.send), so the messages
 *    land in her chat history. Hidden on a call (she hears you there). Over
 *    the plan limit it shows the usage limit and opens the usual wall.
 *  - Her edits (seilink:editor-event): applied with the editor's own ops as
 *    ONE undo step, crossfaded in, the changed parts ringed for a moment, and
 *    a one-tap "Undo {name}'s changes" chip. A suggestion shows "Try
 *    {name}'s idea" instead.
 *  - On a call: a small call pill (mute, hang up), and edits count as being
 *    there for the call's inactivity check.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyRoomOps, opTargets, type RoomEditOp } from '@shared/seilinkDecorate';
import { SEILINK_HER_EDIT_EVENT, SEILINK_EDITOR_TALK_EVENT, isTogetherCount, type SeilinkEditorEvent } from '@shared/seilinkTogether';
import type { RoomState } from '@shared/seilinkRoom';
import type { RoomTogetherCtx } from './RoomEditor';
import { CallControls } from '../call/CallControls';
import { SendIcon } from '../icons';
import { CloseIcon, SparkleIcon, UndoIcon } from './roomEditorIcons';
import { useT } from '../../lib/i18n';
import { useChatStore } from '../../lib/stores/useChatStore';
import { useCreditsStore } from '../../lib/stores/useCreditsStore';
import { useVoiceStore } from '../../lib/stores/useVoiceStore';
import { sei } from '../../lib/ipcClient';
import { bubbleMs, freshCompanionLine } from '../../lib/seilink/togetherBubble';
import styles from './RoomTogether.module.css';

/** The editor's room goes to main this long after the last change. */
export const SYNC_DEBOUNCE_MS = 400;
/** Her rings stay this long. */
const RING_MS = 2400;
const FADE_MS = 650;
/** An edit during a call counts as being there at most this often. */
const PRESENCE_EVERY_MS = 15_000;
const TALK_MAX = 500;

function track(event: string, props: Record<string, string | number | boolean | null>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics never disrupts the editor */
  }
}

interface HerChange {
  state: RoomState;
  items: number[];
  slots: string[];
  at: number;
}

export interface RoomTogetherProps {
  ctx: RoomTogetherCtx;
  token: string;
  characterId: string;
  name: string;
}

export function RoomTogether({ ctx, token, characterId, name }: RoomTogetherProps): React.ReactElement {
  const t = useT();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const onCall = useVoiceStore((s) => s.participants.includes(characterId) && s.status !== 'idle' && s.status !== 'error');
  const overLimit = useCreditsStore((s) => s.over_limit);
  const awaiting = useChatStore((s) => s.awaiting[characterId] === true);
  const messages = useChatStore((s) => s.messages[characterId]);
  const [her, setHer] = useState<HerChange | null>(null);
  const [idea, setIdea] = useState<{ ops: RoomEditOp[]; at: number } | null>(null);
  const [fade, setFade] = useState<{ canvas: HTMLCanvasElement; key: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [bubble, setBubble] = useState<{ id: string; text: string } | null>(null);

  // ── open: the session counters know it is shared; her chat is loaded ──
  useEffect(() => {
    ctxRef.current.analytics.opened(useVoiceStore.getState().participants.includes(characterId));
    void useChatStore.getState().load(characterId);
  }, [characterId]);

  // ── the editor's room, to main ──
  const state = ctx.state;
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        sei.seilinkEditorSync?.({ token, characterId, state });
      } catch {
        /* main may be gone (window closing) */
      }
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [token, characterId, state]);

  // ── on a call, decorating is being there (the call's inactivity check) ──
  const lastPresence = useRef(0);
  const firstState = useRef(state);
  useEffect(() => {
    if (!onCall || state === firstState.current) return;
    const now = Date.now();
    if (now - lastPresence.current < PRESENCE_EVERY_MS) return;
    lastPresence.current = now;
    useVoiceStore.getState().confirmPresence();
  }, [onCall, state]);

  // ── her bubble: the newest companion line since the editor opened ──
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!messages) return;
    if (!seen.current) {
      seen.current = new Set(messages.map((m) => m.id));
      return;
    }
    const last = freshCompanionLine(seen.current, messages);
    if (last) setBubble(last);
  }, [messages]);
  useEffect(() => {
    if (!bubble) return;
    const id = setTimeout(() => setBubble((b) => (b?.id === bubble.id ? null : b)), bubbleMs(bubble.text));
    return () => clearTimeout(id);
  }, [bubble]);

  // ── her edits ──
  const crossfade = useCallback(() => {
    const c = ctxRef.current;
    const scene = c.sceneEl();
    const canvas = snapshotScene(scene, c);
    if (canvas) setFade({ canvas, key: Date.now() });
  }, []);

  const applyHers = useCallback(
    (ops: RoomEditOp[]): boolean => {
      const c = ctxRef.current;
      const before = c.state;
      const { state: next, applied } = applyRoomOps(c.manifest, before, ops);
      if (!applied.length) return false;
      crossfade();
      c.analytics.markHers(next);
      c.commit(next);
      const targets = opTargets(c.manifest, before, applied);
      setHer({ state: next, items: targets.items, slots: targets.slots, at: Date.now() });
      return true;
    },
    [crossfade],
  );

  useEffect(
    () =>
      sei.onSeilinkEditorEvent?.((ev: SeilinkEditorEvent) => {
        if (ev.token !== token) return;
        if (ev.kind === 'count') {
          if (isTogetherCount(ev.key)) ctxRef.current.analytics.count(ev.key);
          return;
        }
        if (ev.mode === 'suggest') setIdea({ ops: ev.ops, at: Date.now() });
        else applyHers(ev.ops);
      }),
    [token, applyHers],
  );

  // Her rings fade on their own; the undo chip stays while the room is still hers.
  const [ringsOn, setRingsOn] = useState(false);
  useEffect(() => {
    if (!her) return;
    setRingsOn(true);
    // Counted from the first frame after her change: drawing her new parts can hold the thread for a moment.
    return afterPaint(() => setRingsOn(false), RING_MS);
  }, [her]);
  useEffect(() => {
    if (!fade) return;
    return afterPaint(() => setFade((f) => (f?.key === fade.key ? null : f)), FADE_MS + 120);
  }, [fade]);

  const hersNow = her !== null && ctx.state === her.state;
  const undoHers = (): void => {
    if (!her) return;
    crossfade();
    if (ctx.undoIf(her.state)) {
      ctx.analytics.count('her_edits_undone');
      track(SEILINK_HER_EDIT_EVENT, { character_id: characterId, outcome: 'undone' });
    }
    setHer(null);
  };
  const tryIdea = (): void => {
    if (!idea) return;
    if (applyHers(idea.ops)) {
      ctx.analytics.count('her_edits_tried');
      track(SEILINK_HER_EDIT_EVENT, { character_id: characterId, outcome: 'tried' });
    }
    setIdea(null);
  };

  // ── the talk box ──
  const send = (): void => {
    const text = draft.trim().slice(0, TALK_MAX);
    if (!text || awaiting) return;
    if (overLimit) {
      ctx.analytics.count('talk_blocked');
      track(SEILINK_EDITOR_TALK_EVENT, { character_id: characterId, outcome: 'limit' });
      openUsageWall();
      return;
    }
    setDraft('');
    ctx.analytics.count('talk_messages');
    void useChatStore
      .getState()
      .send(characterId, text)
      .then(
        (r) => track(SEILINK_EDITOR_TALK_EVENT, { character_id: characterId, outcome: r ? 'sent' : 'error' }),
        () => track(SEILINK_EDITOR_TALK_EVENT, { character_id: characterId, outcome: 'error' }),
      );
  };

  // ── where things go ──
  const head = useMemo(() => {
    const a = ctx.manifest.avatar;
    const x = ctx.vp.left + a.x * ctx.vp.scale;
    const top = ctx.vp.top + (a.y - a.height) * ctx.vp.scale;
    return { x, top };
  }, [ctx.manifest, ctx.vp]);
  void ctx.pickTick; // rings re-measure once the new parts' maps are ready
  const rings = ringsOn && her ? herRects(ctx, her) : [];

  const bubbleText = bubble?.text ?? null;
  const showBubble = Boolean(bubbleText) || awaiting;
  return (
    <>
      {fade && (
        <FadeLayer
          key={fade.key}
          canvas={fade.canvas}
          style={{ left: ctx.vp.left, top: ctx.vp.top, width: ctx.vp.width, height: ctx.vp.height, animationDuration: `${FADE_MS}ms` }}
        />
      )}
      {rings.map((r, i) => (
        <div key={`${her?.at}:${i}`} className={styles.ring} style={r} aria-hidden="true" data-her-ring="" />
      ))}

      {showBubble && (
        <div className={styles.bubbleAnchor} style={{ left: head.x, top: Math.max(56, head.top - 10) }}>
          <div className={styles.bubble} role="status" aria-live="polite">
            {bubbleText && !awaiting ? (
              <span className={styles.bubbleText}>{bubbleText}</span>
            ) : (
              <span className={styles.dots} aria-label={t('{name} is typing…', { name })}>
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
        </div>
      )}

      <div className={styles.dock}>
        {(hersNow || idea) && (
          <div className={styles.chips}>
            {idea && (
              <span className={styles.chipGroup}>
                <button type="button" className={`${styles.chip} ${styles.chipHot}`} onClick={tryIdea}>
                  <SparkleIcon size={14} />
                  {t("Try {name}'s idea", { name })}
                </button>
                <button type="button" className={styles.chipX} aria-label={t('Dismiss')} title={t('Dismiss')} onClick={() => setIdea(null)}>
                  <CloseIcon size={14} />
                </button>
              </span>
            )}
            {hersNow && (
              <button type="button" className={styles.chip} onClick={undoHers}>
                <UndoIcon size={15} />
                {t("Undo {name}'s changes", { name })}
              </button>
            )}
          </div>
        )}
        {onCall ? (
          <div className={styles.call}>
            <span className={styles.callName}>{t('On a call with {name}', { name })}</span>
            <CallControls size="sm" onArt />
          </div>
        ) : overLimit ? (
          <div className={styles.talk}>
            <span className={styles.limit}>{t('Usage limit reached')}</span>
            <button type="button" className={styles.limitBtn} onClick={openUsageWall}>
              {t('See options')}
            </button>
          </div>
        ) : (
          <form
            className={styles.talk}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              className={styles.input}
              value={draft}
              maxLength={TALK_MAX}
              placeholder={t('Say something to {name}…', { name })}
              aria-label={t('Say something to {name}…', { name })}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Typing here is not an editor shortcut; Escape leaves the box first.
                e.stopPropagation();
                if (e.key === 'Escape') e.currentTarget.blur();
              }}
            />
            <button type="submit" className={styles.send} aria-label={t('Send')} title={t('Send')} disabled={!draft.trim() || awaiting}>
              <SendIcon size={17} />
            </button>
          </form>
        )}
      </div>
    </>
  );
}

/** Runs `fn` `ms` after the next painted frame; returns the cancel. */
function afterPaint(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const raf = requestAnimationFrame(() => {
    timer = setTimeout(fn, ms);
  });
  return () => {
    cancelAnimationFrame(raf);
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** The room as it was, fading out over her change (the snapshot canvas itself, nothing encoded). */
function FadeLayer({ canvas, style }: { canvas: HTMLCanvasElement; style: React.CSSProperties }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    host.appendChild(canvas);
    return () => {
      canvas.remove();
    };
  }, [canvas]);
  return <div ref={ref} className={styles.fade} style={style} aria-hidden="true" data-her-fade="" />;
}

/** The usual usage-limit wall (HardStopModal), lifted over the editor. */
function openUsageWall(): void {
  useCreditsStore.setState({ hardStopActive: true, hardStopReason: 'depleted' });
}

/** CSS rects (in the overlay) of the parts her change touched; parts the size of the room get none. */
function herRects(ctx: RoomTogetherCtx, her: HerChange): React.CSSProperties[] {
  const out: React.CSSProperties[] = [];
  const [cw, ch] = ctx.manifest.canvas;
  const push = (r: [number, number, number, number] | null): void => {
    if (!r) return;
    if (r[2] * r[3] > cw * ch * 0.6) return;
    const pad = 10;
    out.push({
      left: ctx.vp.left + r[0] * ctx.vp.scale - pad,
      top: ctx.vp.top + r[1] * ctx.vp.scale - pad,
      width: r[2] * ctx.vp.scale + pad * 2,
      height: r[3] * ctx.vp.scale + pad * 2,
    });
  };
  for (const i of her.items) push(ctx.picker.itemRect(ctx.manifest, her.state, ctx.time, ctx.pack.resolve, i));
  for (const s of her.slots) push(ctx.picker.slotRect(ctx.manifest, her.state, ctx.time, ctx.pack.resolve, s as never));
  return out.slice(0, 6);
}

/**
 * The room as drawn right now, as a canvas for the crossfade: the canvas
 * layers of the scene (her avatar between them is left out, and her box is
 * cleared so she stays herself while the room changes around her).
 */
function snapshotScene(scene: HTMLElement | null, ctx: RoomTogetherCtx): HTMLCanvasElement | null {
  if (!scene) return null;
  try {
    const w = scene.clientWidth;
    const h = scene.clientHeight;
    if (!w || !h) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const out = document.createElement('canvas');
    out.width = Math.round(w * dpr);
    out.height = Math.round(h * dpr);
    const g = out.getContext('2d');
    if (!g) return null;
    for (const c of Array.from(scene.querySelectorAll(':scope > canvas')) as HTMLCanvasElement[]) {
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0' || cs.mixBlendMode !== 'normal') continue;
      if (!c.width || !c.height) continue;
      g.drawImage(c, 0, 0, out.width, out.height);
    }
    const a = ctx.manifest.avatar;
    const s = ctx.vp.scale * dpr;
    const bw = a.height * 0.9 * s;
    g.clearRect(a.x * s - bw / 2, (a.y - a.height * 1.05) * s, bw, a.height * 1.1 * s);
    return out;
  } catch {
    return null;
  }
}
