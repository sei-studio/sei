// src/observers/vitals.js — pure function of bot state
/**
 * @param {import('mineflayer').Bot} bot
 * @returns {{ hp:number, food:number, xp:{level:number}, sleeping:boolean }}
 */
export function vitals(bot) {
  return {
    hp: Math.round(bot.health ?? 0),
    food: Math.round(bot.food ?? 0),
    xp: { level: bot.experience?.level ?? 0 },
    sleeping: Boolean(bot.isSleeping),
  }
}
