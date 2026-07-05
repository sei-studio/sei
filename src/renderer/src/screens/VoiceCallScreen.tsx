/**
 * VoiceCallScreen — the live Discord-style call view (260705, real audio).
 *
 * Centered large companion avatar (pulsing while the companion is speaking),
 * name, a status subtitle (connecting / listening / speaking / error), two
 * caption lines (what you last said, what the companion last said), and the
 * mute + hang-up controls. Reached via view.kind === 'voice-call'.
 *
 * The call session itself lives in useVoiceStore (mic → local Whisper →
 * chat pipeline → TTS queue); this screen renders it and ensures a call is
 * started for the viewed character (idempotent — restore from the minimized
 * widget re-enters without restarting the pipeline). Mute stays in useUiStore,
 * shared with MinimizedCall.
 */

import React, { useEffect, useMemo } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from '../components/PixelPortrait';
import { MicIcon, MicOffIcon, PhoneOffIcon, UserIcon, MinimizeIcon } from '../components/icons';
import styles from './VoiceCallScreen.module.css';

export interface VoiceCallScreenProps {
  characterId: string;
}

export function VoiceCallScreen({ characterId }: VoiceCallScreenProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  // Mute lives in the UI store so it survives a minimize → restore round-trip
  // and is shared with the MinimizedCall widget (#6).
  const muted = useUiStore((s) => s.callMuted);
  const setMuted = useUiStore((s) => s.setCallMuted);
  const minimizeCall = useUiStore((s) => s.minimizeCall);

  const status = useVoiceStore((s) => s.status);
  const speaking = useVoiceStore((s) => s.speaking);
  const lastHeard = useVoiceStore((s) => s.lastHeard);
  const lastSpoken = useVoiceStore((s) => s.lastSpoken);
  const error = useVoiceStore((s) => s.error);
  const callCharacterId = useVoiceStore((s) => s.callCharacterId);
  const startCall = useVoiceStore((s) => s.startCall);
  const endCall = useVoiceStore((s) => s.endCall);

  // Entering this view IS the intent to be on a call (idempotent when the
  // pipeline is already up for this character, e.g. restore-from-minimize).
  useEffect(() => {
    if (callCharacterId !== characterId) void startCall(characterId);
  }, [characterId, callCharacterId, startCall]);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';
  const palette = useMemo(
    () => pickPalette((character?.id ?? '') + (character?.name ?? ''), theme),
    [character?.id, character?.name, theme],
  );

  const companionName = character?.name ?? 'Companion';

  const subtitle =
    status === 'error'
      ? error ?? 'Call failed'
      : status === 'connecting'
        ? 'Connecting…'
        : speaking
          ? 'Speaking'
          : muted
            ? 'On call · muted'
            : 'On call · listening';

  return (
    <div className={styles.root}>
      {/* Minimize sits top-left. */}
      <button
        type="button"
        className={styles.minimizeBtn}
        onClick={() => minimizeCall(characterId)}
        aria-label="Minimize call"
        title="Minimize"
      >
        <MinimizeIcon size={20} />
      </button>

      <div className={speaking ? `${styles.avatar} ${styles.avatarSpeaking}` : styles.avatar}>
        {character ? (
          <PixelPortrait
            seed={character.id + character.name}
            palette={palette}
            size={168}
            portraitImage={character.portrait_image}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <UserIcon size={72} />
        )}
      </div>

      <h1 className={styles.name}>{companionName}</h1>
      <span className={status === 'error' ? `${styles.subtitle} ${styles.subtitleError}` : styles.subtitle}>
        {status !== 'error' ? <span className={styles.subtitleDot} aria-hidden="true" /> : null}
        {subtitle}
      </span>

      {/* Captions — the last line each side said, so a glance explains the audio. */}
      <div className={styles.captions} aria-live="polite">
        {lastSpoken ? (
          <p className={styles.captionCompanion}>{lastSpoken}</p>
        ) : status === 'live' ? (
          <p className={styles.captionHint}>Say something — {companionName} can hear you.</p>
        ) : null}
        {lastHeard ? <p className={styles.captionUser}>You: {lastHeard}</p> : null}
      </div>

      <div className={styles.controls}>
        <div className={styles.control}>
          <button
            type="button"
            className={`${styles.circleBtn} ${muted ? styles.circleBtnMuted : ''}`}
            onClick={() => setMuted(!muted)}
            aria-pressed={muted}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <MicOffIcon size={24} /> : <MicIcon size={24} />}
          </button>
          <span className={styles.controlLabel}>{muted ? 'Muted' : 'Mute'}</span>
        </div>

        <div className={styles.control}>
          <button
            type="button"
            className={`${styles.circleBtn} ${styles.circleBtnHangup}`}
            onClick={() => {
              endCall();
              navigate({ kind: 'chat', characterId });
            }}
            aria-label="Hang up"
          >
            <PhoneOffIcon size={26} />
          </button>
          <span className={styles.controlLabel}>Hang up</span>
        </div>
      </div>
    </div>
  );
}
