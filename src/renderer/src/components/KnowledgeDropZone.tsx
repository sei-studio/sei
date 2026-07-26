/**
 * KnowledgeDropZone — drag/drop + click-to-browse upload zone for Knowledge
 * files (260725). Used by the create-flow import phase and the Knowledge
 * popup on the character page.
 *
 * The renderer NEVER parses uploads: each file's raw bytes go to main over
 * knowledge:extract, which validates the type (.md/.markdown/.txt/.text/
 * .docx; legacy .doc rejected with actionable copy), decodes, sanitizes, and
 * caps the text. This component only collects files and surfaces per-file
 * errors. Multi-file drops are processed sequentially.
 *
 * `cornerAction` renders in the zone's top-right (the "Add text context"
 * affordance in the Knowledge popup).
 */

import React, { useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { UploadIcon } from './icons';
import styles from './KnowledgeDropZone.module.css';

/** Mirrors main's extension allowlist; the picker also lists .doc so the
 * rejection copy ("save as .txt/.md/.docx") can explain itself. */
const ACCEPT = '.md,.markdown,.txt,.text,.doc,.docx';

export interface ExtractedFile {
  title: string;
  content: string;
}

interface KnowledgeDropZoneProps {
  /** Called once per successfully extracted file. */
  onExtracted: (file: ExtractedFile) => void | Promise<void>;
  disabled?: boolean;
  /** Optional element pinned to the zone's top-right (e.g. "Add text context"). */
  cornerAction?: React.ReactNode;
  /** Compact height variant for the popup's right column. */
  compact?: boolean;
}

function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function KnowledgeDropZone({
  onExtracted,
  disabled = false,
  cornerAction,
  compact = false,
}: KnowledgeDropZoneProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const processFiles = async (files: FileList | File[]): Promise<void> => {
    if (disabled || busy) return;
    setBusy(true);
    setErrors([]);
    const failed: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const bytesBase64 = bytesToBase64(await file.arrayBuffer());
        const extracted = await sei.knowledgeExtract({ name: file.name, bytesBase64 });
        await onExtracted(extracted);
      } catch (err) {
        // Main's KnowledgeExtractError copy is user-facing; strip the IPC wrapper
        // ("Error invoking remote method 'knowledge:extract': Error: ...").
        const raw = (err as Error).message ?? String(err);
        failed.push(
          raw
            .replace(/^Error invoking remote method '[^']*':\s*/, '')
            .replace(/^(KnowledgeExtractError|Error):\s*/, ''),
        );
      }
    }
    setErrors(failed);
    setBusy(false);
  };

  const openPicker = (): void => {
    if (!disabled && !busy) inputRef.current?.click();
  };

  return (
    <div className={styles.wrap}>
      <div
        ref={rootRef}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="Upload knowledge files"
        className={[
          styles.zone,
          compact ? styles.compact : '',
          dragOver ? styles.dragOver : '',
          disabled ? styles.disabled : '',
        ].join(' ')}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPicker();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.target === rootRef.current) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer?.files?.length) void processFiles(e.dataTransfer.files);
        }}
      >
        {cornerAction ? (
          <div className={styles.corner} onClick={(e) => e.stopPropagation()}>
            {cornerAction}
          </div>
        ) : null}
        <div className={styles.zoneInner}>
          <span className={styles.zoneIcon} aria-hidden="true">
            <UploadIcon size={34} />
          </span>
          <p className={styles.secondary}>
            {busy
              ? 'Reading files…'
              : dragOver
                ? 'Drop to upload'
                : '.md, .txt, .text, .docx (max 512 KB each)'}
          </p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className={styles.hiddenInput}
        onChange={(e) => {
          if (e.target.files?.length) void processFiles(e.target.files);
          e.target.value = '';
        }}
        tabIndex={-1}
        aria-hidden="true"
      />
      {errors.length > 0 ? (
        <div className={styles.errors} role="alert">
          {errors.map((msg, i) => (
            <div key={i} className={styles.errorRow}>
              {msg}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
