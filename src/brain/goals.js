/**
 * In-memory goal store (D-06). Phase 3 lifts to SQLite (MEM-04).
 * Mutated ONLY via the `setGoals` registry action (D-07).
 */
export function createGoalStore() {
  const owner_goals = []
  const self_goals = []
  const pickList = (list) => (list === 'owner' ? owner_goals : list === 'self' ? self_goals : null)
  return {
    get owner_goals() { return [...owner_goals] },
    get self_goals()  { return [...self_goals] },
    add(list, goal) {
      const arr = pickList(list); if (!arr) throw new Error(`unknown list: ${list}`)
      const trimmed = String(goal).trim()
      if (!trimmed) return false
      if (arr.includes(trimmed)) return false
      arr.push(trimmed); return true
    },
    remove(list, goal) {
      const arr = pickList(list); if (!arr) throw new Error(`unknown list: ${list}`)
      const i = arr.indexOf(String(goal).trim())
      if (i < 0) return false
      arr.splice(i, 1); return true
    },
    snapshot() {
      return { owner_goals: [...owner_goals], self_goals: [...self_goals] }
    },
  }
}
