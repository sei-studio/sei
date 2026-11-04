/**
 * SeiLink desktop host: signals from the rest of main (261104). A tiny,
 * dependency-free module so chatService and ipc.ts can tell the host
 * service what happened without importing it (and its process plumbing).
 *
 * - chat turns: the player is chatting with her (RoomAvatar `busy`);
 * - avatar changes: her imported model was imported, replaced, removed or
 *   had an accessory toggled (RoomAvatar re-resolves what she looks like).
 */
import type { AvatarManifest } from '../../../shared/ipc';

type TurnListener = (characterId: string, active: boolean) => void;
type AvatarListener = (characterId: string, manifest: AvatarManifest | null) => void;

const turnListeners = new Set<TurnListener>();
const avatarListeners = new Set<AvatarListener>();

function each<A extends unknown[]>(set: Set<(...a: A) => void>, ...args: A): void {
  for (const l of set) {
    try {
      l(...args);
    } catch {
      // A listener's failure is its own; the chat turn or import goes on.
    }
  }
}

/** A chat turn with her began. Call the returned function once when it ends (any outcome). */
export function noteSeilinkChatTurn(characterId: string): () => void {
  each(turnListeners, characterId, true);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    each(turnListeners, characterId, false);
  };
}

export function onSeilinkChatTurn(l: TurnListener): () => void {
  turnListeners.add(l);
  return () => turnListeners.delete(l);
}

export function noteSeilinkAvatarChanged(characterId: string, manifest: AvatarManifest | null): void {
  each(avatarListeners, characterId, manifest);
}

export function onSeilinkAvatarChanged(l: AvatarListener): () => void {
  avatarListeners.add(l);
  return () => avatarListeners.delete(l);
}

/**
 * Busy = a chat turn is running, or ended less than `holdMs` ago (she has
 * just answered; the player is reading or typing). onChange fires on edges.
 */
export class BusyTracker {
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private value = false;

  constructor(
    private readonly holdMs: number,
    private readonly onChange: (busy: boolean) => void,
  ) {}

  get busy(): boolean {
    return this.value;
  }

  begin(): void {
    this.active++;
    this.clear();
    this.set(true);
  }

  end(): void {
    if (this.active === 0) return;
    this.active--;
    if (this.active > 0) return;
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.set(false);
    }, this.holdMs);
  }

  dispose(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(v: boolean): void {
    if (v === this.value) return;
    this.value = v;
    this.onChange(v);
  }
}
