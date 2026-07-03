// Furnace session: open + load input/fuel + take smelted output (MCRAFT-01, D-09).
//
// Near-exact mirror of container.js: FURNACE_SESSION is module-scoped so the
// orchestrator can call closeFurnaceSession() on chain end / abort to enforce
// the "never overlap" invariant globally (Pitfall: a leaked window breaks the
// next openContainer/openFurnace). The three slot ops follow the
// deposit/withdraw template. mineflayer's Furnace exposes
// .putInput()/.putFuel()/.takeOutput() + .inputItem()/.fuelItem()/.outputItem().
import mcDataLib from 'minecraft-data'
import { resolveBlock, isStaleHandle } from '../observers/targeting.js'
import { reason } from '../../../brain/errStrings.js'

export const OPEN_TIMEOUT_MS = 6000
export const TRANSFER_TIMEOUT_MS = 4000
const REACH = 4

const FURNACE_SESSION = { furnace: null, blockPos: null }

export async function closeFurnaceSession() {
  if (FURNACE_SESSION.furnace) {
    try { await FURNACE_SESSION.furnace.close() } catch {}
    FURNACE_SESSION.furnace = null
    FURNACE_SESSION.blockPos = null
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

export async function openFurnaceAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'

  // Never overlap sessions — a leaked window desyncs the next open.
  await closeFurnaceSession()

  const target = await resolveBlock(args, bot)
  if (!target) return isStaleHandle(args) ? 'stale target' : 'no target'

  const dist = bot.entity?.position?.distanceTo?.(target.position)
  if (typeof dist === 'number' && dist > REACH) {
    return `target out of reach (${dist.toFixed(1)}m, need ≤${REACH})`
  }

  const timeoutMs = args.timeout_ms ?? config?.openFurnace_timeout_ms ?? OPEN_TIMEOUT_MS
  const targetName = target.name ?? 'furnace'

  const op = bot.openFurnace(target)
    .then((furnace) => {
      FURNACE_SESSION.furnace = furnace
      FURNACE_SESSION.blockPos = target.position
      return `opened ${targetName}`
    })
    .catch((err) => {
      const r = reason(err)
      return r ? `cannot open ${targetName}: ${r}` : `cannot open ${targetName}`
    })

  const tmo = new Promise((r) => setTimeout(async () => {
    await closeFurnaceSession()
    r('timeout')
  }, timeoutMs))

  const abrt = attachAbort(signal, closeFurnaceSession)

  return Promise.race([op, tmo, abrt])
}

export async function smeltInputAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  if (!FURNACE_SESSION.furnace) return 'no furnace open'

  const { item } = args
  const count = args.count ?? 1
  const invItem = bot.inventory.items().find((i) => i.name === item)
  if (!invItem) return `no ${item} to smelt`

  const itemId = invItem.type ?? itemIdByName(bot, item)
  if (itemId == null) return `no ${item} to smelt`

  const actualCount = Math.min(count, invItem.count)
  const timeoutMs = args.timeout_ms ?? config?.smeltInput_timeout_ms ?? TRANSFER_TIMEOUT_MS

  const op = FURNACE_SESSION.furnace.putInput(itemId, null, actualCount)
    .then(() => `smelting ${actualCount} ${item}`)
    .catch((err) => {
      const r = reason(err)
      return r ? `smelt ${item} failed: ${r}` : `smelt ${item} failed`
    })

  // Per container discipline: do NOT close session on transfer timeout —
  // chain-end cleanup handles it.
  const tmo = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))
  const abrt = attachAbort(signal, closeFurnaceSession)

  return Promise.race([op, tmo, abrt])
}

export async function addFuelAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  if (!FURNACE_SESSION.furnace) return 'no furnace open'

  const { item } = args
  const count = args.count ?? 1
  const invItem = bot.inventory.items().find((i) => i.name === item)
  if (!invItem) return `no ${item} to fuel`

  const itemId = invItem.type ?? itemIdByName(bot, item)
  if (itemId == null) return `no ${item} to fuel`

  const actualCount = Math.min(count, invItem.count)
  const timeoutMs = args.timeout_ms ?? config?.addFuel_timeout_ms ?? TRANSFER_TIMEOUT_MS

  const op = FURNACE_SESSION.furnace.putFuel(itemId, null, actualCount)
    .then(() => `added ${actualCount} ${item} fuel`)
    .catch((err) => {
      const r = reason(err)
      return r ? `add ${item} fuel failed: ${r}` : `add ${item} fuel failed`
    })

  const tmo = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))
  const abrt = attachAbort(signal, closeFurnaceSession)

  return Promise.race([op, tmo, abrt])
}

export async function takeSmeltedAction(args, bot, config) {
  const signal = config?.signal
  if (signal?.aborted) return 'aborted'
  if (!FURNACE_SESSION.furnace) return 'no furnace open'

  // Read the output slot defensively (server-controlled) before taking.
  let out = null
  try { out = FURNACE_SESSION.furnace.outputItem() } catch {}
  if (!out) return 'nothing smelted yet'

  const fallbackName = out.name ?? 'item'
  const fallbackCount = out.count ?? 0
  const timeoutMs = args?.timeout_ms ?? config?.takeSmelted_timeout_ms ?? TRANSFER_TIMEOUT_MS

  const op = Promise.resolve()
    .then(() => FURNACE_SESSION.furnace.takeOutput())
    .then((taken) => {
      const n = taken?.count ?? fallbackCount
      const name = taken?.name ?? fallbackName
      return `took ${n} ${name}`
    })
    .catch((err) => {
      const r = reason(err)
      return r ? `take output failed: ${r}` : `take output failed`
    })

  const tmo = new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))
  const abrt = attachAbort(signal, closeFurnaceSession)

  return Promise.race([op, tmo, abrt])
}
