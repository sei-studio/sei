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
 * expand-over-chat, its "x" ends the session AND closes the surface. The
 * controls window's own Disconnect (260725) ends the session but KEEPS the
 * surface, falling back to the Minecraft launch panel so relaunching is one
 * click. There is no hide/minimize: while the bot is online this surface is
 * simply open.
 * Telemetry: useMcDashboardStore (mcdash:snapshot pushes).
 */

import React, { useEffect, useState } from 'react';
import { useMcDashboardStore } from '../../lib/stores/useMcDashboardStore';
import { useDataStore } from '../../lib/stores/useDataStore';
import { sei } from '../../lib/ipcClient';
import { useMcDashLifecycle } from './useMcDashLifecycle';
import { McDashMinimap } from './McDashMinimap';
import { McDashAvatar } from './McDashAvatar';
import { HeartsRow, FoodRow } from './McDashVitals';
import { useSkinServerBase, extractMcVersion, mcItemIconUrl, mcSkinUrl } from './mcAssetSource';
import { effectiveMcUsername } from '@shared/characterSchema';
import type { McDashItem } from '@shared/mcDashboardIpc';
import type { McGameMode } from '@shared/ipc';
import styles from './McDashboardPanel.module.css';

export interface McDashboardPanelProps {
  characterId: string;
}

/** mineflayer player-window slot ranges. */
const MAIN_SLOTS = Array.from({ length: 27 }, (_, i) => 9 + i);
const HOTBAR_SLOTS = Array.from({ length: 9 }, (_, i) => 36 + i);
const ARMOR_SLOTS = [5, 6, 7, 8]; // head, chest, legs, feet
const OFFHAND_SLOT = 45;

/** "oak_log" → "Oak Log" (item names are title case in game). */
function itemLabel(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** "gathering oak logs..." → "Gathering oak logs...". */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One inventory slot. When an icon URL is available the slot renders the
 * real 16x16 item texture scaled up pixelated; if the texture 404s (the
 * server misses that item for the bundled version) the slot falls back to
 * the original text-label rendering.
 *
 * 260725: empty slots render EMPTY. The armor/off-hand placeholder captions
 * ("head", "off hand") are gone; the vanilla screen shows silhouettes, not
 * words, and the tiny text read as clutter.
 */
function Slot({
  item,
  iconUrl,
  held,
}: {
  item: McDashItem | undefined;
  iconUrl: string | null;
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
      title={item ? `${itemLabel(item.name)} x${item.count}` : undefined}
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
      ) : null}
    </div>
  );
}

function prettyDimension(d: string): string {
  if (d.includes('nether')) return 'The Nether';
  if (d.includes('end')) return 'The End';
  return 'Overworld';
}

/** Hover copy for the control buttons (260725). No em dashes: user copy. */
const CONTROL_DESCRIPTIONS: Record<string, string> = {
  pause: 'Freezes your companion in the game. They stand still and stop thinking until you unpress it.',
  reactive: 'The AI follows simple instructions. Does not act without your command. Costs less usage.',
  proactive: 'The AI plays Minecraft alongside you. Can act without your command. Costs more usage.',
  disconnect: 'Your companion leaves the world. You can launch them back in whenever you want.',
};

/**
 * Minimap edge, in px. Matched to the inventory grid (9 slots x 36px) so the
 * map window reads as the same size as the inventory window beside it.
 */
const MINIMAP_PX = 324;

export function McDashboardPanel({ characterId }: McDashboardPanelProps): React.ReactElement {
  useMcDashLifecycle(characterId);
  const snapshot = useMcDashboardStore((s) => s.snapshots[characterId] ?? null);
  const controls = useMcDashboardStore((s) => s.controls[characterId]);
  const storeSetPaused = useMcDashboardStore((s) => s.setPaused);
  const storeSetMode = useMcDashboardStore((s) => s.setMode);
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const lan = useDataStore((s) => s.lan);
  const assetBase = useSkinServerBase();
  const name = character?.name ?? 'Companion';

  // 260725 runtime controls: absent entry == the per-summon defaults
  // (unpaused, proactive). Never persisted; the store drops the entry when
  // the session ends.
  const paused = controls?.paused ?? false;
  const mode: McGameMode = controls?.mode ?? 'proactive';
  /**
   * 260725 Disconnect: the bot leaves the world and this surface falls back to
   * the Minecraft LAUNCH panel (rather than closing the game area, which is
   * what GameSurface's "x" does). The status flip is optimistic and must land
   * BEFORE the launch flag: ChatScreen force-clears `launch` while the bot is
   * online, so setting it first would be swallowed. Both are zustand writes in
   * one tick, so the surface re-renders once, already on the launch panel.
   */
  const disconnect = (): void => {
    useDataStore.getState().setStatus({ kind: 'idle', characterId });
    useMcDashboardStore.getState().setLaunch(characterId, true);
    void sei.stop(characterId).catch(() => {
      // The session is already gone / the port dropped; the UI is correct.
    });
  };

  // Which control button's description shows in the caption area (hover/focus).
  const [controlHint, setControlHint] = useState<string | null>(null);
  const hintHandlers = (key: string): Record<string, () => void> => ({
    onMouseEnter: () => setControlHint(key),
    onMouseLeave: () => setControlHint(null),
    onFocus: () => setControlHint(key),
    onBlur: () => setControlHint(null),
  });

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
        <span className={styles.headTitle}>{name} in Minecraft</span>
      </header>

      {snapshot ? (
        <div className={styles.body}>
          {/* ── Status window (260725): full-width strip translating what the
              AI is doing right now (activityLabel in the bot: "gathering oak
              logs...", "thinking", "idling"; "paused" is renderer state). ── */}
          <section className={`${styles.dialog} ${styles.statusDialog}`} aria-label="Status">
            <span className={styles.statusTitle}>Status</span>
            <span className={styles.statusText} aria-live="polite">
              {paused ? 'Paused' : sentenceCase(snapshot.activity || 'idling')}
            </span>
          </section>

          {/* ── Inventory dialog (the classic light-gray window) ── */}
          <section className={styles.dialog} aria-label={`${name}'s inventory`}>
            <div className={styles.topRow}>
              <div className={styles.armorCol}>
                {ARMOR_SLOTS.map((s) => {
                  const it = bySlot.get(s);
                  return <Slot key={s} item={it} iconUrl={iconUrl(it)} />;
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
                    return <Slot item={it} iconUrl={iconUrl(it)} />;
                  })()}
                </div>
              </div>
            </div>

            <div className={styles.invTitle}>Inventory</div>
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

          {/* ── Map dialog (gray GUI framing around the minimap). The old
              activity line moved to the dedicated status window above. ── */}
          <section className={styles.dialog} aria-label="Minimap">
            <McDashMinimap map={snapshot.map} yaw={snapshot.yaw} sizePx={MINIMAP_PX} />
            <div className={styles.posLine}>
              {Math.round(snapshot.pos.x)} {Math.round(snapshot.pos.y)}{' '}
              {Math.round(snapshot.pos.z)}
              <span className={styles.dim}> {prettyDimension(snapshot.dimension)}</span>
            </div>
          </section>

          {/* ── Controls window (260725): the pause toggle (pressed-in bevel
              while paused, like a vanilla toggle) over the two runtime play
              modes under a "Mode" subtitle. Mode is never persisted: every
              summon starts proactive. The caption under the buttons shows the
              hovered/focused button's description. ── */}
          <section
            className={`${styles.dialog} ${styles.controlsDialog}`}
            aria-label="Companion controls"
          >
            <button
              type="button"
              className={paused ? `${styles.mcButton} ${styles.mcButtonOn}` : styles.mcButton}
              aria-pressed={paused}
              onClick={() => storeSetPaused(characterId, !paused)}
              {...hintHandlers('pause')}
            >
              Pause
            </button>
            <div className={styles.invTitle}>Mode</div>
            <button
              type="button"
              className={mode === 'reactive' ? `${styles.mcButton} ${styles.mcButtonOn}` : styles.mcButton}
              aria-pressed={mode === 'reactive'}
              onClick={() => storeSetMode(characterId, 'reactive')}
              {...hintHandlers('reactive')}
            >
              Reactive
            </button>
            <button
              type="button"
              className={mode === 'proactive' ? `${styles.mcButton} ${styles.mcButtonOn}` : styles.mcButton}
              aria-pressed={mode === 'proactive'}
              onClick={() => storeSetMode(characterId, 'proactive')}
              {...hintHandlers('proactive')}
            >
              Proactive
            </button>
            <div className={styles.controlsHint} aria-live="polite">
              {controlHint ? CONTROL_DESCRIPTIONS[controlHint] : ''}
            </div>
            <button
              type="button"
              className={`${styles.mcButton} ${styles.disconnectBtn}`}
              onClick={disconnect}
              {...hintHandlers('disconnect')}
            >
              Disconnect
            </button>
          </section>
        </div>
      ) : (
        <div className={styles.waiting}>Waiting for {name}...</div>
      )}
    </div>
  );
}
