// Exit 0 when a certificate subject matches a publisher by the rule Sei's
// updaters use (src/main/velopackSignature.ts publisherMatches, the same rule
// as electron-updater's), 1 when it does not, 2 on bad input. release.yml
// runs it so its signature checks cannot drift from the client's. Inputs are
// the two arguments, or with no arguments the environment variables
// PUBLISHER_MATCH_SUBJECT and PUBLISHER_MATCH_PUBLISHER (a DN with quotes or
// commas passes through untouched that way):
//   node --experimental-strip-types scripts/velopack-ci/publisher-match.mjs "<subject>" "<publisher>"
import { publisherMatches } from '../../src/main/velopackSignature.ts';

const args = process.argv.slice(2);
const [subject, publisher] =
  args.length > 0 ? args : [process.env.PUBLISHER_MATCH_SUBJECT ?? '', process.env.PUBLISHER_MATCH_PUBLISHER ?? ''];
if (typeof subject !== 'string' || typeof publisher !== 'string' || !publisher.trim()) {
  console.error('usage: publisher-match.mjs <subject> <publisher> (or PUBLISHER_MATCH_SUBJECT / PUBLISHER_MATCH_PUBLISHER)');
  process.exit(2);
}
const ok = publisherMatches(subject, publisher);
console.log(`${ok ? 'match' : 'no match'}: subject [${subject}] publisher [${publisher}]`);
process.exit(ok ? 0 : 1);
