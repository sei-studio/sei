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

import React, { useEffect, useMemo, useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from '../components/PixelPortrait';
import { Button } from '../components/Button';
import {
  isVoiceModelReady,
  prefetchInProgress,
  prefetchPct,
  prefetchVoiceModel,
} from '../lib/voice/modelPrefetch';
import {
  MicIcon,
  MicOffIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  PhoneOffIcon,
  UserIcon,
  MinimizeIcon,
} from '../components/icons';
import styles from './VoiceCallScreen.module.css';

/** mm:ss (h:mm:ss past the hour) for the live-call duration readout. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Voice-module install gate (260705): 'ready' lets the dial effect run;
 * 'consent' asks first (the user skipped the onboarding opt-in). */
type InstallGate = 'checking' | 'consent' | 'installing' | 'failed' | 'ready';

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
  const deafened = useUiStore((s) => s.callDeafened);
  const setDeafened = useUiStore((s) => s.setCallDeafened);
  const minimizeCall = useUiStore((s) => s.minimizeCall);

  const status = useVoiceStore((s) => s.status);
  const speaking = useVoiceStore((s) => s.speaking);
  const lastHeard = useVoiceStore((s) => s.lastHeard);
  const lastSpoken = useVoiceStore((s) => s.lastSpoken);
  const error = useVoiceStore((s) => s.error);
  const connectingDetail = useVoiceStore((s) => s.connectingDetail);
  const callCharacterId = useVoiceStore((s) => s.callCharacterId);
  const liveAt = useVoiceStore((s) => s.liveAt);
  const startCall = useVoiceStore((s) => s.startCall);
  const endCall = useVoiceStore((s) => s.endCall);

  // Live-call duration readout, ticking once a second while live.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (liveAt === null) return;
    setNowTick(Date.now());
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [liveAt]);

  // Voice-module gate (260705). A call physically needs the ~40 MB Whisper
  // model; if the user skipped the onboarding opt-in, ask before downloading
  // (popup → yes/no → progress). An already-running background download skips
  // the question and just shows its progress.
  const [gate, setGate] = useState<InstallGate>('checking');
  const [installPct, setInstallPct] = useState(0);
  useEffect(() => {
    let alive = true;
    // A call already up for this character means the model is in place.
    if (useVoiceStore.getState().callCharacterId === characterId) {
      setGate('ready');
      return;
    }
    void isVoiceModelReady().then((ready) => {
      if (!alive) return;
      if (ready) setGate('ready');
      else if (prefetchInProgress()) {
        setGate('installing');
        setInstallPct(prefetchPct());
        prefetchVoiceModel((pct) => alive && setInstallPct(pct)).then(
          () => alive && setGate('ready'),
          () => alive && setGate('failed'),
        );
      } else setGate('consent');
    });
    return () => {
      alive = false;
    };
  }, [characterId]);

  const handleInstall = (): void => {
    setGate('installing');
    setInstallPct(prefetchPct());
    prefetchVoiceModel((pct) => setInstallPct(pct)).then(
      () => setGate('ready'),
      () => setGate('failed'),
    );
  };

  // Entering this view IS the intent to be on a call (idempotent when the
  // pipeline is already up for this character, e.g. restore-from-minimize) —
  // once the voice module is in place.
  useEffect(() => {
    if (gate !== 'ready') return;
    if (callCharacterId !== characterId) void startCall(characterId);
  }, [gate, characterId, callCharacterId, startCall]);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';
  const palette = useMemo(
    () => pickPalette((character?.id ?? '') + (character?.name ?? ''), theme),
    [character?.id, character?.name, theme],
  );

  const companionName = character?.name ?? 'Companion';

  // Live: the call duration (00:00, ticking). Everything else keeps words.
  const subtitle =
    status === 'error'
      ? error ?? 'Call failed'
      : status === 'connecting'
        ? connectingDetail
          ? `Preparing voice recognition… ${connectingDetail}%`
          : 'Calling…'
        : liveAt !== null
          ? formatDuration(nowTick - liveAt)
          : '00:00';

  // Install gate overlay: consent question, live progress, or failure. The
  // call UI behind it stays in its idle pose until the gate opens.
  const installOverlay =
    gate === 'consent' || gate === 'installing' || gate === 'failed' ? (
      <div className={styles.installScrim} role="dialog" aria-modal="true" aria-label="Voice module setup">
        <div className={styles.installModal}>
          <h2 className={styles.installTitle}>
            {gate === 'failed' ? 'Download failed' : 'Set up voice calls'}
          </h2>
          {gate === 'consent' ? (
            <>
              <p className={styles.installBody}>
                Calling {companionName} needs the voice module — a one-time ~40 MB download that
                lets Sei understand your voice. Install it now?
              </p>
              <div className={styles.installActions}>
                <Button kind="ghost" onClick={() => navigate({ kind: 'chat', characterId })}>
                  Not now
                </Button>
                <Button kind="primary" onClick={handleInstall}>
                  Install
                </Button>
              </div>
            </>
          ) : gate === 'installing' ? (
            <>
              <p className={styles.installBody}>Downloading the voice module… {installPct}%</p>
              <div
                className={styles.installBar}
                role="progressbar"
                aria-valuenow={installPct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className={styles.installBarFill} style={{ width: `${installPct}%` }} />
              </div>
            </>
          ) : (
            <>
              <p className={styles.installBody}>
                The voice module couldn&rsquo;t be downloaded. Check your connection and try again.
              </p>
              <div className={styles.installActions}>
                <Button kind="ghost" onClick={() => navigate({ kind: 'chat', characterId })}>
                  Back
                </Button>
                <Button kind="primary" onClick={handleInstall}>
                  Retry
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    ) : null;

  return (
    <div className={styles.root}>
      {installOverlay}
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
            size={232}
            portraitImage={character.portrait_image}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <UserIcon size={96} />
        )}
      </div>

      <h1 className={styles.name}>{companionName}</h1>
      <span className={status === 'error' ? `${styles.subtitle} ${styles.subtitleError}` : styles.subtitle}>
        {status !== 'error' ? <span className={styles.subtitleDot} aria-hidden="true" /> : null}
        {subtitle}
      </span>

      {/* Captions — the last line each side said, so a glance explains the audio. */}
      <div className={styles.captions} aria-live="polite">
        {lastSpoken ? <p className={styles.captionCompanion}>{lastSpoken}</p> : null}
        {lastHeard ? <p className={styles.captionUser}>You: {lastHeard}</p> : null}
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={`${styles.circleBtn} ${muted ? styles.circleBtnMuted : ''}`}
          onClick={() => setMuted(!muted)}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute' : 'Mute'}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <MicOffIcon size={24} /> : <MicIcon size={24} />}
        </button>

        <button
          type="button"
          className={`${styles.circleBtn} ${deafened ? styles.circleBtnMuted : ''}`}
          onClick={() => setDeafened(!deafened)}
          aria-pressed={deafened}
          aria-label={deafened ? 'Undeafen' : 'Deafen'}
          title={deafened ? 'Undeafen' : 'Deafen'}
        >
          {deafened ? <HeadphonesOffIcon size={24} /> : <HeadphonesIcon size={24} />}
        </button>

        <button
          type="button"
          className={`${styles.circleBtn} ${styles.circleBtnHangup}`}
          onClick={() => {
            endCall();
            navigate({ kind: 'chat', characterId });
          }}
          aria-label="Hang up"
          title="Hang up"
        >
          <PhoneOffIcon size={26} />
        </button>
      </div>
    </div>
  );
}
