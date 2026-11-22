// The "(silence)" sentinel and its localized leaks. 261116: ru/pt/it joined
// the conversation languages, so their common forms are pinned here too.
import { describe, it, expect } from 'vitest'
import { isSilenceFiller } from './silenceFiller.js'

describe('isSilenceFiller', () => {
  it('matches the English marker and its embellishments', () => {
    expect(isSilenceFiller('(silence)')).toBe(true)
    expect(isSilenceFiller('(staying silent, letting it rest)')).toBe(true)
    expect(isSilenceFiller('(nothing)')).toBe(true)
  })

  it('matches the localized forms', () => {
    for (const line of ['(silencio)', '(æ²‰é»˜)', '(ì¹¨ë¬µ)', '(silÃªncio)', '(silenzio)', '(niente)', '(nada)', '(Ñ‚Ð¸ÑˆÐ¸Ð½Ð°)', '(Ð¼Ð¾Ð»Ñ‡Ð°Ð½Ð¸Ðµ)', '(Ð½Ð¸Ñ‡ÐµÐ³Ð¾)']) {
      expect(isSilenceFiller(line), line).toBe(true)
    }
  })

  it('passes real lines through', () => {
    expect(isSilenceFiller('silence!')).toBe(false)
    expect(isSilenceFiller('(silence) ok fine')).toBe(false)
    expect(isSilenceFiller('Ð½Ð¸Ñ‡ÐµÐ³Ð¾ ÑÐµÐ±Ðµ, ÐºÐ»Ð°ÑÑÐ½Ð¾')).toBe(false)
    expect(isSilenceFiller('niente male')).toBe(false)
  })
})




