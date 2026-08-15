/**
 * phantomDetect — pure detection core for the in-app "phantom call" recovery
 * (260810). Port of scripts/heal-phantom-call.mjs's two exported functions;
 * the script remains the out-of-app fallback and this module must keep its
 * semantics byte-for-byte (the script's thresholds were tuned on the real
 * incident data).
 *
 * The incident this detects: a voice call left running while other audio
 * (videos, music) played into the microphone. STT manufactures a "user
 * utterance" every few seconds, so the transcript fills with machine-cadence
 * user rows for as long as the call runs. The cadence signature is deliberate:
 * it measures the frequency of USER rows, never LLM request rate — an
 * attentive human never produces 7s-median utterances for 15+ minutes, while
 * an autonomous backseat session with a silent player produces FEW user rows
 * and must NOT flag.
 *
 * Everything in this file is pure (no I/O, no Electron) so it is unit-testable
 * and reusable by offline validation scripts.
 */

// ── knobs (mirrors scripts/heal-phantom-call.mjs) ──────────────────────────
/** A gap longer than this between adjacent voice rows splits two sessions. */
export const SESSION_GAP_MS = 5 * 60_000;
/** Auto-flag thresholds: sustained machine-cadence "user" speech. */
export const FLAG_MIN_SPAN_MS = 15 * 60_000;
export const FLAG_MIN_USER_ROWS = 50;
export const FLAG_MAX_MEDIAN_USER_GAP_S = 15;
/** Pad around a quarantined window when matching MEMORY.md entry stamps. */
export const MEMORY_PAD_MS = 2 * 60_000;

/** A parsed transcript row, or null when the JSONL line did not parse. */
export interface ChatRowLike {
  role?: unknown;
  ts?: unknown;
  voice?: unknown;
}

export interface VoiceSessionStats {
  /** ts of the first voice row in the session. */
  start: number;
  /** ts of the last voice row in the session. */
  end: number;
  /** Indices (into the rows array given) of every row in the session. */
  idx: number[];
  /** Timestamps of the user-role rows in the session. */
  userTs: number[];
  spanMs: number;
  /** Median gap between consecutive user rows, seconds. Infinity when <2. */
  medianUserGapS: number;
  /** True when the session matches the phantom-call cadence signature. */
  flagged: boolean;
}

export interface TimeWindow {
  start: number;
  end: number;
}

/**
 * Parse a chat.jsonl blob into { line, msg } pairs, preserving the raw line so
 * a rewrite can keep every untouched row byte-identical. Unparseable lines get
 * msg: null (they are never voice rows, so they are always kept).
 */
export function parseChatJsonl(
  raw: string,
): Array<{ line: string; msg: ChatRowLike | null }> {
  const rows: Array<{ line: string; msg: ChatRowLike | null }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push({ line, msg: JSON.parse(line) as ChatRowLike });
    } catch {
      rows.push({ line, msg: null });
    }
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
export function findVoiceSessions(
  rows: Array<{ msg: ChatRowLike | null }>,
): VoiceSessionStats[] {
  interface Building {
    start: number;
    end: number;
    idx: number[];
    userTs: number[];
  }
  const sessions: Building[] = [];
  let cur: Building | null = null;
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].msg;
    const isVoice = !!(m && m.voice === true && typeof m.ts === 'number');
    if (!isVoice) {
      if (cur) {
        sessions.push(cur);
        cur = null;
      }
      continue;
    }
    const ts = m!.ts as number;
    if (cur && ts - cur.end > SESSION_GAP_MS) {
      sessions.push(cur);
      cur = null;
    }
    if (!cur) cur = { start: ts, end: ts, idx: [], userTs: [] };
    cur.end = ts;
    cur.idx.push(i);
    if (m!.role === 'user') cur.userTs.push(ts);
  }
  if (cur) sessions.push(cur);

  return sessions.map((s) => {
    const spanMs = s.end - s.start;
    const gaps: number[] = [];
    for (let i = 1; i < s.userTs.length; i++) gaps.push((s.userTs[i] - s.userTs[i - 1]) / 1000);
    gaps.sort((a, b) => a - b);
    const medianUserGapS = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
    const flagged =
      spanMs >= FLAG_MIN_SPAN_MS &&
      s.userTs.length >= FLAG_MIN_USER_ROWS &&
      medianUserGapS <= FLAG_MAX_MEDIAN_USER_GAP_S;
    return { ...s, spanMs, medianUserGapS, flagged };
  });
}

/**
 * Split MEMORY.md into kept text + removed entry lines: entry lines
 * (`- [ISO] text`) whose timestamp falls inside any selected window
 * (± MEMORY_PAD_MS) are removed; EVERY other line — including `## World N`
 * headers, blank lines, and non-entry prose — is preserved byte-identically.
 */
export function splitMemory(
  md: string,
  windows: TimeWindow[],
): { kept: string; removed: string[] } {
  const kept: string[] = [];
  const removed: string[] = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]/);
    if (m) {
      const at = Date.parse(m[1]);
      const inWindow = windows.some(
        (w) => at >= w.start - MEMORY_PAD_MS && at <= w.end + MEMORY_PAD_MS,
      );
      if (inWindow) {
        removed.push(line);
        continue;
      }
    }
    kept.push(line);
  }
  return { kept: kept.join('\n'), removed };
}
