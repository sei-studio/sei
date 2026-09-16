import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDashboardTelemetry, activityLabel } from './dashboard/telemetry.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const obs = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'obs-farm.json'), 'utf8'))

describe('stardew dashboard telemetry', () => {
  it('emits nothing until watched, then a stardew-tagged snapshot at once and on action change', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const t = createDashboardTelemetry({ getObs: () => obs, emit, intervalMs: 1000 })
    vi.advanceTimersByTime(3000)
    expect(emit).not.toHaveBeenCalled()
    t.setWatching(true)
    expect(emit).toHaveBeenCalledTimes(1)
    const snap = emit.mock.calls[0][0]
    expect(snap).toMatchObject({ game: 'stardew', location: 'Farm', x: 62, y: 18, stamina: 210, maxStamina: 270, health: 100, gold: 500, held: 'Axe', day: 3, season: 'spring', time: 1330, activity: 'idling', actionName: null })
    expect(snap.items).toHaveLength(9)
    t.setAction('water', {})
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[1][0].activity).toBe('watering the crops...')
    vi.advanceTimersByTime(1000)
    expect(emit).toHaveBeenCalledTimes(3)
    t.setWatching(false)
    vi.advanceTimersByTime(5000)
    expect(emit).toHaveBeenCalledTimes(3)
    t.stop()
    vi.useRealTimers()
  })

  it('activity lines are lowercase natural language', () => {
    expect(activityLabel(null)).toBe('idling')
    expect(activityLabel('gather', { kind: 'wood' })).toBe('gathering wood...')
    expect(activityLabel('goTo', { location: 'Town' })).toBe('walking to Town...')
    expect(activityLabel('thinking')).toBe('thinking')
  })
})
