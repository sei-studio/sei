/**
 * librarySync pure-function tests (260801).
 *
 * The diff is the part worth pinning: it is the only thing standing between a
 * reconcile and deleting a user's whole roster from the cloud. Everything else
 * in the module is IO the tests deliberately do not reach.
 */
import { describe, it, expect } from 'vitest';
import { rosterFromConfig, diffRoster } from './librarySync';

describe('rosterFromConfig', () => {
  it('labels each list with its source', () => {
    expect(rosterFromConfig({ added_default_ids: ['a'], added_world_ids: ['b'] })).toEqual([
      { character_id: 'a', source: 'default' },
      { character_id: 'b', source: 'world' },
    ]);
  });

  it('treats missing lists as empty', () => {
    expect(rosterFromConfig({} as never)).toEqual([]);
  });

  it('dedupes an id present in both lists, world winning', () => {
    // The defaults-to-World migration moves ids across; an install caught
    // mid-migration can carry one in both, and the PK allows only one row.
    const out = rosterFromConfig({ added_default_ids: ['a'], added_world_ids: ['a'] });
    expect(out).toEqual([{ character_id: 'a', source: 'world' }]);
  });
});

describe('diffRoster', () => {
  it('is a no-op when both sides already agree', () => {
    const rows = [{ character_id: 'a', source: 'world' as const }];
    expect(diffRoster(rows, [...rows])).toEqual({ upsert: [], remove: [] });
  });

  it('uploads the whole roster when the remote is empty (first sync after upgrade)', () => {
    const local = [
      { character_id: 'a', source: 'default' as const },
      { character_id: 'b', source: 'world' as const },
    ];
    expect(diffRoster(local, [])).toEqual({ upsert: local, remove: [] });
  });

  it('removes only ids the local roster dropped', () => {
    const out = diffRoster(
      [{ character_id: 'a', source: 'world' }],
      [
        { character_id: 'a', source: 'world' },
        { character_id: 'gone', source: 'world' },
      ],
    );
    expect(out).toEqual({ upsert: [], remove: ['gone'] });
  });

  it('re-upserts a row whose source changed rather than leaving it stale', () => {
    const out = diffRoster(
      [{ character_id: 'a', source: 'world' }],
      [{ character_id: 'a', source: 'default' }],
    );
    expect(out).toEqual({ upsert: [{ character_id: 'a', source: 'world' }], remove: [] });
  });

  it('never removes everything just because the local roster is empty AND remote is empty', () => {
    expect(diffRoster([], [])).toEqual({ upsert: [], remove: [] });
  });

  it('clears the remote when the user emptied their library', () => {
    // The honest counterpart of the case above: an empty local roster is a
    // real state (every foreign character removed), not a failed read — the
    // caller is responsible for not calling this on a failed config load.
    const out = diffRoster([], [{ character_id: 'a', source: 'world' }]);
    expect(out).toEqual({ upsert: [], remove: ['a'] });
  });
});
