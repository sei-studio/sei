// Chest/container session: open + deposit + withdraw.
//
// SESSION is module-scoped so the orchestrator can call closeContainerSession()
// on chain end / abort to enforce the "never overlap" invariant globally.
import mcDataLib from 'minecraft-data'
import { resolveBlock, isStaleHandle } from '../observers/targeting.js'
import { reason } from '../../../brain/errStrings.js'

export const OPEN_TIMEOUT_MS = 6000
export const TRANSFER_TIMEOUT_MS = 4000
const REACH = 4

const SESSION = { container: null, blockPos: null }

export async function closeContainerSession() {
  if (SESSION.container) {
    try { await SESSION.container.close() } catch {}
    SESSION.container = null
    SESSION.blockPos = null
  }
}

function itemIdByName(bot, name) {
  try {
    const data = mcDataLib(bot.version)
    return data?.itemsByName?.[name]?.id ?? null
  } catch {
    return null
  }
}

function attachAbort(signal, onAbort) {
  return new Promise((r) => {
    if (!signal) return
    signal.addEventListener('abort', async () => {
      try { await onAbort() } catch {}
      r('aborted')
    }, { once: true })
  })
}

export async function openContainerAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  // Pitfall 6: never overlap sessions.
  await closeContainerSession()

  const target = await resolveBlock(args, bot)
  if (!target) return isStaleHandle(args) ? 'stale target' : 'no target'

  const dist = bot.entity?.position?.distanceTo?.(target.position)
  if (typeof dist === 'number' && dist > REACH) {
    return `target out of reach (${dist.toFixed(1)}m, need ≤${REACH})`
  }

  const timeoutMs = args.timeout_ms ?? config?.openContainer_timeout_ms ?? OPEN_TIMEOUT_MS
  const targetName = target.name ?? 'container'

  const op = bot.openContainer(target)
    .then((container) => {
      SESSION.container = container
      SESSION.blockPos = target.position
      return `opened ${targetName}`
    })
    .catch((err) => {
      const r = reason(err)
      return r ? `cannot open ${targetName}: ${r}` : `cannot open ${targetName}`
    })

  const tmo = new Promise((r) => setTimeout(async () => {
    await closeContainerSession()
    r('timeout')
  }, timeoutMs))

  const abrt = attachAbort(signal, closeContainerSession)

  return Promise.race([op, tmo, abrt])
}

export async function depositItemAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  if (!SESSION.container) return 'no container open'

  const { item } = args
  const count = args.count ?? 1
  const invItem = bot.inventory.items().find((i) => i.name === item)
  if (!invItem) return `no ${item} to deposit`

  const itemId = invItem.type ?? itemIdByName(bot, item)
  if (itemId == null) return `no ${item} to deposit`

  const actualCount = Math.min(count, invItem.count)
  const timeoutMs = args.timeout_ms ?? config?.depositItem_timeout_ms ?? TRANSFER_TIMEOUT_MS

  const op = SESSION.container.deposit(itemId, null, actualCount)
    .then(() => `deposited ${actualCount} ${item}`)
    .catch((err) => {
      const r = reason(err)
      return r ? `deposit ${item} failed: ${r}` : `deposit ${item} failed`
    })

  // Per plan: do NOT close session on transfer timeout — let chain-end cleanup handle it.
  const tmo = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))

  const abrt = attachAbort(signal, closeContainerSession)

  return Promise.race([op, tmo, abrt])
}

export async function withdrawItemAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  if (!SESSION.container) return 'no container open'

  const { item } = args
  const count = args.count ?? 1

  let chestItems = []
  try {
    chestItems = SESSION.container.containerItems().filter((i) => i.name === item)
  } catch {}
  if (chestItems.length === 0) return 'chest empty'

  const itemId = chestItems[0].type ?? itemIdByName(bot, item)
  if (itemId == null) return 'chest empty'

  const timeoutMs = args.timeout_ms ?? config?.withdrawItem_timeout_ms ?? TRANSFER_TIMEOUT_MS

  const op = SESSION.container.withdraw(itemId, null, count)
    .then(() => `withdrew ${count} ${item}`)
    .catch((err) => {
      const msg = String(err?.message || err).toLowerCase()
      if (msg.includes('no room')) return `inventory full (could not withdraw ${item})`
      const r = reason(err)
      return r ? `withdraw ${item} failed: ${r}` : `withdraw ${item} failed`
    })

  const tmo = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))

  const abrt = attachAbort(signal, closeContainerSession)

  return Promise.race([op, tmo, abrt])
}
