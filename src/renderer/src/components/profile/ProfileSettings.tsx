/**
 * ProfileSettings: a companion's settings rows.
 *
 *  - Your own companion (access.view 'owner'): ONE scrolling page with
 *    section headings (Look, Voice, Personality, Games, Sharing, WorldLink,
 *    Danger zone), in the order people reach for them (product call 261110;
 *    261107 split the same rows over six tabs and hid too much).
 *  - Someone else's companion in your library ('foreign'): the short "Your
 *    settings" list (avatar pick, floating avatar, Knowledge, the DST
 *    survivor, WorldLink, Reset memory, Unbind). Its look, voice and
 *    personality are on the Overview (ProfileOverview), not here.
 *
 * Every row is label + value + action(s). The actions open the existing
 * editors (the page owns those popups and passes openers in); which rows
 * show, and whether they are live or locked, comes from lib/profileRows.ts.
 * Each row is its own component, so its read (voices, knowledge, the avatar
 * library, the room) runs only when the row is shown.
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
import {
  foreignSettingsRows,
  lockTipKey,
  ownerSections,
  sectionOf,
  type ProfileAccess,
  type ProfileAction,
  type ProfileSection,
  type RowKey,
} from '../../lib/profileRows';
import type { Character, CardImageOrigin } from '@shared/characterSchema';
import { cardImageOrigin, effectiveMcUsername, portraitVersionIndex } from '@shared/characterSchema';
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
import { VoiceSampleButton, type SampleResult } from './VoiceSample';
import styles from './Profile.module.css';

export interface ProfileSettingsProps {
  character: Character;
  access: ProfileAccess;
  /** A row's button was used (analytics; the page maps the row to its section or tab). */
  onAction: (action: ProfileAction, row: RowKey) => void;
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
  /** Bumped when a popup that changes a row's value closes (re-read it). */
  refreshKey: number;
  /** The one-time regenerate hint, drawn on the card image's Regenerate button. */
  regenHint?: React.ReactNode;
  /** The pool voice the Voice row's sample plays (CharacterOverviewInfo); undefined while unknown. */
  sampleVoiceId?: string | null;
  /** The Voice row's sample button played (or failed). */
  onSample?: (r: SampleResult) => void;
}

/** Section headings, in English (the i18n key). */
export const SECTION_LABEL: Record<ProfileSection, string> = {
  look: 'Look',
  voice: 'Voice',
  personality: 'Personality',
  games: 'Games',
  sharing: 'Sharing',
  worldlink: 'WorldLink',
  danger: 'Danger zone',
};

export function ProfileSettings(props: ProfileSettingsProps): React.ReactElement {
  return props.access.view === 'owner' ? <OwnerSettings {...props} /> : <ForeignSettings {...props} />;
}

function OwnerSettings(p: ProfileSettingsProps): React.ReactElement {
  const t = useT();
  return (
    <div className={styles.sections}>
      {ownerSections(p.access).map(({ section, rows }) => (
        <section
          key={section}
          className={styles.section}
          data-section={section}
          id={`profile-section-${section}`}
          aria-labelledby={`profile-section-${section}-h`}
        >
          <h2
            id={`profile-section-${section}-h`}
            className={`${styles.sectionHead} ${section === 'danger' ? styles.sectionHeadDanger : ''}`}
          >
            {t(SECTION_LABEL[section])}
          </h2>
          <div className={styles.rows}>
            {rows.map((row) => (
              <Row key={row} row={row} {...p} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** A foreign companion's settings: plain rows, then WorldLink and the Danger zone under headings. */
function ForeignSettings(p: ProfileSettingsProps): React.ReactElement {
  const t = useT();
  const rows = foreignSettingsRows(p.access);
  const groups: { head: ProfileSection | null; rows: RowKey[] }[] = [
    { head: null, rows: rows.filter((r) => !['worldlink', 'danger'].includes(sectionOf(r))) },
    { head: 'worldlink', rows: rows.filter((r) => sectionOf(r) === 'worldlink') },
    { head: 'danger', rows: rows.filter((r) => sectionOf(r) === 'danger') },
  ];
  return (
    <div className={styles.sections}>
      {groups
        .filter((g) => g.rows.length > 0)
        .map((g) => (
          <section key={g.head ?? 'yours'} className={styles.section} data-section={g.head ?? 'yours'}>
            {g.head ? (
              <h2 className={`${styles.sectionHead} ${g.head === 'danger' ? styles.sectionHeadDanger : ''}`}>
                {t(SECTION_LABEL[g.head])}
              </h2>
            ) : null}
            <div className={styles.rows}>
              {g.rows.map((row) => (
                <Row key={row} row={row} {...p} />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

type RowProps = ProfileSettingsProps & { row: RowKey };

function Row(p: RowProps): React.ReactElement | null {
  switch (p.row) {
    case 'cardImage':
      return <CardImageRow {...p} />;
    case 'skin':
      return <SkinRow {...p} />;
    case 'avatar':
      return <AvatarRow {...p} />;
    case 'floatingAvatar':
      return <FloatingAvatarRow {...p} />;
    case 'voice':
      return <VoiceRow {...p} />;
    case 'pitch':
      return <PitchRow character={p.character} onAction={(a) => p.onAction(a, 'pitch')} />;
    case 'about':
      return <AboutRow {...p} />;
    case 'persona':
      return <PersonaRow {...p} />;
    case 'knowledge':
      return <KnowledgeRow {...p} />;
    case 'chess':
      return <ChessRow {...p} />;
    case 'dst':
      return <DstRow {...p} />;
    case 'publicToggle':
      return <PublicRow {...p} />;
    case 'othersHear':
      return <OthersHearRow {...p} />;
    case 'desktopRoom':
      return <DesktopRoomRow {...p} />;
    case 'room':
      return <RoomRow {...p} />;
    case 'idleLines':
      return <IdleLinesRow {...p} />;
    case 'intro':
      return <IntroRow {...p} />;
    case 'resetMemory':
      return <ResetMemoryRow {...p} />;
    case 'unbind':
      return <UnbindRow {...p} />;
  }
}

/** The Locked marker's tooltip for this companion. */
function useLockTip(p: ProfileSettingsProps): string {
  const t = useT();
  return t(lockTipKey(p.access.kind), { name: p.character.name });
}

/** A small secondary button that reports its action, then runs `run`. */
function RowButton({
  p,
  action,
  run,
  children,
  kind = 'secondary',
  disabled,
  icon,
  ariaLabel,
}: {
  p: RowProps;
  action: ProfileAction;
  run: () => void;
  children: React.ReactNode;
  kind?: 'secondary' | 'soft' | 'dangerSoft';
  disabled?: boolean;
  icon?: React.ReactNode;
  ariaLabel?: string;
}): React.ReactElement {
  return (
    <Button
      kind={kind}
      size="sm"
      icon={icon}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={() => {
        p.onAction(action, p.row);
        run();
      }}
    >
      {children}
    </Button>
  );
}

// ── Look ──────────────────────────────────────────────────────────────────

interface CardVersions {
  id: string;
  left: number;
  label: string | null;
  origin: CardImageOrigin;
}

function CardImageRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const hasPortrait = !!portraitSrc(character.portrait_image);

  // Card image versions, regenerations left, and where the active image came from.
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
          label,
          origin: cardImageOrigin(character, st),
        });
      })
      .catch(() => {
        /* unknown: no count chip, origin from the character */
      });
    return () => {
      live = false;
    };
    // t only formats the label; a language switch re-renders anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access.cardImage, character.id, character.portrait_image, p.refreshKey]);
  const cv = versions && versions.id === character.id ? versions : null;
  // Product call 261110: a card image the player uploaded is theirs as made,
  // so it gets no Regenerate (and no "{n} left" chip).
  const origin = cv ? cv.origin : cardImageOrigin(character);
  const canRegenerate = hasPortrait && origin !== 'uploaded';

  const thumb = hasPortrait ? (
    <img className={styles.thumb} src={portraitSrc(character.portrait_image) ?? undefined} alt="" draggable={false} />
  ) : null;
  const cardText = !hasPortrait
    ? t('No card image')
    : access.cardImage !== 'edit'
      ? t('Original art')
      : origin === 'uploaded'
        ? t('Custom image')
        : cv && cv.label
          ? cv.label
          : t('Card image');

  return (
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
          <RowButton p={p} action="card_versions" run={() => p.openCardImage(false)}>
            {access.cardUpload ? t('Change') : t('Versions')}
          </RowButton>
          {canRegenerate ? (
            <span className={styles.anchor}>
              <RowButton
                p={p}
                action="regenerate_card"
                kind="soft"
                icon={<SparkleIcon size={13} />}
                disabled={cv !== null && cv.left === 0}
                run={() => p.openCardImage(true)}
              >
                <span>{t('Regenerate')}</span>
                {cv ? <ActionChip>{t('{n} left', { n: cv.left })}</ActionChip> : null}
              </RowButton>
              {p.regenHint}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** The Minecraft skin, with the in-game username folded in (it lives in the same popup). */
function SkinRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const refreshCharacter = useDataStore((s) => s.refreshCharacter);
  const skinGen = useSkinGenerate(character, () => void refreshCharacter(character.id));
  const showSkinGen = access.skinGenerate && skinGen.visible;
  return (
    <ProfileRow
      rowId="skin"
      label={t('Minecraft skin')}
      tip={t('How {name} looks in Minecraft, and the name they use in your worlds.', { name: character.name })}
      tipKey="skin"
      onTipOpen={p.onTipOpen}
      value={
        skinGen.line ? (
          <span className={skinGen.ok ? styles.resultOk : styles.resultErr} role="status">
            {skinGen.line}
          </span>
        ) : (
          <span className={styles.val}>
            <SkinHead character={character} />
            <span className={styles.stack}>
              <span className={styles.valText}>{skinText(character, t)}</span>
              <span className={styles.subMono}>{effectiveMcUsername(character)}</span>
            </span>
          </span>
        )
      }
      lockedTip={access.skin === 'locked' ? lockTip : null}
      actions={
        <>
          {access.skinEdit ? (
            <RowButton p={p} action="edit_skin" run={p.openSkinEdit}>
              {skinGen.firstSkin ? t('Add') : t('Edit')}
            </RowButton>
          ) : null}
          {showSkinGen ? (
            <RowButton
              p={p}
              action="regenerate_skin"
              icon={<SparkleIcon size={13} />}
              disabled={skinGen.running || skinGen.botOnline}
              run={() => void skinGen.run()}
            >
              <span>{skinGen.running ? t('Making skin...') : skinGen.firstSkin ? t('Generate') : t('Regenerate')}</span>
            </RowButton>
          ) : null}
        </>
      }
    />
  );
}

function AvatarRow(p: RowProps): React.ReactElement | null {
  const t = useT();
  const { character, access } = p;
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
  const manage = access.avatarMode === 'manage' || list?.is_owner === true;
  const canPick = !!list && !list.is_owner && list.avatars.length >= 2;
  // Someone else's companion with one look: nothing to choose, so no row.
  if (access.view === 'foreign' && !canPick) return null;
  return (
    <ProfileRow
      rowId="avatar"
      label={t('Avatar')}
      tip={t('The picture used for WorldLink and calls.')}
      tipKey="avatar"
      onTipOpen={p.onTipOpen}
      value={<RowValue text={avatarText} />}
      actions={
        manage ? (
          <RowButton p={p} action="manage_avatars" run={() => p.openAvatars(true)}>
            {t('Manage')}
          </RowButton>
        ) : canPick ? (
          <RowButton p={p} action="change_avatar" run={() => p.openAvatars(false)}>
            {t('Change')}
          </RowButton>
        ) : null
      }
    />
  );
}

function FloatingAvatarRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  const prefs = useUiStore((s) => s.avatarPrefsByCharacter[character.id]);
  const floatingText =
    prefs?.tab === 'live2d'
      ? 'Live2D'
      : (prefs?.frame ?? 'circle') === 'square'
        ? t('Static, square frame')
        : t('Static, circle frame');
  return (
    <ProfileRow
      rowId="floating-avatar"
      label={t('Floating avatar')}
      tip={t('How {name} looks on the floating avatar. Turn the avatar on in Settings.', { name: character.name })}
      tipKey="floating_avatar"
      onTipOpen={p.onTipOpen}
      value={<RowValue text={floatingText} />}
      actions={
        <RowButton p={p} action="floating_avatar" run={p.openFloating}>
          {t('Change')}
        </RowButton>
      }
    />
  );
}

type T = (key: string, vars?: Record<string, string | number>) => string;

function skinText(c: Character, t: T): string {
  // A pending skin is the free painted placeholder until Minecraft (or the
  // Generate button) makes the real one; to the player that is no skin yet.
  if ((c.metadata as Record<string, unknown> | undefined)?.skin_pending === true) return t('No skin yet');
  switch (c.skin.source) {
    case 'none':
      return t('No skin yet');
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

/**
 * The voice's name as the player should read it. For someone else's own
 * ElevenLabs voice (`othersHear`), the Sei voice it is played with instead.
 */
export function useVoiceLabel(character: Character, opts: { borrowed?: boolean } = {}): string {
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
  const lookup = (vid: string | null): string => {
    const v = vid ? pool?.find((x) => x.id === vid) : undefined;
    return v ? (v.vibe ? t('{name}, {vibe}', { name: v.label, vibe: v.vibe }) : v.label) : t('A Sei voice');
  };
  if (own && opts.borrowed) return lookup(sharedVoiceIdOf(character.metadata));
  if (!id) return t('Auto');
  if (own) return own.name;
  return lookup(id);
}

function VoiceRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const label = useVoiceLabel(character);
  const rate = Math.round(voicePitchRate(character) * 100) / 100;
  const locked = access.voice === 'locked';
  const voiceText = locked && rate !== 1 ? t('{voice}, pitch {pitch}', { voice: label, pitch: rate.toFixed(2) }) : label;
  const silent = character.metadata?.voiceId === NO_VOICE_ID;
  return (
    <ProfileRow
      rowId="voice"
      label={t('Voice')}
      value={
        <RowValue
          lead={
            silent ? null : (
              <VoiceSampleButton
                character={character}
                sampleVoiceId={p.sampleVoiceId}
                compact
                onResult={(r) => p.onSample?.(r)}
              />
            )
          }
          text={voiceText}
        />
      }
      lockedTip={locked ? lockTip : null}
      actions={
        <RowButton p={p} action="edit_voice" run={() => p.openEdit('voice')}>
          {t('Change')}
        </RowButton>
      }
    />
  );
}

/**
 * Pitch, inline. Saves when the slider is let go (or on a key change), with
 * the same neutral-value rule as the voice editor: a companion with a baked
 * non-neutral default (Sui) stores 1 explicitly, everyone else drops the key.
 */
function PitchRow({
  character,
  onAction,
}: {
  character: Character;
  onAction: (a: ProfileAction) => void;
}): React.ReactElement {
  const t = useT();
  const rate = Math.round(voicePitchRate(character) * 100) / 100;
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

/** Name and description: one row, one editor (they were two rows into the same popup). */
function AboutRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const description = character.description?.trim() || '';
  return (
    <ProfileRow
      rowId="about"
      label={t('Name and description')}
      tall
      value={
        <span className={styles.about}>
          <span className={styles.aboutName}>{character.name}</span>
          <span className={styles.clamp} title={description || undefined}>
            {description || t('No description yet.')}
          </span>
        </span>
      }
      lockedTip={access.about === 'locked' ? lockTip : null}
      actions={
        <RowButton p={p} action="edit_about" run={() => p.openEdit('basic')}>
          {t('Edit')}
        </RowButton>
      }
    />
  );
}

function PersonaRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
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
    <ProfileRow
      rowId="persona"
      label={t('Persona')}
      tip={t('The prompt that shapes how {name} talks and acts.', { name: character.name })}
      tipKey="persona"
      onTipOpen={p.onTipOpen}
      value={<RowValue text={personaText} />}
      lockedTip={access.persona === 'locked' ? lockTip : null}
      actions={
        <RowButton p={p} action="edit_persona" run={() => p.openEdit('persona')}>
          {t('Edit')}
        </RowButton>
      }
    />
  );
}

function KnowledgeRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  const [knowledge, setKnowledge] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
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
  }, [character.id, p.refreshKey]);
  const kn = knowledge && knowledge.id === character.id ? knowledge.n : null;
  return (
    <ProfileRow
      rowId="knowledge"
      label={t('Knowledge')}
      tip={t('Files and notes {name} can read when you talk.', { name: character.name })}
      tipKey="knowledge"
      onTipOpen={p.onTipOpen}
      value={
        <RowValue
          text={
            kn === null ? '' : kn === 0 ? t('None yet') : t('{n, plural, one {# entry} other {# entries}}', { n: kn })
          }
        />
      }
      actions={
        <RowButton p={p} action="knowledge" run={p.openKnowledge}>
          {t('Manage')}
        </RowButton>
      }
    />
  );
}

// ── Games ─────────────────────────────────────────────────────────────────

const DST_NAME = "Don't Starve Together";

function ChessRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const chess = (character.metadata?.chess ?? null) as { elo?: number } | null;
  const chessText = chess && typeof chess.elo === 'number' ? t('Custom, Elo {elo}', { elo: chess.elo }) : t('Auto');
  return (
    <ProfileRow
      rowId="chess"
      label={t('Chess')}
      tip={t('How {name} plays chess. On Auto, strength and style come from the persona.', { name: character.name })}
      tipKey="chess"
      onTipOpen={p.onTipOpen}
      value={<RowValue text={chessText} />}
      lockedTip={access.chess === 'locked' ? lockTip : null}
      actions={
        <RowButton p={p} action="edit_chess" run={() => p.openEdit('games')}>
          {t('Change')}
        </RowButton>
      }
    />
  );
}

function DstRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  const [survivor, setSurvivor] = useState<{ id: string; prefab: string | null } | null>(null);
  useEffect(() => {
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
  }, [character.id]);
  const prefab = survivor && survivor.id === character.id ? survivor.prefab : undefined;
  return (
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
        <RowButton
          p={p}
          action="dst_survivor"
          run={() =>
            requestGameLaunch(character.id, { id: 'dontstarve', name: DST_NAME }, () =>
              openGame(character.id, 'dontstarve'),
            )
          }
        >
          {t('Change')}
        </RowButton>
      }
    />
  );
}

// ── Sharing ───────────────────────────────────────────────────────────────

function PublicRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  return (
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
            p.onAction('toggle_public', p.row);
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
  );
}

function OthersHearRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character, access } = p;
  const lockTip = useLockTip(p);
  const { pool, defaultId } = useSharedVoiceInfo(character.id, undefined);
  const othersLabel = useMemo(
    () => poolVoiceLabel(effectiveSharedVoice(sharedVoiceIdOf(character.metadata), defaultId, pool), pool),
    [character.metadata, defaultId, pool],
  );
  return (
    <ProfileRow
      rowId="others-hear"
      label={t('Others will hear')}
      tip={t('Your own ElevenLabs voice only plays for you. Other players hear this Sei voice.')}
      tipKey="others_hear"
      onTipOpen={p.onTipOpen}
      value={<RowValue text={othersLabel ?? t('A Sei voice')} />}
      lockedTip={access.othersHear === 'locked' ? lockTip : null}
      actions={
        <RowButton p={p} action="others_hear" run={() => p.openEdit('voice')}>
          {t('Change')}
        </RowButton>
      }
    />
  );
}

// ── WorldLink ─────────────────────────────────────────────────────────────
// 'gear' is the profile's settings entry for seilink_entry (it was the gear
// menu until 261107); kept so the series stays whole.

function DesktopRoomRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  const livingId = useSeilinkStore((s) => movedInId(s.status));
  const failedHere = useSeilinkStore((s) => s.status.state === 'failed' && s.status.characterId === character.id);
  const moveBusy = useSeilinkStore((s) => s.moveBusy);
  const livesHere = livingId === character.id;
  return (
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
        <RowButton
          p={p}
          action={livesHere ? 'move_off_desktop' : 'move_onto_desktop'}
          disabled={moveBusy}
          run={() => void moveInOrOut(character.id, 'gear')}
        >
          {livesHere ? t('Move off desktop') : t('Move onto desktop')}
        </RowButton>
      }
    />
  );
}

function RoomRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  const [room, setRoom] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
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
  }, [character.id, p.refreshKey]);
  return (
    <ProfileRow
      rowId="room"
      label={t('Room')}
      value={<RowValue text={room && room.id === character.id ? room.text : ''} />}
      actions={
        <RowButton p={p} action="edit_room" run={() => openRoomEditor(character.id, 'gear')}>
          {t('Edit room')}
        </RowButton>
      }
    />
  );
}

function IdleLinesRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { character } = p;
  // The global seilink_deafened flag, inverted.
  const [idleOn, setIdleOn] = useState<boolean | null>(null);
  useEffect(() => {
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
  }, []);
  return (
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
            p.onAction(next ? 'idle_lines_on' : 'idle_lines_off', p.row);
            setIdleOn(next);
            void sei.seilinkSetIdleLines?.(next).then(setIdleOn, () => setIdleOn(!next));
          }}
        />
      }
    />
  );
}

function IntroRow(p: RowProps): React.ReactElement {
  const t = useT();
  return (
    <ProfileRow
      rowId="intro"
      label={t('WorldLink intro')}
      actions={
        <RowButton p={p} action="replay_intro" run={() => replayIntro(p.character.id, 'gear')}>
          {t('Replay')}
        </RowButton>
      }
    />
  );
}

// ── Danger zone ───────────────────────────────────────────────────────────

function ResetMemoryRow(p: RowProps): React.ReactElement {
  const t = useT();
  return (
    <ProfileRow
      rowId="reset-memory"
      danger
      label={t('Reset memory')}
      tip={t('Wipes chats and memories of you. Game inventory stays.')}
      tipKey="reset_memory"
      onTipOpen={p.onTipOpen}
      actions={
        <RowButton p={p} action="reset_memory" kind="dangerSoft" run={p.onResetMemory}>
          {t('Reset memory')}
        </RowButton>
      }
    />
  );
}

function UnbindRow(p: RowProps): React.ReactElement {
  const t = useT();
  const { access } = p;
  const name = p.character.name;
  const unbindTip =
    access.kind === 'world'
      ? t('Removes {name} from your library. You can invite them again from World.', { name })
      : access.kind === 'builtin'
        ? t('Removes {name} from your library. You can add them back from World.', { name })
        : t('Removes {name} for good. This cannot be undone.', { name });
  return (
    <ProfileRow
      rowId="unbind"
      danger
      label={t('Unbind')}
      tip={unbindTip}
      tipKey="unbind"
      onTipOpen={p.onTipOpen}
      actions={
        <RowButton p={p} action="unbind" kind="dangerSoft" run={p.onUnbind}>
          {t('Unbind')}
        </RowButton>
      }
    />
  );
}
