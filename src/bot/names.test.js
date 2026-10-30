// src/bot/names.test.js: accent folding for in-game names (261027).
import { describe, it, expect } from 'vitest'
import { foldLatin, mcUsernameFromName, legacyMcUsernameFromName, MC_USERNAME_MAX, stardewNameFromRaw, STARDEW_NAME_MAX } from './names.js'

describe('foldLatin', () => {
  it.each([
    ['Sofía', 'Sofia'],
    ['Lucía', 'Lucia'],
    ['Élodie', 'Elodie'],
    ['Björn', 'Bjorn'],
    ['Zoë', 'Zoe'],
    ['Łukasz', 'Lukasz'],
    ['Straße', 'Strasse'],
    ['STRAẞE', 'STRASSE'],
    ['Søren', 'Soren'],
    ['ØYSTEIN', 'OYSTEIN'],
    ['İpek', 'Ipek'],
    ['Kadıköy', 'Kadikoy'],
    ['Æsa', 'AEsa'],
    ['Cæcilie', 'Caecilie'],
    ['Œdipe', 'OEdipe'],
    ['Cœur', 'Coeur'],
    ['Đorđe', 'Dorde'],
    ['Ðóra', 'Dora'],
    ['Skaðr', 'Skadr'],
    ['Þóra', 'Thora'],
    ['Ásþór', 'Asthor'],
    ['Ħal', 'Hal'],
    ['Ħħ', 'Hh'],
    ['Chén Huǒ', 'Chen Huo'],
    ['Lǜyè', 'Luye'],
    ['Nguyễn Xuân', 'Nguyen Xuan'],
    ['François', 'Francois'],
    ['Ñuño', 'Nuno'],
    ['Dvořák', 'Dvorak'],
  ])('%s -> %s', (input, want) => {
    expect(foldLatin(input)).toBe(want)
  })

  it('folds a name typed in decomposed form the same as the composed one', () => {
    expect(foldLatin('Sofía')).toBe('Sofia')
    expect(foldLatin('Zoë')).toBe('Zoe')
  })

  it('leaves non-Latin scripts exactly as they are', () => {
    for (const s of ['诗诗', '晨辉', '민준', 'さくら', 'ガブリエル', 'Йордан', 'Ёлка', 'Ἀθηνᾶ', 'אורי', 'سارة']) {
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
    ['Sofía', 'Sofia'],
    ['Björn', 'Bjorn'],
    ['Łukasz', 'Lukasz'],
    ['Straße', 'Strasse'],
    ['Søren', 'Soren'],
    ['İpek', 'Ipek'],
    ['Zoë', 'Zoe'],
    ['Élodie', 'Elodie'],
    ['Lucía Herrera', 'LuciaHerrera'],
    ['晨辉 (Chénhuī)', 'Chenhui'],
    ['Ho’olheyak', 'Hoolheyak'],
  ])('%s -> %s', (input, want) => {
    expect(mcUsernameFromName(input)).toBe(want)
  })

  it('names in non-Latin scripts get exactly what the old rule gave them', () => {
    for (const s of ['诗诗', '민준', 'さくら', 'Йордан', 'Ἀθηνᾶ', '민지 (Min-ji)', 'Ёлка 2']) {
      expect(mcUsernameFromName(s)).toBe(legacyMcUsernameFromName(s))
    }
    expect(mcUsernameFromName('诗诗')).toBe('Sei')
    expect(mcUsernameFromName('Йордан')).toBe('Sei')
    expect(mcUsernameFromName('민지 (Min-ji)')).toBe('Minji')
  })

  it('plain ASCII names are unchanged', () => {
    for (const s of ['Sui', 'Lyra', 'Marv', 'Min-jun', 'Big_Bob 99']) {
      expect(mcUsernameFromName(s)).toBe(legacyMcUsernameFromName(s))
    }
  })

  it('cuts at 16 after folding, so a letter that expands cannot overflow', () => {
    expect(MC_USERNAME_MAX).toBe(16)
    expect(mcUsernameFromName('Catalina Vásquez')).toBe('CatalinaVasquez')
    expect(mcUsernameFromName('Straßenmusikantin')).toBe('Strassenmusikant')
    expect(mcUsernameFromName('Straßenmusikantin')).toHaveLength(16)
    expect(mcUsernameFromName('ßßßßßßßßßß')).toBe('ssssssssssssssss')
  })

  it('keeps the Sei fallback and adds no padding', () => {
    expect(mcUsernameFromName('')).toBe('Sei')
    expect(mcUsernameFromName(null)).toBe('Sei')
    expect(mcUsernameFromName('!!!')).toBe('Sei')
    expect(mcUsernameFromName('Bø')).toBe('Bo')
  })

  it('output is always a valid Minecraft name', () => {
    for (const s of ['Sofía', 'Æþ', 'İ', 'Chén Huǒ', '诗诗', 'a'.repeat(40), 'ﬁona', 'Ｓｕｉ']) {
      expect(mcUsernameFromName(s)).toMatch(/^[A-Za-z0-9_]{1,16}$/)
    }
  })
})

describe('legacyMcUsernameFromName', () => {
  it('is the pre-261027 rule (accents deleted)', () => {
    expect(legacyMcUsernameFromName('Sofía')).toBe('Sofa')
    expect(legacyMcUsernameFromName('Lucía')).toBe('Luca')
    expect(legacyMcUsernameFromName('Élodie')).toBe('lodie')
    expect(legacyMcUsernameFromName('诗诗')).toBe('Sei')
  })
})

describe('stardewNameFromRaw', () => {
  it('folds accents, keeps spaces and hyphens, cuts at 24 after folding', () => {
    expect(STARDEW_NAME_MAX).toBe(24)
    expect(stardewNameFromRaw('Martín Salazar')).toBe('Martin Salazar')
    expect(stardewNameFromRaw('Jean-Élodie')).toBe('Jean-Elodie')
    expect(stardewNameFromRaw('  Zoë!  ')).toBe('Zoe')
    expect(stardewNameFromRaw('ß'.repeat(13))).toHaveLength(24)
  })

  it('non-Latin names give exactly what the old rule gave', () => {
    const old = (raw) => String(raw ?? '').replace(/[^A-Za-z0-9_ \-]/g, '').trim().slice(0, 24) || 'Sei'
    for (const s of ['诗诗', '민지 (Min-ji)', 'Йордан', 'さくら 2', 'Sui', 'Big Bob-99']) {
      expect(stardewNameFromRaw(s)).toBe(old(s))
    }
  })
})
