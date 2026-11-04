import type { RendererApi } from '@shared/ipc';
import type { SeilinkHostBridge } from '@shared/seilinkHost';

declare global {
  interface Window {
    sei: RendererApi;
    /** Only in the SeiLink room host page (src/preload/seilinkHost.ts). */
    seiRoomHost?: SeilinkHostBridge;
  }
}

export {};
