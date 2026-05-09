/**
 * CharacterPage — two-column character detail screen with Description card,
 * Edit affordance (modal), Summon CTA, stats grid, and model row.
 *
 * Layout: 320px portrait column + 1fr details column, 36px gap. Padding 24×40×40.
 * Source: 04-UI-SPEC.md §CharacterPage; D-49..D-53; quick task 260508-mun.
 *
 * Tabs (Persona prompt / Logs) were removed in 260508-mun. The standalone
 * Persona prompt tab is replaced by the Edit modal (name + description +
 * persona_prompt). The Logs tab is replaced by the global bottom LogsBar.
 *
 * Stats grid: Last launched / Total playtime / Created. '—' for never-summoned (D-51).
 *
 * Model row (D-52):
 *  - idle/connecting → green dot + "Ready" / "Connecting…" + mono model id.
 *  - online          → green dot + "Online · {uptime}" + mono model id.
 *  - error           → red dot + plain-English message + "TRY AGAIN" link.
 *
 * Sui (id === 'sui') gates:
 *  - No Edit button rendered (260508-mun item 2).
 *  - No Delete button rendered (D-49; existing).
 *
 * T-04-37 mitigation: on mount, if the character isn't in store, fetch via
 * `sei.getCharacter` (and let main return null on missing → "Character not
 * found" stub).
 */

import React, { useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { Button } from '../components/Button';
import { PixelPortrait } from '../components/PixelPortrait';
import { DeleteConfirmModal } from '../components/DeleteConfirmModal';
import { EditCharacterModal } from '../components/EditCharacterModal';
import { BackIcon, SparkleIcon } from '../components/icons';
import { pickPalette } from '../lib/portraitPalettes';
import { ERROR_COPY } from '../lib/errors';
import type { Character } from '@shared/characterSchema';
import styles from './CharacterPage.module.css';

const MODEL_ID = 'claude-haiku-4-5-20251001';

function fmtMs(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

function fmtUptime(uptimeMs: number): string {
  if (uptimeMs < 1000) return '0s';
  if (uptimeMs < 60_000) return `${Math.floor(uptimeMs / 1000)}s`;
  if (uptimeMs < 3_600_000) {
    const m = Math.floor(uptimeMs / 60_000);
    const s = Math.floor((uptimeMs % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(uptimeMs / 3_600_000);
  const m = Math.floor((uptimeMs % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

export interface CharacterPageProps {
  id: string;
}

export function CharacterPage({ id }: CharacterPageProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const setPendingSummon = useUiStore((s) => s.setPendingSummon);
  const characters = useDataStore((s) => s.characters);
  const summon = useDataStore((s) => s.summon);
  const lan = useDataStore((s) => s.lan);
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  const removeCharacter = useDataStore((s) => s.removeCharacter);

  const character: Character | undefined = characters.find((c) => c.id === id);
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);
  const [editing, setEditing] = useState<boolean>(false);

  // T-04-37: rehydrate the character from disk on mount if not in the store.
  useEffect(() => {
    if (!character) void refreshCharacter(id);
  }, [id, character, refreshCharacter]);

  if (!character) {
    return (
      <div className={styles.notFound}>
        <p>Character not found.</p>
        <Button kind="primary" size="md" onClick={() => navigate({ kind: 'home' })}>
          Back to Home
        </Button>
      </div>
    );
  }

  const isDefault = character.id === 'sui';
  const themeAttr = document.documentElement.getAttribute('data-theme');
  const theme: 'light' | 'dark' = themeAttr === 'dark' ? 'dark' : 'light';
  const palette = pickPalette(character.id + character.name, theme);

  const isActive = summon.kind === 'online' && summon.characterId === id;
  const isErrored = summon.kind === 'error' && summon.characterId === id;
  const isConnecting = summon.kind === 'connecting';

  const handleSummonClick = (): void => {
    if (isActive) {
      void sei.stop();
      return;
    }
    if (lan.kind === 'connected') {
      void sei.summon(id);
      return;
    }
    setPendingSummon(id);
    openModal({ kind: 'lan', mode: 'searching' });
  };

  const handleConfirmDelete = async (): Promise<void> => {
    try {
      await sei.deleteCharacter(id);
      removeCharacter(id);
      navigate({ kind: 'home' });
    } catch (err) {
      // Plan 09 will surface this through ERROR_COPY[errorClass]; for v1 we log.
      // eslint-disable-next-line no-console
      console.error('[CharacterPage] delete failed', err);
    }
  };

  // GUI-05: error label uses centralized ERROR_COPY[ErrorClass] copy, NOT
  // the raw `summon.message` (which can be a stack trace fragment).
  const modelLabel = isActive
    ? `Online · ${fmtUptime(summon.uptimeMs)}`
    : summon.kind === 'error' && summon.characterId === id
      ? (ERROR_COPY[summon.error] ?? ERROR_COPY.BOT_CRASH)
      : isConnecting
        ? 'Connecting…'
        : 'Ready';
  const modelDotColor = isErrored ? 'var(--red)' : isConnecting ? 'var(--warn)' : 'var(--green)';

  return (
    <div className={styles.root}>
      {/* 260508-nkk: full-bleed pixel-art wallpaper. The same procedural
          sprite is rendered behind the page content (huge size → CSS
          image-rendering:pixelated produces the hero wallpaper effect)
          AND inside the .portraitCard 320×320 box below, so the boxed
          portrait composition is preserved. PixelPortrait is deterministic
          on (seed, palette) so both renders are pixel-identical at the
          12×12 grid level — only the upscale ratio differs. */}
      <div className={styles.bgArt} aria-hidden="true">
        <PixelPortrait
          seed={character.id + character.name}
          palette={palette}
          size={1600}
          portraitImage={character.portrait_image}
        />
      </div>

      <div className={styles.crumb}>
        <Button
          kind="quiet"
          size="sm"
          icon={<BackIcon size={14} />}
          onClick={() => navigate({ kind: 'home' })}
        >
          All characters
        </Button>
      </div>

      <div className={styles.cols}>
        <aside className={styles.left}>
          <div className={styles.portraitCard}>
            <PixelPortrait
              seed={character.id + character.name}
              palette={palette}
              size={320}
              portraitImage={character.portrait_image}
            />
          </div>
          <div className={styles.cta}>
            <Button
              kind={isActive ? 'ghost' : 'accent'}
              size="lg"
              fullWidth
              icon={isActive ? null : <SparkleIcon size={14} />}
              onClick={handleSummonClick}
              disabled={isConnecting && !isActive}
            >
              {isActive ? 'Stop' : 'Summon into Minecraft'}
            </Button>
            <div className={styles.secondaryRow}>
              {!isDefault ? (
                <Button kind="ghost" size="md" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              ) : null}
              {!isDefault ? (
                <Button
                  kind="ghost"
                  size="md"
                  onClick={() => setConfirmingDelete(true)}
                  className={styles.deleteBtn}
                >
                  Delete
                </Button>
              ) : null}
            </div>
          </div>
        </aside>

        <main className={styles.right}>
          <div className={styles.eyebrow}>{isDefault ? 'DEFAULT' : 'CUSTOM'}</div>
          <h1 className={styles.title}>{character.name}</h1>

          <div className={styles.card}>
            <div className={styles.cardEyebrow}>
              DESCRIPTION <span className={styles.tag}>For you</span>
            </div>
            <div className={styles.cardBody}>{character.description || '—'}</div>
          </div>

          <div className={styles.stats}>
            <div className={styles.stat}>
              <div className={styles.statEyebrow}>LAST LAUNCHED</div>
              <div className={styles.statValue}>{fmtDate(character.last_launched)}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statEyebrow}>TOTAL PLAYTIME</div>
              <div className={styles.statValue}>{fmtMs(character.playtime_ms)}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statEyebrow}>CREATED</div>
              <div className={styles.statValue}>{fmtDate(character.created)}</div>
            </div>
          </div>

          <div className={styles.modelRow}>
            <span className={styles.modelDot} style={{ background: modelDotColor }} />
            <span className={styles.modelLabel}>{modelLabel}</span>
            <span className={styles.modelSep}>·</span>
            <span className={styles.modelId}>{MODEL_ID}</span>
            {isErrored ? (
              <button type="button" className={styles.tryAgain} onClick={handleSummonClick}>
                TRY AGAIN
              </button>
            ) : null}
          </div>
        </main>
      </div>

      {confirmingDelete ? (
        <DeleteConfirmModal
          characterName={character.name}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            void handleConfirmDelete();
          }}
        />
      ) : null}

      {editing ? (
        <EditCharacterModal character={character} onClose={() => setEditing(false)} />
      ) : null}
    </div>
  );
}
