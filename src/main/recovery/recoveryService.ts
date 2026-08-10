/**
 * recoveryService — main-process side of the in-app phantom-call recovery
 * (260810; incident: a voice call left running while videos played into the
 * mic manufactured ~440 phantom "user" rows over 52 minutes, junk remember()
 * entries, and ~20 summary folds that destroyed bridge.json).
 *
 * Three operations, all local, nothing ever leaves the machine:
 *
 *   scan()    — run the pure detector over every character in the ACTIVE
 *               profile and return flagged sessions as SHAPE ONLY (character,
 *               window, counts, cadence). Never message text.
 *   repair()  — quarantine a character's flagged windows, FAILSAFE BY DESIGN:
 *               full dir backup first, quarantine sidecars written BEFORE any
 *               original is touched, atomic rewrites, and bridge.json only
 *               removed after its quarantine copy exists. If any step throws,
 *               every original is still valid.
 *   dismiss() — persist "don't ask about this window again" keys in
 *               <profileRoot>/recovery-state.json. Deliberately NOT in
 *               UserConfig: the dismissal describes local transcript state and
 *               must never cloud-sync.
 *
 * MEMORY.archive.md is NEVER touched under any circumstance — it is the
 * permanent raw record and the fallback if this recovery itself has a bug.
 * (The backup step copies it, which is read-only with respect to the
 * original; no write path in this module names it.)
 */
import { readFile, writeFile, readdir, mkdir, copyFile, rename, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { paths } from '../paths';
import type { RecoveryCandidate, RecoveryRepairResult, RecoveryWindow } from '../../shared/ipc';
import { findVoiceSessions, parseChatJsonl, splitMemory } from './phantomDetect';

/** Backup dirs live at <profileRoot>/recovery-backup-<stamp>/<characterId>/ —
 * deliberately OUTSIDE <profileRoot>/memory/ so a later scan never mistakes a
 * backup for a character's live memory dir. */
const BACKUP_PREFIX = 'recovery-backup-';

const stateFilePath = (): string => path.join(paths.profileRoot(), 'recovery-state.json');
const memoryRoot = (): string => path.join(paths.profileRoot(), 'memory');

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readChatRows(
  characterId: string,
): Promise<Array<{ line: string; msg: ReturnType<typeof JSON.parse> | null }> | null> {
  try {
    const raw = await readFile(path.join(paths.memoryDir(characterId), 'chat.jsonl'), 'utf8');
    return parseChatJsonl(raw);
  } catch {
    return null;
  }
}

/** Character display name off the on-disk JSON; falls back to null rather
 * than importing the characterStore's full validation chain (a legacy-shaped
 * row must not break a scan). */
async function characterName(characterId: string): Promise<string | null> {
  try {
    const j = JSON.parse(
      await readFile(path.join(paths.charactersDir(), `${characterId}.json`), 'utf8'),
    ) as { name?: unknown };
    return typeof j.name === 'string' && j.name.trim() ? j.name : null;
  } catch {
    return null;
  }
}

// ── dismissed-window persistence ───────────────────────────────────────────

interface RecoveryState {
  /** `${characterId}:${startTs}` keys the user chose to ignore. */
  dismissed: string[];
}

async function readState(): Promise<RecoveryState> {
  try {
    const parsed = JSON.parse(await readFile(stateFilePath(), 'utf8')) as { dismissed?: unknown };
    const dismissed = Array.isArray(parsed.dismissed)
      ? parsed.dismissed.filter((k): k is string => typeof k === 'string')
      : [];
    return { dismissed };
  } catch {
    return { dismissed: [] };
  }
}

export function sessionKey(characterId: string, startTs: number): string {
  return `${characterId}:${startTs}`;
}

/** Persist dismissed session keys so they never re-prompt. Idempotent. */
export async function dismissRecovery(keys: string[]): Promise<void> {
  const state = await readState();
  const merged = Array.from(new Set([...state.dismissed, ...keys]));
  await mkdir(path.dirname(stateFilePath()), { recursive: true });
  await writeFile(stateFilePath(), JSON.stringify({ dismissed: merged }, null, 2) + '\n', 'utf8');
}

// ── scan ───────────────────────────────────────────────────────────────────

/**
 * Detect phantom-call sessions across every character in the active profile.
 * Read-only; returns shape only (never message text). Dismissed windows are
 * filtered out here so the renderer never has to re-check.
 */
export async function scanRecovery(): Promise<RecoveryCandidate[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(memoryRoot(), { withFileTypes: true });
  } catch {
    return []; // no memory dir yet — nothing to scan
  }
  const { dismissed } = await readState();
  const dismissedSet = new Set(dismissed);
  const out: RecoveryCandidate[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith(BACKUP_PREFIX)) continue;
    const characterId = e.name;
    const rows = await readChatRows(characterId);
    if (!rows || rows.length === 0) continue;
    const flagged = findVoiceSessions(rows).filter((s) => s.flagged);
    if (flagged.length === 0) continue;
    const name = await characterName(characterId);
    for (const s of flagged) {
      if (dismissedSet.has(sessionKey(characterId, s.start))) continue;
      out.push({
        characterId,
        characterName: name ?? 'Your companion',
        startTs: s.start,
        endTs: s.end,
        userRows: s.userTs.length,
        totalRows: s.idx.length,
        medianGapS: Number.isFinite(s.medianUserGapS)
          ? Math.round(s.medianUserGapS * 10) / 10
          : 0,
      });
    }
  }
  return out;
}

// ── repair ─────────────────────────────────────────────────────────────────

async function atomicWrite(p: string, content: string, stamp: string): Promise<void> {
  const tmp = `${p}.tmp-${stamp}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, p);
}

/** Copy every regular file of a character memory dir into the backup dir. */
async function backupDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    if (e.isFile()) await copyFile(path.join(src, e.name), path.join(dest, e.name));
  }
}

/**
 * Quarantine the given windows for one character. Order of operations is the
 * failsafe (see module docblock): backup → sidecars → atomic rewrites →
 * bridge removal. Throws on failure with originals intact.
 */
export async function repairRecovery(
  characterId: string,
  windows: RecoveryWindow[],
): Promise<RecoveryRepairResult> {
  const stamp = stampNow();
  const charDir = paths.memoryDir(characterId);
  const chatPath = path.join(charDir, 'chat.jsonl');
  const memPath = path.join(charDir, 'MEMORY.md');
  const bridgePath = path.join(charDir, 'bridge.json');

  const rows = await readChatRows(characterId);
  if (!rows) throw new Error('No transcript found for this character.');

  // A row is quarantined when it is a VOICE row whose ts falls inside any of
  // the selected windows — exactly the rows findVoiceSessions grouped, since a
  // window IS a session's [start, end] span and sessions are voice-row runs.
  const inWindow = (ts: number): boolean => windows.some((w) => ts >= w.start && ts <= w.end);
  const keptLines: string[] = [];
  const quarLines: string[] = [];
  for (const r of rows) {
    const m = r.msg as { voice?: unknown; ts?: unknown } | null;
    const drop = !!(m && m.voice === true && typeof m.ts === 'number' && inWindow(m.ts));
    (drop ? quarLines : keptLines).push(r.line);
  }

  let memPlan: { kept: string; removed: string[] } | null = null;
  if (await exists(memPath)) {
    memPlan = splitMemory(await readFile(memPath, 'utf8'), windows);
  }
  const hasBridge = await exists(bridgePath);

  // (a) Backup the WHOLE character memory dir before touching anything.
  const backup = path.join(paths.profileRoot(), `${BACKUP_PREFIX}${stamp}`, characterId);
  await backupDir(charDir, backup);

  // (b) Quarantine sidecars BEFORE any original changes.
  if (quarLines.length) {
    await writeFile(
      path.join(charDir, `chat.quarantine-${stamp}.jsonl`),
      quarLines.join('\n') + '\n',
      'utf8',
    );
  }
  if (memPlan && memPlan.removed.length) {
    await writeFile(
      path.join(charDir, `MEMORY.quarantine-${stamp}.md`),
      memPlan.removed.join('\n') + '\n',
      'utf8',
    );
  }
  if (hasBridge) {
    await copyFile(bridgePath, path.join(charDir, `bridge.quarantine-${stamp}.json`));
  }

  // (c) Atomic transcript rewrite (tmp + rename).
  await atomicWrite(chatPath, keptLines.join('\n') + (keptLines.length ? '\n' : ''), stamp);

  // (d) Atomic MEMORY.md rewrite. MEMORY.archive.md is never touched.
  if (memPlan && memPlan.removed.length) {
    await atomicWrite(memPath, memPlan.kept, stamp);
  }

  // (e) Drop bridge.json LAST — a missing bridge means "fresh" to continuity.ts
  // (readBridge catches and returns {summary:'', summarizedCount:0}), so the
  // rolling summary rebuilds from the CLEANED transcript on the next fold.
  if (hasBridge) {
    await rm(bridgePath, { force: true });
  }

  const result: RecoveryRepairResult = {
    rowsQuarantined: quarLines.length,
    memoryLinesRemoved: memPlan ? memPlan.removed.length : 0,
  };

  // Analytics: shape only, lazy import, never load-bearing (CLAUDE.md rule).
  void (async () => {
    try {
      const { capture } = await import('../analytics');
      capture('memory_repair_run', {
        sessions_cleaned: windows.length,
        rows_quarantined: result.rowsQuarantined,
        memory_lines_removed: result.memoryLinesRemoved,
      });
    } catch {
      /* analytics is never load-bearing */
    }
  })();

  return result;
}
