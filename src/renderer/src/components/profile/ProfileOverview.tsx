/**
 * ProfileOverview (product call 261110): what a player sees first on a
 * companion they do not own (a built-in like Sui, or someone else's World
 * companion). It leads with who it is, not with settings rows:
 *
 *   - ProfileIntro: the description and its voice, with a play button
 *     (VoiceSample: the bundled clip, no TTS spend, for every pool voice).
 *     Layout A shows it in the page header above the actions; layout B at
 *     the top of this tab (`intro`).
 *   - the games it already has a look for (a Minecraft skin, a Stardew
 *     farmer, the Don't Starve Together survivor you picked), as cover
 *     tiles,
 *   - its public avatars, as portrait tiles,
 *   - a quiet Report link for someone else's companion.
 *
 * The big portrait is the page's art, and the name, share code, creator and
 * created date are the page header. Nothing here edits the companion: an
 * owner's controls never show on a companion you do not own. The few
 * settings that are yours for it live on the "Your settings" and More tabs
 * (ProfileSettings).
 */
import React, { useEffect, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { GAMES } from '../../lib/games';
import type { Character } from '@shared/characterSchema';
import type { AvatarItem } from '@shared/avatarLibrary';
import type { CharacterOverviewInfo } from '@shared/ipc';
import { NO_VOICE_ID, ownVoiceOf } from '@shared/voiceIds';
import { dstSurvivor } from '@shared/dstSurvivors';
import { FlagIcon } from '../icons';
import { useVoiceLabel } from './ProfileSettings';
import { VoiceSampleButton, type SampleResult } from './VoiceSample';
import styles from './ProfileOverview.module.css';

export interface ProfileIntroProps {
  character: Character;
  /** chars:overview-info; null while loading or when it failed. */
  info: CharacterOverviewInfo | null;
  onSample: (r: SampleResult) => void;
  /** 'header' = layout A's page header (clamped); 'wide' = layout B's Overview tab. */
  size: 'header' | 'wide';
}

/** The description, then the voice line (play button + who it sounds like). */
export function ProfileIntro(p: ProfileIntroProps): React.ReactElement {
  const { character } = p;
  const description = character.description?.trim() || '';
  // Someone else's own ElevenLabs voice cannot play for you: the label names
  // the Sei voice you hear instead (the sample plays that one too).
  const label = useVoiceLabel(character, { borrowed: !!ownVoiceOf(character.metadata) });
  const silent = character.metadata?.voiceId === NO_VOICE_ID;
  return (
    <div className={`${styles.intro} ${p.size === 'wide' ? styles.introWide : ''}`} data-ov="intro">
      {description ? (
        <p className={styles.desc} data-ov="description">
          {description}
        </p>
      ) : null}
      <div className={styles.voice} data-ov="voice">
        {silent ? null : (
          <VoiceSampleButton character={character} sampleVoiceId={p.info?.sampleVoiceId} onResult={p.onSample} />
        )}
        <span className={styles.voiceLabel}>{label}</span>
      </div>
    </div>
  );
}

export interface ProfileOverviewProps {
  character: Character;
  /** chars:overview-info; null while loading or when it failed. */
  info: CharacterOverviewInfo | null;
  /** It is in your library (the DST pick is yours only then). */
  inLibrary: boolean;
  /** Show the Report link (someone else's companion). */
  canReport: boolean;
  onReport: () => void;
  /** ProfileIntro, when this tab leads with it (layout B). */
  intro?: React.ReactNode;
}

export function ProfileOverview(p: ProfileOverviewProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  return (
    <div className={styles.overview} data-overview="true">
      {p.intro ?? null}
      <div className={styles.shelves}>
        <GamesShelf {...p} />
        <AvatarsShelf character={character} />
      </div>
      {p.canReport ? (
        <button
          type="button"
          className={styles.report}
          onClick={p.onReport}
          aria-label={t('Report {name}', { name: character.name })}
        >
          <FlagIcon size={12} />
          <span>{t('Report')}</span>
        </button>
      ) : null}
    </div>
  );
}

interface GameLook {
  id: 'minecraft' | 'stardew' | 'dontstarve';
  name: string;
  detail: string;
}

function GamesShelf(p: ProfileOverviewProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  const [dstPick, setDstPick] = useState<{ id: string; prefab: string | null } | null>(null);
  useEffect(() => {
    if (!p.inLibrary) return;
    let live = true;
    // The stored pick only: dstSurvivorGet would derive one (an LLM call).
    void sei
      .getConfig()
      .then((c) => {
        if (live) setDstPick({ id: character.id, prefab: c.dst_survivor?.[character.id]?.prefab ?? null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [p.inLibrary, character.id]);

  const games: GameLook[] = [];
  const skinPending = (character.metadata as Record<string, unknown> | undefined)?.skin_pending === true;
  if (character.skin.source !== 'none' && !skinPending) {
    games.push({
      id: 'minecraft',
      name: 'Minecraft',
      detail: t('Skin ready'),
    });
  }
  if (p.info?.stardewLook) games.push({ id: 'stardew', name: 'Stardew Valley', detail: t('Farmer look ready') });
  const prefab = dstPick && dstPick.id === character.id ? dstPick.prefab : null;
  if (prefab) {
    games.push({
      id: 'dontstarve',
      name: "Don't Starve Together",
      detail: t('Plays as {survivor}', { survivor: dstSurvivor(prefab).name }),
    });
  }

  return (
    <section className={styles.shelf} data-ov="games" aria-labelledby="profile-ov-games">
      <h2 className={styles.shelfHead} id="profile-ov-games">
        {t('Games')}
      </h2>
      {games.length === 0 ? (
        <p className={styles.none}>{t('No game looks yet. They are made on the first launch.')}</p>
      ) : (
        <ul className={styles.tiles}>
          {games.map((g) => (
            <li key={g.id} className={styles.game} data-game={g.id}>
              <GameCover id={g.id} />
              <span className={styles.tileName}>{g.name}</span>
              <span className={styles.tileDetail}>{g.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GameCover({ id }: { id: string }): React.ReactElement {
  const image = GAMES.find((g) => g.id === id)?.image;
  return (
    <span
      className={styles.cover}
      style={image ? { backgroundImage: `url("${image}")` } : undefined}
      aria-hidden="true"
    />
  );
}

/** Its public avatars (beyond the card image, which is the page's portrait). */
function AvatarsShelf({ character }: { character: Character }): React.ReactElement | null {
  const t = useT();
  const [avatars, setAvatars] = useState<{ id: string; list: AvatarItem[] } | null>(null);
  useEffect(() => {
    let live = true;
    void sei
      .avatarLibraryList(character.id)
      .then((v) => {
        if (live) setAvatars({ id: character.id, list: v?.list?.avatars ?? [] });
      })
      .catch(() => {});
    const off = sei.onAvatarLibrary?.((u) => {
      if (u.characterId === character.id) setAvatars({ id: character.id, list: u.view?.list?.avatars ?? [] });
    });
    return () => {
      live = false;
      off?.();
    };
  }, [character.id]);
  const extra = (avatars && avatars.id === character.id ? avatars.list : []).filter((a) => a.source !== 'card');
  if (extra.length === 0) return null;
  return (
    <section className={styles.shelf} data-ov="avatars" aria-labelledby="profile-ov-avatars">
      <h2 className={styles.shelfHead} id="profile-ov-avatars">
        {t('Avatars')}
      </h2>
      <ul className={styles.tiles}>
        {extra.map((a) => {
          const kindLabel = a.kind === 'live2d' ? 'Live2D' : a.kind === 'rig' ? t('Rigged model') : t('Image');
          // Most avatars arrive without a name: the tile is the picture (or
          // its kind), with a caption only when there is a name.
          return (
            <li key={a.id} className={styles.avatar} title={a.name ?? kindLabel}>
              <span className={styles.avatarArt}>
                {a.kind === 'portrait' && a.url ? (
                  <img src={a.url} alt={a.name ?? kindLabel} draggable={false} />
                ) : (
                  <span className={styles.avatarKind}>{kindLabel}</span>
                )}
              </span>
              {a.name ? <span className={styles.tileDetail}>{a.name}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
