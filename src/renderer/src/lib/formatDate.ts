/**
 * formatDate — ISO-timestamp → "Jun 6, 2026" formatter that always renders in
 * the user's LOCAL timezone.
 *
 * Extracted from CharacterPage.tsx (the "Bonded" / "Last launch" stat lines) to
 * fix a timezone bug: a date-only value like "2026-06-06" was parsed by
 * `new Date("2026-06-06")` as UTC midnight, which in a negative-offset zone
 * (e.g. US Pacific) rolls back to the previous calendar day — the card showed
 * "Jun 5, 2026" at 12:45 AM Pacific on Jun 6. Full ISO timestamps (with a time
 * component) already localize correctly; only bare date strings needed the fix.
 *
 * The guard below detects a bare `YYYY-MM-DD` and builds the Date from its
 * parts in local time, so the displayed calendar day matches the stored one.
 * Returns '-' for a missing or unparseable value.
 */
export function formatDate(iso: string | null): string {
  if (!iso) return '-';
  try {
    const d = parseLocalDate(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '-';
  }
}

/**
 * Parse an ISO string into a Date. A bare date (`YYYY-MM-DD`, no time) is built
 * from its components in LOCAL time so it lands on the intended calendar day
 * rather than UTC midnight. Anything with a time component (or an offset) is
 * left to the native parser, which localizes it correctly.
 */
function parseLocalDate(iso: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (dateOnly) {
    const [, y, m, day] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(day));
  }
  return new Date(iso);
}
