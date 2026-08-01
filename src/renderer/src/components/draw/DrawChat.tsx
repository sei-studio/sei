/**
 * DrawChat — the column beside the canvas. Guesses and table talk share one
 * log; there is no separate guess box, because the rule is that saying the
 * word in any sentence counts.
 *
 * The input stays enabled on both turns: while the character draws it is the
 * guess channel, and while the player draws it is table talk the character
 * sees on its next look at the canvas.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { DrawChatMessage } from '@shared/drawIpc';
import { useT } from '../../lib/i18n';
import { SquiggleFrame, SquiggleHighlight } from './Squiggle';
import styles from './draw.module.css';

export interface DrawChatProps {
  messages: DrawChatMessage[];
  playerName: string;
  aiName: string;
  placeholder: string;
  disabled: boolean;
  onSend: (text: string) => void;
}

export function DrawChat({
  messages,
  playerName,
  aiName,
  placeholder,
  disabled,
  onSend,
}: DrawChatProps): React.ReactElement {
  const t = useT();
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  // Pin to the newest line. Guesses arrive fast enough that reading back is
  // not the common case, so unconditional is right here.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = (): void => {
    const t = text.trim();
    if (!t || disabled) return;
    setText('');
    onSend(t);
  };

  return (
    <div className={styles.chat}>
      <div className={styles.chatList} ref={listRef}>
        {messages.map((m, i) => {
          if (m.system) {
            return (
              <p key={m.id} className={styles.chatSystem}>
                {m.text}
              </p>
            );
          }
          // Consecutive lines from one person are one block under one name.
          // Guessing produces runs of four or five lines from the same side,
          // and repeating the name above each turned the column into a list of
          // labels with the actual talking squeezed between them. A system line
          // breaks the run, because something happened in between.
          const prev = messages[i - 1];
          const startsTurn = !prev || prev.system || prev.from !== m.from;
          const cls = [
            styles.chatLine,
            startsTurn && i > 0 ? styles.chatTurn : '',
            m.correct ? styles.chatCorrect : '',
          ]
            .filter(Boolean)
            .join(' ');
          // The swipe goes behind the winning WORD, not the whole sentence
          // (260728): highlighting the full line read as the sentence being
          // the answer. Main locates the word (findWordMatch) and sends the
          // range; a line without one falls back to the whole-line swipe.
          const range =
            m.correct &&
            m.correctRange &&
            m.correctRange.start >= 0 &&
            m.correctRange.end > m.correctRange.start &&
            m.correctRange.end <= m.text.length
              ? m.correctRange
              : null;
          return (
            <p key={m.id} className={cls}>
              {/* The winning line is marked with the same rough swipe as a
                  selected button, not a filled rectangle: a hard-edged block
                  is the one shape this surface does not draw. */}
              {m.correct && !range ? <SquiggleHighlight seed={`hl-${m.id}`} /> : null}
              {startsTurn ? (
                <span className={styles.chatWho}>{m.from === 'ai' ? aiName : playerName}</span>
              ) : null}
              {range ? (
                <span className={styles.btnLabel}>
                  {m.text.slice(0, range.start)}
                  <span className={styles.chatHit}>
                    <SquiggleHighlight seed={`hl-${m.id}`} />
                    <span className={styles.btnLabel}>{m.text.slice(range.start, range.end)}</span>
                  </span>
                  {m.text.slice(range.end)}
                </span>
              ) : (
                <span className={styles.btnLabel}>{m.text}</span>
              )}
            </p>
          );
        })}
      </div>

      <div className={styles.chatInputRow}>
        <SquiggleFrame seed="chat-input" />
        <input
          className={styles.chatInput}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label={t('Chat and guesses')}
        />
      </div>
    </div>
  );
}
