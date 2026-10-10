// Tests for the per-session action outcome aggregator (261011).
import { describe, it, expect } from 'vitest'
import {
  createActionStats,
  classifyActionOutcome,
  classifyResultText,
  classifyLlmError,
  llmMetaFromConfig,
  FAIL_REASONS,
  UNANSWERED_MS,
} from './actionStats.js'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('classifyResultText (real behavior result strings)', () => {
  const cases = [
    ['reached', null],
    ['dug oak_log', null],
    ['crafted 4 oak_planks', null],
    ['follow Steve interrupted (still trailing them)', null],
    ['sign: "you cannot pass, timeout failed"', null],
    ['gathered 16/16 oak_log', null],
    ['gathered 3/16 oak_log (no more oak_log reachable nearby)', 'partial'],
    ['gathered 0/16 oak_log', 'target_not_found'],
    ['dug 2/5 stone', 'partial'],
    ['aborted', 'aborted_by_preempt'],
    ['aborted after 3/10', 'aborted_by_preempt'],
    ['built shelter (aborted before capping)', 'aborted_by_preempt'],
    ['timeout', 'timeout'],
    ['timeout placing dirt', 'timeout'],
    ['cant_reach (closest=4.2m to target 1,2,3)', 'no_path'],
    ['timeout — unreachable — try build to Y=70', 'timeout'],
    ['out of range (5.1m, need ≤4.5) for oak_log @1,2,3', 'no_path'],
    ["couldn't place dirt — no open spot in reach. Step somewhere more open", 'no_path'],
    ['no cobblestone in inventory', 'missing_materials'],
    ['you only have 3 dirt, and that span needs 9', 'missing_materials'],
    ['built 4 of ~9 needed, then ran out of dirt. Gather more', 'missing_materials'],
    ["can't craft furnace here — it needs a crafting table. Go to a crafting table", 'missing_materials'],
    ['dug stone (no drop — you have no tool that can harvest stone; craft a pickaxe)', 'missing_materials'],
    ['no oak_log in loaded chunks within 64m', 'target_not_found'],
    ['no such player: Alex', 'target_not_found'],
    ['target gone', 'target_not_found'],
    ['no furnace open', 'target_not_found'],
    ['built 5 placed, 4 cells FAILED (could not reach o', 'partial'],
    ['built NOTHING: all 9 cells were already occupied', 'partial'],
    ['cannot sleep during day', 'refused'],
    ['busy surviving — try again in a moment', 'refused'],
    ['food bar full', 'refused'],
  ]
  for (const [text, want] of cases) {
    it(`${JSON.stringify(text)} -> ${want}`, () => {
      expect(classifyResultText(text)).toBe(want)
    })
  }
})

describe('classifyActionOutcome', () => {
  it('maps thrown errors', () => {
    expect(classifyActionOutcome({ error: new Error('boom') })).toBe('error')
    expect(classifyActionOutcome({ error: new Error('boom'), aborted: true })).toBe('aborted_by_preempt')
    const abort = new Error('x'); abort.name = 'AbortError'
    expect(classifyActionOutcome({ error: abort })).toBe('aborted_by_preempt')
    const zod = new Error('bad'); zod.name = 'ZodError'
    expect(classifyActionOutcome({ error: zod })).toBe('bad_args')
    expect(classifyActionOutcome({ error: new Error("Unknown action: 'fly'") })).toBe('bad_args')
    expect(classifyActionOutcome({ error: new Error('path timed out') })).toBe('timeout')
  })
  it('maps structured results', () => {
    expect(classifyActionOutcome({ result: { found: true, id: 'oak_log' } })).toBe(null)
    expect(classifyActionOutcome({ result: { found: false, reason: 'no oak_log in loaded chunks within 64m' } })).toBe('target_not_found')
    expect(classifyActionOutcome({ result: { ok: false, reason: 'cant_see' } })).toBe('error')
    expect(classifyActionOutcome({ result: { ok: true } })).toBe(null)
    expect(classifyActionOutcome({ result: { skip: true } })).toBe(null)
    expect(classifyActionOutcome({ result: undefined })).toBe(null)
  })
  it('a completed result wins over a late abort flag', () => {
    expect(classifyActionOutcome({ result: 'dug oak_log', aborted: true })).toBe(null)
  })
})

describe('classifyLlmError', () => {
  it('classes by status and timeout', () => {
    expect(classifyLlmError({ status: 429 })).toBe('429')
    expect(classifyLlmError({ status: 401 })).toBe('401')
    expect(classifyLlmError({ status: 402 })).toBe('402')
    expect(classifyLlmError({ status: 503 })).toBe('5xx')
    expect(classifyLlmError({ isTimeout: true, name: 'AbortError' })).toBe('timeout')
    expect(classifyLlmError(new Error('socket hang up'))).toBe('other')
  })
})

describe('createActionStats', () => {
  it('aggregates attempts, successes, failures by reason and duration per action', () => {
    const c = clock()
    const s = createActionStats({ now: c.now })
    s.recordAction('gather', 1200, null)
    s.recordAction('gather', 800, 'partial')
    s.recordAction('gather', 50, 'no_path')
    s.recordAction('goTo', 12000, 'no_path')
    const snap = s.snapshot()
    expect(snap.actions.gather).toEqual({ n: 3, ok: 1, fail: 2, ms: 2050, reasons: { partial: 1, no_path: 1 } })
    expect(snap.actions.goTo).toEqual({ n: 1, ok: 0, fail: 1, ms: 12000, reasons: { no_path: 1 } })
  })

  it('never stores a non-identifier action name or an unknown reason', () => {
    const s = createActionStats()
    s.recordAction('say "hi Steve" at 1,2,3', 10, null)
    s.recordAction('dig', 10, 'player said something rude')
    const snap = s.snapshot()
    expect(Object.keys(snap.actions).sort()).toEqual(['dig', 'other'])
    expect(snap.actions.dig.reasons).toEqual({ error: 1 })
    for (const a of Object.values(snap.actions)) {
      for (const r of Object.keys(a.reasons)) expect(FAIL_REASONS).toContain(r)
    }
  })

  it('counts turn-level signals and LLM errors by class', () => {
    const s = createActionStats()
    s.noteLlmTurn({ said: true })
    s.noteLlmTurn({ said: false })
    s.noteLlmTurn({ said: false })
    s.noteLlmError({ status: 429 })
    s.noteLlmError({ status: 429 })
    s.noteLlmError({ isTimeout: true })
    s.noteStuck()
    s.noteDeath()
    const snap = s.snapshot()
    expect(snap.counters).toMatchObject({ llm_turns: 3, say_turns: 1, silent_turns: 2, stuck: 1, deaths: 1 })
    expect(snap.llm_errors).toEqual({ 429: 2, timeout: 1 })
  })

  it('a player line with no reply and no action for 20s counts as unanswered', () => {
    const c = clock()
    const s = createActionStats({ now: c.now })
    s.notePlayerChat()
    c.advance(UNANSWERED_MS - 1)
    expect(s.snapshot().counters.unanswered).toBe(0)
    c.advance(1)
    const snap = s.snapshot()
    expect(snap.counters).toMatchObject({ player_msgs: 1, unanswered: 1, replied: 0, pending_chats: 0 })
  })

  it('a say() or a world action inside the window answers every waiting line once', () => {
    const c = clock()
    const s = createActionStats({ now: c.now })
    s.notePlayerChat()
    c.advance(2000)
    s.notePlayerChat()
    c.advance(3000)
    s.noteReply()
    s.notePlayerChat()
    c.advance(1500)
    s.noteActionStarted()
    c.advance(60_000)
    const snap = s.snapshot()
    expect(snap.counters).toMatchObject({ player_msgs: 3, unanswered: 0, replied: 2, reply_ms_total: 5000 + 1500 })
  })

  it('a reply after the window does not rescue the expired line', () => {
    const c = clock()
    const s = createActionStats({ now: c.now })
    s.notePlayerChat()
    c.advance(25_000)
    s.noteReply()
    expect(s.snapshot().counters).toMatchObject({ unanswered: 1, replied: 0 })
  })

  it('voice lines are counted but never timed as unanswered', () => {
    const c = clock()
    const s = createActionStats({ now: c.now })
    s.notePlayerChat({ voice: true })
    c.advance(60_000)
    expect(s.snapshot().counters).toMatchObject({ voice_msgs: 1, player_msgs: 0, unanswered: 0 })
  })

  it('dirty tracking: snapshot clears it, any change or an expiring chat sets it', () => {
    const c = clock()
    const s = createActionStats({ now: c.now })
    expect(s.isDirty()).toBe(false)
    s.recordAction('dig', 5, null)
    expect(s.isDirty()).toBe(true)
    s.snapshot()
    expect(s.isDirty()).toBe(false)
    s.notePlayerChat()
    s.snapshot()
    expect(s.isDirty()).toBe(false)
    c.advance(UNANSWERED_MS)
    expect(s.isDirty()).toBe(true)
  })

  it('snapshot carries meta (static + late-bound) and session time, and is JSON-safe', () => {
    const c = clock()
    const config = { llm: { provider: 'anthropic' }, anthropic: { model: 'claude-haiku-5-5', cloudMode: { authToken: 'secret-jwt' } } }
    const s = createActionStats({ now: c.now })
    s.setMeta({ mc_version: '1.21.4' })
    s.setMetaProvider(() => llmMetaFromConfig(config))
    c.advance(90_000)
    const snap = s.snapshot()
    expect(snap.v).toBe(1)
    expect(snap.session_ms).toBe(90_000)
    expect(snap.meta).toEqual({ mc_version: '1.21.4', provider_kind: 'cloud', llm_provider: 'anthropic', model_id: 'claude-haiku-5-5' })
    expect(JSON.stringify(snap)).not.toContain('secret-jwt')
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap)
  })
})

describe('llmMetaFromConfig', () => {
  it('cloud / byok / ollama', () => {
    expect(llmMetaFromConfig({ llm: { provider: 'anthropic' }, anthropic: { model: 'm', cloudMode: {} } }).provider_kind).toBe('cloud')
    expect(llmMetaFromConfig({ llm: { provider: 'anthropic' }, anthropic: { model: 'm' } }).provider_kind).toBe('byok')
    const o = llmMetaFromConfig({ llm: { provider: 'ollama', providers: { ollama: { model: 'qwen3:4b' } } }, anthropic: {} })
    expect(o).toEqual({ provider_kind: 'ollama', llm_provider: 'ollama', model_id: 'qwen3:4b' })
    expect(llmMetaFromConfig({ llm: { provider: 'openai', providers: { openai: { model: 'gpt-5-mini' } } } }).provider_kind).toBe('byok')
  })
})
