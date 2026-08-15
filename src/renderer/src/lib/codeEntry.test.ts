/**
 * Tests for the segmented email-code entry transforms (260804).
 *
 * These cover the cases that are invisible in a screenshot and are where a
 * hand-rolled code field actually goes wrong: pasting into a partly-typed
 * value, deleting from the middle, and the browser's "old+new" change payload.
 */
import { describe, it, expect } from 'vitest';
import { backspaceAt, digitsOnly, typedInto, writeAt } from './codeEntry';

const LEN = 6;

describe('digitsOnly', () => {
  it('keeps only digits, so a pasted "123-456" is a code', () => {
    expect(digitsOnly(' 123-456 ')).toBe('123456');
    expect(digitsOnly('abc')).toBe('');
  });
});

describe('writeAt', () => {
  it('appends a digit and advances', () => {
    expect(writeAt('12', 2, '3', LEN)).toEqual({ next: '123', focus: 3 });
  });

  it('overwrites from the target cell rather than inserting', () => {
    // Focus cell 1 on "123456" and type 9 → "19", not "192345".
    expect(writeAt('123456', 1, '9', LEN)).toEqual({ next: '19', focus: 2 });
  });

  it('fills forward from the pasted cell and truncates at length', () => {
    expect(writeAt('', 0, '123456789', LEN)).toEqual({ next: '123456', focus: 5 });
    expect(writeAt('12', 2, '9999', LEN)).toEqual({ next: '129999', focus: 5 });
  });

  it('clamps focus to the last cell when the code is full', () => {
    // Nowhere to advance to; focus must not run off the end of the row.
    expect(writeAt('12345', 5, '6', LEN).focus).toBe(5);
  });

  it('is a no-op for input with no digits in it', () => {
    expect(writeAt('12', 2, 'x', LEN)).toEqual({ next: '12', focus: 2 });
  });
});

describe('backspaceAt', () => {
  it('clears a filled cell and stays put', () => {
    expect(backspaceAt('123', 2, LEN)).toEqual({ next: '12', focus: 2 });
  });

  it('steps back and deletes when the cell is already empty', () => {
    expect(backspaceAt('12', 2, LEN)).toEqual({ next: '1', focus: 1 });
  });

  it('closes the gap when deleting from the middle', () => {
    // The value is a string: a hole is not representable, so the tail shifts.
    expect(backspaceAt('123456', 2, LEN)).toEqual({ next: '12456', focus: 2 });
  });

  it('does nothing at the start of an empty value', () => {
    expect(backspaceAt('', 0, LEN)).toEqual({ next: '', focus: 0 });
  });
});

describe('typedInto', () => {
  it('takes the last digit when the browser appends to a filled cell', () => {
    // Cell held "1", user typed "9" → the input reports "19".
    expect(typedInto('1', '19')).toBe('9');
  });

  it('passes a multi-digit arrival through on an empty cell', () => {
    // Autofill delivering the whole code must not be truncated to one digit.
    expect(typedInto(undefined, '123456')).toBe('123456');
  });

  it('drops non-digits', () => {
    expect(typedInto(undefined, 'a')).toBe('');
  });
});
