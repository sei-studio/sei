/**
 * ProfileOverview (product call 261110): what a player sees first on a
 * companion they do not own (a built-in like Sui, or someone else's World
 * companion). Settings rows were the wrong first impression for someone
 * deciding whether to invite a companion, so this leads with who it is:
 *
 *   - the description (the big portrait is the page's hero layer, and the
 *     name, share code, creator, add count and created date are the page
 *     header above this),
 *   - its voice, with a play button (VoiceSample: the bundled clip, no TTS
 *     spend, for every pool voice),
 *   - the games it already has a look for (a Minecraft skin, a Stardew
 *     farmer, the Don't Starve Together survivor you picked),
 *   - its public avatars,
 *   - a quiet Report link for someone else's companion.
 *
 * Nothing here edits the companion: an owner's controls never show on a
 * companion you do not own. The few settings that are yours for it live on
 * the page's "Your settings" tab (ProfileSettings, foreign view).
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

export interface ProfileOverviewProps {
  character: Character;
  /** chars:overview-info; null while loading or when it failed. */
  info: CharacterOverviewInfo | null;
  /** It is in your library (the DST pick is yours only then). */
  inLibrary: boolean;
  /** Show the Report link (someone else's companion). */
  canReport: boolean;
  onReport: () => void;
  onSample: (r: SampleResult) => void;
}

export function ProfileOverview(p: ProfileOverviewProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  const description = character.description?.trim() || '';
  return (
    <div className={styles.overview} data-overview="true">
      {description ? (
        <p className={styles.desc} data-ov="description">
          {description}
        </p>
      ) : null}
      <dl className={styles.facts}>
        <VoiceFact {...p} />
        <GamesFact {...p} />
        <AvatarsFact character={character} />
      </dl>
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

function VoiceFact(p: ProfileOverviewProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  // Someone else's own ElevenLabs voice cannot play for you: the label names
  // the Sei voice you hear instead (the sample plays that one too).
  const label = useVoiceLabel(character, { borrowed: !!ownVoiceOf(character.metadata) });
  const silent = character.metadata?.voiceId === NO_VOICE_ID;
  return (
    <div className={styles.fact} data-ov="voice">
      <dt>{t('Voice')}</dt>
      <dd className={styles.voice}>
        {silent ? null : (
          <VoiceSampleButton character={character} sampleVoiceId={p.info?.sampleVoiceId} onResult={p.onSample} />
        )}
        <span className={styles.voiceLabel}>{label}</span>
      </dd>
    </div>
  );
}

interface GameLook {
  id: 'minecraft' | 'stardew' | 'dontstarve';
  name: string;
  detail: string;
}

function GamesFact(p: ProfileOverviewProps): React.ReactElement {
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
    <div className={styles.fact} data-ov="games">
      <dt>{t('Games')}</dt>
      <dd>
        {games.length === 0 ? (
          <span className={styles.none}>{t('No game looks yet. They are made on the first launch.')}</span>
        ) : (
          <ul className={styles.games}>
            {games.map((g) => (
              <li key={g.id} className={styles.game} data-game={g.id}>
                <GameThumb id={g.id} />
                <span className={styles.gameText}>
                  <span className={styles.gameName}>{g.name}</span>
                  <span className={styles.gameDetail}>{g.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}

function GameThumb({ id }: { id: string }): React.ReactElement | null {
  const image = GAMES.find((g) => g.id === id)?.image;
  if (!image) return null;
  return <span className={styles.gameThumb} style={{ backgroundImage: `url("${image}")` }} aria-hidden="true" />;
}

/** Its public avatars (beyond the card image, which is the hero portrait). */
function AvatarsFact({ character }: { character: Character }): React.ReactElement | null {
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
    <div className={styles.fact} data-ov="avatars">
      <dt>{t('Avatars')}</dt>
      <dd>
        <ul className={styles.avatars}>
          {extra.map((a) => {
            const kindLabel = a.kind === 'live2d' ? 'Live2D' : a.kind === 'rig' ? t('Rigged model') : t('Image');
            return (
              <li key={a.id} className={styles.avatar} title={a.name ?? kindLabel}>
                <span className={styles.avatarThumb}>
                  {a.kind === 'portrait' && a.url ? (
                    <img src={a.url} alt="" draggable={false} />
                  ) : (
                    <span className={styles.avatarKind}>{kindLabel}</span>
                  )}
                </span>
                <span className={styles.avatarName}>{a.name ?? kindLabel}</span>
              </li>
            );
          })}
        </ul>
      </dd>
    </div>
  );
}
