/**
 * Unvoiced lines (261121, T507): a companion line whose TTS failed is still
 * shown, so a call with a broken voice reads as text instead of silence.
 *
 * Before this the call caption was set only from a clip's first audible
 * sample, and a generic VOICE_TTS_FAILED set no notice, so when every TTS
 * transfer failed (a connection that cut off larger downloads) the call
 * looked completely silent while text chat worked.
 *
 * Pure pieces only; useVoiceStore wires them.
 */

/** Unvoiced lines of one speaker this close together read as one reply. */
export const UNVOICED_RUN_MS = 15_000;
/** At most this many lines of a run stay in the caption (oldest drop). */
export const UNVOICED_RUN_MAX_LINES = 3;

export interface UnvoicedRun {
  characterId: string;
  lines: string[];
  /** When the newest line was shown. */
  at: number;
  /** The caption text this run last produced (to tell whether anything
   * replaced it since). */
  caption: string;
}

/** Scripts written without spaces between sentences. */
const NO_SPACE_SCRIPT = /[\u3040-\u30FF\u3400-\u9FFF\uFF00-\uFFEF]/;

function joinLines(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    if (!out) out = line;
    else if (NO_SPACE_SCRIPT.test(out.slice(-1)) || NO_SPACE_SCRIPT.test(line.charAt(0))) out += line;
    else out += ` ${line}`;
  }
  return out;
}

/**
 * The run after one more unvoiced line. Several lines of one reply fail in
 * quick succession, and replacing the caption with each would leave only the
 * last one readable, so a line from the same speaker inside UNVOICED_RUN_MS
 * joins the run, as long as the caption still shows that run (an audible
 * line or another speaker in between starts a new one).
 */
export function nextUnvoicedRun(
  prev: UnvoicedRun | null,
  currentCaption: string,
  characterId: string,
  text: string,
  now: number,
): UnvoicedRun {
  const line = text.trim();
  const continues =
    prev !== null &&
    prev.characterId === characterId &&
    now - prev.at < UNVOICED_RUN_MS &&
    prev.caption === currentCaption;
  const lines = continues ? [...prev.lines, line].slice(-UNVOICED_RUN_MAX_LINES) : [line];
  return { characterId, lines, at: now, caption: joinLines(lines) };
}

/** After the notice clears (audio played again), it can come back no sooner
 * than this: a flaky connection should not flash it on every other line. */
export const VOICE_FAIL_NOTICE_GAP_MS = 60_000;

/**
 * Gate for the generic "voice could not load" call notice: shown on the
 * first failure, not repeated while it is up, cleared when audio plays, and
 * not shown again within VOICE_FAIL_NOTICE_GAP_MS of the last time.
 */
export function createVoiceFailNoticeGate(gapMs = VOICE_FAIL_NOTICE_GAP_MS) {
  let showing = false;
  let shownAt = Number.NEGATIVE_INFINITY;
  return {
    /** A line failed. True = show the notice now. */
    failed(now: number): boolean {
      if (showing || now - shownAt < gapMs) return false;
      showing = true;
      shownAt = now;
      return true;
    },
    /** Audio played. True = the notice is up and should be cleared. */
    audible(): boolean {
      const was = showing;
      showing = false;
      return was;
    },
    /** New call: forget everything. */
    reset(): void {
      showing = false;
      shownAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/**
 * Which call notice a TTS failure with no specific notice gets. On-device
 * voices have no connection to check; Fish Audio and every cloud voice do.
 * VOICE_DISABLED (a companion with no voice) is not a failure: null.
 */
export function genericTtsFailureKind(msg: string, onDeviceVoice: boolean): 'connection' | 'local' | null {
  if (/VOICE_DISABLED/.test(msg)) return null;
  // BYOK with no ElevenLabs key: a setup state, not a connection problem.
  if (/VOICE_NOT_CONFIGURED: add your ElevenLabs key/.test(msg)) return null;
  return onDeviceVoice ? 'local' : 'connection';
}




