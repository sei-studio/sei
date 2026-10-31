#!/usr/bin/env node
/**
 * Verify the app's PostHog identity sequence against a SCRATCH PostHog
 * project (261031, T278 review). NOT for production: it refuses the app's
 * baked production key, and it must be pointed at a project made for this.
 * Nobody runs this automatically; create the scratch project by hand first.
 *
 * It sends, with fresh random ids, exactly the calls src/main/analytics.ts
 * makes (analytics.identity.test.ts asserts the same sequences offline):
 *
 *   (a) fresh install, never signs in:
 *       capture(device, installer_first_launch | app_opened | onboarding_step)
 *   (b) fresh install, then a NEW account:
 *       capture(device, ...day 0) ; alias(user <- device) ; identify(user)
 *   (c) fresh install, then an EXISTING account (made on "another machine"
 *       first: capture(other) ; alias(user <- other) ; identify(user)):
 *       capture(device, ...day 0) ; alias(user <- device) ; identify(user)
 *   (d) a pre-261031 anonymous install, then signs in:
 *       capture(install, ...) ; alias(user <- install) ; identify(user)
 *   (e) a second account on the same device (b's device): identify(user2)
 *       only, no alias (analytics.ts IDENTITY_FILE guard)
 *
 * Then wait a few minutes for ingestion and run the printed HogQL in the
 * scratch project: every row of a scenario that signs in must show ONE
 * person_id, and (e)'s user2 a different one from (b)'s user.
 *
 * Usage:
 *   POSTHOG_SCRATCH_KEY=phc_... [POSTHOG_SCRATCH_HOST=https://us.i.posthog.com] \
 *     node scripts/posthog-identity-check.mjs --scratch-project
 */
import { randomUUID } from 'node:crypto';
import { PostHog } from 'posthog-node';

const PROD_KEY = 'phc_srnfn2HQDxcGyadVKFz9qRzEv7Rr2XTtzMpNbgPc2F7R';
const key = (process.env.POSTHOG_SCRATCH_KEY ?? '').trim();
const host = (process.env.POSTHOG_SCRATCH_HOST ?? 'https://us.i.posthog.com').trim();

if (!process.argv.includes('--scratch-project') || !key.startsWith('phc_')) {
  console.error('Set POSTHOG_SCRATCH_KEY to a SCRATCH project key and pass --scratch-project.');
  process.exit(2);
}
if (key === PROD_KEY || key === (process.env.POSTHOG_KEY ?? '').trim()) {
  console.error('Refusing: that is the production ingestion key.');
  process.exit(2);
}

const run = `idcheck-${Date.now().toString(36)}`;
const id = (label) => `${run}-${label}-${randomUUID().slice(0, 8)}`;
const ph = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dayZero(distinctId, scenario) {
  for (const event of ['installer_first_launch', 'app_opened', 'onboarding_step']) {
    ph.capture({ distinctId, event, properties: { idcheck_run: run, scenario } });
  }
}

const ids = {};

// (a)
ids.a_device = id('a-device');
dayZero(ids.a_device, 'a');

// (b)
ids.b_device = id('b-device');
ids.b_user = id('b-user');
dayZero(ids.b_device, 'b');
await sleep(1500);
ph.alias({ distinctId: ids.b_user, alias: ids.b_device });
ph.identify({ distinctId: ids.b_user, properties: { idcheck_run: run } });
ph.capture({ distinctId: ids.b_user, event: 'signed_in', properties: { idcheck_run: run, scenario: 'b' } });

// (c) the account exists first, from another machine.
ids.c_other = id('c-other-install');
ids.c_user = id('c-user');
ph.capture({ distinctId: ids.c_other, event: 'app_opened', properties: { idcheck_run: run, scenario: 'c' } });
await sleep(1500);
ph.alias({ distinctId: ids.c_user, alias: ids.c_other });
ph.identify({ distinctId: ids.c_user, properties: { idcheck_run: run } });
ph.capture({ distinctId: ids.c_user, event: 'chat_session_started', properties: { idcheck_run: run, scenario: 'c' } });
await sleep(3000);
ids.c_device = id('c-device');
dayZero(ids.c_device, 'c');
await sleep(1500);
ph.alias({ distinctId: ids.c_user, alias: ids.c_device });
ph.identify({ distinctId: ids.c_user, properties: { idcheck_run: run } });
ph.capture({ distinctId: ids.c_user, event: 'signed_in', properties: { idcheck_run: run, scenario: 'c' } });

// (d)
ids.d_install = id('d-install');
ids.d_user = id('d-user');
dayZero(ids.d_install, 'd');
await sleep(1500);
ph.alias({ distinctId: ids.d_user, alias: ids.d_install });
ph.identify({ distinctId: ids.d_user, properties: { idcheck_run: run } });
ph.capture({ distinctId: ids.d_user, event: 'signed_in', properties: { idcheck_run: run, scenario: 'd' } });

// (e) a second account on (b)'s device: identify only.
ids.e_user2 = id('e-user2');
ph.identify({ distinctId: ids.e_user2, properties: { idcheck_run: run } });
ph.capture({ distinctId: ids.e_user2, event: 'signed_in', properties: { idcheck_run: run, scenario: 'e' } });

await ph.shutdown(10_000);

console.log(JSON.stringify(ids, null, 2));
console.log(`
Sent. After ingestion (a few minutes), run in the SCRATCH project's SQL editor:

  SELECT properties.scenario AS scenario, distinct_id, event, person_id
  FROM events
  WHERE properties.idcheck_run = '${run}'
  ORDER BY scenario, timestamp

Expected: within (b), (c) and (d) one person_id per scenario (the day-0
device / install events share the account's person); (e)'s person_id differs
from (b)'s; (a) is one anonymous person.`);
