// src/bot/adapter/dontstarve/survivors.js — the eligible survivor roster on
// the bot side (game-adapters M2, 260908). MIRROR of
// src/shared/dstSurvivors.ts (which owns the prose + the pick) and
// native/dst-mod/sei/scripts/sei/survivors.lua (the safety layer); the
// vitest suite pins the three prefab lists together. The bot only needs the
// display names and the mechanics flags: the chosen survivor's primer
// paragraph arrives pre-rendered from main in the join target.

export const DST_SURVIVORS = Object.freeze({
  wilson: { name: 'Wilson' },
  willow: { name: 'Willow', fireImmune: true },
  wolfgang: { name: 'Wolfgang' },
  wendy: { name: 'Wendy' },
  wx78: { name: 'WX-78', eatsSpoiled: true, wetnessDamage: true },
  wickerbottom: { name: 'Wickerbottom', noSleep: true },
  waxwell: { name: 'Maxwell', frail: true },
  wigfrid: { name: 'Wigfrid', diet: 'meat' },
  webber: { name: 'Webber' },
  winona: { name: 'Winona' },
  wortox: { name: 'Wortox', souls: true },
  wormwood: { name: 'Wormwood', plantFriend: true },
  warly: { name: 'Warly', needsCrockpot: true },
  wurt: { name: 'Wurt', diet: 'veg' },
  walter: { name: 'Walter' },
})

export const DST_SURVIVOR_PREFABS = Object.freeze(Object.keys(DST_SURVIVORS))
export const DST_DEFAULT_SURVIVOR = 'wilson'

export function survivorName(prefab) {
  return DST_SURVIVORS[prefab]?.name ?? DST_SURVIVORS[DST_DEFAULT_SURVIVOR].name
}

export function survivorFlags(prefab) {
  return DST_SURVIVORS[prefab] ?? DST_SURVIVORS[DST_DEFAULT_SURVIVOR]
}
