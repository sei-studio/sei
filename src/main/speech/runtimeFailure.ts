/**
 * Why the sherpa-onnx runtime would not load (issue #59, 261127).
 *
 * On Windows 11 with Smart App Control on, Code Integrity refuses to map an
 * unsigned native (events 3077/3033). v0.7.0 shipped sherpa-onnx.node and its
 * DLLs unsigned, so every on-device voice line (Fast and Kokoro) and every
 * SenseVoice transcription failed with SPEECH_RUNTIME_FAILED. The loader
 * itself cannot say why: sherpa-onnx-node's addon.js swallows each require
 * error and throws a generic "Could not find sherpa-onnx-node". So, once per
 * process, the failure is diagnosed here:
 *
 *   - the platform package (sherpa-onnx-<platform>-<arch>) absent from the
 *     install = 'missing' (the mac x64 case from 260817);
 *   - on Windows, loading the platform .node directly to read the OS loader
 *     message, plus the Smart App Control state from the registry (the loader
 *     message is localized, so the English wording alone cannot be relied
 *     on) = 'os_blocked';
 *   - anything else = 'load_error'.
 *
 * The reason rides the thrown sentinel (`SPEECH_RUNTIME_FAILED: os_blocked:
 * ...`) so the call notice can say Windows blocked it, and one
 * `speech_runtime_failed` diagnostic {reason, sac_state} goes to analytics.
 * Never the loader message: it carries the user's install path.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type SpeechRuntimeFailureReason = 'os_blocked' | 'missing' | 'load_error';

/** Smart App Control, from HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy
 * VerifiedAndReputablePolicyState: 0 off, 1 on (enforcing), 2 evaluation
 * (audits, blocks nothing). 'unknown' off Windows or when unreadable. */
export type SmartAppControlState = 'on' | 'evaluation' | 'off' | 'unknown';

/**
 * English Windows loader messages for a code-integrity or app-control block:
 * ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION (4551, "An Application Control
 * policy has blocked this file"), ERROR_INVALID_IMAGE_HASH (577, "Windows
 * cannot verify the digital signature for this file") and
 * ERROR_ACCESS_DISABLED_BY_POLICY (1260, "blocked by group policy").
 */
const OS_BLOCK_MESSAGE =
  /application control policy|blocked by group policy|device guard|smart app control|code integrity|cannot verify the digital signature/i;

export interface SpeechRuntimeProbe {
  platform: NodeJS.Platform;
  /** The platform package's .node file is present in the install. */
  platformPackageFound: boolean;
  /** The OS loader's message when the .node was loaded directly, or null
   * when that load succeeded (or was not attempted). */
  loadError: string | null;
  sac: SmartAppControlState;
}

export function classifySpeechRuntimeFailure(p: SpeechRuntimeProbe): SpeechRuntimeFailureReason {
  if (!p.platformPackageFound) return 'missing';
  // A blocked dependency DLL (sherpa-onnx-c-api.dll, onnxruntime.dll) makes
  // the .node fail with a plain "module could not be found", so with Smart
  // App Control enforcing, any direct load failure counts as the block.
  if (p.platform === 'win32' && p.loadError !== null && (p.sac === 'on' || OS_BLOCK_MESSAGE.test(p.loadError))) {
    return 'os_blocked';
  }
  return 'load_error';
}

export function parseSmartAppControlState(regOutput: string): SmartAppControlState {
  const m = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(regOutput);
  if (!m) return 'unknown';
  switch (parseInt(m[1], 16)) {
    case 0:
      return 'off';
    case 1:
      return 'on';
    case 2:
      return 'evaluation';
    default:
      return 'unknown';
  }
}

/** Reads the Smart App Control state. Never rejects; 'unknown' off Windows. */
export function readSmartAppControlState(platform: NodeJS.Platform = process.platform): Promise<SmartAppControlState> {
  if (platform !== 'win32') return Promise.resolve('unknown');
  // Absolute path: a reg.exe earlier on PATH must not answer for Windows.
  const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise((resolve) => {
    try {
      execFile(
        reg,
        ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState'],
        { timeout: 3000, windowsHide: true },
        (err, stdout) => resolve(err ? 'unknown' : parseSmartAppControlState(String(stdout))),
      );
    } catch {
      resolve('unknown');
    }
  });
}

/** The platform package dir name sherpa-onnx-node's addon.js looks for
 * (it calls win32 "win"). */
export function sherpaPlatformPackage(platform: NodeJS.Platform, arch: string): string {
  return `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}`;
}

/**
 * Probes why sherpa-onnx-node failed to load. `req` is the bundle-anchored
 * require that failed (bundleRequire). Never throws.
 */
export async function probeSpeechRuntime(
  req: NodeJS.Require,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<SpeechRuntimeProbe> {
  let nodeFile: string | null = null;
  try {
    // Same place addon.js tries: the sibling of sherpa-onnx-node's own dir.
    const pkgDir = path.dirname(req.resolve('sherpa-onnx-node/package.json'));
    const candidate = path.join(pkgDir, '..', sherpaPlatformPackage(platform, arch), 'sherpa-onnx.node');
    if (existsSync(candidate)) nodeFile = candidate;
  } catch {
    /* sherpa-onnx-node itself is absent: the platform package is too */
  }
  let loadError: string | null = null;
  if (nodeFile) {
    try {
      req(nodeFile);
    } catch (err) {
      loadError = String((err as Error)?.message ?? err);
    }
  }
  const sac = await readSmartAppControlState(platform);
  return { platform, platformPackageFound: nodeFile !== null, loadError, sac };
}
