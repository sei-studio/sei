import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  extractKnowledgeText,
  sanitizeKnowledgeText,
  capKnowledgeText,
  titleFromFilename,
  KnowledgeExtractError,
  KNOWLEDGE_ENTRY_MAX_BYTES,
  KNOWLEDGE_UPLOAD_MAX_BYTES,
} from './extractText';

/** Build a minimal valid zip holding one entry (used for .docx tests). */
function buildZip(name: string, content: Buffer, method: 0 | 8): Buffer {
  const data = method === 8 ? deflateRawSync(content) : content;
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(content.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  const localRec = Buffer.concat([local, nameBuf, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const centralRec = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralRec.length, 12);
  eocd.writeUInt32LE(localRec.length, 16); // central dir offset

  return Buffer.concat([localRec, centralRec, eocd]);
}

describe('sanitizeKnowledgeText', () => {
  it('strips control chars but keeps newlines and tabs', () => {
    expect(sanitizeKnowledgeText('a\u0000b\u0007c\td\ne')).toBe('abc\td\ne');
  });

  it('strips zero-width and bidi controls (hidden-text tricks)', () => {
    expect(sanitizeKnowledgeText('a​b‮c⁦d﻿e')).toBe('abcde');
  });

  it('normalizes CRLF and collapses blank runs', () => {
    expect(sanitizeKnowledgeText('a\r\nb\n\n\n\n\nc')).toBe('a\nb\n\nc');
  });
});

describe('capKnowledgeText', () => {
  it('returns short text unchanged', () => {
    expect(capKnowledgeText('hello')).toBe('hello');
  });

  it('truncates over-limit text with a visible marker, never mid-codepoint', () => {
    const big = '汉'.repeat(40_000); // 3 bytes each, ~120 KB
    const capped = capKnowledgeText(big);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(KNOWLEDGE_ENTRY_MAX_BYTES);
    expect(capped).toMatch(/\[truncated: file exceeded the knowledge size limit\]$/);
    expect(capped).not.toContain('�');
  });
});

describe('titleFromFilename', () => {
  it('uses the basename without extension', () => {
    expect(titleFromFilename('/some/dir/My Companion Memories.txt')).toBe('My Companion Memories');
  });

  it('caps at 80 chars and never returns empty', () => {
    expect(titleFromFilename('.txt')).toBe('Untitled');
    expect(titleFromFilename(`${'x'.repeat(200)}.md`).length).toBe(80);
  });
});

describe('extractKnowledgeText', () => {
  it('extracts plain text files', () => {
    const res = extractKnowledgeText('memories.txt', Buffer.from('She likes tea.\n', 'utf8'));
    expect(res.title).toBe('memories');
    expect(res.content).toBe('She likes tea.');
  });

  it('accepts .md, .markdown and .text', () => {
    for (const name of ['a.md', 'a.markdown', 'a.text']) {
      expect(extractKnowledgeText(name, Buffer.from('hello', 'utf8')).content).toBe('hello');
    }
  });

  it('rejects binary bytes disguised as .txt', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x00, 0x0a]);
    expect(() => extractKnowledgeText('sneaky.txt', png)).toThrow(KnowledgeExtractError);
  });

  it('rejects unsupported extensions', () => {
    expect(() => extractKnowledgeText('run.exe', Buffer.from('MZ', 'utf8'))).toThrow(/not a supported type/);
    expect(() => extractKnowledgeText('page.html', Buffer.from('<html>', 'utf8'))).toThrow(/not a supported type/);
  });

  it('rejects legacy .doc with actionable copy', () => {
    expect(() => extractKnowledgeText('old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toThrow(
      /legacy \.doc/,
    );
  });

  it('rejects empty and oversized files', () => {
    expect(() => extractKnowledgeText('a.txt', Buffer.alloc(0))).toThrow(/empty/);
    expect(() => extractKnowledgeText('a.txt', Buffer.alloc(KNOWLEDGE_UPLOAD_MAX_BYTES + 1, 0x61))).toThrow(
      /larger than 512 KB/,
    );
  });

  it('extracts deflated .docx body text with paragraph breaks and entities', () => {
    const xml =
      '<?xml version="1.0"?><w:document><w:body>' +
      '<w:p><w:r><w:t>Likes &amp; dislikes</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Loves cats</w:t><w:tab/><w:t>hates rain</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const docx = buildZip('word/document.xml', Buffer.from(xml, 'utf8'), 8);
    const res = extractKnowledgeText('profile.docx', docx);
    expect(res.content).toBe('Likes & dislikes\nLoves cats\thates rain');
  });

  it('extracts stored (method 0) .docx entries too', () => {
    const xml = '<w:document><w:body><w:p><w:t>stored ok</w:t></w:p></w:body></w:document>';
    const docx = buildZip('word/document.xml', Buffer.from(xml, 'utf8'), 0);
    expect(extractKnowledgeText('a.docx', docx).content).toBe('stored ok');
  });

  it('rejects a .docx without word/document.xml', () => {
    const zip = buildZip('other.xml', Buffer.from('<x/>', 'utf8'), 0);
    expect(() => extractKnowledgeText('a.docx', zip)).toThrow(/could not be read/);
  });

  it('rejects a .docx that is not a zip at all', () => {
    expect(() => extractKnowledgeText('a.docx', Buffer.from('just text', 'utf8'))).toThrow(
      /could not be read/,
    );
  });
});
