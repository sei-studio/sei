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
import { SquiggleFrame } from './Squiggle';
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
        {messages.map((m) => {
          if (m.system) {
            return (
              <p key={m.id} className={styles.chatSystem}>
                {m.text}
              </p>
            );
          }
          return (
            <p
              key={m.id}
              className={m.correct ? `${styles.chatLine} ${styles.chatCorrect}` : styles.chatLine}
            >
              <span className={styles.chatWho}>{m.from === 'ai' ? aiName : playerName}</span>
              {m.text}
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
          aria-label="Chat and guesses"
        />
      </div>
    </div>
  );
}
