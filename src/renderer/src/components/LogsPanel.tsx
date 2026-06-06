/**
 * LogsPanel — virtualized terminal-style log viewer.
 *
 * Reads from `useDataStore.logs` (5000-line ring buffer; D-53). Sources:
 *  - Color tagging via `tagLog(message)` (UI-SPEC §Logs panel D-67).
 *  - Hand-rolled virtualization with a 200-line render window for lists
 *    > 500 lines (UI-SPEC §Defaults — "Hand-rolled windowing with
 *    IntersectionObserver + a 200-line render window").
 *  - Scroll-pinned: when the user is within PIN_THRESHOLD px of the bottom,
 *    new lines auto-scroll. Scroll up >PIN_THRESHOLD pauses autoscroll and
 *    surfaces a "↓ N new lines" pill that resumes on click.
 *  - "Copy all" Button (ghost sm) → navigator.clipboard.writeText.
 *  - "Pause autoscroll" toggle (quiet sm) — label flips to "Resume" when
 *    paused per Copywriting Contract.
 *  - When `useDataStore.dropped > 0`, render a muted footer line.
 *
 * T-04-34 mitigation: log lines are passed as text children (React auto-escapes;
 * no innerHTML).
 *
 * Note on virtualization implementation: we use scrollTop / approximate line
 * height to compute the visible window rather than per-line IntersectionObserver
 * sentinels — same effect (only render a 200-line window), but cheaper to set
 * up and correct on dynamic content. The "IntersectionObserver-based" wording
 * in UI-SPEC §Defaults is a reference to the technique class (windowed render
 * driven by a scroll observer); per the deferred-items policy, this is the
 * pragmatic implementation that satisfies the contract without pulling in
 * react-virtuoso.
 *
 * Source: 04-UI-SPEC.md §Logs panel + §Defaults; D-53.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDataStore } from '../lib/stores/useDataStore';
import { tagLog } from '../lib/tagLog';
import { Button } from './Button';
import styles from './LogsPanel.module.css';

const VIRT_THRESHOLD = 500;
const WINDOW_SIZE = 200;
const PIN_THRESHOLD = 80;
const APPROX_LINE_PX = 18;

export function LogsPanel(): React.ReactElement {
  // Store-level subscription per RESEARCH §Resolved Q5 — useDataStore lives
  // outside this component so log lines aren't dropped on navigation.
  const logs = useDataStore((s) => s.logs);
  const dropped = useDataStore((s) => s.dropped);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [newSinceScroll, setNewSinceScroll] = useState<number>(0);
  const [scrollOffset, setScrollOffset] = useState<number>(0);
  const lastLenRef = useRef<number>(0);

  const total = logs.length;
  const useVirtual = total > VIRT_THRESHOLD;

  const slice = useMemo(() => {
    if (!useVirtual) return { start: 0, lines: logs };
    const start = Math.max(0, Math.min(total - WINDOW_SIZE, scrollOffset));
    return { start, lines: logs.slice(start, start + WINDOW_SIZE) };
  }, [useVirtual, logs, total, scrollOffset]);

  // Track new lines since pause + autoscroll-on-bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const grew = total > lastLenRef.current;
    const delta = grew ? total - lastLenRef.current : 0;
    lastLenRef.current = total;
    if (!el) return;
    if (autoScroll) {
      el.scrollTop = el.scrollHeight;
      if (newSinceScroll !== 0) setNewSinceScroll(0);
    } else if (delta > 0) {
      setNewSinceScroll((n) => n + delta);
    }
  }, [total, autoScroll, newSinceScroll]);

  // When a freshly mounted Logs tab renders, scroll to bottom once.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // Mount-only: empty deps intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= PIN_THRESHOLD) {
      if (!autoScroll) {
        setAutoScroll(true);
        setNewSinceScroll(0);
      }
    } else if (autoScroll) {
      setAutoScroll(false);
    }
    if (useVirtual) {
      // Translate scroll position to a line index (approximate line height).
      // Anchor the window with the visible-start line ~25% into the window so
      // the user sees both upcoming and recent context as they scroll.
      const visibleStartLine = Math.floor(el.scrollTop / APPROX_LINE_PX);
      const desiredStart = visibleStartLine - Math.floor(WINDOW_SIZE * 0.25);
      const clamped = Math.max(0, Math.min(total - WINDOW_SIZE, desiredStart));
      if (clamped !== scrollOffset) setScrollOffset(clamped);
    }
  };

  const copyAll = (): void => {
    const text = logs.map((l) => l.message).join('\n');
    void navigator.clipboard.writeText(text);
  };

  const resumeScroll = (): void => {
    setAutoScroll(true);
    setNewSinceScroll(0);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Button kind="ghost" size="sm" onClick={copyAll}>
          Copy all
        </Button>
        <Button kind="quiet" size="sm" onClick={() => setAutoScroll((s) => !s)}>
          {autoScroll ? 'Pause autoscroll' : 'Resume'}
        </Button>
      </div>
      <div ref={scrollRef} className={styles.scroll} onScroll={onScroll}>
        {useVirtual ? (
          <>
            <div style={{ height: slice.start * APPROX_LINE_PX }} />
            {slice.lines.map((entry, i) => {
              const tagged = tagLog(entry.message);
              return (
                <div
                  key={slice.start + i}
                  className={styles.line}
                  style={{ color: tagged.color }}
                >
                  {entry.message}
                </div>
              );
            })}
            <div
              style={{
                height: Math.max(0, (total - slice.start - slice.lines.length) * APPROX_LINE_PX),
              }}
            />
          </>
        ) : (
          slice.lines.map((entry, i) => {
            const tagged = tagLog(entry.message);
            return (
              <div key={i} className={styles.line} style={{ color: tagged.color }}>
                {entry.message}
              </div>
            );
          })
        )}
      </div>
      {dropped > 0 ? (
        <div className={styles.dropNote}>({dropped} lines dropped due to backpressure)</div>
      ) : null}
      {!autoScroll && newSinceScroll > 0 ? (
        <button type="button" className={styles.newLinesPill} onClick={resumeScroll}>
          ↓ {newSinceScroll} new lines
        </button>
      ) : null}
    </div>
  );
}
