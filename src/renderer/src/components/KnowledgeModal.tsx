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
        setError('This entry could not be read.');
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
      title={`${characterName}'s knowledge`}
      width={880}
      onClose={onClose}
      escClose
      scrimClose
      aria-label="Knowledge"
    >
      <p className={styles.lede}>
        You can manually add things for the AI to know here. The AI has a separate internal
        memory storage.
      </p>
      <div className={styles.columns}>
        <div className={styles.listCol}>
          {entries.length === 0 ? (
            <p className={styles.empty}>No knowledge yet. Upload files or add text context.</p>
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
                    {e.source === 'compacted' ? ' · compacted' : e.source === 'text' ? ' · text' : ''}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label={`Edit ${e.title}`}
                    title="Edit"
                    onClick={() => void openEdit(e.id)}
                  >
                    <PencilIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className={[styles.iconBtn, confirmDeleteId === e.id ? styles.iconBtnDanger : ''].join(' ')}
                    aria-label={confirmDeleteId === e.id ? `Confirm delete ${e.title}` : `Delete ${e.title}`}
                    title={confirmDeleteId === e.id ? 'Click again to delete' : 'Delete'}
                    onClick={() => void remove(e.id)}
                    onBlur={() => setConfirmDeleteId((id) => (id === e.id ? null : id))}
                  >
                    {confirmDeleteId === e.id ? <span className={styles.confirmDel}>Delete?</span> : <TrashIcon size={14} />}
                  </button>
                </div>
              </div>
            ))
          )}
          {entries.length > 0 ? (
            <div className={styles.totals}>
              {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}, {Math.max(1, totalKb)} KB total
              {totalBytes > KNOWLEDGE_COMPACT_SUGGEST_BYTES
                ? ' · large knowledge can slow down replies on calls and in games'
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
                aria-label="Add text context"
                title="Add text context"
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
          Done
        </Button>
      </ModalFooter>

      {form ? (
        <ModalShell
          title={form.mode === 'add' ? 'Add text context' : 'Edit knowledge'}
          width={560}
          tier="stacked"
          onClose={() => setForm(null)}
          escClose
          aria-label={form.mode === 'add' ? 'Add text context' : 'Edit knowledge'}
        >
          <div className={styles.formField}>
            <span className="u-lbl">Title</span>
            <TextField value={formTitle} onChange={setFormTitle} aria-label="Knowledge title" autoFocus />
          </div>
          <div className={styles.formField}>
            <span className="u-lbl">Content</span>
            <textarea
              className={styles.formTextarea}
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              aria-label="Knowledge content"
            />
          </div>
          <ModalFooter>
            <Button kind="quiet" onClick={() => setForm(null)} disabled={formBusy}>
              Cancel
            </Button>
            <Button
              kind="accent"
              onClick={() => void saveForm()}
              disabled={formBusy || formTitle.trim() === '' || formContent.trim() === ''}
            >
              {formBusy ? 'Saving…' : 'Save'}
            </Button>
          </ModalFooter>
        </ModalShell>
      ) : null}
    </ModalShell>
  );
}
