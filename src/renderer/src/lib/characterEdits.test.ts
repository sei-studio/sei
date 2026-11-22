/**
 * characterEdits (261119): the save rules the profile's inline editors use,
 * carried over unchanged from the Edit companion popup.
 */
import { describe, expect, it } from 'vitest';
import {
  aboutDiffers,
  aboutToSave,
  chessDiffers,
  chessFromCharacter,
  chessMetadataToSave,
  personaModeOf,
  voiceDiffers,
  voiceFromCharacter,
  voiceMetadataToSave,
} from './characterEdits';
import { SUI_CHARACTER_ID, SUI_DEFAULT_PITCH_RATE, SUI_DEFAULT_STABILITY } from '@shared/voicePitch';

// A pool-style id (well formed) and an own-voice id.
const POOL = 'EXAVITQu4vr4xnSDxMaL';
const OWN = 'ownVoice1234567890ab';

describe('voice', () => {
  it('starts from the stored voice and the effective slider values', () => {
    const v = voiceFromCharacter({ id: 'x', metadata: { voiceId: POOL, voicePitch: 1.1 } });
    expect(v.voiceId).toBe(POOL);
    expect(v.params.pitch).toBe(1.1);
    expect(v.voiceOwn).toBeNull();
    expect(voiceFromCharacter({ id: 'x', metadata: {} }).voiceId).toBeNull(); // Auto
  });

  it('dirty only when something the save writes changed', () => {
    const a = voiceFromCharacter({ id: 'x', metadata: { voiceId: POOL } });
    expect(voiceDiffers(a, { ...a })).toBe(false);
    expect(voiceDiffers(a, { ...a, voiceId: 'none' })).toBe(true);
    expect(voiceDiffers(a, { ...a, params: { pitch: 1.2 } })).toBe(true);
    expect(voiceDiffers(a, { ...a, voiceShared: POOL })).toBe(true);
  });

  it('a neutral pitch drops the key, unless the companion has a baked non-neutral default', () => {
    const plain = voiceMetadataToSave('plain-id', { voicePitch: 1.2 }, {
      voiceId: POOL,
      voiceOwn: null,
      voiceShared: null,
      params: {},
    });
    expect('voicePitch' in plain).toBe(false);
    expect(plain.voiceId).toBe(POOL);
    // Sui has a baked pitch and calmness: neutral sliders are written out, so
    // the baked defaults cannot come back.
    const sui = voiceMetadataToSave(SUI_CHARACTER_ID, {}, { voiceId: POOL, voiceOwn: null, voiceShared: null, params: {} });
    expect(sui.voicePitch).toBe(1);
    expect(sui.voiceStability).toBe(0.5);
    // And she opens with the sliders where her voice actually is.
    expect(voiceFromCharacter({ id: SUI_CHARACTER_ID, metadata: {} }).params).toEqual({
      pitch: Math.round(SUI_DEFAULT_PITCH_RATE * 100) / 100,
      calmness: SUI_DEFAULT_STABILITY,
    });
  });

  it('a pool pick clears the own-voice marker and the voice others hear', () => {
    const meta = voiceMetadataToSave('x', { voiceId: OWN, voiceOwn: { name: 'Mine' }, voiceShared: POOL }, {
      voiceId: POOL,
      voiceOwn: null,
      voiceShared: POOL,
      params: {},
    });
    expect(meta.voiceId).toBe(POOL);
    expect(meta.voiceOwn).toBeUndefined();
    expect(meta.voiceShared).toBeUndefined();
  });

  it('a Voice Library voice reads back as a library pick and never carries a voice for others', () => {
    const stored = { voiceId: OWN, voiceLibrary: { name: 'Captain Wren', gender: 'female' } };
    const draft = voiceFromCharacter({ id: 'x', metadata: stored });
    expect(draft.voiceOwn).toEqual({ name: 'Captain Wren', gender: 'female', source: 'library' });
    // A params-only save keeps the library marker.
    const kept = voiceMetadataToSave('x', stored, { ...draft, params: { calmness: 0.7 } });
    expect(kept.voiceLibrary).toEqual({ name: 'Captain Wren', gender: 'female' });
    expect(kept.voiceOwn).toBeUndefined();
    // A fresh library pick over an own voice drops the own marker and the voice for others.
    const picked = voiceMetadataToSave('x', { voiceId: POOL, voiceOwn: { name: 'Mine' }, voiceShared: POOL }, {
      voiceId: OWN,
      voiceOwn: { name: 'Captain Wren', source: 'library' },
      voiceShared: POOL,
      params: {},
    });
    expect(picked.voiceLibrary).toEqual({ name: 'Captain Wren' });
    expect(picked.voiceOwn).toBeUndefined();
    expect(picked.voiceShared).toBeUndefined();
  });

  it('keeps metadata it does not own', () => {
    const meta = voiceMetadataToSave('x', { chess: { elo: 1200 }, prompt_mode: 'advanced' }, {
      voiceId: null,
      voiceOwn: null,
      voiceShared: null,
      params: { calmness: 0.7 },
    });
    expect(meta.chess).toEqual({ elo: 1200 });
    expect(meta.prompt_mode).toBe('advanced');
    expect(meta.voiceStability).toBe(0.7);
    expect('voiceId' in meta).toBe(false); // Auto
  });
});

describe('name and description', () => {
  it('an empty name is refused; an empty description is stored as null', () => {
    expect(aboutToSave({ name: '   ', description: 'x' })).toBe('empty_name');
    expect(aboutToSave({ name: ' Sui ', description: '  ' })).toEqual({ name: 'Sui', description: null });
    expect(aboutToSave({ name: 'Sui', description: ' Hi ' })).toEqual({ name: 'Sui', description: 'Hi' });
  });

  it('whitespace-only changes are not a change', () => {
    expect(aboutDiffers({ name: 'Sui', description: 'a' }, { name: 'Sui ', description: ' a' })).toBe(false);
    expect(aboutDiffers({ name: 'Sui', description: 'a' }, { name: 'Lyra', description: 'a' })).toBe(true);
  });
});

describe('chess', () => {
  it('Custom writes a user profile, Auto removes it', () => {
    expect(chessMetadataToSave({ voiceId: POOL }, { custom: true, elo: 1400, style: ' bold ' })).toEqual({
      voiceId: POOL,
      chess: { elo: 1400, styleNote: 'bold', source: 'user' },
    });
    expect(chessMetadataToSave({ chess: { elo: 1400 } }, { custom: false, elo: 1400, style: '' })).toEqual({});
  });

  it('reads the stored profile, Auto at 900 when there is none', () => {
    expect(chessFromCharacter({ metadata: {} })).toEqual({ custom: false, elo: 900, style: '' });
    const c = chessFromCharacter({ metadata: { chess: { elo: 1600, styleNote: 'sharp' } } });
    expect(c).toEqual({ custom: true, elo: 1600, style: 'sharp' });
    expect(chessDiffers(c, { ...c, elo: 1650 })).toBe(true);
    expect(chessDiffers(c, { ...c })).toBe(false);
  });
});

describe('persona', () => {
  it('opens in Advanced only for a companion saved that way', () => {
    expect(personaModeOf({ metadata: { prompt_mode: 'advanced' } })).toBe('advanced');
    expect(personaModeOf({ metadata: {} })).toBe('standard');
  });
});




