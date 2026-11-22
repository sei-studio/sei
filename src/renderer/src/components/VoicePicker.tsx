/**
 * VoicePicker (260705, reworked 260720, tabs + playground 260725) â€” choose the
 * companion's speaking voice during creation and in Edit companion.
 *
 * Three selection states (see lib/voicePicker.ts):
 *   - Auto (default): metadata.voiceId stays unset; the runtime assigns a
 *     deterministic, roster-deduped pick from the curated pool on first use.
 *   - No voice: metadata.voiceId = 'none'; the companion is silent on calls.
 *   - A pinned pool voice, chosen from gender tabs (Feminine / Masculine /
 *     Neutral). Only the active tab's voices render.
 *
 * Layout (261120, product call 261120: "clean up these buttons ... too many
 * colors and fonts and subtexts"): the current voice is one row on top (play,
 * name) with a quiet "..." menu holding Auto and No voice, so a silent
 * companion is one deliberate step away instead of a big card. Below it a
 * quiet filter and one plain list, one muted line per row. The Voice Library
 * is one line at the bottom, then pitch and calmness. Every button is the
 * shared Button in its quiet kind; the accent marks the selected row only.
 *
 * Samples (260720, bundled-first): every curated-pool voice ships a
 * pre-generated sample mp3 per conversation language in the renderer's public
 * assets (voice-previews/), so pool rows play instantly, offline, with no
 * sign-in. The live TTS path (main-side disk cache + session Map here) is the
 * fallback for voice ids without a bundled file (the legacy "Current voice"
 * row), for a bundled asset that fails to load, and for a non-default CALMNESS
 * (the bundled clips are recorded at engine defaults). One sample plays at a
 * time; starting a second stops the first. When TTS is unavailable (signed out,
 * no dev key) bundled samples keep playing.
 *
 * Playground (260725): a "Tune the voice" panel with Pitch and Calmness
 * (ElevenLabs stability) sliders.
 *
 * 260731: pitch is applied locally at playback (lib/voice/pitchBus.ts) and no
 * longer reaches synthesis, so it no longer forces a live TTS fetch â€” a
 * pitch-only tune previews from the BUNDLED clip through the shifter: instant,
 * offline, no sign-in, no spend. Only calmness still changes the bytes.
 *
 * 261019: "Your ElevenLabs voices". When main has an ElevenLabs key
 * (resolveOwnVoiceKey: a stored key on either AI backend since 261020, or
 * the SEI_TTS_DEV_KEY env in dev shells), it lists the voices in the
 * user's own account (cloned, designed, saved from the Voice Library) and
 * they get their own tab. A pick reports its OwnVoicePick through onChange so
 * the save site stamps the metadata.voiceOwn marker. Samples are ElevenLabs'
 * own preview clips, fetched in main. A key refusal or a network failure is
 * one quiet line; the built-in list is never affected. While the key route is
 * active on the LOCAL backend the pool tabs say that Sei's voices need a paid
 * ElevenLabs plan through the key (ElevenLabs does not serve library voices
 * over the API to free plans). On Sei Cloud the pool stays on the proxy.
 *
 * 261020 (T158): with no key saved, on either backend, one line points to
 * the key field in Settings. Text only: the picker sits inside creation and
 * Edit companion, and jumping to Settings would drop unsaved edits.
 *
 * 261119: a "Browse the Voice Library" link (voiceLibraryTile in
 * lib/voicePicker.ts) opens the library in the browser for players who want
 * to choose a voice themselves. A voice they save to their ElevenLabs account
 * comes back through the own-voice list above, so on their own key the link
 * shows only when a key is saved and its list was read, or (no key yet) in
 * place of the add-your-key line, whose instruction its short note carries.
 * On Sei cloud it sits beside the paste field with no note. Click event:
 * voice_library_opened {surface, key, backend} (shape only).
 *
 * 261119, Sei cloud: "Use a voice from the library". A cloud user pastes a
 * Voice Library link or voice id; main asks the proxy
 * (voiceLibraryLookup: name, labels, preview), the play button plays
 * ElevenLabs' preview clip, and "Use this voice" asks the proxy to add it
 * (voiceLibraryAdd, which validates again) before reporting the pick with
 * `source: 'library'`, which the save site stores as metadata.voiceLibrary.
 * A rejection is one line of reason copy (libraryReasonCopy). A stored
 * library voice shows as the current voice; when the proxy says it is
 * gone, that row says a similar Sei voice speaks for them (the runtime's
 * stand-in). Events (shape only, no voice names): library_voice_rejected
 * {reason, stage}, library_voice_add_attempted, library_voice_added
 * {already}, library_voice_unavailable_shown, all with {surface}.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import type { LibraryVoiceInfo, LibraryVoiceReason, OwnVoiceList, VoiceInfo } from '@shared/ipc';
import {
  groupVoices,
  reduceSelection,
  isUnlistedVoice,
  assetPathFor,
  normalizeVoiceParams,
  ownVoicePickFor,
  ownVoiceCategoryLabel,
  ownVoiceDetail,
  ownVoicesView,
  poolUsesOwnKey,
  voiceLibraryTile,
  libraryPasteShown,
  libraryReasonCopy,
  libraryVoiceDetail,
  libraryVoicePick,
  ELEVEN_VOICE_LIBRARY_URL,
  defaultVoiceTab,
  OWN_TAB_KEY,
  PITCH_DEFAULT,
  CALMNESS_DEFAULT,
  NO_VOICE_ID,
  type OwnVoicePick,
  type VoiceParams,
  type VoiceTabKey,
} from '../lib/voicePicker';
import { attach as attachPitch, warm as warmPitchBus, whenReady as pitchReady } from '../lib/voice/pitchBus';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useT } from '../lib/i18n';
import { DotsIcon, PlayIcon, StopIcon } from './icons';
import { Button } from './Button';
import { clipMimeType } from '../lib/fishVoice';
import styles from './VoicePicker.module.css';
import { userChatLanguage } from '@shared/chatLanguage';

/** The paste card's state (261119). */
type LibraryPasteState =
  | { kind: 'idle' }
  | { kind: 'looking' }
  | { kind: 'found'; voice: LibraryVoiceInfo }
  | { kind: 'adding'; voice: LibraryVoiceInfo }
  | { kind: 'rejected'; reason: LibraryVoiceReason };

export interface VoicePickerProps {
  /** Selected pool voice id, NO_VOICE_ID ('none') for silent, or null for Auto. */
  value: string | null;
  /**
   * `own` is the marker to persist for a pick from "Your ElevenLabs voices"
   * (261019); null for every other selection. Save sites hand both to
   * applyVoicePick (shared/voiceIds.ts).
   */
  onChange: (voiceId: string | null, own: OwnVoicePick | null) => void;
  /** The stored own-voice marker for `value` (metadata.voiceOwn), so the
   * "Current voice" row can name it when the own list cannot be read. */
  valueOwn?: OwnVoicePick | null;
  /** Playground params; absent key = engine default (see lib/voicePicker.ts). */
  params: VoiceParams;
  /** Receives NORMALIZED params (default-valued keys already dropped). */
  onParamsChange: (params: VoiceParams) => void;
  /**
   * W5 (260817, china-compat): the user runs local TTS (BYOK backend with
   * tts_engine 'local'). The ElevenLabs voice list, previews and the Calmness
   * slider (an ElevenLabs synthesis param) are HIDDEN â€” only Pitch renders,
   * since it applies locally through the pitch bus. The character's stored
   * ElevenLabs voiceId is left untouched underneath: `value` is never changed
   * from this mode, so cloud characters and a later engine switch keep it.
   */
  localTtsMode?: boolean;
  /**
   * 261103: the companion speaks with a Fish Audio voice the user picked,
   * which plays without the pitch shift. The pitch sample plays at 1 and the
   * slider says why.
   */
  pitchBypassed?: boolean;
  /**
   * Local TTS (260915): the companion whose local voice the pitch sample
   * should use (Edit companion passes its id; the creation flow has none yet).
   * main resolves gender from the companion exactly like a live call line, so
   * the sample is the voice the player will actually hear, at the slider's
   * pitch. Ignored outside localTtsMode.
   */
  previewCharacterId?: string;
  /** Where the picker sits, for the Voice Library click event (261119). */
  surface?: 'create' | 'edit';
}

export function VoicePicker({
  value,
  onChange,
  params,
  onParamsChange,
  localTtsMode = false,
  pitchBypassed = false,
  previewCharacterId,
  valueOwn = null,
  surface,
}: VoicePickerProps): React.ReactElement {
  const t = useT();
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  /** The user's own ElevenLabs voices (261019); null = loading / not asked. */
  const [ownList, setOwnList] = useState<OwnVoiceList | null>(null);
  const [ownRefreshing, setOwnRefreshing] = useState(false);
  const ownVoices = ownList?.status === 'ok' ? ownList.voices : [];
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** null = probing; false disables sample playback with the quiet hint. */
  const [samplesAvailable, setSamplesAvailable] = useState<boolean | null>(null);
  /** User-chosen tab; null = derive from the selection (else Feminine). */
  const [chosenTab, setChosenTab] = useState<VoiceTabKey | null>(null);

  // Non-reactive playback internals.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** Tears the playing clip out of the pitch bus (null when unshifted). */
  const detachRef = useRef<(() => void) | null>(null);
  const cacheRef = useRef<Map<string, ArrayBuffer>>(new Map());
  const aliveRef = useRef(true);
  /** Conversation language for bundled samples; 'en' until the config loads. */
  const langRef = useRef('en');
  const sliderIdBase = useId();

  // Local backend with no ElevenLabs key (260907): the curated pool and the
  // Auto assignment resolve to ElevenLabs voices, and neither the cloud proxy
  // (no session) nor ElevenLabs (no key) can synthesize them, so a picked or
  // auto-assigned voice is silent on calls. Warn on the picker itself rather
  // than letting the companion go mute. null = probing (no warning yet).
  const aiBackendKind = useCreditsStore((s) => s.ai_backend_kind);
  const [hasElevenKey, setHasElevenKey] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void sei
      .voiceElevenKeyStatus()
      .then(({ present }) => {
        if (alive) setHasElevenKey(present);
      })
      .catch(() => {
        /* leave null â€” never warn on an unknown state */
      });
    return () => {
      alive = false;
    };
  }, []);
  const cloudVoicesUnavailable =
    !localTtsMode && aiBackendKind === 'local' && hasElevenKey === false;

  // â”€â”€ Voice Library paste card (261119, Sei cloud) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const libraryPaste = libraryPasteShown(aiBackendKind, localTtsMode);
  const [libInput, setLibInput] = useState('');
  const [libState, setLibState] = useState<LibraryPasteState>({ kind: 'idle' });
  /** Voices looked up this session: preview clips + labels. */
  const [libVoices, setLibVoices] = useState<LibraryVoiceInfo[]>([]);
  /** The stored library voice's state on the proxy (null = not asked). */
  const [libStatus, setLibStatus] = useState<'active' | 'removed' | null>(null);
  const valueLibrary = valueOwn?.source === 'library' && value ? value : null;
  useEffect(() => {
    setLibStatus(null);
    if (!valueLibrary || !libraryPaste) return;
    let alive = true;
    try {
      void sei
        .voiceLibraryStatus({ voiceId: valueLibrary })
        .then((r) => {
          if (!alive) return;
          if (r.status === 'removed') {
            setLibStatus('removed');
            trackLibrary('library_voice_unavailable_shown', {});
          } else if (r.status === 'active') {
            setLibStatus('active');
          }
        })
        .catch(() => {});
    } catch {
      /* stale preload without the channel: no status line */
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueLibrary, libraryPaste]);

  function trackLibrary(event: string, props: Record<string, string | boolean>): void {
    try {
      sei.track(event, { surface: surface ?? 'other', ...props });
    } catch {
      /* analytics must never break the picker */
    }
  }

  function rememberLibraryVoice(v: LibraryVoiceInfo): void {
    setLibVoices((prev) => [v, ...prev.filter((x) => x.voiceId !== v.voiceId)].slice(0, 20));
  }

  async function lookupLibrary(raw?: string): Promise<void> {
    const input = (raw ?? libInput).trim();
    if (!input || libState.kind === 'looking' || libState.kind === 'adding') return;
    setLibState({ kind: 'looking' });
    let r: Awaited<ReturnType<typeof sei.voiceLibraryLookup>>;
    try {
      r = await sei.voiceLibraryLookup({ input });
    } catch {
      r = { ok: false, reason: 'unavailable' };
    }
    if (!aliveRef.current) return;
    if (r.ok) {
      rememberLibraryVoice(r.voice);
      setLibState({ kind: 'found', voice: r.voice });
    } else {
      setLibState({ kind: 'rejected', reason: r.reason });
      trackLibrary('library_voice_rejected', { reason: r.reason, stage: 'lookup' });
    }
  }

  async function pickLibraryVoice(voice: LibraryVoiceInfo): Promise<void> {
    if (libState.kind === 'adding') return;
    trackLibrary('library_voice_add_attempted', {});
    setLibState({ kind: 'adding', voice });
    let r: Awaited<ReturnType<typeof sei.voiceLibraryAdd>>;
    try {
      r = await sei.voiceLibraryAdd({ input: voice.voiceId });
    } catch {
      r = { ok: false, reason: 'unavailable' };
    }
    if (!aliveRef.current) return;
    if (r.ok) {
      trackLibrary('library_voice_added', { already: r.already });
      rememberLibraryVoice(r.voice);
      onChange(r.voice.voiceId, libraryVoicePick(r.voice));
      setLibInput('');
      setLibState({ kind: 'idle' });
    } else {
      trackLibrary('library_voice_rejected', { reason: r.reason, stage: 'add' });
      setLibState({ kind: 'rejected', reason: r.reason });
    }
  }

  useEffect(() => {
    // Re-arm on every (re)mount â€” StrictMode dev runs mount â†’ cleanup â†’ mount
    // on the SAME instance, and the ref keeps its false from the first cleanup.
    aliveRef.current = true;
    // Build the pitch shifter while the player is still reading the voice list,
    // so the first sample they play is already shifted (see toggleSample).
    // 260915: warmed in local-TTS mode as well â€” its pitch sample (the only
    // way to hear the slider without a call) plays through the same bus.
    warmPitchBus();
    // Local-TTS mode renders only the pitch slider plus its sample â€” no voice
    // list to load, no ElevenLabs samples to probe.
    if (localTtsMode) return;
    void sei
      .voiceListVoices()
      .then((v) => {
        if (aliveRef.current) setVoices(v);
      })
      .catch(() => {
        if (aliveRef.current) setError(t('Could not load the voice list.'));
      });
    // Own ElevenLabs voices (261019). Separate from the pool on purpose: any
    // failure here only changes the own-voice hint, never the built-in list.
    loadOwnVoices(false);
    // Conversation language, for picking the bundled sample file. Best-effort:
    // a failed read leaves English, which always exists.
    void sei
      .getConfig()
      .then((c) => {
        langRef.current = userChatLanguage(c);
      })
      .catch(() => {
        /* keep 'en' */
      });
    // Probe sample availability (live-TTS fallback rows only); a failed or
    // missing probe leaves samples enabled and the first play surfaces the
    // real state reactively.
    try {
      void sei
        .voicePreviewAvailable()
        .then((ok) => {
          if (aliveRef.current) setSamplesAvailable(ok);
        })
        .catch(() => {
          if (aliveRef.current) setSamplesAvailable(true);
        });
    } catch {
      setSamplesAvailable(true); // stale preload without the probe â€” stay permissive
    }
    return () => {
      aliveRef.current = false;
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadOwnVoices(refresh: boolean): void {
    if (refresh) setOwnRefreshing(true);
    try {
      void sei
        .voiceListOwnVoices({ refresh })
        .then((list) => {
          if (aliveRef.current) setOwnList(list);
        })
        .catch(() => {
          if (aliveRef.current) setOwnList({ status: 'error', voices: [] });
        })
        .finally(() => {
          if (aliveRef.current) setOwnRefreshing(false);
        });
    } catch {
      // Stale preload without the channel: behave as before (no own tab).
      setOwnRefreshing(false);
    }
  }

  function stopPlayback(): void {
    const el = audioRef.current;
    if (el) {
      try {
        el.pause();
        URL.revokeObjectURL(el.src);
      } catch {
        /* already torn down */
      }
      detachRef.current?.();
      detachRef.current = null;
      audioRef.current = null;
    }
    setPlayingId(null);
  }

  // â”€â”€ Playground params (effective values; absent key = engine default) â”€â”€â”€â”€
  const pitch = params.pitch ?? PITCH_DEFAULT;
  const calmness = params.calmness ?? CALMNESS_DEFAULT;
  /** Whether the SYNTHESIS differs from the bundled clips. Pitch is not part of
   * this any more (260731): it is a playback effect, so a pitch-only tune can
   * still preview from the bundled asset. */
  const tuned = calmness !== CALMNESS_DEFAULT;
  /** The playground needs a concrete voice â€” Auto / No voice can't preview.
   * Local-TTS mode is always tunable: pitch applies to whatever local voice
   * the runtime maps, independent of the (hidden) ElevenLabs selection. */
  const tunable = localTtsMode || (value !== null && value !== NO_VOICE_ID);

  /**
   * Start playback of `url` shifted to `rate` (1 = as recorded), through the
   * same pitch bus live calls use, so the sample is exactly what the player
   * will hear. Resolves true once playback starts, false when the source fails
   * to load or play, so callers can fall back.
   */
  function startAudio(url: string, voiceId: string, rate: number): Promise<boolean> {
    return new Promise((resolve) => {
      const el = new Audio(url);
      const detachPitch = attachPitch(el, rate);
      audioRef.current = el;
      detachRef.current = detachPitch;
      el.addEventListener(
        'ended',
        () => {
          if (audioRef.current === el) stopPlayback();
        },
        { once: true },
      );
      el.addEventListener(
        'error',
        () => {
          if (audioRef.current === el) stopPlayback();
          resolve(false);
        },
        { once: true },
      );
      setPlayingId(voiceId);
      void el.play().then(
        () => resolve(true),
        () => {
          if (audioRef.current === el) stopPlayback();
          resolve(false);
        },
      );
    });
  }

  /** An own ElevenLabs voice at default calmness: ElevenLabs' own preview
   * clip, fetched by main (it falls back to synthesizing the sample line
   * through the key when the voice has no preview). Session-cached. */
  async function playOwnPreview(voiceId: string): Promise<void> {
    const key = `own|${voiceId}`;
    let buf = cacheRef.current.get(key);
    if (!buf) {
      setLoadingId(voiceId);
      buf = await sei.voiceOwnPreview({ voiceId });
      cacheRef.current.set(key, buf);
    }
    if (!aliveRef.current) return;
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    await startAudio(url, voiceId, pitch);
  }

  /** A looked-up Voice Library voice at default calmness: ElevenLabs'
   * preview clip, fetched by main (261119). Session-cached. */
  async function playLibraryPreview(voiceId: string): Promise<void> {
    const key = `lib|${voiceId}`;
    let buf = cacheRef.current.get(key);
    if (!buf) {
      setLoadingId(voiceId);
      buf = await sei.voiceLibraryPreview({ voiceId });
      cacheRef.current.set(key, buf);
    }
    if (!aliveRef.current) return;
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    await startAudio(url, voiceId, pitch);
  }

  /** Live TTS preview with the current params, session-cached per combo. Pitch
   * is not part of the key: it does not change the bytes any more, only how
   * they are played back. */
  async function playTts(voiceId: string): Promise<void> {
    const key = `${voiceId}|${calmness}`;
    let buf = cacheRef.current.get(key);
    if (!buf) {
      setLoadingId(voiceId);
      buf = await sei.voicePreview({ voiceId, calmness });
      cacheRef.current.set(key, buf);
    }
    if (!aliveRef.current) return;
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    await startAudio(url, voiceId, pitch);
  }

  async function toggleSample(voiceId: string): Promise<void> {
    if (playingId === voiceId) {
      stopPlayback();
      return;
    }
    // One sample at a time: starting a new one stops whatever is playing.
    stopPlayback();
    setError(null);
    try {
      // Unlike a call, a sample CAN wait for the shifter: the whole point of
      // pressing play here is to hear the slider, so a sample that starts
      // 200ms later is better than one that ignores it. Bounded, and a false
      // just means the sample plays at its recorded pitch.
      if (pitch !== PITCH_DEFAULT) await pitchReady();
      if (!aliveRef.current) return;
      if (!tuned && voices.some((v) => v.id === voiceId)) {
        // Pool voice at default calmness: bundled sample asset â€” instant,
        // offline, no sign-in, shifted locally to the chosen pitch. A load/play
        // failure falls through to live TTS.
        const ok = await startAudio(assetPathFor(voiceId, langRef.current), voiceId, pitch);
        if (ok || !aliveRef.current) return;
      }
      if (!tuned && ownVoices.some((v) => v.id === voiceId)) {
        await playOwnPreview(voiceId);
        return;
      }
      if (!tuned && libVoices.some((v) => v.voiceId === voiceId && v.hasPreview)) {
        await playLibraryPreview(voiceId);
        return;
      }
      await playTts(voiceId);
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = String((err as Error)?.message ?? '');
      if (/VOICE_NO_SESSION/.test(msg)) {
        setSamplesAvailable(false);
      } else if (/VOICE_LIBRARY_UNAVAILABLE/.test(msg)) {
        setError(t('This voice is no longer available.'));
      } else if (/VOICE_NEEDS_PAID_PLAN/.test(msg)) {
        setError(t('Free ElevenLabs plans cannot play this voice through your key. Pick one of your own voices.'));
      } else if (/VOICE_ELEVEN_QUOTA/.test(msg)) {
        setError(t('Your ElevenLabs account is out of credits.'));
      } else if (/VOICE_ELEVEN_KEY_INVALID/.test(msg)) {
        setError(t('ElevenLabs rejected your key. Check it in Playtime.'));
      } else {
        setError(t('Sample unavailable right now.'));
      }
    } finally {
      if (aliveRef.current) setLoadingId(null);
    }
  }

  const samplesOff = samplesAvailable === false;

  /** Sentinel id for the local-TTS pitch sample in playingId / loadingId. */
  const LOCAL_SAMPLE_ID = '__local-sample__';

  /**
   * Local TTS (260915): play the companion's LOCAL voice saying the preview
   * line, shifted to the slider. Before this the slider had no sample in
   * local mode (the ElevenLabs list and its play buttons are hidden), so a
   * player dragging it heard nothing until the next call line and read the
   * slider as broken. Synthesis is ~100 ms on the local pack; the shifter is
   * awaited (bounded) so the sample never plays at the wrong pitch.
   */
  async function toggleLocalSample(): Promise<void> {
    if (playingId === LOCAL_SAMPLE_ID) {
      stopPlayback();
      return;
    }
    stopPlayback();
    setError(null);
    setLoadingId(LOCAL_SAMPLE_ID);
    try {
      const samplePitch = pitchBypassed ? PITCH_DEFAULT : pitch;
      if (samplePitch !== PITCH_DEFAULT) await pitchReady();
      if (!aliveRef.current) return;
      const buf = await sei.voicePreview({
        ...(value !== null && value !== NO_VOICE_ID ? { voiceId: value } : {}),
        ...(previewCharacterId ? { characterId: previewCharacterId } : {}),
      });
      if (!aliveRef.current) return;
      // WAV from the local packs, mp3 from Fish Audio (261103).
      const url = URL.createObjectURL(new Blob([buf], { type: clipMimeType(buf) }));
      const ok = await startAudio(url, LOCAL_SAMPLE_ID, samplePitch);
      if (!ok && aliveRef.current) setError(t('Sample unavailable right now.'));
    } catch (err) {
      if (!aliveRef.current) return;
      const msg = String((err as Error)?.message ?? '');
      if (/VOICE_PACK_MISSING/.test(msg)) {
        setError(t('Download a voice pack in Playtime to hear a sample.'));
      } else if (/SPEECH_RUNTIME_FAILED/.test(msg)) {
        setError(t('Local speech cannot run on this install.'));
      } else {
        setError(t('Sample unavailable right now.'));
      }
    } finally {
      if (aliveRef.current) setLoadingId(null);
    }
  }

  function setPitchParam(next: number): void {
    onParamsChange(normalizeVoiceParams({ pitch: next, calmness: params.calmness }));
  }

  function setCalmnessParam(next: number): void {
    onParamsChange(normalizeVoiceParams({ pitch: params.pitch, calmness: next }));
  }

  /** One play control, the same quiet button in every row. */
  function renderPlay(id: string, label: string, disabled: boolean): React.ReactElement {
    return (
      <Button
        kind="quiet"
        size="sm"
        className={styles.playBtn}
        aria-label={
          playingId === id ? t('Stop {name} sample', { name: label }) : t('Play {name} sample', { name: label })
        }
        disabled={disabled}
        onClick={() => void toggleSample(id)}
        icon={
          loadingId === id ? (
            <span className={styles.loadingDot} aria-hidden="true" />
          ) : playingId === id ? (
            <StopIcon size={12} />
          ) : (
            <PlayIcon size={12} />
          )
        }
      />
    );
  }

  /** Whether a sample of `id` can play now. Tuned previews always need live
   * TTS, even for bundled pool voices. */
  function playDisabled(id: string, bundled: boolean): boolean {
    return (samplesOff && (!bundled || tuned)) || (loadingId !== null && loadingId !== id);
  }

  /** A list row: play, the name, at most one short muted line. */
  function renderRow(id: string, name: string, detail: string, bundled = true): React.ReactElement {
    const selected = value === id;
    return (
      <div key={id} className={`${styles.row} ${selected ? styles.selected : ''}`}>
        {renderPlay(id, name, playDisabled(id, bundled))}
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          className={styles.rowBody}
          onClick={() => {
            const next = reduceSelection(value, id);
            onChange(next, next === null ? null : ownVoicePickFor(next, ownVoices));
          }}
        >
          <span className={styles.name}>{name}</span>
          {detail ? <span className={styles.detail}>{detail}</span> : null}
        </button>
      </div>
    );
  }

  // â”€â”€ Filter: only the active gender group's voices render. Default: the group
  //    containing the current selection, else the first group (Feminine when
  //    populated â€” GROUP_ORDER puts it first). Empty groups have no filter. â”€â”€
  const groups = groupVoices(voices);
  const ownView = ownVoicesView(ownList);
  const ownTabShown = ownView === 'tab';
  const tabKeys: VoiceTabKey[] = [
    ...(ownTabShown ? [OWN_TAB_KEY as VoiceTabKey] : []),
    ...groups.map((g) => g.key),
  ];
  const activeTab: VoiceTabKey | null =
    chosenTab !== null && tabKeys.includes(chosenTab)
      ? chosenTab
      : defaultVoiceTab(value, groups, ownTabShown ? ownVoices : null);
  const activeGroup = groups.find((g) => g.key === activeTab) ?? null;
  const unlisted = isUnlistedVoice(value, [...voices, ...ownVoices]);
  // valueOwn only describes `value` when it is still the stored pick.
  const unlistedOwn = unlisted && valueOwn ? valueOwn : null;
  const libraryTile = voiceLibraryTile(hasElevenKey, localTtsMode, ownList);

  // â”€â”€ The current voice (261120): the one row at the top, whatever the filter.
  const pinned = value !== null && value !== NO_VOICE_ID ? value : null;
  const poolCurrent = pinned ? voices.find((v) => v.id === pinned) : undefined;
  const currentName =
    value === null
      ? t('Auto: let Sei pick')
      : value === NO_VOICE_ID
        ? t('No voice')
        : (poolCurrent?.label ??
          ownVoices.find((v) => v.id === pinned)?.name ??
          libVoices.find((v) => v.voiceId === pinned)?.name ??
          valueOwn?.name ??
          (voices.length > 0 ? t('Current voice') : ''));
  // One muted line, only when the current voice does not simply play.
  const currentNote =
    unlistedOwn?.source === 'library'
      ? libStatus === 'removed'
        ? t('No longer available. A similar Sei voice speaks for them until you pick another.')
        : null
      : unlistedOwn && aiBackendKind === 'cloud-proxy'
        ? t('From your ElevenLabs account. Without your ElevenLabs key, a Sei voice speaks for them.')
        : samplesOff && unlisted && !unlistedOwn
          ? t('Sign in to play the current voice sample. Picking a voice still works.')
          : null;

  // â”€â”€ Auto / No voice overflow menu (261120) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus();
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);

  /** A menu item sets its choice (picking the checked one again keeps it,
   * unlike a list row, which toggles back to Auto). */
  function pickFromMenu(next: string | null): void {
    setMenuOpen(false);
    if (next !== value) onChange(next, null);
  }

  function openVoiceLibrary(): void {
    try {
      sei.track('voice_library_opened', {
        surface: surface ?? 'other',
        key: libraryTile === 'with_key' ? 'saved' : 'none',
        backend: aiBackendKind === 'local' ? 'local' : 'cloud',
      });
    } catch {
      /* analytics must never break the picker */
    }
    void sei.openExternal(ELEVEN_VOICE_LIBRARY_URL).catch(() => {});
  }

  const browseLink = (
    <button type="button" className={styles.link} data-testid="voice-library-tile" onClick={openVoiceLibrary}>
      {t('Browse the Voice Library')}
    </button>
  );

  /** The library row (261119, quieted 261120): the paste field and Look up,
   * the Browse link beside them, then the voice or a reason. */
  function renderLibraryPaste(): React.ReactElement {
    const busy = libState.kind === 'looking' || libState.kind === 'adding';
    const shown = libState.kind === 'found' || libState.kind === 'adding' ? libState.voice : null;
    return (
      <section className={styles.lib} data-testid="library-voice-card" aria-label={t('Use a voice from the library')}>
        <form
          className={styles.libForm}
          onSubmit={(e) => {
            e.preventDefault();
            void lookupLibrary();
          }}
        >
          <input
            className={styles.libInput}
            type="text"
            value={libInput}
            placeholder={t('Voice Library link or voice ID')}
            aria-label={t('Voice Library link or voice ID')}
            spellCheck={false}
            autoComplete="off"
            maxLength={2048}
            disabled={busy}
            onChange={(e) => {
              setLibInput(e.target.value);
              if (libState.kind === 'rejected' || libState.kind === 'found') setLibState({ kind: 'idle' });
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text').trim();
              if (!text) return;
              e.preventDefault();
              setLibInput(text);
              void lookupLibrary(text);
            }}
          />
          <Button
            kind="quiet"
            size="sm"
            className={styles.action}
            type="submit"
            disabled={busy || !libInput.trim()}
          >
            {libState.kind === 'looking' ? t('Looking up...') : t('Look up')}
          </Button>
          {browseLink}
        </form>
        {shown ? (
          <div className={styles.row}>
            {renderPlay(shown.voiceId, shown.name, !shown.hasPreview || (loadingId !== null && loadingId !== shown.voiceId))}
            <div className={styles.rowStatic}>
              <span className={styles.name}>{shown.name}</span>
              <span className={styles.detail}>{libraryVoiceDetail(shown)}</span>
            </div>
            <Button
              kind="quiet"
              size="sm"
              className={styles.action}
              disabled={libState.kind === 'adding' || value === shown.voiceId}
              onClick={() => void pickLibraryVoice(shown)}
            >
              {value === shown.voiceId
                ? t('In use')
                : libState.kind === 'adding'
                  ? t('Adding...')
                  : t('Use this voice')}
            </Button>
          </div>
        ) : null}
        {libState.kind === 'rejected' ? (
          <div className={styles.note} role="status">
            {t(libraryReasonCopy(libState.reason))}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <div className={styles.root}>
      {localTtsMode ? null : (
      <>
      {cloudVoicesUnavailable ? (
        <div className={styles.warnNote} role="alert">
          {t(
            'Not connected to Sei cloud or an ElevenLabs key. Custom voices will not play. Local voice packs still work.',
          )}
        </div>
      ) : null}

      {/* The current voice, with Auto and No voice tucked in its menu. */}
      <div className={styles.current} data-testid="voice-current">
        <div className={styles.currentRow}>
          {pinned ? (
            renderPlay(pinned, currentName, playDisabled(pinned, !!poolCurrent))
          ) : (
            <span className={styles.playSpacer} aria-hidden="true" />
          )}
          <span className={styles.currentName}>{currentName}</span>
          <div className={styles.menuWrap} ref={menuRef}>
            <Button
              kind="quiet"
              size="sm"
              className={styles.menuBtn}
              aria-label={t('Voice options')}
              title={t('Voice options')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              icon={<DotsIcon size={16} />}
            />
            {menuOpen ? (
              <div
                className={styles.menu}
                role="menu"
                aria-label={t('Voice options')}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setMenuOpen(false);
                  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
                    const at = items.indexOf(document.activeElement as HTMLButtonElement);
                    const step = e.key === 'ArrowDown' ? 1 : -1;
                    items[(at + step + items.length) % items.length]?.focus();
                  }
                }}
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === null}
                  className={styles.menuItem}
                  onClick={() => pickFromMenu(null)}
                >
                  {t('Auto: let Sei pick')}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={value === NO_VOICE_ID}
                  className={styles.menuItem}
                  onClick={() => pickFromMenu(NO_VOICE_ID)}
                >
                  {t('No voice')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {currentNote ? <div className={styles.note}>{currentNote}</div> : null}
      </div>

      {ownView === 'hint' ? (
        <div className={styles.note} role="status">
          {ownList?.status === 'bad_key'
            ? t('Could not read your ElevenLabs voices. Check your ElevenLabs key in Playtime.')
            : t('Could not load your ElevenLabs voices right now.')}
        </div>
      ) : null}

      {tabKeys.length > 0 ? (
        <div className={styles.filter} role="tablist" aria-label={t('Voice group')}>
          {tabKeys.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={key === activeTab}
              className={key === activeTab ? `${styles.filterBtn} ${styles.filterActive}` : styles.filterBtn}
              onClick={() => setChosenTab(key)}
            >
              {key === OWN_TAB_KEY
                ? t('Your ElevenLabs voices')
                : t(groups.find((g) => g.key === key)?.title ?? '')}
            </button>
          ))}
          {activeTab === OWN_TAB_KEY && ownTabShown ? (
            <Button
              kind="quiet"
              size="sm"
              className={styles.filterEnd}
              onClick={() => loadOwnVoices(true)}
              disabled={ownRefreshing}
            >
              {t('Refresh')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {activeTab !== OWN_TAB_KEY && activeGroup && poolUsesOwnKey(ownList, aiBackendKind) ? (
        <div className={styles.note}>
          {t("Sei's voices need a paid ElevenLabs plan on your key.")}
        </div>
      ) : null}

      <div className={styles.list} role="radiogroup" aria-label={t('Voice')}>
        {activeTab === OWN_TAB_KEY && ownTabShown ? (
          ownVoices.length === 0 ? (
            <div className={styles.note}>
              {t('No voices in your ElevenLabs account yet. Voices you clone, design or save there show up here.')}
            </div>
          ) : (
            ownVoices.map((v) =>
              renderRow(
                v.id,
                v.name,
                [t(ownVoiceCategoryLabel(v.category)), ownVoiceDetail(v)].filter(Boolean).join(', '),
                false,
              ),
            )
          )
        ) : activeGroup ? (
          activeGroup.voices.map((v) =>
            renderRow(v.id, v.label, [v.age.replace(/_/g, ' '), v.vibe].filter(Boolean).join(', ')),
          )
        ) : null}
      </div>

      {/* The Voice Library (261119): on Sei cloud a pasted link; with your
          own ElevenLabs key, voices you save there join your list. */}
      {libraryPaste ? (
        renderLibraryPaste()
      ) : libraryTile ? (
        <div className={styles.libLine}>
          {browseLink}
          <span className={styles.note}>
            {libraryTile === 'with_key'
              ? t('Voices you save there show up under Your ElevenLabs voices. Paid plans only.')
              : t('To use one, add your ElevenLabs key in Playtime. Paid plans only.')}
          </span>
        </div>
      ) : null}
      </>
      )}

      {/* â”€â”€ Pitch and calmness (260725) â”€â”€ */}
      <section className={styles.tuner} aria-label={t('Tune the voice')}>
        {!tunable ? <div className={styles.note}>{t('Pick a voice to tune it.')}</div> : null}
        {localTtsMode && pitchBypassed ? (
          <div className={styles.note}>{t('Their own Fish Audio voice plays without the pitch setting.')}</div>
        ) : null}
        {!localTtsMode && tunable && tuned && samplesOff ? (
          <div className={styles.note}>{t('Sign in to hear tuned samples.')}</div>
        ) : null}

        <div className={styles.tunerRow}>
          <label
            className={styles.tunerLabel}
            htmlFor={`${sliderIdBase}-pitch`}
            title={t('Higher or lower voice. Speaking pace stays the same.')}
          >
            {t('Pitch')}
          </label>
          <input
            id={`${sliderIdBase}-pitch`}
            className={styles.tunerSlider}
            type="range"
            min={0.85}
            max={1.4}
            step={0.01}
            value={pitch}
            disabled={!tunable}
            onChange={(e) => setPitchParam(Number(e.target.value))}
          />
          <span className={styles.tunerValue}>{pitch.toFixed(2)}</span>
          {localTtsMode ? (
            <Button
              kind="quiet"
              size="sm"
              className={styles.playBtn}
              aria-label={playingId === LOCAL_SAMPLE_ID ? t('Stop the pitch sample') : t('Hear the pitch')}
              title={playingId === LOCAL_SAMPLE_ID ? t('Stop the pitch sample') : t('Hear the pitch')}
              disabled={loadingId !== null && loadingId !== LOCAL_SAMPLE_ID}
              onClick={() => void toggleLocalSample()}
              icon={
                loadingId === LOCAL_SAMPLE_ID ? (
                  <span className={styles.loadingDot} aria-hidden="true" />
                ) : playingId === LOCAL_SAMPLE_ID ? (
                  <StopIcon size={12} />
                ) : (
                  <PlayIcon size={12} />
                )
              }
            />
          ) : null}
          <Button
            kind="quiet"
            size="sm"
            className={`${styles.tunerReset} ${tunable && params.pitch !== undefined ? '' : styles.hidden}`}
            onClick={() => setPitchParam(PITCH_DEFAULT)}
            disabled={!tunable || params.pitch === undefined}
          >
            {t('Reset')}
          </Button>
        </div>

        {/* Calmness is ElevenLabs `stability` â€” a synthesis param the local
            engine has no equivalent for, so local-TTS mode hides it. */}
        {localTtsMode ? null : (
        <div className={styles.tunerRow}>
          <label
            className={styles.tunerLabel}
            htmlFor={`${sliderIdBase}-calmness`}
            title={t('Higher is steadier and more even. Lower is more dramatic.')}
          >
            {t('Calmness')}
          </label>
          <input
            id={`${sliderIdBase}-calmness`}
            className={styles.tunerSlider}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={calmness}
            disabled={!tunable}
            onChange={(e) => setCalmnessParam(Number(e.target.value))}
          />
          <span className={styles.tunerValue}>{calmness.toFixed(2)}</span>
          <Button
            kind="quiet"
            size="sm"
            className={`${styles.tunerReset} ${tunable && params.calmness !== undefined ? '' : styles.hidden}`}
            onClick={() => setCalmnessParam(CALMNESS_DEFAULT)}
            disabled={!tunable || params.calmness === undefined}
          >
            {t('Reset')}
          </Button>
        </div>
        )}
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}
    </div>
  );
}




