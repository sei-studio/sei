/**
 * Mic dictation (260705): capture → energy VAD → local Whisper transcription.
 *
 * Design constraints that shaped this:
 *   - Open-source + free + no native modules: Whisper runs locally in a Web
 *     Worker via transformers.js (see whisperWorker.ts); segmentation is a
 *     plain RMS-energy VAD, so the only dependency is the model itself.
 *   - Against the companion's own voice: getUserMedia echo cancellation
 *     removes most of the TTS audio from the mic signal. 260705 barge-in:
 *     while companion audio plays (`setHold(true)`) the VAD keeps listening
 *     at an ELEVATED threshold (BARGE_RMS_FLOOR/BARGE_FACTOR) — the echo
 *     residue stays below it, real player speech clears it, opens an
 *     utterance, and fires onBargeIn so the owner cuts playback.
 *   - Mute is renderer-side: the stream keeps running (fast unmute) but frames
 *     are discarded and any in-progress utterance is dropped.
 *
 * VAD: 16kHz mono frames captured by a tiny AudioWorklet (see WORKLET_SRC —
 * inline blob module, so no bundler plumbing); speech opens when frame RMS
 * exceeds an adaptive noise floor, closes after END_SILENCE_MS below it.
 * Utterances shorter than MIN_UTTERANCE_MS are discarded (coughs, clicks);
 * longer than MAX_UTTERANCE_MS are force-flushed so a monologue still lands.
 * The VAD math runs on the main thread off the worklet's posted frames — the
 * worklet only batches samples (128-sample render quanta → 2048-sample frames,
 * ~8 messages/sec).
 */

import { dbOf, pushEnv, type EnvSample, type MicEchoInfo } from './echoGate';
import { createSttArbiter } from './sttArbiter';
import { whisperMirrorFirst } from './mirrorPref';
import { tagCallSetupStage } from './callSetupFailure';
import { isJunkTranscript } from './pfcSteer';

export type DictationStatus = 'loading-model' | 'ready' | 'error';

/** First-run model download is ~40MB; a stalled CDN must surface as an error
 * instead of an eternal "Connecting…" (260705 field report). */
const MODEL_LOAD_TIMEOUT_MS = 180_000;

export interface Dictation {
  /** Renderer-side mute: discard mic input without stopping the stream. */
  setMuted(muted: boolean): void;
  /** Half-duplex hold — true while companion audio is playing. 260705: no
   * longer a hard discard — during hold the VAD keeps listening at an
   * ELEVATED threshold so the player can barge in (see onBargeIn). */
  setHold(hold: boolean): void;
  /** 260726: the held clip just became AUDIBLE — restart the barge-in grace
   * window from here. setHold(true) fires when the clip takes the playhead,
   * which for a streamed clip precedes the whole TTS round trip; on the first
   * line of a call that gap routinely exceeded the window, so the greeting
   * entered its first spoken word already interruptible with AEC converged on
   * nothing. Re-arming on real audio gives every clip its full window. */
  armBargeGrace(): void;
  /** True once the mic level shows live speech (drives the UI level dot). */
  speechActive(): boolean;
  /** Tear down mic, audio graph, and worker. */
  stop(): void;
}

const SAMPLE_RATE = 16_000;
const FRAME_SIZE = 2048; // ~128ms at 16kHz
const START_RMS_FLOOR = 0.012; // absolute minimum to open speech
const NOISE_ADAPT = 0.02; // EMA rate for the noise floor
const START_FACTOR = 3; // open at noiseFloor * factor (≥ START_RMS_FLOOR)
// 600ms (was 700 → 550 → 450 → 600): every ms here is dead air on the player's
// end of the call — the whole reply pipeline (Whisper + LLM + TTS) queues
// behind utterance-end detection, so this was trimmed aggressively. 260725
// walked it back up: at 450ms an ordinary mid-sentence breath split utterances
// in two ("那你和你的" / "其他的机器人会说什么语言？" landed as separate turns),
// and a split costs a whole wrong reply, which no latency win pays for.
const END_SILENCE_MS = 600;
// 260705 latency: fire a PROVISIONAL Whisper pass this early into a silence
// run. Silence frames add no words, so if the silence holds to END_SILENCE_MS
// the provisional transcript IS the final one — Whisper's ~0.5–1s of work
// overlaps the remaining ~600ms of end-of-utterance wait instead of starting
// after it. If speech resumes, the provisional result is discarded.
const EAGER_SILENCE_MS = 250;
// 260724 cloud STT: once the LOCAL transcript is ready, how much longer the
// cloud (Scribe) pass may run before we stop waiting and ship local. This is
// the hard bound on what cloud STT can add over local-only latency; when
// cloud beats local outright (long clips) it costs nothing. See sttArbiter.ts.
const CLOUD_STT_GRACE_MS = 400;
// 260725 'none' local-model mode: cloud-only transcription hard bound. With no
// local worker behind it a hung Scribe request would strand the utterance
// forever; past this the utterance is dropped and the failure surfaces
// through onCloudSttFailure.
const CLOUD_ONLY_TIMEOUT_MS = 8_000;
const MIN_UTTERANCE_MS = 350;
const MAX_UTTERANCE_MS = 15_000;
// Frames kept before speech opens. The trigger frame itself lands in preRoll
// (pushed before the threshold check), so this is trigger + 2 true
// pre-trigger frames (~256ms of onset context).
const PRE_ROLL_FRAMES = 3;
// Barge-in (260705): while companion audio plays (hold), speech must clear a
// stiffer bar than normal — echo cancellation removes most of the companion's
// own voice from the mic, and the margin keeps the residue from
// self-triggering.
// 260725: the bar is now ADAPTIVE. The fixed absolute floor (0.03 → 0.05 →
// 0.065 across three speaker-echo tuning rounds) was calibrated to one
// machine's speaker leakage; on a quieter setup (headphones, or any mic post
// autoGainControl-off) real speech never reached 0.065 and barge-in was
// silently impossible — the "talking over her does nothing, indicator never
// lights" report. Instead we MEASURE the echo residue that actually reaches
// the mic while each clip plays (holdResidue EMA below) and set the bar a
// multiple above that: headphones → residue ≈ noise floor → low bar, easy
// interrupts; loud speakers → high residue → high bar, no self-triggering.
// The old absolute constant survives only as BARGE_ABS_MIN, the floor that
// keeps a dead-quiet room from setting a hair-trigger bar.
// Raised 0.025 -> 0.04 (260726): on HEADPHONES there is no leakage to learn
// from, so holdResidue collapses to the room floor and the bar pins to this
// constant for the whole call — 0.025 (~-32 dBFS) is close enough to a breath
// or a mouth click on an in-ear mic that transients kept cutting clips off
// (the AirPods "her last word gets chopped" report). 0.04 is ~-28 dBFS: still
// well under conversational speech at a headset mic (~-24 dBFS, which is what
// has to clear it) and ~10 dB over a quiet room floor, but above the transient
// noise that was self-triggering. Ceiling comes from the tuning history above:
// 0.065 was high enough that real speech never reached it.
// Lowered 0.04 -> 0.03 (260728, "interrupting on an open laptop mic takes
// shouting"): a built-in mic at arm's length reads several dB quieter than a
// headset mic, so ordinary speech was hovering AT the 0.04 bar and only a
// raised voice held above it for the full BARGE_CONFIRM_MS run. 0.03 keeps
// ~8 dB over a quiet room floor; the 260726 transient problem is guarded by
// the level gate AND the 400ms sustained-run gate together, so the duration
// gate carries more of the load now. If in-ear transients chop clips again,
// raise BARGE_CONFIRM_MS before re-raising this.
const BARGE_ABS_MIN = 0.03;
const BARGE_NOISE_FACTOR = 5; // bar is also ≥ noiseFloor * this
// Lowered 3 -> 2.5 (260728, same laptop report): on open speakers the residue
// term dominates the bar, and 3x the echo EMA (~9.5 dB over it) demanded a
// shout from an arm's-length mic. 2.5x (~8 dB) still clears the residue's own
// frame-to-frame wobble — single echo peaks reset the sustained-run gate and
// never survive 400ms — while genuine speech over the companion lands.
const BARGE_RESIDUE_FACTOR = 2.5; // bar is residue * this — speech must clear it
// Residue EMA rates: rise fast so the first frames of a clip (and the grace
// window) capture how loud its echo really is; decay slow so brief pauses
// inside a clip don't collapse the bar mid-sentence.
const RESIDUE_RISE = 0.25;
const RESIDUE_DECAY = 0.02;
// 260706: barge-in grace window. AEC needs time to converge on each NEW clip's
// audio; during that window the companion's own onset echoes into the mic above
// the barge bar and self-triggers a barge-in that cuts the clip off after a
// split second (the "I only heard 'hey'" bug). Ignore barge-in for this long
// after each clip starts playing (setHold(true)); genuine barge-in over a
// longer clip still lands once the window passes.
const BARGE_GRACE_MS = 600;
// 260730: the grace window is per PLAYBACK RUN, not per clip.
//
// What AEC needs to converge on is the output path, and that does not change
// between the lines of one reply — only the first clip after real quiet starts
// cold. Charging every clip a full 600ms was survivable while the queue went
// IDLE between short lines (those gaps dropped the hold, so the player's speech
// opened a normal utterance and interrupted that way), but reserving each
// clip's slot at emit time (audioQueue `blob`, 260729) closed the gaps: the
// hold now spans the whole reply, and every line inside it re-armed the full
// window. On ~1.2s lines that left ~600ms of interruptible audio per line
// against a 400ms confirm, with `bargeRunMs` zeroed at every boundary — which
// is "talking over her does nothing" for a multi-line reply.
//
// So only the FIRST audible clip of a hold run gets the full window; every
// later clip in the same unbroken run gets the short one, which is enough for
// the boundary transient and not enough to eat the interrupt.
const BARGE_REGRACE_MS = 150;
// 260706: barge-in must be SUSTAINED, not a single frame. Playing the call out
// loud (speakers, not headphones) leaks the companion's own voice past echo
// cancellation; a lone loud frame of that residue used to trip a barge-in and
// clear the queue, cutting the companion off mid-sentence (the "lines get cut
// off" bug). Real player speech holds above the barge bar for a beat, so we
// require this much CONTINUOUS elevated energy before it counts — brief echo
// peaks reset the run and never fire. ~3 frames at ~128ms each.
// Raised 320 -> 480 (260706): a longer continuous run is needed to count as a
// barge-in, so a burst of speaker-echo residue can't trip it — only sustained
// real speech does. ~3-4 frames at ~128ms each.
// Lowered 480 -> 300 (260708, "interrupt faster"): frames land every ~128ms,
// so the confirm quantizes to whole frames — 480 fired on the 4th consecutive
// over-bar frame (~512ms of the player talking over the companion), 300 fires
// on the 3rd (~384ms). The single-frame echo peaks the sustained-run gate
// exists for still reset the run and never reach 3 frames; the residual risk
// (a 3-frame speaker-echo burst) is also softer now that a barge-in FADES the
// clip out (audioQueue clear) instead of hard-cutting it. If speaker users
// report self-interruptions again, this is the knob to raise (4 frames = 400+).
// Raised 300 -> 400 (260726): back to the 4th consecutive over-bar frame. A
// breath or a click is one or two frames and now always resets the run; real
// speech holds. Pairs with the BARGE_ABS_MIN raise above — level gate first,
// duration gate second, so a transient has to be both loud AND sustained.
// Raised 400 -> 1400 (260804), and it is no longer the main path. Read the
// block below first: sustained energy is now the FALLBACK that fires when
// transcription cannot answer, so it is tuned to be slow and certain rather
// than fast and occasionally wrong. 1400ms is eleven consecutive over-bar
// frames, which no burst of speaker echo has ever produced.
const BARGE_CONFIRM_MS = 1400;

/**
 * ── Barge-in, two stages (260804) ────────────────────────────────────────
 *
 * The old design had one gate: sustained energy over an adaptive bar, and on
 * trip it CLEARED the queue. That single gate had to serve two contradictory
 * masters. Trip too easily and speaker echo cuts the companion off mid-word,
 * destroying a line for nothing; trip too reluctantly and interrupting her
 * takes shouting. Six rounds of tuning across three reports moved the numbers
 * around and never resolved it, because the conflict is structural: energy
 * cannot tell speech from a door closing, and a cleared queue cannot be undone.
 *
 * Splitting it resolves both at once, because the two stages can have opposite
 * temperaments:
 *
 *   1. DUCK, on almost any noise. One frame over a low bar. The companion drops
 *      to near-silence in ~130ms, which is what the player actually perceives
 *      as being able to interrupt her. It is REVERSIBLE, so being wrong is
 *      nearly free, which is exactly why the bar can be this low. (261031: the
 *      duck PAUSES her clip and a retraction resumes it where it stopped; it
 *      used to mute a clip that kept playing. See "Voice after the duck".)
 *   2. COMMIT, only on a WORD. The audio collected since the duck goes to the
 *      same STT that transcribes every utterance, and the barge is confirmed
 *      only if a real word comes back. A cough, a keyboard, a door, the
 *      companion's own echo: all transcribe to nothing or to junk, and the clip
 *      comes back up as though nothing happened.
 *
 * So the trigger is dictation, not gain, which is the whole point: what decides
 * whether the companion stops talking is now whether the player SAID something.
 *
 * Latency, honestly. Perceived interrupt: ~130ms, against ~400ms before, and
 * with no 600ms grace-window blind spot at the start of every clip. Commit:
 * BARGE_WORD_MS of speech plus one short STT pass, so roughly 500-800ms —
 * slower than the old 400ms commit. That is the right trade, because by then
 * she has already been silent for hundreds of milliseconds; the commit is only
 * what decides whether the line is discarded, and nobody hears a decision.
 */

/** Speech collected before the confirming transcription is fired. Long enough
 *  to hold one short word ("wait", "no", "hey") — Whisper on less than this
 *  hallucinates, which is the same floor MIN_UTTERANCE_MS exists for. */
const BARGE_WORD_MS = 400;
/** Level bar for the DUCK, against BARGE_ABS_MIN's for the commit fallback.
 *  ~-34 dBFS: under a quiet word at a laptop mic, over a still room. */
const DUCK_ABS_MIN = 0.02;
/** Duck bar is also this multiple of the measured echo residue, against
 *  BARGE_RESIDUE_FACTOR's 2.5. Lower because a false duck is recoverable. */
const DUCK_RESIDUE_FACTOR = 1.6;
/** Continuous over-bar energy before ducking. One frame: the whole value of
 *  this stage is that it happens before anything can be confirmed. */
const DUCK_CONFIRM_MS = 120;
/** How long a duck may stay unconfirmed. Past this the transcription has
 *  either failed or is slower than the feature can wait for, and the decision
 *  falls back to energy: still loud means still talking. */
const BARGE_SUSPECT_MAX_MS = 1800;
/** 261030: once the confirming pass HAS come back with a word and only the
 *  echo gate is still deciding whose word it was, the energy deadline above
 *  no longer applies. The gate's slow path waits one bounded screen-STT flush
 *  (~1.2 s), which on top of a cloud STT round trip routinely ran past 1.8 s
 *  during a share, and the energy fallback then threw the player's words away
 *  whenever that one frame happened to sit under the stiff bar (a pause
 *  between words, or simply a loud game). This is the outer bound for the
 *  gate's answer, after which the old energy rule decides as before. */
const BARGE_ECHO_WAIT_MAX_MS = 4000;
/**
 * 261030: the noise-floor term of both barge bars is capped at this while a
 * screen share is live (BARGE_ABS_MIN / BARGE_NOISE_FACTOR, so the term can
 * never exceed the absolute minimum).
 *
 * Why: AEC removes only Sei's own TTS from the mic. Game audio played on
 * speakers reaches the mic untouched, and the noise floor (adapted between her
 * lines) climbs to the game's level. Both bars are >= 5x that floor, so over a
 * loud game a normal voice never crossed either, and interrupting her was
 * impossible (0.6.10 Windows report: "It doesnt let me interrupt it", during a
 * Roblox share). The measured hold residue already contains the game AND her
 * echo, because it is sampled while she plays, so it keeps carrying the margin
 * over both (speech must clear 1.6x of it to duck, 2.5x to commit on energy).
 * The cap only removes the floor's extra 5x on top; the floor itself still
 * counts at the residue's factors (see bargeBars). The bars never drop below
 * what a quiet room gives with the same residue, so TTS echo false triggers
 * are no more likely than with the same speakers in a quiet room. What a share's game sound may
 * now trip is the DUCK, which stage two retracts unless STT hears a word that
 * the echo gate does not trace back to the screen.
 */
const SHARE_NOISE_FLOOR_CAP = BARGE_ABS_MIN / BARGE_NOISE_FACTOR;

/**
 * ── Voice after the duck (261031) ──────────────────────────────────────────
 *
 * 0.6.11 cut companions off far too often during shares (one Windows user:
 * 19 cuts and 75 ducks in 8 minutes, "it keeps getting cut off"). Replayed
 * headless over real game audio with her TTS echo on top and a real Whisper
 * pass, three things combined:
 *
 *   1. The duck trips on one frame, and game audio is spiky: in a Roblox clip
 *      over a third of all frames sit above 1.6x the median. So she ducked
 *      every 10-60 s for nothing, and the duck MUTED her while the clip kept
 *      running, so each false duck also skipped about a second of her line.
 *      (Fixed in audioQueue: the duck pauses the clip and resumes it.)
 *   2. The confirming pass transcribed the pre-roll, the ~400 ms BEFORE the
 *      duck, which is her own voice leaking past AEC. Whisper turns half a
 *      second of that into "What?", "Okay.", "Yeah.", and one or two words are
 *      under the echo gate's minimum token count, so they committed: a false
 *      cut, and the same phantom word was then sent to her as the player's
 *      turn.
 *   3. A cut is not undoable, and hasSpokenWord accepts words the utterance
 *      junk filter later drops ("thank you", "music"): she was cut and then
 *      nothing was said to her, so she went silent.
 *
 * So once she is ducked, the decision only looks at what the mic hears AFTER
 * the duck, when she is paused and her echo is gone:
 *
 *   - Voice evidence first, for free: the frames after the duck have to clear
 *     the duck bar with her echo taken out (`bargeVoiceBar`, the room alone).
 *     A click, a door, a game hit or her own onset dies inside a few frames,
 *     and the duck is retracted with NO transcription at all ('no_voice'). A
 *     voice keeps going. This now holds only for ducks inside a clip's grace
 *     window: a later duck may be a short word that is already over, and
 *     gets its one pass (see "A short word" below).
 *   - The confirming pass never reads the pre-roll: it starts at the frame
 *     after the trigger (at the trigger itself after a clean duck), and
 *     commits only on a word that also passes the utterance junk filter and
 *     the echo gate.
 *   - The energy deadline needs most of the post-duck frames voiced, not one
 *     loud frame.
 *   - A pass that found no word gets ONE more pass over the audio after it
 *     when a voice kept going while it was out: the player who starts talking
 *     during a duck that something else opened is still heard.
 *   - A duck a transcription has rejected teaches the bar (learnFalseDuck):
 *     a loud game otherwise re-ducked her the instant she resumed, forever.
 *   - Her audio never ends up inside an ordinary utterance either: one that
 *     is open when her clip becomes audible ends there (armBargeGrace), and
 *     the pre-roll collected under hold is dropped when she stops.
 *
 *   - A short word (261031 review): "no", "stop" or "wait" is often over in
 *     the trigger frame and the skip frame, and nothing voiced follows. When
 *     the duck came after the clip's grace window (the residue knows her echo,
 *     so the trigger was louder than she can be), the duck gets ONE pass over
 *     the trigger frame onward once the voice window closes, and commits on a
 *     word like any other. An energy test on the skip frame was tried first
 *     and lost most short words on loud speakers, where the end of a word and
 *     the tail of her echo are the same level; a learned duck bar and the
 *     pass are what bound it instead. A duck inside the grace window (where
 *     the trigger may be her own onset) still needs a voice after it, and is
 *     retracted for free without one.
 *   - Nothing transcribed is thrown away silently: a pass that answers after
 *     the energy deadline gave up on it, or after a finished barge's wait ran
 *     out, still reaches her as an ordinary turn when it is a word the echo
 *     gate does not trace to her (settleDelivery).
 *
 * The cost, honestly: a clean false duck (a game hit, a loud syllable of
 * hers) costs one transcription, and on rare occasions Whisper makes a stock
 * word of that audio ("Bye.") and it cuts her: in the headless replay a
 * couple of times an hour on loud speakers over a game, against close to
 * once a minute in 0.6.11. A word that never reaches the duck bar is not
 * heard as an interrupt at all, and neither is a short word inside the first
 * ~150 ms of one of her clips (600 ms for the first clip of a reply) that is
 * over before a voiced frame. The old pre-roll pass caught some of those, by
 * the same mechanism that invented "Okay." out of her echo.
 */
/** Frames right after the trigger that still carry her echo: the duck's
 *  60 ms ramp plus the speaker-to-mic path. Not counted either way. */
const VOICE_SKIP_FRAMES = 1;
/** Frames after the skip in which the player's voice has to show up. Three
 *  frames is ~380 ms: the player pauses this long only between sentences. */
const VOICE_WINDOW_FRAMES = 3;
/** Voiced frames needed inside that window before any transcription runs. */
const VOICE_MIN_FRAMES = 1;
/** Share of post-duck frames over the voice bar the energy deadline needs
 *  (the fallback for a transcription that never answered). */
const BARGE_DEADLINE_VOICED = 0.6;
/** Voiced frames heard while the confirming pass was out that earn one more
 *  pass when the first found no word (~250 ms of a voice still going). */
const BARGE_REASK_VOICED = 2;
/** How far one false duck moves the echo residue toward its trigger level. */
const FALSE_DUCK_LEARN = 0.5;

export interface BargeLevels {
  /** Adaptive room noise floor (EMA over frames outside speech and hold). */
  noiseFloor: number;
  /** EMA of what reaches the mic while the companion plays. */
  holdResidue: number;
  /** A screen share is live, so other apps' audio may be in the room. */
  shareActive: boolean;
}

/**
 * The two barge bars for one frame under hold (pure, tested). `duck` opens
 * stage one; `commit` is the sustained-energy fallback's bar. See
 * SHARE_NOISE_FLOOR_CAP for what the share changes and why.
 */
export function bargeBars(l: BargeLevels): { duck: number; commit: number } {
  if (!l.shareActive) {
    const floorTerm = l.noiseFloor * BARGE_NOISE_FACTOR;
    return {
      duck: Math.max(DUCK_ABS_MIN, floorTerm, l.holdResidue * DUCK_RESIDUE_FACTOR),
      commit: Math.max(BARGE_ABS_MIN, floorTerm, l.holdResidue * BARGE_RESIDUE_FACTOR),
    };
  }
  // During a share the floor stops being multiplied by 5 and is treated like
  // the residue instead: both measure what the room sounds like without the
  // player, and the floor is the fresher of the two at the start of a line (it
  // adapted to the game in the gap, while the residue still holds the last
  // line's level). Without this the first loud frame of every line ducked her.
  const floorTerm = Math.min(l.noiseFloor, SHARE_NOISE_FLOOR_CAP) * BARGE_NOISE_FACTOR;
  const room = Math.max(l.holdResidue, l.noiseFloor);
  return {
    duck: Math.max(DUCK_ABS_MIN, floorTerm, room * DUCK_RESIDUE_FACTOR),
    commit: Math.max(BARGE_ABS_MIN, floorTerm, room * BARGE_RESIDUE_FACTOR),
  };
}

/** The energy bar the unanswered-duck deadline decides on (no floor term, as
 *  before 261030). Exported for the tests. */
export function bargeDeadlineBar(holdResidue: number): number {
  return Math.max(BARGE_ABS_MIN, holdResidue * BARGE_RESIDUE_FACTOR);
}

/**
 * The level a frame AFTER a duck must reach to count as the player's voice
 * (261031, pure, tested): the duck bar with her echo residue taken out, since
 * the duck paused her and the mic now hears only the room (and, during a
 * share, the game). See the voice-after-the-duck block above.
 */
export function bargeVoiceBar(l: BargeLevels): number {
  return bargeBars({ ...l, holdResidue: 0 }).duck;
}

/** Why a provisional barge was retracted (261030 diagnostics). 'echo' = the
 *  echo gate traced the confirming words to the speakers; 'no_word' = no word
 *  came back (or the energy fallback decided against it); 'no_voice' (261031)
 *  = nothing voice-like followed the duck, so no transcription ran at all;
 *  'cancelled' = the utterance was abandoned (mute, teardown, a hold
 *  transition). */
export type BargeAbortReason = 'echo' | 'no_word' | 'no_voice' | 'cancelled';

/** A word worth stopping her for: what hasSpokenWord accepts AND the junk
 *  filter every finished utterance goes through would keep (261031). Without
 *  the second half, "thank you" or "music" cut her and was then dropped
 *  before it reached her, and she went silent. */
export function isBargeWord(text: string): boolean {
  return hasSpokenWord(text) && !isJunkTranscript(text);
}

/**
 * Does a transcript contain a word the player actually said?
 *
 * Deliberately stricter than the junk filter used on finished utterances. This
 * runs on ~400ms of audio, where every STT engine is at its most inventive, and
 * a false positive here cuts off a line that was doing nothing wrong. Requiring
 * a letter or CJK run of at least two characters rejects the whole observed
 * vocabulary of onset artifacts: "", ".", "-", "you", "[BLANK_AUDIO]", "hhh",
 * "MM", and bare punctuation. ("you" survives the length test and is a real
 * word, so it is named explicitly: it is Whisper's single most common output
 * for a fragment of noise.)
 */
export function hasSpokenWord(text: string): boolean {
  const clean = text
    // Engines annotate non-speech in brackets AND in parentheses: "[BLANK_AUDIO]",
    // "[silence]", "(music)", "(wind blowing)". Stripping both leaves nothing,
    // which is the correct answer for all of them.
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .trim()
    .toLowerCase();
  if (!clean) return false;
  const words = clean.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  if (words.length === 1) {
    const w = words[0];
    if (w === 'you' || w === 'the' || w === 'a') return false;
    // A single repeated LETTER is breath ("hhhh", "mmmm"), not speech. Scoped
    // to Latin script on purpose: a repeated CJK character is an ordinary word
    // (等等, 慢慢), and rejecting it would make barge-in silently impossible in
    // Chinese and Japanese, which is exactly the class of bug the adaptive
    // energy bar was fixed for in 260725.
    if (/^[a-z]+$/.test(w) && /^(.)\1*$/.test(w)) return false;
    return w.length >= 2;
  }
  return true;
}

/**
 * AudioWorklet processor (issue: ScriptProcessorNode is deprecated). Batches
 * the 128-sample render quanta into FRAME_SIZE frames and posts them to the
 * main thread (transferred, zero-copy). Inlined as a blob module so it needs
 * no bundler/worklet build plumbing; it must stay dependency-free JS.
 */
const WORKLET_SRC = `
class SeiVadCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(${FRAME_SIZE});
    this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this._buf.length - this._n);
        this._buf.set(ch.subarray(i, i + take), this._n);
        this._n += take;
        i += take;
        if (this._n === this._buf.length) {
          const out = this._buf;
          this.port.postMessage(out, [out.buffer]);
          this._buf = new Float32Array(${FRAME_SIZE});
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('sei-vad-capture', SeiVadCapture);
`;

export async function createDictation(opts: {
  /** `span` (260925): wall-clock bounds of the utterance's audio, when known. */
  onUtterance: (text: string, span?: { t0: number; t1: number }) => void;
  onStatus: (status: DictationStatus, detail?: string) => void;
  /** CONFIRMED barge-in: a word was transcribed from speech that opened during
   * hold. The owner should stop companion playback — which releases the hold —
   * and this same utterance then flows through onUtterance as usual. */
  onBargeIn?: () => void;
  /** PROVISIONAL barge-in (260804): something crossed the low bar during hold
   * and may be the player. The owner should DUCK playback (since 261031:
   * pause it, so a retraction resumes the same words), not stop it — this
   * fires on coughs and doors too, and is retracted by onBargeAbort when the
   * confirming transcription comes back without a word. See the two-stage
   * block above BARGE_WORD_MS. */
  onBargeSuspect?: () => void;
  /** The provisional barge-in was not speech. Bring playback back up. Only ever
   * fires after onBargeSuspect and never after onBargeIn. */
  onBargeAbort?: (reason: BargeAbortReason) => void;
  /** Fires true when the player's live mic speech opens and false when it ends —
   * drives the "you're talking" ring on the caller's own avatar (same lit ring
   * the companions get while speaking). Edge-emitted, so it only fires on change. */
  onSpeechActive?: (active: boolean) => void;
  /** 260709: conversation language (UserConfig.chat_language). 'en'/absent
   * keeps the English-only whisper-tiny.en; any other code loads the
   * multilingual model with that decode language pinned (whisperWorker.ts). */
  language?: string;
  /** 260724: cloud STT (ElevenLabs Scribe via main). When present, every
   * utterance races this against the local worker (see sttArbiter.ts —
   * bounded grace, local always the fallback). Resolve null on any failure
   * or when cloud STT is unavailable; must not reject. */
  cloudTranscribe?: (audio: Float32Array) => Promise<string | null>;
  /** 260725 STT policy: 'eager' (default) boots the local Whisper worker up
   * front (today's behavior — cloud races it when configured). 'none' skips
   * the worker AND the ~40MB model download entirely: the mic/VAD pipeline
   * starts immediately (status goes straight to 'ready') and transcription is
   * cloud-only through the arbiter, bounded by CLOUD_ONLY_TIMEOUT_MS with no
   * local fallback — a failed/empty cloud pass drops the utterance. */
  localModel?: 'eager' | 'none';
  /** 260816 SenseVoice: which engine serves the LOCAL leg when 'eager'.
   * 'whisper' (default) is the in-renderer worker; 'sensevoice' skips the
   * worker entirely and every local pass goes through `mainTranscribe`
   * (main-side sherpa SenseVoice). The arbiter/race structure is unchanged —
   * only the local transcriber swaps. */
  localEngine?: 'whisper' | 'sensevoice';
  /** 260816: main-side transcription for the 'sensevoice' engine. Must
   * resolve transcript text; errors are treated as '' (the utterance falls
   * to cloud, or drops, exactly like an empty Whisper result). */
  mainTranscribe?: (audio: Float32Array) => Promise<string>;
  /** 'none' mode only: a cloud pass produced no transcript (unavailable,
   * transport error, timeout), so an utterance was dropped with nothing to
   * fall back on. Edge-fired ONCE per dictation session — the owner uses it
   * to offer the local backup-model install, not to count failures. */
  onCloudSttFailure?: () => void;
  /**
   * Echo gate (260807): asked before a transcript is delivered as the player
   * (purpose 'utterance') and before a word-confirmed barge-in commits
   * (purpose 'barge'). Resolve true when the words were the SPEAKERS — the
   * companion's own TTS leaking past AEC, or the shared screen's audio, which
   * AEC cannot touch at all (no reference signal exists for another app's
   * sound). Measured 260807: on speakers at max volume, Instagram reel
   * dialogue was dispatched as the player's own words and the companion's
   * leaked voice kept confirming barge-ins against her. May be async (the
   * screen transcript lags real time by up to one Whisper chunk); an
   * 'utterance' waits for the answer before dispatching, a 'barge' waits
   * while already ducked, so the player hears silence either way. Errors and
   * absence both mean "not echo".
   */
  echoCheck?: (info: MicEchoInfo) => boolean | Promise<boolean>;
  /**
   * 261030: whether a screen share is live right now. Read per frame under
   * hold; while true the barge bars stop scaling with the room noise floor
   * past a quiet-room level (SHARE_NOISE_FLOOR_CAP), because the floor is
   * then mostly the game's own audio.
   */
  shareActive?: () => boolean;
  /**
   * The mic stream is open (260730). Fires once, as soon as getUserMedia
   * resolves and BEFORE the model load below, because opening a mic with
   * echoCancellation reconfigures the page's whole audio OUTPUT path: Chromium
   * has to route playback through the echo canceller so it can subtract it from
   * the capture, and everything already scheduled at that moment is dropped.
   * The call's ringtone starts on this rather than at dial for exactly that
   * reason — see startRingtone's caller.
   */
  onMicReady?: () => void;
}): Promise<Dictation> {
  const useLocalModel = (opts.localModel ?? 'eager') !== 'none';
  // 260816: the SenseVoice engine runs in MAIN (sherpa), so no worker boots —
  // the local leg of the arbiter race calls mainTranscribe instead.
  const useSenseVoice =
    useLocalModel && opts.localEngine === 'sensevoice' && typeof opts.mainTranscribe === 'function';
  const useWorker = useLocalModel && !useSenseVoice;
  let nextId = 1;
  /** Delivery registry for ARBITRATED results, keyed by the id postTranscribe
   * returns — deleting an id (cancelEager) drops the eventual result. */
  const inflight = new Map<number, (text: string) => void>();
  /** Resolvers for raw local-worker passes (internal to the arbiter path). */
  const localWaiters = new Map<number, (text: string) => void>();

  // Worker first — if the model can't load there is no point holding the mic.
  // (In 'eager' mode the local model loads even when cloudTranscribe is
  // present: it is the arbiter's fallback for every utterance, and the only
  // path offline. 'none' skips the worker entirely — cloud-only calls must
  // connect without the download.)
  let worker: Worker | null = null;
  let ready: Promise<void> = Promise.resolve();
  if (useWorker) {
    opts.onStatus('loading-model');
    let w: Worker;
    try {
      w = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      opts.onStatus('error', 'speech recognition failed to start');
      throw tagCallSetupStage(err, 'stt_boot');
    }
    worker = w;
    ready = new Promise<void>((resolve, reject) => {
      // Every failure here is the local speech model's (261023: the stage and
      // a fixed error name ride the call_setup_failed event, see
      // callSetupFailure.ts). The names are ours, never the worker's text.
      let settled = false;
      const fail = (name: string, message: string): void => {
        settled = true;
        clearTimeout(watchdog);
        const err = new Error(message);
        err.name = name;
        reject(tagCallSetupStage(err, 'stt_boot'));
      };
      const watchdog = setTimeout(
        () => fail('TimeoutError', 'voice recognition took too long to download, check your connection and retry'),
        MODEL_LOAD_TIMEOUT_MS,
      );
      // The worker script itself failed to load or threw at top level. Without
      // this the call sat on "Connecting" for the whole download watchdog and
      // then blamed the connection. After 'ready' it leaves the error to the
      // console as before; per-utterance failures already answer with empty text.
      w.onerror = (e: ErrorEvent) => {
        if (settled) return;
        e.preventDefault?.();
        fail('WorkerLoadError', 'speech recognition worker failed to load');
      };
      w.onmessage = (e: MessageEvent) => {
        const msg = e.data as { type: string; id?: number; text?: string; message?: string; pct?: number };
        if (msg.type === 'ready') {
          settled = true;
          clearTimeout(watchdog);
          resolve();
        } else if (msg.type === 'init-error') {
          fail('ModelLoadError', msg.message ?? 'model load failed');
        } else if (msg.type === 'progress' && typeof msg.pct === 'number') {
          // First-run download progress — surfaced so "Connecting…" shows a
          // moving percentage instead of looking hung for ~40MB.
          opts.onStatus('loading-model', `${Math.min(99, msg.pct)}`);
        } else if (msg.type === 'transcript' && typeof msg.id === 'number') {
          localWaiters.get(msg.id)?.(msg.text ?? '');
          localWaiters.delete(msg.id);
        }
      };
    });
    w.postMessage({ type: 'init', language: opts.language ?? 'en', mirrorFirst: whisperMirrorFirst() });
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Echo cancellation is load-bearing: it subtracts the companion's TTS
        // (played by this same page) from the mic signal.
        echoCancellation: true,
        noiseSuppression: true,
        // autoGainControl OFF (260706): AGC dynamically boosts a quiet mic, which
        // makes our absolute-RMS energy VAD read "hotter" (ambient noise + speaker
        // echo cross the thresholds) and fights AEC's convergence — the "mic feels
        // too sensitive" report. Off gives a stable signal the fixed thresholds
        // can trust, which is the standard choice for energy-based VAD pipelines.
        autoGainControl: false,
      },
    });
  } catch (err) {
    worker?.terminate();
    opts.onStatus('error', 'microphone permission denied');
    // Refusals and every other getUserMedia failure (no mic, held by another
    // app) share this tag; callSetupFailureProps splits out the refusals.
    throw tagCallSetupStage(err, 'mic_capture');
  }
  // Output path is now settled (see onMicReady): anything the caller wants to
  // PLAY can be scheduled from here without the AEC switch swallowing it.
  opts.onMicReady?.();

  try {
    await ready;
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    worker?.terminate();
    opts.onStatus('error', (err as Error).message);
    throw tagCallSetupStage(err, 'stt_boot');
  }
  opts.onStatus('ready');

  // The audio graph. 261023: the AudioContext and the stream source used to be
  // built outside the try below, so a throw there skipped the cleanup and left
  // the mic stream open (and the worker running) after the call had already
  // failed.
  let graphCtx: AudioContext | null = null;
  let graphSource: MediaStreamAudioSourceNode | null = null;
  // AudioWorklet capture (replaces the deprecated ScriptProcessorNode). The
  // module is a blob URL built from WORKLET_SRC above.
  let workletUrl: string | null = null;
  let graphNode: AudioWorkletNode | null = null;
  try {
    graphCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    graphSource = graphCtx.createMediaStreamSource(stream);
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
    await graphCtx.audioWorklet.addModule(workletUrl);
    graphNode = new AudioWorkletNode(graphCtx, 'sei-vad-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
  } catch (err) {
    if (workletUrl) URL.revokeObjectURL(workletUrl);
    if (graphCtx) void graphCtx.close().catch(() => {});
    stream.getTracks().forEach((t) => t.stop());
    worker?.terminate();
    opts.onStatus('error', 'audio capture failed');
    throw tagCallSetupStage(err, 'audio_graph');
  }
  URL.revokeObjectURL(workletUrl);
  const ctx: AudioContext = graphCtx;
  const source: MediaStreamAudioSourceNode = graphSource;
  const captureNode: AudioWorkletNode = graphNode;

  let muted = false;
  let hold = false;
  /** When the current companion clip became AUDIBLE (armBargeGrace); basis for
   * the barge-in grace window that stops a clip's own onset from self-barging.
   * Deliberately NOT set by setHold: a reserved slot waiting on synthesis is
   * silence, and silence has no onset echo to protect against (260730). */
  let holdSince = 0;
  /** How long the current grace window runs — full on a cold start, short at a
   * clip boundary inside one playback run (see BARGE_REGRACE_MS). */
  let graceMs = BARGE_GRACE_MS;
  /** A clip in THIS hold run has already been audible, so AEC is converged on
   * this output path and the next clip needs the short window only. */
  let holdRunArmed = false;
  /** Diagnostics for one hold run: the loudest frame the player produced while
   * the companion held the floor, and the bar it was measured against. Logged
   * once per run so "interrupting does nothing" is answerable from a session
   * log instead of by theory — a peak far under the bar is a threshold
   * problem, a peak over it is a timing/grace problem. */
  let holdPeakRms = 0;
  let holdPeakBar = 0;
  let holdBarged = false;
  /** Running length of continuous over-the-barge-bar energy during hold; the
   * fallback commit fires once this clears BARGE_CONFIRM_MS (see there). */
  let bargeRunMs = 0;
  type Suspect = {
    since: number;
    asked: boolean;
    answered: boolean;
    /** Index of the trigger frame in `utterance`. What comes before it is
     *  pre-roll from before the duck, which is mostly her own echo. */
    head: number;
    /** bargeVoiceBar at the moment of the duck. */
    voiceBar: number;
    /** Frames since the trigger, and how many of the counted ones (past
     *  VOICE_SKIP_FRAMES) cleared voiceBar. */
    post: number;
    voiced: number;
    trig: number;
    /** The duck fired outside the clip's grace window, so the residue has
     *  learned her echo and the trigger frame was louder than she can be. */
    clean: boolean;
    /** A clean duck, past its trigger: it may be a short word that is over
     *  before any counted frame, so it is transcribed even with nothing
     *  voiced after it (261031 review). */
    burst: boolean;
    /** Where the confirming pass reads from in `utterance`, and where the
     *  audio it was given ended (a second pass reads from there). */
    askFrom: number;
    askEnd: number;
    /** Voiced frames since the pass was fired, and whether the one second
     *  pass was already spent (see BARGE_REASK_VOICED). */
    voicedSinceAsk: number;
    reasked: boolean;
    /** The confirming pass's answer once it is back (undefined while out),
     *  and who else wants it: an utterance that ended while the pass was out
     *  reuses it rather than paying for a second transcription of the same
     *  audio plus its silence run. */
    passText?: string;
    passWaiter?: (text: string) => void;
    /** How the duck was retracted while its pass was still out: 'late' means
     *  the energy deadline gave up on the pass, so its answer is still owed to
     *  the player as an ordinary turn (see settleDelivery). */
    retracted?: 'late' | 'cancelled';
  };
  /** Running length over the lower DUCK bar, which is what opens stage one. */
  let duckRunMs = 0;
  /**
   * Stage one is open: playback is ducked and this utterance is provisional
   * until a transcript decides it. Null whenever the barge machinery is idle,
   * which is also true of every utterance that began outside hold — those were
   * never in doubt.
   */
  let suspect: Suspect | null = null;
  /** A provisional barge whose utterance already ended and is waiting on its
   *  transcript (261031). She stays ducked meanwhile, so the wait is bounded
   *  (BARGE_ECHO_WAIT_MAX_MS from the flush): past it the duck is retracted
   *  and the transcript, when it comes, is an ordinary utterance. */
  type BargeVerdict = { voiced: boolean; open: boolean; since: number; trig: number };
  let flushedBarge: BargeVerdict | null = null;
  /** EMA of the echo residue reaching the mic while companion audio plays —
   * the basis of the adaptive barge bar (see BARGE_RESIDUE_FACTOR). Carries
   * across clips: the playback device and volume don't change mid-call. */
  let holdResidue = 0.008;
  let noiseFloor = 0.008;
  let inSpeech = false;
  let silenceMs = 0;
  let speechMs = 0;
  const preRoll: Float32Array[] = [];
  let utterance: Float32Array[] = [];
  /** Rolling mic loudness contour for the echo gate (260807): ~32ms samples,
   * kept long enough that a delivery decided after a transcription round trip
   * can still slice its own utterance's window out of it. */
  const recentEnv: EnvSample[] = [];
  const ENV_KEEP_MS = 20_000;
  const envWindow = (t0: number, t1: number): EnvSample[] =>
    recentEnv.filter((s) => s.t >= t0 - 100 && s.t <= t1 + 100);

  /** Edge-emit the player's live speaking state (for the caller's own avatar
   * ring). Deduped so it only fires on a genuine transition. */
  let speechEmitted = false;
  function emitSpeech(active: boolean): void {
    if (active === speechEmitted) return;
    speechEmitted = active;
    opts.onSpeechActive?.(active);
  }

  /** Provisional end-of-utterance transcription (EAGER_SILENCE_MS). Identity-
   * free lifecycle: `cancelled` kills it when speech resumes; `wanted` marks
   * that the utterance finalized before the transcript arrived. */
  type Eager = {
    id: number;
    cancelled: boolean;
    wanted: boolean;
    done: boolean;
    text: string | null;
    /** Set when the utterance finalized before the transcript arrived: the
     *  flush's echo-gated delivery (settleDelivery) — it owns the pending
     *  barge decision AND the onUtterance dispatch. */
    decide?: (text: string) => void;
  };
  let eager: Eager | null = null;

  function cancelEager(): void {
    if (!eager) return;
    eager.cancelled = true;
    inflight.delete(eager.id);
    eager = null;
  }

  function localTranscribe(audio: Float32Array): Promise<string> {
    // SenseVoice engine (260816): the local leg is a main-process sherpa call.
    // Errors resolve '' — the same shape as an empty Whisper result, so the
    // arbiter's cloud-wait / drop behavior applies unchanged.
    if (useSenseVoice) {
      return (opts.mainTranscribe as (audio: Float32Array) => Promise<string>)(audio).catch(
        () => '',
      );
    }
    const w = worker;
    if (!w) return Promise.resolve(''); // 'none' mode never calls this
    return new Promise((resolve) => {
      const id = nextId++;
      localWaiters.set(id, resolve);
      // With cloud STT racing, the arbiter still holds `audio` — transfer a
      // copy. Local-only keeps the old zero-copy transfer.
      const payload = opts.cloudTranscribe ? audio.slice() : audio;
      w.postMessage({ type: 'transcribe', id, audio: payload }, [payload.buffer]);
    });
  }

  // 260724: every utterance runs cloud (ElevenLabs Scribe) and local Whisper
  // in a bounded race — cloud wins on accuracy when it's fast, local caps the
  // added latency at CLOUD_STT_GRACE_MS. See sttArbiter.ts for the policy.
  // 260725 'none' mode: local is null, so the arbiter runs cloud-only with a
  // hard timeout; a failed pass drops the utterance and reports here, where
  // it edge-fires onCloudSttFailure once per call.
  let cloudFailureFired = false;
  const transcribe = createSttArbiter({
    local: useLocalModel ? localTranscribe : null,
    cloud: opts.cloudTranscribe ?? null,
    graceMs: CLOUD_STT_GRACE_MS,
    cloudTimeoutMs: CLOUD_ONLY_TIMEOUT_MS,
    onCloudFailure: () => {
      if (cloudFailureFired) return;
      cloudFailureFired = true;
      opts.onCloudSttFailure?.();
    },
  });

  function postTranscribe(frames: Float32Array[], cb: (text: string) => void): number {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const audio = new Float32Array(total);
    let off = 0;
    for (const f of frames) {
      audio.set(f, off);
      off += f.length;
    }
    const id = nextId++;
    inflight.set(id, cb);
    void transcribe(audio).then((text) => {
      const deliver = inflight.get(id);
      if (!deliver) return; // cancelled (cancelEager / discarded short utterance)
      inflight.delete(id);
      deliver(text);
    });
    return id;
  }

  function resetUtterance(): void {
    inSpeech = false;
    silenceMs = 0;
    speechMs = 0;
    utterance = [];
    cancelEager();
    // Abandoning an utterance that was still provisional (mute, teardown, a
    // hold transition) leaves playback ducked with nothing coming to un-duck
    // it. `settle` clears `suspect` before it calls in here, so its own abort
    // does not double-fire.
    if (suspect) {
      suspect.retracted = 'cancelled';
      suspect = null;
      opts.onBargeAbort?.('cancelled');
    }
    emitSpeech(false);
  }

  /**
   * Echo-gated delivery (260807): the one place that decides BOTH halves of a
   * finished transcript — whether a pending provisional barge commits, and
   * whether the text becomes a player utterance. Before the gate these were
   * decided at four call sites; the echo answer has to reach both or a
   * speaker-echo line would abort its barge and still get dispatched as the
   * player (or vice versa). `env` is sliced by the caller at flush time,
   * because the rolling contour keeps moving while transcription runs.
   *
   * `barge` is the provisional barge this utterance still carries, or null.
   * 261031: it commits only on a word the junk filter keeps AND with voice
   * after the duck; an utterance with no voice after its duck was her echo
   * and the room, so its text is not delivered either.
   */
  function settleDelivery(
    text: string,
    t0: number,
    t1: number,
    env: EnvSample[],
    barge: BargeVerdict | null,
  ): void {
    const finish = (echo: boolean): void => {
      // A barge whose wait ran out (or whose duck a newer barge took over) is
      // already decided: its words are delivered as an ordinary utterance.
      if (barge?.open) {
        barge.open = false;
        if (flushedBarge === barge) flushedBarge = null;
        const word = isBargeWord(text);
        if (word && !echo && barge.voiced) {
          holdBarged = true;
          opts.onBargeIn?.();
        } else {
          if (barge.voiced) learnFalseDuck(barge.trig); // transcribed, and not the player
          opts.onBargeAbort?.(echo && word ? 'echo' : barge.voiced ? 'no_word' : 'no_voice');
          // 261031: this text was just judged not to be the player stopping
          // her, so it is not sent to her as their turn either ("Thank you."
          // from a cough used to cut her and then arrive as the reply prompt).
          if (text) console.log(`[sei/voice] barge: dropped, not an interrupt — "${text.slice(0, 80)}"`);
          return;
        }
      }
      if (!text) return;
      if (echo) {
        console.log(`[sei/voice] echo-gate: dropped speaker echo — "${text.slice(0, 80)}"`);
        return;
      }
      if (barge && !barge.voiced) {
        console.log(`[sei/voice] barge: dropped, no voice after the duck — "${text.slice(0, 80)}"`);
        return;
      }
      // A barge decided without its transcript (its wait ran out, a newer duck
      // took it over, or the energy deadline gave up on the pass) arrives here
      // late. It is delivered as the player's turn, but only on the same terms
      // as a commit: a word the junk filter keeps, already echo-checked as a
      // barge above (her own words condemn from two tokens, not three).
      if (barge && !isBargeWord(text)) {
        console.log(`[sei/voice] barge: late transcript dropped, not a word — "${text.slice(0, 80)}"`);
        return;
      }
      opts.onUtterance(text, { t0, t1 });
    };
    const check = opts.echoCheck;
    if (!check || !text) {
      finish(false);
      return;
    }
    // A barge still open is judged as one (two-token minimum for her own
    // words, not three): its text decides whether her line is destroyed.
    const purpose = barge ? 'barge' : 'utterance';
    void Promise.resolve(check({ text, t0, t1, envelope: env, purpose })).then(
      finish,
      () => finish(false),
    );
  }

  function flushUtterance(): void {
    const pendingEager = eager;
    eager = null; // ownership transfers below; resetUtterance must not cancel it
    // The utterance ended before stage two could answer, so the real transcript
    // below decides the barge instead of a separate confirming pass. 261031:
    // read from the duck on, like stage two, so her echo in the pre-roll
    // cannot decide it (the player's first ~130 ms go with it; an utterance
    // this short is one or two words).
    const s = suspect;
    const barge = bargeOf(s);
    const frames = s ? utterance.slice(s.askFrom) : utterance;
    suspect = null;
    if (barge) flushedBarge = barge;
    // Utterance bounds + contour, snapshotted NOW: transcription runs after
    // the reset below, and the next utterance must not shift this one's window.
    const t1 = Date.now();
    const t0 = t1 - speechMsOf(frames) - 150;
    const env = envWindow(t0, t1);
    const deliver = (text: string): void => settleDelivery(text, t0, t1, env, barge);
    inSpeech = false;
    silenceMs = 0;
    speechMs = 0;
    utterance = [];
    emitSpeech(false);
    if (speechMsOf(frames) < MIN_UTTERANCE_MS) {
      if (pendingEager) {
        pendingEager.cancelled = true;
        inflight.delete(pendingEager.id);
      }
      // Too short to be a word at all, so it was a transient: un-duck.
      if (barge && s) {
        barge.open = false;
        flushedBarge = null;
        opts.onBargeAbort?.(barge.voiced ? 'no_word' : 'no_voice');
      }
      return;
    }
    // A barge whose confirming pass is out and has seen everything but this
    // silence run: its answer is this utterance's transcript.
    const silenceRun = Math.ceil(END_SILENCE_MS / ((FRAME_SIZE / SAMPLE_RATE) * 1000)) + 1;
    if (s && s.asked && s.askFrom + frames.length - s.askEnd <= silenceRun) {
      if (pendingEager) {
        pendingEager.cancelled = true;
        inflight.delete(pendingEager.id);
      }
      if (s.passText !== undefined) deliver(s.passText);
      else s.passWaiter = deliver;
      return;
    }
    if (pendingEager) {
      // The provisional pass already covers this utterance — the frames since
      // it fired are the silence run, which adds no words. Use it instead of
      // re-transcribing (its ~0.5–1s of Whisper work overlapped the wait).
      if (pendingEager.done) {
        deliver(pendingEager.text ?? '');
      } else {
        pendingEager.wanted = true;
        pendingEager.decide = deliver;
      }
      return;
    }
    postTranscribe(frames, deliver);
  }

  /** What settleDelivery needs to know about a still-open barge. */
  function bargeOf(s: Suspect | null): BargeVerdict | null {
    return s
      ? { voiced: s.voiced >= VOICE_MIN_FRAMES || s.burst, open: true, since: performance.now(), trig: s.trig }
      : null;
  }

  /** A duck that turned out not to be the player teaches the bar (261031):
   *  the level that tripped it is, by now, known to be the room or her echo,
   *  so the residue steps halfway to where that level would no longer duck.
   *  It decays back through the ordinary residue EMA (a few seconds). Without
   *  this a loud game re-ducked her the frame she resumed, every time: 20 s of
   *  her line stuttering forward a tenth of a second per duck in the replay. */
  function learnFalseDuck(trig: number): void {
    const target = trig / DUCK_RESIDUE_FACTOR;
    if (target > holdResidue) holdResidue += (target - holdResidue) * FALSE_DUCK_LEARN;
  }

  function speechMsOf(frames: Float32Array[]): number {
    const samples = frames.reduce((n, f) => n + f.length, 0);
    return (samples / SAMPLE_RATE) * 1000;
  }

  /** Stage two. Watches the frames after the duck for a voice, then fires one
   *  transcription over them, and lets the answer decide whether the companion
   *  actually stops. Runs once per frame of a provisional utterance. */
  function confirmBarge(rms: number): void {
    const s = suspect;
    if (!s) return;
    const settle = (real: boolean, why: BargeAbortReason = 'no_word'): void => {
      if (suspect !== s) return; // superseded (utterance ended, mute, teardown)
      suspect = null;
      if (real) {
        holdBarged = true;
        opts.onBargeIn?.();
        return;
      }
      // Not speech. Retract the duck and go back to listening under hold — the
      // frames collected are discarded rather than transcribed again, because
      // the pass that just ran already read them and found nothing.
      // Only a duck a transcription has looked at teaches the bar. A blip that
      // died on its own ('no_voice') says nothing about the room's steady
      // level, and learning from its peak would make a quiet player unable to
      // duck her after a few game hits.
      if (why === 'echo' || (why === 'no_word' && s.asked)) learnFalseDuck(s.trig);
      // A no-voice retraction resumes her mid-line, and the duck spent the
      // clip's grace window paused, so the residue never saw her echo: on
      // loud speakers every resumed frame re-ducked her (one frame of audio,
      // then a ~0.5 s pause, for a whole line). The resumed frames are her
      // echo again, so they get the short re-grace the next clip of a run
      // gets: the residue learns from them and the duck bar catches up.
      if (why === 'no_voice') {
        holdSince = performance.now();
        graceMs = BARGE_REGRACE_MS;
      }
      opts.onBargeAbort?.(why);
      resetUtterance();
    };

    s.post += 1;
    // The skip frame is not voice evidence (it still holds the tail of her
    // echo), and a short word like "stop" is often over inside it. No energy
    // test tells that word from her echo there (in the replay a player's word
    // on loud speakers and her own echo tail read the same), so a clean duck
    // is a burst: it gets its one pass even with nothing voiced after it, and
    // the pass decides. The word started in the trigger frame, so that is
    // where the pass reads from.
    if (s.post <= VOICE_SKIP_FRAMES && s.clean) {
      s.burst = true;
      s.askFrom = s.head;
    }
    const voicedFrame = s.post > VOICE_SKIP_FRAMES && rms >= s.voiceBar;
    if (voicedFrame) s.voiced += 1;
    if (voicedFrame && s.asked) s.voicedSinceAsk += 1;
    const counted = s.post - VOICE_SKIP_FRAMES;

    // 261030: a pass that came back with a word is waiting on the echo gate,
    // not on transcription, so it gets the gate's longer bound (see
    // BARGE_ECHO_WAIT_MAX_MS) instead of being decided on one frame's energy.
    const deadline = s.answered ? BARGE_ECHO_WAIT_MAX_MS : BARGE_SUSPECT_MAX_MS;
    if (performance.now() - s.since >= deadline) {
      // Transcription never answered. Decide on energy, over everything heard
      // since the duck (261031: it used to be the one frame that happened to
      // land on the deadline, which a single game hit could win).
      const real = counted > 0 && s.voiced / counted >= BARGE_DEADLINE_VOICED;
      // A pass still out is owed to the player: its answer, if it is a word,
      // arrives as an ordinary turn instead of being dropped with the duck.
      if (!real && s.asked && s.passText === undefined) s.retracted = 'late';
      settle(real);
      return;
    }
    // 261031: no voice after the duck = a blip, or her own onset. Retracted
    // here for free, before any transcription is paid for. A short burst
    // (see `burst`) is the exception: it is a word that has already ended.
    if (s.voiced < VOICE_MIN_FRAMES && !s.burst) {
      if (counted >= VOICE_WINDOW_FRAMES) settle(false, 'no_voice');
      return;
    }
    if (s.asked) return;
    // Only the audio from the duck on: the pre-roll before it is her echo,
    // which is what Whisper turned into the words that used to cut her off.
    // (A burst reads from the trigger frame: after a clean duck it was louder
    // than her echo has been, and a word's start is in it.)
    const heard = utterance.slice(s.askFrom);
    // A burst with nothing voiced after it is a word that has already ended:
    // it is read once the voice window closes on it, since a longer word
    // shows up there and needs no special case.
    const shortWord = s.voiced < VOICE_MIN_FRAMES;
    if (shortWord ? counted < VOICE_WINDOW_FRAMES : speechMsOf(heard) < BARGE_WORD_MS) return;
    s.asked = true;
    s.askEnd = utterance.length;
    s.voicedSinceAsk = 0;
    s.passText = undefined;
    const t1 = Date.now();
    const t0 = t1 - speechMsOf(heard) - 150;
    const env = envWindow(t0, t1);
    // Copied, because the utterance keeps growing while this runs and the
    // arbiter transfers what it is given.
    postTranscribe(
      heard.map((f) => f.slice()),
      (text) => {
        s.passText = text;
        if (suspect !== s) {
          const w = s.passWaiter;
          s.passWaiter = undefined;
          if (w) w(text);
          // The energy deadline retracted the duck before this answered, and
          // the player's word is still unheard: deliver it as an ordinary turn
          // through the same checks a commit would face (a closed barge).
          else if (s.retracted === 'late') {
            settleDelivery(text, t0, t1, env, { voiced: true, open: false, since: s.since, trig: s.trig });
          }
          return;
        }
        if (!isBargeWord(text)) {
          // 261031: the pass read the first ~400 ms after the duck. When the
          // player only started talking after that (a false duck was already
          // up, or they took a breath first), their words are in the audio
          // since, so a voice that kept going gets ONE more pass over it
          // instead of being thrown away with the duck.
          if (suspect === s && !s.reasked && s.voicedSinceAsk >= BARGE_REASK_VOICED) {
            s.reasked = true;
            s.asked = false;
            s.askFrom = s.askEnd;
            s.since = performance.now();
            return;
          }
          settle(false);
          return;
        }
        // A word came back — but WHOSE? Her own leaked line and the shared
        // screen's audio both transcribe to real words (260807), and both
        // used to commit here. The gate answers while she is already ducked,
        // so waiting on it costs the player nothing audible; `settle`'s
        // suspect guard handles the answer arriving stale.
        const check = opts.echoCheck;
        if (!check) {
          settle(true);
          return;
        }
        s.answered = true;
        void Promise.resolve(check({ text, t0, t1, envelope: env, purpose: 'barge' })).then(
          (echo) => settle(!echo, 'echo'),
          () => settle(true),
        );
      },
    );
  }

  function openSpeech(frameMs: number): void {
    inSpeech = true;
    speechMs = frameMs;
    silenceMs = 0;
    // Both call sites push the trigger frame into preRoll BEFORE opening, so
    // preRoll already ends with it — spreading it alone is the whole
    // utterance head. Re-pushing the trigger frame here (the pre-260725 bug)
    // duplicated the first ~128ms of audio, and Scribe faithfully
    // transcribed the stutter ("I, I want...", "我-我今天...").
    utterance = [...preRoll];
    preRoll.length = 0;
    emitSpeech(true);
  }

  captureNode.port.onmessage = (e: MessageEvent) => {
    const frame = e.data as Float32Array;
    if (!(frame instanceof Float32Array) || frame.length === 0) return;
    // Before the mute check: a barge whose utterance ended keeps her paused
    // until its transcript lands, and muting right after speaking must not
    // stretch that wait past its bound.
    if (flushedBarge && performance.now() - flushedBarge.since >= BARGE_ECHO_WAIT_MAX_MS) {
      flushedBarge.open = false;
      flushedBarge = null;
      opts.onBargeAbort?.('no_word');
    }
    if (muted) {
      if (inSpeech) resetUtterance();
      preRoll.length = 0;
      return;
    }
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const frameMs = (frame.length / SAMPLE_RATE) * 1000;

    // Echo-gate contour: 4 sub-windows per frame ≈ the gate's 32ms grid. The
    // frame's audio ENDS now; its sub-windows are stamped back across it.
    if (opts.echoCheck) {
      const now = Date.now();
      const sub = Math.max(1, frame.length >> 2);
      for (let i = 0; i < frame.length; i += sub) {
        const end = Math.min(frame.length, i + sub);
        let s2 = 0;
        for (let j = i; j < end; j += 1) s2 += frame[j] * frame[j];
        const t = now - frameMs + (end / frame.length) * frameMs;
        pushEnv(recentEnv, t, dbOf(Math.sqrt(s2 / (end - i))), ENV_KEEP_MS);
      }
    }

    // Barge-in (260705): while the companion is audible (hold), keep listening
    // at an ELEVATED threshold — echo cancellation strips most of the
    // companion's own voice, the stiffer bar rejects the residue. Real player
    // speech opens the utterance normally AND asks the owner to cut playback.
    // No noise-floor adaptation here: the echo residue must not poison it.
    if (hold && !inSpeech) {
      preRoll.push(frame.slice());
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      const inGrace = performance.now() - holdSince < graceMs;
      const levels = { noiseFloor, holdResidue, shareActive: opts.shareActive?.() === true };
      const bars = bargeBars(levels);
      const bar = bars.commit;
      if (rms > holdPeakRms) {
        holdPeakRms = rms;
        holdPeakBar = bar;
      }
      // Residue calibration: during the grace window EVERY frame is presumed
      // to be the clip's own echo (AEC hasn't converged; the player barging in
      // this early is indistinguishable anyway), so the EMA tracks it even
      // over the bar — that's how loud speakers teach the bar to rise. After
      // the window only below-bar frames adapt, so the player's own barge
      // speech can't inflate the bar against itself.
      if (inGrace || rms < bar) {
        const rate = rms > holdResidue ? RESIDUE_RISE : RESIDUE_DECAY;
        holdResidue = holdResidue * (1 - rate) + rms * rate;
      }
      // Grace window: for the first BARGE_GRACE_MS of a clip, ignore threshold
      // crossings — that early audio is almost always the clip's own onset
      // echoing back before AEC converges, not the player barging in.
      //
      // 260804: the grace applies only to the sustained-energy FALLBACK. Stage
      // one is allowed to duck during it, because a duck is reversible and the
      // window was itself a bug: for its first 600ms every clip was completely
      // uninterruptible, which on short lines is the whole clip. A false duck
      // caused by a clip's own onset is retracted a few hundred milliseconds
      // later by the transcription, and the player hears a wobble at worst.
      if (rms >= bars.duck) {
        duckRunMs += frameMs;
        if (duckRunMs >= DUCK_CONFIRM_MS) {
          duckRunMs = 0;
          bargeRunMs = 0;
          // Open the utterance for real: from here the normal in-speech path
          // below collects frames, and `suspect` is what marks the collection
          // as unconfirmed.
          // A barge still waiting on its transcript already holds the duck:
          // this one takes it over rather than ducking twice.
          const adopted = flushedBarge !== null;
          if (flushedBarge) {
            flushedBarge.open = false;
            flushedBarge = null;
          }
          openSpeech(frameMs);
          suspect = {
            since: performance.now(),
            asked: false,
            answered: false,
            head: utterance.length - 1,
            voiceBar: bargeVoiceBar(levels),
            trig: rms,
            clean: !inGrace,
            burst: false,
            post: 0,
            voiced: 0,
            // The frame after the trigger: the trigger itself still carries
            // her echo (the duck ramps over it).
            askFrom: utterance.length,
            askEnd: 0,
            voicedSinceAsk: 0,
            reasked: false,
          };
          if (!adopted) opts.onBargeSuspect?.();
          return;
        }
      } else {
        duckRunMs = 0;
      }
      // Sustained-energy fallback. It exists for the case transcription cannot
      // serve: no local model AND a cloud pass that is slow or failing. Slower
      // and stiffer than the duck by design — see BARGE_CONFIRM_MS.
      const overBar = rms >= bar && !inGrace;
      if (overBar) {
        bargeRunMs += frameMs;
        if (bargeRunMs >= BARGE_CONFIRM_MS) {
          bargeRunMs = 0;
          duckRunMs = 0;
          suspect = null;
          holdBarged = true;
          openSpeech(frameMs);
          opts.onBargeIn?.();
        }
      } else {
        bargeRunMs = 0;
      }
      return;
    }

    if (!inSpeech) {
      // Adapt the noise floor only outside speech so talking doesn't raise it.
      noiseFloor = noiseFloor * (1 - NOISE_ADAPT) + rms * NOISE_ADAPT;
      const threshold = Math.max(START_RMS_FLOOR, noiseFloor * START_FACTOR);
      preRoll.push(frame.slice());
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      if (rms >= threshold) openSpeech(frameMs);
      return;
    }

    utterance.push(frame.slice());
    speechMs += frameMs;
    if (suspect) confirmBarge(rms);
    const endThreshold = Math.max(START_RMS_FLOOR * 0.7, noiseFloor * 2);
    if (rms < endThreshold) {
      silenceMs += frameMs;
      // Provisional transcription: overlap Whisper with the rest of the
      // silence wait (see EAGER_SILENCE_MS). One per silence run.
      // Not while a barge is still provisional (261031): stage two owns that
      // utterance's transcription, and a quiet run right after a duck is
      // usually the blip ending, which costs nothing to retract.
      if (
        silenceMs >= EAGER_SILENCE_MS &&
        !eager &&
        !suspect &&
        speechMsOf(utterance) >= MIN_UTTERANCE_MS
      ) {
        const e: Eager = { id: 0, cancelled: false, wanted: false, done: false, text: null };
        e.id = postTranscribe(utterance, (text) => {
          if (e.cancelled) return;
          e.done = true;
          e.text = text;
          if (e.wanted) {
            e.decide?.(text); // settleDelivery: barge decision + gated dispatch
            return;
          }
          // 260724 latency: the transcript landed while the end-of-utterance
          // silence run is STILL open (Whisper beat the remaining
          // END_SILENCE_MS wait — common on short utterances). The silence
          // frames since the eager fire add no words, so this IS the final
          // transcript: deliver now instead of sitting on it until the VAD
          // closes, saving up to END_SILENCE_MS - EAGER_SILENCE_MS (~350ms).
          // `eager === e` proves the silence run is unbroken (any resumed
          // speech cancels the eager pass). Trade-off: if the player resumes
          // speaking after this early close, their words open a NEW utterance
          // where they previously merged into one — only reachable via a
          // 250-600ms mid-sentence pause combined with a transcription faster
          // than the pause's remainder (local-worker modes only; a cloud
          // round-trip never beats it), and the brain handles back-to-back
          // messages fine.
          if (eager === e && inSpeech) {
            eager = null; // consumed — resetUtterance's cancelEager is a no-op
            const t1 = Date.now();
            const t0 = t1 - speechMsOf(utterance) - 150;
            const env = envWindow(t0, t1);
            // Still provisional: this transcript is the best evidence there
            // is, so the echo-gated delivery decides the barge on it. Suspect
            // is taken over BEFORE resetUtterance so its abort doesn't un-duck
            // a genuine interruption first.
            const barge = bargeOf(suspect);
            suspect = null;
            resetUtterance();
            settleDelivery(text, t0, t1, env, barge);
          }
        });
        eager = e;
      }
    } else {
      silenceMs = 0;
      cancelEager(); // speech resumed — the provisional pass is stale
    }
    if (silenceMs >= END_SILENCE_MS || speechMs >= MAX_UTTERANCE_MS) {
      flushUtterance();
    }
  };

  source.connect(captureNode);
  // Keep the node pulled by the rendered graph via a zero-gain sink so capture
  // never stalls, and nothing echoes to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  captureNode.connect(sink);
  sink.connect(ctx.destination);

  return {
    setMuted(m) {
      muted = m;
      if (m && inSpeech) resetUtterance();
    },
    setHold(h) {
      // Hold going up mid-speech no longer kills the utterance: with barge-in
      // the common case is the player already talking when the companion's
      // next queued clip starts — their words must survive it.
      //
      // 260730: this no longer arms the grace window or resets the run. A slot
      // takes the playhead before its audio exists (a streamed clip's whole
      // synthesis round trip, and since the `blob` reservation every short
      // clip's too), so arming here spent the window on silence and then
      // armBargeGrace spent a second one on the audio. Both together, once per
      // line of a reply, is what made a multi-line reply uninterruptible. The
      // stiffer BAR still applies from here — that part is the point of the
      // slot-level hold (a noise in the synthesis gap must not trip the much
      // lower normal speech threshold).
      if (h && !hold) {
        holdPeakRms = 0;
        holdPeakBar = 0;
        holdBarged = false;
      }
      if (!h && hold && holdPeakRms > 0) {
        // One line per companion turn: what the mic heard while she had the
        // floor, versus what it had to clear. See holdPeakRms.
        console.log(
          `[sei/voice] barge ${holdBarged ? 'FIRED' : 'none'} — peak ${holdPeakRms.toFixed(3)} ` +
            `vs bar ${holdPeakBar.toFixed(3)} (residue ${holdResidue.toFixed(3)}, floor ${noiseFloor.toFixed(3)})`,
        );
      }
      if (!h) holdRunArmed = false; // playback stopped: the next run starts cold
      // 261031: the pre-roll collected under hold is her voice, so it must not
      // become the head of the next utterance (a game hit just after her line
      // ended opened one, and its pre-roll transcribed to "Okay.").
      if (!h && hold && !inSpeech) preRoll.length = 0;
      // The duck run belongs to the hold it opened in (260804), so any hold
      // transition drops it. `suspect` deliberately survives: resetUtterance
      // owns retracting a duck, and it un-ducks as it goes.
      duckRunMs = 0;
      hold = h;
    },
    armBargeGrace() {
      // Real audio just started. The first clip of a run gets the full window
      // (AEC is converging on it); the rest of the run gets the short one.
      graceMs = holdRunArmed ? BARGE_REGRACE_MS : BARGE_GRACE_MS;
      holdRunArmed = true;
      holdSince = performance.now();
      bargeRunMs = 0;
      duckRunMs = 0;
      // 261031: an utterance that opened before her audio (a game hit in the
      // gap, or the player already talking) would collect her voice from here
      // on, and a second of her echo transcribes to "Okay." / "Yeah.", which
      // is under the echo gate's minimum and was sent to her as the player's
      // turn. End it at her onset: what came before is transcribed as usual,
      // and a player who keeps talking is a barge from here, decided on the
      // audio after the duck like any other.
      if (inSpeech && !suspect) flushUtterance();
    },
    speechActive: () => inSpeech,
    stop() {
      emitSpeech(false);
      try { captureNode.port.onmessage = null; } catch { /* torn down */ }
      try { captureNode.disconnect(); source.disconnect(); sink.disconnect(); } catch { /* torn down */ }
      void ctx.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
      worker?.terminate();
      inflight.clear();
      localWaiters.clear();
    },
  };
}
