/**
 * AvatarPane (260804) — the character profile's "Avatar" tab: how this
 * companion appears on the always-on-top overlay.
 *
 * Two sub-tabs:
 *  - Static: tile shape ("frame", circle-only today) + "Always bright"
 *    (disables the talking indicator). USER preferences — they live in
 *    UserConfig.avatar_prefs (sparse, per character), never in
 *    character.metadata, so they work on foreign characters and never sync.
 *  - Live2D (beta): import/replace/remove a Live2D model zip and preview it
 *    live (idle behaviors running). The model is stored locally under the
 *    profile's avatars dir; nothing reaches the cloud.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { AvatarPrefs } from '@shared/characterSchema';
import { useT } from '../../lib/i18n';
import { sei } from '../../lib/ipcClient';
import { useUiStore } from '../../lib/stores/useUiStore';
import { useAvatarStore } from '../../lib/stores/useAvatarStore';
import { Seg } from '../Seg';
import { Toggle } from '../Toggle';
import { Live2DView } from '../../lib/live2d/Live2DView';
import styles from './AvatarPane.module.css';

/** Client-side mirror of avatarStore's zip cap (the server-side check is the
 * authority; this just fails fast with a readable message). */
const ZIP_MAX_BYTES = 128 * 1024 * 1024;

interface AvatarPaneProps {
  characterId: string;
}

type SubTab = 'static' | 'live2d';

export function AvatarPane({ characterId }: AvatarPaneProps): React.ReactElement {
  const t = useT();
  const prefs = useUiStore((s) => s.avatarPrefsByCharacter[characterId]);
  const setAvatarPrefsFor = useUiStore((s) => s.setAvatarPrefsFor);
  // The chosen sub-tab is itself a per-character preference (avatar_prefs.tab):
  // someone maintaining a Live2D model should land back on that tab.
  const [sub, setSub] = useState<SubTab>(
    () => useUiStore.getState().avatarPrefsByCharacter[characterId]?.tab ?? 'static',
  );
  useEffect(() => {
    setSub(useUiStore.getState().avatarPrefsByCharacter[characterId]?.tab ?? 'static');
  }, [characterId]);
  const manifest = useAvatarStore((s) => s.manifests[characterId]);
  const ensureManifest = useAvatarStore((s) => s.ensure);
  const setManifest = useAvatarStore((s) => s.setManifest);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    ensureManifest(characterId);
  }, [characterId, ensureManifest]);

  // Optimistic store write + read-modify-write persist (avatar_prefs is a
  // renderer-settable key; the record is replaced whole, so merge over the
  // freshest on-disk copy rather than any cached one).
  const persistPrefs = async (next: AvatarPrefs): Promise<void> => {
    const prev = prefs;
    setAvatarPrefsFor(characterId, next);
    try {
      const cfg = await sei.getConfig();
      await sei.saveConfig({
        ...cfg,
        avatar_prefs: { ...(cfg.avatar_prefs ?? {}), [characterId]: next },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AvatarPane] saveConfig (avatar_prefs) failed', err);
      setAvatarPrefsFor(characterId, prev ?? {});
    }
  };

  const onPickZip = async (file: File): Promise<void> => {
    setImportError(null);
    if (!/\.zip$/i.test(file.name)) {
      setImportError(t('That file is not a .zip archive.'));
      return;
    }
    if (file.size > ZIP_MAX_BYTES) {
      setImportError(t('That archive is too large.'));
      return;
    }
    setImporting(true);
    try {
      const bytes = await file.arrayBuffer();
      const imported = await sei.avatarImport(characterId, bytes);
      setManifest(characterId, imported);
      setPreviewStatus('loading');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AvatarPane] import failed', err);
      setImportError(
        t('Could not read that model. It needs a .model3.json, a .moc3 and its textures.'),
      );
    } finally {
      setImporting(false);
    }
  };

  const onRemove = async (): Promise<void> => {
    try {
      await sei.avatarRemove(characterId);
      setManifest(characterId, null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AvatarPane] remove failed', err);
    }
  };

  return (
    <div className={styles.pane}>
      <div className={styles.subTabs}>
        <Seg<SubTab>
          aria-label={t('Avatar type')}
          options={[
            { value: 'static', label: t('Static') },
            { value: 'live2d', label: t('Live2D (beta)') },
          ]}
          value={sub}
          onChange={(next) => {
            setSub(next);
            void persistPrefs({ ...(prefs ?? {}), tab: next });
          }}
        />
      </div>

      {sub === 'static' ? (
        <div className={styles.section}>
          <p className={styles.hint}>
            {t('How this companion looks on the floating avatar. Turn the avatar on in Settings.')}
          </p>
          <div className={styles.row}>
            <span className={styles.label}>{t('Frame')}</span>
            <Seg<'circle' | 'square'>
              aria-label={t('Frame')}
              options={[
                { value: 'circle', label: t('Circle') },
                { value: 'square', label: t('Square') },
              ]}
              value={prefs?.frame ?? 'circle'}
              onChange={(frame) => void persistPrefs({ ...(prefs ?? {}), frame })}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>{t('Always bright')}</span>
            <Toggle
              aria-label={t('Always bright')}
              on={prefs?.always_bright === true}
              onChange={() =>
                void persistPrefs({ ...(prefs ?? {}), always_bright: !(prefs?.always_bright === true) })
              }
            />
          </div>
          <p className={styles.subHint}>
            {t('Always bright keeps the picture lit and turns off the talking indicator.')}
          </p>
        </div>
      ) : (
        <div className={styles.section}>
          {manifest ? (
            <>
              <div className={styles.previewBox}>
                <Live2DView
                  characterId={characterId}
                  className={styles.preview}
                  onStatus={setPreviewStatus}
                />
                {previewStatus === 'loading' ? (
                  <span className={styles.previewNote}>{t('Loading model...')}</span>
                ) : null}
                {previewStatus === 'error' ? (
                  <span className={styles.previewNote}>{t('This model could not be rendered.')}</span>
                ) : null}
              </div>
              <p className={styles.subHint}>
                {t('{name}, {count} expressions', {
                  name: manifest.name,
                  count: String(manifest.expressions.length),
                })}
              </p>
              <div className={styles.btnRow}>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={importing}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {importing ? t('Importing...') : t('Replace')}
                </button>
                <button
                  type="button"
                  className={styles.btnDanger}
                  disabled={importing}
                  onClick={() => void onRemove()}
                >
                  {t('Remove')}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className={styles.hint}>
                {t(
                  'Give this companion a Live2D body on the floating avatar. Import a Live2D model as a .zip: it should contain a .model3.json, a .moc3, textures, and optionally expressions.',
                )}
              </p>
              <button
                type="button"
                className={styles.uploadBox}
                disabled={importing}
                onClick={() => fileInputRef.current?.click()}
              >
                <span className={styles.uploadTitle}>
                  {importing ? t('Importing...') : t('Upload Live2D model (.zip)')}
                </span>
                <span className={styles.uploadSub}>
                  {t('The model stays on this computer. It is never uploaded.')}
                </span>
              </button>
            </>
          )}
          {importError ? (
            <p className={styles.error} role="alert">
              {importError}
            </p>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onPickZip(f);
            }}
          />
        </div>
      )}
    </div>
  );
}
