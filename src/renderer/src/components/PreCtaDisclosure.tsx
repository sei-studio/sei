/**
 * PreCtaDisclosure — quick/260525-sbo Task 4.
 *
 * Renders the three required disclosure lines per California Bus & Prof Code
 * §17602(a)(1) ("clear and conspicuous" pre-purchase disclosure of the
 * automatic renewal terms — total amount, frequency, cancellation method).
 * Mounts immediately above EVERY "Join a Party" CTA (CreditsScreen Party
 * card + HardStopModal footer).
 *
 * Visual-proximity rule: the disclosure block uses the SAME visual weight as
 * the surrounding body copy (.line uses --ink-1, NOT --ink-muted; same font
 * size as .tileBody). Footnote/muted styling here would violate the
 * "clear and conspicuous" prong of the statute.
 *
 * PROXY-05 carve-out: this disclosure block renders dollar amounts in the
 * renderer per CA ARL §17602(a)(1) clear-and-conspicuous + visual-proximity
 * requirement. The PROXY-05 bright-line ("no dollar amounts in renderer") is
 * suspended for the at-purchase legal-disclosure surface only — all other UI
 * surfaces (Playtime pill, plan labels, hard-stop copy) remain dollar-free.
 *
 * Lines rendered, in EXACT order:
 *   1. "$20.00 USD per month"
 *   2. Renewal day:
 *        - With renewsAt → "Auto-renews on the {Nth} of each month until you cancel"
 *        - Without       → "Auto-renews monthly until you cancel"  (first-time
 *          purchaser path — we have no renewal date yet)
 *   3. "Cancel anytime in Settings → Cloud AI → Cancel subscription"
 *
 * 260602-uv9: the prior "14-day money-back on unused credits" line was REMOVED
 * — Sei's policy is now all-sales-final (cancellation only stops auto-renewal
 * at the end of the current paid period). The three lines above remain because
 * they are the CA ARL §17602(a)(1) clear-and-conspicuous requirements (price,
 * auto-renew terms, cancellation method).
 *
 * Source: quick/260525-sbo Cluster F Task 4; money-back line removed 260602-uv9.
 */
import React from 'react';
import styles from './PreCtaDisclosure.module.css';

export interface PreCtaDisclosureProps {
  /**
   * ISO timestamp of the next renewal date if the user already has an
   * active subscription (renews_at on CreditsStatus). For the typical
   * first-time-Join-a-Party path this is null — we render the
   * "Auto-renews monthly" fallback that doesn't claim a day-of-month.
   */
  renewsAt: string | null;
}

/**
 * 1 → "1st", 2 → "2nd", 3 → "3rd", 11/12/13 → "11th"/"12th"/"13th",
 * 21 → "21st", etc. Inline rather than imported — 10 lines of switch
 * logic is cheaper than another dep.
 */
function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function renewalLine(renewsAt: string | null): string {
  if (!renewsAt) return 'Auto-renews monthly until you cancel.';
  const d = new Date(renewsAt);
  if (Number.isNaN(d.getTime())) return 'Auto-renews monthly until you cancel.';
  return `Auto-renews on the ${ordinal(d.getDate())} of each month until you cancel.`;
}

export function PreCtaDisclosure({ renewsAt }: PreCtaDisclosureProps): React.ReactElement {
  return (
    <div className={styles.block} role="group" aria-label="Subscription terms">
      <p className={styles.line}>$20.00 USD per month</p>
      <p className={styles.line}>{renewalLine(renewsAt)}</p>
      <p className={styles.line}>Cancel anytime in Settings → Cloud AI → Cancel subscription</p>
    </div>
  );
}
