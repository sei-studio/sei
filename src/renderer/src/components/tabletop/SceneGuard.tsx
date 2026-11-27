/**
 * SceneGuard — what a 3D game panel shows when its WebGL scene cannot run.
 *
 * Two ways a scene fails:
 *   - WebGL cannot be created at all (no GPU driver, blocklisted, too many
 *     contexts): three.js throws from `new WebGLRenderer()` inside the board's
 *     mount effect. SceneBoundary catches it, so the chat screen around the
 *     panel keeps working.
 *   - The context is lost later (GPU reset, driver update, sleep): the canvas
 *     goes blank. watchWebglContext reports it, and the panel shows the same
 *     notice until the browser restores the context (three.js re-creates its
 *     GPU state on restore; the board then asks the scene for a fresh frame).
 *
 * Either way the panel shows one line and a Close button instead of the board.
 * Shared by chess, Four in a Row and Fleet Battle; it draws nothing while the
 * scene works, so the games look exactly the same.
 */

import React from 'react';
import { useT } from '../../lib/i18n';
import { Button } from '../Button';
import hud from './TabletopHud.module.css';

interface BoundaryProps {
  /** Called once when a child throws (the panel then shows the notice). */
  onFail: () => void;
  children: React.ReactNode;
}

export class SceneBoundary extends React.Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(err: unknown): void {
    console.error('[sei/tabletop] 3D scene failed', err);
    this.props.onFail();
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Report WebGL context loss and restore for any canvas inside `el` (capture
 * phase: the events do not bubble). Returns the unsubscribe.
 */
export function watchWebglContext(el: HTMLElement, onChange: (lost: boolean) => void): () => void {
  const lost = (): void => onChange(true);
  const restored = (): void => onChange(false);
  const opts = { capture: true };
  el.addEventListener('webglcontextlost', lost, opts);
  el.addEventListener('webglcontextrestored', restored, opts);
  return () => {
    el.removeEventListener('webglcontextlost', lost, opts);
    el.removeEventListener('webglcontextrestored', restored, opts);
  };
}

export function SceneFailedNotice({ onClose }: { onClose: () => void }): React.ReactElement {
  const t = useT();
  return (
    <div className={hud.sceneFailed} role="alert">
      <p className={hud.sceneFailedText}>{t("The 3D board couldn't load on this computer.")}</p>
      <Button kind="quiet" size="sm" onClick={onClose}>
        {t('Close')}
      </Button>
    </div>
  );
}
