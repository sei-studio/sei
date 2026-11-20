/**
 * Entry of the SeiLink room host page (seilink-host.html, 261104). Mounts
 * only SeilinkHostView: this bundle is drawn as the desktop wallpaper by the
 * room host process, so it stays small and never loads the app.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { SeilinkHostView } from './components/seilink/host/SeilinkHostView';

ReactDOM.createRoot(document.getElementById('root')!).render(<SeilinkHostView />);
