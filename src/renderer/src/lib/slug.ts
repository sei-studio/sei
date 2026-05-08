/**
 * slugify — derive a kebab-case character id from a free-form name.
 *
 * Source: 04-07-onboarding-and-home-PLAN.md Task 1; T-04-31 mitigation
 * (renderer-side defense — main re-validates via Zod). Collision-safe
 * `-2`/`-3` suffix logic so re-creating "Sui" while `sui` exists yields
 * `sui-2`, `sui-3`, etc.
 *
 * Rules:
 *  - Lower-case, NFKD-normalize, strip diacritics.
 *  - Replace any run of non-ASCII-alnum with a single hyphen.
 *  - Trim leading/trailing hyphens, collapse runs.
 *  - Empty result → fall back to `'character'`.
 *  - On collision with `existingIds`, append `-2`, then `-3`, etc.
 */
export function slugify(name: string, existingIds: string[] = []): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
      .replace(/[^a-z0-9]+/g, '-') // non-alnum → hyphen
      .replace(/^-+|-+$/g, '') // trim hyphens
      .replace(/-{2,}/g, '-') || 'character'; // collapse + fallback

  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
