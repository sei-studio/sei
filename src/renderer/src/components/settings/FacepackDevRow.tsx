/**
 * FacepackDevRow — Settings → About entry for the desktop companion facepack
 * pilot (261028). Renders NOTHING unless main reports the dev flag on
 * (unpackaged + SEI_FACEPACK_DIR), so a packaged build's About is unchanged.
 *
 * Two things: an Open button for the dev preview window, and each pack's
 * `attribution` lines (Lyra's frames come from Talking Head Anime 3, CC BY
 * 4.0, which requires the credit wherever the frames are shown). When packs
 * ship to users this credit must render unconditionally for the packs that
 * are installed, not behind the dev flag.
 *
 * Dev-only copy is plain English on purpose (not in the i18n tables): no
 * user ever sees it.
 */
import React, { useEffect, useState } from 'react';
import type { FacepackDevInfo } from '@shared/facepack';
import { sei } from '../../lib/ipcClient';
import { Button } from '../Button';
import styles from '../../screens/SettingsScreen.module.css';

export function FacepackDevRowView({
  info,
  onOpen,
}: {
  info: FacepackDevInfo | null;
  onOpen: () => void;
}): React.ReactElement | null {
  if (!info?.enabled) return null;
  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>Face preview (dev)</span>
        <Button kind="ghost" size="sm" onClick={onOpen}>
          Open
        </Button>
      </div>
      {info.packs
        .filter((p) => p.attribution.length > 0)
        .map((p) => (
          <p key={p.id} className={styles.helper}>
            {p.character} face: {p.attribution.join(' ')}
          </p>
        ))}
    </>
  );
}

export function FacepackDevRow(): React.ReactElement | null {
  const [info, setInfo] = useState<FacepackDevInfo | null>(null);
  useEffect(() => {
    let live = true;
    void sei
      .facepackInfo?.()
      .then((i) => {
        if (live) setInfo(i ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return <FacepackDevRowView info={info} onOpen={() => void sei.facepackOpenPreview?.()} />;
}
