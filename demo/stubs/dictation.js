// Demo stub for src/renderer/src/lib/voice/dictation.ts.
//
// The real createDictation() opens the microphone and boots a local Whisper
// worker — neither is available (or wanted) in the headless scripted demo, and
// the real one throwing would flip the call to an error state. This no-op
// Dictation lets useVoiceStore.startCall() proceed straight to a live call; the
// demo never speaks, so the utterance / barge-in callbacks simply stay dormant.
export async function createDictation() {
  return {
    setMuted() {},
    setHold() {},
    speechActive() {
      return false;
    },
    stop() {},
  };
}
