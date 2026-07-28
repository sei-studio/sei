/**
 * ChatScreen — Discord-style in-app chat with a companion (Phase 18/19).
 *
 * Layout (260721 top/bottom split): the shared ChatTopBar, then a column with
 * the GAME AREA ON TOP (chess / screen share / Minecraft launch + dashboard,
 * inside the shared GameSurface chrome) and the chat BELOW: a scrollable
 * NO-BUBBLE message list (avatar + author header + text, grouped by
 * consecutive author, split by per-day separators), a "<name> is typing…"
 * line while a reply is in flight, and a floating boxed composer (send button
 * appears once the draft is non-empty). GameSurface's bottom-left "V" expands
 * the game down over the chat; its bottom-right "x" is the unified end
 * control.
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

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { resolvedScheme } from '../lib/theme';
import { useDataStore } from '../lib/stores/useDataStore';
import { useChatStore } from '../lib/stores/useChatStore';
import { useChessStore, isChessOpen, isChessReplayOpen } from '../lib/stores/useChessStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { ChessPanel } from '../components/chess/ChessPanel';
import { ChessReplayPanel } from '../components/chess/ChessReplayPanel';
import { useMcDashboardStore } from '../lib/stores/useMcDashboardStore';
import { McDashboardPanel } from '../components/mcdash/McDashboardPanel';
import { McLaunchPanel } from '../components/mcdash/McLaunchPanel';
import { GameSurface } from '../components/GameSurface';
import { ChatTopBar } from '../components/ChatTopBar';
import { sei } from '../lib/ipcClient';
import { startOrOpenCall } from '../lib/callLaunch';
import { portraitSrc } from '../lib/portraitSrc';
import { pickPalette } from '../lib/portraitPalettes';
import { useDominantColor } from '../lib/useDominantColor';
import { presenceOf, useMinuteTick } from '../lib/presence';
import { actionVerb } from '../lib/actionVerb';
import { readGameLayout, writeGameLayout } from '../lib/gameLayoutPref';
import { PixelPortrait } from '../components/PixelPortrait';
import { Presence } from '../components/Presence';
import { Button } from '../components/Button';
import {
  GamepadIcon,
  UserIcon,
  PhoneIcon,
  SendIcon,
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

/* Drag-resize bounds for the game/chat split (260721): the game area never
 * shrinks below a playable band and the chat keeps composer + a few lines. */
const SPLIT_MIN_GAME_PX = 180;
const SPLIT_MIN_CHAT_PX = 220;
/** ArrowUp/ArrowDown nudge on the (focusable) split handle. */
const SPLIT_KEY_STEP_PX = 24;

function clampSplitPx(px: number, total: number): number {
  return Math.min(Math.max(px, SPLIT_MIN_GAME_PX), Math.max(SPLIT_MIN_GAME_PX, total - SPLIT_MIN_CHAT_PX));
}

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

/**
 * Scrolling within this many px of the list top pulls the next older transcript
 * page (infinite scrollback, 260721). Generous so the fetch starts before the
 * user actually hits the hard top.
 */
const LOAD_OLDER_THRESHOLD_PX = 120;

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
  // On a call the reply is SPOKEN and its row is a hidden voice row (see
  // visibleMessages above), so "is typing…" would show and then nothing ever
  // appears in the thread — read as the companion going unresponsive. While
  // this character is on the live (or dialing) call, the indicator stays off.
  const onCall = useVoiceStore(
    (s) => s.participants.includes(characterId) && (s.status === 'live' || s.status === 'connecting'),
  );
  const showTyping = awaiting && !onCall;
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

  // Infinite scrollback (260721): scrolling near the top pulls the next older
  // transcript page. The anchor snapshot (scrollHeight + scrollTop at request
  // time, tagged with the character it belongs to) lets the layout effect below
  // keep the viewport pinned to the same message after the prepend, instead of
  // the browser keeping scrollTop and visually teleporting to the new oldest row.
  const prependAnchorRef = useRef<{ id: string; h: number; t: number } | null>(null);
  const maybeLoadOlder = (): void => {
    const el = listRef.current;
    if (!el || loading) return;
    if (el.scrollTop > LOAD_OLDER_THRESHOLD_PX) return;
    const st = useChatStore.getState();
    if (!st.hasOlder[characterId] || st.loadingOlder[characterId]) return;
    prependAnchorRef.current = { id: characterId, h: el.scrollHeight, t: el.scrollTop };
    void st.loadOlder(characterId).finally(() => {
      // A page with no fresh rows never re-renders the list, so the layout
      // effect never consumes the anchor — drop it after paint, or the NEXT
      // message (a send) would anchor-restore instead of pinning to bottom.
      requestAnimationFrame(() => {
        prependAnchorRef.current = null;
      });
    });
  };

  // Auto-scroll to the bottom on new messages / typing-indicator changes, and on
  // entering a DM (characterId) once its transcript finishes loading. A single
  // post-paint write can land just short of the true bottom because portraits /
  // images grow the list after the first layout, so re-pin on the next frame —
  // otherwise entry leaves the newest message (and the composer breathing room)
  // below the fold until you scroll. Layout effect (not useEffect) so the
  // scrollback anchor restore lands before paint — no flash of wrong position.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const anchor = prependAnchorRef.current;
    if (anchor && anchor.id === characterId) {
      // Older page landed above the viewport: keep the same message on screen.
      prependAnchorRef.current = null;
      el.scrollTop = el.scrollHeight - anchor.h + anchor.t;
      // A page of only hidden rows (e.g. voice-call captions) adds no visible
      // height, so the viewport is still at the top and no scroll event will
      // fire — keep draining until visible content (or the true top) arrives.
      maybeLoadOlder();
      return;
    }
    prependAnchorRef.current = null;
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
    // Near the top → pull the next older transcript page (guards inside).
    maybeLoadOlder();
  };
  useEffect(
    () => () => {
      if (scrollFadeTimer.current !== null) window.clearTimeout(scrollFadeTimer.current);
    },
    [],
  );

  // Re-render each minute so the Presence line decays online → idle (§2).
  useMinuteTick();

  const theme: 'light' | 'dark' = resolvedScheme();

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
    // With a game surface open the call starts IN PLACE (this screen stays;
    // GameSurface's bottom chrome row carries the compact call cluster);
    // otherwise it opens the fullscreen call view. Consent is preserved either
    // way: the helper falls back to VoiceCallScreen (whose gate owns the
    // install/consent modal) whenever the voice module is not installed yet.
    startOrOpenCall(characterId);
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
        data-tip-edge="right"
      >
        <CopyIcon size={15} />
      </button>
      <button
        type="button"
        className={styles.rowActionBtn}
        onClick={() => onReply(m)}
        aria-label="Reply"
        data-tip="Reply"
        data-tip-edge="right"
      >
        <ReplyIcon size={15} />
      </button>
    </div>
  );

  const showingUser = panelCard === 'user';

  // Chess (260710): the game area is open whenever this character has a game
  // (or a pre-game setup card was requested). While open it takes the top of
  // the screen and force-collapses the presence panel (CSS). One area, one
  // game at a time; chess wins a tie.
  const chessOpen = useChessStore((s) => isChessOpen(s, characterId));
  const chessGame = useChessStore((s) => s.games[characterId] ?? null);
  // Chess replay (260724): a clicked "You and X played chess" transcript row
  // opens the recorded game in this same slot. Purely local view state; it
  // covers (and never disturbs) any live surface below it in the priority.
  const chessReplayOpen = useChessStore((s) => isChessReplayOpen(s, characterId));
  // Minecraft dashboard (260721): shown in this same slot whenever the bot
  // is online (open or closed, nothing in between). The snapshot clears when
  // the bot leaves.
  const mcOnline = summon?.kind === 'online';
  const mcDashReset = useMcDashboardStore((s) => s.reset);
  const mcDashOpen = mcOnline;
  useEffect(() => {
    if (!mcOnline) mcDashReset(characterId);
  }, [mcOnline, characterId, mcDashReset]);
  // Minecraft launch panel (260721): opened by the games picker's Minecraft
  // tile while the bot is offline; it owns the Launch button. Once the bot
  // comes online it hands the same game slot off to the live dashboard.
  const mcLaunch = useMcDashboardStore((s) => s.launch[characterId] === true);
  const mcSetLaunch = useMcDashboardStore((s) => s.setLaunch);
  const mcLaunchOpen = mcLaunch && !mcOnline;
  useEffect(() => {
    if (mcOnline && mcLaunch) mcSetLaunch(characterId, false);
  }, [mcOnline, mcLaunch, characterId, mcSetLaunch]);
  const gameOpen = chessReplayOpen || chessOpen || mcDashOpen || mcLaunchOpen;

  // Unified end control (260721): every surface ends from GameSurface's
  // bottom-right "x", through its existing end path. `confirmGameEnd` gates
  // the "This will end the game." popup on a LIVE session; surfaces without
  // one (launch cards, pickers, a finished chess game) dismiss directly.
  const onGameEnd = (): void => {
    if (chessReplayOpen) {
      // A replay is only ever a local view; dismiss it, nothing to end.
      useChessStore.getState().closeReplay(characterId);
      return;
    }
    if (chessOpen) {
      // Ends any game in main (an unfinished one is recorded as abandoned).
      void useChessStore.getState().end(characterId);
      return;
    }
    if (mcDashOpen || summon?.kind === 'connecting') {
      // Same instant-disconnect path as the presence panel button; the
      // !mcOnline effect above clears the dashboard state afterwards.
      useDataStore.getState().setStatus({ kind: 'idle', characterId });
      void sei.stop(characterId);
    }
    mcSetLaunch(characterId, false);
  };
  const confirmGameEnd = chessReplayOpen
    ? false
    : chessOpen
    ? chessGame?.status === 'active'
    : mcDashOpen
      ? true
      : summon?.kind === 'connecting';

  // Expand-over-chat (260721): the GameSurface bottom-left "V" grows the game
  // area to the full content height, hiding the chat below it.
  const [gameExpanded, setGameExpanded] = useState(() => readGameLayout().expanded);
  // Drag-resize (260721): a hairline grab strip on the game/chat boundary.
  // The dragged size is a percentage of the main column (null = the default
  // CSS split); dragging while expanded exits expanded mode into the dragged
  // size, and double-click resets to the default split. The height transition
  // is disabled while dragging (no animation fighting).
  const [gameSplit, setGameSplit] = useState<number | null>(() => readGameLayout().split);
  const [splitDragging, setSplitDragging] = useState(false);
  // In-app fullscreen (260728) hides the chat too, on top of whatever the
  // expand "V" was set to, and restores that state on exit rather than
  // clobbering it. It is not persisted into the layout preference: fullscreen
  // is a thing you do for a moment, the split is a thing you keep.
  const gameFullscreen = useUiStore((s) => s.gameFullscreen);
  const setGameFullscreen = useUiStore((s) => s.setGameFullscreen);
  const chatHidden = gameOpen && (gameExpanded || gameFullscreen);
  // 260725: the sizing is a user PREFERENCE, not per-view state. It used to
  // reset on unmount (and on a DM switch), so opening a profile and coming
  // back dropped a full-window game straight back to the half split. Persist
  // it instead: one sizing for every character and game, restored on mount
  // and across restarts (gameLayoutPref coalesces the drag writes).
  useEffect(() => {
    writeGameLayout({ expanded: gameExpanded, split: gameSplit });
  }, [gameExpanded, gameSplit]);

  const mainColRef = useRef<HTMLDivElement | null>(null);
  const gameAreaRef = useRef<HTMLElement | null>(null);
  const splitDrag = useRef<{ startY: number; startH: number; total: number } | null>(null);

  const onSplitPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const col = mainColRef.current;
    const area = gameAreaRef.current;
    if (!col || !area) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    splitDrag.current = {
      startY: e.clientY,
      startH: area.getBoundingClientRect().height,
      total: col.getBoundingClientRect().height,
    };
    setSplitDragging(true);
  };
  const onSplitPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = splitDrag.current;
    if (!d || d.total <= 0) return;
    const px = clampSplitPx(d.startH + (e.clientY - d.startY), d.total);
    if (gameExpanded) setGameExpanded(false);
    setGameSplit((px / d.total) * 100);
  };
  const onSplitPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!splitDrag.current) return;
    splitDrag.current = null;
    setSplitDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
  };
  const onSplitReset = (): void => {
    setGameExpanded(false);
    setGameSplit(null);
  };
  const onSplitKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const col = mainColRef.current;
    const area = gameAreaRef.current;
    if (!col || !area) return;
    e.preventDefault();
    const total = col.getBoundingClientRect().height;
    if (total <= 0) return;
    const cur = area.getBoundingClientRect().height;
    const px = clampSplitPx(cur + (e.key === 'ArrowDown' ? SPLIT_KEY_STEP_PX : -SPLIT_KEY_STEP_PX), total);
    if (gameExpanded) setGameExpanded(false);
    setGameSplit((px / total) * 100);
  };
  // Dragged split, clamped so a later window resize can't starve either side.
  // Applied only on the open, non-expanded split: the class rules keep owning
  // the closed (0) and expanded (100%) heights.
  const gameAreaStyle: React.CSSProperties | undefined =
    gameOpen && !gameExpanded && gameSplit !== null
      ? {
          height: `clamp(${SPLIT_MIN_GAME_PX}px, ${gameSplit}%, calc(100% - ${SPLIT_MIN_CHAT_PX}px))`,
        }
      : undefined;
  // Unread dot: a companion (or system) line that lands WHILE chat is hidden
  // lights a red dot on the toggle; showing chat again clears it. Derived from
  // the store's message list length, so pushed and awaited replies both count;
  // the user's own sends and hidden voice rows do not.
  const [gameUnread, setGameUnread] = useState(false);
  const seenCountRef = useRef(0);
  useEffect(() => {
    const prev = seenCountRef.current;
    seenCountRef.current = messages.length;
    if (!chatHidden || messages.length <= prev) return;
    if (messages.slice(prev).some((m) => m.role !== 'user' && !m.voice)) setGameUnread(true);
  }, [messages, chatHidden]);
  useEffect(() => {
    if (!chatHidden) setGameUnread(false);
  }, [chatHidden]);

  return (
    <div
      className={`${styles.root} ${panelOpen ? styles.presOpen : ''} ${
        gameOpen ? styles.gameOpen : ''
      } ${chatHidden ? styles.gameExpanded : ''} ${splitDragging ? styles.splitDragging : ''}`}
    >
      {/* ── Top bar: identical structure across chat, games and calls
          (260721) — the shared ChatTopBar. ── */}
      <ChatTopBar characterId={characterId} />

      <div className={styles.content}>
        <div className={styles.mainCol} ref={mainColRef}>
          {/* ── Game area (260721): the game surface rides ON TOP of the
              chat. GameSurface's bottom-left "V" expands it down over the
              chat; its bottom-right "x" is the unified end control. ── */}
          <section
            className={styles.gameArea}
            ref={gameAreaRef}
            style={gameAreaStyle}
            aria-label={
              chessReplayOpen
                ? 'Chess replay'
                : chessOpen
                ? 'Chess'
                : mcDashOpen
                  ? 'Minecraft dashboard'
                  : 'Minecraft'
            }
            aria-hidden={!gameOpen}
          >
            {gameOpen ? (
              <GameSurface
                expanded={chatHidden}
                unread={gameUnread}
                // The "V" always means "show me the chat again", so while
                // fullscreen is hiding it, pressing V leaves fullscreen rather
                // than toggling a state with no visible effect.
                onToggle={() => {
                  if (gameFullscreen) {
                    setGameFullscreen(false);
                    setGameExpanded(false);
                    return;
                  }
                  setGameExpanded((v) => !v);
                }}
                onEnd={onGameEnd}
                confirmEnd={confirmGameEnd}
              >
                {chessReplayOpen ? (
                  <ChessReplayPanel characterId={characterId} />
                ) : chessOpen ? (
                  <ChessPanel characterId={characterId} />
                ) : mcDashOpen ? (
                  <McDashboardPanel characterId={characterId} />
                ) : (
                  <McLaunchPanel characterId={characterId} />
                )}
              </GameSurface>
            ) : null}
          </section>

          {/* Zero-height boundary strip between game and chat: a ~6px hit
              area straddles it (cursor row-resize), a hairline lights on
              hover/drag. Double-click resets to the default split. */}
          {gameOpen ? (
            <div
              className={styles.splitHandle}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize game area"
              tabIndex={0}
              onPointerDown={onSplitPointerDown}
              onPointerMove={onSplitPointerMove}
              onPointerUp={onSplitPointerUp}
              onPointerCancel={onSplitPointerUp}
              onDoubleClick={onSplitReset}
              onKeyDown={onSplitKeyDown}
            />
          ) : null}

          <div className={styles.chatCol} aria-hidden={chatHidden}>

        {/* ── Message list ── */}
        <div
          className={showTyping ? `${styles.list} ${styles.listTyping}` : styles.list}
          ref={listRef}
          onScroll={onListScroll}
        >
          {loading ? <ChatSkeleton /> : null}
          {!loading && visibleMessages.length === 0 && !showTyping ? (
            <div className={styles.empty}>
              This is the beginning of your conversation with {companionName}. Say hi.
            </div>
          ) : null}
          {loading ? null : visibleMessages.map((m, i, arr) => {
            if (m.role === 'system') {
              if (m.event?.kind === 'play') {
                // A chess row that carries the recorded game opens its replay
                // in the game area (260724). Rows without moves stay plain.
                const replay = m.event.chess;
                if (replay && replay.moves.length > 0) {
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`${styles.systemRow} ${styles.playRow} ${styles.playRowClickable}`}
                      onClick={() => useChessStore.getState().openReplay(characterId, replay)}
                    >
                      <span className={styles.playIcon}>
                        <GamepadIcon size={18} />
                      </span>
                      <span>{m.text}</span>
                      <span className={styles.replayHint}>Watch replay</span>
                    </button>
                  );
                }
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
          {showTyping ? (
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
            {/* Close "x" pinned to the panel's top-right corner. Same path as
                clicking an author name again: hides the panel and persists the
                preference (setPanelOpen -> chat_panel_hidden). */}
            <button
              type="button"
              className={styles.presClose}
              onClick={() => setPanelOpen(false)}
              aria-label="Close profile"
              title="Close profile"
            >
              ×
            </button>
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
