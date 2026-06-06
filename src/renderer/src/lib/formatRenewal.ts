/**
 * formatRenewal — shared ISO-timestamp → "May 22, 2026" formatter.
 *
 * Extracted from CreditsScreen.tsx so ReceiptScreen.tsx (quick/260525-sbo
 * Task 6) can reuse the exact same en-US locale formatting without
 * duplicating the helper. Returns null when the input is missing or
 * unparseable so the caller can decide whether to omit the line entirely
 * or render a fallback like "in 30 days".
 */
export function formatRenewal(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(d);
  } catch {
    return null;
  }
}
