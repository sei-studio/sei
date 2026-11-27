/**
 * Whether anyone can see the window: the document is visible and the window
 * has focus. The "{Name} is thinking…" shimmer pauses when this is false; it
 * repaints its text every frame, which cost about 12% CPU on a Mac while the
 * player was in Minecraft during every companion turn.
 */
import { useSyncExternalStore } from 'react';

type Listen = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export function windowWatched(doc: Pick<Document, 'hidden' | 'hasFocus'>): boolean {
  return !doc.hidden && (typeof doc.hasFocus === 'function' ? doc.hasFocus() : true);
}

/** Calls onChange on focus, blur and visibility changes; returns the unsubscribe. */
export function watchWindow(win: Listen, doc: Listen, onChange: () => void): () => void {
  win.addEventListener('focus', onChange);
  win.addEventListener('blur', onChange);
  doc.addEventListener('visibilitychange', onChange);
  return () => {
    win.removeEventListener('focus', onChange);
    win.removeEventListener('blur', onChange);
    doc.removeEventListener('visibilitychange', onChange);
  };
}

const subscribe = (onChange: () => void): (() => void) => watchWindow(window, document, onChange);
const snapshot = (): boolean => windowWatched(document);
const serverSnapshot = (): boolean => true;

export function useWindowWatched(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
