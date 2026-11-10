/**
 * ChatTopBar — the ONE companion top bar (260721), shared by ChatScreen and
 * VoiceCallScreen so games and calls keep an identical header: back chevron,
 * avatar, name + dim #tag (opens the profile page) over the Presence line,
 * the icon buttons, and Play.
 *
 * Quiet register (product call 261110): the chat's right-hand presence panel
 * is gone, so its Play / Disconnect moved here as the screen's one accent
 * button (Play carries data-tutorial games-btn, the guide's games step). The
 * phone moved next to the composer on the chat view; the header keeps it only
 * on the call view, where it means "back to chat". The one-time games notice
 * is now a NoticeLine above the composer (lib/useGamesTip); Play retires it.
 *
 * Context-aware behavior, identical structure:
 *   - back:  chat → home; call view → back to that chat (the call keeps
 *            running; GameSurface's chrome row / the icon-rail badge carry it).
 *   - Play:  opens the games picker, including mid-call; Disconnect while a
 *            bot is online, the connecting label while it starts.
 *   - backseat: opens the screen-share source picker (260803). It is here
 *            because backseat's only other entry point is the share button in
 *            the call controls, which you cannot reach without already being on
 *            a call, so nobody who had not already found the feature ever saw
 *            it. From here, confirming a source starts the call as well (the
 *            picker arms a pending share; see ShareScreenModal). Its one-time
 *            beta tip was moved to the games button (260929).
 *   - SeiLink (261105, T337): her room on the desktop. Shown wherever SeiLink
 *            can run (useSeilinkStore availability). Not moved in -> the
 *            move-in flow (the sheet, or straight in); moved in -> her room
 *            editor (lib/seilink/seilinkFlow openSeilink). Lit while she lives
 *            there. The guide's SeiLink tour spotlights it (data-tutorial).
 *   - phone: call view only, back to chat (toggles the SURFACE; hanging up
 *            stays on the red button).
 */

import React, { useMemo } from 'react';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { retireGamesTip } from '../lib/useGamesTip';
import { presenceOf, useMinuteTick } from '../lib/presence';
import { connectingLabel } from '../lib/summonProgress';
import { sei } from '../lib/ipcClient';
import { visionBlocked, visionGateReason } from '../lib/visionGate';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from './PixelPortrait';
import { PhoneIcon, BackIcon, UserIcon, BackseatIcon, SeilinkIcon } from './icons';
import { Presence } from './Presence';
import { Button } from './Button';
import { movedInId, useSeilinkStore } from '../lib/stores/useSeilinkStore';
import { openSeilink } from '../lib/seilink/seilinkFlow';
import { IdTag } from './IdTag';
import { useT } from '../lib/i18n';
import styles from './ChatTopBar.module.css';

export interface ChatTopBarProps {
  characterId: string;
  /** A game surface is open below the header (ChatScreen's own `gameOpen`).
   *  Kept for the call sites; the games notice now lives in ChatScreen. */
  gameOpen?: boolean;
}

export function ChatTopBar({ characterId }: ChatTopBarProps): React.ReactElement {
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const setChatReturnId = useUiStore((s) => s.setChatReturnId);
  const onCallView = useUiStore((s) => s.view.kind === 'voice-call');
  const character = useDataStore((s) => s.characters.find((c) => c.id === characterId));
  const t = useT();
  const seilinkAvailable = useSeilinkStore((s) => s.availability?.enabled === true);
  const seilinkHere = useSeilinkStore((s) => movedInId(s.status) === characterId);

  // china-compat W9: backseat is an image surface, so a text-only local model
  // disables the button (never hides it) with the reason as its tooltip. Only
  // a confident 'no' locks; 'unknown' stays usable (backseatService's
  // LLM_NO_VISION gate is the authoritative backstop). The reason rides the
  // native `title` because the data-tip tooltip is one nowrap line.
  //
  // A live Minecraft summon disables it too (260907): backseat is mutually
  // exclusive with a summon (main refuses with BACKSEAT_MC_SESSION_ACTIVE),
  // so grey the button up front with the reason instead of letting the picker
  // flow fail at the end.
  const backseatBlocked = visionBlocked(useUiStore((s) => s.llmVision));
  const llmModel = useUiStore((s) => s.llmModel);
  const summon = useDataStore((s) => s.summons[characterId]);
  const summonKind = summon?.kind;
  const mcSummonActive = summonKind === 'online' || summonKind === 'connecting';
  const backseatDisabled = backseatBlocked || mcSummonActive;
  const backseatReason = backseatBlocked
    ? visionGateReason(t, 'backseat', llmModel)
    : mcSummonActive
      ? t('End the Minecraft session to use Backseat')
      : null;

  // Presence decays online -> idle on the shared minute ticker.
  useMinuteTick();
  const presence = character
    ? presenceOf(character, summon)
    : ({ category: 'idle', label: t('Idle') } as const);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';
  const companionName = character?.name ?? t('Companion');
  const palette = useMemo(
    () => pickPalette((character?.id ?? '') + (character?.name ?? ''), theme),
    [character?.id, character?.name, theme],
  );

  const onBack = (): void => {
    if (onCallView) navigate({ kind: 'chat', characterId });
    else navigate({ kind: 'home' });
  };

  const onProfile = (): void => {
    setChatReturnId(characterId);
    navigate({ kind: 'character', id: characterId });
  };

  const onPlay = (): void => {
    // Finding the games is what the one-time notice was for, so it retires too.
    retireGamesTip();
    openModal({ kind: 'games-picker', characterId });
  };

  const onDisconnect = (): void => {
    // Instant: drop the entry from the store immediately so the button flips
    // back to Play; `stop` still tears down any live session (idempotent).
    useDataStore.getState().setStatus({ kind: 'idle', characterId });
    void sei.stop(characterId);
  };

  return (
    <header className={styles.header}>
      <button
        type="button"
        className={styles.backBtn}
        onClick={onBack}
        aria-label={t('Back')}
        data-tip={t('Back')}
      >
        <BackIcon size={20} />
      </button>
      <div className={styles.headerAvatar}>
        {character ? (
          <PixelPortrait
            seed={character.id + character.name}
            palette={palette}
            size={44}
            portraitImage={character.portrait_image}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <UserIcon size={20} />
        )}
      </div>
      <div className={styles.identity}>
        <button
          type="button"
          className={styles.nameToggle}
          onClick={onProfile}
          aria-label={t("Open {name}'s profile", { name: companionName })}
        >
          <span className={styles.headerName}>{companionName}</span>
          {character?.public_id ? <IdTag id={character.public_id} size="sm" /> : null}
        </button>
        <Presence category={presence.category} label={presence.label} className={styles.presence} />
      </div>
      <div className={styles.headerActions}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => {
            if (!backseatDisabled) openModal({ kind: 'share-screen', characterId });
          }}
          disabled={backseatDisabled}
          aria-disabled={backseatDisabled}
          aria-label={t('Backseat (beta)')}
          title={backseatReason ?? undefined}
          data-tip={backseatReason ?? t('Backseat (beta)')}
          data-tip-edge="right"
          data-tutorial="backseat-btn"
        >
          <BackseatIcon size={20} />
        </button>
        {seilinkAvailable ? (
          <button
            type="button"
            className={seilinkHere ? `${styles.iconBtn} ${styles.iconBtnActive}` : styles.iconBtn}
            onClick={() => void openSeilink(characterId, 'button')}
            aria-label={t('WorldLink')}
            aria-pressed={seilinkHere}
            data-tip={seilinkHere ? t("WorldLink: edit {name}'s room", { name: companionName }) : t('WorldLink: put {name} on your desktop', { name: companionName })}
            data-tip-edge="right"
            data-tutorial="seilink-btn"
          >
            <SeilinkIcon size={20} />
          </button>
        ) : null}
        {/* The call view keeps its "back to chat" phone; on the chat view the
            Call button sits next to the composer (ChatScreen). */}
        {onCallView ? (
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.iconBtnActive}`}
            onClick={() => navigate({ kind: 'chat', characterId })}
            aria-label={t('Back to chat')}
            data-tip={t('Back to chat')}
            data-tip-edge="right"
            data-tutorial="call-btn"
          >
            <PhoneIcon size={20} />
          </button>
        ) : null}
        {summonKind === 'online' ? (
          <Button kind="danger" size="md" onClick={onDisconnect}>
            {t('Disconnect')}
          </Button>
        ) : summonKind === 'connecting' ? (
          <Button kind="ghost" size="md" disabled>
            {connectingLabel(summon, t)}
          </Button>
        ) : (
          <Button kind="primary" size="md" onClick={onPlay} data-tutorial="games-btn">
            {t('Play')}
          </Button>
        )}
      </div>
    </header>
  );
}
