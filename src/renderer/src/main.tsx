import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { CallOverlay } from './CallOverlay';

const root = ReactDOM.createRoot(document.getElementById('root')!);

// The always-on-top call overlay (task 4) loads this SAME bundle in its own
// transparent BrowserWindow with an `?overlay=1` marker. In that window mount
// ONLY the lightweight CallOverlay (never the full App, which would re-run the
// whole app), and make the page transparent so only the circles paint.
if (new URLSearchParams(window.location.search).has('overlay')) {
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
