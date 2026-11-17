/**
 * Whether the local speech runtime (sherpa-onnx: the Fast and Kokoro voices,
 * SenseVoice) can load on this install, and why not (261118).
 *
 * A Windows 11 user with Smart App Control on had every local voice fail in
 * silence: SAC refused sherpa-onnx-c-api.dll (CodeIntegrity 3077/3033, the
 * DLL was unsigned until the 261118 build), sherpa-onnx-node swallowed the
 * real loader error into "Could not find sherpa-onnx-node", and the voice
 * settings still said the voice pack was Ready. Now the first failed load is
 * classified once per process:
 *
 *   blocked_by_policy  Windows code integrity refused the file (SAC or a
 *                      WDAC policy). Seen in the loader message, or inferred
 *                      when SAC is on and the files are present.
 *   missing            the platform package is not on disk.
 *   load_failed        anything else (a broken DLL, a missing VC runtime).
 *
 * The status feeds the voice settings line, the in-call system-voice
 * fallback (src/main/voice/tts.ts) and the `local_speech_load_failed`
 * analytics event. It never holds the loader message itself beyond the main
 * log: Windows localizes it and it carries install paths.
 */
import { execFile } from 'node:child_process';

export type SpeechRuntimeCode = 'blocked_by_policy' | 'missing' | 'load_failed';
/** Smart App Control: VerifiedAndReputablePolicyState 1 = on, 2 = evaluation, 0 = off. */
export type SacState = 'on' | 'eval' | 'off' | 'unknown' | 'n/a';

export type SpeechRuntimeStatus =
  | { state: 'unknown' }
  | { state: 'ok' }
  | { state: 'failed'; code: SpeechRuntimeCode; sac: SacState };

/**
 * Loader messages that mean code integrity refused the image. Windows
 * localizes the text, so the numeric forms matter most:
 * ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION is 4551 (0x80071C7 as an HRESULT
 * 0x800711C7); 0xC0000428 is STATUS_INVALID_IMAGE_HASH ("Windows cannot
 * verify the digital signature").
 */
const POLICY_BLOCK =
  /application control|device guard|code integrity|smart app control|integrity polic|digital signature|\b4551\b|0x0*800711c7|0x0*c0000428/i;

export function classifySpeechLoadError(input: {
  message: string;
  platform: NodeJS.Platform;
  /** The platform addon (sherpa-onnx.node) exists on disk. */
  addonPresent: boolean;
  sac: SacState;
}): SpeechRuntimeCode {
  if (POLICY_BLOCK.test(input.message)) return 'blocked_by_policy';
  if (!input.addonPresent) return 'missing';
  // With SAC enforcing and the files in place, a load failure is SAC
  // refusing one of the unsigned DLLs the addon links: when the refused file
  // is a dependency, LoadLibrary can surface it as a plain "module could not
  // be found" (126) for the addon instead of the policy error.
  if (input.platform === 'win32' && input.sac === 'on') return 'blocked_by_policy';
  return 'load_failed';
}

/** Parse `reg query ... /v VerifiedAndReputablePolicyState` output. */
export function parseSacState(regOutput: string): SacState {
  const m = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(regOutput);
  if (!m) return 'unknown';
  const v = parseInt(m[1], 16);
  return v === 1 ? 'on' : v === 2 ? 'eval' : v === 0 ? 'off' : 'unknown';
}

/** Smart App Control state on Windows; 'n/a' elsewhere. Never throws. */
export function readSacState(platform: NodeJS.Platform = process.platform): Promise<SacState> {
  if (platform !== 'win32') return Promise.resolve('n/a');
  return new Promise((resolve) => {
    try {
      execFile(
        'reg.exe',
        ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState'],
        { timeout: 3_000, windowsHide: true },
        (err, stdout) => resolve(err ? 'unknown' : parseSacState(String(stdout))),
      );
    } catch {
      resolve('unknown');
    }
  });
}

// ── process-wide state ─────────────────────────────────────────────────────

let status: SpeechRuntimeStatus = { state: 'unknown' };
let classifying: Promise<SpeechRuntimeStatus> | null = null;
type FailureListener = (s: Extract<SpeechRuntimeStatus, { state: 'failed' }>) => void;
const listeners = new Set<FailureListener>();

export function speechRuntimeStatus(): SpeechRuntimeStatus {
  return status;
}

/** Resolves once a pending failure has been classified (SAC read included). */
export function speechRuntimeSettled(): Promise<SpeechRuntimeStatus> {
  return classifying ?? Promise.resolve(status);
}

export function noteSpeechRuntimeOk(): void {
  status = { state: 'ok' };
}

/**
 * Record the first load failure. The synchronous status is set at once (SAC
 * unknown); the SAC read then refines it and the listeners fire ONCE per
 * process with the final code.
 */
export function noteSpeechRuntimeFailure(
  input: { message: string; addonPresent: boolean },
  deps: { platform?: NodeJS.Platform; readSac?: () => Promise<SacState> } = {},
): void {
  if (status.state === 'failed' || classifying) return;
  const platform = deps.platform ?? process.platform;
  const sync = classifySpeechLoadError({ ...input, platform, sac: 'unknown' });
  status = { state: 'failed', code: sync, sac: 'unknown' };
  classifying = (deps.readSac ?? (() => readSacState(platform)))()
    .catch((): SacState => 'unknown')
    .then((sac) => {
      const final = { state: 'failed' as const, code: classifySpeechLoadError({ ...input, platform, sac }), sac };
      status = final;
      for (const l of listeners) {
        try {
          l(final);
        } catch {
          /* a listener never breaks speech */
        }
      }
      return final;
    });
}

export function onSpeechRuntimeFailure(l: FailureListener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Tests only. */
export function resetSpeechRuntimeStatusForTest(): void {
  status = { state: 'unknown' };
  classifying = null;
  listeners.clear();
}
