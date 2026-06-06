/**
 * LogsBar — collapsible bottom log strip for the app shell.
 *
 * Collapsed (default): a thin (~30px) bar showing the LOGS label, a preview
 * of the latest log line (truncated to one line), and a chevron-up. Click
 * anywhere on the bar to expand.
 *
 * Expanded: bar header (chevron-down) + a constrained-height LogsPanel
 * below it, with a drag-handle on the top edge to resize between
 * MIN_PANEL_HEIGHT_PX and MAX_PANEL_HEIGHT_PX.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDataStore } from '../lib/stores/useDataStore';
import { LogsPanel } from './LogsPanel';
import styles from './LogsBar.module.css';

const DEFAULT_PANEL_HEIGHT_PX = 280;
const MIN_PANEL_HEIGHT_PX = 120;
const MAX_PANEL_HEIGHT_PX = 720;

export function LogsBar(): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);
  const [height, setHeight] = useState<number>(DEFAULT_PANEL_HEIGHT_PX);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const preview = useDataStore((s) =>
    s.logs.length > 0 ? s.logs[s.logs.length - 1].message : '',
  );

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startY - e.clientY;
    const next = Math.min(
      MAX_PANEL_HEIGHT_PX,
      Math.max(MIN_PANEL_HEIGHT_PX, dragRef.current.startH + delta),
    );
    setHeight(next);
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [onPointerMove]);

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  const onHandlePointerDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startY: e.clientY, startH: height };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className={open ? styles.rootOpen : styles.root}>
      {open ? (
        <div
          className={styles.resizeHandle}
          onPointerDown={onHandlePointerDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize console"
          title="Drag to resize"
        />
      ) : null}
      <button
        type="button"
        className={styles.header}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? 'Collapse console' : 'Expand console'}
      >
        <span className={styles.label}>CONSOLE</span>
        {!open ? (
          <span className={styles.preview} title={preview}>
            {preview || '-'}
          </span>
        ) : (
          <span className={styles.previewSpacer} />
        )}
        <span className={styles.chevron} aria-hidden="true">
          {open ? '▾' : '▴'}
        </span>
      </button>
      {open ? (
        <div className={styles.panelWrap} style={{ height }}>
          <LogsPanel />
        </div>
      ) : null}
    </div>
  );
}
