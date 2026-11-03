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
 *              topup | factoryreset | deleteaccount   (over the Home screen)
 *     &theme=light|dark  &lang=zh  &backdrop=1 (call: the character-art view)
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
import { CharactersScreen } from '../screens/CharactersScreen';
import { CharacterPage } from '../screens/CharacterPage';
import { ChatScreen } from '../screens/ChatScreen';
import { VoiceCallScreen } from '../screens/VoiceCallScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import suiArt from '../../../../vendor/skin-gen/examples/sui-input.png';
import lyraArt from '../../../../vendor/skin-gen/examples/lyra-input.png';
import { isUiLanguage } from '@shared/uiLanguage';

const SUI = '3f6c2a1e-9b7d-4c1a-8e2f-5a6b7c8d9e01';
const LYRA = '7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c03';
const MARV = 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e06';
const PEBBLE = '6d0a3f0e-58a4-4d43-9a43-6c1f0d2b7e11';

type Screen = 'home' | 'character' | 'chat' | 'call' | 'settings' | 'edit';

const params = new URLSearchParams(window.location.search);
const screen = (params.get('screen') ?? 'home') as Screen;
const modal = params.get('modal');
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
    getConfig: async () => ({ preferred_name: 'Robin', ai_backend_kind: 'cloud-proxy', ui_language: params.get('lang') ?? 'en' }),
    getCharacter: async (id: string) => CHARACTERS.find((c) => c.id === id) ?? null,
    listCharacters: async () => CHARACTERS,
    getSkinServerUrl: async () => ({ baseUrl: 'http://127.0.0.1:1' }),
    voiceListVoices: async () => VOICES,
    voiceListOwnVoices: async () => ({ status: 'unavailable', voices: [] }),
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
  const nav = useUiStore.getState().navigate;
  if (screen === 'home') nav({ kind: 'home' });
  if (screen === 'character' || screen === 'edit') nav({ kind: 'character', id: SUI });
  if (screen === 'chat') nav({ kind: 'chat', characterId: SUI });
  if (screen === 'call') nav({ kind: 'voice-call', characterId: SUI });
  if (screen === 'settings') nav({ kind: 'settings' });
}

seed();

const noop = (): void => undefined;

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
    default:
      return null;
  }
}

export function DevScreenShot(): React.ReactElement {
  const body = (() => {
    switch (screen) {
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
    </div>
  );
}
