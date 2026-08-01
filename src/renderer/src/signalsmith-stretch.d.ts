/**
 * Types for `signalsmith-stretch` (MIT), the WASM/AudioWorklet build of the
 * Signalsmith Stretch pitch/time library. The package ships plain .js/.mjs with
 * no declarations, so the surface we use is declared here.
 *
 * Only the live-input half is typed: buffer playback (addBuffers / dropBuffers
 * / inputTime / loop points) exists in the library but has no caller here, and
 * an unused declaration is a claim nobody checks. Add it when something needs
 * it. See lib/voice/pitchBus.ts for the one consumer.
 */
declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    /** Context time for the change. The node compensates for its own latency,
     * so scheduling ahead only matters for a softer transition. */
    output?: number;
    /** Whether the node is processing audio at all. */
    active?: boolean;
    /** Pitch shift, in semitones. */
    semitones?: number;
    /** Tonality limit in Hz (library default 8000). */
    tonalityHz?: number;
    /** Shift the formants independently of the pitch. */
    formantSemitones?: number;
    /** Hold the formants where they are while the pitch moves. OFF gives the
     * timbre of a plain resample (see pitchBus.ts). */
    formantCompensation?: boolean;
    /** Rough fundamental for formant analysis (0 attempts pitch tracking). */
    formantBaseHz?: number;
  }

  export interface StretchConfig {
    /** STFT block length in ms. 0 or null falls back to `preset`. */
    blockMs?: number | null;
    /** Interval between blocks (default blockMs / 4). */
    intervalMs?: number;
    /** Spread computation more evenly across render quanta. */
    splitComputation?: boolean;
    preset?: 'default' | 'cheaper';
  }

  export interface StretchNode extends AudioNode {
    /** Begin processing. Nothing passes through until this is called. */
    start: (when?: number) => void;
    stop: (when?: number) => void;
    /** Apply a change, dropping any scheduled changes after it. */
    schedule: (opts: StretchSchedule) => void;
    /** Latency in seconds, in live-input mode. */
    latency: () => number;
    configure: (opts: StretchConfig) => void;
  }

  /** Resolves once the worklet is registered and the WASM is ready. */
  export default function SignalsmithStretch(
    context: BaseAudioContext,
    channelOptions?: {
      numberOfInputs?: number;
      numberOfOutputs?: number;
      outputChannelCount?: number[];
    },
  ): Promise<StretchNode>;
}
