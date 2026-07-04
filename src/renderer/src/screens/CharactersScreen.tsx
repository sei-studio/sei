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
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useBrowseStore } from '../lib/stores/useBrowseStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { lastInteractionAt } from '../lib/lastInteraction';
import { CharacterCard } from '../components/CharacterCard';
import { AddCard } from '../components/AddCard';
import { CreationLimitModal } from '../components/CreationLimitModal';
import { AddCompanionChooserModal } from '../components/AddCompanionChooserModal';
import { SignInModal } from '../components/SignInModal';
import { BrowseCard } from '../components/BrowseCard';
import type { Character } from '@shared/characterSchema';
import { MAX_COMPANION_SLOTS } from '@shared/characterSchema';
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
    kind: 'custom',
    public_id: null,
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
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const setHomeTab = useUiStore((s) => s.setHomeTab);
  const greetingDismissed = useUiStore((s) => s.homeGreetingDismissed);
  const authState = useAuthStore((s) => s.state);
  const authKind = authState.kind;
  const setUpgradeFraming = useAuthStore((s) => s.setUpgradeFraming);
  const upgradeFraming = useAuthStore((s) => s.upgradeFraming);
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  const [cloudOnly, setCloudOnly] = useState<Array<{ id: string; name: string }>>([]);
  const [openPrepareError, setOpenPrepareError] = useState<string | null>(null);
  const [preferredName, setPreferredName] = useState<string>('');
  const [isFirstLogin, setIsFirstLogin] = useState<boolean>(false);
  // Daily character-creation cap (persona_daily). Pre-flight gate before the
  // new-character flow so a maxed-out user gets a "come back tomorrow" modal
  // instead of failing mid-expansion. null = hidden.
  const [createLimit, setCreateLimit] = useState<{ resetsAt: string | null } | null>(null);
  // 260703 procgen — the add-companion chooser (opened from an empty slot) and
  // the sign-in prompt shown when a signed-out / local-mode user picks the
  // flagship "unique companion" path.
  const [chooserOpen, setChooserOpen] = useState<boolean>(false);
  const [showSignIn, setShowSignIn] = useState<boolean>(false);

  // Gate the custom-creation entry point on the daily quota. checkCreateQuota
  // fails open (blocked:false) for BYOK users and on any error, so this never
  // wrongly blocks creation.
  const handleAddClick = async (): Promise<void> => {
    const quota = await sei.checkCreateQuota();
    if (quota.blocked) {
      setCreateLimit({ resetsAt: quota.resetsAt });
      return;
    }
    navigate({ kind: 'add-character' });
  };

  // Chooser → "Create from scratch": the existing custom wizard (quota-gated).
  const handlePickCustom = (): void => {
    setChooserOpen(false);
    void handleAddClick();
  };

  // Chooser → "Invite an existing companion": switch the Home view to World.
  const handlePickWorld = (): void => {
    setChooserOpen(false);
    setHomeTab('world');
  };

  // Chooser → flagship "Meet your unique companion". Cloud + signed-in only:
  // a signed-out user OR a local-mode (BYOK) user is routed to the sign-in
  // modal (framed for this action), same pattern as the cloud-AI upsell. When
  // eligible, run the first-sign-in questionnaire gate if it hasn't been
  // answered yet, then land on the per-slot gender question.
  const handlePickUnique = async (): Promise<void> => {
    if (authKind !== 'signed_in') {
      setChooserOpen(false);
      setUpgradeFraming('meet your unique companion');
      setShowSignIn(true);
      return;
    }
    let backendLocal = false;
    try {
      const cfg = await sei.getConfig();
      backendLocal = (cfg.ai_backend_kind ?? 'local') !== 'cloud-proxy';
    } catch {
      // Fail OPEN — let the generation pipeline surface any real backend issue
      // rather than blocking an eligible user on a transient config read.
      backendLocal = false;
    }
    if (backendLocal) {
      setChooserOpen(false);
      setUpgradeFraming('meet your unique companion');
      setShowSignIn(true);
      return;
    }
    setChooserOpen(false);
    try {
      const prefs = await sei.prefsGet();
      if (prefs.needed) {
        navigate({ kind: 'profile-questions', next: 'unique-gender' });
        return;
      }
    } catch {
      // Fail open — proceed to the gender step; the pipeline can still run.
    }
    navigate({ kind: 'unique-gender' });
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await sei.getConfig();
        if (cancelled) return;
        setPreferredName(cfg.preferred_name ?? '');
        // "Welcome to Sei" shows ONLY on the user's very first login; every
        // later app open shows "Welcome back". has_been_welcomed is the
        // persisted one-shot marker — flip it true the first time we render
        // the first-login greeting so subsequent opens read false→back.
        const firstLogin = cfg.has_been_welcomed !== true;
        setIsFirstLogin(firstLogin);
        if (firstLogin) {
          try {
            await sei.saveConfig({ ...cfg, has_been_welcomed: true });
          } catch {
            /* non-fatal: worst case the next open repeats "Welcome to Sei" */
          }
        }
      } catch {
        /* fall through: empty name, treat as returning user */
      }
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

  const handleSummon = (id: string): void => {
    // The card's "Play" CTA opens the game picker; each tile launches through
    // the shared summonFlow (skin-setup nudge → LAN gate). Mirrors CharacterPage.
    openModal({ kind: 'games-picker', characterId: id });
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
      // Non-fatal — ChatScreen / CharacterPage refetch via their own effects.
    }
    // Phase 18/19: a Home card click now opens the in-app chat (the new primary
    // surface); CharacterPage stays reachable via the chat header's Profile button.
    navigate({ kind: 'chat', characterId: id });
  };

  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const addedDefaultIds = useLibraryStateStore((s) => s.addedDefaultIds);

  /**
   * Home filter (260703 procgen — the fixed-slot model):
   *   - bundled defaults → now live on the World tab; hidden from Home UNLESS
   *     the user has explicitly invited them into a slot
   *     (UserConfig.added_default_ids). The old removed_default_ids logic no
   *     longer drives Home.
   *   - foreign chars (owner stamped, doesn't match current user) → hidden
   *     UNLESS the id is in UserConfig.added_world_ids (invited from World).
   *   - legacy null-owner chars (created before owner-stamping landed) → shown
   *     for everyone; they're treated as the current session's local library.
   *   - own chars (owner === currentUserId) → shown.
   *   - signed out + owner-stamped chars → hidden (those belong to a cloud
   *     account; don't surface them in the offline / local-mode view).
   */
  const homeCharacters = characters.filter((c) => {
    if (c.is_default === true) {
      return addedDefaultIds.has(c.id);
    }
    if (currentUserId) {
      if (c.owner != null && c.owner !== currentUserId) {
        return addedWorldIds.has(c.id);
      }
      return true;
    }
    return c.owner == null;
  });

  // #7 — order the grid by last interaction (summon OR chat), matching the
  // IconRail: most-recently-active first, then created desc. A failed summon
  // never stamps last_launched (backstopped in botSupervisor) and a chat only
  // stamps last_chatted on a successful reply, so failures don't reorder cards.
  const orderedCharacters = homeCharacters.slice().sort((a, b) => {
    const aLast = lastInteractionAt(a) ?? '';
    const bLast = lastInteractionAt(b) ?? '';
    if (aLast !== bLast) {
      if (!aLast) return 1;
      if (!bLast) return -1;
      return bLast.localeCompare(aLast);
    }
    return (b.created ?? '').localeCompare(a.created ?? '');
  });

  const displayName = preferredName.trim() || 'friend';
  const greetingLead = isFirstLogin ? 'Welcome to Sei, ' : 'Welcome back, ';

  // 260703 procgen — the Home page is a fixed row of exactly
  // MAX_COMPANION_SLOTS (4) slots. Fill order: library characters ordered by
  // last interaction, then cloud-only placeholder rows (which count toward the
  // 4), capped at 4. Any remaining slots render an empty "summon a companion"
  // add tile that opens the three-way chooser.
  const cloudPlaceholders = cloudOnly
    .filter((co) => !characters.some((c) => c.id === co.id))
    .filter((co) => !recentlyDeletedIds.has(co.id))
    .map((co) => makeCloudPlaceholder(co.id, co.name));
  const slotCharacters = [...orderedCharacters, ...cloudPlaceholders].slice(
    0,
    MAX_COMPANION_SLOTS,
  );
  const emptyCount = Math.max(0, MAX_COMPANION_SLOTS - slotCharacters.length);

  return (
    <div className={homeStyles.root}>
      <header className={homeStyles.header}>
        <h2 className={homeStyles.greeting}>
          {greetingDismissed ? (
            'Companions'
          ) : (
            <>
              {greetingLead}
              <span className={homeStyles.greetingName}>{displayName}</span>!
            </>
          )}
        </h2>
      </header>
      <section className={homeStyles.slotGrid}>
        {slotCharacters.map((c) => (
          <div key={c.id} className={homeStyles.slot}>
            <CharacterCard
              character={c}
              theme={theme}
              variant="slot"
              onOpen={() => {
                void handleOpen(c.id);
              }}
              onSummon={() => handleSummon(c.id)}
              onUnsummon={() => void sei.stop(c.id)}
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
        {Array.from({ length: emptyCount }).map((_, i) => (
          <div key={`empty-slot-${i}`} className={homeStyles.slot}>
            <AddCard
              variant="slot"
              label="Summon a companion"
              onClick={() => setChooserOpen(true)}
            />
          </div>
        ))}
      </section>
      {chooserOpen ? (
        <AddCompanionChooserModal
          onPickUnique={() => void handlePickUnique()}
          onPickCustom={handlePickCustom}
          onPickWorld={handlePickWorld}
          onClose={() => setChooserOpen(false)}
        />
      ) : null}
      {showSignIn ? (
        <SignInModal
          framingLabel={upgradeFraming}
          onClose={() => setShowSignIn(false)}
        />
      ) : null}
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

  // #6 — World sort. Alphabetical by default; "Newest" sorts by updatedAt desc.
  // Client-side over the currently-loaded pages (infinite scroll appends more).
  const [worldSort, setWorldSort] = useState<'alpha' | 'recent'>('alpha');

  const localCharacters = useDataStore((s) => s.characters);
  const addedDefaultIds = useLibraryStateStore((s) => s.addedDefaultIds);
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
      // 260703 procgen: defaults are opt-in on Home — "in library" means the
      // user invited this default (matches the HomeGrid/IconRail filter).
      inMyLibrary: addedDefaultIds.has(c.id),
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

  // Merge defaults + cloud rows into one list, then sort per the dropdown.
  const worldEntries = [
    ...defaultEntries,
    ...entries.filter((e) => !defaultEntries.some((d) => d.id === e.id)),
  ].sort((a, b) =>
    worldSort === 'alpha' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt),
  );

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
              Browse companions made by other players.
            </span>
          </span>
        </div>
        <div className={styles.browseControls}>
          <input
            className={styles.searchField}
            type="search"
            placeholder="Search companions..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search world companions"
          />
          <select
            className={styles.sortSelect}
            value={worldSort}
            onChange={(e) => setWorldSort(e.target.value as 'alpha' | 'recent')}
            aria-label="Sort companions"
          >
            <option value="alpha">A–Z</option>
            <option value="recent">Newest</option>
          </select>
        </div>
      </header>
      <div className={styles.scroll}>
      {error ? (
        <div className={styles.error} role="alert">
          Couldn&apos;t load World. {error}
        </div>
      ) : null}
      {entries.length === 0 && defaultEntries.length === 0 && !loading && !error ? (
        <div className={styles.empty}>
          No public companions yet. Be the first to share one.
        </div>
      ) : null}
      <div className={styles.grid}>
        {worldEntries.map((entry) => (
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
    </div>
  );
}
