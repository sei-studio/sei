/**
 * McDashboardPanel — the Minecraft dashboard surface (260721): a live view
 * of the summoned companion styled after Minecraft's own inventory screen (a
 * deliberate, contained exception to the app design tokens, per spec).
 *
 * Vanilla treatment (260721): the panel reads as the real Java Edition
 * inventory dialog. A light-gray (#c6c6c6 family) window with pixel-bevel
 * borders sits over a darkened backdrop; slots are dark inset bevels holding
 * REAL item textures (served by main from prismarine-viewer's bundled
 * per-version folders over the local skin server, /mcassets/...); a
 * skinview3d player-model viewport shows the companion's actual skin in the
 * dark window beside the armor column, like the real inventory. A second
 * gray window frames the minimap + activity line + coordinates.
 *
 * Fallbacks are graceful at every step: no skin server / missing texture
 * (the <img> 404s) -> the slot keeps the original text-label rendering; no
 * WebGL -> the avatar window stays empty.
 *
 * Mounts from ChatScreen inside the shared GameSurface chrome in the game
 * area on top of the chat (260721); GameSurface's "V" provides the
 * expand-over-chat, its "x" ends the session (disconnect). There is no
 * hide/minimize: while the bot is online this surface is simply open.
 * Telemetry: useMcDashboardStore (mcdash:snapshot pushes).
 */

import React, { useEffect, useState } from 'react';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useMcDashLifecycle } from './useMcDashLifecycle';
import { McDashMinimap } from './McDashMinimap';
import { McDashAvatar } from './McDashAvatar';
import { HeartsRow, FoodRow } from './McDashVitals';
import { useSkinServerBase, extractMcVersion, mcItemIconUrl, mcSkinUrl } from './mcAssetSource';
import { effectiveMcUsername } from '@shared/characterSchema';
import type { McDashItem } from '@shared/mcDashboardIpc';
import styles from './McDashboardPanel.module.css';

export interface McDashboardPanelProps {
  characterId: string;
}

/** mineflayer player-window slot ranges. */
const MAIN_SLOTS = Array.from({ length: 27 }, (_, i) => 9 + i);
const HOTBAR_SLOTS = Array.from({ length: 9 }, (_, i) => 36 + i);
const ARMOR_SLOTS = [5, 6, 7, 8]; // head, chest, legs, feet
const OFFHAND_SLOT = 45;

const ARMOR_HINTS: Record<number, string> = {
  5: 'head',
  6: 'chest',
  7: 'legs',
  8: 'feet',
  45: 'off hand',
};

function itemLabel(name: string): string {
  return name.replace(/_/g, ' ');
}

/**
 * One inventory slot. When an icon URL is available the slot renders the
 * real 16x16 item texture scaled up pixelated; if the texture 404s (the
 * server misses that item for the bundled version) the slot falls back to
 * the original text-label rendering.
 */
function Slot({
  item,
  iconUrl,
  hint,
  held,
}: {
  item: McDashItem | undefined;
  iconUrl: string | null;
  hint?: string;
  held?: boolean;
}): React.ReactElement {
  const [iconFailed, setIconFailed] = useState(false);
  useEffect(() => {
    setIconFailed(false);
  }, [iconUrl]);
  const showIcon = !!item && !!iconUrl && !iconFailed;
  return (
    <div
      className={held ? `${styles.slot} ${styles.slotHeld}` : styles.slot}
      title={item ? `${itemLabel(item.name)} x${item.count}` : hint}
    >
      {item ? (
        <>
          {showIcon ? (
            <img
              className={styles.slotIcon}
              src={iconUrl}
              alt={itemLabel(item.name)}
              draggable={false}
              onError={() => setIconFailed(true)}
            />
          ) : (
            <span className={styles.slotLabel}>{itemLabel(item.name)}</span>
          )}
          {item.count > 1 ? <span className={styles.slotCount}>{item.count}</span> : null}
        </>
      ) : hint ? (
        <span className={styles.slotHint}>{hint}</span>
      ) : null}
    </div>
  );
}

function prettyDimension(d: string): string {
  if (d.includes('nether')) return 'the nether';
  if (d.includes('end')) return 'the end';
  return 'overworld';
}

export function McDashboardPanel({ characterId }: McDashboardPanelProps): React.ReactElement {
  useMcDashLifecycle(characterId);
  const snapshot = useMcDashboardStore((s) => s.snapshots[characterId] ?? null);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const lan = useDataStore((s) => s.lan);
  const assetBase = useSkinServerBase();
  const name = character?.name ?? 'Companion';

  // Texture version rides the LAN world's reported MC version; main snaps it
  // to the closest bundled texture folder (newest when unknown).
  const mcVersion = extractMcVersion(lan.kind === 'open' ? lan.versionName : undefined);
  const iconUrl = (item: McDashItem | undefined): string | null =>
    item && assetBase ? mcItemIconUrl(assetBase, mcVersion, item.name) : null;
  const skinUrl = character && assetBase ? mcSkinUrl(assetBase, effectiveMcUsername(character)) : null;

  const bySlot = new Map<number, McDashItem>();
  for (const it of snapshot?.items ?? []) bySlot.set(it.slot, it);

  return (
    <div className={styles.panel} aria-label={`${name}'s Minecraft dashboard`}>
      {/* ── Header bar (vanilla gray strip) ── */}
      <header className={styles.head}>
        <span className={styles.headTitle}>{name} in minecraft</span>
      </header>

      {snapshot ? (
        <div className={styles.body}>
          {/* ── Inventory dialog (the classic light-gray window) ── */}
          <section className={styles.dialog} aria-label={`${name}'s inventory`}>
            <div className={styles.topRow}>
              <div className={styles.armorCol}>
                {ARMOR_SLOTS.map((s) => {
                  const it = bySlot.get(s);
                  return <Slot key={s} item={it} iconUrl={iconUrl(it)} hint={ARMOR_HINTS[s]} />;
                })}
              </div>
              <McDashAvatar skinUrl={skinUrl} name={name} width={112} height={144} />
              <div className={styles.sideCol}>
                <HeartsRow health={snapshot.health} />
                <FoodRow food={snapshot.food} />
                <div className={styles.sideSpacer} />
                <div className={styles.offhandRow}>
                  {(() => {
                    const it = bySlot.get(OFFHAND_SLOT);
                    return <Slot item={it} iconUrl={iconUrl(it)} hint={ARMOR_HINTS[OFFHAND_SLOT]} />;
                  })()}
                </div>
              </div>
            </div>

            <div className={styles.invTitle}>inventory</div>
            <div className={styles.invGrid}>
              {MAIN_SLOTS.map((s) => {
                const it = bySlot.get(s);
                return <Slot key={s} item={it} iconUrl={iconUrl(it)} />;
              })}
            </div>
            <div className={styles.hotbarRow}>
              {HOTBAR_SLOTS.map((s) => {
                const it = bySlot.get(s);
                return (
                  <Slot
                    key={s}
                    item={it}
                    iconUrl={iconUrl(it)}
                    held={!!it && !!snapshot.held && it.name === snapshot.held}
                  />
                );
              })}
            </div>
          </section>

          {/* ── Map dialog (gray GUI framing around the minimap) ── */}
          <section className={styles.dialog} aria-label="Minimap">
            <McDashMinimap map={snapshot.map} yaw={snapshot.yaw} sizePx={264} />
            <div className={styles.activity} aria-live="polite">
              {snapshot.activity}
            </div>
            <div className={styles.posLine}>
              {Math.round(snapshot.pos.x)} {Math.round(snapshot.pos.y)}{' '}
              {Math.round(snapshot.pos.z)}
              <span className={styles.dim}> {prettyDimension(snapshot.dimension)}</span>
            </div>
          </section>
        </div>
      ) : (
        <div className={styles.waiting}>waiting for {name}...</div>
      )}
    </div>
  );
}
