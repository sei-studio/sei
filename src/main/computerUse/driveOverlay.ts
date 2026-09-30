/**
 * 260925 backseat act: the "Sui is driving" pill with a Stop button.
 *
 * Built with the callOverlay recipe: a non-activating panel, always on top
 * across Spaces and fullscreen apps, content-protected so it never appears in
 * the screenshots the model sees, and acceptFirstMouse so the first click on
 * Stop lands even while another app is active. It is small and never covers
 * the target's middle (top edge of the display), and its rect is reported to
 * the scope check so the model can never click it.
 *
 * No preload: the page is a data: URL and its buttons navigate to
 * sei-act://stop, which main intercepts in will-navigate. There is no
 * Pause: any mouse or keyboard input from the player (Esc included) stops the
 * run outright, so taking the mouse back is always the way out.
 */
import { BrowserWindow, screen } from 'electron';
import type { Rect } from './types';

export interface DriveOverlay {
  setDetail(detail: string): void;
  rect(): Rect | null;
  nativeWindowId(): number | null;
  close(): void;
}

const W = 360;
const H = 48;

function html(name: string, hotkey: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:rgba(18,20,28,.92);--fg:#f2f4f8;--dim:#a8b0c4;--accent:#7FB0FF;--stop:#ff5d5d}
html,body{margin:0;height:100%;background:transparent;font:13px -apple-system,system-ui,sans-serif;color:var(--fg);overflow:hidden;user-select:none}
.pill{box-sizing:border-box;height:${H}px;display:flex;align-items:center;gap:10px;padding:0 8px 0 14px;background:var(--bg);border:1px solid rgba(127,176,255,.5);border-radius:${H / 2}px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--accent);animation:p 1.2s infinite}
@keyframes p{50%{opacity:.35}}
.txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{color:var(--dim);font-size:11px}
button{border:0;border-radius:16px;height:32px;padding:0 12px;font:inherit;font-weight:600;cursor:pointer}
#stop{background:var(--stop);color:#fff}
</style></head><body><div class="pill" id="pill"><div class="dot"></div>
<div class="txt"><div id="status">${esc(name)} is driving</div><div class="sub" id="sub">Touch the mouse or keyboard, or ${esc(hotkey)}, to stop.</div></div>
<button id="stop" onclick="location.href='sei-act://stop'">Stop</button></div></body></html>`;
}

export function createDriveOverlay(o: {
  characterName: string;
  hotkeyLabel: string;
  /** Global rect of the target; the pill sits at the top of its display. */
  near: Rect;
  onStop: () => void;
}): DriveOverlay {
  const center = { x: Math.round(o.near.x + o.near.w / 2), y: Math.round(o.near.y + o.near.h / 2) };
  const wa = screen.getDisplayNearestPoint(center).workArea;
  const bounds = { x: Math.round(wa.x + (wa.width - W) / 2), y: wa.y + 8, width: W, height: H };
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    title: 'Sei driving',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setContentProtection(true);
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (url.startsWith('sei-act://stop')) o.onStop();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(o.characterName, o.hotkeyLabel))}`);
  win.once('ready-to-show', () => win.showInactive());

  const alive = () => !win.isDestroyed();
  return {
    setDetail(detail) {
      if (!alive()) return;
      const d = JSON.stringify(detail);
      void win.webContents
        .executeJavaScript(`(()=>{const s=document.getElementById('sub');if(s)s.textContent=${d};})()`)
        .catch(() => {});
    },
    rect() {
      if (!alive()) return null;
      const b = win.getBounds();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    },
    nativeWindowId() {
      if (!alive()) return null;
      const m = /^window:(\d+):/.exec(win.getMediaSourceId());
      return m ? Number(m[1]) : null;
    },
    close() {
      if (alive()) win.destroy();
    },
  };
}
