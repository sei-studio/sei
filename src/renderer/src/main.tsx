// Must stay the first import: see devHarnessStubs.ts.
import './devHarnessStubs';
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
} else if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('dashshot')) {
  // Dev-only screenshot harness (260909): http://localhost:5173/?dashshot=1
  // renders the Don't Starve Together + Stardew Valley dashboards over
  // fixture snapshots (or one of them with ?dashshot=dontstarve|stardew), no
  // summon and no real IPC, so the game-styled panels can be checked in a
  // plain browser tab. Lazy import keeps it out of prod bundles.
  const which = new URLSearchParams(window.location.search).get('dashshot') ?? '';
  if (which === 'screen') {
    // 261103: the real screens in the real shell (DevScreenShot).
    void import('./components/DevScreenShot').then(({ DevScreenShot }) => {
      root.render(<DevScreenShot />);
    });
  } else {
    void import('./components/games/DevDashShot').then(({ DevDashShot }) => {
      root.render(<DevDashShot which={which} />);
    });
  }
  // 260803: the `?backseat=1` branch is gone with the backseat overlay window.
  // Screen sharing is a call feature now and its capture runs in THIS window;
  // see lib/stores/useBackseatStore.ts for why that is safe.
} else if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('facepack')) {
  // Dev-only facepack preview (261028, desktop companion pilot):
  // http://localhost:5173/?facepack=1 (see DevFacepackPreview for params), or
  // main's dev-flag preview window. Lazy import keeps it out of prod bundles.
  void import('./components/DevFacepackPreview').then(({ DevFacepackPreview }) => {
    root.render(<DevFacepackPreview />);
  });
} else if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('seilinkintro')) {
  // Dev-only SeiLink first-link intro (261105, T337). See DevIntroPreview.
  void import('./components/seilink/intro/DevIntroPreview').then(({ DevIntroPreview }) => {
    root.render(<DevIntroPreview />);
  });
} else if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('seilinkhost')) {
  // Dev-only SeiLink wallpaper page with the dock and a bubble (261104, M4),
  // over a fake host bridge. See DevHostPreview for params.
  void import('./components/seilink/host/DevHostPreview').then(({ DevHostPreview }) => {
    root.render(<DevHostPreview />);
  });
} else if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('seilink')) {
  // Dev-only SeiLink room preview (261104): main's dev window (unpackaged +
  // SEI_SEILINK_PACKS) or a browser tab with &pack=<url>. See DevRoomPreview.
  void import('./components/seilink/DevRoomPreview').then(({ DevRoomPreview }) => {
    root.render(<DevRoomPreview />);
  });
} else if (new URLSearchParams(window.location.search).has('overlay')) {
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  root.render(<CallOverlay />);
} else if (new URLSearchParams(window.location.search).has('captions')) {
  // The caption overlay window (260806) — same pattern as ?overlay=1: its own
  // transparent BrowserWindow, mounting only the caption box. Lazy so the
  // main window and the avatar overlay never pay for it.
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  void import('./CaptionOverlay').then(({ CaptionOverlay }) => {
    root.render(<CaptionOverlay />);
  });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
