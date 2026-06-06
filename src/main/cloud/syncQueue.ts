/**
 * Phase 11 — Persistent retry queue for cloud-mirror operations.
 *
 * Source: 11-RESEARCH §Pattern 4 (queue shape + processing rules) +
 *         11-PATTERNS §syncQueue.ts (analog: sessionStore.ts without
 *         safeStorage encryption).
 *
 * Local-first, mirror-cloud-immediately (D-18):
 *   - characterStore.saveCharacter writes to disk synchronously, THEN
 *     enqueues a cloud-mirror upsert (fire-and-forget).
 *   - This module drains the queue when authState transitions to
 *     signed_in AND tos_accepted AND emailVerified, when network reconnect
 *     fires, and after every successful drain.
 *
 * NOT an offline-first sync engine. RxDB-style replication was considered
 * and rejected (CONTEXT §Claude's Discretion + RESEARCH §Alternatives Considered).
 *
 * Cross-plan contract notes:
 *   - Plan 11-07 (cloudCharacterClient) provides upsertCharacter / deleteCharacter /
 *     uploadSkin / uploadPortrait / deleteStorageObjects. Lazy-imported below
 *     to avoid module-init cycles AND to keep this file testable in isolation
 *     before Plan 11-07 lands in main.
 *   - Plan 11-14 (authState.isCloudWriteAllowed) gates the drainer. Lazy-imported
 *     for the same reason.
 *   - Plan 11-09 wires processNext() into auth-state transitions, net.online,
 *     and a setInterval sweep.
 */

import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
// allowJs:true in tsconfig.node.json lets TS resolve these .js modules.
import { atomicWrite } from '../../bot/brain/storage/atomicWrite.js';
import { withFileLock } from '../../bot/brain/storage/fileLock.js';
import { paths } from '../paths';

export type SyncOp =
  | {
      kind: 'upsert';
      uuid: string;
      queuedAt: string;
      attempts: number;
      nextAttemptAt: string;
      failedAt?: string;
      lastError?: string;
    }
  | {
      kind: 'delete';
      uuid: string;
      storagePaths: Array<{ bucket: 'skins' | 'portraits'; name: string }>;
      queuedAt: string;
      attempts: number;
      nextAttemptAt: string;
      failedAt?: string;
      lastError?: string;
    };

// Backoff schedule in milliseconds (RESEARCH §Pattern 4):
//   attempts=0 → 1s   (initial, basically immediate)
//   attempts=1 → 5s
//   attempts=2 → 30s
//   attempts=3 → 5min
//   attempts=4 → 30min
// At attempts=5, the op transitions to attempts=6 inside the failure handler
// which clamps to MAX_ATTEMPTS and marks failedAt — no further scheduling.
const BACKOFF_MS = [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000];
const MAX_ATTEMPTS = 6;
// Gate-blocked reschedule. NOT a "failed attempt"; the op stays at the same
// attempts counter and just shifts forward by 30s so we don't busy-loop while
// the user is signed out / TOS unaccepted.
const GATE_BLOCKED_BACKOFF_MS = 30_000;

async function readQueue(): Promise<SyncOp[]> {
  let raw: string;
  try {
    raw = await readFile(paths.syncQueuePath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[sei] sync-queue.json not an array — resetting');
      return [];
    }
    return parsed as SyncOp[];
  } catch {
    // T-11-08-01: corrupt blob MUST NOT crash the app.
    console.warn('[sei] sync-queue.json corrupt — resetting');
    return [];
  }
}

async function writeQueue(q: SyncOp[]): Promise<void> {
  const target = paths.syncQueuePath();
  await mkdir(path.dirname(target), { recursive: true });
  await withFileLock(target, async () => {
    await atomicWrite(target, JSON.stringify(q, null, 2) + '\n');
  });
}

function nextBackoffIso(attempts: number): string {
  // attempts is the NEW count (post-increment). Clamp into BACKOFF_MS.
  const idx = Math.min(Math.max(attempts, 0), BACKOFF_MS.length - 1);
  const delay = BACKOFF_MS[idx];
  return new Date(Date.now() + delay).toISOString();
}

/**
 * Ownership guard. The cloud `characters` table is protected by a Supabase RLS
 * policy that only permits rows where `owner = auth.uid()`. A character the
 * signed-in user does NOT own (e.g. a World-tab character added to the library,
 * whose `owner` is another account) can therefore NEVER be upserted under this
 * account — every attempt 403s with "violates row-level security policy",
 * leaving the op stuck in the queue and the card pinned to "SYNCING" forever.
 *
 * Returns true when `uuid` must not be cloud-mirrored under the current account.
 * Own chars (owner === current uid) and legacy null-owner chars (the cloud
 * stamps owner on first upsert) are allowed.
 */
async function isForeignOwned(uuid: string): Promise<boolean> {
  const { getCharacter } = await import('../characterStore');
  const char = await getCharacter(uuid).catch(() => null);
  // No owner stamp (own char being created, or a legacy null-owner local char)
  // → the cloud stamps owner on first upsert, so it's mirrorable. Bail before
  // touching authState.
  if (!char || char.owner == null) return false;
  const { getCurrentAuthState } = await import('../auth/authState');
  const st = getCurrentAuthState();
  const uid = st.kind === 'signed_in' ? st.user.id : null;
  return char.owner !== uid;
}

export async function enqueueUpsert(uuid: string): Promise<void> {
  if (await isForeignOwned(uuid)) {
    // Never queue a doomed upsert. Also purge any previously-queued (stuck)
    // upsert for this uuid so an op enqueued before this guard existed
    // self-clears and the "SYNCING" pill disappears.
    const existing = await readQueue();
    const purged = existing.filter(op => !(op.kind === 'upsert' && op.uuid === uuid));
    if (purged.length !== existing.length) {
      await writeQueue(purged);
      notifyStatusChange();
    }
    return;
  }
  const q = await readQueue();
  // Collapse — replace existing upsert for the same uuid, leave deletes alone.
  // Two fast successive edits to the same character collapse to ONE upload;
  // the drainer re-reads the local file at drain time so the latest content
  // is what lands in cloud.
  const filtered = q.filter(op => !(op.kind === 'upsert' && op.uuid === uuid));
  filtered.push({
    kind: 'upsert',
    uuid,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
  });
  await writeQueue(filtered);
  notifyStatusChange();
}

export async function enqueueDelete(
  uuid: string,
  storagePaths: Array<{ bucket: 'skins' | 'portraits'; name: string }>,
): Promise<void> {
  const q = await readQueue();
  // For deletes, replace ANY pending op (upsert or delete) for same uuid.
  // The delete supersedes a queued upsert — uploading then deleting would
  // waste bandwidth and racing the two could leave a tombstone-less row.
  const filtered = q.filter(op => op.uuid !== uuid);
  filtered.push({
    kind: 'delete',
    uuid,
    storagePaths,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
  });
  await writeQueue(filtered);
  notifyStatusChange();
}

export async function processNext(): Promise<void> {
  const q = await readQueue();
  const now = Date.now();
  const idx = q.findIndex(op => !op.failedAt && new Date(op.nextAttemptAt).getTime() <= now);
  if (idx < 0) return;

  const op = q[idx];

  // T-11-08-02: never replay cloud writes when the user is signed-out,
  // unverified, or has not accepted ToS. Lazy-import so this module can be
  // imported before Plan 11-14 has landed isCloudWriteAllowed in authState.ts.
  const { isCloudWriteAllowed } = await import('../auth/authState');
  if (!(await isCloudWriteAllowed())) {
    // Reschedule without counting as a failed attempt — gate-blocked is
    // expected steady-state for users who run Sei without ever signing in.
    op.nextAttemptAt = new Date(now + GATE_BLOCKED_BACKOFF_MS).toISOString();
    q[idx] = op;
    await writeQueue(q);
    return;
  }

  // Lazy-import the cloud client + getClient so test code's vi.mock() calls
  // get a chance to register. Also keeps module-init free of network deps.
  const { upsertCharacter, deleteCharacter, uploadSkin, uploadPortrait, deleteStorageObjects } =
    await import('./cloudCharacterClient');
  const { getClient } = await import('../auth/supabaseClient');
  const { getCharacter } = await import('../characterStore');

  const supabase = getClient();
  const sessionResp = await supabase.auth.getSession();
  const session = sessionResp?.data?.session;
  if (!session?.user?.id || !session.access_token) {
    // Shouldn't happen because isCloudWriteAllowed already gates this, but be
    // defensive: a race between the gate check and getSession could leave the
    // op unrunnable. Treat as a gate miss, not a failure.
    op.nextAttemptAt = new Date(now + GATE_BLOCKED_BACKOFF_MS).toISOString();
    q[idx] = op;
    await writeQueue(q);
    return;
  }
  const ownerUuid = session.user.id as string;
  // Skin/portrait bytes upload via the sign-character-asset-upload Edge Function
  // (asymmetric-JWT bridge); the row upsert + delete below go direct over
  // PostgREST, which verifies ES256.
  const jwt = session.access_token;

  try {
    if (op.kind === 'upsert') {
      // Re-read local file at drain time — this is what makes the queue
      // collapse-friendly: any number of saves between enqueue and drain
      // collapse to a single upload of the latest bytes.
      const char = await getCharacter(op.uuid);
      if (!char) {
        // Local char vanished (deleted between enqueue and drain). Drop the
        // queue entry — the delete op will land separately if the user
        // actually wanted a cloud-delete.
        q.splice(idx, 1);
      } else if (char.owner != null && char.owner !== ownerUuid) {
        // Foreign-owned (added from the World tab; owner is another account).
        // The cloud RLS policy (owner = auth.uid()) would 403 this upsert on
        // every attempt, so it must never be retried — drop it so the card
        // stops showing "SYNCING". Self-heals ops queued before enqueueUpsert
        // grew its ownership guard.
        q.splice(idx, 1);
      } else {
        // Upsert row first (cheap, single roundtrip).
        await upsertCharacter(char, ownerUuid);

        // Skin upload: best-effort. A skin upload failure does NOT block the
        // row upsert success — the row is already in cloud, just without an
        // up-to-date skin. The user will see "synced" in the pill; if they
        // re-save, a fresh upsert re-attempts the skin upload.
        try {
          const { resolveSkinPng } = await import('../skinStore');
          // resolveSkinPng signature: (character: Character) => Promise<Buffer | null>
          const skinBytes = await resolveSkinPng(char).catch(() => null);
          if (skinBytes) await uploadSkin(op.uuid, skinBytes, jwt);
        } catch (err) {
          console.warn(
            `[sei] sync-queue: skin upload for ${op.uuid} failed: ${(err as Error).message}`,
          );
        }

        // Portrait upload: best-effort, same justification as skin. Plan
        // 11-06's PortraitImagePicker writes PNG to <userData>/portraits/<uuid>.png;
        // older installs (pre-11-06) won't have the file and we silently skip.
        try {
          const portraitBytes = await readFile(paths.portraitPath(op.uuid)).catch(() => null);
          if (portraitBytes) {
            // Format detection: the on-disk file is always PNG (PortraitImagePicker
            // canvas-re-encodes any source format to PNG before writing).
            await uploadPortrait(op.uuid, portraitBytes, 'png', jwt);
          }
        } catch (err) {
          console.warn(
            `[sei] sync-queue: portrait upload for ${op.uuid} failed: ${(err as Error).message}`,
          );
        }

        q.splice(idx, 1);
      }
    } else {
      // delete branch
      await deleteCharacter(op.uuid);
      // T-11-08-03: ownership of these object paths is enforced by Storage
      // RLS (Plan 11-01) — wrong-owner deletes 403 server-side.
      await deleteStorageObjects(op.storagePaths);
      q.splice(idx, 1);
    }
    await writeQueue(q);
    notifyStatusChange();
    // Drain another op immediately if any are due. Use setImmediate (not
    // recursion) so the event loop can interleave other work — this matters
    // when there's a long backlog after a reconnect.
    setImmediate(() => {
      void processNext();
    });
  } catch (err) {
    // T-11-08-04: bounded retries. After MAX_ATTEMPTS the op is left in the
    // queue with failedAt set so getStatus() can surface it; the renderer
    // shows "sync failed — retry" and the user has to opt-in to retry().
    op.attempts += 1;
    op.lastError = (err as Error).message;
    if (op.attempts >= MAX_ATTEMPTS) {
      op.failedAt = new Date().toISOString();
    } else {
      op.nextAttemptAt = nextBackoffIso(op.attempts);
    }
    q[idx] = op;
    await writeQueue(q);
    notifyStatusChange();
  }
}

export async function getStatus(): Promise<{
  pending: number;
  failed: SyncOp[];
  pendingByUuid: Record<string, 'syncing' | 'failed'>;
}> {
  const q = await readQueue();
  const failed = q.filter(op => op.failedAt);
  const pending = q.filter(op => !op.failedAt);
  const pendingByUuid: Record<string, 'syncing' | 'failed'> = {};
  for (const op of pending) pendingByUuid[op.uuid] = 'syncing';
  // 'failed' wins over 'syncing' if both somehow exist for the same uuid;
  // assign after the pending loop so the value is overwritten.
  for (const op of failed) pendingByUuid[op.uuid] = 'failed';
  return { pending: pending.length, failed, pendingByUuid };
}

/**
 * Drop ALL pending ops for a uuid (both upserts and deletes). Used by the
 * sign-in owner-reconciliation sweep when it deletes a foreign-owned local
 * leak — leaving the upsert in the queue would keep the renderer's sync pill
 * stuck on SYNCING for a character that no longer exists locally.
 */
export async function dropOpsForUuid(uuid: string): Promise<void> {
  const q = await readQueue();
  const next = q.filter((op) => op.uuid !== uuid);
  if (next.length === q.length) return;
  await writeQueue(next);
  notifyStatusChange();
}

export async function retry(uuid: string): Promise<void> {
  const q = await readQueue();
  const idx = q.findIndex(op => op.uuid === uuid);
  if (idx < 0) return;
  // Reset retry state and force-immediate scheduling. The user clicked "retry"
  // so we want to attempt right now, not wait out the 30min backoff.
  q[idx].attempts = 0;
  q[idx].nextAttemptAt = new Date().toISOString();
  delete q[idx].failedAt;
  delete q[idx].lastError;
  await writeQueue(q);
  notifyStatusChange();
  await processNext();
}

// ── Status-change subscriber registry ──────────────────────────────────────
// Plan 11-09 wires an IPC emitter onto this — every queue-state change pushes
// sync:status to the renderer so the per-card pill updates without polling.
type StatusListener = () => void;
const listeners = new Set<StatusListener>();

export function subscribeStatusChange(fn: StatusListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyStatusChange(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // Listeners are best-effort; one bad listener must not block others.
    }
  }
}

// Drainer wake-up hookup is owned by Plan 11-09 / main/index.ts bootstrap:
//   authState.subscribe(state => state.kind === 'signed_in' && void processNext())
//   net.online listener → void processNext()
//   setInterval(processNext, 10_000) belt-and-suspenders sweep
