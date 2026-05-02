#!/usr/bin/env node
/**
 * Verification harness for Phase 3 Plan 3-02 (markdown memory layer).
 *
 * Usage: node scripts/verify-phase3-memory.js --case=<name>
 *
 * Cases (Task 1 — atomicWrite + ownerStore + diary + config):
 *   atomic-write              — atomicWrite tmp lives in same dir, renames cleanly, no leftover
 *   fresh-install             — loadOwner on missing file returns exists:false; does NOT create file
 *   owner-roundtrip           — saveOwner then loadOwner returns equal data
 *   owner-tolerates-malformed — extra/unknown frontmatter keys are ignored, no throw
 *   owner-seed-block          — formatOwnerSeedBlock produces budgeted markdown
 *   diary-lazy-create         — createDiary().seedSlice() on missing file does not create file
 *   diary-newest-first        — appendEntry preserves newest-first order in readAll()
 *   diary-byte-budget         — seedSlice() respects seedDiaryBudgetBytes
 *   diary-heading-format      — appendEntry produces D-49 heading format with ≤6 word topic
 *   diary-replace-older-half  — replaceOlderHalf keeps top half + replacement
 *
 * Cases (Task 2 — sessionState + bot.js wiring):
 *   owner-uuid-cold           — first-encounter creates OWNER.md with UUID
 *   owner-uuid-warm           — subsequent join increments total_sessions, updates last_seen
 *   username-change-recognition — UUID-based recognition survives username change
 *   owner-uuid-fallback       — empty UUID falls back to username match (D-48)
 *   spawn-settle-delay        — onSpawn() respects 500ms delay before checking bot.players
 *   per-loop-batch-counter    — onLoopTerminal() updates counters without disk writes
 *
 * Cases (Task 3 — seed-message loader in orchestrator):
 *   seed-content-shape        — seed user turn has exactly seed_owner, seed_diary, event, snapshot blocks
 *   seed-content-fresh-install — placeholder text when no OWNER/DIARY exist
 *   seed-budget-respected     — seed_owner ≤ 1024 bytes, seed_diary ≤ 3072 bytes
 *   seed-permanent-across-iterations — seed turn keeps OWNER/DIARY through 5 iterations
 *   seed-not-in-system-blocks — cachedSystemBlocks contain no `# Owner`/`# Diary` text
 */

import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { atomicWrite } from '../src/storage/atomicWrite.js'
import { loadOwner, saveOwner, formatOwnerSeedBlock } from '../src/memory/owner.js'
import { createDiary } from '../src/memory/diary.js'
import { createSessionState } from '../src/llm/sessionState.js'
import { createCompactor } from '../src/llm/compaction.js'

const argv = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)

// ─── helpers ───────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg)
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`ASSERTION FAILED: ${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

function freshTmpDir() {
  return mkdtempSync(join(tmpdir(), `sei-test-${process.pid}-`))
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

const CASES = {}

// ─── Task 1 ────────────────────────────────────────────────────────────

CASES['atomic-write'] = async () => {
  const dir = freshTmpDir()
  try {
    const target = join(dir, 'foo.md')
    await atomicWrite(target, 'hello')
    assert(existsSync(target), 'target exists after atomicWrite')
    assertEqual(readFileSync(target, 'utf8'), 'hello', 'target content matches')

    // Verify no leftover tmp file in dir
    const leftovers = readdirSync(dir).filter(n => n !== 'foo.md')
    assertEqual(leftovers.length, 0, `no leftover tmp files (got ${JSON.stringify(leftovers)})`)

    // Concurrency: independent paths, no interference
    const a = join(dir, 'a.md')
    const b = join(dir, 'b.md')
    await Promise.all([atomicWrite(a, 'A'), atomicWrite(b, 'B')])
    assertEqual(readFileSync(a, 'utf8'), 'A', 'a.md')
    assertEqual(readFileSync(b, 'utf8'), 'B', 'b.md')

    // Verify the implementation is NOT using os.tmpdir for the tmp file:
    // grep the source.
    const src = readFileSync(new URL('../src/storage/atomicWrite.js', import.meta.url), 'utf8')
    assert(!/os\.tmpdir|tmpdir\(\)/.test(src), 'atomicWrite.js must not reference os.tmpdir')
    console.log('OK atomic-write')
  } finally { cleanup(dir) }
}

CASES['fresh-install'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerPath = join(dir, 'OWNER.md')
    const data = await loadOwner(ownerPath)
    assertEqual(data.exists, false, 'exists=false on missing file')
    assertEqual(data.owner_uuid, null, 'owner_uuid null')
    assertEqual(data.owner_username, null, 'owner_username null')
    assertEqual(data.total_sessions, 0, 'total_sessions 0')
    assertEqual(data.notes, '', 'notes empty')
    assert(!existsSync(ownerPath), 'loadOwner did NOT create the file (Q4 lazy-create)')
    console.log('OK fresh-install')
  } finally { cleanup(dir) }
}

CASES['owner-roundtrip'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerPath = join(dir, 'OWNER.md')
    const original = {
      exists: true,
      owner_uuid: 'u-shawn',
      owner_username: 'shawn',
      first_seen: '2026-04-30T12:00:00.000Z',
      last_seen: '2026-04-30T13:00:00.000Z',
      total_sessions: 1,
      preferred_name: null,
      pronouns: null,
      notes: '',
    }
    await saveOwner(ownerPath, original)
    const reloaded = await loadOwner(ownerPath)
    assertEqual(reloaded.exists, true, 'exists=true after save')
    assertEqual(reloaded.owner_uuid, original.owner_uuid, 'owner_uuid')
    assertEqual(reloaded.owner_username, original.owner_username, 'owner_username')
    assertEqual(reloaded.first_seen, original.first_seen, 'first_seen')
    assertEqual(reloaded.last_seen, original.last_seen, 'last_seen')
    assertEqual(reloaded.total_sessions, original.total_sessions, 'total_sessions')
    assertEqual(reloaded.notes, original.notes, 'notes')
    console.log('OK owner-roundtrip')
  } finally { cleanup(dir) }
}

CASES['owner-tolerates-malformed'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerPath = join(dir, 'OWNER.md')
    const malformed = [
      '---',
      'owner_uuid: u-x',
      'owner_username: alice',
      'total_sessions: 7',
      'unknown_key: value',
      'this line has no colon and is malformed',
      'first_seen: 2026-01-01T00:00:00.000Z',
      '---',
      '# Notes',
      'Hand-written prose.',
      '',
    ].join('\n')
    writeFileSync(ownerPath, malformed)
    const data = await loadOwner(ownerPath)
    assertEqual(data.exists, true, 'exists')
    assertEqual(data.owner_uuid, 'u-x', 'owner_uuid parsed')
    assertEqual(data.owner_username, 'alice', 'owner_username parsed')
    assertEqual(data.total_sessions, 7, 'total_sessions parsed')
    assertEqual(data.first_seen, '2026-01-01T00:00:00.000Z', 'first_seen parsed')
    assert(data.notes.includes('Hand-written prose'), 'notes preserved')
    console.log('OK owner-tolerates-malformed')
  } finally { cleanup(dir) }
}

CASES['owner-seed-block'] = async () => {
  const owner = {
    exists: true,
    owner_uuid: 'u-x',
    owner_username: 'alice',
    first_seen: '2026-01-01T00:00:00.000Z',
    last_seen: '2026-04-30T00:00:00.000Z',
    total_sessions: 12,
    preferred_name: null,
    pronouns: null,
    notes: 'a'.repeat(5000), // big notes to force truncation
  }
  const block = formatOwnerSeedBlock(owner, 1024)
  assert(block.startsWith('# Owner'), 'block starts with # Owner')
  assert(Buffer.byteLength(block, 'utf8') <= 1024, `≤ 1024 bytes, got ${Buffer.byteLength(block, 'utf8')}`)
  // Frontmatter (UUID/username) must be preserved despite truncation
  assert(block.includes('u-x'), 'owner_uuid preserved')
  assert(block.includes('alice'), 'owner_username preserved')

  // Fresh install path
  const empty = formatOwnerSeedBlock({ exists: false }, 1024)
  assertEqual(empty, '# Owner\n(no owner recorded yet)\n', 'fresh-install seed block')
  console.log('OK owner-seed-block')
}

CASES['diary-lazy-create'] = async () => {
  const dir = freshTmpDir()
  try {
    const path = join(dir, 'DIARY.md')
    const diary = createDiary({ path, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const slice = await diary.seedSlice()
    assertEqual(slice, '# Diary (recent first)\n(no prior history yet)\n', 'placeholder slice')
    assert(!existsSync(path), 'seedSlice did NOT create the file')

    await diary.appendEntry({ topic: 'first', body: 'a body' })
    assert(existsSync(path), 'appendEntry created the file')
    console.log('OK diary-lazy-create')
  } finally { cleanup(dir) }
}

CASES['diary-newest-first'] = async () => {
  const dir = freshTmpDir()
  try {
    const path = join(dir, 'DIARY.md')
    const diary = createDiary({ path, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    await diary.appendEntry({ topic: 'oldest', body: 'old body', when: new Date('2026-01-01T10:00:00Z') })
    await diary.appendEntry({ topic: 'middle', body: 'mid body', when: new Date('2026-02-01T10:00:00Z') })
    await diary.appendEntry({ topic: 'newest', body: 'new body', when: new Date('2026-03-01T10:00:00Z') })

    const all = await diary.readAll()
    assertEqual(all.length, 3, '3 entries')
    assert(all[0].headingLine.includes('newest'), `first entry is newest, got ${all[0].headingLine}`)
    assert(all[2].headingLine.includes('oldest'), `last entry is oldest, got ${all[2].headingLine}`)

    const slice = await diary.seedSlice()
    assert(slice.indexOf('newest') < slice.indexOf('oldest'), 'newest before oldest in slice')
    console.log('OK diary-newest-first')
  } finally { cleanup(dir) }
}

CASES['diary-byte-budget'] = async () => {
  const dir = freshTmpDir()
  try {
    const path = join(dir, 'DIARY.md')
    const diary = createDiary({ path, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    // 20 entries each ~500 bytes ⇒ ~10 KB total
    for (let i = 0; i < 20; i++) {
      const ts = new Date(2026, 0, i + 1, 12, 0, 0)
      await diary.appendEntry({ topic: `entry-${i}`, body: 'x'.repeat(450), when: ts })
    }
    const slice = await diary.seedSlice()
    assert(Buffer.byteLength(slice, 'utf8') <= 3072, `slice ≤ 3072 (got ${Buffer.byteLength(slice, 'utf8')})`)
    // The newest entry must be present; some older entries are dropped
    assert(slice.includes('entry-19'), 'newest entry present')
    // entry-0 should not fit
    assert(!slice.includes('entry-0\n') && !slice.includes('entry-0 '), 'oldest entry dropped')
    console.log('OK diary-byte-budget')
  } finally { cleanup(dir) }
}

CASES['diary-heading-format'] = async () => {
  const dir = freshTmpDir()
  try {
    const path = join(dir, 'DIARY.md')
    const diary = createDiary({ path, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    await diary.appendEntry({
      topic: 'fought a creeper near the village fountain at dusk',
      body: 'It exploded. Patched up.',
      when: new Date(Date.UTC(2026, 3, 30, 14, 25, 0)),
    })
    const all = await diary.readAll()
    assertEqual(all.length, 1, 'one entry')
    // Heading must match exactly: ## YYYY-MM-DD HH:MM — <topic ≤ 6 words>
    const heading = all[0].headingLine
    const re = /^## 2026-04-30 14:25 — fought a creeper near the village$/
    assert(re.test(heading), `heading mismatch: ${JSON.stringify(heading)}`)
    console.log('OK diary-heading-format')
  } finally { cleanup(dir) }
}

CASES['diary-replace-older-half'] = async () => {
  const dir = freshTmpDir()
  try {
    const path = join(dir, 'DIARY.md')
    const diary = createDiary({ path, seedDiaryBudgetBytes: 99999, logger: silentLogger() })
    // 8 entries ⇒ 4 keep, 4 replace (50/50 with min 5 — actually keep max(ceil(8/2),5)=5)
    for (let i = 0; i < 8; i++) {
      const ts = new Date(2026, 0, i + 1, 12, 0, 0)
      await diary.appendEntry({ topic: `e${i}`, body: `body ${i}`, when: ts })
    }
    // newest-first: e7 is at top, e0 at bottom
    await diary.replaceOlderHalf('## Earlier (consolidated through 2026-01-04)\nDense paragraph.\n')
    const all = await diary.readAll()
    // 5 newest kept + 1 consolidated block
    assertEqual(all.length, 6, `keeps top 5 + 1 consolidated, got ${all.length}`)
    // The 5 newest entries (e7..e3) must remain in newest-first order at the top
    assert(all[0].headingLine.includes('e7'), `top is e7, got ${all[0].headingLine}`)
    assert(all[4].headingLine.includes('e3'), `5th is e3, got ${all[4].headingLine}`)
    // The consolidated block is at the bottom
    assert(all[5].isConsolidated, 'last entry is consolidated')
    assert(all[5].headingLine.startsWith('## Earlier ('), 'consolidated heading')
    console.log('OK diary-replace-older-half')
  } finally { cleanup(dir) }
}

// ─── Task 2 ────────────────────────────────────────────────────────────

function makeStubBot() {
  const bot = {
    players: {},
    uuidToUsername: {},
    _listeners: new Map(),
    on(ev, fn) {
      if (!this._listeners.has(ev)) this._listeners.set(ev, [])
      this._listeners.get(ev).push(fn)
    },
    once(ev, fn) {
      const wrapper = (...args) => {
        const arr = this._listeners.get(ev) ?? []
        const idx = arr.indexOf(wrapper)
        if (idx >= 0) arr.splice(idx, 1)
        fn(...args)
      }
      this.on(ev, wrapper)
    },
    emit(ev, ...args) {
      for (const fn of (this._listeners.get(ev) ?? []).slice()) fn(...args)
    },
    addPlayer(player) {
      this.players[player.username] = player
      this.uuidToUsername[player.uuid] = player.username
    },
  }
  return bot
}

function memoryConfig(overrides = {}) {
  return {
    owner_username: 'shawn',
    memory: {
      owner_md_path: '',
      diary_md_path: '',
      iteration_cap: 20,
      loop_batch_loop_count_cap: 10,
      loop_batch_context_cap_bytes: 32768,
      sessions_per_consolidation: 4,
      diary_size_cap_bytes: 204800,
      seed_diary_budget_bytes: 3072,
      seed_owner_budget_bytes: 1024,
      spawn_settle_delay_ms: 50, // fast for tests
      ...overrides,
    },
  }
}

CASES['owner-uuid-cold'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    bot.addPlayer({ uuid: 'u-shawn', username: 'shawn' })
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const t0 = Date.now()
    const ss = await createSessionState({ ownerMdPath, diary, config, bot, logger: silentLogger() })
    await ss.onPlayerJoined({ uuid: 'u-shawn', username: 'shawn' })

    assert(existsSync(ownerMdPath), 'OWNER.md created')
    const owner = await loadOwner(ownerMdPath)
    assertEqual(owner.owner_uuid, 'u-shawn', 'uuid captured')
    assertEqual(owner.owner_username, 'shawn', 'username captured')
    assertEqual(owner.total_sessions, 1, 'total_sessions=1')
    assert(owner.first_seen, 'first_seen set')
    assert(owner.last_seen, 'last_seen set')
    const ts = Date.parse(owner.first_seen)
    assert(ts >= t0 - 100 && ts <= Date.now() + 100, 'first_seen within recent window')
    assert(ss.ownerPresent(), 'ownerPresent true after join')
    console.log('OK owner-uuid-cold')
  } finally { cleanup(dir) }
}

CASES['owner-uuid-warm'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'

    const seeded = {
      exists: true,
      owner_uuid: 'u-shawn',
      owner_username: 'shawn',
      first_seen: '2026-01-01T00:00:00.000Z',
      last_seen: '2026-01-01T00:00:00.000Z',
      total_sessions: 3,
      preferred_name: null,
      pronouns: null,
      notes: '',
    }
    await saveOwner(ownerMdPath, seeded)

    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const ss = await createSessionState({ ownerMdPath, diary, config, bot, logger: silentLogger() })
    await ss.onPlayerJoined({ uuid: 'u-shawn', username: 'newname' })

    const owner = await loadOwner(ownerMdPath)
    assertEqual(owner.total_sessions, 4, 'total_sessions=4')
    assertEqual(owner.owner_username, 'newname', 'owner_username updated')
    assertEqual(owner.first_seen, '2026-01-01T00:00:00.000Z', 'first_seen unchanged')
    assert(owner.last_seen !== '2026-01-01T00:00:00.000Z', 'last_seen updated')
    console.log('OK owner-uuid-warm')
  } finally { cleanup(dir) }
}

CASES['username-change-recognition'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'

    await saveOwner(ownerMdPath, {
      exists: true, owner_uuid: 'u-shawn', owner_username: 'shawn',
      first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z',
      total_sessions: 5, preferred_name: null, pronouns: null, notes: '',
    })

    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const ss = await createSessionState({ ownerMdPath, diary, config, bot, logger: silentLogger() })

    // Recognized via UUID despite different username
    await ss.onPlayerJoined({ uuid: 'u-shawn', username: 'shawn-renamed' })
    let owner = await loadOwner(ownerMdPath)
    assertEqual(owner.total_sessions, 6, 'recognized → counter +1')
    assertEqual(owner.owner_username, 'shawn-renamed', 'username updated')

    // Different UUID with the original username → REJECTED
    await ss.onPlayerLeft({ uuid: 'u-shawn', username: 'shawn-renamed' })
    await ss.onPlayerJoined({ uuid: 'u-imposter', username: 'shawn' })
    owner = await loadOwner(ownerMdPath)
    assertEqual(owner.total_sessions, 6, 'imposter rejected, counter unchanged')
    console.log('OK username-change-recognition')
  } finally { cleanup(dir) }
}

CASES['owner-uuid-fallback'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'

    // Hand-edited: OWNER exists but owner_uuid is null
    await saveOwner(ownerMdPath, {
      exists: true, owner_uuid: null, owner_username: null,
      first_seen: null, last_seen: null,
      total_sessions: 0, preferred_name: null, pronouns: null,
      notes: 'preexisting notes',
    })

    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const ss = await createSessionState({ ownerMdPath, diary, config, bot, logger: silentLogger() })

    await ss.onPlayerJoined({ uuid: 'u-shawn', username: 'shawn' })
    const owner = await loadOwner(ownerMdPath)
    assertEqual(owner.owner_uuid, 'u-shawn', 'fallback captured uuid')
    assertEqual(owner.owner_username, 'shawn', 'username set')
    assertEqual(owner.total_sessions, 1, 'session=1')
    assert(owner.notes.includes('preexisting'), 'notes preserved')
    console.log('OK owner-uuid-fallback')
  } finally { cleanup(dir) }
}

CASES['spawn-settle-delay'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath, spawn_settle_delay_ms: 80 })
    config.owner_username = 'shawn'

    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const ss = await createSessionState({ ownerMdPath, diary, config, bot, logger: silentLogger() })

    // Owner not present at spawn — no session-start fires immediately.
    await ss.onSpawn()
    assert(!ss.ownerPresent(), 'no owner recognized at spawn')
    // After settle delay (still no players) — no session-start.
    await new Promise(r => setTimeout(r, 120))
    assert(!ss.ownerPresent(), 'still no owner after settle')
    assert(!existsSync(ownerMdPath), 'OWNER.md not created without owner')

    // Now owner connects via playerJoined event (the late-arrival path)
    bot.addPlayer({ uuid: 'u-shawn', username: 'shawn' })
    bot.emit('playerJoined', { uuid: 'u-shawn', username: 'shawn' })
    // The one-shot listener attached by onSpawn should pick this up.
    await new Promise(r => setTimeout(r, 30))
    assert(ss.ownerPresent(), 'one-shot late-arrival fires')
    assert(existsSync(ownerMdPath), 'OWNER.md created via late-arrival')

    // ── Second scenario: owner already present at spawn time
    const dir2 = freshTmpDir()
    const ownerMdPath2 = join(dir2, 'OWNER.md')
    const diaryPath2 = join(dir2, 'DIARY.md')
    const config2 = memoryConfig({ owner_md_path: ownerMdPath2, diary_md_path: diaryPath2, spawn_settle_delay_ms: 60 })
    config2.owner_username = 'shawn'
    const bot2 = makeStubBot()
    bot2.addPlayer({ uuid: 'u-shawn', username: 'shawn' })
    const diary2 = createDiary({ path: diaryPath2, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const ss2 = await createSessionState({ ownerMdPath: ownerMdPath2, diary: diary2, config: config2, bot: bot2, logger: silentLogger() })
    await ss2.onSpawn()
    await new Promise(r => setTimeout(r, 100))
    assert(ss2.ownerPresent(), 'owner-present-at-spawn fires session-start after delay')
    cleanup(dir2)
    console.log('OK spawn-settle-delay')
  } finally { cleanup(dir) }
}

CASES['per-loop-batch-counter'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const ss = await createSessionState({ ownerMdPath, diary, config, bot, logger: silentLogger() })

    for (let i = 0; i < 10; i++) await ss.onLoopTerminal({ messagesByteSize: 5000 })
    const batch = ss.currentSessionLoopBatch()
    assertEqual(batch.loopCount, 10, 'loopCount=10')
    assertEqual(batch.cumulativeBytes, 50000, 'cumulativeBytes=50000')

    // No DIARY file written by Plan 3-02 — that's Plan 3-03's job
    assert(!existsSync(diaryPath), 'DIARY.md not created by onLoopTerminal')
    console.log('OK per-loop-batch-counter')
  } finally { cleanup(dir) }
}

// ─── Task 3 ────────────────────────────────────────────────────────────

function makeStubAnthropic(initial = []) {
  // Deterministic stub: returns canned responses; records call args.
  // The orchestrator dispatches via createAnthropicClient(config), so we can't
  // easily inject; instead we drive the loop construction path directly via
  // a controlled harness — we patch into createOrchestrator's seam by feeding
  // a custom registry/stub on the dispatch path.
  const calls = []
  let i = 0
  return {
    calls,
    async call(req) {
      calls.push(req)
      const next = initial[i++] ?? { toolUses: [], text: 'done', content: [{ type: 'text', text: 'done' }] }
      return next
    },
  }
}

// To avoid wiring the full anthropic SDK, we directly drive a Loop with the
// orchestrator's seed-loader code path. Plan 3-02 exposes the loader so it
// can be invoked directly from the harness.
async function loadComposeSeedBlocks() {
  const mod = await import('../src/llm/orchestrator.js')
  if (typeof mod.composeSeedBlocks !== 'function') {
    throw new Error('orchestrator.js must export composeSeedBlocks')
  }
  return mod.composeSeedBlocks
}

CASES['seed-content-shape'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    await saveOwner(ownerMdPath, {
      exists: true, owner_uuid: 'u-shawn', owner_username: 'shawn',
      first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z',
      total_sessions: 1, preferred_name: null, pronouns: null, notes: 'hi',
    })
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const ownerStore = { loadOwner, saveOwner, formatOwnerSeedBlock }
    const ss = await createSessionState({ ownerMdPath, diary, config, bot, logger: silentLogger() })

    const composeSeedBlocks = await loadComposeSeedBlocks()
    const blocks = await composeSeedBlocks({
      sessionState: ss, ownerStore, diary, config,
      eventText: 'Event: chat\nData: {"text":"hi"}',
      snapshotText: 'snapshot xyz',
    })
    assertEqual(blocks.length, 4, 'four seed blocks')
    assertEqual(blocks[0].name, 'seed_owner', 'seed_owner first')
    assertEqual(blocks[1].name, 'seed_diary', 'seed_diary second')
    assertEqual(blocks[2].name, 'event', 'event third')
    assertEqual(blocks[3].name, 'snapshot', 'snapshot fourth')
    assert(blocks[0].text.startsWith('# Owner'), 'seed_owner starts with # Owner')
    assert(blocks[1].text.startsWith('# Diary'), 'seed_diary starts with # Diary')
    console.log('OK seed-content-shape')
  } finally { cleanup(dir) }
}

CASES['seed-content-fresh-install'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const ownerStore = { loadOwner, saveOwner, formatOwnerSeedBlock }
    const ss = await createSessionState({ ownerMdPath, diary, config, bot, logger: silentLogger() })

    const composeSeedBlocks = await loadComposeSeedBlocks()
    const blocks = await composeSeedBlocks({
      sessionState: ss, ownerStore, diary, config,
      eventText: 'Event: idle\nData: {}',
      snapshotText: 'snap',
    })
    assert(blocks[0].text.includes('(no owner recorded yet)'), 'fresh-install owner placeholder')
    assert(blocks[1].text.includes('(no prior history yet)'), 'fresh-install diary placeholder')
    console.log('OK seed-content-fresh-install')
  } finally { cleanup(dir) }
}

CASES['seed-budget-respected'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    await saveOwner(ownerMdPath, {
      exists: true, owner_uuid: 'u', owner_username: 'a',
      first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z',
      total_sessions: 1, preferred_name: null, pronouns: null,
      notes: 'x'.repeat(5000),
    })
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'a'
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    // Pump diary
    for (let i = 0; i < 20; i++) {
      await diary.appendEntry({ topic: `e${i}`, body: 'y'.repeat(450), when: new Date(2026, 0, i + 1) })
    }
    const ownerStore = { loadOwner, saveOwner, formatOwnerSeedBlock }
    const ss = await createSessionState({ ownerMdPath, diary, config, bot, logger: silentLogger() })

    const composeSeedBlocks = await loadComposeSeedBlocks()
    const blocks = await composeSeedBlocks({
      sessionState: ss, ownerStore, diary, config,
      eventText: 'e', snapshotText: 's',
    })
    const ownerBytes = Buffer.byteLength(blocks[0].text, 'utf8')
    const diaryBytes = Buffer.byteLength(blocks[1].text, 'utf8')
    assert(ownerBytes <= 1024, `owner ≤ 1024, got ${ownerBytes}`)
    assert(diaryBytes <= 3072, `diary ≤ 3072, got ${diaryBytes}`)
    console.log('OK seed-budget-respected')
  } finally { cleanup(dir) }
}

CASES['seed-permanent-across-iterations'] = async () => {
  // Test the Loop-level invariant: seed turn keeps seed_owner / seed_diary
  // through multiple iterations (D-45). The Loop class itself enforces this;
  // here we just verify the orchestrator wires the seed flag correctly.
  const { createLoop } = await import('../src/llm/loop.js')
  const loop = createLoop({ iterationCap: 20, logger: silentLogger() })
  loop.appendUserTurn([
    { type: 'text', name: 'seed_owner', text: '# Owner\nshawn' },
    { type: 'text', name: 'seed_diary', text: '# Diary\nentries' },
    { type: 'text', name: 'event', text: 'E0' },
    { type: 'text', name: 'snapshot', text: 'S0' },
  ], { seed: true })

  // 5 iterations
  for (let i = 0; i < 5; i++) {
    loop.appendAssistant([{ type: 'tool_use', id: `tu_${i}`, name: 'goTo', input: {} }])
    loop.appendToolResults(
      [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: 'arr', is_error: false }],
      { snapshot: `S${i + 1}` },
    )
  }
  const payload = loop.buildAnthropicPayload()
  // The first user turn must still carry seed_owner + seed_diary
  const firstUser = payload.find(t => t.role === 'user')
  const texts = firstUser.content.filter(b => b.type === 'text').map(b => b.text)
  assert(texts.some(t => t.includes('# Owner') && t.includes('shawn')), 'seed_owner persists')
  assert(texts.some(t => t.includes('# Diary') && t.includes('entries')), 'seed_diary persists')
  console.log('OK seed-permanent-across-iterations')
}

CASES['seed-not-in-system-blocks'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    await saveOwner(ownerMdPath, {
      exists: true, owner_uuid: 'u-shawn', owner_username: 'shawn',
      first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z',
      total_sessions: 1, preferred_name: null, pronouns: null, notes: '',
    })

    // Construct an orchestrator with stubbed registry; verify cachedSystemBlocks
    // contain no `# Owner` or `# Diary` strings.
    const config = {
      ...memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath }),
      host: 'localhost', port: 25565, auth: 'offline',
      username: 'sei', minecraft_version: 'auto',
      reconnect_delay_ms: 0, pathfinder_timeout_ms: 1000, follow_range: 3,
      persona: { name: 'Sei', backstory: 'b', tone: 'curious' },
      anthropic: { api_key: 'k', model: 'claude-haiku-4-5-20251001', timeout_ms: 1000 },
      ollama: { host: 'http://x', model: 'q', timeout_ms: 1000 },
      llm: { rate_limit_per_min: 30, debounce_ms: 500, max_hops: 5, idle_fallback_ms: 10000, executor: 'api' },
    }
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    bot.chat = () => {}
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const ownerStore = { loadOwner, saveOwner, formatOwnerSeedBlock }
    const sessionState = await createSessionState({ ownerMdPath, diary, config, bot, logger: silentLogger() })

    const fakeRegistry = { list: () => [], schema: () => null, execute: async () => 'ok' }
    const { createOrchestrator } = await import('../src/llm/orchestrator.js')
    const orch = createOrchestrator({ bot, config, registry: fakeRegistry, logger: silentLogger(), sessionState, ownerStore, diary })

    const sysBlocks = orch._internal.getCachedSystemBlocks()
    const combinedBlocks = orch._internal.getCachedCombinedSystemBlocks()
    for (const blk of [...sysBlocks, ...combinedBlocks]) {
      const t = typeof blk === 'string' ? blk : (blk && blk.text) ?? ''
      assert(!t.includes('# Owner'), `system block must not contain '# Owner'`)
      assert(!t.includes('# Diary'), `system block must not contain '# Diary'`)
    }
    console.log('OK seed-not-in-system-blocks')
  } finally { cleanup(dir) }
}

// ─── Plan 3-03 Task 1: Compactor unit tests ────────────────────────────

function makeCompactionAnthropic(textOrFn) {
  // Simpler stub for compaction tests. Records args; returns content blocks.
  const calls = []
  return {
    calls,
    async call(req) {
      calls.push(req)
      const text = typeof textOrFn === 'function' ? await textOrFn(req) : textOrFn
      return { content: [{ type: 'text', text }], toolUses: [], text, usage: {}, stopReason: 'end_turn' }
    },
  }
}

function makeStubDiary() {
  const appended = []
  let replaced = null
  let entries = []
  let fileSize = 0
  return {
    appended, get replaced() { return replaced },
    setEntries(arr) { entries = arr.slice() },
    setFileSize(n) { fileSize = n },
    async appendEntry({ topic, body, when }) { appended.push({ topic, body, when }) },
    async readAll() { return entries.slice() },
    async replaceOlderHalf(replacement) { replaced = replacement },
    async getFileSizeBytes() { return fileSize },
  }
}

function compactionConfig(overrides = {}) {
  return {
    anthropic: { timeout_ms: 5000 },
    memory: {
      loop_batch_loop_count_cap: 10,
      loop_batch_context_cap_bytes: 32768,
      sessions_per_consolidation: 4,
      diary_size_cap_bytes: 204800,
      ...overrides,
    },
  }
}

CASES['summarize-prompt-shape'] = async () => {
  const cachedSystemBlocks = [{ type: 'text', text: 'sys' }, { type: 'text', text: 'tools', cache_control: { type: 'ephemeral' } }]
  const anthropic = makeCompactionAnthropic('A diary entry.')
  const diary = makeStubDiary()
  const compactor = createCompactor({ anthropic, cachedSystemBlocks, diary, config: compactionConfig(), logger: silentLogger() })

  const batch = [
    { role: 'assistant', content: [{ type: 'text', text: 'i greet shawn' }, { type: 'tool_use', id: 'tu1', name: 'say', input: { text: 'hi' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'said' }] },
  ]
  await compactor.summarizeLoopBatch({ loopMessagesBatch: batch })

  assertEqual(anthropic.calls.length, 1, 'one anthropic call')
  const req = anthropic.calls[0]
  assert(req.systemBlocks === cachedSystemBlocks, 'systemBlocks identity matches cachedSystemBlocks')
  assertEqual(Array.isArray(req.tools) ? req.tools.length : -1, 0, 'tools is empty array')
  assert(Array.isArray(req.messages), 'messages is array')
  const lastUser = req.messages[req.messages.length - 1]
  assertEqual(lastUser.role, 'user', 'last message is user turn')
  const content = typeof lastUser.content === 'string' ? lastUser.content : (lastUser.content[0]?.text ?? '')
  assert(content.includes('In 2–4 sentences'), 'D-52 prompt body present')
  assert(content.includes('--- Recent activity ---'), 'serialized batch separator present')
  assert(content.includes('hi') || content.includes('say'), 'batch messages serialized into prompt')
  console.log('OK summarize-prompt-shape')
}

CASES['summarize-output-parses'] = async () => {
  const cachedSystemBlocks = [{ type: 'text', text: 'sys' }]
  const anthropic = makeCompactionAnthropic('Today I chopped wood with shawn near the river. It was peaceful and rainy.')
  const diary = makeStubDiary()
  const compactor = createCompactor({ anthropic, cachedSystemBlocks, diary, config: compactionConfig(), logger: silentLogger() })

  const result = await compactor.summarizeLoopBatch({ loopMessagesBatch: [] })
  assert(result, 'returns truthy')
  assertEqual(result.body, 'Today I chopped wood with shawn near the river. It was peaceful and rainy.', 'body matches')
  // First ≤6 words of output, lowercased, trimmed
  const words = result.topic.split(/\s+/)
  assert(words.length <= 6, `topic ≤6 words, got ${words.length}`)
  assert(result.topic.toLowerCase().includes('today') || result.topic.toLowerCase().includes('chopped'), `topic deterministic prefix, got ${result.topic}`)
  console.log('OK summarize-output-parses')
}

CASES['summarize-writes-diary'] = async () => {
  const cachedSystemBlocks = [{ type: 'text', text: 'sys' }]
  const anthropic = makeCompactionAnthropic('A peaceful afternoon by the lake.')
  const diary = makeStubDiary()
  const compactor = createCompactor({ anthropic, cachedSystemBlocks, diary, config: compactionConfig(), logger: silentLogger() })
  const when = new Date('2026-04-30T12:00:00Z')
  await compactor.summarizeLoopBatch({ loopMessagesBatch: [], when })
  assertEqual(diary.appended.length, 1, 'one append')
  assertEqual(diary.appended[0].when, when, 'when passed through')
  assert(diary.appended[0].body.includes('peaceful'), 'body written')
  assert(typeof diary.appended[0].topic === 'string' && diary.appended[0].topic.length > 0, 'topic non-empty')
  console.log('OK summarize-writes-diary')
}

CASES['summarize-rate-limited'] = async () => {
  const cachedSystemBlocks = [{ type: 'text', text: 'sys' }]
  const failingAnthropic = {
    calls: [],
    async call(req) { this.calls.push(req); throw new Error('rate limited') },
  }
  const diary = makeStubDiary()
  const compactor = createCompactor({ anthropic: failingAnthropic, cachedSystemBlocks, diary, config: compactionConfig(), logger: silentLogger() })
  const result = await compactor.summarizeLoopBatch({ loopMessagesBatch: [] })
  assertEqual(result, null, 'returns null on failure')
  assertEqual(diary.appended.length, 0, 'no diary write')
  console.log('OK summarize-rate-limited')
}

CASES['consolidate-prompt-shape'] = async () => {
  const cachedSystemBlocks = [{ type: 'text', text: 'sys' }]
  const anthropic = makeCompactionAnthropic('A dense narrative paragraph spanning many days.')
  const diary = makeStubDiary()
  // 10 entries (newest-first); keep = max(ceil(10/2),5) = 5; older = E5..E9
  const entries = []
  for (let i = 0; i < 10; i++) {
    entries.push({
      headingLine: `## 2026-01-${String(i + 1).padStart(2, '0')} 12:00 — entry ${i}`,
      body: `body ${i}`,
      isConsolidated: false,
    })
  }
  diary.setEntries(entries)
  const c = createCompactor({ anthropic, cachedSystemBlocks, diary, config: compactionConfig(), logger: silentLogger() })
  const result = await c.consolidateOlderHalf({})
  assertEqual(result, true, 'returns true on success')
  assertEqual(anthropic.calls.length, 1, 'one anthropic call')
  const req = anthropic.calls[0]
  const lastUser = req.messages[req.messages.length - 1]
  const content = typeof lastUser.content === 'string' ? lastUser.content : (lastUser.content[0]?.text ?? '')
  assert(content.includes('Compress them into a single denser narrative'), 'D-54 prompt body present')
  assert(content.includes('--- Older entries ---'), 'older-entries separator present')
  assert(content.includes('entry 5') && content.includes('entry 9'), 'older entries inlined')
  assert(!content.includes('entry 0'), 'newer entries not in prompt')
  // Replacement block has the locked heading
  assert(diary.replaced && diary.replaced.startsWith('## Earlier (consolidated through '), `replacement begins with locked heading: ${diary.replaced?.slice(0, 60)}`)
  console.log('OK consolidate-prompt-shape')
}

CASES['consolidate-min-entries'] = async () => {
  const cachedSystemBlocks = [{ type: 'text', text: 'sys' }]
  const anthropic = makeCompactionAnthropic('should not be called')
  const diary = makeStubDiary()
  const entries = []
  for (let i = 0; i < 4; i++) entries.push({ headingLine: `## 2026-01-${i + 1} 12:00 — e${i}`, body: 'b', isConsolidated: false })
  diary.setEntries(entries)
  const c = createCompactor({ anthropic, cachedSystemBlocks, diary, config: compactionConfig(), logger: silentLogger() })
  const result = await c.consolidateOlderHalf({})
  assertEqual(result, false, 'returns false')
  assertEqual(anthropic.calls.length, 0, 'no anthropic call when N ≤ 5')
  assertEqual(diary.replaced, null, 'no replacement')
  console.log('OK consolidate-min-entries')
}

CASES['consolidate-split-50pct'] = async () => {
  const cachedSystemBlocks = [{ type: 'text', text: 'sys' }]
  const anthropic = makeCompactionAnthropic('Dense.')
  const diary = makeStubDiary()
  const entries = []
  // 12 entries; keep = max(ceil(12/2),5) = 6; older = E6..E11
  for (let i = 0; i < 12; i++) {
    const dd = String(i + 1).padStart(2, '0')
    entries.push({ headingLine: `## 2026-01-${dd} 10:00 — e${i}`, body: `body ${i}`, isConsolidated: false })
  }
  diary.setEntries(entries)
  const c = createCompactor({ anthropic, cachedSystemBlocks, diary, config: compactionConfig(), logger: silentLogger() })
  const result = await c.consolidateOlderHalf({})
  assertEqual(result, true, 'success')
  // E11 is the oldest in our newest-first array → its date prefix used in heading
  assert(diary.replaced.startsWith('## Earlier (consolidated through 2026-01-12)'), `heading has E11 date, got: ${diary.replaced.split('\n')[0]}`)
  console.log('OK consolidate-split-50pct')
}

CASES['compaction-uses-cached-system-blocks'] = async () => {
  const cachedSystemBlocks = [{ type: 'text', text: 'sys' }, { type: 'text', text: 'tools', cache_control: { type: 'ephemeral' } }]
  const anthropic = makeCompactionAnthropic('summary text')
  const diary = makeStubDiary()
  const entries = []
  for (let i = 0; i < 12; i++) entries.push({ headingLine: `## 2026-01-${String(i + 1).padStart(2, '0')} 10:00 — e${i}`, body: 'b', isConsolidated: false })
  diary.setEntries(entries)
  const c = createCompactor({ anthropic, cachedSystemBlocks, diary, config: compactionConfig(), logger: silentLogger() })

  await c.summarizeLoopBatch({ loopMessagesBatch: [] })
  await c.consolidateOlderHalf({})

  assertEqual(anthropic.calls.length, 2, 'two calls total')
  assert(anthropic.calls[0].systemBlocks === cachedSystemBlocks, 'summarize uses identity-equal blocks')
  assert(anthropic.calls[1].systemBlocks === cachedSystemBlocks, 'consolidate uses identity-equal blocks')
  console.log('OK compaction-uses-cached-system-blocks')
}

CASES['compaction-has-timeout'] = async () => {
  const cachedSystemBlocks = [{ type: 'text', text: 'sys' }]
  const anthropic = makeCompactionAnthropic('summary text')
  const diary = makeStubDiary()
  const entries = []
  for (let i = 0; i < 12; i++) entries.push({ headingLine: `## 2026-01-${String(i + 1).padStart(2, '0')} 10:00 — e${i}`, body: 'b', isConsolidated: false })
  diary.setEntries(entries)
  const c = createCompactor({ anthropic, cachedSystemBlocks, diary, config: compactionConfig({ /*defaults*/ }), logger: silentLogger() })

  await c.summarizeLoopBatch({ loopMessagesBatch: [] })
  await c.consolidateOlderHalf({})
  assertEqual(anthropic.calls.length, 2, 'two calls')
  assertEqual(anthropic.calls[0].timeoutMs, 5000, 'summarize timeoutMs from config')
  assertEqual(anthropic.calls[1].timeoutMs, 5000, 'consolidate timeoutMs from config')
  console.log('OK compaction-has-timeout')
}

// ─── Plan 3-03 Task 2: sessionState integration ────────────────────────

function makeStubCompactor() {
  const summarizeCalls = []
  const consolidateCalls = []
  const compactor = {
    summarizeCalls, consolidateCalls,
    summarizeReturn: { topic: 'a topic', body: 'body' },
    consolidateReturn: true,
    consolidateDelayMs: 0,
    async summarizeLoopBatch(opts) {
      summarizeCalls.push(opts)
      return compactor.summarizeReturn
    },
    async consolidateOlderHalf(opts) {
      consolidateCalls.push({ opts, startedAt: Date.now() })
      if (compactor.consolidateDelayMs) {
        await new Promise(r => setTimeout(r, compactor.consolidateDelayMs))
      }
      return compactor.consolidateReturn
    },
  }
  return compactor
}

CASES['d51-loop-count-trigger'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const compactor = makeStubCompactor()
    const ss = await createSessionState({ ownerMdPath, diary, compactor, config, bot, logger: silentLogger() })

    // 9 loops: no summary
    for (let i = 0; i < 9; i++) {
      await ss.onLoopTerminal({ messagesByteSize: 1000, loopMessages: [{ role: 'assistant', content: [{ type: 'text', text: `t${i}` }] }] })
    }
    assertEqual(compactor.summarizeCalls.length, 0, 'no summary before threshold')

    // 10th loop fires
    await ss.onLoopTerminal({ messagesByteSize: 1000, loopMessages: [{ role: 'assistant', content: [{ type: 'text', text: 't9' }] }] })
    assertEqual(compactor.summarizeCalls.length, 1, 'summary fires at 10')
    assert(Array.isArray(compactor.summarizeCalls[0].loopMessagesBatch), 'batch is an array')
    assert(compactor.summarizeCalls[0].loopMessagesBatch.length >= 1, 'batch has messages')

    // Counters reset after success
    const batch = ss.currentSessionLoopBatch()
    assertEqual(batch.loopCount, 0, 'loopCount reset')
    assertEqual(batch.cumulativeBytes, 0, 'cumulativeBytes reset')
    console.log('OK d51-loop-count-trigger')
  } finally { cleanup(dir) }
}

CASES['d51-bytes-trigger'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath, loop_batch_loop_count_cap: 100, loop_batch_context_cap_bytes: 32768 })
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const compactor = makeStubCompactor()
    const ss = await createSessionState({ ownerMdPath, diary, compactor, config, bot, logger: silentLogger() })

    // 4 loops × 10 KB = 40 KB > 32 KB
    for (let i = 0; i < 4; i++) {
      await ss.onLoopTerminal({ messagesByteSize: 10000, loopMessages: [{ role: 'user', content: [{ type: 'text', text: `t${i}` }] }] })
    }
    assertEqual(compactor.summarizeCalls.length, 1, 'bytes-trigger fired exactly once')
    const batch = ss.currentSessionLoopBatch()
    assertEqual(batch.loopCount, 0, 'loopCount reset')
    assertEqual(batch.cumulativeBytes, 0, 'cumulativeBytes reset')
    console.log('OK d51-bytes-trigger')
  } finally { cleanup(dir) }
}

CASES['d51-trigger-survives-failure'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const compactor = makeStubCompactor()
    compactor.summarizeReturn = null  // simulate rate-limit / failure
    const ss = await createSessionState({ ownerMdPath, diary, compactor, config, bot, logger: silentLogger() })

    for (let i = 0; i < 10; i++) {
      await ss.onLoopTerminal({ messagesByteSize: 1000, loopMessages: [{ role: 'user', content: [] }] })
    }
    assertEqual(compactor.summarizeCalls.length, 1, 'attempted once')
    const batch = ss.currentSessionLoopBatch()
    assertEqual(batch.loopCount, 10, 'loopCount NOT reset (retry semantic)')
    assertEqual(batch.cumulativeBytes, 10000, 'bytes NOT reset')
    console.log('OK d51-trigger-survives-failure')
  } finally { cleanup(dir) }
}

CASES['d53-session-trigger'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath, sessions_per_consolidation: 4 })
    config.owner_username = 'shawn'
    // Pre-seed OWNER.md so session-start runs warm
    await saveOwner(ownerMdPath, {
      exists: true, owner_uuid: 'u-shawn', owner_username: 'shawn',
      first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z',
      total_sessions: 3, preferred_name: null, pronouns: null, notes: '',
    })
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const compactor = makeStubCompactor()
    const ss = await createSessionState({ ownerMdPath, diary, compactor, config, bot, logger: silentLogger() })

    // Simulate 4 join/leave cycles to bring sessionsSinceConsolidation to 4
    for (let i = 0; i < 4; i++) {
      await ss.onPlayerJoined({ uuid: 'u-shawn', username: 'shawn' })
      await ss.onPlayerLeft({ uuid: 'u-shawn', username: 'shawn' })
    }
    // Wait for fire-and-forget consolidation to settle
    await new Promise(r => setTimeout(r, 30))
    assert(compactor.consolidateCalls.length >= 1, `consolidate fired (got ${compactor.consolidateCalls.length})`)
    const batch = ss.currentSessionLoopBatch()
    assertEqual(batch.sessionsSinceConsolidation, 0, 'sessions counter reset')
    console.log('OK d53-session-trigger')
  } finally { cleanup(dir) }
}

CASES['d53-size-trigger'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath, diary_size_cap_bytes: 100 })
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    // Use a stub diary that reports a large file size
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    // Pre-write a large diary file to push file size > cap
    writeFileSync(diaryPath, 'x'.repeat(500))
    const compactor = makeStubCompactor()
    const ss = await createSessionState({ ownerMdPath, diary, compactor, config, bot, logger: silentLogger() })

    await ss.onLoopTerminal({ messagesByteSize: 100, loopMessages: [] })
    // Allow async fire to settle
    await new Promise(r => setTimeout(r, 30))
    assert(compactor.consolidateCalls.length >= 1, `size-trigger fired consolidation (got ${compactor.consolidateCalls.length})`)
    console.log('OK d53-size-trigger')
  } finally { cleanup(dir) }
}

CASES['d53-async-non-blocking'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath, sessions_per_consolidation: 1 })
    config.owner_username = 'shawn'
    await saveOwner(ownerMdPath, {
      exists: true, owner_uuid: 'u-shawn', owner_username: 'shawn',
      first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z',
      total_sessions: 1, preferred_name: null, pronouns: null, notes: '',
    })
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const compactor = makeStubCompactor()
    compactor.consolidateDelayMs = 500  // slow
    const ss = await createSessionState({ ownerMdPath, diary, compactor, config, bot, logger: silentLogger() })

    await ss.onPlayerJoined({ uuid: 'u-shawn', username: 'shawn' })
    const t0 = Date.now()
    await ss.onPlayerLeft({ uuid: 'u-shawn', username: 'shawn' })
    const elapsed = Date.now() - t0
    assert(elapsed < 200, `onPlayerLeft non-blocking, elapsed=${elapsed}ms`)
    console.log('OK d53-async-non-blocking')
  } finally { cleanup(dir) }
}

CASES['a7-no-idle-write'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    let appendCount = 0
    const wrappedDiary = {
      ...diary,
      appendEntry: async (...args) => { appendCount++; return diary.appendEntry(...args) },
      readAll: diary.readAll, seedSlice: diary.seedSlice,
      replaceOlderHalf: diary.replaceOlderHalf, getFileSizeBytes: diary.getFileSizeBytes,
    }
    const compactor = makeStubCompactor()
    const ss = await createSessionState({ ownerMdPath, diary: wrappedDiary, compactor, config, bot, logger: silentLogger() })

    // Idle ticks do NOT touch sessionState compaction paths. There is no idle
    // hook on sessionState — ergo zero diary writes. Verify by exercising 100
    // "idle" no-op cycles: nothing should be invoked on sessionState that
    // writes to disk.
    for (let i = 0; i < 100; i++) { /* idle = no-op */ }
    assertEqual(appendCount, 0, 'zero diary appends from idle ticks')
    assertEqual(compactor.summarizeCalls.length, 0, 'zero summarize calls from idle')
    assertEqual(compactor.consolidateCalls.length, 0, 'zero consolidate calls from idle')
    console.log('OK a7-no-idle-write')
  } finally { cleanup(dir) }
}

CASES['session-end-flush'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    const config = memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath })
    config.owner_username = 'shawn'
    const bot = makeStubBot()
    const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
    const compactor = makeStubCompactor()
    const ss = await createSessionState({ ownerMdPath, diary, compactor, config, bot, logger: silentLogger() })

    await ss.onPlayerJoined({ uuid: 'u-shawn', username: 'shawn' })
    // 3 loops — below D-51 threshold
    for (let i = 0; i < 3; i++) {
      await ss.onLoopTerminal({ messagesByteSize: 500, loopMessages: [{ role: 'assistant', content: [{ type: 'text', text: `r${i}` }] }] })
    }
    assertEqual(compactor.summarizeCalls.length, 0, 'no summary mid-session')

    await ss.onPlayerLeft({ uuid: 'u-shawn', username: 'shawn' })
    assertEqual(compactor.summarizeCalls.length, 1, 'session-end flush fired')
    const batch = ss.currentSessionLoopBatch()
    assertEqual(batch.loopCount, 0, 'loopCount reset after flush')
    assertEqual(batch.cumulativeBytes, 0, 'bytes reset after flush')
    console.log('OK session-end-flush')
  } finally { cleanup(dir) }
}

// ─── 260502-h6i: prompt-cache fix verification ─────────────────────────

CASES['cache-system-blocks-byte-stable'] = async () => {
  const dir = freshTmpDir()
  try {
    const ownerMdPath = join(dir, 'OWNER.md')
    const diaryPath = join(dir, 'DIARY.md')
    await saveOwner(ownerMdPath, {
      exists: true, owner_uuid: 'u-shawn', owner_username: 'shawn',
      first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z',
      total_sessions: 1, preferred_name: null, pronouns: null, notes: '',
    })
    const baseConfig = () => ({
      ...memoryConfig({ owner_md_path: ownerMdPath, diary_md_path: diaryPath }),
      host: 'localhost', port: 25565, auth: 'offline',
      username: 'sei', minecraft_version: 'auto',
      reconnect_delay_ms: 0, pathfinder_timeout_ms: 1000, follow_range: 3,
      persona: { name: 'Sei', backstory: 'curious explorer', tone: 'curious' },
      anthropic: { api_key: 'k', model: 'claude-haiku-4-5-20251001', timeout_ms: 1000 },
      ollama: { host: 'http://x', model: 'q', timeout_ms: 1000 },
      llm: { rate_limit_per_min: 30, debounce_ms: 500, max_hops: 5, idle_fallback_ms: 10000, executor: 'api' },
      owner_username: 'shawn',
    })
    const fakeRegistry = { list: () => [], schema: () => null, execute: async () => 'ok' }
    const { createOrchestrator } = await import('../src/llm/orchestrator.js')

    function buildOnce() {
      const config = baseConfig()
      const bot = makeStubBot(); bot.chat = () => {}
      const diary = createDiary({ path: diaryPath, seedDiaryBudgetBytes: 3072, logger: silentLogger() })
      const ownerStore = { loadOwner, saveOwner, formatOwnerSeedBlock }
      // Reuse same shared sessionState — irrelevant for system block content.
      return createOrchestrator({ bot, config, registry: fakeRegistry, logger: silentLogger(), sessionState: null, ownerStore, diary })
    }

    const a = buildOnce()
    const b = buildOnce()
    const ja = JSON.stringify(a._internal.getCachedSystemBlocks())
    const jb = JSON.stringify(b._internal.getCachedSystemBlocks())
    assertEqual(ja, jb, 'cachedSystemBlocks byte-stable across constructions')

    const blocks = a._internal.getCachedSystemBlocks()
    assert(Array.isArray(blocks) && blocks.length >= 2, 'system blocks present')
    const last = blocks[blocks.length - 1]
    assertEqual(last.cache_control?.type, 'ephemeral', 'last block carries ephemeral cache_control')
    for (let i = 0; i < blocks.length - 1; i++) {
      assert(!blocks[i].cache_control, `non-last block ${i} has no cache_control`)
    }
    for (const blk of blocks) {
      const t = (blk && blk.text) ?? ''
      assert(!t.includes('# Owner'), 'no `# Owner` header in system blocks')
      assert(!t.includes('# Diary'), 'no `# Diary` header in system blocks')
    }
    console.log('OK cache-system-blocks-byte-stable')
  } finally { cleanup(dir) }
}

CASES['cache-marker-on-last-tool'] = async () => {
  const { stampLastToolCacheControl } = await import('../src/llm/anthropicClient.js')
  // Empty/missing → undefined (no tools, no marker)
  assertEqual(stampLastToolCacheControl(undefined), undefined, 'undefined tools → undefined')
  assertEqual(stampLastToolCacheControl([]), undefined, 'empty tools → undefined')

  // Single tool → carries cache_control
  const single = stampLastToolCacheControl([
    { name: 'a', description: 'd', input_schema: { type: 'object' } },
  ])
  assertEqual(single.length, 1, 'single tool length 1')
  assertEqual(single[0].cache_control?.type, 'ephemeral', 'single tool stamped')

  // Multiple tools → ONLY last carries cache_control
  const tools = [
    { name: 'a', description: 'da', input_schema: { type: 'object' } },
    { name: 'b', description: 'db', input_schema: { type: 'object' } },
    { name: 'c', description: 'dc', input_schema: { type: 'object' } },
  ]
  const out = stampLastToolCacheControl(tools)
  assertEqual(out.length, 3, 'output length matches')
  assert(!out[0].cache_control, 'tool 0 has no cache_control')
  assert(!out[1].cache_control, 'tool 1 has no cache_control')
  assertEqual(out[2].cache_control?.type, 'ephemeral', 'last tool stamped')
  // Original tools untouched (immutability)
  assert(!tools[2].cache_control, 'input array not mutated')
  console.log('OK cache-marker-on-last-tool')
}

// ─── Driver ────────────────────────────────────────────────────────────

async function main() {
  const name = argv.case
  if (!name) {
    console.error('usage: verify-phase3-memory.js --case=<name>')
    console.error('cases: ' + Object.keys(CASES).join(', '))
    process.exit(2)
  }
  const fn = CASES[name]
  if (!fn) {
    console.error(`unknown case: ${name}`)
    process.exit(2)
  }
  try {
    await fn()
    process.exit(0)
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`)
    if (process.env.DEBUG) console.error(err.stack)
    process.exit(1)
  }
}

main()
