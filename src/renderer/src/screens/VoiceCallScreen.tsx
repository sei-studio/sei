/**
 * VoiceCallScreen — the live Discord-style call view (260705, real audio;
 * multi-companion 260706).
 *
 * A cluster of avatars: every companion on the call (lit while speaking, dimmed
 * while idle from the per-companion speaking state) plus the user's own avatar
 * beside them, and a "＋" tile to add another companion. A header title (the
 * companion's name solo, "Group call" with 2+), a status subtitle (connecting /
 * duration / error), optional caption lines, and the mute + hang-up controls.
 * Reached via view.kind === 'voice-call'.
 *
 * The call session itself lives in useVoiceStore (mic → local Whisper →
 * chat pipeline → TTS queue); this screen renders it and ensures a call is
 * started for the viewed character (idempotent — restore from the minimized
 * widget re-enters without restarting the pipeline). Mute stays in useUiStore,
 * shared with MinimizedCall.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { isHomeCharacter } from '../lib/homeLibrary';
import { pickPalette } from '../lib/portraitPalettes';
import { portraitSrc } from '../lib/portraitSrc';
import { PixelPortrait } from '../components/PixelPortrait';
import { Button } from '../components/Button';
import { sei } from '../lib/ipcClient';
import type { UserProfile } from '@shared/ipc';
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
  PlusIcon,
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
  const characters = useDataStore((s) => s.characters);
  const character = characters.find((c) => c.id === characterId);
  // Mute lives in the UI store so it survives a minimize → restore round-trip
  // and is shared with the MinimizedCall widget (#6).
  const muted = useUiStore((s) => s.callMuted);
  const setMuted = useUiStore((s) => s.setCallMuted);
  const deafened = useUiStore((s) => s.callDeafened);
  const setDeafened = useUiStore((s) => s.setCallDeafened);
  const captionsOn = useUiStore((s) => s.callCaptions);
  const minimizeCall = useUiStore((s) => s.minimizeCall);

  const status = useVoiceStore((s) => s.status);
  const speakingId = useVoiceStore((s) => s.speakingId);
  const userSpeaking = useVoiceStore((s) => s.userSpeaking);
  const lastHeard = useVoiceStore((s) => s.lastHeard);
  const lastSpoken = useVoiceStore((s) => s.lastSpoken);
  const error = useVoiceStore((s) => s.error);
  const participants = useVoiceStore((s) => s.participants);
  const liveAt = useVoiceStore((s) => s.liveAt);
  const startCall = useVoiceStore((s) => s.startCall);
  const addParticipant = useVoiceStore((s) => s.addParticipant);
  const endCall = useVoiceStore((s) => s.endCall);

  // The user's own avatar (shown beside the companion pfps).
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  useEffect(() => {
    let cancelled = false;
    void sei
      .userGetProfile()
      .then((p) => !cancelled && setUserProfile(p))
      .catch(() => {
        /* generic glyph fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Add-a-companion picker (task 3): companions in the user's party (the SAME
  // home-library rule the IconRail + Home grid use, so "who I can invite" matches
  // the roster exactly), minus whoever is already on the call.
  const authState = useAuthStore((s) => s.state);
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  const addedDefaultIds = useLibraryStateStore((s) => s.addedDefaultIds);
  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const [pickerOpen, setPickerOpen] = useState(false);
  const addable = useMemo(
    () =>
      characters.filter(
        (c) =>
          !participants.includes(c.id) &&
          isHomeCharacter(c, currentUserId, addedDefaultIds, addedWorldIds),
      ),
    [characters, participants, currentUserId, addedDefaultIds, addedWorldIds],
  );

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
    // A call already includes this character → the model is already in place.
    if (useVoiceStore.getState().participants.includes(characterId)) {
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
  // once the voice module is in place. We dial this character AT MOST ONCE per
  // mount: if they later drop from the call (their own end_call, or the call
  // collapses), we must NOT auto re-dial them back in — that re-entered the
  // 'connecting' state and snapped the screen back to "Calling…", and made
  // hang-up impossible ("no way to stop, had to quit the app").
  const dialedRef = useRef<string | null>(null);
  useEffect(() => {
    if (gate !== 'ready') return;
    // Already a member (incl. restore-from-minimize) → nothing to dial.
    if (useVoiceStore.getState().participants.includes(characterId)) {
      dialedRef.current = characterId;
      return;
    }
    if (dialedRef.current === characterId) return; // already dialed once; don't re-dial after a drop
    dialedRef.current = characterId;
    // startCall() is smart: it dials a fresh call, or adds this character to a
    // call already open (multi-companion).
    void startCall(characterId);
  }, [gate, characterId, startCall]);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  const companionName = character?.name ?? 'Companion';
  const isGroup = participants.length > 1;
  // Header title: the companion's name on a solo call, "Group call" with 2+.
  const title = isGroup ? 'Group call' : companionName;
  // Avatar size shrinks as the roster grows so every companion + the user + the
  // "＋" tile stay on ONE row (the "＋ pushed to its own ugly second row" fix).
  const companionCount = participants.length;
  const avatarPx =
    companionCount <= 1 ? 176 : companionCount === 2 ? 140 : companionCount === 3 ? 118 : companionCount === 4 ? 104 : 92;
  const userName = userProfile?.preferredName?.trim() || 'You';
  const userAvatarSrc = portraitSrc(userProfile?.profilePicture);

  // Live: the call duration (00:00, ticking). Everything else keeps words.
  const subtitle =
    status === 'error'
      ? error ?? 'Call failed'
      : status === 'connecting'
        ? // Outgoing state: always just "Calling…" (no "setting up 99%" — the
          // model-load percentage flashed on every call even from cache, task 3).
          'Calling…'
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
                Calling {companionName} needs the voice module, a one-time ~40 MB download that
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

  // Add-companion picker: pick from companions not already on the call. Choosing
  // one adds them to the live call (they greet the room and join the turn-taking).
  const pickerOverlay = pickerOpen ? (
    <div
      className={styles.pickerScrim}
      role="dialog"
      aria-modal="true"
      aria-label="Add a companion to the call"
      onClick={() => setPickerOpen(false)}
    >
      <div className={styles.pickerModal} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.pickerTitle}>Add to call</h2>
        {addable.length === 0 ? (
          <p className={styles.pickerEmpty}>Everyone is already on the call.</p>
        ) : (
          <div className={styles.pickerList}>
            {addable.map((c) => {
              const src = portraitSrc(c.portrait_image);
              const pal = pickPalette(c.id + c.name, theme);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={styles.pickerRow}
                  onClick={() => {
                    addParticipant(c.id);
                    setPickerOpen(false);
                  }}
                >
                  <span className={styles.pickerRowAvatar}>
                    {src ? (
                      <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <PixelPortrait
                        seed={c.id + c.name}
                        palette={pal}
                        size={34}
                        portraitImage={c.portrait_image}
                        style={{ width: '100%', height: '100%' }}
                      />
                    )}
                  </span>
                  <span className={styles.pickerRowName}>{c.name}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className={styles.installActions}>
          <Button kind="ghost" onClick={() => setPickerOpen(false)}>
            Done
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className={styles.root}>
      {installOverlay}
      {pickerOverlay}
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

      {/* Participant cluster (260706): every companion on the call, lit while
          speaking and dimmed while idle (per-companion speaking state), plus the
          user's own avatar beside them, and a "＋" tile to add another. */}
      <div className={styles.cluster}>
        {participants.map((id) => {
          const c = characters.find((x) => x.id === id);
          const isSpeaking = speakingId === id;
          const dim = !isSpeaking && isGroup;
          const pal = pickPalette((c?.id ?? '') + (c?.name ?? ''), theme);
          return (
            <div key={id} className={styles.tile}>
              <div
                className={`${styles.tileAvatar} ${
                  isSpeaking ? styles.tileSpeaking : dim ? styles.tileIdle : ''
                }`}
                style={{ width: avatarPx, height: avatarPx }}
              >
                {c ? (
                  <PixelPortrait
                    seed={c.id + c.name}
                    palette={pal}
                    size={avatarPx}
                    portraitImage={c.portrait_image}
                    style={{ width: '100%', height: '100%' }}
                  />
                ) : (
                  <UserIcon size={Math.round(avatarPx * 0.4)} />
                )}
              </div>
              {/* Always name each companion under their avatar, like the user's
                  own tile, even on a 1:1 call. */}
              <span className={styles.tileName}>{c?.name ?? 'Companion'}</span>
            </div>
          );
        })}

        {/* The user's own tile — lit with the speaking ring while they talk
            (same ring the companions get), dimmed when their mic is muted. */}
        <div className={styles.tile}>
          <div
            className={`${styles.tileAvatar} ${
              userSpeaking && !muted ? styles.tileSpeaking : muted ? styles.tileMutedSelf : ''
            }`}
            style={{ width: avatarPx, height: avatarPx }}
          >
            {userAvatarSrc ? (
              <img src={userAvatarSrc} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <UserIcon size={Math.round(avatarPx * 0.4)} />
            )}
          </div>
          <span className={`${styles.tileName} ${styles.tileNameSelf}`}>{userName}</span>
        </div>

        {/* Add another companion to the call. */}
        {addable.length > 0 ? (
          <div className={styles.tile}>
            <button
              type="button"
              className={styles.addBtn}
              style={{ width: avatarPx, height: avatarPx }}
              onClick={() => setPickerOpen(true)}
              aria-label="Add a companion to the call"
              title="Add a companion"
            >
              <PlusIcon size={Math.round(avatarPx * 0.3)} />
            </button>
            <span className={styles.tileName}>Add</span>
          </div>
        ) : null}
      </div>

      <h1 className={styles.name}>{title}</h1>
      <span className={status === 'error' ? `${styles.subtitle} ${styles.subtitleError}` : styles.subtitle}>
        {status !== 'error' ? <span className={styles.subtitleDot} aria-hidden="true" /> : null}
        {subtitle}
      </span>

      {/* Captions — opt-in (Appearance & feel → Call captions, default off).
          Not rendered at all when off so the reserved min-height collapses and
          the controls sit closer to the name. */}
      {captionsOn ? (
        <div className={styles.captions} aria-live="polite">
          {lastSpoken ? <p className={styles.captionCompanion}>{lastSpoken}</p> : null}
          {lastHeard ? <p className={styles.captionUser}>You: {lastHeard}</p> : null}
        </div>
      ) : null}

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
