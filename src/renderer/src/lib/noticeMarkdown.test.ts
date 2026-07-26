/**
 * noticeMarkdown — parser tests (260725).
 *
 * The parser is the only thing standing between a remote feed and what the
 * inbox renders, so the cases that matter are: the supported subset produces
 * the right blocks, and anything hostile or malformed degrades to plain text
 * rather than becoming markup.
 */
import { describe, it, expect } from 'vitest';
import { parseInline, parseNoticeBody, safeUrl } from './noticeMarkdown';

describe('safeUrl', () => {
  it('accepts https for links and images', () => {
    expect(safeUrl('https://sei.gg/a.png', 'image')).toBe('https://sei.gg/a.png');
    expect(safeUrl('https://sei.gg/', 'link')).toBe('https://sei.gg/');
  });

  it('accepts mailto only for links', () => {
    expect(safeUrl('mailto:dmca@sei.gg', 'link')).toBe('mailto:dmca@sei.gg');
    expect(safeUrl('mailto:dmca@sei.gg', 'image')).toBeNull();
  });

  it('rejects every other protocol', () => {
    expect(safeUrl('javascript:alert(1)', 'link')).toBeNull();
    expect(safeUrl('data:text/html,<script>', 'image')).toBeNull();
    expect(safeUrl('file:///etc/passwd', 'link')).toBeNull();
    expect(safeUrl('http://sei.gg/', 'link')).toBeNull();
    expect(safeUrl('not a url', 'link')).toBeNull();
  });
});

describe('parseInline', () => {
  it('parses bold, italic and code', () => {
    expect(parseInline('a **b** c *d* e `f`')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'strong', v: 'b' },
      { t: 'text', v: ' c ' },
      { t: 'em', v: 'd' },
      { t: 'text', v: ' e ' },
      { t: 'code', v: 'f' },
    ]);
  });

  it('parses links and images', () => {
    expect(parseInline('[docs](https://sei.gg/docs)')).toEqual([
      { t: 'link', href: 'https://sei.gg/docs', v: 'docs' },
    ]);
    expect(parseInline('![shot](https://sei.gg/a.png)')).toEqual([
      { t: 'img', src: 'https://sei.gg/a.png', alt: 'shot' },
    ]);
  });

  it('degrades an unsafe link to its text and an unsafe image to literal source', () => {
    expect(parseInline('[click](javascript:void0)')).toEqual([{ t: 'text', v: 'click' }]);
    const img = parseInline('![x](data:text/html,y)');
    expect(img.every((run) => run.t === 'text')).toBe(true);
  });

  it('leaves raw HTML as text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([
      { t: 'text', v: '<img src=x onerror=alert(1)>' },
    ]);
  });

  it('leaves unclosed emphasis alone', () => {
    expect(parseInline('a **b')).toEqual([{ t: 'text', v: 'a **b' }]);
  });
});

describe('parseNoticeBody', () => {
  it('splits paragraphs on blank lines and keeps soft breaks', () => {
    const blocks = parseNoticeBody('one\ntwo\n\nthree');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      t: 'para',
      children: [{ t: 'text', v: 'one' }, { t: 'br' }, { t: 'text', v: 'two' }],
    });
    expect(blocks[1].t).toBe('para');
  });

  it('parses headings by level', () => {
    const blocks = parseNoticeBody('# a\n## b\n### c');
    expect(blocks.map((b) => (b.t === 'heading' ? b.level : null))).toEqual([1, 2, 3]);
  });

  it('groups consecutive bullets into one list', () => {
    const blocks = parseNoticeBody('- one\n- two\n\ntail');
    expect(blocks[0]).toEqual({
      t: 'list',
      ordered: false,
      items: [[{ t: 'text', v: 'one' }], [{ t: 'text', v: 'two' }]],
    });
    expect(blocks[1].t).toBe('para');
  });

  it('parses ordered lists separately from bullets', () => {
    const blocks = parseNoticeBody('1. one\n2. two');
    expect(blocks[0].t).toBe('list');
    expect(blocks[0]).toMatchObject({ ordered: true });
  });

  it('parses quotes, rules and fenced code', () => {
    const blocks = parseNoticeBody('> quoted\n> more\n\n---\n\n```\ncode\nhere\n```');
    expect(blocks[0].t).toBe('quote');
    expect(blocks[1]).toEqual({ t: 'hr' });
    expect(blocks[2]).toEqual({ t: 'code', v: 'code\nhere' });
  });

  it('treats an unterminated code fence as code to EOF', () => {
    expect(parseNoticeBody('```\nx')).toEqual([{ t: 'code', v: 'x' }]);
  });

  it('returns nothing for an empty body', () => {
    expect(parseNoticeBody('')).toEqual([]);
  });
});
