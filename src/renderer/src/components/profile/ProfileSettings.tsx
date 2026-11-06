/**
 * ProfileSettings (261107, profile v0.7 "Option A"): the content of ONE
 * profile tab. CharacterPage renders the hero portrait, the name, the meta
 * line, the tab bar and the pinned Chat / Play row; this renders only the
 * active tab's rows, so no tab can be scrolled into another.
 *
 * Every row is label + value + action(s). The actions open the existing
 * editors (the page owns those popups and passes openers in); who may use
 * which row comes from lib/profileRows.ts. Each tab component mounts only
 * while its tab is active, so its reads (voices, knowledge, the avatar
 * library, the room) run only when it is shown.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { sei } from '../../lib/ipcClient';
import { useT } from '../../lib/i18n';
import { useDataStore } from '../../lib/stores/useDataStore';
import { useUiStore } from '../../lib/stores/useUiStore';
import { movedInId, useSeilinkStore } from '../../lib/stores/useSeilinkStore';
import { moveInOrOut, openRoomEditor, replayIntro } from '../../lib/seilink/seilinkFlow';
import { ROOM_PRESET_LABEL } from '../../lib/seilink/moveIn';
import { requestGameLaunch, openGame } from '../../lib/gameLaunch';
import { portraitSrc } from '../../lib/portraitSrc';
import { effectiveSharedVoice, poolVoiceLabel } from '../../lib/sharedVoice';
import { useSharedVoiceInfo } from '../SharedVoiceChoice';
import { lockTipKey, type ProfileAccess, type ProfileAction, type ProfileTab } from '../../lib/profileRows';
import type { Character } from '@shared/characterSchema';
import { effectiveMcUsername, portraitVersionIndex } from '@shared/characterSchema';
import type { AvatarLibraryView } from '@shared/avatarLibrary';
import type { VoiceInfo } from '@shared/ipc';
import { NO_VOICE_ID, ownVoiceOf, sharedVoiceIdOf } from '@shared/voiceIds';
import { VOICE_PITCH_MAX, VOICE_PITCH_MIN, voicePitchRate } from '@shared/voicePitch';
import { dstSurvivor } from '@shared/dstSurvivors';
import type { EditSection } from '../EditCharacterModal';
import { Button } from '../Button';
import { Toggle } from '../Toggle';
import { SparkleIcon } from '../icons';
import { useSkinGenerate } from '../SkinGenerateButton';
import { HoverTip } from './HoverTip';
import { ActionChip, ProfileRow, RowValue } from './ProfileRow';
import styles from './Profile.module.css';

export interface ProfileSettingsProps {
  character: Character;
  access: ProfileAccess;
  tab: ProfileTab;
  onAction: (action: ProfileAction) => void;
  onTipOpen: (key: string) => void;
  openEdit: (section: EditSection) => void;
  /** The card image popup; `regenerate` starts a regeneration at once. */
  openCardImage: (regenerate: boolean) => void;
  openKnowledge: () => void;
  openSkinEdit: () => void;
  openAvatars: (manage: boolean) => void;
  openFloating: () => void;
  onToggleShared: () => void;
  shareToggleDisabled: boolean;
  onResetMemory: () => void;
  onUnbind: () => void;
  onReport: () => void;
  /** Bumped when a popup that changes a row's value closes (re-read it). */
  refreshKey: number;
  /** The one-time regenerate hint, drawn on the card image's Regenerate button. */
  regenHint?: React.ReactNode;
}

export function ProfileSettings(props: ProfileSettingsProps): React.ReactElement {
  switch (props.tab) {
    case 'look':
      return <LookTab {...props} />;
    case 'voice':
      return <VoiceTab {...props} />;
    case 'personality':
      return <PersonalityTab {...props} />;
    case 'games':
      return <GamesTab {...props} />;
    case 'sharing':
      return <SharingTab {...props} />;
    case 'danger':
      return <DangerTab {...props} />;
  }
}

/** The Locked marker's tooltip for this companion. */
function useLockTip(p: ProfileSettingsProps): string {
  const t = useT();
  return t(lockTipKey(p.access.kind), { name: p.character.name });
}

// ── Look ──────────────────────────────────────────────────────────────────

interface CardVersions {
  id: string;
  left: number;
  count: number;
  label: string | null;
}

function LookTab(p: ProfileSettingsProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  const hasPortrait = !!portraitSrc(character.portrait_image);

  // Card image versions + regenerations left (owned companions only).
  const [versions, setVersions] = useState<CardVersions | null>(null);
  useEffect(() => {
    if (access.cardImage !== 'edit') return;
    let live = true;
    void sei
      .charsPortraitVersions(character.id)
      .then((st) => {
        if (!live || !st) return;
        const active = st.versions.find((v) => v.file === st.active) ?? null;
        const label = !active
          ? null
          : active.source === 'original'
            ? t('Original')
            : t('v{n}', { n: portraitVersionIndex(character.id, active.file) ?? st.versions.indexOf(active) + 1 });
        setVersions({
          id: character.id,
          left: Math.max(0, st.regenLimit - st.regenCount),
          count: st.versions.length,
          label,
        });
      })
      .catch(() => {
        /* unknown: no count chip */
      });
    return () => {
      live = false;
    };
    // t only formats the label; a language switch re-renders anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access.cardImage, character.id, character.portrait_image, p.refreshKey]);
  const cv = versions && versions.id === character.id ? versions : null;

  const thumb = hasPortrait ? (
    <img className={styles.thumb} src={portraitSrc(character.portrait_image) ?? undefined} alt="" draggable={false} />
  ) : null;
  const cardText = !hasPortrait
    ? t('No card image')
    : access.cardImage !== 'edit'
      ? t('Original art')
      : cv && cv.label
        ? cv.count > 1
          ? t('{version} ({n, plural, one {# version} other {# versions}})', { version: cv.label, n: cv.count })
          : cv.label
        : t('Card image');

  const skinGen = useSkinGenerate(character, () => void refreshCharacter(character.id));
  const showSkinGen = access.skinGenerate && skinGen.visible;

  // Avatar library: what plays, and whether there is anything to pick.
  const [avatarView, setAvatarView] = useState<AvatarLibraryView | null>(null);
  useEffect(() => {
    let live = true;
    void sei
      .avatarLibraryList(character.id)
      .then((v) => {
        if (live) setAvatarView(v);
      })
      .catch(() => {});
    const off = sei.onAvatarLibrary?.((u) => {
      if (u.characterId === character.id) setAvatarView(u.view);
    });
    return () => {
      live = false;
      off?.();
    };
  }, [character.id]);
  const list = avatarView?.list ?? null;
  const playing = list?.avatars.find((a) => a.id === avatarView?.effective_id) ?? null;
  const avatarText =
    !playing || playing.source === 'card'
      ? t('Card image')
      : (playing.name ??
        (playing.kind === 'live2d' ? 'Live2D' : playing.kind === 'rig' ? t('Rigged model') : t('Image')));
  const canPick = !!list && !list.is_owner && list.avatars.length >= 2;

  const prefs = useUiStore((s) => s.avatarPrefsByCharacter[character.id]);
  const floatingText =
    prefs?.tab === 'live2d'
      ? 'Live2D'
      : (prefs?.frame ?? 'circle') === 'square'
        ? t('Static, square frame')
        : t('Static, circle frame');

  return (
    <div className={styles.rows}>
      <ProfileRow
        rowId="card-image"
        label={t('Card image')}
        tip={t('Every version is kept on this device. Only the one you pick is shown to others.')}
        tipKey="card_image"
        onTipOpen={p.onTipOpen}
        value={<RowValue lead={thumb} text={cardText} wrap />}
        lockedTip={access.cardImage === 'locked' ? lockTip : null}
        actions={
          <>
            <Button
              kind="secondary"
              size="sm"
              onClick={() => {
                p.onAction('card_versions');
                p.openCardImage(false);
              }}
            >
              {t('Versions')}
            </Button>
            {hasPortrait ? (
              <span className={styles.anchor}>
                <Button
                  kind="soft"
                  size="sm"
                  icon={<SparkleIcon size={13} />}
                  disabled={cv !== null && cv.left === 0}
                  onClick={() => {
                    p.onAction('regenerate_card');
                    p.openCardImage(true);
                  }}
                >
                  <span>{t('Regenerate')}</span>
                  {cv ? <ActionChip>{t('{n} left', { n: cv.left })}</ActionChip> : null}
                </Button>
                {p.regenHint}
              </span>
            ) : null}
          </>
        }
      />
      <ProfileRow
        rowId="skin"
        label={t('Minecraft skin')}
        tip={t('How {name} looks in Minecraft.', { name: character.name })}
        tipKey="skin"
        onTipOpen={p.onTipOpen}
        value={
          skinGen.line ? (
            <span className={skinGen.ok ? styles.resultOk : styles.resultErr} role="status">
              {skinGen.line}
            </span>
          ) : (
            <RowValue lead={<SkinHead character={character} />} text={skinText(character, t)} />
          )
        }
        lockedTip={access.skin === 'locked' ? lockTip : null}
        actions={
          <>
            {access.skinEdit ? (
              <Button
                kind="secondary"
                size="sm"
                onClick={() => {
                  p.onAction('edit_skin');
                  p.openSkinEdit();
                }}
              >
                {t('Edit')}
              </Button>
            ) : null}
            {showSkinGen ? (
              <Button
                kind="secondary"
                size="sm"
                icon={<SparkleIcon size={13} />}
                disabled={skinGen.running || skinGen.botOnline}
                onClick={() => {
                  p.onAction('regenerate_skin');
                  void skinGen.run();
                }}
              >
                <span>{skinGen.running ? t('Making skin...') : skinGen.firstSkin ? t('Make') : t('Regenerate')}</span>
                {skinGen.running ? null : <ActionChip>{t('uses credits')}</ActionChip>}
              </Button>
            ) : null}
          </>
        }
      />
      <ProfileRow
        rowId="avatar"
        label={t('Avatar')}
        tip={t('The picture used for WorldLink and calls.')}
        tipKey="avatar"
        onTipOpen={p.onTipOpen}
        value={<RowValue text={avatarText} />}
        actions={
          access.avatar === 'manage' ? (
            <Button
              kind="secondary"
              size="sm"
              onClick={() => {
                p.onAction('manage_avatars');
                p.openAvatars(true);
              }}
            >
              {t('Manage')}
            </Button>
          ) : canPick ? (
            <Button
              kind="secondary"
              size="sm"
              onClick={() => {
                p.onAction('change_avatar');
                p.openAvatars(false);
              }}
            >
              {t('Change')}
            </Button>
          ) : null
        }
      />
      <ProfileRow
        rowId="floating-avatar"
        label={t('Floating avatar')}
        tip={t('How {name} looks on the floating avatar. Turn the avatar on in Settings.', { name: character.name })}
        tipKey="floating_avatar"
        onTipOpen={p.onTipOpen}
        value={<RowValue text={floatingText} />}
        actions={
          <Button
            kind="secondary"
            size="sm"
            onClick={() => {
              p.onAction('floating_avatar');
              p.openFloating();
            }}
          >
            {t('Change')}
          </Button>
        }
      />
    </div>
  );
}

type T = (key: string, vars?: Record<string, string | number>) => string;

function skinText(c: Character, t: T): string {
  if ((c.metadata as Record<string, unknown> | undefined)?.skin_pending === true) return t('Making skin...');
  switch (c.skin.source) {
    case 'bundled':
      return t('Original skin');
    case 'upload':
      return t('Custom skin');
    case 'username':
      return c.skin.mojang_username ? t('From {name}', { name: c.skin.mojang_username }) : t('Custom skin');
    default:
      return t('Default skin');
  }
}

/** The skin's face (8x8 at 8,8) and hat layer (40,8), from the local skin server. */
function SkinHead({ character }: { character: Character }): React.ReactElement | null {
  const [base, setBase] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    void sei
      .getSkinServerUrl()
      .then((r) => {
        if (live) setBase(r.baseUrl);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const url = base
    ? `${base}/skins/${encodeURIComponent(effectiveMcUsername(character))}.png?sha=${character.skin.png_sha256 ?? 'none'}`
    : null;
  useEffect(() => setOk(false), [url]);
  if (!url) return null;
  return (
    <span className={styles.head} aria-hidden="true" style={ok ? undefined : { display: 'none' }}>
      <img src={url} alt="" onLoad={() => setOk(true)} onError={() => setOk(false)} className={styles.headProbe} />
      <i style={{ backgroundImage: `url("${url}")` }} />
      <i className={styles.headHat} style={{ backgroundImage: `url("${url}")` }} />
    </span>
  );
}

// ── Voice ─────────────────────────────────────────────────────────────────

function useVoiceLabel(character: Character): string {
  const t = useT();
  const [pool, setPool] = useState<VoiceInfo[] | null>(null);
  const id = typeof character.metadata?.voiceId === 'string' ? (character.metadata.voiceId as string) : null;
  useEffect(() => {
    let live = true;
    void sei
      .voiceListVoices()
      .then((v) => {
        if (live) setPool(v);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const own = ownVoiceOf(character.metadata);
  if (id === NO_VOICE_ID) return t('No voice');
  if (!id) return t('Auto');
  if (own) return own.name;
  const v = pool?.find((x) => x.id === id);
  return v ? (v.vibe ? t('{name}, {vibe}', { name: v.label, vibe: v.vibe }) : v.label) : t('A Sei voice');
}

function VoiceTab(p: ProfileSettingsProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const label = useVoiceLabel(character);
  const rate = Math.round(voicePitchRate(character) * 100) / 100;
  const locked = access.voice === 'locked';
  const voiceText = locked && rate !== 1 ? t('{voice}, pitch {pitch}', { voice: label, pitch: rate.toFixed(2) }) : label;
  return (
    <div className={styles.rows}>
      <ProfileRow
        rowId="voice"
        label={t('Voice')}
        value={<RowValue text={voiceText} />}
        lockedTip={locked ? lockTip : null}
        actions={
          <Button
            kind="secondary"
            size="sm"
            onClick={() => {
              p.onAction('edit_voice');
              p.openEdit('voice');
            }}
          >
            {t('Change')}
          </Button>
        }
      />
      {access.pitch === 'edit' ? <PitchRow character={character} rate={rate} onAction={p.onAction} /> : null}
    </div>
  );
}

/**
 * Pitch, inline. Saves when the slider is let go (or on a key change), with
 * the same neutral-value rule as the voice editor: a companion with a baked
 * non-neutral default (Sui) stores 1 explicitly, everyone else drops the key.
 */
function PitchRow({
  character,
  rate,
  onAction,
}: {
  character: Character;
  rate: number;
  onAction: (a: ProfileAction) => void;
}): React.ReactElement {
  const t = useT();
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  const [draft, setDraft] = useState<number>(rate);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(rate), [rate]);

  const commit = async (value: number): Promise<void> => {
    if (value === rate) return;
    onAction('pitch');
    setError(null);
    try {
      const latest = (await sei.getCharacter(character.id)) ?? character;
      const metadata: Record<string, unknown> = { ...(latest.metadata ?? {}) };
      const bakedNeutral = voicePitchRate({ id: character.id, metadata: {} }) === 1;
      if (value === 1 && bakedNeutral) delete metadata.voicePitch;
      else metadata.voicePitch = value;
      await sei.saveCharacter({ ...latest, metadata }, { skipExpansion: true });
      await refreshCharacter(character.id);
    } catch (err) {
      setError((err as Error)?.message ?? t('Failed to save voice settings.'));
      setDraft(rate);
    }
  };

  return (
    <ProfileRow
      rowId="pitch"
      label={t('Pitch')}
      value={
        error ? (
          <span className={styles.resultErr} role="alert">
            {error}
          </span>
        ) : (
          <span className={styles.slider}>
            <input
              type="range"
              min={VOICE_PITCH_MIN}
              max={VOICE_PITCH_MAX}
              step={0.01}
              value={draft}
              aria-label={t('Pitch')}
              onChange={(e) => setDraft(Number(e.currentTarget.value))}
              onPointerUp={(e) => void commit(Number(e.currentTarget.value))}
              onKeyUp={(e) => void commit(Number(e.currentTarget.value))}
              onBlur={(e) => void commit(Number(e.currentTarget.value))}
            />
            <span className={styles.mono}>{draft.toFixed(2)}</span>
          </span>
        )
      }
    />
  );
}

// ── Personality ───────────────────────────────────────────────────────────

function PersonalityTab(p: ProfileSettingsProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const [knowledge, setKnowledge] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (access.knowledge !== 'edit') return;
    let live = true;
    void sei
      .knowledgeList(character.id)
      .then((list) => {
        if (live) setKnowledge({ id: character.id, n: list.length });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [access.knowledge, character.id, p.refreshKey]);
  const kn = knowledge && knowledge.id === character.id ? knowledge.n : null;

  const description = character.description?.trim() || '';
  const personaText =
    access.persona === 'edit'
      ? character.metadata?.prompt_mode === 'advanced'
        ? t('Advanced')
        : t('Standard')
      : access.kind === 'builtin'
        ? t('Written by Sei')
        : access.kind === 'awakened'
          ? t('Cast by Sei')
          : t('Written by their creator');

  return (
    <div className={styles.rows}>
      <ProfileRow
        rowId="name"
        label={t('Name')}
        value={<RowValue text={character.name} />}
        lockedTip={access.name === 'locked' ? lockTip : null}
        actions={
          <Button
            kind="secondary"
            size="sm"
            onClick={() => {
              p.onAction('rename');
              p.openEdit('basic');
            }}
          >
            {t('Rename')}
          </Button>
        }
      />
      <ProfileRow
        rowId="description"
        label={t('Description')}
        tall
        value={
          <span className={styles.clamp} title={description || undefined}>
            {description || t('No description yet.')}
          </span>
        }
        lockedTip={access.description === 'locked' ? lockTip : null}
        actions={
          <Button
            kind="secondary"
            size="sm"
            onClick={() => {
              p.onAction('edit_description');
              p.openEdit('basic');
            }}
          >
            {t('Edit')}
          </Button>
        }
      />
      <ProfileRow
        rowId="persona"
        label={t('Persona')}
        tip={t('The prompt that shapes how {name} talks and acts.', { name: character.name })}
        tipKey="persona"
        onTipOpen={p.onTipOpen}
        value={<RowValue text={personaText} />}
        lockedTip={access.persona === 'locked' ? lockTip : null}
        actions={
          <Button
            kind="secondary"
            size="sm"
            onClick={() => {
              p.onAction('edit_persona');
              p.openEdit('persona');
            }}
          >
            {t('Edit')}
          </Button>
        }
      />
      {access.knowledge === 'edit' ? (
        <ProfileRow
          rowId="knowledge"
          label={t('Knowledge')}
          tip={t('Files and notes {name} can read when you talk.', { name: character.name })}
          tipKey="knowledge"
          onTipOpen={p.onTipOpen}
          value={
            <RowValue
              text={
                kn === null
                  ? ''
                  : kn === 0
                    ? t('None yet')
                    : t('{n, plural, one {# entry} other {# entries}}', { n: kn })
              }
            />
          }
          actions={
            <Button
              kind="secondary"
              size="sm"
              onClick={() => {
                p.onAction('knowledge');
                p.openKnowledge();
              }}
            >
              {t('Manage')}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

// ── Games ─────────────────────────────────────────────────────────────────

const DST_NAME = "Don't Starve Together";

function GamesTab(p: ProfileSettingsProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const [survivor, setSurvivor] = useState<{ id: string; prefab: string | null } | null>(null);
  useEffect(() => {
    if (access.dst !== 'edit') return;
    let live = true;
    // The stored pick only: dstSurvivorGet would derive one (an LLM call) on first use.
    void sei
      .getConfig()
      .then((c) => {
        if (live) setSurvivor({ id: character.id, prefab: c.dst_survivor?.[character.id]?.prefab ?? null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [access.dst, character.id]);
  const prefab = survivor && survivor.id === character.id ? survivor.prefab : undefined;

  const chess = (character.metadata?.chess ?? null) as { elo?: number } | null;
  const chessText = chess && typeof chess.elo === 'number' ? t('Custom, Elo {elo}', { elo: chess.elo }) : t('Auto');

  return (
    <div className={styles.rows}>
      <ProfileRow
        rowId="username"
        label={t('In-game username')}
        tip={t('The name {name} uses in Minecraft worlds.', { name: character.name })}
        tipKey="username"
        onTipOpen={p.onTipOpen}
        value={<RowValue text={effectiveMcUsername(character)} mono />}
        lockedTip={access.username === 'locked' ? lockTip : null}
        actions={
          <Button
            kind="secondary"
            size="sm"
            onClick={() => {
              p.onAction('change_username');
              p.openSkinEdit();
            }}
          >
            {t('Change')}
          </Button>
        }
      />
      <ProfileRow
        rowId="chess"
        label={t('Chess')}
        tip={t('How {name} plays chess. On Auto, strength and style come from the persona.', { name: character.name })}
        tipKey="chess"
        onTipOpen={p.onTipOpen}
        value={<RowValue text={chessText} />}
        lockedTip={access.chess === 'locked' ? lockTip : null}
        actions={
          <Button
            kind="secondary"
            size="sm"
            onClick={() => {
              p.onAction('edit_chess');
              p.openEdit('games');
            }}
          >
            {t('Change')}
          </Button>
        }
      />
      {access.dst === 'edit' ? (
        <ProfileRow
          rowId="dst"
          label={DST_NAME}
          value={
            <RowValue
              text={
                prefab === undefined
                  ? ''
                  : prefab
                    ? t('Plays as {survivor}', { survivor: dstSurvivor(prefab).name })
                    : t('Picks on the first launch')
              }
            />
          }
          actions={
            <Button
              kind="secondary"
              size="sm"
              onClick={() => {
                p.onAction('dst_survivor');
                requestGameLaunch(character.id, { id: 'dontstarve', name: DST_NAME }, () =>
                  openGame(character.id, 'dontstarve'),
                );
              }}
            >
              {t('Change')}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

// ── Sharing and WorldLink ────────────────────────────────────────────────

function SharingTab(p: ProfileSettingsProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const livingId = useSeilinkStore((s) => movedInId(s.status));
  const failedHere = useSeilinkStore((s) => s.status.state === 'failed' && s.status.characterId === character.id);
  const moveBusy = useSeilinkStore((s) => s.moveBusy);
  const livesHere = livingId === character.id;

  // Others will hear (own ElevenLabs voice only).
  const { pool, defaultId } = useSharedVoiceInfo(character.id, undefined);
  const othersLabel = useMemo(
    () => poolVoiceLabel(effectiveSharedVoice(sharedVoiceIdOf(character.metadata), defaultId, pool), pool),
    [character.metadata, defaultId, pool],
  );

  // Her room's preset.
  const [room, setRoom] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (access.room !== 'edit') return;
    let live = true;
    void sei
      .seilinkRoomGet?.(character.id)
      .then((r) => {
        if (!live) return;
        setRoom({
          id: character.id,
          text: r.saved ? t(ROOM_PRESET_LABEL[r.state.preset] ?? 'Cozy') : t('Not set up yet'),
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access.room, character.id, p.refreshKey]);

  // Idle lines: the global seilink_deafened flag, inverted.
  const [idleOn, setIdleOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (access.idleLines !== 'edit') return;
    let live = true;
    void sei
      .getConfig()
      .then((c) => {
        if (live) setIdleOn(c.seilink_deafened !== true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [access.idleLines]);

  return (
    <div className={styles.rows}>
      {access.publicToggle === 'edit' ? (
        <ProfileRow
          rowId="public"
          label={t('Public')}
          tip={t('Others can invite {name}. Memory stays private.', { name: character.name })}
          tipKey="public"
          onTipOpen={p.onTipOpen}
          value={<RowValue text={character.shared ? t('On') : t('Off')} />}
          actions={
            <Toggle
              on={character.shared}
              onChange={() => {
                p.onAction('toggle_public');
                p.onToggleShared();
              }}
              disabled={p.shareToggleDisabled}
              aria-label={
                character.shared
                  ? t('Companion is public. Turn off to make private.')
                  : t('Companion is private. Turn on to make public.')
              }
            />
          }
        />
      ) : null}
      {access.othersHear !== 'hidden' ? (
        <ProfileRow
          rowId="others-hear"
          label={t('Others will hear')}
          tip={t('Your own ElevenLabs voice only plays for you. Other players hear this Sei voice.')}
          tipKey="others_hear"
          onTipOpen={p.onTipOpen}
          value={<RowValue text={othersLabel ?? t('A Sei voice')} />}
          lockedTip={access.othersHear === 'locked' ? lockTip : null}
          actions={
            <Button
              kind="secondary"
              size="sm"
              onClick={() => {
                p.onAction('others_hear');
                p.openEdit('voice');
              }}
            >
              {t('Change')}
            </Button>
          }
        />
      ) : null}
      {access.desktopRoom === 'edit' ? (
        <ProfileRow
          rowId="desktop-room"
          label={t('Desktop room')}
          value={
            failedHere && !livesHere ? (
              <HoverTip
                tip={t('Her desktop room kept stopping, so it was turned off. Move her in to try again.')}
                onOpen={() => p.onTipOpen('desktop_room_stopped')}
              >
                <RowValue lead={<span className={`${styles.dot} ${styles.dotBad}`} />} text={t('Stopped')} />
              </HoverTip>
            ) : (
              <RowValue
                lead={<span className={`${styles.dot} ${livesHere ? styles.dotOn : ''}`} />}
                text={livesHere ? t('On your desktop') : t('Not on your desktop')}
              />
            )
          }
          actions={
            <Button
              kind="secondary"
              size="sm"
              disabled={moveBusy}
              onClick={() => {
                p.onAction(livesHere ? 'move_off_desktop' : 'move_onto_desktop');
                // 'gear' is the profile's settings entry (it was the gear menu
                // until 261107); kept so the seilink_entry series stays whole.
                void moveInOrOut(character.id, 'gear');
              }}
            >
              {livesHere ? t('Move off desktop') : t('Move onto desktop')}
            </Button>
          }
        />
      ) : null}
      {access.room === 'edit' ? (
        <ProfileRow
          rowId="room"
          label={t('Room')}
          value={<RowValue text={room && room.id === character.id ? room.text : ''} />}
          actions={
            <Button
              kind="secondary"
              size="sm"
              onClick={() => {
                p.onAction('edit_room');
                openRoomEditor(character.id, 'gear');
              }}
            >
              {t('Edit room')}
            </Button>
          }
        />
      ) : null}
      {access.idleLines === 'edit' ? (
        <ProfileRow
          rowId="idle-lines"
          label={t('Idle lines')}
          tip={t('Lines {name} says on the desktop without being asked. A click still gets a reply.', {
            name: character.name,
          })}
          tipKey="idle_lines"
          onTipOpen={p.onTipOpen}
          value={<RowValue text={idleOn === null ? '' : idleOn ? t('On') : t('Off')} />}
          actions={
            <Toggle
              on={idleOn === true}
              disabled={idleOn === null || !sei.seilinkSetIdleLines}
              aria-label={t('Idle lines')}
              onChange={(next) => {
                p.onAction(next ? 'idle_lines_on' : 'idle_lines_off');
                setIdleOn(next);
                void sei.seilinkSetIdleLines?.(next).then(setIdleOn, () => setIdleOn(!next));
              }}
            />
          }
        />
      ) : null}
      {access.intro === 'edit' ? (
        <ProfileRow
          rowId="intro"
          label={t('WorldLink intro')}
          actions={
            <Button
              kind="secondary"
              size="sm"
              onClick={() => {
                p.onAction('replay_intro');
                replayIntro(character.id, 'gear');
              }}
            >
              {t('Replay')}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

// ── Danger zone ───────────────────────────────────────────────────────────

function DangerTab(p: ProfileSettingsProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const name = character.name;
  const unbindTip =
    access.kind === 'world'
      ? t('Removes {name} from your library. You can invite them again from World.', { name })
      : access.kind === 'builtin'
        ? t('Removes {name} from your library. You can add them back from World.', { name })
        : t('Removes {name} for good. This cannot be undone.', { name });
  return (
    <div className={styles.rows}>
      {access.report === 'edit' ? (
        <ProfileRow
          rowId="report"
          danger
          label={t('Report')}
          tip={t('Tell us if {name} breaks the rules.', { name })}
          tipKey="report"
          onTipOpen={p.onTipOpen}
          actions={
            <Button
              kind="dangerSoft"
              size="sm"
              aria-label={t('Report {name}', { name })}
              onClick={() => {
                p.onAction('report');
                p.onReport();
              }}
            >
              {t('Report')}
            </Button>
          }
        />
      ) : null}
      {access.resetMemory === 'edit' ? (
        <ProfileRow
          rowId="reset-memory"
          danger
          label={t('Reset memory')}
          tip={t('Wipes chats and memories of you. Game inventory stays.')}
          tipKey="reset_memory"
          onTipOpen={p.onTipOpen}
          actions={
            <Button
              kind="dangerSoft"
              size="sm"
              onClick={() => {
                p.onAction('reset_memory');
                p.onResetMemory();
              }}
            >
              {t('Reset memory')}
            </Button>
          }
        />
      ) : null}
      {access.unbind === 'edit' ? (
        <ProfileRow
          rowId="unbind"
          danger
          label={t('Unbind')}
          tip={unbindTip}
          tipKey="unbind"
          onTipOpen={p.onTipOpen}
          actions={
            <Button
              kind="dangerSoft"
              size="sm"
              onClick={() => {
                p.onAction('unbind');
                p.onUnbind();
              }}
            >
              {t('Unbind')}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}
