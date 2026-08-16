/**
 * llm:capability push (china-compat W1) — the config-derived vision verdict of
 * the ACTIVE chat backend, mirrored to the renderer the way vision:capability
 * is for bot sessions. Pushed on config saves that touch provider/model/
 * backend and on ai_backend_kind changes; seeded by the llm:capability-get
 * pull so a fresh renderer never races the push.
 */
import { BrowserWindow } from 'electron';
import { IpcChannel, type LlmCapability } from '../../shared/ipc';
import { activeLlmVision } from './index';

export async function currentLlmCapability(): Promise<LlmCapability> {
  return { vision: await activeLlmVision() };
}

/** Best-effort broadcast to every window. Never throws, never load-bearing. */
export async function pushLlmCapability(): Promise<void> {
  try {
    const cap = await currentLlmCapability();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IpcChannel.llm.capability, cap);
    }
  } catch {
    /* next config change retries */
  }
}
