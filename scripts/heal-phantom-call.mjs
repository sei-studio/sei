#!/usr/bin/env node
/**
 * heal-phantom-call.mjs — repair a companion's memory after a "phantom call"
 * incident: a voice call left running while other audio (videos, music) played
 * into the microphone, so the companion held a long "conversation" with that
 * audio. The flood of junk turns pollutes three things the model reads:
 *
 *   1. chat.jsonl        — hundreds of voice rows that fill the recent window
 *   2. MEMORY.md         — remember() entries about the phantom conversation
 *   3. bridge.json       — the rolling summary, rewritten fold by fold until
 *                          the real relationship content is gone
 *
 * This script runs ENTIRELY on the user's machine. It sends nothing anywhere.
 * It never deletes: every removed row/entry is moved into a quarantine file
 * next to the original, and the whole memory directory is copied to a backup
 * first. It never prints message content, only timestamps and counts.
 *
 * Usage (quit Sei first):
 *   node heal-phantom-call.mjs [--dry-run] [--auto] [--data-dir <path>]
 *
 * No Node installed? The Sei app carries one:
 *   macOS:   ELECTRON_RUN_AS_NODE=1 "/Applications/Sei.app/Contents/MacOS/Sei" heal-phantom-call.mjs
 *   Windows: set ELECTRON_RUN_AS_NODE=1 && "%LOCALAPPDATA%\Programs\Sei\Sei.exe" heal-phantom-call.mjs
 *
 * --dry-run  report only, change nothing
 * --auto     quarantine every auto-flagged session without asking per-session
 */

import { readFile, writeFile, readdir, mkdir, copyFile, rename, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

// ── knobs ────────────────────────────────────────────────────────────────
/** A gap longer than this between adjacent voice rows splits two sessions. */
const SESSION_GAP_MS = 5 * 60_000;
/** Auto-flag thresholds: sustained machine-cadence "user" speech. */
const FLAG_MIN_SPAN_MS = 15 * 60_000;
const FLAG_MIN_USER_ROWS = 50;
const FLAG_MAX_MEDIAN_USER_GAP_S = 15;
/** Pad around a quarantined window when matching MEMORY.md entry stamps. */
const MEMORY_PAD_MS = 2 * 60_000;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const AUTO = args.includes('--auto');
const dataDirArg = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : null;

function defaultDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Sei');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? '', 'Sei');
  return path.join(os.homedir(), '.config', 'Sei');
}

const DATA_DIR = dataDirArg ?? defaultDataDir();
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const fmt = (ms) =>
  new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function readJsonl(p) {
  let raw;
  try { raw = await readFile(p, 'utf8'); } catch { return null; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push({ line, msg: JSON.parse(line) }); } catch { rows.push({ line, msg: null }); }
  }
  return rows;
}

/**
 * Group the transcript's voice rows into call sessions and measure each.
 * A session is a maximal run of voice rows whose adjacent gaps stay under
 * SESSION_GAP_MS. Non-voice rows end the run (system/play rows are rare
 * enough mid-call that splitting on them only makes quarantine narrower,
 * never wider — the conservative direction).
 */
export function findVoiceSessions(rows) {
  const sessions = [];
  let cur = null;
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].msg;
    const isVoice = !!(m && m.voice === true && typeof m.ts === 'number');
    if (!isVoice) { if (cur) { sessions.push(cur); cur = null; } continue; }
    if (cur && m.ts - cur.end > SESSION_GAP_MS) { sessions.push(cur); cur = null; }
    if (!cur) cur = { start: m.ts, end: m.ts, idx: [], userTs: [] };
    cur.end = m.ts;
    cur.idx.push(i);
    if (m.role === 'user') cur.userTs.push(m.ts);
  }
  if (cur) sessions.push(cur);
  for (const s of sessions) {
    s.spanMs = s.end - s.start;
    const gaps = [];
    for (let i = 1; i < s.userTs.length; i++) gaps.push((s.userTs[i] - s.userTs[i - 1]) / 1000);
    gaps.sort((a, b) => a - b);
    s.medianUserGapS = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
    s.flagged =
      s.spanMs >= FLAG_MIN_SPAN_MS &&
      s.userTs.length >= FLAG_MIN_USER_ROWS &&
      s.medianUserGapS <= FLAG_MAX_MEDIAN_USER_GAP_S;
  }
  return sessions;
}

/** MEMORY.md entry lines stamped inside any selected window (with pad). */
export function splitMemory(md, windows) {
  const kept = [];
  const removed = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]/);
    if (m) {
      const at = Date.parse(m[1]);
      const inWindow = windows.some((w) => at >= w.start - MEMORY_PAD_MS && at <= w.end + MEMORY_PAD_MS);
      if (inWindow) { removed.push(line); continue; }
    }
    kept.push(line);
  }
  return { kept: kept.join('\n'), removed };
}

async function atomicWrite(p, content) {
  const tmp = p + '.tmp-' + STAMP;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, p);
}

async function backupDir(src, dest) {
  await mkdir(dest, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    if (e.isFile()) await copyFile(path.join(src, e.name), path.join(dest, e.name));
  }
}

async function characterName(profileDir, charId) {
  for (const cand of [path.join(profileDir, 'characters', charId + '.json')]) {
    try {
      const j = JSON.parse(await readFile(cand, 'utf8'));
      if (j && typeof j.name === 'string') return j.name;
    } catch { /* fall through */ }
  }
  return null;
}

async function main() {
  console.log(`Sei phantom-call repair ${DRY ? '(DRY RUN — nothing will be changed)' : ''}`);
  console.log(`Data dir: ${DATA_DIR}`);
  if (!(await exists(DATA_DIR))) {
    console.error('Sei data directory not found. Pass --data-dir <path>.');
    process.exit(1);
  }
  console.log('\nIMPORTANT: quit the Sei app before continuing.\n');

  const rl = AUTO || DRY ? null : createInterface({ input: process.stdin, output: process.stdout });
  const profilesDir = path.join(DATA_DIR, 'profiles');
  const profiles = (await exists(profilesDir)) ? await readdir(profilesDir) : [];
  let totalQuarantined = 0;

  for (const profile of profiles) {
    const profileDir = path.join(profilesDir, profile);
    const memRoot = path.join(profileDir, 'memory');
    if (!(await exists(memRoot))) continue;

    // Surface a possibly language-flipped config for the user to eyeball.
    try {
      const cfg = JSON.parse(await readFile(path.join(profileDir, 'config.json'), 'utf8'));
      if (cfg.chat_language) console.log(`[profile ${profile}] chat_language is "${cfg.chat_language}" — if the companion switched language, this is why (edit config.json to change it back).`);
    } catch { /* no config or unreadable — fine */ }

    for (const charId of await readdir(memRoot)) {
      const charDir = path.join(memRoot, charId);
      const chatPath = path.join(charDir, 'chat.jsonl');
      const rows = await readJsonl(chatPath);
      if (!rows || rows.length === 0) continue;

      const name = await characterName(profileDir, charId);
      const label = `${name ?? charId} (profile ${profile})`;
      const sessions = findVoiceSessions(rows);
      const candidates = sessions.filter((s) => s.spanMs >= FLAG_MIN_SPAN_MS || s.flagged);
      if (candidates.length === 0) continue;

      console.log(`\n== ${label} — ${rows.length} transcript rows`);
      candidates.forEach((s, i) => {
        console.log(
          `  [${i + 1}] ${fmt(s.start)} → ${fmt(s.end)}  (${Math.round(s.spanMs / 60000)} min, ` +
          `${s.idx.length} rows, ${s.userTs.length} "you" rows, median gap ${Number.isFinite(s.medianUserGapS) ? s.medianUserGapS.toFixed(1) + 's' : 'n/a'})` +
          (s.flagged ? '  ← LOOKS LIKE A PHANTOM CALL' : ''),
        );
      });

      let chosen;
      if (AUTO || DRY) {
        chosen = candidates.filter((s) => s.flagged);
      } else {
        const ans = (await rl.question(
          '  Quarantine which sessions? (numbers comma-separated / "f" = all flagged / enter = none): ',
        )).trim().toLowerCase();
        if (ans === 'f') chosen = candidates.filter((s) => s.flagged);
        else chosen = ans.split(',').map((x) => candidates[Number(x.trim()) - 1]).filter(Boolean);
      }
      if (chosen.length === 0) { console.log('  Nothing selected — skipped.'); continue; }

      const windows = chosen.map((s) => ({ start: s.start, end: s.end }));
      const dropIdx = new Set(chosen.flatMap((s) => s.idx));

      // MEMORY.md entries stamped inside the chosen windows.
      const memPath = path.join(charDir, 'MEMORY.md');
      let memPlan = null;
      if (await exists(memPath)) {
        memPlan = splitMemory(await readFile(memPath, 'utf8'), windows);
      }

      const bridgePath = path.join(charDir, 'bridge.json');
      const hasBridge = await exists(bridgePath);

      console.log(
        `  Plan: quarantine ${dropIdx.size} transcript rows, ` +
        `${memPlan ? memPlan.removed.length : 0} memory entries; ` +
        `${hasBridge ? 'reset the rolling summary (rebuilt automatically from the cleaned transcript)' : 'no summary file present'}.`,
      );
      if (DRY) continue;

      // 1. Backup the whole character memory dir.
      const backup = path.join(profileDir, `memory-backup-${STAMP}`, charId);
      await backupDir(charDir, backup);
      console.log(`  Backup: ${backup}`);

      // 2. Transcript: keep / quarantine.
      const keptLines = [];
      const quarLines = [];
      rows.forEach((r, i) => (dropIdx.has(i) ? quarLines : keptLines).push(r.line));
      await writeFile(path.join(charDir, `chat.quarantine-${STAMP}.jsonl`), quarLines.join('\n') + '\n', 'utf8');
      await atomicWrite(chatPath, keptLines.join('\n') + (keptLines.length ? '\n' : ''));

      // 3. Memory entries.
      if (memPlan && memPlan.removed.length) {
        await writeFile(path.join(charDir, `MEMORY.quarantine-${STAMP}.md`), memPlan.removed.join('\n') + '\n', 'utf8');
        await atomicWrite(memPath, memPlan.kept);
      }

      // 4. Rolling summary: move aside; the app rebuilds it from the cleaned
      //    transcript on its own (a missing bridge.json means "fresh").
      if (hasBridge) {
        await rename(bridgePath, path.join(charDir, `bridge.quarantine-${STAMP}.json`));
      }

      totalQuarantined += dropIdx.size;
      console.log('  Done.');
    }
  }

  rl?.close();
  console.log(
    totalQuarantined || DRY
      ? `\nFinished. ${DRY ? 'Dry run — nothing was changed.' : `Quarantined ${totalQuarantined} rows total. Nothing was deleted; every removed row is in the *.quarantine-* files and the full backup.`}`
      : '\nNo phantom call sessions found. Nothing was changed.',
  );
}

// Allow importing findVoiceSessions/splitMemory for tests without running.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
