/**
 * The first-link intro in the app (261105, T337). SeilinkFlowHost mounts it
 * for a useSeilinkStore `intro` request: the first move-in on this account
 * (seilinkFlow.startSeilinkHost, while the host starts) or "Replay SeiLink
 * intro" in the companion menu.
 *
 * It loads her room (the same state the wallpaper will draw), plays
 * FirstLinkIntroView with the treatment from introStyle(), honours reduced
 * motion, and records what happened (seilink_intro: shown, then completed /
 * skipped / aborted, with the beat, a duration bucket and the host's state).
 * The intro counts as seen once it ended (completed or skipped) on a move-in
 * that worked; an aborted or failed one leaves it for the next try.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { seilinkResolver } from '@shared/seilinkPack';
import { SEILINK_INTRO_EVENT, introDurationBucket, type IntroHost } from '@shared/seilinkIntroTelemetry';
import { sei } from '../../../lib/ipcClient';
import { useDataStore } from '../../../lib/stores/useDataStore';
import type { SeilinkIntroRequest } from '../../../lib/stores/useSeilinkStore';
import { introStyle, markIntroSeen } from '../../../lib/seilink/introPref';
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

function track(props: Record<string, string | number | boolean | null>): void {
  try {
    sei.track(SEILINK_INTRO_EVENT, props);
  } catch {
    /* analytics must never disrupt SeiLink */
  }
}

export default function FirstLinkIntro(props: { request: SeilinkIntroRequest; onDone(): void }): React.ReactElement | null {
  const { request, onDone } = props;
  const character = useDataStore((s) => s.characters.find((c) => c.id === request.characterId) ?? null);
  const [room, setRoom] = useState<IntroRoom | null | undefined>(undefined);
  const [use, setUse] = useState<'auto' | 'sei' | 'imported'>('auto');
  const [answer, setAnswer] = useState<boolean | null>(null);
  const style = useMemo(() => introStyle(), []);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const answerRef = useRef<boolean | null>(null);
  const base = useMemo(
    () => ({ character_id: request.characterId, trigger: request.trigger, entry: request.entry, style, reduced_motion: reduced }),
    [request, style, reduced],
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

  useEffect(() => {
    let dead = false;
    void request.outcome.then(
      (ok) => {
        answerRef.current = ok;
        if (!dead) setAnswer(ok);
      },
      () => {
        answerRef.current = false;
        if (!dead) setAnswer(false);
      },
    );
    return () => {
      dead = true;
    };
  }, [request.outcome]);

  const shown = room !== undefined;
  useEffect(() => {
    if (shown) track({ ...base, action: 'shown' });
  }, [shown, base]);

  if (room === undefined) return null;

  const onFinish = (end: IntroFinish): void => {
    const host: IntroHost = request.trigger === 'replay' ? 'none' : answerRef.current === null ? 'pending' : answerRef.current ? 'ok' : 'failed';
    track({ ...base, action: end.action, beat: end.beat, duration_bucket: introDurationBucket(end.elapsedMs), host });
    if (request.trigger === 'first_link' && end.action !== 'aborted') {
      // Seen once the move-in worked; a start still pending is checked when it answers.
      void request.outcome.then((ok) => ok && markIntroSeen(), () => undefined);
    }
    onDone();
  };

  return (
    <FirstLinkIntroView
      style={style}
      reduced={reduced}
      characterId={request.characterId}
      name={character?.name ?? ''}
      room={room}
      portrait={character?.portrait_image ?? null}
      use={use}
      answer={request.trigger === 'replay' ? true : answer}
      onFinish={onFinish}
    />
  );
}
