/**
 * Launch speed (261123): main creates the window before it has registered
 * its IPC handlers, so the renderer bundle loads while main is still running
 * its startup steps (scope, migrations, services). A call made in that window
 * would fail with "No handler registered" (or read data before a migration),
 * so every invoke and send waits until main says its handlers are in place
 * (`app:ipc-ready`, answered once registerIpcHandlers has run).
 *
 * Push listeners (`on` / `off`) are never delayed: a push main sends is
 * delivered to whoever listens at that moment, as before.
 *
 * Order is kept: calls made before the gate opens run in the order they were
 * made, invokes and sends together. If main has no gate handler (an older
 * main, or a window main never gated), the probe rejects at once and calls go
 * straight through.
 */
import type { IpcRenderer } from 'electron';

export type GatedIpc = Pick<IpcRenderer, 'invoke' | 'send' | 'on' | 'off'>;

export function createGatedIpc(raw: GatedIpc, readyChannel: string): GatedIpc {
  let open = false;
  // A probe that throws or returns no promise opens the gate too.
  const ready: Promise<void> = new Promise<unknown>((resolve) => resolve(raw.invoke(readyChannel)))
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      open = true;
    });
  return {
    invoke: (channel: string, ...args: unknown[]) =>
      open ? raw.invoke(channel, ...args) : ready.then(() => raw.invoke(channel, ...args)),
    send: (channel: string, ...args: unknown[]) => {
      if (open) raw.send(channel, ...args);
      else void ready.then(() => raw.send(channel, ...args));
    },
    on: raw.on.bind(raw),
    off: raw.off.bind(raw),
  } as GatedIpc;
}
