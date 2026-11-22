// src/bot/names.test.js: accent folding for in-game names (261027).
import { describe, it, expect } from 'vitest'
import { foldLatin, mcUsernameFromName, legacyMcUsernameFromName, MC_USERNAME_MAX, stardewNameFromRaw, STARDEW_NAME_MAX } from './names.js'

describe('foldLatin', () => {
  it.each([
    ['SofÃ­a', 'Sofia'],
    ['LucÃ­a', 'Lucia'],
    ['Ã‰lodie', 'Elodie'],
    ['BjÃ¶rn', 'Bjorn'],
    ['ZoÃ«', 'Zoe'],
    ['Åukasz', 'Lukasz'],
    ['StraÃŸe', 'Strasse'],
    ['STRAáºžE', 'STRASSE'],
    ['SÃ¸ren', 'Soren'],
    ['Ã˜YSTEIN', 'OYSTEIN'],
    ['Ä°pek', 'Ipek'],
    ['KadÄ±kÃ¶y', 'Kadikoy'],
    ['Ã†sa', 'AEsa'],
    ['CÃ¦cilie', 'Caecilie'],
    ['Å’dipe', 'OEdipe'],
    ['CÅ“ur', 'Coeur'],
    ['ÄorÄ‘e', 'Dorde'],
    ['ÃÃ³ra', 'Dora'],
    ['SkaÃ°r', 'Skadr'],
    ['ÃžÃ³ra', 'Thora'],
    ['ÃsÃ¾Ã³r', 'Asthor'],
    ['Ä¦al', 'Hal'],
    ['Ä¦Ä§', 'Hh'],
    ['ChÃ©n HuÇ’', 'Chen Huo'],
    ['LÇœyÃ¨', 'Luye'],
    ['Nguyá»…n XuÃ¢n', 'Nguyen Xuan'],
    ['FranÃ§ois', 'Francois'],
    ['Ã‘uÃ±o', 'Nuno'],
    ['DvoÅ™Ã¡k', 'Dvorak'],
  ])('%s -> %s', (input, want) => {
    expect(foldLatin(input)).toBe(want)
  })

  it('folds a name typed in decomposed form the same as the composed one', () => {
    expect(foldLatin('SofiÌa')).toBe('Sofia')
    expect(foldLatin('ZoeÌˆ')).toBe('Zoe')
  })

  it('leaves non-Latin scripts exactly as they are', () => {
    for (const s of ['è¯—è¯—', 'æ™¨è¾‰', 'ë¯¼ì¤€', 'ã•ãã‚‰', 'ã‚¬ãƒ–ãƒªã‚¨ãƒ«', 'Ð™Ð¾Ñ€Ð´Ð°Ð½', 'ÐÐ»ÐºÐ°', 'á¼ˆÎ¸Î·Î½á¾¶', '××•×¨×™', 'Ø³Ø§Ø±Ø©']) {
      expect(foldLatin(s)).toBe(s)
    }
  })

  it('leaves ASCII, digits, punctuation and spaces alone', () => {
    expect(foldLatin('Sui_2 the-great! (x)')).toBe('Sui_2 the-great! (x)')
    expect(foldLatin('')).toBe('')
    expect(foldLatin(null)).toBe('')
    expect(foldLatin(undefined)).toBe('')
  })
})

describe('mcUsernameFromName', () => {
  it.each([
    ['SofÃ­a', 'Sofia'],
    ['BjÃ¶rn', 'Bjorn'],
    ['Åukasz', 'Lukasz'],
    ['StraÃŸe', 'Strasse'],
    ['SÃ¸ren', 'Soren'],
    ['Ä°pek', 'Ipek'],
    ['ZoÃ«', 'Zoe'],
    ['Ã‰lodie', 'Elodie'],
    ['LucÃ­a Herrera', 'LuciaHerrera'],
    ['æ™¨è¾‰ (ChÃ©nhuÄ«)', 'Chenhui'],
    ['Hoâ€™olheyak', 'Hoolheyak'],
  ])('%s -> %s', (input, want) => {
    expect(mcUsernameFromName(input)).toBe(want)
  })

  it('names in non-Latin scripts get exactly what the old rule gave them', () => {
    for (const s of ['è¯—è¯—', 'ë¯¼ì¤€', 'ã•ãã‚‰', 'Ð™Ð¾Ñ€Ð´Ð°Ð½', 'á¼ˆÎ¸Î·Î½á¾¶', 'ë¯¼ì§€ (Min-ji)', 'ÐÐ»ÐºÐ° 2']) {
      expect(mcUsernameFromName(s)).toBe(legacyMcUsernameFromName(s))
    }
    expect(mcUsernameFromName('è¯—è¯—')).toBe('Sei')
    expect(mcUsernameFromName('Ð™Ð¾Ñ€Ð´Ð°Ð½')).toBe('Sei')
    expect(mcUsernameFromName('ë¯¼ì§€ (Min-ji)')).toBe('Minji')
  })

  it('plain ASCII names are unchanged', () => {
    for (const s of ['Sui', 'Lyra', 'Marv', 'Min-jun', 'Big_Bob 99']) {
      expect(mcUsernameFromName(s)).toBe(legacyMcUsernameFromName(s))
    }
  })

  it('cuts at 16 after folding, so a letter that expands cannot overflow', () => {
    expect(MC_USERNAME_MAX).toBe(16)
    expect(mcUsernameFromName('Catalina VÃ¡squez')).toBe('CatalinaVasquez')
    expect(mcUsernameFromName('StraÃŸenmusikantin')).toBe('Strassenmusikant')
    expect(mcUsernameFromName('StraÃŸenmusikantin')).toHaveLength(16)
    expect(mcUsernameFromName('ÃŸÃŸÃŸÃŸÃŸÃŸÃŸÃŸÃŸÃŸ')).toBe('ssssssssssssssss')
  })

  it('keeps the Sei fallback and adds no padding', () => {
    expect(mcUsernameFromName('')).toBe('Sei')
    expect(mcUsernameFromName(null)).toBe('Sei')
    expect(mcUsernameFromName('!!!')).toBe('Sei')
    expect(mcUsernameFromName('BÃ¸')).toBe('Bo')
  })

  it('output is always a valid Minecraft name', () => {
    for (const s of ['SofÃ­a', 'Ã†Ã¾', 'Ä°', 'ChÃ©n HuÇ’', 'è¯—è¯—', 'a'.repeat(40), 'ï¬ona', 'ï¼³ï½•ï½‰']) {
      expect(mcUsernameFromName(s)).toMatch(/^[A-Za-z0-9_]{1,16}$/)
    }
  })
})

describe('legacyMcUsernameFromName', () => {
  it('is the pre-261027 rule (accents deleted)', () => {
    expect(legacyMcUsernameFromName('SofÃ­a')).toBe('Sofa')
    expect(legacyMcUsernameFromName('LucÃ­a')).toBe('Luca')
    expect(legacyMcUsernameFromName('Ã‰lodie')).toBe('lodie')
    expect(legacyMcUsernameFromName('è¯—è¯—')).toBe('Sei')
  })
})

describe('stardewNameFromRaw', () => {
  it('folds accents, keeps spaces and hyphens, cuts at 24 after folding', () => {
    expect(STARDEW_NAME_MAX).toBe(24)
    expect(stardewNameFromRaw('MartÃ­n Salazar')).toBe('Martin Salazar')
    expect(stardewNameFromRaw('Jean-Ã‰lodie')).toBe('Jean-Elodie')
    expect(stardewNameFromRaw('  ZoÃ«!  ')).toBe('Zoe')
    expect(stardewNameFromRaw('ÃŸ'.repeat(13))).toHaveLength(24)
  })

  it('non-Latin names give exactly what the old rule gave', () => {
    const old = (raw) => String(raw ?? '').replace(/[^A-Za-z0-9_ \-]/g, '').trim().slice(0, 24) || 'Sei'
    for (const s of ['è¯—è¯—', 'ë¯¼ì§€ (Min-ji)', 'Ð™Ð¾Ñ€Ð´Ð°Ð½', 'ã•ãã‚‰ 2', 'Sui', 'Big Bob-99']) {
      expect(stardewNameFromRaw(s)).toBe(old(s))
    }
  })
})




