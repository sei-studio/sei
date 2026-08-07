/** Caption chunking (260806) — fixed font size, box-fit paging. */
import { describe, it, expect } from 'vitest';
import {
  captionCapacity,
  chunkCaption,
  splitSentences,
  visualUnits,
} from './captionChunks';

describe('visualUnits', () => {
  it('counts latin as 1 and CJK as 2', () => {
    expect(visualUnits('abc')).toBe(3);
    expect(visualUnits('你好')).toBe(4);
    expect(visualUnits('a你b')).toBe(4);
  });
});

describe('captionCapacity', () => {
  it('shrinks with a larger font at the same box', () => {
    const small = captionCapacity(400, 80, 14);
    const large = captionCapacity(400, 80, 28);
    expect(large.unitsPerChunk).toBeLessThan(small.unitsPerChunk);
  });

  it('never returns zero capacity for a tiny box', () => {
    const cap = captionCapacity(40, 20, 48);
    expect(cap.unitsPerLine).toBeGreaterThan(0);
    expect(cap.lines).toBeGreaterThan(0);
  });
});

describe('splitSentences', () => {
  it('splits on latin and CJK terminators', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
    expect(splitSentences('你好。真的吗？好。')).toEqual(['你好。', '真的吗？', '好。']);
  });

  it('keeps a trailing unterminated sentence', () => {
    expect(splitSentences('Done. and then')).toEqual(['Done.', 'and then']);
  });
});

describe('chunkCaption', () => {
  it('returns empty for blank input', () => {
    expect(chunkCaption('', 100)).toEqual([]);
    expect(chunkCaption('   ', 100)).toEqual([]);
  });

  it('keeps a short line whole', () => {
    expect(chunkCaption('Hi there!', 100)).toEqual(['Hi there!']);
  });

  it('packs sentences up to capacity, then pages', () => {
    const chunks = chunkCaption('One two three. Four five six. Seven eight nine.', 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(visualUnits(c)).toBeLessThanOrEqual(30);
    // Nothing is lost across the chunks.
    expect(chunks.join(' ')).toBe('One two three. Four five six. Seven eight nine.');
  });

  it('a bigger font (smaller capacity) breaks the same line into more chunks', () => {
    const text = 'The quick brown fox jumps over the lazy dog. Again and again it goes.';
    expect(chunkCaption(text, 20).length).toBeGreaterThan(chunkCaption(text, 60).length);
  });

  it('breaks an overlong sentence on word boundaries', () => {
    const chunks = chunkCaption('one two three four five six seven eight', 15);
    for (const c of chunks) expect(visualUnits(c)).toBeLessThanOrEqual(15);
    expect(chunks.join(' ')).toBe('one two three four five six seven eight');
  });

  it('hard-slices an unspaced run longer than the whole box', () => {
    const chunks = chunkCaption('这是一句完全没有空格的很长很长的中文句子啊', 12);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(visualUnits(c)).toBeLessThanOrEqual(12);
    expect(chunks.join('')).toBe('这是一句完全没有空格的很长很长的中文句子啊');
  });
});
