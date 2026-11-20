# Kokoro local voice

Kokoro-82M is one of the two on-device voice models for local (own key) mode,
next to the original voice packs, which the UI calls **Fast**. It came in with
issue #47 / PR #49 and uses the existing `sherpa-onnx-node` runtime and speech
pack downloader. No new npm dependency, service or bundled weights.

## Setting

Settings > Voice: **Voices** = ElevenLabs | Local. Under Local, **Local voice**
= Fast | Kokoro.

| Key | Values | Absent means |
| --- | --- | --- |
| `tts_engine` | `elevenlabs`, `local` | `elevenlabs` |
| `local_tts_model` | `fast`, `kokoro` | `fast` |

Read through `localTtsModel()` in `src/shared/ttsEngine.ts`. Profiles from
before the key have no value and stay on Fast, so nobody is moved to Kokoro
without picking it. Cloud accounts ignore both keys. (The unreleased PR #49
preview wrote `local_tts_voice` and a third `tts_engine` value; neither
shipped. configStore keeps the stray `local_tts_voice` key as an unknown key
and nothing reads it.)

Picking Kokoro while its pack is missing opens the download confirm, and the
choice is saved once the pack is ready (same flow as SenseVoice). The Kokoro
pack row shows while Kokoro is chosen or while its pack is on disk, so it can
be uninstalled after switching back to Fast.

## Routing

`synthesizeLocalClip` in `src/main/voice/tts.ts`, per line:

| Language | Female | Male |
| --- | --- | --- |
| English | af_heart (speaker 3, speed 0.8) | am_michael (16) |
| Spanish | ef_dora (28) | em_alex (29) |
| French | ff_siwis (30) | Fast voices |
| Italian (mapped, no chat language yet) | if_sara (35) | im_nicola (36) |

Speaker ids follow the
[sherpa v1.0 table](https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/kokoro/v1.0/generate_voices_bin.py).
Any language or gender without a Kokoro voice (zh, ja, ko, French male) uses
the Fast voices with their installed-pack fallback.

Kokoro never leaves a companion silent: when its pack is missing, or it fails
to load or returns no audio, the line is spoken with the Fast voices and the
call shows a `kokoro-fallback` notice (`pack-missing` or `failed`). Only when
no Fast pack is installed either does the line fail, with
`VOICE_PACK_MISSING:tts-kokoro` so the notice names the Kokoro download. A
failed engine load is remembered for 60 s so a call does not reload a broken
model on every line. Companions with no voice stay silent.

The voice preview (Edit companion) goes through the same function, so it
plays Kokoro when Kokoro is chosen and Fast otherwise, with the pre-Kokoro
inputs: the chat language's sample line, and the picker's voice for a
companion that has none saved yet.

## Memory

One Kokoro engine per phonemizer language (en, es, fr, it), roughly 170 to
250 MB each. They are dropped when the user switches away from Kokoro (config
save), when the pack is uninstalled, and after 5 minutes without a Kokoro
line. sherpa-onnx-node has no explicit free: the native model goes when V8
collects the wrapper.

## Sentence delivery

Kokoro synthesizes slower than the Fast voices, so Kokoro calls reserve one
ordered WAV slot per sentence in the existing audio queue and call `voiceTts`
once per sentence (`src/renderer/src/lib/voice/sentenceTts.ts`). Sentence one
plays while sentence two is generating. The queue still owns pitch, captions,
echo references, supersession, mute, barge-in and hang-up. Native inference
already running cannot be preempted; interrupts discard late audio and stop
the remaining sentences.

## Pack and licenses

- Asset `kokoro-int8-multi-lang-v1_0.tar.bz2`, 132,353,410 bytes (126 MB),
  SHA-256 `72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653`,
  from the [sherpa-onnx tts-models release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models).
  Downloaded mirror first (`dl.sei.gg/speech/`), then the origin.
  The downloader checks the exact size and the bzip2 CRC.
- [Kokoro-82M by hexgrad](https://huggingface.co/hexgrad/Kokoro-82M): Apache-2.0
  weights; conversion and runtime by sherpa-onnx. The pack's espeak-ng data
  keeps its GPL-3.0-or-later notices.

## Live check

`src/main/speech/kokoro.live.test.ts` is opt-in: extract the archive under
`<isolated userData>/speech-models/tts-kokoro/`, add the `pack.json` marker
(see `packStore.ts`), then run it with `SEI_KOKORO_LIVE_DIR` set to that
userData. Never point it at a real profile.
