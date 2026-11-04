/**
 * Stand-in companion for the SeiLink desktop host until the real avatar
 * lands (hostAvatar.tsx): a soft silhouette that breathes at the frame cap,
 * holds still at 0, and hops when poked.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { HostAvatarProps } from './hostAvatar';
import styles from './SeilinkHost.module.css';

export function PlaceholderAvatar({ slot, fps, poke }: HostAvatarProps): React.ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [hop, setHop] = useState(0);

  useEffect(() => {
    if (!poke) return;
    setHop((h) => h + 1);
  }, [poke]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || fps <= 0) return;
    let raf = 0;
    let last = 0;
    const step = (t: number): void => {
      if (t - last >= 1000 / fps - 2) {
        last = t;
        const breathe = Math.sin(t / 900) * 0.012;
        el.style.transform = `scaleY(${1 + breathe}) translateY(${-breathe * 40}%)`;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [fps]);

  const h = Math.max(40, slot.height);
  return (
    <div className={styles.placeholder} style={{ width: h * 0.42, height: h }} data-seilink-hit>
      <div key={hop} className={hop ? `${styles.placeholderHop}` : undefined} style={{ width: '100%', height: '100%' }}>
        <div ref={bodyRef} className={styles.placeholderBody}>
          <div className={styles.placeholderHead} />
          <div className={styles.placeholderTorso} />
        </div>
      </div>
    </div>
  );
}
