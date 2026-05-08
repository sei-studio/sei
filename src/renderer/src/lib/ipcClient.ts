/**
 * Typed wrapper around `window.sei`.
 *
 * Renderer code MUST import from this module rather than touching `window.sei`
 * directly — keeps a single substitution point for testability and gives one
 * place where the RendererApi shape is bound to the actual contextBridge handle.
 *
 * Source: 04-CONTEXT.md D-15/D-17 (preload contract), 04-PATTERNS.md §ipcClient.
 */

import type { RendererApi } from '@shared/ipc';

export const sei: RendererApi = window.sei;
