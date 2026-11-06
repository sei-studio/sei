/**
 * The first-link intro in the app (261105, T337). SeilinkFlowHost mounts it
 * for a useSeilinkStore `intro` request: the first move-in on this account
 * (seilinkFlow.startSeilinkHost, while the host starts) or "Replay WorldLink
 * intro" in the companion menu.
 *
 * It loads her room (the same state the wallpaper will draw), plays
 * FirstLinkIntroView (the eclipse aurora and its climax, which fills the
 * screen with the theme's solid colour), ending on what the wallpaper will
 * draw (introEndFor: the plain black or white background while she has no
 * room yet), honours reduced
 * motion, and records what happened (seilink_intro: shown, then completed /
 * skipped / aborted, with the beat, a duration bucket and the host's state).
 * The intro counts as seen once it ended (completed or skipped) on a move-in
 * that worked; an aborted or failed one leaves it for the next try.
 *
 * 261106 v6 (WorldLink): the status lines follow her Anima bake and the host
 * start (animaLinkSource; a replay plays them at the minimum dwell), and
 * seilink_intro_link records how they went. A failed link (the failure line,
 * closed with Close or Esc) stops the host if it had started (`link_failed`:
 * she is not left on the desktop without her intro), gives the window back
 * and leaves the intro unseen, so the next WorldLink press plays it again
 * (main retries a failed bake).
 *
 * 261106 (first-link flow): a request with `stage` (the first link) plays on
 * the desktop stage (main/seilink/desktopStage.ts): the window covers the
 * primary display, the intro ends on her plain background (or her room) full screen (holdEnd), and once
 * she is really there the window steps aside, so the wallpaper (the same
 * picture) is what stays, and the dock asks about setting up her room together. A start
 * that failed comes back to the app window and the move-in sheet's error. A
 * refused stage plays in the window as before and still steps aside at the
 * end. The view stays mounted until the window has stepped aside, so nothing
 * of the app shows in between.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { seilinkResolver } from '@shared/seilinkPack';
import { INTRO_MOOD, INTRO_STYLE, SEILINK_INTRO_EVENT, SEILINK_INTRO_LINK_EVENT, introDurationBucket, type IntroHost } from '@shared/seilinkIntroTelemetry';
import { sei } from '../../../lib/ipcClient';
import { useDataStore } from '../../../lib/stores/useDataStore';
import type { SeilinkIntroRequest } from '../../../lib/stores/useSeilinkStore';
import { markIntroSeen } from '../../../lib/seilink/introPref';
import { introEndFor, plainTone } from '../../../lib/seilink/plainTone';
import { revealAndOffer } from '../../../lib/seilink/seilinkFlow';
import { animaLinkSource } from '../../../lib/seilink/animaLinkSource';
import { fixedSource, instantLog } from '../../../lib/seilink/worldLink';
import { roomAvatarUse } from '../RoomAvatar';
import { FirstLinkIntroView, type IntroFinish, type IntroRoom } from './FirstLinkIntroView';

/** Wait this long for her room before playing over a plain backdrop. */
const ROOM_WAIT_MS = 1500;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

function track(props: Record<string, string | number | boolean | null>, event: string = SEILINK_INTRO_EVENT): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics must never disrupt SeiLink */
  }
}

export default function FirstLinkIntro(props: { request: SeilinkIntroRequest; onDone(): void }): React.ReactElement | null {
  const { request, onDone } = props;
  const character = useDataStore((s) => s.characters.find((c) => c.id === request.characterId) ?? null);
  const [room, setRoom] = useState<IntroRoom | null | undefined>(undefined);
  const [use, setUse] = useState<'auto' | 'sei' | 'imported'>('auto');
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const answerRef = useRef<boolean | null>(null);
  // The desktop stage: null until main answers (or there is none to ask for).
  const [staged, setStaged] = useState<boolean | null>(request.stage ? null : false);
  const stagedRef = useRef(false);
  const doneRef = useRef(false);
  // What it ends on is fixed once her room has loaded (a theme change mid-intro does not swap it).
  const tone = useMemo(() => plainTone(), []);
  const endOn = useMemo(() => (room === undefined ? null : introEndFor(room?.state ?? null, tone)), [room, tone]);
  const base = useMemo(
    () => ({
      character_id: request.characterId,
      trigger: request.trigger,
      entry: request.entry,
      style: INTRO_STYLE,
      mood: INTRO_MOOD,
      end_on: endOn ?? 'plain_dark',
      reduced_motion: reduced,
    }),
    [request, reduced, endOn],
  );

  useEffect(() => {
    let dead = false;
    const timer = window.setTimeout(() => {
      if (!dead) setRoom((r) => (r === undefined ? null : r));
    }, ROOM_WAIT_MS);
    void (sei.seilinkRoomGet?.(request.characterId) ?? Promise.resolve(null))
      .then((p) => {
        if (dead) return;
        if (p?.state) setUse(roomAvatarUse(p.state.avatar));
        setRoom((r) => (r !== undefined ? r : p?.pack ? { manifest: p.pack.manifest, state: p.state, resolve: seilinkResolver(p.pack) } : null));
      })
      .catch(() => {
        if (!dead) setRoom((r) => (r === undefined ? null : r));
      });
    return () => {
      dead = true;
      window.clearTimeout(timer);
    };
  }, [request.characterId]);

  // What paces the status lines: her bake and the host start (a replay has nothing to wait on).
  const source = useMemo(
    () => (request.trigger === 'replay' ? fixedSource(instantLog()) : animaLinkSource(request.characterId, request.outcome)),
    [request],
  );

  useEffect(() => {
    void request.outcome.then(
      (ok) => {
        answerRef.current = ok;
      },
      () => {
        answerRef.current = false;
      },
    );
  }, [request.outcome]);

  // Step out over the desktop as soon as there is something to show (the intro opens on the theme's solid colour).
  useEffect(() => {
    if (!request.stage || room === undefined) return;
    let dead = false;
    if (!sei.seilinkStage) {
      setStaged(false);
      return;
    }
    void sei.seilinkStage({ action: 'enter', purpose: 'intro', characterId: request.characterId }).then(
      (r) => {
        if (dead) {
          if (r.ok) void sei.seilinkStage?.({ action: 'exit', reveal: false });
          return;
        }
        stagedRef.current = r.ok;
        setStaged(r.ok);
      },
      () => !dead && setStaged(false),
    );
    return () => {
      dead = true;
    };
    // Once per request: the room only goes from undefined to loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.stage, room === undefined]);

  // Unmounted some other way (an account switch) while on the stage: give the window back.
  useEffect(
    () => () => {
      if (stagedRef.current && !doneRef.current) {
        stagedRef.current = false;
        void sei.seilinkStage?.({ action: 'exit', reveal: false });
      }
    },
    [],
  );

  const shown = room !== undefined;
  useEffect(() => {
    if (shown) track({ ...base, action: 'shown' });
  }, [shown, base]);

  if (room === undefined || endOn === null) return null;

  const onReport = (report: Record<string, string | number>): void => {
    track({ ...report, trigger: request.trigger, reduced_motion: reduced, anima_start: source.startStage?.() ?? 'none' }, SEILINK_INTRO_LINK_EVENT);
  };

  const onFinish = (end: IntroFinish): void => {
    const host: IntroHost = request.trigger === 'replay' ? 'none' : answerRef.current === null ? 'pending' : answerRef.current ? 'ok' : 'failed';
    track({ ...base, action: end.action, beat: end.beat, duration_bucket: introDurationBucket(end.elapsedMs), host });
    if (request.trigger === 'first_link' && end.action !== 'aborted') {
      // Seen once the move-in worked; a start still pending is checked when it answers.
      void request.outcome.then((ok) => ok && markIntroSeen(), () => undefined);
    }
    if (end.action === 'aborted') {
      // The link failed: she does not stay on the desktop without it (the host is stopped once it has answered).
      void request.outcome
        .then((ok) => (ok ? sei.seilinkHostStop?.({ reason: 'link_failed' }) : null), () => null)
        .catch(() => null);
    }
    if (!request.stage) {
      onDone();
      return;
    }
    // The first link: once she is there, the window steps aside onto her room and the dock asks.
    void (async () => {
      const ok = end.action !== 'aborted' && (await request.outcome.catch(() => false));
      const wasStaged = stagedRef.current;
      doneRef.current = true;
      stagedRef.current = false;
      if (ok) await revealAndOffer(request.characterId, 'intro', { staged: wasStaged });
      else if (wasStaged) await sei.seilinkStage?.({ action: 'exit', reveal: false }).catch(() => null);
      onDone();
    })();
  };

  return (
    <FirstLinkIntroView
      end={endOn}
      tone={tone}
      reduced={reduced}
      characterId={request.characterId}
      name={character?.name ?? ''}
      room={room}
      portrait={character?.portrait_image ?? null}
      use={use}
      source={source}
      onFinish={onFinish}
      onReport={onReport}
      holdEnd={staged === true}
    />
  );
}
