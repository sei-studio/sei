// Staged rollout for electron-updater feeds (261101, scale review M2).
//
// electron-updater (6.8.3 in every shipped 0.6.x client) reads an optional
// top-level `stagingPercentage` from latest.yml / latest-mac.yml (and the
// beta*.yml mirror copies). AppUpdater.isStagingMatch buckets each device on
// the UUID in <userData>/.updaterId:
//
//   field absent        -> everyone is offered the update
//   parseInt() is NaN   -> everyone (logged as a warning), so never write junk
//   N (0..100)          -> offered when bucket < N/100, bucket in [0, 1]
//
// So 0 offers the update to NOBODY (bucket < 0 is never true): 0 is the
// pause value. 100 offers it to everyone except a device whose bucket is
// exactly 1.0; promote removes the field instead, which is exact.
//
// The rewrite is line based on purpose: it touches only top-level
// `stagingPercentage:` lines and leaves every other byte (sha512, files,
// releaseDate quoting, line endings) as electron-builder wrote it.

export const PAUSE_PERCENT = 0;

const FIELD = 'stagingPercentage';
const FIELD_LINE = /^stagingPercentage:/;
const FIELD_LINE_M = /^stagingPercentage:[^\r\n]*/m;
const FIELD_LINE_WITH_EOL = /^stagingPercentage:[^\r\n]*(?:\r?\n|$)/m;

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Lines without their terminators, plus whether the text ended with one. */
function splitLines(text) {
  const eol = eolOf(text);
  const trailing = text.endsWith('\n');
  const body = trailing ? text.slice(0, text.endsWith('\r\n') ? -2 : -1) : text;
  return { eol, trailing, lines: body === '' ? [] : body.split(/\r?\n/) };
}

function topLevel(lines, key) {
  const re = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

function unquote(v) {
  const m = /^(['"])(.*)\1$/.exec(v);
  return m ? m[2] : v;
}

/** Throws unless the text looks like an electron-builder update feed. */
export function assertFeed(text, name = 'feed') {
  const { lines } = splitLines(text);
  if (topLevel(lines, 'version') === undefined || !lines.some((l) => /^files:/.test(l))) {
    throw new Error(`${name} is not an electron-updater feed (no top-level version: and files:)`);
  }
  if (lines.filter((l) => FIELD_LINE.test(l)).length > 1) {
    throw new Error(`${name} has more than one ${FIELD} line`);
  }
}

/** The feed's top-level version, unquoted. */
export function readVersion(text) {
  const v = topLevel(splitLines(text).lines, 'version');
  return v === undefined ? undefined : unquote(v);
}

/**
 * The feed's stagingPercentage: null when absent, otherwise the raw value as
 * electron-updater would read it (a number when it is an integer literal).
 */
export function readStaging(text) {
  const v = topLevel(splitLines(text).lines, FIELD);
  if (v === undefined) return null;
  const raw = unquote(v);
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

function checkPercent(percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error(`percent must be an integer 0-100, got ${percent}`);
  }
}

/**
 * The percent a rollout action writes: a number, or null for "no field".
 *   set N    -> N, except 100 -> null (exactly everyone; see header)
 *   pause    -> 0 (nobody)
 *   promote  -> null
 */
export function targetPercent(action, percent) {
  if (action === 'promote') return null;
  if (action === 'pause') return PAUSE_PERCENT;
  if (action === 'set') {
    checkPercent(percent);
    return percent === 100 ? null : percent;
  }
  throw new Error(`action must be set, pause or promote, got ${action}`);
}

/**
 * Return `text` with stagingPercentage set to `percent` (an integer 0..100),
 * or removed when `percent` is null. Every other line is kept byte for byte,
 * the file's line ending (LF or CRLF) is reused, and an existing field is
 * replaced where it stands (a new one is appended at the end, where
 * electron-builder itself writes it).
 */
export function setStaging(text, percent, name = 'feed') {
  if (percent !== null) checkPercent(percent);
  assertFeed(text, name);
  let next;
  if (percent === null) {
    next = text.replace(FIELD_LINE_WITH_EOL, '');
  } else if (FIELD_LINE_M.test(text)) {
    next = text.replace(FIELD_LINE_M, `${FIELD}: ${percent}`);
  } else {
    const eol = eolOf(text);
    next = text.endsWith('\n') ? `${text}${FIELD}: ${percent}${eol}` : `${text}${eol}${FIELD}: ${percent}`;
  }
  // Belt and braces: with the field stripped, old and new must be identical.
  if (stripStaging(next) !== stripStaging(text)) {
    throw new Error(`${name}: rewrite changed more than ${FIELD}`);
  }
  return next;
}

/** The text without its stagingPercentage line and without one final line break. */
function stripStaging(text) {
  return text.replace(new RegExp(FIELD_LINE_WITH_EOL.source, 'gm'), '').replace(/\r?\n$/, '');
}

/**
 * mirror-release.yml: the percent to publish on the mirror for an incoming
 * feed, given what the mirror already serves under that name. The incoming
 * value wins when it has one. When it has none but the mirror serves the SAME
 * version with a value, that value is kept: a rollout.yml run that landed
 * while the mirror job was uploading artifacts must not be undone by the
 * mirror job's older copy. Returns { percent, carried }.
 */
export function carryStaging(incomingText, existingText) {
  const incoming = readStaging(incomingText);
  if (incoming !== null) return { percent: incoming, carried: false };
  if (!existingText) return { percent: null, carried: false };
  try {
    assertFeed(existingText, 'existing');
  } catch {
    return { percent: null, carried: false };
  }
  const existing = readStaging(existingText);
  if (existing === null || readVersion(existingText) !== readVersion(incomingText)) {
    return { percent: null, carried: false };
  }
  if (!Number.isInteger(existing) || existing < 0 || existing > 100) {
    return { percent: null, carried: false };
  }
  return { percent: existing, carried: true };
}

/** "20%", "absent (100%)" for logs. */
export function describeStaging(v) {
  if (v === null) return 'absent (everyone)';
  if (typeof v === 'number') return v === 0 ? '0 (paused: nobody)' : `${v}%`;
  return `${JSON.stringify(v)} (not a number: electron-updater treats it as everyone)`;
}

/** Minimal line diff (the files are a dozen lines) for dry runs. */
export function lineDiff(before, after) {
  const a = splitLines(before).lines;
  const b = splitLines(after).lines;
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (i < a.length && !b.slice(j).includes(a[i])) {
      out.push(`- ${a[i++]}`);
    } else if (j < b.length) {
      out.push(`+ ${b[j++]}`);
    } else {
      out.push(`- ${a[i++]}`);
    }
  }
  if (eolOf(before) !== eolOf(after)) out.push('! line endings changed');
  return out.join('\n');
}
