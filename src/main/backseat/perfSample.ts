/**
 * Main's half of backseat_perf (261123, see shared/backseatPerf.ts): reads
 * CPU seconds and memory from app.getAppMetrics() for the renderer that sent
 * the sample, the GPU process and all of Sei, against the baseline taken at
 * that renderer's 'start' marker.
 *
 * cumulativeCPUUsage (CPU seconds since process start) rather than
 * percentCPUUsage, because the latter is "since the last getAppMetrics call"
 * and any other caller would silently shorten the window.
 */
import os from 'node:os';
import { app } from 'electron';
import {
  backseatPerfProps,
  cpuProps,
  sanitizeBackseatPerf,
  type CpuSnapshot,
} from '../../shared/backseatPerf';

const baselines = new Map<number, CpuSnapshot>();

function snapshot(rendererPid: number | null): CpuSnapshot {
  const snap: CpuSnapshot = {
    at: Date.now(),
    rendererCpuS: null,
    gpuCpuS: null,
    totalCpuS: null,
    rendererMemMb: null,
    gpuMemMb: null,
    totalMemMb: null,
  };
  let metrics: Electron.ProcessMetric[] = [];
  try {
    metrics = app.getAppMetrics();
  } catch {
    return snap;
  }
  let total = 0;
  let totalMem = 0;
  let haveTotal = false;
  for (const m of metrics) {
    const cpuS = m.cpu?.cumulativeCPUUsage;
    const memMb = typeof m.memory?.workingSetSize === 'number' ? Math.round(m.memory.workingSetSize / 1024) : null;
    if (typeof cpuS === 'number') {
      total += cpuS;
      haveTotal = true;
    }
    if (memMb !== null) totalMem += memMb;
    if (rendererPid !== null && m.pid === rendererPid) {
      snap.rendererCpuS = typeof cpuS === 'number' ? cpuS : null;
      snap.rendererMemMb = memMb;
    }
    if (m.type === 'GPU') {
      snap.gpuCpuS = typeof cpuS === 'number' ? cpuS : null;
      snap.gpuMemMb = memMb;
    }
  }
  if (haveTotal) snap.totalCpuS = total;
  snap.totalMemMb = totalMem || null;
  return snap;
}

/**
 * Handle one backseat_perf message from a renderer. Returns the props to send,
 * or null for the 'start' marker (baseline only) and malformed input.
 */
export function handleBackseatPerf(
  sender: { id: number; getOSProcessId: () => number },
  rawProps: unknown,
): Record<string, string | number | boolean | null> | null {
  const sample = sanitizeBackseatPerf(rawProps);
  if (!sample) return null;
  let pid: number | null = null;
  try {
    pid = sender.getOSProcessId();
  } catch {
    pid = null;
  }
  const now = snapshot(pid);
  if (sample.phase === 'start') {
    baselines.set(sender.id, now);
    return null;
  }
  const base = baselines.get(sender.id) ?? null;
  if (sample.phase === 'end') baselines.delete(sender.id);
  return backseatPerfProps(sample, cpuProps(base, now, os.cpus().length));
}
