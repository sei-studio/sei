import type { RendererApi } from '@shared/ipc';

declare global {
  interface Window { sei: RendererApi; }
}

export {};
