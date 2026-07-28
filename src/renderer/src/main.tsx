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
} else if (new URLSearchParams(window.location.search).has('backseat')) {
  // Backseat (260728) loads the same bundle in its own always-on-top window.
  // That window is not just chrome: it OWNS the screen-share capture, because
  // it is the one window guaranteed to stay visible while the player is in a
  // fullscreen game. Capturing from the main window instead would mean the
  // ring buffer stops the moment the game takes over the display.
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  void import('./components/backseat/BackseatOverlay').then(({ BackseatOverlay }) => {
    root.render(<BackseatOverlay />);
  });
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
