/**
 * Main-window guards for the startup popup frame (261027).
 *
 * The popup page (an operator page on https://sei.gg/popup/) is shown in a
 * sandboxed <iframe> inside the main renderer. Why an iframe and not a
 * WebContentsView or <webview>:
 *   - the iframe is cross-origin, so Chromium's site isolation runs it in its
 *     own renderer process, and Electron never injects the preload into
 *     subframes (nodeIntegrationInSubFrames is off), so the page has no
 *     window.sei and no Node;
 *   - the sandbox attribute (see StartupPopup.tsx) gives it an opaque origin
 *     with no scripts, no storage, no forms and no top navigation;
 *   - the overlay, backdrop click-out, X and Esc are plain renderer UI, so no
 *     second native view has to be positioned and resized over the window.
 * A <webview> would need webviewTag on the main window (a broader door), and
 * a WebContentsView floats above the DOM, so the X and backdrop would need
 * their own native view.
 *
 * What main adds here, for every SUBFRAME of the main window (the popup is
 * the app's only iframe):
 *   - navigation lock: a subframe may only navigate to an allowed popup URL.
 *     Any other link opens in the default browser through the same
 *     assertSafeExternalUrl gate as app:open-external (https/mailto only), and
 *     the frame stays where it is. A frame with no popup page committed (a
 *     nested <iframe> embed's first load) is cancelled without opening the
 *     browser. Redirects off the allow-list are cancelled;
 *   - actions (261029): a link to https://sei.gg/popup/_action/<name> is a
 *     button that does something in the app (src/shared/popupActions.ts).
 *     Followed from the committed popup frame, the navigation is cancelled
 *     (no request is made) and the name goes to the renderer over
 *     `app:startup-popup-action`; the renderer closes the popup and runs it,
 *     unless the popup is not shown yet or was revealed under
 *     POPUP_ACTION_ARM_MS ago (a meta refresh or Refresh header can reach an
 *     action URL with no click).
 *     An unknown name, or an action URL from any other frame, is dropped:
 *     nothing runs and no browser tab opens. Routing is the pure
 *     routeSubframeNavigation in startupPopup.ts;
 *   - window.open / target=_blank: denied for the whole main window (nothing
 *     in the app opens child windows), the URL goes to the default browser.
 *     An action link with target=_blank (the popup pages set
 *     <base target="_blank">) arrives here instead of will-frame-navigate,
 *     with no frame attached; it runs only while a popup page is committed in
 *     a subframe, since that page is the only content in the window that is
 *     not the app's own renderer (which never opens windows);
 *   - framing: sei.gg sends X-Frame-Options: SAMEORIGIN on every page, which
 *     would block the frame inside the app. The header (and a CSP
 *     frame-ancestors) is dropped for allowed popup URLs loaded as a subframe
 *     of the main window only;
 *   - load check: PopupFrameTracker records whether the frame committed a 2xx
 *     page, so the renderer never reveals an error page or a 404;
 *   - Esc: a key typed while focus is inside the frame is delivered to the
 *     frame, not to the renderer, so Esc is relayed from before-input-event.
 */
import { session, shell, type BrowserWindow } from 'electron';
import { IpcChannel } from '../shared/ipc';
import { assertSafeExternalUrl } from './lib/externalUrlValidator';
import { isPopupFrameUrl, popupDevOrigins } from './notices';
import {
  POPUP_ORIGIN,
  POPUP_PATH_PREFIX,
  PopupFrameTracker,
  popupActionFromUrl,
  routeSubframeNavigation,
} from './startupPopup';
import type { PopupAction } from '../shared/popupActions';

const logger = {
  info: (m: string) => console.log(`[sei] ${m}`),
};

const tracker = new PopupFrameTracker(isPopupFrameUrl);

/** Hand a URL to the default browser if it passes the shared gate; else drop it. */
function openExternally(url: string): void {
  try {
    assertSafeExternalUrl(url);
  } catch {
    logger.info(`popup: blocked non-https link ${url.slice(0, 80)}`);
    return;
  }
  logger.info(`popup: opening link externally ${url.slice(0, 200)}`);
  void shell.openExternal(url).catch(() => undefined);
}

/** Remove frame-ancestors from a CSP value, dropping the header if nothing is left. */
function stripFrameAncestors(value: string): string | null {
  const kept = value
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !/^frame-ancestors(\s|$)/i.test(d));
  return kept.length > 0 ? kept.join('; ') : null;
}

export function installPopupFrameGuards(win: BrowserWindow): void {
  const wc = win.webContents;

  const runAction = (action: PopupAction): void => {
    logger.info(`popup: action ${action}`);
    if (!wc.isDestroyed()) wc.send(IpcChannel.app.startupPopupAction, action);
  };

  wc.setWindowOpenHandler(({ url }) => {
    const action = popupActionFromUrl(url, popupDevOrigins());
    if (action === null) {
      openExternally(url);
    } else if (action !== 'unknown' && popupPageCommitted(wc)) {
      runAction(action);
    } else {
      logger.info(`popup: dropped action link ${url.slice(0, 80)}`);
    }
    return { action: 'deny' };
  });

  wc.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    // Only a frame that is showing a popup page is following a link. That is
    // a click, or a meta refresh / Refresh header (the page runs no scripts,
    // but those still navigate it with no click), which is why the renderer
    // ignores an action that lands right after the reveal. A frame with
    // nothing committed yet is a nested <iframe> starting its first load (an
    // embed on the page): it is cancelled without opening the browser, or
    // every load of that popup would pop a browser tab with no click.
    const route = routeSubframeNavigation(details.url, details.frame?.url ?? '', popupDevOrigins());
    if (route.kind === 'allow') return;
    details.preventDefault();
    if (route.kind === 'action') runAction(route.action);
    else if (route.kind === 'external') openExternally(details.url);
    else logger.info(`popup: blocked frame load ${details.url.slice(0, 80)}`);
  });

  wc.on('will-redirect', (details) => {
    if (details.isMainFrame) return;
    if (!isPopupFrameUrl(details.url)) details.preventDefault();
  });

  // Esc typed with focus inside the popup page goes to that frame's process
  // and never reaches the renderer's keydown listener, so relay it.
  wc.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    const frame = wc.focusedFrame;
    if (!frame || frame === wc.mainFrame || !isPopupFrameUrl(frame.url)) return;
    wc.send(IpcChannel.app.startupPopupEscape);
  });

  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame) tracker.onStart(details.url);
  });
  wc.on('did-frame-navigate', (_e, url, httpResponseCode, _text, isMainFrame) => {
    if (!isMainFrame) tracker.onCommit(url, httpResponseCode);
  });
  wc.on('did-fail-provisional-load', (_e, _code, _desc, url, isMainFrame) => {
    if (!isMainFrame) tracker.onFail(url);
  });

  const patterns = [POPUP_ORIGIN, ...popupDevOrigins()].map((o) => `${o}${POPUP_PATH_PREFIX}*`);
  session.defaultSession.webRequest.onHeadersReceived({ urls: patterns }, (details, callback) => {
    if (
      details.resourceType !== 'subFrame' ||
      details.webContentsId !== wc.id ||
      !isPopupFrameUrl(details.url) ||
      !details.responseHeaders
    ) {
      callback({});
      return;
    }
    const headers: Record<string, string[]> = {};
    for (const [key, values] of Object.entries(details.responseHeaders)) {
      const k = key.toLowerCase();
      if (k === 'x-frame-options') continue;
      if (k === 'content-security-policy') {
        const kept = values.map(stripFrameAncestors).filter((v): v is string => v !== null);
        if (kept.length > 0) headers[key] = kept;
        continue;
      }
      headers[key] = values;
    }
    callback({ responseHeaders: headers });
  });
}

/** Whether some subframe of the window has a popup page committed. */
function popupPageCommitted(wc: BrowserWindow['webContents']): boolean {
  try {
    return wc.mainFrame.framesInSubtree.some((f) => f !== wc.mainFrame && isPopupFrameUrl(f.url));
  } catch {
    return false;
  }
}

/**
 * Whether the popup frame's latest load committed a 2xx page. The frame's
 * commit normally lands well before the renderer's `load` event; a short wait
 * covers a still-pending navigation.
 */
export async function popupFrameLoadedOk(waitMs = 1500): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (!tracker.loadedOk() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return tracker.loadedOk();
}
