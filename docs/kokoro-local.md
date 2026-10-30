# Optional Kokoro local voices

Implementation for [SEI issue #47](https://github.com/sei-studio/sei/issues/47)
and [PR #49](https://github.com/sei-studio/sei/pull/49), targeting `dev`.
Uses the existing `sherpa-onnx-node` runtime and speech pack downloader.
No new npm dependency, Python/Docker service, bundled weights or Android changes.

## Setup and routing

1. Use the **My key** backend and open Settings → Voice.
2. Select **Kokoro**, beside **ElevenLabs** and **Local**.
3. Download the Kokoro pack. Download standard local packs too if you need fallback.
4. Preview a companion voice or start a call.

`tts_engine: 'kokoro'` selects automatic language/gender matching for each line.
The companion's existing voice identity, own-voice gender hint and pitch remain
unchanged. Character language pins and SEI's text-script language handling apply.
Cloud accounts keep their existing route and ignore this engine preference.
Profiles from the first preview with Local + an explicit Kokoro preset are read
as Kokoro; changing the engine in Settings clears that legacy preset.
The old global preset dropdown is removed.

| Language | Female | Male |
| --- | --- | --- |
| English | af_heart (speaker 3, speed 0.8) | am_michael (16) |
| Spanish | ef_dora (28) | em_alex (29) |
| French | ff_siwis (30) | standard local fallback |
| Italian mapping | if_sara (35) | im_nicola (36) |

The speaker IDs follow the [sherpa v1.0 table](https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/kokoro/v1.0/generate_voices_bin.py).
Italian mappings are tested at the synthesis/helper boundary; SEI's current
conversation-language set does **not** include Italian. This PR does not expand
STT/chat-language support. Unlike the first preview, an old Sara selection no
longer forces Italian pronunciation over an English conversation.

No configured match (including zh, ja, ko and French male) uses the existing
standard local picker, with its installed-pack fallback and missing-pack notice.
A matching Kokoro voice with its pack missing raises `VOICE_PACK_MISSING:tts-kokoro`;
it never downloads automatically during a call or silently changes engines on a
runtime failure. Silent companions remain silent.

## Sentence delivery and interruption

Kokoro calls reserve one ordered WAV slot per sentence in the existing audio
queue. The renderer invokes the existing `voiceTts` IPC once per sentence;
synthesis is sequential across lines/companions within the call. Sentence one
can play while sentence two is generating. This is sentence-level delivery, not
sample-level PCM streaming or concatenated WAVs in the MPEG/MSE stream.

The queue still owns pitch, captions, echo references, turn supersession, stale
lines, mute/deafen, barge-in and hang-up. A Backseat confirmation is reported
heard only when every sentence completes audibly. Interrupts discard late audio
and prevent remaining sentences from being synthesized. Native inference already
running cannot be preempted; a new sentence waits for it to return. A long sentence
still needs its whole inference before playback, and audio can underrun if CPU
synthesis is slower than real time. No latency guarantee is made.

The public `voiceTtsStream` local compatibility path still returns one complete
WAV; Kokoro calls use the sentence queue instead of the MPEG stream API.

## Model and licenses

- Pack: `kokoro-int8-multi-lang-v1_0.tar.bz2`, 132,353,410 bytes (~126 MiB).
- [Origin](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models).
- Observed SHA-256: `72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653`.
  Downloader checks archive size and bzip2 CRC; SHA-256 is a validation check,
  not an additional runtime guarantee.
- Existing mirror-first downloader with origin fallback; no claim the SEI
  mirror already hosts this asset. Models live under
  `<userData>/speech-models/tts-kokoro/` and are never committed.
- Lazy async engines are cached per phonemizer language and shared by same-language
  voices. `enableExternalBuffer: false` preserves Electron's memory-cage constraint.
- SEI retains AGPL. [Kokoro-82M by hexgrad](https://huggingface.co/hexgrad/Kokoro-82M)
  weights are Apache-2.0; conversion/runtime are from sherpa-onnx.
  The pack's espeak-ng data retains GPL-3.0-or-later notices and corresponding
  source obligations. Extraction preserves the archive's regular notice files.

## Reproduce checks

```sh
npm ci --ignore-scripts
npm test -- src/main/speech src/main/voice/tts.test.ts src/main/voice/tts.kokoro.test.ts src/main/configStore.test.ts src/shared/ttsEngine.test.ts src/renderer/src/lib/voice/audioQueue.test.ts src/renderer/src/lib/voice/sentenceTts.test.ts src/renderer/src/screens/SettingsScreen.test.tsx --maxWorkers=2 --pool=threads
npm run typecheck
npm run build
```

For the opt-in native test, extract the archive beneath
`<isolated-test-userData>/speech-models/tts-kokoro/` and create the pack marker
as described in `packStore.ts`. Never point this test at production userData.
Set `SEI_KOKORO_LIVE_DIR` to that isolated directory and run
`npm test -- src/main/speech/kokoro.live.test.ts --maxWorkers=1 --pool=threads`.
It checks every mapped voice for nonempty, finite, non-silent 24 kHz PCM under
Node, not Electron. See `kokoro-validation.md` for actual results and limitations.
