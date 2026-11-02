// Probe: do raw window clicks craft on the 1.21.11 server? (harness check)
import { connectAgent, uiState } from './body.mjs'
import { cmds, itemCount } from '../quality-eval/lib/server.mjs'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bot = await connectAgent({ username: 'Dex' })
const show = (t) => { const u = uiState(bot, true); console.log(t, 'cursor', u.cursor?.name, u.cursor?.count, '|', u.slots.filter((s) => s.slot <= 4 || s.name).map((s) => `${s.slot}:${s.name || '-'}${s.count || ''}`).join(' ')) }
const seq = process.argv[2] || 'click_36,rclick_1,rclick_2,rclick_3,rclick_4,click_0'
await cmds(['gamemode survival Dex', 'clear Dex', `give Dex ${process.argv[3] || 'oak_planks 4'}`])
await sleep(1000)
show('start')
for (const k of seq.split(',')) {
  const [kind, n] = k.split('_')
  const [button, mode] = kind === 'click' ? [0, 0] : kind === 'rclick' ? [1, 0] : [0, 1]
  await Promise.race([bot.clickWindow(Number(n), button, mode).catch(() => {}), sleep(1500)])
  await sleep(Number(process.env.GAP || 300))
  show(k)
}
bot.closeWindow(bot.inventory)
await sleep(800)
console.log('server: table', await itemCount('Dex', 'crafting_table'), 'planks', await itemCount('Dex', 'oak_planks'), 'logs', await itemCount('Dex', 'oak_log'))
bot.quit(); await sleep(300); process.exit(0)
