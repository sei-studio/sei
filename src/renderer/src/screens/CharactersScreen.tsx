/**
 * CharactersScreen — Home / World tabbed view (Party redesign).
 *
 * Renders two co-located tab bodies:
 *
 *   - <HomeGrid />   : the party wall (§4.2). Full-height flex panels, one per
 *                      companion slot (MAX_COMPANION_SLOTS = 4, always all
 *                      rendered). Filled slots show full-bleed portrait art,
 *                      the presence line, and a hover-revealed lastline +
 *                      [Message][Play] action row. Empty slots are dormant
 *                      panels (gathering pixels + "Awaken") that route to the
 *                      awaken view. Slot fill order: library characters by
 *                      last interaction, then cloud-only placeholder rows.
 *
 *   - <WorldGrid />  : public character listing. Search + sort top bar with a
 *                      right-aligned party-slots indicator, 3:4 "scouting"
 *                      cards (BrowseCard) whose body opens the character
 *                      profile (where "Add to library" lives), paged by
 *                      ROWS_PER_BATCH rows behind an explicit "Load more"
 *                      button (260704: bounds the portrait-download burst that
 *                      tripped the per-IP rate limit on the proxy).
 *
 * Lifecycle pitfalls (unchanged):
 *   - HomeGrid's useEffect that fires sei.charsListMerged() stays INSIDE
 *     HomeGrid so it doesn't re-fire on tab switch.
 *   - useBrowseStore.prefetch() is called ONCE in WorldGrid's useEffect.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sei } from '../lib/ipcClient';
import { useUiStore } from '../lib/stores/useUiStore';
import { useDataStore } from '../lib/stores/useDataStore';
import { useAuthStore } from '../lib/stores/useAuthStore';
import { useBrowseStore } from '../lib/stores/useBrowseStore';
import { useLibraryStateStore } from '../lib/stores/useLibraryStateStore';
import { useChatStore, chatPreviewFor } from '../lib/stores/useChatStore';
import { lastInteractionAt } from '../lib/lastInteraction';
import { isHomeCharacter } from '../lib/homeLibrary';
import { presenceOf, useMinuteTick } from '../lib/presence';
import { actionVerb } from '../lib/actionVerb';
import { pickPalette } from '../lib/portraitPalettes';
import { PixelPortrait } from '../components/PixelPortrait';
import { Presence } from '../components/Presence';
import { GatherPixels } from '../components/GatherPixels';
import type { GatherCycle } from '../components/GatherPixels';
import { CreationLimitModal } from '../components/CreationLimitModal';
import { BrowseCard } from '../components/BrowseCard';
import { portraitSrc } from '../lib/portraitSrc';
import { Button } from '../components/Button';
import type { Character } from '@shared/characterSchema';
import { MAX_COMPANION_SLOTS } from '@shared/characterSchema';
import type { BrowseEntry } from '@shared/ipc';
import homeStyles from './HomeScreen.module.css';
import styles from './CharactersScreen.module.css';

type Tab = 'home' | 'world';

/**
 * World grid batch size in ROWS (260704). Rows, not cards: cards-per-row is
 * responsive, so WorldGrid measures the live column count off the grid and
 * shows `columns × visibleRows` cards. Each "Load more" click adds this many
 * rows. Keeps the first paint (and its portrait-download burst) bounded.
 */
const ROWS_PER_BATCH = 4;

/**
 * Dormant-slot gathering figures by wall position (sigil-lab "four
 * variations" set) — slot 1 plays cycle a, slot 2 b, etc., so no two empty
 * slots gather into the same figure.
 */
const GATHER_CYCLES: readonly GatherCycle[] = ['a', 'b', 'c', 'd'];

/**
 * World grid wireframe rows shown while the first page is in flight — a
 * fixed two-row block (never a partial third row).
 */
const SKELETON_ROWS = 2;

/**
 * Above-the-fold group reveal: the first two visible World rows stay wireframed
 * until every portrait in them has loaded, then reveal together (no per-card
 * pop-in). This is the safety net — reveal anyway after it elapses so a slow or
 * broken portrait can never pin the wireframe forever.
 */
const FIRST_ROWS_REVEAL_TIMEOUT_MS = 4000;

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
 * HomeGrid — the party wall (Party redesign §4.2).
 *
 * All MAX_COMPANION_SLOTS panels always render: filled slots (library
 * characters by last interaction, then cloud-only placeholders), then dormant
 * "Awaken" panels for the remainder. Panel click / Message opens the chat
 * (charsOpenPrepare first); Play opens the games picker; dormant panels gate
 * on the daily creation quota then route to the awaken view.
 */
function HomeGrid(): React.ReactElement {
  const characters = useDataStore((s) => s.characters);
  const recentlyDeletedIds = useDataStore((s) => s.recentlyDeletedIds);
  const summons = useDataStore((s) => s.summons);
  const actions = useDataStore((s) => s.actions);
  const navigate = useUiStore((s) => s.navigate);
  const openModal = useUiStore((s) => s.openModal);
  const authState = useAuthStore((s) => s.state);
  const authKind = authState.kind;
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;
  const [cloudOnly, setCloudOnly] = useState<Array<{ id: string; name: string }>>([]);
  // Daily character-creation cap (persona_daily). Pre-flight gate before the
  // awaken view so a maxed-out user gets a "come back tomorrow" modal instead
  // of failing mid-expansion. null = hidden.
  const [createLimit, setCreateLimit] = useState<{ resetsAt: string | null } | null>(null);

  // Presence decays online → idle on the shared minute ticker.
  useMinuteTick();

  // Roster lastlines: live transcript tail when loaded, else the bulk
  // chat:previews pull (fetched once on mount; kept fresh by chat pushes).
  const chatState = useChatStore();
  const loadPreviews = useChatStore((s) => s.loadPreviews);
  useEffect(() => {
    void loadPreviews();
  }, [loadPreviews]);

  // Dormant panel → awaken view, gated on the daily creation quota.
  // checkCreateQuota applies to every backend (local rolling-24h creation log,
  // BYOK included) and fails open on any error, so a transient hiccup never
  // wrongly blocks the path.
  const handleAwaken = async (): Promise<void> => {
    const quota = await sei.checkCreateQuota();
    if (quota.blocked) {
      setCreateLimit({ resetsAt: quota.resetsAt });
      return;
    }
    navigate({ kind: 'awaken' });
  };

  useEffect(() => {
    // has_been_welcomed is the persisted first-open marker. The greeting
    // header is gone (party wall), but the one-shot flip stays so any future
    // first-open surface keeps working — do not delete the config plumbing.
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await sei.getConfig();
        if (cancelled) return;
        if (cfg.has_been_welcomed !== true) {
          try {
            await sei.saveConfig({ ...cfg, has_been_welcomed: true });
          } catch {
            /* non-fatal: worst case the next open repeats the flip */
          }
        }
      } catch {
        /* fall through */
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
    // The panel's "Play" CTA opens the game picker; each tile launches through
    // the shared summonFlow (skin-setup nudge → LAN gate). Mirrors CharacterPage.
    openModal({ kind: 'games-picker', characterId: id });
  };

  const handleOpen = (id: string): void => {
    // Phase 18/19: a panel click opens the in-app chat (the primary surface);
    // CharacterPage stays reachable via the chat header. Navigate FIRST so the
    // chat opens instantly — a home card is by definition already in the local
    // library, so charsOpenPrepare here is only a background freshness check.
    // Firing it AFTER navigation (fire-and-forget) keeps the click from stalling
    // on a Supabase round-trip; the chat works off the cached copy and refreshes
    // in place. A failure is non-fatal — ChatScreen refetches via its own effect.
    navigate({ kind: 'chat', characterId: id });
    void sei
      .charsOpenPrepare(id)
      .then(() => useDataStore.getState().refreshCharacter(id))
      .catch((err) => {
        console.warn(`[sei] open prepare failed for ${id}: ${(err as Error).message}`);
      });
  };

  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const addedDefaultIds = useLibraryStateStore((s) => s.addedDefaultIds);

  // See isHomeCharacter above. Kept as a named list: this is the same set the
  // World tab's slots indicator counts.
  const homeCharacters = characters.filter((c) =>
    isHomeCharacter(c, currentUserId, addedDefaultIds, addedWorldIds),
  );

  // #7 — order the wall by last interaction (summon OR chat), matching the
  // IconRail: most-recently-active first, then created desc. A failed summon
  // never stamps last_launched (backstopped in botSupervisor) and a chat only
  // stamps last_chatted on a successful reply, so failures don't reorder slots.
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

  // 260703 procgen — exactly MAX_COMPANION_SLOTS (4) slots. Fill order:
  // library characters by last interaction, then cloud-only placeholder rows
  // (which count toward the 4), capped at 4. Remaining slots render dormant.
  const cloudPlaceholders = cloudOnly
    .filter((co) => !characters.some((c) => c.id === co.id))
    .filter((co) => !recentlyDeletedIds.has(co.id))
    .map((co) => makeCloudPlaceholder(co.id, co.name));
  const placeholderIds = new Set(cloudPlaceholders.map((p) => p.id));
  const slotCharacters = [...orderedCharacters, ...cloudPlaceholders].slice(
    0,
    MAX_COMPANION_SLOTS,
  );
  const emptyCount = Math.max(0, MAX_COMPANION_SLOTS - slotCharacters.length);

  return (
    <div className={homeStyles.root}>
      <section className={homeStyles.panels} aria-label="Party">
        {slotCharacters.map((c) => {
          const isPlaceholder = placeholderIds.has(c.id);
          const preview = isPlaceholder ? null : chatPreviewFor(chatState, c.id);
          // An existing transcript is proof of interaction even when the
          // last_chatted stamp was missed (routed in-game replies, failed
          // turns, old records): never show "New"/"Say hello" over a real
          // conversation — fold the preview timestamp into presence instead.
          let pres = presenceOf(c, summons[c.id]);
          if (pres.category === 'new' && preview) {
            pres = presenceOf(
              { last_launched: null, last_chatted: new Date(preview.ts).toISOString() },
              summons[c.id],
            );
          }
          const isNew = pres.category === 'new';

          // Lastline: live action verb while in-game, else the last chat line,
          // else the "matched recently" note for never-touched companions.
          let lastline: React.ReactNode = null;
          if (!isPlaceholder) {
            if (pres.category === 'in-game') {
              const verb = actionVerb(actions[c.id]);
              if (verb) lastline = verb;
            }
            if (lastline == null) {
              if (preview) {
                lastline = (
                  <>
                    <b>{preview.role === 'user' ? 'You' : c.name}:</b> {preview.text}
                  </>
                );
              } else if (isNew) {
                lastline = 'Matched with you recently.';
              }
            }
          }

          return (
            <div
              key={c.id}
              className={`${homeStyles.panel} ${isPlaceholder ? homeStyles.panelMuted : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`Open ${c.name}`}
              onClick={() => {
                void handleOpen(c.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void handleOpen(c.id);
                }
              }}
            >
              <div className={homeStyles.art} aria-hidden="true">
                <PixelPortrait
                  seed={c.id + c.name}
                  palette={pickPalette(c.id + c.name, theme)}
                  portraitImage={c.portrait_image}
                  size={520}
                  style={{ width: '100%', height: '100%' }}
                />
              </div>
              <div className={homeStyles.panelScrim} aria-hidden="true" />
              <div className={homeStyles.info}>
                <div className={homeStyles.nameRow}>
                  <span className={homeStyles.name}>{c.name}</span>
                </div>
                {isPlaceholder ? (
                  <span className={homeStyles.cloudNote}>Stored in cloud</span>
                ) : (
                  <Presence category={pres.category} label={pres.label} />
                )}
                {!isPlaceholder ? (
                  <div className={homeStyles.more}>
                    <div className={homeStyles.moreInner}>
                      {lastline != null ? (
                        <span className={homeStyles.lastline}>{lastline}</span>
                      ) : null}
                      <div className={homeStyles.actions}>
                        <Button
                          kind="primary"
                          size="md"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleOpen(c.id);
                          }}
                        >
                          {isNew ? 'Say hello' : 'Message'}
                        </Button>
                        <Button
                          kind="ghost"
                          size="md"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSummon(c.id);
                          }}
                        >
                          Play
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        {Array.from({ length: emptyCount }).map((_, i) => {
          // Each wall position keeps its own gathering figure (sigil-lab
          // cycles a–d), offset 700ms per slot so they don't pulse together.
          const slotIdx = slotCharacters.length + i;
          return (
          <div
            key={`empty-slot-${i}`}
            className={`${homeStyles.panel} ${homeStyles.dormant}`}
            role="button"
            tabIndex={0}
            aria-label="Awaken a companion"
            onClick={() => {
              void handleAwaken();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void handleAwaken();
              }
            }}
          >
            <div
              className={`${homeStyles.dormantSky} ${homeStyles[`sky${slotIdx % 4}`]}`}
              aria-hidden="true"
            />
            <div className={homeStyles.center}>
              <span
                className={homeStyles.dormantHalo}
                style={{ animationDelay: `${slotIdx * 700}ms` }}
                aria-hidden="true"
              />
              <GatherPixels
                cycle={GATHER_CYCLES[slotIdx % GATHER_CYCLES.length]}
                stagger={slotIdx * 700}
                className={homeStyles.dormantMark}
              />
              <span className={homeStyles.awakenLabel}>Awaken</span>
            </div>
          </div>
          );
        })}
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
 * WorldGrid — public character listing backed by useBrowseStore (§4.4).
 *
 * Top bar: search + sort on the left, party-slots indicator on the right.
 * Cards: 3:4 scouting cards whose body opens the character profile; adding to
 * the library happens there via CharacterPage's "Add to library" CTA (there is
 * no in-grid invite action).
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

  // Paged display (260704): show ROWS_PER_BATCH rows per "Load more" click.
  // Cards-per-row is responsive (grid auto-fill), so the column count is
  // measured off the rendered grid rather than hardcoded.
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  const [visibleRows, setVisibleRows] = useState(ROWS_PER_BATCH);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = (): void => {
      // Computed grid-template-columns resolves auto-fill to the actual
      // track list ("190px 190px …") — its length IS the live column count.
      const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length;
      setColumns((prev) => (prev === cols ? prev : Math.max(1, cols)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // #6 — World sort. Alphabetical by default; "Newest" sorts by updatedAt desc.
  // Client-side over the currently-loaded pages.
  const [worldSort, setWorldSort] = useState<'alpha' | 'recent'>('alpha');

  const localCharacters = useDataStore((s) => s.characters);
  const addedDefaultIds = useLibraryStateStore((s) => s.addedDefaultIds);
  const addedWorldIds = useLibraryStateStore((s) => s.addedWorldIds);
  const authState = useAuthStore((s) => s.state);
  const currentUserId = authState.kind === 'signed_in' ? authState.user.id : null;

  // Party-slots indicator — counts the SAME set the party wall shows (minus
  // cloud-only placeholders, which have no local row to count here).
  const homeCount = localCharacters.filter((c) =>
    isHomeCharacter(c, currentUserId, addedDefaultIds, addedWorldIds),
  ).length;
  const slotsOpen = Math.max(0, MAX_COMPANION_SLOTS - homeCount);
  const partyFull = slotsOpen <= 0;

  // Bundled defaults (sui/lyra/clawd) are surfaced as system-authored World
  // entries so the user can find them next to other public characters even
  // though they live in the local store and don't have a cloud row (D-22).
  // `inMyLibrary` flips false when the user removed the default from their
  // library (config-tracked) so BrowseCard offers Invite again.
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
      // Builtins carry their vanity code in the bundled JSON (#0001-#0003),
      // matching the cloud rows — surface it like any other World card.
      publicId: c.public_id ?? null,
      portraitUrl: c.portrait_image,
      skinUrl: null,
      updatedAt: c.created,
      // 260703 procgen: defaults are opt-in on Home — "in library" means the
      // user invited this default (matches the HomeGrid/IconRail filter).
      inMyLibrary: addedDefaultIds.has(c.id),
    }));

  const navigate = useUiStore((s) => s.navigate);

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

  // A new search shows a fresh result set — restart at the first batch.
  useEffect(() => {
    setVisibleRows(ROWS_PER_BATCH);
  }, [query]);

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

  const handleOpen = (entry: BrowseEntry): void => {
    // Navigate immediately — CharacterPage self-handles a cache miss on mount
    // (its rehydrate effect runs charsOpenPrepare + refresh when the character
    // isn't in the local store yet), showing a wireframe skeleton while the
    // download lands. The hover prefetch above has usually already warmed the
    // cache by the time this fires, so the profile fills in at once.
    navigate({ kind: 'character', id: entry.id });
  };

  // Merge defaults + cloud rows into one list, then sort per the dropdown.
  const worldEntries = [
    ...defaultEntries,
    ...entries.filter((e) => !defaultEntries.some((d) => d.id === e.id)),
  ].sort((a, b) =>
    worldSort === 'alpha' ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt),
  );

  // Cap the DISPLAY to whole rows; the store keeps its own page size. Cards
  // render → portraits download, so this cap is what bounds the network burst.
  const visibleCount = columns * visibleRows;

  // Cold open / new search with nothing fetched yet: hold back the bundled
  // defaults too, so the whole grid loads as one piece of wireframe instead
  // of three real cards next to skeletons.
  const initialLoading = loading && entries.length === 0;
  const shownEntries = initialLoading ? [] : worldEntries.slice(0, visibleCount);

  // Group-reveal gate for the first two visible rows (above the fold): hold
  // their wireframes until every portrait in those rows has actually loaded
  // (or failed / timed out), then reveal them together — instead of letting
  // each card pop in as its own image streams (260706). Rows past the first
  // two keep the per-card lazy reveal. "Two rows" tracks the live measured
  // column count, so it follows the responsive grid.
  const firstRowsCount = columns * SKELETON_ROWS;
  const firstRowsEntries = shownEntries.slice(0, firstRowsCount);
  // A stable key over the first-rows set: re-gate only when the actual cards
  // (or their portrait refs) change — not on every render.
  const firstRowsKey = firstRowsEntries
    .map((e) => `${e.id}:${e.portraitUrl ?? ''}`)
    .join('|');
  const firstRowsSrcs = firstRowsEntries
    .map((e) => portraitSrc(e.portraitUrl))
    .filter((s): s is string => !!s);
  const [firstRowsReady, setFirstRowsReady] = useState(false);
  useEffect(() => {
    // Nothing on screen yet (still fetching page 0) → stay gated so the
    // initial-loading skeletons keep holding.
    if (firstRowsEntries.length === 0) {
      setFirstRowsReady(false);
      return;
    }
    // No portraits to wait on (all procedural) → reveal at once.
    if (firstRowsSrcs.length === 0) {
      setFirstRowsReady(true);
      return;
    }
    setFirstRowsReady(false);
    let settled = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      settled += 1;
      if (settled >= firstRowsSrcs.length) {
        done = true;
        setFirstRowsReady(true);
      }
    };
    const imgs = firstRowsSrcs.map((src) => {
      const img = new Image();
      let counted = false;
      const once = (): void => {
        if (counted) return;
        counted = true;
        finish();
      };
      // A broken image resolves via onerror — treated as "done" so it never
      // holds the group.
      img.onload = once;
      img.onerror = once;
      img.src = src;
      // A cached image can already be complete before the handlers attach.
      if (img.complete) once();
      return img;
    });
    const timer = window.setTimeout(() => {
      if (!done) {
        done = true;
        setFirstRowsReady(true);
      }
    }, FIRST_ROWS_REVEAL_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
      imgs.forEach((img) => {
        img.onload = null;
        img.onerror = null;
      });
    };
    // firstRowsKey uniquely determines firstRowsEntries/firstRowsSrcs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstRowsKey]);

  // Backfill: when the display window outruns what's loaded (initial batch on
  // a wide window, or "Load more" past the last fetched page), pull the next
  // page. loadMore() no-ops while loading/exhausted, so this can't stack.
  useEffect(() => {
    if (worldEntries.length < visibleCount && !exhausted && !loading) void loadMore();
  }, [worldEntries.length, visibleCount, exhausted, loading, loadMore]);

  // More to show: either already-loaded rows beyond the cap, or more pages
  // server-side. Hidden while the very first page is still loading.
  const hasMoreToShow = worldEntries.length > visibleCount || !exhausted;

  // Wireframe placeholders while a fetch is in flight: a fixed SKELETON_ROWS
  // block on a cold open / new search (whole rows only — never a partial
  // trailing row), just the unfilled tail slots on a Load-more backfill
  // (row-aligned by construction: visibleCount is a whole-row count). Zero
  // when a background fetch isn't going to change what's on screen.
  const skeletonCount = loading
    ? initialLoading
      ? columns * SKELETON_ROWS
      : Math.max(0, visibleCount - shownEntries.length)
    : 0;

  return (
    <div className={styles.browse}>
      <header className={styles.worldTop}>
        <div className={styles.search}>
          <svg
            width="15"
            height="15"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <circle cx="9" cy="9" r="6" />
            <path d="M13.5 13.5L18 18" />
          </svg>
          <input
            className={styles.searchField}
            type="search"
            placeholder="Search companions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search world companions"
          />
        </div>
        <select
          className={styles.sortSelect}
          value={worldSort}
          onChange={(e) => setWorldSort(e.target.value as 'alpha' | 'recent')}
          aria-label="Sort companions"
        >
          <option value="alpha">A–Z</option>
          <option value="recent">Newest</option>
        </select>
        <span className={styles.slots}>
          {partyFull ? 'Party full' : `${slotsOpen}/${MAX_COMPANION_SLOTS} slots open`}
        </span>
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
      <div className={styles.grid} ref={gridRef}>
        {shownEntries.map((entry, i) => (
          <BrowseCard
            key={entry.id}
            entry={entry}
            theme={theme}
            ready={i < firstRowsCount ? firstRowsReady : undefined}
            onOpen={() => {
              void handleOpen(entry);
            }}
            onPrefetch={() => handlePrefetch(entry)}
          />
        ))}
        {Array.from({ length: skeletonCount }, (_, i) => (
          <div key={`skeleton-${i}`} className={styles.skeletonCard} aria-hidden>
            <div className={styles.skeletonArt} />
            <div className={styles.skeletonName} />
            <div className={styles.skeletonMeta} />
          </div>
        ))}
      </div>
      {hasMoreToShow && !loading ? (
        <div className={styles.loadMoreRow}>
          <Button kind="ghost" onClick={() => setVisibleRows((r) => r + ROWS_PER_BATCH)}>
            Load more
          </Button>
        </div>
      ) : null}
      </div>
    </div>
  );
}
