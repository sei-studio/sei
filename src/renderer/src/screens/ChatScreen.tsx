/**
 * ChatScreen — Discord-style in-app chat with a companion (Phase 18/19).
 *
 * Layout: a compact header (back button + avatar + a name TOGGLE that opens the
 * presence side panel + Play / Voice icon buttons), a scrollable NO-BUBBLE
 * message list (avatar + author header + text, grouped by consecutive author,
 * split by per-day separators), a "<name> is typing…" line while a reply is in
 * flight, and a floating boxed composer (send button appears once the draft is
 * non-empty).
 *
 * Party redesign (§4.5): the header name toggles a collapsible 260px presence
 * side panel (portrait art + kind + Presence line + live action verb + an action
 * stack). Clicking a message author's name swaps the panel between the companion
 * card and the "You" (user) card; clicking the same author again closes it.
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
 * Source: .planning/design/UI-REDESIGN-PARTY.md §4.5.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useChatStore } from '../lib/stores/useChatStore';
import { sei } from '../lib/ipcClient';
import { portraitSrc } from '../lib/portraitSrc';
import { pickPalette } from '../lib/portraitPalettes';
import { useDominantColor } from '../lib/useDominantColor';
import { presenceOf, useMinuteTick } from '../lib/presence';
import { actionVerb } from '../lib/actionVerb';
import { PixelPortrait } from '../components/PixelPortrait';
import { Presence } from '../components/Presence';
import { Button } from '../components/Button';
import {
  GamepadIcon,
  UserIcon,
  PhoneIcon,
  SendIcon,
  BackIcon,
  CopyIcon,
  ReplyIcon,
} from '../components/icons';
import { IdTag } from '../components/IdTag';
import { CHAT_TEXT_MAX, type ChatMessage, type ChatReplyRef, type UserProfile } from '@shared/ipc';
import type { Character } from '@shared/characterSchema';
import styles from './ChatScreen.module.css';

export interface ChatScreenProps {
  characterId: string;
}

/** Which resident the presence side panel is showing. */
type PanelCard = 'companion' | 'user';

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
  const summon = useDataStore((s) => s.summons[characterId]);
  const action = useDataStore((s) => s.actions[characterId]);

  const messages = useChatStore((s) => s.messages[characterId]) ?? EMPTY;
  // Voice-call lines (transcribed utterances / spoken replies) are persisted
  // for the model's continuity but hidden here — a call is represented by its
  // "You and X called for Y" row alone. Filtered BEFORE the map so day
  // separators and author-run detection key on the visible neighbors.
  const visibleMessages = useMemo(() => messages.filter((m) => !m.voice), [messages]);
  const awaiting = useChatStore((s) => s.awaiting[characterId]) ?? false;
  const loading = useChatStore((s) => s.loading[characterId]) ?? false;
  const load = useChatStore((s) => s.load);
  const send = useChatStore((s) => s.send);

  const [draft, setDraft] = useState('');
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  // #9 — reply quoting + copy feedback. replyTo holds the quoted author + text.
  const [replyTo, setReplyTo] = useState<ChatReplyRef | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // §4.5 — presence side panel: default OPEN (260705 revision); hiding it is a
  // sticky preference across companions and app restarts (useUiStore, persisted
  // via UserConfig.chat_panel_hidden). Which card shows stays per-screen state.
  const panelHidden = useUiStore((s) => s.chatPanelHidden);
  const setChatPanelHidden = useUiStore((s) => s.setChatPanelHidden);
  const panelOpen = !panelHidden;
  const setPanelOpen = (open: boolean): void => {
    setChatPanelHidden(!open);
    // Persist best-effort: read-modify-write the config off the current value.
    void sei
      .getConfig()
      .then((cfg) => sei.saveConfig({ ...cfg, chat_panel_hidden: !open }))
      .catch(() => {
        /* preference still applies for this session */
      });
  };
  const [panelCard, setPanelCard] = useState<PanelCard>('companion');

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

  // Auto-scroll to the bottom on new messages / typing-indicator changes, and on
  // entering a DM (characterId) once its transcript finishes loading. A single
  // post-paint write can land just short of the true bottom because portraits /
  // images grow the list after the first layout, so re-pin on the next frame —
  // otherwise entry leaves the newest message (and the composer breathing room)
  // below the fold until you scroll.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const toBottom = (): void => {
      el.scrollTop = el.scrollHeight;
    };
    toBottom();
    const r = requestAnimationFrame(toBottom);
    return () => cancelAnimationFrame(r);
  }, [messages, awaiting, characterId, loading]);

  // Scrollbar auto-hide: the thumb is transparent at rest and shows only
  // while the list is actively scrolling (data-scrolling, cleared after a
  // short idle). Direct DOM writes — no re-render per scroll frame.
  const scrollFadeTimer = useRef<number | null>(null);
  const onListScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    el.dataset.scrolling = 'true';
    if (scrollFadeTimer.current !== null) window.clearTimeout(scrollFadeTimer.current);
    scrollFadeTimer.current = window.setTimeout(() => {
      delete el.dataset.scrolling;
    }, 700);
  };
  useEffect(
    () => () => {
      if (scrollFadeTimer.current !== null) window.clearTimeout(scrollFadeTimer.current);
    },
    [],
  );

  // Re-render each minute so the Presence line decays online → idle (§2).
  useMinuteTick();

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  const companionName = character?.name ?? 'Companion';
  const userName = userProfile?.preferredName?.trim() || 'You';
  // Panel kind line: the character's one-line description with the leading
  // "<Name>, " appositive and trailing period stripped ("A wolf-person"),
  // replacing the generic "Companion" label. Long descriptions (hand-written
  // customs can be paragraphs) fall back to the generic label so the panel
  // never floods.
  const kindLine = useMemo(() => {
    let d = (character?.description ?? '').replace(/\s+/g, ' ').trim();
    const name = (character?.name ?? '').trim();
    if (name) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Only strip the leading name when it's the "<Name>, ..." appositive form
      // (comma REQUIRED). Without the comma the name is the sentence subject
      // ("Sui is the OG...") and stripping it drops the subject, leaving a
      // mangled "Is the OG..." — so leave those intact.
      d = d.replace(new RegExp(`^${esc},\\s+`, 'i'), '');
    }
    d = d.replace(/[.\s]+$/, '');
    if (!d || d.length > 80) return 'Companion';
    return d.charAt(0).toUpperCase() + d.slice(1);
  }, [character?.description, character?.name]);

  const panelPalette = useMemo(
    () => pickPalette((character?.id ?? '') + (character?.name ?? ''), theme),
    [character?.id, character?.name, theme],
  );
  const userArtSrc = portraitSrc(userProfile?.profilePicture);
  // §4.5 (260705) — tint the presence panel with the portrait's main color.
  // Null (no portrait / extraction blocked) falls back to the plain surface.
  const panelTint = useDominantColor(
    portraitSrc(character?.portrait_image ?? null),
    character?.cloud_updated_at ?? null,
  );

  const presence = character
    ? presenceOf(character, summon)
    : ({ category: 'idle', label: 'Idle' } as const);
  const online = summon?.kind === 'online';
  const connecting = summon?.kind === 'connecting';
  const nowVerb = presence.category === 'in-game' ? actionVerb(action) : null;

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
    void send(characterId, text, ref);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // IME guard (260709): while composing with a CJK input method, Enter
    // CONFIRMS the candidate word, it does not send. isComposing covers
    // Chromium's composition state; keyCode 229 catches the engines that
    // deliver the confirming keydown with isComposing already false.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  const onProfile = (): void => {
    setChatReturnId(characterId);
    navigate({ kind: 'character', id: characterId });
  };

  const onVoiceCall = (): void => {
    // Open the call view WITHOUT starting the pipeline: VoiceCallScreen's gate
    // decides whether to show the install/consent modal first (mic + ~40 MB
    // model download) and only starts the call once the module is in place and
    // the user has consented. Starting here would set callCharacterId before
    // the gate ran and skip that consent step.
    navigate({ kind: 'voice-call', characterId });
  };

  const onDisconnect = (): void => {
    // Instant: drop the entry from the store immediately so the panel flips to
    // "Play"; `stop` still tears down any live session (idempotent).
    useDataStore.getState().setStatus({ kind: 'idle', characterId });
    void sei.stop(characterId);
  };

  /** Show a resident's card in the side panel; clicking the same one closes it. */
  const showCard = (who: PanelCard): void => {
    if (panelOpen && panelCard === who) {
      setPanelOpen(false);
      return;
    }
    setPanelCard(who);
    setPanelOpen(true);
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

  const showingUser = panelCard === 'user';

  return (
    <div className={`${styles.root} ${panelOpen ? styles.presOpen : ''}`}>
      <div className={styles.chatCol}>
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
          {/* 260705: the header name opens the full profile page (the side
              panel is reachable via message author names + open by default). */}
          <button
            type="button"
            className={styles.nameToggle}
            onClick={onProfile}
            aria-label={`Open ${companionName}'s profile`}
          >
            <span className={styles.headerName}>{companionName}</span>
            {character?.public_id ? <IdTag id={character.public_id} size="sm" /> : null}
          </button>
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
              onClick={onVoiceCall}
              aria-label="Voice call"
              data-tip="Voice call"
            >
              <PhoneIcon size={18} />
            </button>
          </div>
        </header>

        {/* ── Message list ── */}
        <div
          className={awaiting ? `${styles.list} ${styles.listTyping}` : styles.list}
          ref={listRef}
          onScroll={onListScroll}
        >
          {loading ? <ChatSkeleton /> : null}
          {!loading && visibleMessages.length === 0 && !awaiting ? (
            <div className={styles.empty}>
              This is the beginning of your conversation with {companionName}. Say hi.
            </div>
          ) : null}
          {loading ? null : visibleMessages.map((m, i, arr) => {
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
              // Voice calls (260705): "You and X called for Y." — same Discord-
              // style session row as play, with the handset glyph.
              if (m.event?.kind === 'call') {
                return (
                  <div key={m.id} className={`${styles.systemRow} ${styles.playRow}`}>
                    <span className={styles.playIcon}>
                      <PhoneIcon size={18} />
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
            const prev = arr[i - 1];
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
                    <button
                      type="button"
                      className={styles.authorName}
                      onClick={() => showCard(m.role === 'user' ? 'user' : 'companion')}
                    >
                      {m.role === 'user' ? userName : companionName}
                    </button>
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

      {/* ── Presence side panel (§4.5) ── */}
      <aside
        className={styles.presPanel}
        style={
          !showingUser && panelTint
            ? ({ '--pres-tint': panelTint } as React.CSSProperties)
            : undefined
        }
        aria-label={showingUser ? 'You' : `${companionName} details`}
        aria-hidden={!panelOpen}
      >
        <div className={styles.presInner}>
          <div className={styles.presArt}>
            {showingUser ? (
              userArtSrc ? (
                <img src={userArtSrc} alt="" className={styles.presArtImg} />
              ) : (
                <span className={styles.presArtFallback}>
                  <UserIcon size={72} />
                </span>
              )
            ) : character ? (
              <PixelPortrait
                seed={character.id + character.name}
                palette={panelPalette}
                size={190}
                portraitImage={character.portrait_image}
                style={{ width: '100%', height: '100%' }}
              />
            ) : (
              <span className={styles.presArtFallback}>
                <UserIcon size={72} />
              </span>
            )}
            <span className={styles.presFade} aria-hidden="true" />
          </div>
          <div className={styles.presBody}>
            <div className={styles.presNameRow}>
              <span className={styles.presName}>{showingUser ? userName : companionName}</span>
              {showingUser
                ? userProfile?.handle && <IdTag id={userProfile.handle} size="sm" />
                : character?.public_id && <IdTag id={character.public_id} size="sm" />}
            </div>
            <div className={styles.presKind}>{showingUser ? 'Human' : kindLine}</div>
            {!showingUser ? <Presence category={presence.category} label={presence.label} /> : null}
            {!showingUser && nowVerb ? <div className={styles.presNow}>{nowVerb}</div> : null}
            {!showingUser ? (
              <div className={styles.presActions}>
                {online ? (
                  <Button kind="danger" fullWidth onClick={onDisconnect}>
                    Disconnect
                  </Button>
                ) : connecting ? (
                  <Button kind="ghost" fullWidth disabled>
                    Connecting…
                  </Button>
                ) : (
                  <Button
                    kind="primary"
                    fullWidth
                    onClick={() => openModal({ kind: 'games-picker', characterId })}
                  >
                    Play
                  </Button>
                )}
                <Button kind="ghost" fullWidth onClick={onVoiceCall}>
                  Call
                </Button>
                <Button kind="ghost" fullWidth onClick={onProfile}>
                  Profile
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Stable empty array so the selector doesn't churn re-renders. */
const EMPTY: ChatMessage[] = [];

/**
 * Wireframe rows shown while the persisted transcript is still loading. Each row
 * mirrors the real message layout (40px avatar gutter + text) so nothing jumps
 * when content lands: `lead` rows carry a circular avatar placeholder + a short
 * name bar, continuation rows are gutter-aligned text only. Widths vary 42-66%
 * to read like real chat. Static by design (260705) — no shimmer sweep.
 */
const SKELETON_ROWS: ReadonlyArray<{ lead: boolean; width: string }> = [
  { lead: true, width: '52%' },
  { lead: false, width: '42%' },
  { lead: true, width: '66%' },
  { lead: true, width: '48%' },
  { lead: false, width: '58%' },
  { lead: true, width: '44%' },
];

function ChatSkeleton(): React.ReactElement {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      {SKELETON_ROWS.map((r, i) =>
        r.lead ? (
          <div key={i} className={styles.skelRowLead}>
            <span className={styles.skelAvatar} />
            <div className={styles.skelBody}>
              <span className={styles.skelName} />
              <span className={styles.skelBar} style={{ width: r.width }} />
            </div>
          </div>
        ) : (
          <div key={i} className={styles.skelRowCont}>
            <span aria-hidden="true" />
            <span className={styles.skelBar} style={{ width: r.width }} />
          </div>
        ),
      )}
    </div>
  );
}

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
