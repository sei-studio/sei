/**
 * ChatScreen — Discord-style in-app chat with a companion (Phase 18/19).
 *
 * Layout: a compact header (back button + avatar + companion name, with Games /
 * Voice / Profile icon buttons on the right), a scrollable NO-BUBBLE message
 * list (avatar + author header + text, grouped by consecutive author, split by
 * per-day separators), a small "<name> is typing…" line while a reply is in
 * flight, and a floating composer that hovers over the bottom of the window
 * (the send button appears only once the draft is non-empty).
 *
 * Per-message hover affordances (copy / reply). Reply quotes the message: the
 * quote shows as a line above the composer and is prepended to the outgoing
 * message as `user quoted "…"`.
 *
 * Messages + the awaiting flag live in useChatStore; history loads once on
 * mount. The companion avatar is the character's portrait (PixelPortrait
 * handles the procedural fallback); the user avatar is their profile picture
 * (sei.userGetProfile), falling back to a generic glyph.
 *
 * Source: .planning/design/app-chat-and-memory.md §5 (UI plan) + R4/R6/R9.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useChatStore } from '../lib/stores/useChatStore';
import { sei } from '../lib/ipcClient';
import { portraitSrc } from '../lib/portraitSrc';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from '../components/PixelPortrait';
import {
  GamepadIcon,
  UserIcon,
  PhoneIcon,
  SendIcon,
  BackIcon,
  CopyIcon,
  ReplyIcon,
} from '../components/icons';
import { CHAT_TEXT_MAX, type ChatMessage, type ChatReplyRef, type UserProfile } from '@shared/ipc';
import type { Character } from '@shared/characterSchema';
import styles from './ChatScreen.module.css';

export interface ChatScreenProps {
  characterId: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** "17/04/2026, 11:33" — DD/MM/YYYY, 24-hour, locale-independent. */
function fmtTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}, ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

/** "17 Apr 2026" — day-separator label. */
function fmtDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Stable per-calendar-day key so a separator drops in when the day changes. */
function dayKey(ts: number): number {
  const d = new Date(ts);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function ChatScreen({ characterId }: ChatScreenProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const setChatReturnId = useUiStore((s) => s.setChatReturnId);

  const character: Character | undefined = useDataStore((s) =>
    s.characters.find((c) => c.id === characterId),
  );

  const messages = useChatStore((s) => s.messages[characterId]) ?? EMPTY;
  const awaiting = useChatStore((s) => s.awaiting[characterId]) ?? false;
  const load = useChatStore((s) => s.load);
  const send = useChatStore((s) => s.send);

  const [draft, setDraft] = useState('');
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  // #9 — reply quoting + copy feedback. replyTo holds the quoted author + text.
  const [replyTo, setReplyTo] = useState<ChatReplyRef | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Transient toast for the "coming soon" phone notice.
  const [notice, setNotice] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Load persisted transcript once for this character.
  useEffect(() => {
    void load(characterId);
  }, [characterId, load]);

  // Seed the user's profile (avatar + name) on mount.
  useEffect(() => {
    let cancelled = false;
    void sei
      .userGetProfile()
      .then((p) => {
        if (!cancelled) setUserProfile(p);
      })
      .catch(() => {
        /* fall back to the generic avatar + 'You' */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll to the bottom on new messages / typing-indicator changes.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, awaiting]);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  const companionName = character?.name ?? 'Companion';
  const userName = userProfile?.preferredName?.trim() || 'You';

  const doSend = (): void => {
    const text = draft.trim();
    // #9 — sending while a reply is in flight is allowed: it interrupts the
    // in-flight LLM call (main aborts + supersedes) and sends this instead.
    if (!text) return;
    // #9 — the quote travels as structured metadata (rendered in-chat + fed to
    // the model), so the message text itself stays clean.
    const ref = replyTo ?? undefined;
    setDraft('');
    setReplyTo(null);
    // The launch toast is already wired in App (it toasts on 'online'); we leave
    // the user in chat regardless of the launch outcome — the reply text already
    // instructs them when the LAN world isn't open.
    void send(characterId, text, ref);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  const onProfile = (): void => {
    setChatReturnId(characterId);
    navigate({ kind: 'character', id: characterId });
  };

  const onCopy = (m: ChatMessage): void => {
    void navigator.clipboard
      ?.writeText(m.text)
      .then(() => {
        setCopiedId(m.id);
        window.setTimeout(() => setCopiedId((c) => (c === m.id ? null : c)), 1200);
      })
      .catch(() => {
        /* clipboard blocked — no-op */
      });
  };

  const onReply = (m: ChatMessage): void => {
    setReplyTo({ role: m.role === 'companion' ? 'companion' : 'user', text: m.text });
    inputRef.current?.focus();
  };

  /** Copy + reply cluster shown on row hover (both lead and continuation rows). */
  const rowActions = (m: ChatMessage): React.ReactElement => (
    <div className={styles.rowActions}>
      <button
        type="button"
        className={styles.rowActionBtn}
        onClick={() => onCopy(m)}
        aria-label="Copy message"
        data-tip={copiedId === m.id ? 'Copied' : 'Copy'}
      >
        <CopyIcon size={15} />
      </button>
      <button
        type="button"
        className={styles.rowActionBtn}
        onClick={() => onReply(m)}
        aria-label="Reply"
        data-tip="Reply"
      >
        <ReplyIcon size={15} />
      </button>
    </div>
  );

  return (
    <div className={styles.root}>
      {/* ── Header ── */}
      <header className={styles.header}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => navigate({ kind: 'home' })}
          aria-label="Back"
          data-tip="Back"
        >
          <BackIcon size={20} />
        </button>
        <div className={styles.headerAvatar}>
          {character ? (
            <CompanionAvatar character={character} theme={theme} size={22} />
          ) : (
            <UserIcon size={14} />
          )}
        </div>
        <div className={styles.headerText}>
          <span className={styles.headerName}>{companionName}</span>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => openModal({ kind: 'games-picker', characterId })}
            aria-label="Play together"
            data-tip="Play together"
          >
            <GamepadIcon size={18} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => {
              setNotice('Voice call coming later this month!');
              window.setTimeout(() => setNotice((n) => (n ? null : n)), 2200);
            }}
            aria-label="Voice call"
            data-tip="Voice call"
          >
            <PhoneIcon size={18} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onProfile}
            aria-label={`${companionName} profile`}
            data-tip="Profile"
          >
            <UserIcon size={18} />
          </button>
        </div>
      </header>

      {/* ── Message list ── */}
      <div
        className={awaiting ? `${styles.list} ${styles.listTyping}` : styles.list}
        ref={listRef}
      >
        {messages.length === 0 && !awaiting ? (
          <div className={styles.empty}>
            This is the beginning of your conversation with {companionName}. Say hi.
          </div>
        ) : null}
        {messages.map((m, i) => {
          if (m.role === 'system') {
            if (m.event?.kind === 'play') {
              return (
                <div key={m.id} className={`${styles.systemRow} ${styles.playRow}`}>
                  <span className={styles.playIcon}>
                    <GamepadIcon size={18} />
                  </span>
                  <span>{m.text}</span>
                </div>
              );
            }
            return (
              <div key={m.id} className={styles.systemRow}>
                {m.text}
              </div>
            );
          }
          const prev = messages[i - 1];
          const newDay = !prev || dayKey(prev.ts) !== dayKey(m.ts);
          // A day break — or a quoted reply — restarts an author run so the
          // avatar + header (and the quote reference above it) are shown.
          const isLead = newDay || !!m.replyTo || !prev || prev.role !== m.role;
          const separator = newDay ? (
            <div className={styles.daySeparator}>
              <span className={styles.daySeparatorLabel}>{fmtDay(m.ts)}</span>
            </div>
          ) : null;

          const row = isLead ? (
            <div className={styles.rowLead}>
              {/* Quoted reply spans the full row ABOVE the avatar (Discord-style)
                  so the 40px avatar aligns with the author header, not the quote. */}
              {m.replyTo ? (
                <div className={styles.quoteRef}>
                  <span className={styles.quoteAvatar}>
                    <MessageAvatar
                      role={m.replyTo.role}
                      character={character}
                      theme={theme}
                      userProfile={userProfile}
                    />
                  </span>
                  <span className={styles.quoteName}>
                    {m.replyTo.role === 'companion' ? companionName : userName}
                  </span>
                  <span className={styles.quoteText}>{m.replyTo.text}</span>
                </div>
              ) : null}
              <div className={styles.avatarCell}>
                <MessageAvatar
                  role={m.role}
                  character={character}
                  theme={theme}
                  userProfile={userProfile}
                />
              </div>
              <div className={styles.msgBody}>
                <div className={styles.msgHeader}>
                  <span className={styles.authorName}>
                    {m.role === 'user' ? userName : companionName}
                  </span>
                  <span className={styles.timestamp}>{fmtTimestamp(m.ts)}</span>
                </div>
                <div className={styles.msgText}>{m.text}</div>
              </div>
              {rowActions(m)}
            </div>
          ) : (
            <div className={styles.rowCont}>
              <span aria-hidden="true" />
              <div className={styles.msgText}>{m.text}</div>
              {rowActions(m)}
            </div>
          );

          return (
            <React.Fragment key={m.id}>
              {separator}
              {row}
            </React.Fragment>
          );
        })}
      </div>

      {/* ── Floating composer (hovers over the chat window) ── */}
      <div className={styles.composerDock}>
        {awaiting ? (
          <div className={styles.typingLine} aria-live="polite">
            {companionName} is typing…
          </div>
        ) : null}
        {replyTo ? (
          <div className={styles.replyBar}>
            <ReplyIcon size={14} />
            <span className={styles.replyName}>
              {replyTo.role === 'companion' ? companionName : userName}
            </span>
            <span className={styles.replyQuote}>{replyTo.text}</span>
            <button
              type="button"
              className={styles.replyClose}
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
              title="Cancel reply"
            >
              ×
            </button>
          </div>
        ) : null}
        {copiedId ? (
          <div className={styles.copiedToast} aria-live="polite">
            Copied to clipboard
          </div>
        ) : null}
        {notice ? (
          <div className={styles.copiedToast} aria-live="polite">
            {notice}
          </div>
        ) : null}
        <div className={styles.composer}>
          <textarea
            ref={inputRef}
            className={styles.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message ${companionName}…`}
            // 260705: mirror the chat:send Zod cap — an over-limit paste would
            // otherwise be rejected pre-persist and show unfixable "try again" copy.
            maxLength={CHAT_TEXT_MAX}
            rows={1}
            aria-label={`Message ${companionName}`}
          />
          {draft.trim() !== '' ? (
            <button
              type="button"
              className={styles.sendBtn}
              onClick={doSend}
              aria-label="Send"
              title="Send"
            >
              <SendIcon size={18} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Stable empty array so the selector doesn't churn re-renders. */
const EMPTY: ChatMessage[] = [];

/** Circular companion avatar (portrait → procedural fallback via PixelPortrait). */
function CompanionAvatar({
  character,
  theme,
  size,
}: {
  character: Character;
  theme: 'light' | 'dark';
  size: number;
}): React.ReactElement {
  const palette = useMemo(
    () => pickPalette(character.id + character.name, theme),
    [character.id, character.name, theme],
  );
  return (
    <PixelPortrait
      seed={character.id + character.name}
      palette={palette}
      size={size}
      portraitImage={character.portrait_image}
      style={{ width: '100%', height: '100%' }}
    />
  );
}

/** Picks the right avatar for a message row by author role. */
function MessageAvatar({
  role,
  character,
  theme,
  userProfile,
}: {
  role: ChatMessage['role'];
  character: Character | undefined;
  theme: 'light' | 'dark';
  userProfile: UserProfile | null;
}): React.ReactElement {
  if (role === 'user') {
    const src = portraitSrc(userProfile?.profilePicture);
    return src ? (
      <img
        src={src}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    ) : (
      <UserIcon size={22} />
    );
  }
  return character ? (
    <CompanionAvatar character={character} theme={theme} size={40} />
  ) : (
    <UserIcon size={22} />
  );
}
