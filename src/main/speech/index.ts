/**
 * Local speech (260816, china-compat W3+W4): sherpa-onnx TTS (en+zh, f+m) and
 * SenseVoice STT for LOCAL-mode users. ElevenLabs paths are untouched.
 *
 * ── Contract for the Settings/onboarding UI (W5/W6 — not built here) ────────
 *
 * Config (UserConfig, renderer-settable through saveConfig):
 *   tts_engine: 'elevenlabs' | 'local'      absent = 'elevenlabs'. Read only
 *     when ai_backend_kind === 'local'; cloud accounts ignore it.
 *   stt_engine: 'scribe' | 'whisper' | 'sensevoice'
 *     BYOK: 'sensevoice' turns dictation local-only through main-side
 *     SenseVoice (pack required). Cloud: the local-fallback model prefers
 *     SenseVoice when ui_language === 'zh' AND the pack is downloaded.
 *
 * IPC (see shared/ipc.ts `speech` namespace, zod-validated in main/ipc.ts):
 *   speech:pack-status    {} → { packs: Record<packId, {state, pct?, bytes}> }
 *     state: 'absent' | 'downloading' | 'ready'; bytes = archive size (what a
 *     download costs — show it in the "Download? (XX MB)" prompt).
 *   speech:pack-download  { packId } → resolves when ready; progress rides the
 *     speech:pack-state push (full PackStates snapshot per change).
 *   speech:pack-remove    { packId } → removes the pack from disk.
 *   speech:stt-transcribe { pcm: ArrayBuffer (Float32), sampleRate } →
 *     { text, language? } — SenseVoice, called by the dictation path.
 *
 * Typed errors the UI must map:
 *   VOICE_PACK_MISSING:<packId>   thrown by TTS synthesis and STT transcribe
 *     when the needed pack is not downloaded. Offer the download; NEVER
 *     auto-download mid-call.
 *   SPEECH_DOWNLOAD_FAILED: ...   pack download failed on every source.
 *   SPEECH_RUNTIME_FAILED: ...    sherpa-onnx runtime failed to load.
 *
 * Pack ids: 'tts-en' (~78 MB, both en voices), 'tts-zh-f' (~30 MB),
 * 'tts-zh-m' (~13 MB), 'stt-sensevoice' (~155 MB). Which packs a given
 * character needs: resolveLocalVoice(voiceId, language) → LOCAL_VOICE_SPEC.
 * Models live in <userData>/speech-models/<packId>/ (device-global).
 */
export { SPEECH_PACKS, SPEECH_PACK_IDS, isSpeechPackId, type SpeechPackId } from './packs';
export {
  packStatus,
  downloadPack,
  removePack,
  packReady,
  onPackStates,
  type PackState,
  type PackStates,
} from './packStore';
export {
  LOCAL_VOICE_SPEC,
  resolveLocalVoice,
  voiceGenderFor,
  localVoiceFor,
  type LocalVoiceId,
} from './localVoice';
export { synthesizeLocal, transcribeLocal, packMissingError } from './engine';
