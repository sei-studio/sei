/**
 * Analytics for the own-key (local) companion import (261116). Shape only:
 * where it was offered, counts and an outcome, never names or ids.
 *
 *   local_import_party_full {entry, party_count, incoming, limit}
 *     the import was not offered (or refused by main) because the local
 *     companions would not fit the account's party; the one-line notice or
 *     the Settings hint showed instead.
 *   local_import_result {entry, outcome, imported_n, failed_n}
 *     the player answered the import modal: outcome 'imported' | 'failed' |
 *     'party_full' | 'declined'.
 */
import type { LocalImportPartyFit } from '@shared/ipc';
import { sei } from './ipcClient';

/** Where the import was offered: the sign-in, the one-time boot offer, after the first-run scene, or Settings. */
export type LocalImportEntry = 'sign_in' | 'boot' | 'onboarding' | 'settings';

export type LocalImportOutcome = 'imported' | 'failed' | 'party_full' | 'declined';

function track(event: string, props: Record<string, string | number | boolean>): void {
  try {
    sei.track(event, props);
  } catch {
    /* analytics must never break the offer */
  }
}

export function trackLocalImportPartyFull(entry: LocalImportEntry, party: LocalImportPartyFit | undefined): void {
  track('local_import_party_full', {
    entry,
    party_count: party?.count ?? -1,
    incoming: party?.incoming ?? -1,
    limit: party?.limit ?? -1,
  });
}

export function trackLocalImportResult(
  entry: LocalImportEntry,
  outcome: LocalImportOutcome,
  importedN: number,
  failedN: number,
): void {
  track('local_import_result', { entry, outcome, imported_n: importedN, failed_n: failedN });
}




