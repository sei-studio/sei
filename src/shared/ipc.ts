/**
 * IPC contract between main, preload, and renderer.
 *
 * Single source of truth: every ipcMain.handle (in src/main/ipc.ts) and every
 * ipcRenderer.invoke (in src/preload/index.ts) imports channel names from
 * `IpcChannel` below. Method signatures imported as `RendererApi`.
 *
 * Sources:
 *   - CONTEXT D-17 (RendererApi shape)
 *   - CONTEXT D-19 (BotLifecycle vocabulary)
 *   - CONTEXT D-22 (LanState variants)
 *   - PATTERNS §src/shared/ipc.ts
 *   - RESEARCH §Pattern 2 (contextBridge contract)
 *   - UI-SPEC §Defaults (channel naming)
 */

import type { Character, UserConfig } from './characterSchema';
import type { ErrorClass } from './errorClasses';
export type { ErrorClass } from './errorClasses';

/* -------------------------------------------------------------------------- */
/*  Lifecycle / status / log domain types                                     */
/* -------------------------------------------------------------------------- */

export type Unsubscribe = () => void;

/** Renderer-facing bot status surface (used by CharacterPage model row). */
export type BotStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'online'; uptimeMs: number; characterId: string }
  | { kind: 'error'; error: ErrorClass; message: string; characterId: string };

/** Renderer-facing LAN watcher status (used by HomeScreen pill + LAN modal). */
export type LanState =
  | { kind: 'connected'; port: number; motd: string; lastSeenAt: number }
  | { kind: 'not_connected' }
  | { kind: 'unavailable' };

/**
 * Startup warnings reported by main on first boot (one-shot query).
 * `keychainFallbackPlaintext` is true when running on Linux with the
 * `basic_text` safeStorage backend (no kwallet/libsecret available) —
 * surfaces as a top-of-window Banner per RESEARCH §Pitfall 3.
 */
export interface StartupWarnings {
  keychainFallbackPlaintext: boolean;
}

/** Single log line forwarded from utilityProcess stdout/stderr → main → renderer. */
export interface LogEntry {
  timestamp: string;             // ISO; main attaches this when it tees the line
  tag: string | null;            // e.g. "[chat<-]", "[haiku!]"; null when no prefix matches
  message: string;               // raw line text including any prefix
  level: 'info' | 'warn' | 'error';
}

/** Batched log delivery (Pitfall 7 — main coalesces ~50ms / 100 lines per batch). */
export interface LogBatch {
  entries: LogEntry[];
  dropped?: number;              // sentinel when backpressure clipped lines
}

/**
 * Internal main↔utilityProcess MessagePort message vocabulary.
 * Renderer never sees these directly — main translates to BotStatus.
 */
export type BotLifecycle =
  | { type: 'init-ack' }
  | { type: 'connected' }
  | { type: 'disconnected'; reason?: string }
  | { type: 'error'; error: ErrorClass; message: string }
  | { type: 'chat'; from: string; text: string }
  | { type: 'summon-ready' }
  | { type: 'summon-stopped' }
  | { type: 'exit'; code: number | null };

/* -------------------------------------------------------------------------- */
/*  Preload-exposed RendererApi                                                */
/* -------------------------------------------------------------------------- */

/**
 * The shape of `window.sei` in renderer code.
 * Preload (src/preload/index.ts) uses `contextBridge.exposeInMainWorld('sei', api)`
 * with `api: RendererApi`. Main registers ipcMain.handle for every request/response method.
 */
export interface RendererApi {
  // Bot supervision (request/response with timeouts — main enforces)
  summon(characterId: string): Promise<void>;
  stop(): Promise<void>;

  // Character CRUD
  listCharacters(): Promise<Character[]>;
  getCharacter(id: string): Promise<Character | null>;
  saveCharacter(character: Character): Promise<void>;
  deleteCharacter(id: string): Promise<void>;
  resetMemory(id: string): Promise<void>;

  // User config + secret
  getConfig(): Promise<UserConfig>;
  saveConfig(config: UserConfig): Promise<void>;
  saveApiKey(plaintext: string): Promise<void>;
  hasApiKey(): Promise<boolean>;

  // App-level one-shot queries
  getStartupWarnings(): Promise<StartupWarnings>;

  // Push subscriptions — return Unsubscribe (renderer cleans up on unmount)
  onStatus(cb: (status: BotStatus) => void): Unsubscribe;
  onLog(cb: (batch: LogBatch) => void): Unsubscribe;
  onLan(cb: (state: LanState) => void): Unsubscribe;
}

/* -------------------------------------------------------------------------- */
/*  IPC channel string constants — single source of truth for both sides       */
/* -------------------------------------------------------------------------- */

export const IpcChannel = {
  bot: {
    summon: 'bot:summon',
    stop: 'bot:stop',
    status: 'bot:status',
    logBatch: 'bot:log:batch',
  },
  lan: {
    state: 'lan:state',
  },
  chars: {
    list: 'chars:list',
    get: 'chars:get',
    save: 'chars:save',
    delete: 'chars:delete',
    resetMemory: 'chars:reset-memory',
  },
  config: {
    get: 'config:get',
    save: 'config:save',
    saveApiKey: 'config:save-api-key',
    hasApiKey: 'config:has-api-key',
  },
  app: {
    ready: 'app:ready',
    warnings: 'app:warnings',
  },
} as const;

export type IpcChannelName =
  | typeof IpcChannel.bot[keyof typeof IpcChannel.bot]
  | typeof IpcChannel.lan[keyof typeof IpcChannel.lan]
  | typeof IpcChannel.chars[keyof typeof IpcChannel.chars]
  | typeof IpcChannel.config[keyof typeof IpcChannel.config]
  | typeof IpcChannel.app[keyof typeof IpcChannel.app];
