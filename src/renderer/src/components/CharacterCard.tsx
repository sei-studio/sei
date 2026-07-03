/**
 * CharacterCard — tall portrait card (the "Summoning Terminal" grid tile).
 *
 * Mockup contract (ui.jsx .card): a 210/312 portrait card with a per-character
 * accent tint behind the portrait, a bottom scrim, an Oswald name + status
 * line, an accent bar that slides across the bottom on hover, corner brackets,
 * and a -7px hover lift. Quick-Summon (our feature, not in the mockup) stays as
 * a centered hover action; the sync pills + chips are preserved verbatim.
 *
 * Click on the card body → onOpen. Click on the Summon overlay → onSummon
 * (stopPropagation so the card click doesn't also fire).
 *
 * Source: .planning/UI-DESIGN-SYSTEM.md §Cards; mockup ui.jsx CharacterCard.
 */

import React from 'react';
import type { Character } from '@shared/characterSchema';
import { PixelPortrait } from './PixelPortrait';
import { Button } from './Button';
import { StatusPill } from './StatusPill';
import { SparkleIcon } from './icons';
import { pickPalette } from '../lib/portraitPalettes';
import { lastInteractionAt } from '../lib/lastInteraction';
import { useSyncStore } from '../lib/stores/useSyncStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useDataStore } from '../lib/stores/useDataStore';
import styles from './CharacterCard.module.css';

export interface CharacterCardProps {
  character: Character;
  theme: 'light' | 'dark';
  onOpen: () => void;
  onSummon: () => void;
  /** Stop this character's running bot (the hover CTA flips to "Unsummon"). */
  onUnsummon: () => void;
}

// Home-card status line: the bare date of the last interaction — an in-game
// session OR an in-app chat (#6) — e.g. "May 23, 2026", or "No activity yet"
// before either has happened. The date alone reads cleaner under the name; the
// full label still appears on the detail screen's stat cell.
function formatLast(iso: string | null): string {
  if (!iso) return 'No activity yet';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return 'No activity yet';
  }
}

export function CharacterCard({
  character: c,
  theme,
  onOpen,
  onSummon,
  onUnsummon,
}: CharacterCardProps): React.ReactElement {
  const palette = pickPalette(c.id + c.name, theme);
  const isDefault = c.is_default === true;
  // Per-character accent tint behind the portrait — derived from the seeded
  // palette so each card glows in its own hue (the mockup's `tint` field).
  const tint = palette[2] ?? palette[1] ?? 'var(--accent)';
  const lastActive = lastInteractionAt(c);
  const ready = lastActive != null;
  // Phase 11 D-18 — per-card sync pill driver. Defaults never sync (D-22), so
  // gate every read on !isDefault. Shallow-equality selectors mean a sibling
  // card's status flip never re-renders this one (T-11-16-02 mitigation).
  const syncStatusRaw = useSyncStore((s) =>
    isDefault ? undefined : s.pendingByUuid[c.id],
  );
  // A signed-out user has no cloud to sync to: saveCharacter still enqueues a
  // mirror op, but the drainer is gate-blocked (isCloudWriteAllowed === false),
  // so the op sits pending forever and the pill reads a permanent, meaningless
  // "SYNCING". Suppress the pill entirely unless signed in — the queue still
  // holds the op, so it surfaces (and drains) the moment the user authenticates.
  const signedIn = useAuthStore((s) => s.state.kind === 'signed_in');
  const syncStatus = signedIn ? syncStatusRaw : undefined;
  const retry = useSyncStore((s) => s.retry);
  // Is THIS character currently summoned (multi-summon)? Online OR connecting
  // counts so the card reflects the in-flight session immediately. The hover
  // CTA flips to an actionable red "Unsummon", and the card gets the summoned
  // frame + reflective glint (mirrors the IconRail avatar treatment).
  const isSummoned = useDataStore((s) => {
    const st = s.summons[c.id]?.kind;
    return st === 'online' || st === 'connecting';
  });

  return (
    <div
      className={`${styles.card} ${ready ? styles.live : ''} ${isSummoned ? styles.summoned : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Open ${c.name}`}
    >
      <div
        className={styles.bg}
        style={{
          background: `radial-gradient(120% 80% at 50% 22%, ${tint}6b, transparent 62%),
                       linear-gradient(180deg, var(--card-top), var(--card-bottom))`,
        }}
      />
      <div className={styles.portraitWrap}>
        <PixelPortrait
          seed={c.id + c.name}
          palette={palette}
          size={300}
          portraitImage={c.portrait_image}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      <div className={styles.scrim} />

      {/* Reflective glint sweep while summoned — same animation language as the
          CharacterPage "summon into Minecraft" deploy button. Clipped to the
          card by its own overflow:hidden so it can't bleed past the border. */}
      {isSummoned ? <span className={styles.summonGlint} aria-hidden="true" /> : null}

      {/*
        Phase 11 D-18 — sync pill. Sits top-right; absent once synced (no
        lingering 'SYNCED' badge). Defaults never show it (D-22).
      */}
      {!isDefault && syncStatus === 'syncing' ? (
        <div className={`${styles.syncPillOverlay} ${styles.syncPillOverlayPassive}`}>
          <StatusPill tone="pulse" label="SYNCING" size="tag" />
        </div>
      ) : null}
      {!isDefault && syncStatus === 'failed' ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void retry(c.id);
          }}
          aria-label={`Sync failed for ${c.name}, click to retry`}
          className={`${styles.syncPillOverlay} ${styles.syncPillOverlayButton}`}
        >
          <StatusPill tone="warn" label="SYNC FAILED · RETRY" size="tag" />
        </button>
      ) : null}

      <div className={styles.meta}>
        <div className={styles.name}>{c.name}</div>
        <div className={styles.metaLine}>
          <span className={`${styles.dot} ${ready ? styles.dotReady : ''}`} aria-hidden="true" />
          {formatLast(lastActive)}
        </div>
      </div>

      <div className={styles.hoverOverlay}>
        <Button
          kind={isSummoned ? 'danger' : 'accent'}
          size="md"
          icon={<SparkleIcon size={12} />}
          onClick={(e) => {
            e.stopPropagation();
            if (isSummoned) onUnsummon();
            else onSummon();
          }}
          aria-label={isSummoned ? `Disconnect ${c.name}` : `Play with ${c.name}`}
        >
          {isSummoned ? 'Disconnect' : 'Play'}
        </Button>
      </div>

      <span className={styles.bar} aria-hidden="true" />
      <span className="u-brk tl" aria-hidden="true" />
      <span className="u-brk tr" aria-hidden="true" />
      <span className="u-brk bl" aria-hidden="true" />
      <span className="u-brk br" aria-hidden="true" />
    </div>
  );
}
