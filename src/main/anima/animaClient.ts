/**
 * Anima client (261105): her face set, baked in the cloud the first time
 * SeiLink opens for her, then kept on disk.
 *
 * Product feedback (msg 1607): the bake starts only when the user opens SeiLink (the
 * move-in sheet, the room editor, or her desktop room starting), never at
 * app start, so people who never use SeiLink cost nothing. It runs in the
 * background while the user sets up the room.
 *
 * prepare(characterId, trigger):
 *   1. Her pack is on disk and her portrait has not changed since the last
 *      check (and that check is under CHECK_TTL_MS old): ready, no network.
 *   2. Offline, or signed out (no Sei session): nothing. The fallback avatar
 *      (portrait cutout, silhouette) stays. BYOK/local-model users with a Sei
 *      account still get a bake: it goes through sei-proxy on their Sei auth.
 *   3. POST /anima/v1/request. queued/running: poll GET /anima/v1/status
 *      (10 s, then 20 s, then 45 s, for at most POLL_MAX_MS). ready: download
 *      the signed pack.zip, check its sha256, extract (animaPacks.ts), then
 *      tell every view to re-resolve her avatar (onReady), which crossfades
 *      to the face set with no restart.
 *   no_pack / failed / deferred / unavailable / 4xx: nothing shown, fallback
 *   kept; the next SeiLink open asks again (the proxy keeps no_pack final for
 *   that portrait, so asking again is cheap).
 *
 * Analytics: `seilink_anima` with `phase` (shape only, never the portrait or
 * a URL), see docs/agents/seilink-analytics.md.
 */
import type { AnimaShownKind, AnimaStatus, AnimaTrigger, AnimaUiState } from '../../shared/anima';
import { animaPackId } from '../../shared/anima';
import { AnimaPackError, type AnimaIndexEntry, type AnimaPackStore } from './animaPacks';

export const CHECK_TTL_MS = 12 * 60 * 60 * 1000;
export const POLL_MAX_MS = 25 * 60 * 1000;
export const DOWNLOAD_MAX_BYTES = 60 * 1024 * 1024;
/** How long an old pack stays after a new one replaced it (a view may still be reading it). */
export const PRUNE_DELAY_MS = 120_000;
/** After a portrait edit the cloud row may lag the local save: look again at these delays. */
export const PORTRAIT_RECHECK_MS = [20_000, 90_000, 240_000] as const;

export type ProxyState = 'none' | 'queued' | 'running' | 'ready' | 'no_pack' | 'failed' | 'deferred' | 'unavailable';

export interface ProxyReply {
  state: ProxyState;
  reason?: string;
  portrait_hash?: string;
  pack?: { url: string; sha256: string; bytes: number | null; expires_in: number };
  created?: boolean;
}

export class AnimaNoSession extends Error {
  constructor() {
    super('no session');
    this.name = 'AnimaNoSession';
  }
}

export interface AnimaClientDeps {
  /** Call sei-proxy with the user's Sei JWT. Throws AnimaNoSession when signed out. */
  api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  online(): boolean;
  /** GET a signed URL, at most maxBytes. */
  download(url: string, maxBytes: number): Promise<Uint8Array>;
  store: AnimaPackStore;
  /** Her local portrait ref (portrait_image + cloud watermark); undefined = no such character. */
  portraitRef(characterId: string): Promise<string | null | undefined>;
  capture(event: string, props: Record<string, unknown>): void;
  /** Her pack is installed (or changed): views re-resolve her avatar. */
  onReady(characterId: string, packId: string): void;
  onStatus(status: AnimaStatus): void;
  now(): number;
  setTimeout(fn: () => Promise<void> | void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  log?(line: string): void;
}

interface Run {
  /** Bumped by reset(): a run from before an account switch stops. */
  gen: number;
  trigger: AnimaTrigger;
  startedAt: number;
  ui: AnimaUiState;
  timer: unknown;
  polls: number;
  /** A bake was waited on (not ready at the first answer). */
  waited: boolean;
  busy: boolean;
  /** portrait_changed: the hash the old pack was baked from, to spot a cloud row that has not caught up. */
  oldPortraitHash: string | null;
  recheck: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pollDelay(n: number): number {
  if (n < 6) return 10_000;
  if (n < 15) return 20_000;
  return 45_000;
}

function asReply(v: unknown): ProxyReply | null {
  const r = v as ProxyReply | null;
  return r && typeof r === 'object' && typeof r.state === 'string' ? r : null;
}

export class AnimaClient {
  private gen = 0;
  private readonly runs = new Map<string, Run>();
  private readonly ui = new Map<string, AnimaUiState>();
  /** Once per app run: (phase|character|...) keys already sent. */
  private readonly sent = new Set<string>();
  private pruned: Promise<number> | null = null;

  constructor(private readonly d: AnimaClientDeps) {}

  status(characterId: string): AnimaStatus {
    return { characterId, state: this.ui.get(characterId) ?? 'idle' };
  }

  /** Her pack id when it is on disk (RoomAvatar's facepackForCharacter). */
  packIdFor(characterId: string): Promise<string | null> {
    return this.d.store.packIdFor(characterId);
  }

  /** SeiLink opened for her. Never throws; resolves once the first answer is handled. */
  async prepare(characterId: string, trigger: AnimaTrigger): Promise<AnimaStatus> {
    if (!UUID_RE.test(characterId)) return this.status(characterId);
    const live = this.runs.get(characterId);
    if (live) return this.status(characterId);
    try {
      // Once per run, before any install (every prepare waits on the same pass).
      this.pruned ??= this.d.store.prune(true).catch(() => 0);
      await this.pruned;
      const ref = await this.d.portraitRef(characterId);
      if (ref === undefined) return this.status(characterId);
      const entry = await this.d.store.entry(characterId);
      const packId = entry ? await this.d.store.packIdFor(characterId) : null;
      const fresh = entry && packId && entry.portrait_ref === ref && this.d.now() - entry.checked_at < CHECK_TTL_MS;
      if (fresh && trigger !== 'portrait_changed') {
        this.setUi(characterId, 'ready');
        this.once(`ready|${characterId}`, { phase: 'ready', trigger, from_cache: true, source: 'disk', wait_ms: 0 });
        return this.status(characterId);
      }
      if (!this.d.online()) {
        this.once(`skipped|offline|${characterId}`, { phase: 'skipped', reason: 'offline', trigger });
        if (packId) this.setUi(characterId, 'ready');
        return this.status(characterId);
      }
      const run: Run = {
        gen: this.gen,
        trigger,
        startedAt: this.d.now(),
        ui: packId ? 'ready' : 'idle',
        timer: null,
        polls: 0,
        waited: false,
        busy: false,
        oldPortraitHash: trigger === 'portrait_changed' ? (entry?.portrait_hash ?? null) : null,
        recheck: 0,
      };
      this.runs.set(characterId, run);
      await this.ask(characterId, run, 'request', ref);
    } catch (err) {
      this.d.log?.(`[anima] prepare failed (${(err as Error).message})`);
      this.runs.delete(characterId);
    }
    return this.status(characterId);
  }

  /**
   * Her character was saved. When her portrait ref differs from the one her
   * pack was checked against, ask again (a few times: the cloud row may lag
   * the local save). Only for characters that already went through SeiLink.
   */
  async portraitMaybeChanged(characterId: string): Promise<void> {
    const entry = await this.d.store.entry(characterId).catch(() => null);
    if (!entry && !this.ui.has(characterId)) return;
    const ref = await this.d.portraitRef(characterId).catch(() => undefined);
    if (ref === undefined || (entry && entry.portrait_ref === ref)) return;
    this.stop(characterId);
    const gen = this.gen;
    this.d.setTimeout(async () => {
      if (gen === this.gen) await this.prepare(characterId, 'portrait_changed');
    }, PORTRAIT_RECHECK_MS[0]);
  }

  /** What a view ended up showing for her (once per character, surface and kind per run). */
  noteShown(characterId: string, kind: AnimaShownKind, surface: 'desktop' | 'editor'): void {
    if (!UUID_RE.test(characterId)) return;
    this.once(`shown|${characterId}|${surface}|${kind}`, {
      phase: 'shown',
      avatar_kind: kind,
      surface,
      anima_state: this.ui.get(characterId) ?? 'idle',
    });
  }

  /** Account switch or quit: stop every poll; nothing from before carries on. */
  reset(): void {
    this.gen++;
    for (const id of [...this.runs.keys()]) this.stop(id);
    this.ui.clear();
  }

  private stop(characterId: string): void {
    const run = this.runs.get(characterId);
    if (!run) return;
    if (run.timer) this.d.clearTimeout(run.timer);
    run.timer = null;
    this.runs.delete(characterId);
  }

  private setUi(characterId: string, state: AnimaUiState): void {
    if ((this.ui.get(characterId) ?? 'idle') === state) return;
    this.ui.set(characterId, state);
    try {
      this.d.onStatus({ characterId, state });
    } catch {
      /* a closed window */
    }
  }

  private once(key: string, props: Record<string, unknown>): void {
    if (this.sent.has(key)) return;
    this.sent.add(key);
    this.capture(props);
  }

  private capture(props: Record<string, unknown>): void {
    try {
      this.d.capture('seilink_anima', props);
    } catch {
      /* analytics is optional */
    }
  }

  private schedule(characterId: string, run: Run, ms: number, ref: string | null): void {
    // The callback returns the poll's promise (tests await it; timers ignore it).
    run.timer = this.d.setTimeout(() => {
      run.timer = null;
      if (this.runs.get(characterId) !== run || run.gen !== this.gen) return undefined;
      return this.ask(characterId, run, 'status', ref);
    }, ms);
  }

  private finish(characterId: string, run: Run): void {
    if (this.runs.get(characterId) === run) this.runs.delete(characterId);
  }

  private async ask(characterId: string, run: Run, kind: 'request' | 'status', ref: string | null): Promise<void> {
    if (run.busy) return;
    run.busy = true;
    let res: { status: number; body: unknown };
    try {
      res =
        kind === 'request'
          ? await this.d.api('POST', '/anima/v1/request', { character_id: characterId })
          : await this.d.api('GET', `/anima/v1/status/${encodeURIComponent(characterId)}`);
    } catch (err) {
      run.busy = false;
      if (err instanceof AnimaNoSession) {
        this.once(`skipped|signed_out|${characterId}`, { phase: 'skipped', reason: 'signed_out', trigger: run.trigger });
        this.finish(characterId, run);
        return;
      }
      // Network: keep polling a bake we know about; give up on a first request.
      if (kind === 'status' && this.d.now() - run.startedAt < POLL_MAX_MS) {
        this.schedule(characterId, run, pollDelay(run.polls++), ref);
        return;
      }
      this.once(`failed|network|${characterId}`, { phase: 'failed', reason: 'network', trigger: run.trigger });
      this.settleUi(characterId, run);
      this.finish(characterId, run);
      return;
    }
    run.busy = false;
    if (run.gen !== this.gen || this.runs.get(characterId) !== run) return;

    if (res.status === 429 && this.d.now() - run.startedAt < POLL_MAX_MS) {
      this.schedule(characterId, run, 60_000, ref);
      return;
    }
    const reply = res.status === 200 ? asReply(res.body) : null;
    if (!reply) {
      const reason = res.status === 404 ? 'not_found' : res.status === 403 ? 'forbidden' : res.status === 401 ? 'auth' : `http_${res.status}`;
      const phase = res.status === 404 || res.status === 403 ? 'unavailable' : 'failed';
      this.once(`${phase}|${reason}|${characterId}`, { phase, reason, trigger: run.trigger });
      this.settleUi(characterId, run);
      this.finish(characterId, run);
      return;
    }

    if (kind === 'request') {
      this.once(`requested|${characterId}|${run.trigger}`, {
        phase: 'requested',
        trigger: run.trigger,
        state: reply.state,
        created: reply.created === true,
      });
    }

    switch (reply.state) {
      case 'queued':
      case 'running': {
        // A portrait edit the cloud has not seen yet still answers for the old portrait.
        run.waited = true;
        if (this.ui.get(characterId) !== 'ready') this.setUi(characterId, 'preparing');
        if (this.d.now() - run.startedAt >= POLL_MAX_MS) {
          this.once(`failed|timeout|${characterId}`, { phase: 'failed', reason: 'poll_timeout', trigger: run.trigger });
          this.settleUi(characterId, run);
          this.finish(characterId, run);
          return;
        }
        this.schedule(characterId, run, pollDelay(run.polls++), ref);
        return;
      }
      case 'ready': {
        if (run.oldPortraitHash && reply.portrait_hash === run.oldPortraitHash && run.recheck < PORTRAIT_RECHECK_MS.length - 1) {
          // The cloud row still has the old portrait: look again a little later.
          run.recheck++;
          this.schedule(characterId, run, PORTRAIT_RECHECK_MS[run.recheck], ref);
          return;
        }
        await this.install(characterId, run, reply, ref);
        return;
      }
      case 'no_pack':
      case 'failed':
      case 'deferred':
      case 'unavailable':
      case 'none': {
        if (run.oldPortraitHash && reply.portrait_hash === run.oldPortraitHash && run.recheck < PORTRAIT_RECHECK_MS.length - 1) {
          run.recheck++;
          this.schedule(characterId, run, PORTRAIT_RECHECK_MS[run.recheck], ref);
          return;
        }
        const phase = reply.state === 'none' ? 'failed' : reply.state;
        this.once(`${phase}|${characterId}|${reply.portrait_hash ?? ''}`, {
          phase,
          ...(reply.reason ? { reason: reply.reason } : reply.state === 'none' ? { reason: 'not_queued' } : {}),
          trigger: run.trigger,
          wait_ms: this.d.now() - run.startedAt,
        });
        // Her old pack was for another portrait: it no longer shows her.
        const entry = await this.d.store.entry(characterId).catch(() => null);
        if (entry && reply.portrait_hash && entry.portrait_hash !== reply.portrait_hash) {
          await this.d.store.setEntry(characterId, null).catch(() => {});
          this.setUi(characterId, 'idle');
          this.notifyReady(characterId, '');
        } else {
          this.settleUi(characterId, run);
        }
        this.finish(characterId, run);
        return;
      }
    }
    this.finish(characterId, run);
  }

  /** Back to ready if her pack is on disk, else idle. */
  private settleUi(characterId: string, run: Run): void {
    void this.d.store
      .packIdFor(characterId)
      .catch(() => null)
      .then((id) => {
        if (run.gen === this.gen) this.setUi(characterId, id ? 'ready' : 'idle');
      });
  }

  private notifyReady(characterId: string, packId: string): void {
    try {
      this.d.onReady(characterId, packId);
    } catch (err) {
      this.d.log?.(`[anima] ready push failed (${(err as Error).message})`);
    }
  }

  private async install(characterId: string, run: Run, reply: ProxyReply, ref: string | null): Promise<void> {
    const pack = reply.pack;
    if (!pack || !/^[0-9a-f]{64}$/.test(pack.sha256) || !/^https:\/\//i.test(pack.url)) {
      this.once(`failed|bad_reply|${characterId}`, { phase: 'failed', reason: 'bad_reply', trigger: run.trigger });
      this.settleUi(characterId, run);
      this.finish(characterId, run);
      return;
    }
    const id = animaPackId(pack.sha256);
    const before = await this.d.store.entry(characterId).catch(() => null);
    const had = await this.d.store.hasPack(id);
    let bytes = 0;
    if (!had) {
      if (this.ui.get(characterId) !== 'ready') this.setUi(characterId, 'preparing');
      const t0 = this.d.now();
      try {
        const zip = await this.d.download(pack.url, DOWNLOAD_MAX_BYTES);
        bytes = zip.byteLength;
        await this.d.store.install(zip, pack.sha256);
      } catch (err) {
        const reason = err instanceof AnimaPackError ? err.code : 'download';
        this.once(`failed|${reason}|${characterId}`, { phase: 'failed', reason, trigger: run.trigger });
        this.d.log?.(`[anima] install failed (${reason})`);
        this.settleUi(characterId, run);
        this.finish(characterId, run);
        return;
      }
      this.d.log?.(`[anima] pack ${id} installed (${(bytes / 1e6).toFixed(1)} MB, ${this.d.now() - t0} ms)`);
    }
    if (run.gen !== this.gen) return;
    const entry: AnimaIndexEntry = {
      pack_sha256: pack.sha256,
      portrait_hash: reply.portrait_hash ?? null,
      portrait_ref: ref,
      checked_at: this.d.now(),
    };
    await this.d.store.setEntry(characterId, entry);
    const changed = before?.pack_sha256 !== pack.sha256;
    this.setUi(characterId, 'ready');
    this.once(`ready|${characterId}|${pack.sha256}`, {
      phase: 'ready',
      trigger: run.trigger,
      from_cache: !run.waited,
      source: had ? 'disk' : run.waited ? 'baked' : 'cloud_cache',
      wait_ms: this.d.now() - run.startedAt,
      ...(bytes ? { pack_mb: Math.round(bytes / 1e5) / 10 } : {}),
    });
    this.finish(characterId, run);
    if (changed) {
      this.notifyReady(characterId, id);
      // Her old pack: removed once the views have moved to the new one.
      if (before) this.d.setTimeout(() => this.d.store.prune().then(() => undefined, () => undefined), PRUNE_DELAY_MS);
    }
  }
}
