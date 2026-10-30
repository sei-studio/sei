/**
 * DevArtShot — dev-only screenshot harness for text drawn over character art
 * (261023), NOT part of the app UI. Mounted by DevDashShot for
 * `?dashshot=art`, with:
 *
 *     &part=browse|page|call   a World grid row, the character page, or a
 *                              live call in backdrop mode (the Home wall is
 *                              `?dashshot=home&art=...`)
 *     &art=<url>[,<url>...]    the portrait(s); a dev-server path works, e.g.
 *                              /@fs/<repo>/demo/fixtures/portraits/sui.png
 *     &name=<name>[,<name>...] the matching names (default Sui, Marv, Lyra)
 *     &backdrop=0              (part=call) the avatar tiles, not the backdrop
 *
 * Used to measure name legibility on light and dark portraits in both
 * schemes. window.sei is the generic Proxy stub from devHarnessStubs.ts.
 * Deliberately no real IPC.
 */
import React from 'react';
import type { Character } from '@shared/characterSchema';
import type { BrowseEntry } from '@shared/ipc';
import { useDataStore } from '../lib/stores/useDataStore';
import { useUiStore } from '../lib/stores/useUiStore';
import { useVoiceStore } from '../lib/stores/useVoiceStore';
import { resolvedScheme } from '../lib/theme';
import { BrowseCard } from './BrowseCard';
import { CharacterPage } from '../screens/CharacterPage';
import { VoiceCallScreen } from '../screens/VoiceCallScreen';

const params = new URLSearchParams(window.location.search);

/** The art list and names shared with the `?dashshot=home` seed. */
export function devArtList(): Array<{ name: string; art: string | null }> {
  const arts = (params.get('art') ?? '').split(',').filter(Boolean);
  const names = (params.get('name') ?? '').split(',').filter(Boolean);
  const fallback = ['Sui', 'Marv', 'Lyra'];
  const n = Math.max(arts.length, names.length, 3);
  return Array.from({ length: n }, (_, i) => ({
    name: names[i] ?? fallback[i] ?? `Companion ${i + 1}`,
    art: arts[i] ?? null,
  }));
}

const ART_IDS = devArtList().map((a, i) => `dashshot-art-${i}-${a.name.toLowerCase()}`);

function seed(): void {
  const list = devArtList();
  useDataStore.setState({
    summons: {},
    characters: list.map((a, i) => ({
      id: ART_IDS[i],
      name: a.name,
      description: `${a.name} is a companion who likes long walks, building things and talking about the day.`,
      persona: { source: `${a.name} is curious and warm.` },
      ...(a.art ? { portrait_image: a.art } : {}),
      last_chatted: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
    })) as unknown as Character[],
  });
  // The character page refreshes its character over IPC and drops it on a
  // miss, so the stub answers from the seeded list.
  (window as unknown as { sei: Record<string, unknown> }).sei.getCharacter = async (id: string) =>
    useDataStore.getState().characters.find((c) => c.id === id) ?? null;
  if (params.get('part') === 'call') {
    // &backdrop=0 opens the avatar-tiles view instead of the backdrop.
    useUiStore.setState({
      callBackdropByCharacter: { [ART_IDS[0]]: params.get('backdrop') !== '0' },
    });
    // Live this instant, so the chrome bar shows its first-seconds reveal.
    useVoiceStore.setState({ participants: [ART_IDS[0]], status: 'live', liveAt: Date.now() });
  }
}

// DevDashShot imports every harness eagerly: seed only for our own mode.
if (params.get('dashshot') === 'art') seed();

export function DevArtShot(): React.ReactElement {
  const part = params.get('part') ?? 'browse';
  if (part === 'page') {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'var(--window)' }}>
        <CharacterPage id={ART_IDS[0]} />
      </div>
    );
  }
  if (part === 'call') {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--window)' }}>
        <VoiceCallScreen characterId={ART_IDS[0]} />
      </div>
    );
  }
  const entries: BrowseEntry[] = devArtList().map((a, i) => ({
    id: ART_IDS[i],
    name: a.name,
    personaSnippet: '',
    creatorLabel: 'by anonymous',
    publicId: 'K7QX',
    portraitUrl: a.art,
    skinUrl: null,
    updatedAt: new Date().toISOString(),
    inMyLibrary: false,
  }));
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--window)', padding: 24 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 0 }}>
        {entries.map((e) => (
          <BrowseCard key={e.id} entry={e} theme={resolvedScheme()} onOpen={() => undefined} ready />
        ))}
      </div>
    </div>
  );
}
