/**
 * KTANE bomb sheet (261115): the companion's own notes, applied from its
 * bomb_notes() calls. Pins the field cleaning (indicator shapes, ints, caps),
 * the module/new-bomb resets, and the note read back to it every turn.
 */
import { describe, expect, it } from 'vitest';
import { applyBombNotes, emptySheet, lastDigit, renderSheetNote } from './ktaneSheet';

describe('applyBombNotes', () => {
  it('records edgework and reports which fields changed', () => {
    const r = applyBombNotes(emptySheet(), {
      serial: 'al5 qf2',
      batteries: '3',
      indicators: ['lit FRK', 'unlit CAR', { label: 'bob', lit: true }],
      ports: ['Parallel', 'RJ-45'],
      strikes: 1,
    });
    expect(r.sheet.serial).toBe('AL5QF2');
    expect(r.sheet.batteries).toBe(3);
    expect(r.sheet.indicators).toEqual([
      { label: 'FRK', lit: true },
      { label: 'CAR', lit: false },
      { label: 'BOB', lit: true },
    ]);
    expect(r.sheet.ports).toEqual(['Parallel', 'RJ-45']);
    expect(r.sheet.strikes).toBe(1);
    expect(r.changed).toEqual(['serial', 'batteries', 'indicators', 'ports', 'strikes']);
    expect(r.outcome).toBeNull();
  });

  it('reads the indicator label, never the word "lit" or "off"', () => {
    const r = applyBombNotes(emptySheet(), { indicators: ['LIT FRK', 'FRK off', 'SND: lit', 'lit', 'nonsense words'] });
    expect(r.sheet.indicators).toEqual([
      { label: 'FRK', lit: true },
      { label: 'FRK', lit: false },
      { label: 'SND', lit: true },
    ]);
  });

  it('an empty list means "none", which differs from not asked', () => {
    const r = applyBombNotes(emptySheet(), { indicators: [], ports: [] });
    expect(r.sheet.indicators).toEqual([]);
    expect(r.sheet.ports).toEqual([]);
    expect(renderSheetNote(r.sheet)).toContain('indicators: none');
    expect(renderSheetNote(emptySheet())).toContain('indicators: not asked yet');
  });

  it('drops out-of-range or junk values instead of throwing', () => {
    const r = applyBombNotes(emptySheet(), { batteries: -2, strikes: 'many', serial: 42, indicators: 'FRK', ports: 'none' });
    expect(r.sheet).toEqual(emptySheet());
    expect(r.changed).toEqual([]);
  });

  it('moving to another module drops the old stage notes; the same module keeps them', () => {
    let s = applyBombNotes(emptySheet(), { module: 'Memory', memo: 'stage 1: pos 2 label 4' }).sheet;
    expect(s.module).toBe('memory');
    s = applyBombNotes(s, { module: 'memory' }).sheet;
    expect(s.memo).toBe('stage 1: pos 2 label 4');
    s = applyBombNotes(s, { module: 'maze' }).sheet;
    expect(s.module).toBe('maze');
    expect(s.memo).toBeNull();
  });

  it('caps the memo (a traced maze route fits, an essay does not)', () => {
    const route = '(1,6) up (1,5) up (1,4) right (2,4) right (3,4) down (3,5) right (4,5) up (4,4) right (5,4)';
    expect(applyBombNotes(emptySheet(), { memo: route }).sheet.memo).toBe(route);
    expect(applyBombNotes(emptySheet(), { memo: 'x'.repeat(5000) }).sheet.memo).toHaveLength(600);
  });

  it('solved moves the current module to the solved list', () => {
    let r = applyBombNotes(emptySheet(), { module: 'wires', memo: 'four wires' });
    r = applyBombNotes(r.sheet, { solved: true });
    expect(r.solvedModule).toBe('wires');
    expect(r.sheet.solved).toEqual(['wires']);
    expect(r.sheet.module).toBeNull();
    expect(r.sheet.memo).toBeNull();
  });

  it('a new bomb starts a clean sheet with the next number; defused keeps the sheet', () => {
    const full = applyBombNotes(emptySheet(), { serial: 'AB1CD2', batteries: 2, strikes: 2, module: 'keypad' }).sheet;
    const defused = applyBombNotes(full, { bomb: 'defused' });
    expect(defused.outcome).toBe('defused');
    expect(defused.sheet.serial).toBe('AB1CD2');
    const next = applyBombNotes(full, { bomb: 'new', serial: 'ZZ9ZZ9' });
    expect(next.outcome).toBe('new');
    expect(next.sheet).toEqual({ ...emptySheet(2), serial: 'ZZ9ZZ9' });
  });

  it('never mutates the previous sheet', () => {
    const prev = applyBombNotes(emptySheet(), { module: 'wires' }).sheet;
    const frozen = structuredClone(prev);
    applyBombNotes(prev, { solved: true, serial: 'AA1AA1' });
    expect(prev).toEqual(frozen);
  });
});

describe('renderSheetNote', () => {
  it('reads the notes back with the serial facts the rules key on', () => {
    const s = applyBombNotes(emptySheet(), {
      serial: 'AL5QF2',
      batteries: 1,
      indicators: ['lit FRK'],
      module: 'button',
      memo: 'blue abort',
    }).sheet;
    const note = renderSheetNote(s);
    expect(note).toContain('[your bomb notes, bomb 1]');
    expect(note).toContain('AL5QF2 (last digit 2, has a vowel)');
    expect(note).toContain('lit FRK');
    expect(note).toContain('working on: button. your notes: blue abort');
    expect(note).toContain('ports: not asked yet');
  });

  it('lastDigit takes the last digit anywhere in the serial', () => {
    expect(lastDigit('AL5QF2')).toBe(2);
    expect(lastDigit('7BCDEF')).toBe(7);
    expect(lastDigit('ABCDEF')).toBeNull();
  });
});
