/**
 * DevWorldShot — dev-only screenshot harness for the World tab (261110).
 *
 * The real CharactersScreen (World tab) or a CharacterPage opened from World,
 * in the real shell (MacosWindow + IconRail), over a fixture World listing
 * with varied library add counts, in a plain browser tab with no IPC.
 *
 *   http://localhost:5173/?dashshot=screen&screen=world[&sort=popular|recent|alpha]
 *   http://localhost:5173/?dashshot=screen&screen=worldprofile[&who=<name>]
 *     &fallback=1   the server has no sorted/counts RPC yet (old database):
 *                   newest-first pages, `sorted: false`, no counts
 *     &delay=<ms>   per-page latency (default 300), to watch the auto-load
 *     &theme=light|dark  &lang=zh|ja|ru|pt-BR|es
 *
 * The fixture pager answers like main's browse:list: PAGE_SIZE rows per call
 * in the requested order, `hasMore` when a full page came back.
 */
import React from 'react';
import { useDataStore } from '../lib/stores/useDataStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useCreditsStore } from '../lib/stores/useCreditsStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { useBrowseStore } from '../lib/stores/useBrowseStore';
import { useLangStore } from '../lib/i18n';
import { applyTheme } from '../lib/theme';
import { isUiLanguage } from '@shared/uiLanguage';
import { MacosWindow } from './MacosWindow';
import { IconRail } from './IconRail';
import { CharactersScreen } from '../screens/CharactersScreen';
import { CharacterPage } from '../screens/CharacterPage';
import suiArt from '../../../../vendor/skin-gen/examples/sui-input.png';
import lyraArt from '../../../../vendor/skin-gen/examples/lyra-input.png';
import marvArt from '../../../../vendor/skin-gen/examples/clawd-input.png';
import animeF from '../assets/art-styles/anime-female.jpg';
import animeM from '../assets/art-styles/anime-male.jpg';
import cartoonF from '../assets/art-styles/cartoon-female.jpg';
import cartoonM from '../assets/art-styles/cartoon-male.jpg';
import celF from '../assets/art-styles/celshaded-female.jpg';
import celM from '../assets/art-styles/celshaded-male.jpg';
import chibiF from '../assets/art-styles/chibi-female.jpg';
import chibiM from '../assets/art-styles/chibi-male.jpg';
import threeF from '../assets/art-styles/3d-female.jpg';
import threeM from '../assets/art-styles/3d-male.jpg';

const params = new URLSearchParams(window.location.search);
const view = params.get('screen') === 'worldprofile' ? 'profile' : 'grid';
const fallback = params.get('fallback') === '1';
const delayMs = Number(params.get('delay') ?? 300) || 0;
const DAY = 86_400_000;
const now = Date.now();
const ME = '8c41e2d7-5b9a-4f3e-a1c6-2d7e9f0b4a18';
const SEI_OWNER = '571634bd-0f6d-4835-bef2-06fd7f449a3d';

interface Fixture {
  id: string;
  name: string;
  persona: string;
  art: string | null;
  adds: number;
  daysAgo: number;
  author: string;
  code: string;
  isDefault?: boolean;
}

const uid = (n: number): string => `5e1d0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Defaults first (the harness's own Sui/Lyra/Marv), then user-shared rows.
const FIXTURES: Fixture[] = [
  { id: uid(1), name: 'Sui', persona: 'A teasing, sunny gremlin who loves building ridiculous things and always remembers what you were worried about last week.', art: suiArt, adds: 2400, daysAgo: 120, author: 'Sei', code: '0001', isDefault: true },
  { id: uid(2), name: 'Marv', persona: 'A grumpy red lobster with a heart of gold and strong opinions about redstone.', art: marvArt, adds: 19, daysAgo: 118, author: 'Sei', code: '0002', isDefault: true },
  { id: uid(3), name: 'Lyra', persona: 'A calm, bookish catgirl who plans every farm three seasons ahead and hums while she fishes.', art: lyraArt, adds: 58, daysAgo: 119, author: 'Sei', code: '0003', isDefault: true },
  { id: uid(10), name: 'Aria', persona: 'A cheerful bard who narrates your mining trips like an epic and keeps a tally of every diamond you drop in lava.', art: animeF, adds: 72, daysAgo: 21, author: 'kitsune', code: 'M5IR' },
  { id: uid(11), name: 'Mina', persona: 'Soft-spoken healer who carries too many golden carrots and worries out loud when you go below y=0.', art: celF, adds: 41, daysAgo: 30, author: 'mochi', code: 'XJSL' },
  { id: uid(12), name: 'Kaito', persona: 'A competitive speedrunner who times everything, including how long you take to pick a door.', art: animeM, adds: 36, daysAgo: 12, author: 'zeph', code: '1PDO' },
  { id: uid(13), name: 'Eris', persona: 'Hot-headed swordswoman, bad at waiting, great at clearing a mob farm in thirty seconds flat.', art: threeF, adds: 28, daysAgo: 40, author: 'rudeus', code: 'SWU8' },
  { id: uid(14), name: 'Emilia', persona: 'Gentle half-elf who names every animal she tames and insists on a proper house for each one.', art: cartoonF, adds: 22, daysAgo: 9, author: 'puck', code: 'WKA4' },
  { id: uid(15), name: 'Chen Wei', persona: 'Retired architect who critiques your builds with kindness and a little too much detail.', art: celM, adds: 15, daysAgo: 55, author: 'linli', code: 'OYTL' },
  { id: uid(16), name: 'Ultron', persona: 'A dramatic robot overlord who is secretly very good at organizing chests.', art: threeM, adds: 12, daysAgo: 33, author: 'stark', code: 'YD50' },
  { id: uid(17), name: 'Marta Novak', persona: 'Field botanist who catalogues every flower biome and gets distracted by bees.', art: cartoonM, adds: 9, daysAgo: 4, author: 'fern', code: 'I5UT' },
  { id: uid(18), name: 'Natsuki', persona: 'Prickly baker who pretends not to care but always has bread for you after a long night.', art: chibiF, adds: 8, daysAgo: 16, author: 'yuri', code: 'E2LS' },
  { id: uid(19), name: 'Solphivia', persona: 'A sun priestess who refuses to go into caves without at least four stacks of torches.', art: null, adds: 8, daysAgo: 2, author: 'helio', code: 'TQ1T' },
  { id: uid(20), name: 'Red', persona: 'Quiet trainer of wolves, speaks in short sentences, never leaves a wolf behind.', art: chibiM, adds: 7, daysAgo: 27, author: 'oak', code: '771Q' },
  { id: uid(21), name: 'Roger', persona: 'A laid-back fisherman with a story for every fish, most of them invented.', art: null, adds: 5, daysAgo: 8, author: 'wave', code: 'RRKY' },
  { id: uid(22), name: 'Luki', persona: 'Tiny trickster fox who hides your tools and leaves riddles where they were.', art: null, adds: 5, daysAgo: 6, author: 'mint', code: 'N7JI' },
  { id: uid(23), name: 'Pingota', persona: 'Penguin explorer obsessed with ice biomes and sliding down every slope.', art: null, adds: 5, daysAgo: 13, author: 'frost', code: 'HWOL' },
  { id: uid(24), name: 'Morgan', persona: 'A dry-humored witch who brews potions badly on purpose to see what happens.', art: null, adds: 5, daysAgo: 19, author: 'hex', code: '5807' },
  { id: uid(25), name: 'Zhu Yuan', persona: 'Calm captain who plans raids with diagrams and always brings spare shields.', art: null, adds: 5, daysAgo: 24, author: 'jade', code: 'URNH' },
  { id: uid(26), name: 'Raven', persona: 'Night owl scout who maps everything and leaves little signs at every crossroads.', art: null, adds: 4, daysAgo: 31, author: 'crow', code: '8RT1' },
  { id: uid(27), name: 'Katya', persona: 'Blunt engineer who builds iron farms and judges your hopper placement.', art: null, adds: 4, daysAgo: 37, author: 'volt', code: '21J6' },
  { id: uid(28), name: 'Maximilius', persona: 'A pompous knight who narrates his own victories in the third person.', art: null, adds: 3, daysAgo: 44, author: 'lance', code: 'C8HY' },
  { id: uid(29), name: 'Laila', persona: 'Desert nomad who trades stories for sand and always knows where the temples are.', art: null, adds: 2, daysAgo: 48, author: 'dune', code: '0J9M' },
  { id: uid(30), name: 'Matías', persona: 'Sleepy farmer who only wakes up for harvest day and pumpkin pie.', art: null, adds: 1, daysAgo: 52, author: 'sol', code: 'SCZC' },
  { id: uid(31), name: 'Haruhi', persona: 'Club president with grand plans for a secret base and no patience for boredom.', art: null, adds: 1, daysAgo: 58, author: 'sos', code: '0OQC' },
  { id: uid(32), name: 'Rocky', persona: 'An alien engineer who speaks in musical chords and fixes everything with xenonite.', art: null, adds: 1, daysAgo: 61, author: 'grace', code: 'N4GW' },
  { id: uid(33), name: 'Pebble', persona: 'A tiny stone golem who collects shiny rocks and speaks in short, earnest sentences.', art: null, adds: 0, daysAgo: 1, author: 'quartz', code: 'PBBL' },
  { id: uid(34), name: 'Juniper', persona: 'A shy forest spirit who plants a sapling wherever you cut a tree down.', art: null, adds: 0, daysAgo: 3, author: 'moss', code: 'JNPR' },
];

const ownerOf = (f: Fixture): string => (f.isDefault ? SEI_OWNER : `a0a0a0a0-0000-4000-8000-${f.code.padStart(12, '0')}`);

function toEntry(f: Fixture) {
  return {
    id: f.id,
    name: f.name,
    personaSnippet: f.persona.length > 120 ? f.persona.slice(0, 120).trimEnd() + '…' : f.persona,
    creatorLabel: `by ${f.author}`,
    publicId: f.code,
    portraitUrl: f.art,
    skinUrl: null,
    updatedAt: new Date(now - f.daysAgo * DAY).toISOString(),
    inMyLibrary: false,
    addCount: fallback ? null : f.adds,
  };
}

function toCharacter(f: Fixture) {
  return {
    id: f.id,
    kind: 'custom',
    public_id: f.code,
    name: f.name,
    persona: { source: f.persona, expanded: '' },
    is_default: f.isDefault === true,
    description: f.persona,
    shared: true,
    slug: null,
    metadata: {},
    created: new Date(now - f.daysAgo * DAY).toISOString(),
    last_launched: null,
    last_chatted: null,
    playtime_ms: 0,
    ...(f.art ? { portrait_image: f.art } : {}),
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
    owner: ownerOf(f),
  };
}

type Sort = 'popular' | 'recent' | 'alpha';

function ordered(sort: Sort | undefined, query: string): Fixture[] {
  const q = query.toLowerCase();
  const rows = FIXTURES.filter((f) => !q || f.name.toLowerCase().includes(q) || f.persona.toLowerCase().includes(q));
  const newest = (a: Fixture, b: Fixture): number => a.daysAgo - b.daysAgo;
  if (fallback || !sort || sort === 'recent') return rows.sort(newest);
  if (sort === 'alpha') return rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || newest(a, b));
  return rows.sort((a, b) => b.adds - a.adds || newest(a, b));
}

function seed(): void {
  const lang = params.get('lang');
  if (isUiLanguage(lang)) useLangStore.getState().setLang(lang);
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') applyTheme(theme === 'light' ? 'ice' : 'midnight');
  const characters = FIXTURES.filter((f) => f.isDefault).map(toCharacter);
  const profileName = (params.get('who') ?? 'Aria').toLowerCase();
  const profiled = FIXTURES.find((f) => f.name.toLowerCase() === profileName) ?? FIXTURES[3];
  if (view === 'profile' && !profiled.isDefault) characters.push(toCharacter(profiled));
  const sei = window.sei as unknown as Record<string, unknown>;
  Object.assign(sei, {
    browseList: async (args: { query: string; limit: number; offset: number; sort?: Sort }) => {
      await new Promise((r) => setTimeout(r, delayMs));
      const rows = ordered(args.sort, args.query).slice(args.offset, args.offset + args.limit);
      return {
        entries: rows.map(toEntry),
        hasMore: rows.length === args.limit,
        sorted: fallback ? args.sort === 'recent' : true,
      };
    },
    track: () => undefined,
    getConfig: async () => ({ preferred_name: 'Robin', ai_backend_kind: 'cloud-proxy', ui_language: lang ?? 'en' }),
    getCharacter: async (id: string) => useDataStore.getState().characters.find((c) => c.id === id) ?? null,
    listCharacters: async () => useDataStore.getState().characters,
    charsOpenPrepare: async () => ({ ok: true }),
    getSkinServerUrl: async () => ({ baseUrl: 'http://127.0.0.1:1' }),
    charsPortraitVersions: async (id: string) => ({
      versions: [{ file: `${id}.png`, source: 'original' }],
      active: `${id}.png`,
      regenCount: 0,
      regenLimit: 3,
    }),
  });
  useDataStore.setState({
    characters: characters as unknown as ReturnType<typeof useDataStore.getState>['characters'],
    summons: {},
  });
  // Sui and Lyra are in this user's party; Marv is not.
  useLibraryStateStore.setState({ addedDefaultIds: new Set([uid(1), uid(3)]), addedWorldIds: new Set() });
  useAuthStore.setState({
    state: {
      kind: 'signed_in',
      user: { id: ME, email: 'robin@example.com', emailVerified: true, createdAt: '2026-09-20T10:00:00Z' },
    },
  } as never);
  useCreditsStore.setState({ ai_backend_kind: 'cloud-proxy' } as never);
  const ui = useUiStore.getState();
  ui.setHomeTab('world');
  const sort = params.get('sort');
  if (view === 'profile') {
    // As if the World grid had loaded its first page, then the card was clicked.
    useBrowseStore.setState({ entries: ordered('popular', '').slice(0, 24).map(toEntry) as never, exhausted: false });
    ui.navigate({ kind: 'character', id: profiled.id });
  } else {
    ui.navigate({ kind: 'home' });
    if (sort === 'recent' || sort === 'alpha') {
      const store = useBrowseStore.getState() as unknown as { setSort?: (s: Sort) => void };
      store.setSort?.(sort);
    }
  }
}

seed();

export function DevWorldShot(): React.ReactElement {
  const v = useUiStore((s) => s.view);
  const body = v.kind === 'character' ? <CharacterPage id={v.id} /> : <CharactersScreen />;
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
    </div>
  );
}
