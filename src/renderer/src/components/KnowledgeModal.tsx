/**
 * KnowledgeModal — per-character Knowledge manager (260725). Opened from the
 * companion settings gear menu (next to Reset memory / Unbind), available for
 * EVERY character (not just user-created ones).
 *
 * Two columns: left lists the stored entries (pencil = edit title/content,
 * trashcan = delete with a two-click confirm), right is an upload drop zone
 * whose top-right "Add text context" opens a small title/content form. All
 * content is plain text, extracted + sanitized in main; the list renders it
 * as text only.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useT } from '../lib/i18n';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import { KnowledgeDropZone } from './KnowledgeDropZone';
import { TextField } from './TextField';
import { FileTextIcon, NotePlusIcon, PencilIcon, TrashIcon } from './icons';
import type { KnowledgeEntryMeta } from '@shared/ipc';
import { KNOWLEDGE_COMPACT_SUGGEST_BYTES } from '@shared/ipc';
import styles from './KnowledgeModal.module.css';

export interface KnowledgeModalProps {
  characterId: string;
  characterName: string;
  onClose: () => void;
}

type FormState =
  | { mode: 'add' }
  | { mode: 'edit'; entryId: string };

/** Strip Electron's IPC wrapper so main's user-facing copy shows clean. */
function cleanError(err: unknown): string {
  const raw = (err as Error)?.message ?? String(err);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(KnowledgeExtractError|Error):\s*/, '');
}

export function KnowledgeModal({
  characterId,
  characterName,
  onClose,
}: KnowledgeModalProps): React.ReactElement {
  const t = useT();
  const [entries, setEntries] = useState<KnowledgeEntryMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formTitle, setFormTitle] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setEntries(await sei.knowledgeList(characterId));
    } catch (err) {
      setError(cleanError(err));
    }
  }, [characterId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
  const totalKb = Math.round(totalBytes / 1024);

  const addUpload = async (file: { title: string; content: string }): Promise<void> => {
    setError(null);
    try {
      await sei.knowledgeAdd(characterId, { title: file.title, content: file.content, source: 'upload' });
      await refresh();
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const openAddText = (): void => {
    setFormTitle('');
    setFormContent('');
    setForm({ mode: 'add' });
  };

  const openEdit = async (entryId: string): Promise<void> => {
    setError(null);
    try {
      const res = await sei.knowledgeRead(characterId, entryId);
      if (!res) {
        setError(t('This entry could not be read.'));
        return;
      }
      setFormTitle(res.meta.title);
      setFormContent(res.content);
      setForm({ mode: 'edit', entryId });
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const saveForm = async (): Promise<void> => {
    if (!form || formTitle.trim() === '' || formContent.trim() === '') return;
    setFormBusy(true);
    setError(null);
    try {
      if (form.mode === 'add') {
        await sei.knowledgeAdd(characterId, { title: formTitle.trim(), content: formContent, source: 'text' });
      } else {
        await sei.knowledgeUpdate(characterId, form.entryId, { title: formTitle.trim(), content: formContent });
      }
      setForm(null);
      await refresh();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setFormBusy(false);
    }
  };

  const remove = async (entryId: string): Promise<void> => {
    if (confirmDeleteId !== entryId) {
      setConfirmDeleteId(entryId);
      return;
    }
    setConfirmDeleteId(null);
    setError(null);
    try {
      await sei.knowledgeDelete(characterId, entryId);
      await refresh();
    } catch (err) {
      setError(cleanError(err));
    }
  };

  return (
    <ModalShell
      title={t("{name}'s knowledge", { name: characterName })}
      width={880}
      onClose={onClose}
      escClose
      scrimClose
      aria-label={t('Knowledge')}
    >
      <p className={styles.lede}>
        {t(
          'You can manually add things for the AI to know here. The AI has a separate internal memory storage.',
        )}
      </p>
      <div className={styles.columns}>
        <div className={styles.listCol}>
          {entries.length === 0 ? (
            <p className={styles.empty}>{t('No knowledge yet. Upload files or add text context.')}</p>
          ) : (
            entries.map((e) => (
              <div key={e.id} className={styles.row}>
                <span className={styles.rowIcon} aria-hidden="true">
                  <FileTextIcon size={16} />
                </span>
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>{e.title}</span>
                  <span className={styles.rowMeta}>
                    {Math.max(1, Math.round(e.bytes / 1024))} KB
                    {e.source === 'compacted' ? t(' · compacted') : e.source === 'text' ? t(' · text') : ''}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label={t('Edit {title}', { title: e.title })}
                    title={t('Edit')}
                    onClick={() => void openEdit(e.id)}
                  >
                    <PencilIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className={[styles.iconBtn, confirmDeleteId === e.id ? styles.iconBtnDanger : ''].join(' ')}
                    aria-label={
                      confirmDeleteId === e.id
                        ? t('Confirm delete {title}', { title: e.title })
                        : t('Delete {title}', { title: e.title })
                    }
                    title={confirmDeleteId === e.id ? t('Click again to delete') : t('Delete')}
                    onClick={() => void remove(e.id)}
                    onBlur={() => setConfirmDeleteId((id) => (id === e.id ? null : id))}
                  >
                    {confirmDeleteId === e.id ? <span className={styles.confirmDel}>{t('Delete?')}</span> : <TrashIcon size={14} />}
                  </button>
                </div>
              </div>
            ))
          )}
          {entries.length > 0 ? (
            <div className={styles.totals}>
              {entries.length === 1
                ? t('1 entry, {kb} KB total', { kb: Math.max(1, totalKb) })
                : t('{count} entries, {kb} KB total', {
                    count: entries.length,
                    kb: Math.max(1, totalKb),
                  })}
              {totalBytes > KNOWLEDGE_COMPACT_SUGGEST_BYTES
                ? t(' · large knowledge can slow down replies on calls and in games')
                : ''}
            </div>
          ) : null}
        </div>
        <div className={styles.zoneCol}>
          <KnowledgeDropZone
            compact
            onExtracted={addUpload}
            cornerAction={
              <Button
                kind="ghost"
                size="sm"
                onClick={openAddText}
                aria-label={t('Add text context')}
                title={t('Add text context')}
                icon={<NotePlusIcon size={16} />}
              />
            }
          />
        </div>
      </div>
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
      <ModalFooter>
        <Button kind="primary" onClick={onClose}>
          {t('Done')}
        </Button>
      </ModalFooter>

      {form ? (
        <ModalShell
          title={form.mode === 'add' ? t('Add text context') : t('Edit knowledge')}
          width={560}
          tier="stacked"
          onClose={() => setForm(null)}
          escClose
          aria-label={form.mode === 'add' ? t('Add text context') : t('Edit knowledge')}
        >
          <div className={styles.formField}>
            <span className="u-lbl">{t('Title')}</span>
            <TextField value={formTitle} onChange={setFormTitle} aria-label={t('Knowledge title')} autoFocus />
          </div>
          <div className={styles.formField}>
            <span className="u-lbl">{t('Content')}</span>
            <textarea
              className={styles.formTextarea}
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              aria-label={t('Knowledge content')}
            />
          </div>
          <ModalFooter>
            <Button kind="quiet" onClick={() => setForm(null)} disabled={formBusy}>
              {t('Cancel')}
            </Button>
            <Button
              kind="accent"
              onClick={() => void saveForm()}
              disabled={formBusy || formTitle.trim() === '' || formContent.trim() === ''}
            >
              {formBusy ? t('Saving…') : t('Save')}
            </Button>
          </ModalFooter>
        </ModalShell>
      ) : null}
    </ModalShell>
  );
}
