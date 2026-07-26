/**
 * NoticesInboxModal — the notices inbox (260725).
 *
 * A minimal two-column inbox rendered through ModalShell: notice titles on the
 * left, the selected notice on the right (title, date, body). Opens itself once
 * when a new notice arrives (see useNoticesStore) and is reopenable from
 * Playtime → Inbox.
 *
 * Bodies are markdown, parsed by lib/noticeMarkdown into a typed AST and
 * rendered to React elements here — no `dangerouslySetInnerHTML` anywhere, so a
 * feed that gets it wrong renders as text instead of markup. Links open in the
 * OS browser through `sei.openExternal`. Any https host is allowed (the host
 * allowlist was removed 260725 so a notice can link anywhere without a client
 * release); main still refuses non-https protocols, so a `file:`/`javascript:`
 * URL in a body is a silent no-op rather than an OS handoff.
 */

import React, { useEffect, useRef } from 'react';
import type { Notice } from '@shared/ipc';
import { sei } from '../lib/ipcClient';
import {
  parseNoticeBody,
  type NoticeBlock,
  type NoticeInline,
} from '../lib/noticeMarkdown';
import { useNoticesStore } from '../lib/stores/useNoticesStore';
import { Button } from './Button';
import { ModalShell, ModalFooter } from './ModalShell';
import styles from './NoticesInboxModal.module.css';

/** `2026-07-25` → `Jul 25, 2026`. Unparseable / empty dates render blank. */
export function formatNoticeDate(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function InlineRun({ run }: { run: NoticeInline }): React.ReactElement | null {
  switch (run.t) {
    case 'text':
      return <>{run.v}</>;
    case 'strong':
      return <strong>{run.v}</strong>;
    case 'em':
      return <em>{run.v}</em>;
    case 'code':
      return <code className={styles.inlineCode}>{run.v}</code>;
    case 'br':
      return <br />;
    case 'img':
      return <img className={styles.image} src={run.src} alt={run.alt} loading="lazy" />;
    case 'link':
      return (
        <a
          className={styles.link}
          href={run.href}
          onClick={(e) => {
            e.preventDefault();
            void sei.openExternal(run.href).catch(() => undefined);
          }}
        >
          {run.v}
        </a>
      );
    default:
      return null;
  }
}

function Inlines({ runs }: { runs: NoticeInline[] }): React.ReactElement {
  return (
    <>
      {runs.map((run, i) => (
        <InlineRun key={i} run={run} />
      ))}
    </>
  );
}

function Block({ block }: { block: NoticeBlock }): React.ReactElement | null {
  switch (block.t) {
    case 'heading': {
      const cls =
        block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
      return (
        <div className={cls}>
          <Inlines runs={block.children} />
        </div>
      );
    }
    case 'para':
      return (
        <p className={styles.para}>
          <Inlines runs={block.children} />
        </p>
      );
    case 'list':
      return block.ordered ? (
        <ol className={styles.list}>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inlines runs={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className={styles.list}>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inlines runs={item} />
            </li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <blockquote className={styles.quote}>
          <Inlines runs={block.children} />
        </blockquote>
      );
    case 'code':
      return <pre className={styles.codeBlock}>{block.v}</pre>;
    case 'hr':
      return <hr className={styles.rule} />;
    default:
      return null;
  }
}

/** Render a markdown notice body. Exported for the body-only preview in tests. */
export function NoticeBody({ body }: { body: string }): React.ReactElement {
  const blocks = React.useMemo(() => parseNoticeBody(body), [body]);
  return (
    <div className={styles.body}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}

export function NoticesInboxModal(): React.ReactElement | null {
  const open = useNoticesStore((s) => s.open);
  const notices = useNoticesStore((s) => s.notices);
  const readIds = useNoticesStore((s) => s.readIds);
  const selectedId = useNoticesStore((s) => s.selectedId);
  const select = useNoticesStore((s) => s.select);
  const close = useNoticesStore((s) => s.close);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Switching notices should start the reading pane at the top, not wherever
  // the previous (possibly long) notice was scrolled to.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [selectedId]);

  if (!open) return null;

  const selected: Notice | null =
    notices.find((n) => n.id === selectedId) ?? notices[0] ?? null;

  return (
    <ModalShell
      title="Inbox"
      width={760}
      scrimClose
      onClose={close}
      panelClassName={styles.panel}
    >
      {notices.length === 0 ? (
        <p className={styles.empty}>No notices yet.</p>
      ) : (
        <div className={styles.columns}>
          <ul className={styles.titles} role="listbox" aria-label="Notices">
            {notices.map((n) => {
              const unread = !readIds.includes(n.id);
              const active = selected?.id === n.id;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={[styles.item, active ? styles.itemActive : '']
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => select(n.id)}
                  >
                    <span className={styles.itemTitle}>
                      {unread ? <span className={styles.dot} aria-label="Unread" /> : null}
                      {n.title}
                    </span>
                    <span className={styles.itemDate}>{formatNoticeDate(n.date)}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className={styles.reader} ref={bodyRef}>
            {selected ? (
              <>
                <h4 className={styles.readerTitle}>{selected.title}</h4>
                <div className={styles.readerDate}>{formatNoticeDate(selected.date)}</div>
                <NoticeBody body={selected.body} />
              </>
            ) : null}
          </div>
        </div>
      )}

      <ModalFooter>
        <Button kind="ghost" size="sm" onClick={close}>
          Close
        </Button>
      </ModalFooter>
    </ModalShell>
  );
}
