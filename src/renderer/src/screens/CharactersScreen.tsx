/**
 * CharactersScreen — Home / World tabbed view (B4 refactor).
 *
 * Renders two co-located tab bodies:
 *
 *   - <HomeGrid />   : the user's local + cloud library. Filters down to
 *                      characters that are either (a) bundled defaults,
 *                      (b) owned by the current user, or (c) legacy local-only
 *                      (no owner). Public-but-not-mine cloud characters that
 *                      somehow ended up in the local store are excluded here —
 *                      they live on the World tab instead.
 *
 *   - <WorldGrid />  : public character listing (previously called Browse).
 *                      Mounts a search field + grid + IntersectionObserver
 *                      sentinel for infinite scroll, backed by useBrowseStore.
 *
 * B4 changes vs. the prior version:
 *   1. Capability gate removed — the tab bar is always rendered. The default
 *      tab is driven by useUiStore.homeTab (set by IconRail's compass icon
 *      in B3). Tab labels are "Home" and "World".
 *   2. CharacterCard chip text now reads 'MINE' for user-owned characters
 *      and 'WORLD' for foreign-owned characters that landed in the local
 *      store via the Add-to-Mine flow.
 *   3. Home grid filtering hides foreign-owned chars (they're WORLD content).
 *   4. WorldGrid drops the H1 heading (the tab bar labels it) and BrowseCard
 *      renders without a chip (all world cards are implicitly world).
 *
 * Lifecycle pitfalls (unchanged):
 *   - HomeGrid's useEffect that fires sei.charsListMerged() stays INSIDE
 *     HomeGrid so it doesn't re-fire on tab switch.
 *   - useBrowseStore.refresh() is called ONCE in WorldGrid's useEffect.
 *   - LAN pill belongs ONLY in HomeGrid.
 */

import React, { useEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { attemptSummon } from '../lib/summonFlow';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useBrowseStore } from '../lib/stores/useBrowseStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { Button } from '../components/Button';
import { PlusIcon } from '../components/icons';
import { CharacterCard } from '../components/CharacterCard';
import { AddCard } from '../components/AddCard';
import { CreationLimitModal } from '../components/CreationLimitModal';
import { BrowseCard } from '../components/BrowseCard';
import type { Character } from '@shared/characterSchema';
import type { BrowseEntry } from '@shared/ipc';
import homeStyles from './HomeScreen.module.css';
import styles from './CharactersScreen.module.css';

type Tab = 'home' | 'world';

/**
 * Phase 11 plan 19 (D-19, LIB-04) — cloud-only entry shape.
 *
 * The merged listing from chars:list-merged may contain rows that exist in
 * cloud but NOT yet on local disk. Carried over verbatim from HomeScreen.tsx.
 */
function makeCloudPlaceholder(id: string, name: string): Character {
  return {
    id,
    name,
    slug: null,
    persona: { source: '', expanded: '' },
    is_default: false,
    shared: true,
    created: new Date().toISOString(),
    last_launched: null,
    playtime_ms: 0,
    portrait_image: null,
    skin: { source: 'none', mojang_username: null, png_sha256: null, applied_at: null },
    username: null,
    metadata: {},
    description: null,
  };
}

function lanLabel(kind: 'connected' | 'not_connected' | 'unavailable'): string {
  if (kind === 'connected') return 'CONNECTED';
  if (kind === 'not_connected') return 'NOT CONNECTED';
  return 'UNAVAILABLE';
}

export function CharactersScreen(): React.ReactElement {
  // The IconRail Home pill writes homeTab='home'; the compass writes
  // homeTab='world'. Subscribe live so a click on either rail button swaps
  // the body without a remount.
  const tab = useUiStore((s) => s.homeTab) as Tab;

  return (
    <div className={styles.screen}>
      {tab === 'home' ? <HomeGrid /> : <WorldGrid />}
    </div>
  );
}

/**
 * HomeGrid — the user's library tab.
 *
 * B4 filtering rule: only show characters where
 *   (a) is_default === true, OR
 *   (b) character.owner === currentUserId, OR
 *   (c) character.owner == null (legacy local).
 * Public-but-not-mine cloud characters that somehow ended up in the local
 * store but aren't owned by the user are excluded here — they belong on the
 * World tab.
 */
function HomeGrid(): React.ReactElement {
  const characters = useDataStore((s) => s.characters);
  const recentlyDeletedIds = useDataStore((s) => s.recentlyDeletedIds);
  const lan = useDataStore((s) => s.lan);
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const authState = useAuthStore((s) => s.state);
  const authKind = authState.kind;
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  const [cloudOnly, setCloudOnly] = useState<Array<{ id: string; name: string }>>([]);
  const [openPrepareError, setOpenPrepareError] = useState<string | null>(null);
  const [preferredName, setPreferredName] = useState<string>('');
  const [isFirstVisit, setIsFirstVisit] = useState<boolean>(true);
  // Daily character-creation cap (persona_daily). Pre-flight gate before the
  // new-character flow so a maxed-out user gets a "come back tomorrow" modal
  // instead of failing mid-expansion. null = hidden.
  const [createLimit, setCreateLimit] = useState<{ resetsAt: string | null } | null>(null);

  // Gate both creation entry points (header "New" + AddCard tile) on the daily
  // quota. checkCreateQuota fails open (blocked:false) for BYOK users and on
  // any error, so this never wrongly blocks creation.
  const handleAddClick = async (): Promise<void> => {
    const quota = await sei.checkCreateQuota();
    if (quota.blocked) {
      setCreateLimit({ resetsAt: quota.resetsAt });
      return;
    }
    navigate({ kind: 'add-character' });
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await sei.getConfig();
        if (cancelled) return;
        setPreferredName(cfg.preferred_name ?? '');
      } catch {
        /* fall through with empty name */
      }
      // "First visit" = no character ever launched. First visit shows the
      // "Welcome to Sei, <name>!" greeting; any prior launch flips it to the
      // plain "Summons" header. Cheap heuristic, no separate persisted flag.
      const everLaunched = useDataStore.getState().characters.some(
        (c) => c.last_launched != null,
      );
      if (!cancelled) setIsFirstVisit(!everLaunched);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authKind !== 'signed_in') {
      setCloudOnly([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { characters: merged } = await sei.charsListMerged();
        if (cancelled) return;
        const onlyCloud = merged
          .filter((m) => m.source === 'cloud')
          .map((m) => ({ id: m.id, name: m.name }));
        setCloudOnly(onlyCloud);
      } catch {
        if (!cancelled) setCloudOnly([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authKind, characters]);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  const lanDotColor =
    lan.kind === 'connected'
      ? 'var(--green)'
      : lan.kind === 'not_connected'
        ? 'var(--red)'
        : 'var(--muted)';
  const lanTitle =
    lan.kind === 'unavailable' ? 'LAN auto-detect unavailable on this network.' : undefined;

  const handleSummon = (id: string): void => {
    // Shared flow (lib/summonFlow.ts): one-time skin-setup nudge → LAN gate →
    // summon. Keeps this card in lockstep with CharacterPage's deploy bar.
    void attemptSummon(id);
  };

  const handleOpen = async (id: string): Promise<void> => {
    setOpenPrepareError(null);
    try {
      await sei.charsOpenPrepare(id);
    } catch (err) {
      console.warn(`[sei] open prepare failed for ${id}: ${(err as Error).message}`);
      setOpenPrepareError(id);
      return;
    }
    try {
      await useDataStore.getState().refreshCharacter(id);
    } catch {
      // Non-fatal — CharacterPage will refetch via its own mount-time effect.
    }
    navigate({ kind: 'character', id });
  };

  const removedDefaultIds = useLibraryStateStore((s) => s.removedDefaultIds);
  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);

  /**
   * Home filter (mirrored in IconRail so the rail and the grid never diverge):
   *   - bundled defaults → shown unless the user has "removed" them from the
   *     library via the gear menu (tracked by UserConfig.removed_default_ids).
   *   - foreign chars (owner stamped, doesn't match current user) → hidden
   *     UNLESS the id is in UserConfig.added_world_ids (the user clicked
   *     "+ Add to Mine" on it in the World tab).
   *   - legacy null-owner chars (created before owner-stamping landed) → shown
   *     for everyone; they're treated as the current session's local library.
   *   - own chars (owner === currentUserId) → shown.
   *   - signed out + owner-stamped chars → hidden (those belong to a cloud
   *     account; don't surface them in the offline / local-mode view).
   */
  const homeCharacters = characters.filter((c) => {
    if (c.is_default === true) {
      return !removedDefaultIds.has(c.id);
    }
    if (currentUserId) {
      if (c.owner != null && c.owner !== currentUserId) {
        return addedWorldIds.has(c.id);
      }
      return true;
    }
    return c.owner == null;
  });

  const displayName = preferredName.trim() || 'friend';
  const greeting = isFirstVisit ? `Welcome to Sei, ${displayName}!` : 'Summons';

  return (
    <div className={homeStyles.root}>
      <header className={homeStyles.header}>
        <h2 className={homeStyles.greeting}>{greeting}</h2>
        <div className={homeStyles.actions}>
          <button
            type="button"
            className={homeStyles.lanPill}
            onClick={() => openModal({ kind: 'lan', mode: 'info' })}
            title={lanTitle}
            aria-label={`LAN: ${lanLabel(lan.kind).toLowerCase()}`}
          >
            <span
              className={homeStyles.lanDot}
              style={{ background: lanDotColor, color: lanDotColor }}
            />
            {lanLabel(lan.kind)}
          </button>
          <Button
            kind="accent"
            size="md"
            icon={<PlusIcon size={14} />}
            onClick={() => void handleAddClick()}
          >
            New
          </Button>
        </div>
      </header>
      <section className={homeStyles.grid}>
        {homeCharacters.map((c) => (
          <div key={c.id} style={{ position: 'relative' }}>
            <CharacterCard
              character={c}
              theme={theme}
              onOpen={() => {
                void handleOpen(c.id);
              }}
              onSummon={() => handleSummon(c.id)}
            />
            {openPrepareError === c.id ? (
              <div
                style={{
                  position: 'absolute',
                  left: 12,
                  bottom: 60,
                  padding: '4px 8px',
                  background: 'var(--red)',
                  color: 'white',
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  borderRadius: 2,
                  pointerEvents: 'none',
                }}
                role="alert"
              >
                COULDN&apos;T OPEN: OFFLINE?
              </div>
            ) : null}
          </div>
        ))}
        {cloudOnly
          .filter((co) => !characters.some((c) => c.id === co.id))
          .filter((co) => !recentlyDeletedIds.has(co.id))
          .map((co) => (
            <div key={co.id} style={{ position: 'relative' }}>
              <CharacterCard
                character={makeCloudPlaceholder(co.id, co.name)}
                theme={theme}
                onOpen={() => {
                  void handleOpen(co.id);
                }}
                onSummon={() => handleSummon(co.id)}
              />
              {openPrepareError === co.id ? (
                <div
                  style={{
                    position: 'absolute',
                    left: 12,
                    bottom: 60,
                    padding: '4px 8px',
                    background: 'var(--red)',
                    color: 'white',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                    borderRadius: 2,
                    pointerEvents: 'none',
                  }}
                  role="alert"
                >
                  DOWNLOAD FAILED
                </div>
              ) : null}
            </div>
          ))}
        <AddCard onClick={() => void handleAddClick()} />
      </section>
      {createLimit ? (
        <CreationLimitModal
          resetsAt={createLimit.resetsAt}
          onClose={() => setCreateLimit(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * WorldGrid — public character listing backed by useBrowseStore.
 *
 * B4 changes vs. the prior BrowseGrid:
 *   - Drops the H1 heading (the tab bar labels it).
 *   - All cards are implicitly world; BrowseCard renders without a chip.
 *   - Renamed for clarity.
 */
function WorldGrid(): React.ReactElement {
  const entries = useBrowseStore((s) => s.entries);
  const query = useBrowseStore((s) => s.query);
  const loading = useBrowseStore((s) => s.loading);
  const exhausted = useBrowseStore((s) => s.exhausted);
  const error = useBrowseStore((s) => s.error);
  const setQuery = useBrowseStore((s) => s.setQuery);
  const loadMore = useBrowseStore((s) => s.loadMore);
  const prefetch = useBrowseStore((s) => s.prefetch);

  const localCharacters = useDataStore((s) => s.characters);
  const removedDefaultIds = useLibraryStateStore((s) => s.removedDefaultIds);
  // Bundled defaults (sui/lyra/clawd) are surfaced as system-authored World
  // entries so the user can find them next to other public characters even
  // though they live in the local store and don't have a cloud row (D-22).
  // `inMyLibrary` flips false when the user removed the default from their
  // library (config-tracked) so BrowseCard renders "+ Add to Mine".
  const defaultEntries: BrowseEntry[] = localCharacters
    .filter((c) => c.is_default === true)
    .filter((c) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        (c.persona.source ?? '').toLowerCase().includes(q)
      );
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      personaSnippet:
        (c.persona.source ?? '').length > 120
          ? (c.persona.source ?? '').slice(0, 120).trimEnd() + '…'
          : (c.persona.source ?? ''),
      creatorLabel: 'by Sei',
      portraitUrl: c.portrait_image,
      skinUrl: null,
      updatedAt: c.created,
      inMyLibrary: !removedDefaultIds.has(c.id),
    }));

  const navigate = useUiStore((s) => s.navigate);

  const sentinelRef = useRef<HTMLDivElement>(null);

  const theme: 'light' | 'dark' =
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light';

  useEffect(() => {
    // Warm-if-cold rather than an unconditional refresh: when the user hovered
    // the World rail icon first, the grid is already populated and we must NOT
    // wipe + refetch it (that's the pop-in we're eliminating). A cold open
    // still fetches page 0 here.
    void prefetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: '200px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, exhausted]);

  // Prefetch dedup — one warm-up per id per mount. main's in-flight guard +
  // existsSync already make repeats cheap, but this avoids redundant IPC churn
  // when the pointer re-enters the same card.
  const prefetchedRef = useRef<Set<string>>(new Set());
  const handlePrefetch = (entry: BrowseEntry): void => {
    // Already-in-library entries are cached locally; nothing to warm.
    if (entry.inMyLibrary) return;
    if (prefetchedRef.current.has(entry.id)) return;
    prefetchedRef.current.add(entry.id);
    // Fire-and-forget: warm the cache-on-demand path. Errors are non-fatal —
    // handleOpen re-runs the same call and surfaces any real failure there.
    void sei.charsOpenPrepare(entry.id).catch(() => {
      // Allow a later retry on the actual open.
      prefetchedRef.current.delete(entry.id);
    });
  };

  const handleOpen = async (entry: BrowseEntry): Promise<void> => {
    try {
      await sei.charsOpenPrepare(entry.id);
    } catch (err) {
      console.warn(`[sei] browse open prepare failed for ${entry.id}: ${(err as Error).message}`);
    }
    try {
      await useDataStore.getState().refreshCharacter(entry.id);
    } catch {
      // Non-fatal.
    }
    navigate({ kind: 'character', id: entry.id });
  };

  return (
    <div className={styles.browse}>
      <header className={styles.browseHeader}>
        <div className={styles.worldTitleRow}>
          <h1 className={styles.browseTitle}>World</h1>
          <span
            className={styles.worldHelp}
            tabIndex={0}
            role="img"
            aria-label="What is World?"
          >
            ?
            <span className={styles.worldHelpTip} role="tooltip">
              Browse and summon characters made by other players.
            </span>
          </span>
        </div>
        <input
          className={styles.searchField}
          type="search"
          placeholder="Search characters..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search world characters"
        />
      </header>
      {error ? (
        <div className={styles.error} role="alert">
          Couldn&apos;t load World. {error}
        </div>
      ) : null}
      {entries.length === 0 && defaultEntries.length === 0 && !loading && !error ? (
        <div className={styles.empty}>
          No public characters yet. Be the first to share one.
        </div>
      ) : null}
      <div className={styles.grid}>
        {defaultEntries.map((entry) => (
          <div key={entry.id} style={{ position: 'relative' }}>
            <BrowseCard
              entry={entry}
              theme={theme}
              onOpen={() => {
                void handleOpen(entry);
              }}
              onPrefetch={() => handlePrefetch(entry)}
            />
          </div>
        ))}
        {entries
          // Don't double-render a default if a cloud row with the same id ever
          // surfaces (defaults aren't uploaded per D-22, but belt-and-suspenders).
          .filter((e) => !defaultEntries.some((d) => d.id === e.id))
          .map((entry) => (
          <div key={entry.id} style={{ position: 'relative' }}>
            <BrowseCard
              entry={entry}
              theme={theme}
              onOpen={() => {
                void handleOpen(entry);
              }}
              onPrefetch={() => handlePrefetch(entry)}
            />
          </div>
        ))}
      </div>
      {!exhausted ? <div ref={sentinelRef} className={styles.sentinel} aria-hidden /> : null}
      {loading ? <div className={styles.loading}>Loading…</div> : null}
    </div>
  );
}
