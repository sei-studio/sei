/**
 * VoiceCallScreen — Discord-style call PLACEHOLDER (Phase 18/19). No real audio.
 *
 * Centered large companion avatar, name, an "on call" subtitle, and two
 * circular controls: a local-only mute toggle and a red hang-up button that
 * returns to the chat. Reached via view.kind === 'voice-call'.
 *
 * Source: .planning/design/app-chat-and-memory.md §5 (VoiceCallModal) + R6.
 */

import React, { useMemo } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
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
  const endCall = useUiStore((s) => s.endCall);
  // Fresh calls start unmuted because endCall() resets callMuted on every
  // hang-up; a restore keeps the carried-over mute state (so no reset here).

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';
  const palette = useMemo(
    () => pickPalette((character?.id ?? '') + (character?.name ?? ''), theme),
    [character?.id, character?.name, theme],
  );

  const companionName = character?.name ?? 'Companion';

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

      <div className={styles.avatar}>
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
      <span className={styles.subtitle}>
        <span className={styles.subtitleDot} aria-hidden="true" />
        On call
      </span>

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
