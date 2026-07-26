/**
 * Knowledge upload text extraction (260725).
 *
 * Single validated ingestion path for user-uploaded knowledge files. The
 * renderer NEVER parses uploads — it ships `{ name, bytes }` to main and this
 * module decides everything, so the security posture lives in one place:
 *
 *   - Allowed types: .md / .markdown / .txt / .text (plain text) and .docx
 *     (extracted here with a minimal in-repo zip reader — no external parser,
 *     nothing executed). Legacy binary .doc is REJECTED with actionable copy.
 *   - Binary masquerading as text is rejected (NUL bytes / replacement-char
 *     ratio after UTF-8 decode).
 *   - Output is sanitized: control chars stripped (keep \n \t), Unicode
 *     bidi/zero-width controls stripped (hidden-text prompt tricks), blank
 *     runs collapsed, hard byte cap with a visible truncation marker.
 *
 * The extracted text is only ever treated as DATA downstream: stored under
 * our own UUID filenames (the upload's name never becomes a path component),
 * rendered as plain text in the UI, and framed as reference material (not
 * instructions) when injected into prompts.
 */
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

/** Raw uploaded file ceiling (pre-extraction). */
export const KNOWLEDGE_UPLOAD_MAX_BYTES = 512 * 1024;
/** Stored entry ceiling (post-extraction, per file). */
export const KNOWLEDGE_ENTRY_MAX_BYTES = 64 * 1024;

const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.text']);

/** Typed, user-readable extraction failure. Message is shown verbatim in the UI. */
export class KnowledgeExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeExtractError';
  }
}

export interface ExtractedKnowledge {
  /** Title derived from the file name (sanitized, capped). */
  title: string;
  /** Sanitized plain text, capped at KNOWLEDGE_ENTRY_MAX_BYTES. */
  content: string;
}

/** Strip control + invisible-direction chars; keep \n and \t. */
export function sanitizeKnowledgeText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      // C0/C1 controls except \n \t, plus DEL.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
      // Zero-width + bidi controls (hidden-text / direction-spoofing tricks).
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Enforce the per-entry byte ceiling with a visible marker (never mid-codepoint). */
export function capKnowledgeText(text: string, maxBytes = KNOWLEDGE_ENTRY_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const marker = '\n\n[truncated: file exceeded the knowledge size limit]';
  let sliced = Buffer.from(text, 'utf8').subarray(0, maxBytes - Buffer.byteLength(marker, 'utf8')).toString('utf8');
  // A byte-boundary cut can split a codepoint; toString replaces it with U+FFFD — drop it.
  sliced = sliced.replace(/�+$/, '');
  return sliced + marker;
}

/** Title from an uploaded filename: basename, no extension, sanitized, capped. */
export function titleFromFilename(name: string): string {
  const base = path.basename(String(name ?? '')).replace(/\.[^.]+$/, '');
  const clean = sanitizeKnowledgeText(base).replace(/\s+/g, ' ').trim();
  return (clean || 'Untitled').slice(0, 80);
}

function decodeUtf8Strict(buf: Buffer, label: string): string {
  if (buf.includes(0)) {
    throw new KnowledgeExtractError(`${label} looks like a binary file, not text. Save it as .txt or .md and try again.`);
  }
  const text = buf.toString('utf8');
  const bad = (text.match(/�/g) ?? []).length;
  if (text.length > 0 && bad / text.length > 0.02) {
    throw new KnowledgeExtractError(`${label} does not look like readable text. Save it as .txt or .md and try again.`);
  }
  return text;
}

/* ────────────────────────── minimal .docx reader ──────────────────────────
 * A .docx is a zip; the body text lives in word/document.xml. We walk the
 * central directory ourselves (EOCD → entries → local header) and inflate
 * with node:zlib — no third-party parser, no code paths that execute
 * document content. Anything malformed throws KnowledgeExtractError.
 */

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readDocxDocumentXml(buf: Buffer): string {
  // EOCD is within the last 64KB + 22 bytes of the file.
  const scanFrom = Math.max(0, buf.length - 65558);
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new KnowledgeExtractError('This .docx file could not be read. Save it as .txt or .md and try again.');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDIR_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (name !== 'word/document.xml') continue;

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL_SIG) break;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) break;
    const data = buf.subarray(dataStart, dataStart + compSize);
    try {
      if (method === 0) return data.toString('utf8');
      if (method === 8) return inflateRawSync(data).toString('utf8');
    } catch {
      break;
    }
    break;
  }
  throw new KnowledgeExtractError('This .docx file could not be read. Save it as .txt or .md and try again.');
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const cp = parseInt(h, 16);
      return cp >= 0x20 || cp === 0x0a || cp === 0x09 ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const cp = parseInt(d, 10);
      return cp >= 0x20 || cp === 0x0a || cp === 0x09 ? String.fromCodePoint(cp) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function docxXmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/**
 * Extract sanitized plain text from an uploaded knowledge file.
 * Throws KnowledgeExtractError with user-facing copy on any rejection.
 */
export function extractKnowledgeText(name: string, bytes: Buffer): ExtractedKnowledge {
  const fileName = path.basename(String(name ?? 'file'));
  if (bytes.length === 0) throw new KnowledgeExtractError(`"${fileName}" is empty.`);
  if (bytes.length > KNOWLEDGE_UPLOAD_MAX_BYTES) {
    throw new KnowledgeExtractError(`"${fileName}" is larger than 512 KB. Split it into smaller files and try again.`);
  }
  const ext = path.extname(fileName).toLowerCase();
  const title = titleFromFilename(fileName);

  let text: string;
  if (TEXT_EXTS.has(ext)) {
    text = decodeUtf8Strict(bytes, `"${fileName}"`);
  } else if (ext === '.docx') {
    text = docxXmlToText(readDocxDocumentXml(bytes));
  } else if (ext === '.doc') {
    throw new KnowledgeExtractError(
      `"${fileName}" is a legacy .doc file, which cannot be read safely. Save it as .txt, .md, or .docx and try again.`,
    );
  } else {
    throw new KnowledgeExtractError(
      `"${fileName}" is not a supported type. Upload .md, .txt, .text, or .docx files.`,
    );
  }

  const content = capKnowledgeText(sanitizeKnowledgeText(text));
  if (!content) throw new KnowledgeExtractError(`"${fileName}" contains no readable text.`);
  return { title, content };
}
