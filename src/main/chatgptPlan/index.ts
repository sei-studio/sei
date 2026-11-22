/**
 * 261017 (issue #46): the app's ChatGPT-plan session singleton, wired to
 * Electron (safeStorage vault, system browser, loopback listener) and to the
 * renderer status push. Everything outside src/main/chatgptPlan imports from
 * here, never session.ts directly.
 */
import { BrowserWindow, shell } from 'electron';
import { startCallbackListener } from './loopback';
import { createChatgptSession, type ChatgptSession } from './session';
import { electronVault, getChatgptHostId } from './store';
import type { ChatgptStatus } from '../../shared/chatgptPlan';

export type { AccessToken, ChatgptSession } from './session';

/** Renderer push channel for status changes. */
export const CHATGPT_STATUS_CHANNEL = 'chatgpt:status-changed';

let session: ChatgptSession | null = null;

export function chatgptSession(): ChatgptSession {
  if (!session) {
    session = createChatgptSession({
      vault: electronVault,
      hostId: getChatgptHostId,
      fetchImpl: (...args) => globalThis.fetch(...args),
      openExternal: (url) => shell.openExternal(url),
      startListener: (state) => startCallbackListener(state),
      log: (line) => console.log(line),
    });
    session.onStatus((s: ChatgptStatus) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(CHATGPT_STATUS_CHANNEL, s);
      }
    });
  }
  return session;
}

/** Test seam: replace the singleton (null restores lazy creation). */
export function _setChatgptSessionForTests(s: ChatgptSession | null): void {
  session = s;
}




