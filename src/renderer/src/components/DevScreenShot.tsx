/**
 * DevScreenShot — dev-only screenshot harness (261103, the spacing pass).
 *
 * The real screens in the real shell (MacosWindow + IconRail + <main>) over
 * fixture data, in a plain browser tab with no IPC, so layout and spacing can
 * be reviewed screen by screen. Adapted from the T262 explore's DevFlowShot,
 * without its flow layer.
 *
 *   http://localhost:5173/?dashshot=screen&screen=<screen>[&modal=<modal>]
 *     screen = home | character | chat | call | settings | edit (&section=appearance|voice|persona|games)
 *     modal  = delete | feedback | report | signout | apikey | creationlimit |
 *              topup | factoryreset | deleteaccount | movein   (over the Home screen)
 *     &seilink=on|unsupported       SeiLink availability (261104; no setting since 261105)
 *     movein: &pack=<url of a pack dir> (its thumbnail), &swap=1 (Lyra lives there now)
 *     &theme=light|dark  &lang=zh  &backdrop=1 (call: the character-art view)
 *     &tour=1[&audience=new]  the guide's SeiLink tour, live from its offer on
 *                    Home (261105): the screen follows the tour's navigation,
 *                    and its end opens the move-in sheet (&pack= as movein)
 *
 *     &loginitem=off|on|approval  "Open on login" (261107): Settings >
 *                    Appearance as on a packaged mac/win build; approval =
 *                    macOS waiting for the user in System Settings. Without
 *                    it the row is hidden. (The setup step after the guided
 *                    room setup: ?seilinkflow=1&phase=login, DevFirstRoomFlow.)
 *
 *     &regenhint=1   (character) the one-time "Not happy with the look?" hint
 *                    on the Look tab's card image Regenerate button
 *                    (261107); without it the hint is marked seen so other
 *                    character shots stay as they were.
 *     &tab=look|voice|personality|games|sharing|danger   (character) the
 *                    profile tab to open on (profile v0.7, 261107)
 *     &who=own|builtin|world   (character) Sui as your own companion
 *                    (default), as a built-in, or as another player's World
 *                    companion in your library; &movedin=1 with &seilink=on
 *                    puts her on the desktop (the Idle lines row)
 *     &noskin=1      (character) skin still the creation placeholder, so
 *                    the Look tab shows Add / Generate
 *
 * The World tab and a profile opened from World: ?dashshot=screen&screen=world|worldprofile
 * (DevWorldShot, 261110).
 *
 * Other surfaces already have harnesses: ?dashshot=creditwall&part=modal|credits,
 * ?dashshot=signinmodal, ?dashshot=authchoice, ?dashshot=onboard.
 */
import React from 'react';
import { useDataStore } from '../lib/stores/useDataStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useSeilinkStore } from '../lib/stores/useSeilinkStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { useLangStore } from '../lib/i18n';
import { applyTheme } from '../lib/theme';
import { MacosWindow } from './MacosWindow';
import { IconRail } from './IconRail';
import { EditCharacterModal } from './EditCharacterModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { FeedbackModal } from './FeedbackModal';
import { ReportCompanionModal } from './ReportCompanionModal';
import { SignOutConfirmModal } from './SignOutConfirmModal';
import { ApiKeySetupModal } from './ApiKeySetupModal';
import { CreationLimitModal } from './CreationLimitModal';
import { TopUpModal } from './TopUpModal';
import { FactoryResetConfirmModal } from './FactoryResetConfirmModal';
import { DeleteAccountModal } from './DeleteAccountModal';
import { MoveInSheetView } from './seilink/MoveInSheet';
import { TutorialOverlay } from './tutorial/TutorialOverlay';
import { useTutorialStore } from '../lib/stores/useTutorialStore';
import type { SeilinkAvailability } from '@shared/seilinkHost';
import { CharactersScreen } from '../screens/CharactersScreen';
import { CharacterPage } from '../screens/CharacterPage';
import { ChatScreen } from '../screens/ChatScreen';
import { VoiceCallScreen } from '../screens/VoiceCallScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import suiArt from '../../../../vendor/skin-gen/examples/sui-input.png';
import lyraArt from '../../../../vendor/skin-gen/examples/lyra-input.png';
import { isUiLanguage } from '@shared/uiLanguage';
import { markRegenHintSeen, regenHintKey } from '../lib/regenHintPref';
import { PROFILE_TABS, requestProfileTab, type ProfileTab } from '../lib/profileRows';

const SUI = '3f6c2a1e-9b7d-4c1a-8e2f-5a6b7c8d9e01';
const LYRA = '7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c03';
const MARV = 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e06';
const PEBBLE = '6d0a3f0e-58a4-4d43-9a43-6c1f0d2b7e11';

type Screen = 'home' | 'character' | 'chat' | 'call' | 'settings' | 'edit';

const params = new URLSearchParams(window.location.search);
const screen = (params.get('screen') ?? 'home') as Screen;
const modal = params.get('modal');
const seilinkShot = params.get('seilink');
const tourShot = params.get('tour') === '1';
const seilinkAvailability: SeilinkAvailability | null =
  seilinkShot === 'on'
    ? { supported: true, enabled: true, dev: false }
    : seilinkShot === 'unsupported'
      ? { supported: false, reason: 'platform', enabled: false, dev: false }
      : null;
const loginItemShot = params.get('loginitem');
const loginItemState =
  loginItemShot === 'on' || loginItemShot === 'off' || loginItemShot === 'approval'
    ? { supported: true, enabled: loginItemShot !== 'off', needsApproval: loginItemShot === 'approval', decided: true }
    : null;
const HOUR = 3_600_000;
const now = Date.now();

function character(id: string, name: string, source: string, art: string | null, chattedHoursAgo: number) {
  return {
    id,
    kind: 'custom',
    public_id: null,
    name,
    persona: { source, expanded: '' },
    is_default: false,
    description: source,
    shared: true,
    slug: null,
    metadata: {},
    created: new Date(now - 40 * 24 * HOUR).toISOString(),
    last_launched: new Date(now - (chattedHoursAgo + 2) * HOUR).toISOString(),
    last_chatted: new Date(now - chattedHoursAgo * HOUR).toISOString(),
    playtime_ms: 14 * HOUR,
    ...(art ? { portrait_image: art } : {}),
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
    owner: null,
  };
}

const CHARACTERS = [
  character(
    SUI,
    'Sui',
    'A teasing, sunny gremlin who loves building ridiculous things in Minecraft, roasts you when you die to the same creeper twice, and always remembers what you were worried about last week.',
    suiArt,
    1,
  ),
  character(LYRA, 'Lyra', 'A calm, bookish catgirl who plans every farm three seasons ahead and hums while she fishes.', lyraArt, 26),
  character(MARV, 'Marv', 'A grumpy red lobster with a heart of gold and strong opinions about redstone.', null, 70),
  character(PEBBLE, 'Pebble', 'A tiny stone golem who collects shiny rocks and speaks in short, earnest sentences.', null, 140),
];

// The character screen's companion (261107): whose Sui the profile shows.
const who = screen === 'character' ? (params.get('who') ?? 'own') : 'own';
const OTHER_PLAYER = '2b9e7c11-0d4f-4e8a-9a3b-6f1e2d3c4b5a';
if (screen === 'character') {
  const sui = CHARACTERS[0] as Record<string, unknown>;
  sui.public_id = 'K7Q2';
  sui.metadata = who === 'builtin' ? { voiceId: 'v-lily' } : { voiceId: 'v-sarah', voicePitch: 1.1 };
  if (who === 'builtin') {
    sui.is_default = true;
    sui.shared = false;
  }
  if (who === 'world') sui.owner = OTHER_PLAYER;
  // &noskin=1: still on the free creation placeholder (skin_pending).
  if (params.get('noskin') === '1') sui.metadata = { ...(sui.metadata as object), skin_pending: true };
}

const CHAT = [
  ['user', 'morning! did you end up finishing the lake house roof?', 46],
  ['companion', 'not yet, i ran out of spruce planks halfway across the west side', 45.5],
  ['companion', "the chest by the dock still has like 40 logs though. we could do it tonight if you're on", 45.4],
  ['user', "yeah i'll hop on after dinner. should we do the dock first or the roof?", 44],
  ['companion', 'roof first. last time we left a hole in it a phantom got in and you screamed for a solid minute', 43.6],
  ['user', 'that was ONE time', 43],
  ['companion', 'one time is all it takes. i have it on record', 42.8],
  ['user', 'ok roof first. bring the stairs you crafted', 6],
  ['companion', "already in my bag. 64 spruce stairs and a stack of lanterns for the dock, because i'm thinking ahead for once", 5.8],
] as const;

const VOICES = [
  ['v-sarah', 'Sarah', 'female', 'young', 'bright and playful, American'],
  ['v-lily', 'Lily', 'female', 'adult', 'warm and calm, British'],
  ['v-aria', 'Aria', 'female', 'young', 'soft and dreamy'],
  ['v-roger', 'Roger', 'male', 'adult', 'laid back, casual'],
  ['v-george', 'George', 'male', 'elder', 'deep storyteller, British'],
  ['v-river', 'River', 'neutral', 'adult', 'relaxed and even'],
].map(([id, label, gender, age, vibe]) => ({ id, label, gender, age, tags: [], vibe }));

function seed(): void {
  const shotLang = params.get('lang');
  if (isUiLanguage(shotLang)) useLangStore.getState().setLang(shotLang);
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') applyTheme(theme === 'light' ? 'ice' : 'midnight');
  const sei = window.sei as unknown as Record<string, unknown>;
  // The stub Proxy forwards writes to its target, so these replace answers.
  Object.assign(sei, {
    chatHistory: async () =>
      CHAT.map(([role, text, hoursAgo], i) => ({ id: `shot-${i}`, role, text, ts: now - hoursAgo * HOUR })),
    chatPreviews: async () => ({
      [SUI]: { role: 'companion', text: CHAT[CHAT.length - 1][1], ts: now - 5.8 * HOUR },
      [LYRA]: { role: 'companion', text: 'the cauliflower is ready, come look', ts: now - 26 * HOUR },
      [MARV]: { role: 'system', text: 'You and Marv played chess for 12 minutes.', ts: now - 70 * HOUR },
    }),
    getConfig: async () => ({
      preferred_name: 'Robin',
      ai_backend_kind: 'cloud-proxy',
      ui_language: params.get('lang') ?? 'en',
      added_default_ids: who === 'builtin' ? [SUI] : [],
      added_world_ids: who === 'world' ? [SUI] : [],
    }),
    seilinkAvailability: async () => seilinkAvailability,
    seilinkLoginItemGet: async () => loginItemState ?? { supported: false, enabled: false, needsApproval: false, decided: false },
    seilinkLoginItemSet: async (enabled: boolean) => ({ ...(loginItemState ?? { supported: true, needsApproval: false }), enabled, decided: true }),
    getCharacter: async (id: string) => CHARACTERS.find((c) => c.id === id) ?? null,
    listCharacters: async () => CHARACTERS,
    getSkinServerUrl: async () => ({ baseUrl: 'http://127.0.0.1:1' }),
    voiceListVoices: async () => VOICES,
    voiceListOwnVoices: async () => ({ status: 'unavailable', voices: [] }),
    charsPortraitVersions: async (id: string) => ({
      versions: [
        { file: `${id}.png`, source: 'original' },
        { file: `${id}.v1.png`, source: 'regenerated' },
      ],
      active: `${id}.png`,
      regenCount: 1,
      regenLimit: 3,
    }),
    knowledgeList: async () => [
      { id: 'k1', title: 'Base coordinates', bytes: 420, added: new Date(now - 9 * 24 * HOUR).toISOString(), source: 'text' },
      { id: 'k2', title: 'Farm plan.md', bytes: 3100, added: new Date(now - 3 * 24 * HOUR).toISOString(), source: 'upload' },
    ],
    seilinkRoomGet: async () => ({ saved: true, state: { preset: 'cozy' } }),
  });
  useDataStore.setState({
    characters: CHARACTERS as unknown as ReturnType<typeof useDataStore.getState>['characters'],
    summons: {},
  });
  if (screen === 'call') {
    useUiStore.getState().setCallBackdropFor(SUI, params.get('backdrop') === '1');
    useVoiceStore.setState({ participants: [SUI], status: 'live', liveAt: now - 3 * 60_000 - 12_000 });
  }
  // A signed-in cloud account: the common case.
  useAuthStore.setState({
    state: {
      kind: 'signed_in',
      user: { id: '8c41e2d7-5b9a-4f3e-a1c6-2d7e9f0b4a18', email: 'robin@example.com', emailVerified: true, createdAt: '2026-09-20T10:00:00Z' },
    },
  } as never);
  useCreditsStore.setState({ ai_backend_kind: 'cloud-proxy' } as never);
  // 261107: the one-time regenerate hint shows only with &regenhint=1.
  try {
    if (params.get('regenhint') === '1') localStorage.removeItem(regenHintKey());
    else markRegenHintSeen();
  } catch {
    /* no storage: the hint may show */
  }
  if (seilinkAvailability) useSeilinkStore.setState({ availability: seilinkAvailability });
  if (seilinkAvailability && params.get('movedin') === '1') {
    useSeilinkStore.setState({
      status: { state: 'running', characterId: SUI, covered: false, paused: false, fps: 30 },
    });
  }
  useLibraryStateStore.setState({
    addedDefaultIds: new Set(who === 'builtin' ? [SUI] : []),
    addedWorldIds: new Set(who === 'world' ? [SUI] : []),
  });
  // The profile tab to open on (261107).
  const shotTab = params.get('tab');
  if (PROFILE_TABS.includes(shotTab as ProfileTab)) requestProfileTab(shotTab as ProfileTab);
  const nav = useUiStore.getState().navigate;
  if (screen === 'home') nav({ kind: 'home' });
  if (screen === 'character' || screen === 'edit') nav({ kind: 'character', id: SUI });
  if (screen === 'chat') nav({ kind: 'chat', characterId: SUI });
  if (screen === 'call') nav({ kind: 'voice-call', characterId: SUI });
  if (screen === 'settings') nav({ kind: 'settings' });
  if (tourShot) {
    nav({ kind: 'home' });
    useTutorialStore.getState().startSeilink(SUI, params.get('audience') === 'new' ? 'new' : 'existing', 1);
  }
}

seed();

const noop = (): void => undefined;

/** The move-in sheet (261106: a first room starts blank; &saved=1 = she has a room already). */
function MoveInShot(): React.ReactElement {
  return (
    <MoveInSheetView
      name="Sui"
      otherName={params.get('swap') === '1' ? 'Lyra' : null}
      firstRoom={params.get('saved') !== '1'}
      busy={false}
      error={null}
      onCancel={noop}
      onConfirm={noop}
    />
  );
}

function Modal(): React.ReactElement | null {
  switch (modal) {
    case 'delete':
      return <DeleteConfirmModal characterName="Sui" onCancel={noop} onConfirm={noop} />;
    case 'feedback':
      return <FeedbackModal onClose={noop} />;
    case 'report':
      return <ReportCompanionModal characterName="Sui" onClose={noop} />;
    case 'signout':
      return <SignOutConfirmModal botRunning={false} onCancel={noop} onConfirm={async () => undefined} />;
    case 'apikey':
      return <ApiKeySetupModal onCancel={noop} onComplete={noop} />;
    case 'creationlimit':
      return <CreationLimitModal resetsAt={new Date(now + 3 * 24 * HOUR).toISOString()} onClose={noop} />;
    case 'topup':
      return <TopUpModal onClose={noop} />;
    case 'factoryreset':
      return <FactoryResetConfirmModal onCancel={noop} />;
    case 'deleteaccount':
      return <DeleteAccountModal accountEmail="robin@example.com" onCancel={noop} onConfirmed={noop} />;
    case 'movein':
      return <MoveInShot />;
    default:
      return null;
  }
}

export function DevScreenShot(): React.ReactElement {
  const view = useUiStore((s) => s.view);
  const flow = useSeilinkStore((s) => s.flow);
  const shown: Screen = tourShot ? (view.kind === 'chat' ? 'chat' : 'home') : screen;
  const body = (() => {
    switch (shown) {
      case 'character':
      case 'edit':
        return <CharacterPage id={SUI} />;
      case 'chat':
        return <ChatScreen characterId={SUI} />;
      case 'call':
        return <VoiceCallScreen characterId={SUI} />;
      case 'settings':
        return <SettingsScreen />;
      default:
        return <CharactersScreen />;
    }
  })();
  const sui = CHARACTERS[0] as unknown as Parameters<typeof EditCharacterModal>[0]['character'];
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <MacosWindow railHidden={false}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <IconRail />
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, background: 'var(--elbow)' }}>
              <main
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  overflow: 'auto',
                  background: 'var(--window)',
                  borderTopLeftRadius: 'var(--radius)',
                  borderTop: '1px solid var(--border)',
                  borderLeft: '1px solid var(--border)',
                }}
              >
                {body}
              </main>
            </div>
          </div>
        </div>
      </MacosWindow>
      {screen === 'edit' ? <EditCharacterModal character={sui} onClose={noop} initialSection={(['appearance', 'voice', 'persona', 'games'] as const).find((x) => x === params.get('section')) ?? 'basic'} /> : null}
      <Modal />
      {tourShot && flow?.kind === 'sheet' ? <MoveInShot /> : null}
      {tourShot ? <TutorialOverlay /> : null}
    </div>
  );
}
