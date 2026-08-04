import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { CallOverlay } from './CallOverlay';

const root = ReactDOM.createRoot(document.getElementById('root')!);

// The always-on-top call overlay (task 4) loads this SAME bundle in its own
// transparent BrowserWindow with an `?overlay=1` marker. In that window mount
// ONLY the lightweight CallOverlay (never the full App, which would re-run the
// whole app), and make the page transparent so only the circles paint.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('chessshot')) {
  // Dev-only screenshot harness (260721): http://localhost:5173/?chessshot=1
  // renders ONLY the 3D chess scene, full viewport, no HUD, no window.sei —
  // works in a plain browser tab. Lazy import keeps it out of prod bundles.
  void import('./components/chess/DevChessShot').then(({ DevChessShot }) => {
    root.render(<DevChessShot />);
  });
  // 260803: the `?backseat=1` branch is gone with the backseat overlay window.
  // Screen sharing is a call feature now and its capture runs in THIS window;
  // see lib/stores/useBackseatStore.ts for why that is safe.
} else if (new URLSearchParams(window.location.search).has('overlay')) {
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  root.render(<CallOverlay />);
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
