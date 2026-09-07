/**
 * AvatarView (260817) — renders whichever avatar model the character has
 * imported: a real Live2D Cubism model (Live2DView) or a simple layered rig
 * (RigView), chosen by the manifest's `kind`. Hosts pass the shared surface
 * contract once and never care which format is behind it; both the profile
 * preview and the overlay tile use this instead of Live2DView directly.
 *
 * Fetches the manifest itself (one tiny JSON read) because the overlay
 * window has no zustand manifest cache, and subscribes to the manifest
 * broadcast so a Replace import that changes format swaps the view live.
 */
import React, { useEffect, useState } from 'react';
import type { AvatarCamera, AvatarEmotion } from '@shared/ipc';
import { sei } from '../ipcClient';
import { Live2DView } from '../live2d/Live2DView';
import { RigView } from '../rig/RigView';

export interface AvatarViewProps {
  characterId: string;
  speaking?: boolean;
  levelRef?: React.MutableRefObject<number>;
  /** Emotion of the line being spoken; Live2D models map it through their
   * expression table, a rig has no expressions and ignores it. */
  emotion?: AvatarEmotion | null;
  camera?: AvatarCamera | null;
  className?: string;
  onStatus?: (status: 'loading' | 'ready' | 'error') => void;
}

export function AvatarView(props: AvatarViewProps): React.ReactElement | null {
  const { characterId, onStatus } = props;
  const [kind, setKind] = useState<'live2d' | 'rig' | 'none' | null>(null);

  useEffect(() => {
    setKind(null);
    let cancelled = false;
    void sei
      .avatarGet(characterId)
      .then((m) => {
        if (!cancelled) setKind(m ? (m.kind ?? 'live2d') : 'none');
      })
      .catch(() => {
        if (!cancelled) setKind('none');
      });
    const off = sei.onAvatarManifest?.((update) => {
      if (update.characterId !== characterId) return;
      setKind(update.manifest ? (update.manifest.kind ?? 'live2d') : 'none');
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [characterId]);

  useEffect(() => {
    if (kind === null) onStatus?.('loading');
    if (kind === 'none') onStatus?.('error');
    // 'live2d' / 'rig': the mounted view owns the status from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  if (kind === 'rig') {
    const { emotion: _emotion, ...rest } = props;
    return <RigView {...rest} />;
  }
  if (kind === 'live2d') return <Live2DView {...props} />;
  return null;
}
