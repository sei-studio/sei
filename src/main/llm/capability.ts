/**
 * llm:capability push (china-compat W1) â€” the config-derived vision verdict of
 * the ACTIVE chat backend, mirrored to the renderer the way vision:capability
 * is for bot sessions. Pushed on config saves that touch provider/model/
 * backend and on ai_backend_kind changes; seeded by the llm:capability-get
 * pull so a fresh renderer never races the push.
 */
import { BrowserWindow } from 'electron';
import { IpcChannel, type LlmCapability } from '../../shared/ipc';
import { activeLlmModelLabel, activeLlmVision } from './index';
import { getAiBackendKind } from '../apiKeyStore';
import { loadConfig } from '../configStore';

/** The active local provider kind, or null on the cloud backend. Never throws. */
async function activeLocalProvider(): Promise<string | null> {
  try {
    if ((await getAiBackendKind()) === 'cloud-proxy') return null;
    return (await loadConfig()).provider ?? 'anthropic';
  } catch {
    return null;
  }
}

export async function currentLlmCapability(): Promise<LlmCapability> {
  return {
    vision: await activeLlmVision(),
    model: await activeLlmModelLabel(),
    provider: await activeLocalProvider(),
  };
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




