/**
 * Notice body markdown → block AST (260725).
 *
 * Notices arrive from https://sei.gg/notices.json as markdown so an
 * announcement can carry images and light formatting without shipping an app
 * update. This module parses a deliberately SMALL subset into a typed AST; the
 * inbox renders that AST to React elements, so no remote string is ever fed to
 * `dangerouslySetInnerHTML`. Raw HTML in a body is treated as plain text, on
 * purpose — the allowlist IS the sanitizer, and there is nothing to bypass.
 *
 * Supported blocks:
 *   `# ` `## ` `### ` heading · `- `/`* ` bullet list · `1. ` ordered list ·
 *   `> ` quote · `---` rule · ``` fenced code · blank-line-separated paragraph
 *   (single newlines inside a paragraph become soft breaks).
 *
 * Supported inline:
 *   `**bold**` · `*italic*` / `_italic_` · `` `code` `` · `[text](url)` ·
 *   `![alt](url)` image.
 *
 * URLs are gated to `https:` (links may also be `mailto:`). Anything else —
 * `javascript:`, `data:`, `file:` — degrades to plain text rather than
 * rendering an anchor or an image.
 */

/** One inline run inside a block. */
export type NoticeInline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'code'; v: string }
  | { t: 'br' }
  | { t: 'link'; href: string; v: string }
  | { t: 'img'; src: string; alt: string };

/** One block of a notice body. */
export type NoticeBlock =
  | { t: 'heading'; level: 1 | 2 | 3; children: NoticeInline[] }
  | { t: 'para'; children: NoticeInline[] }
  | { t: 'list'; ordered: boolean; items: NoticeInline[][] }
  | { t: 'quote'; children: NoticeInline[] }
  | { t: 'code'; v: string }
  | { t: 'hr' };

/**
 * Return `raw` if it is a URL we are willing to render, else null.
 * `https:` always; `mailto:` only for links (images can't be mailto).
 */
export function safeUrl(raw: string, kind: 'link' | 'image'): string | null {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol === 'https:') return trimmed;
  if (kind === 'link' && u.protocol === 'mailto:') return trimmed;
  return null;
}

/** Matches, in priority order: image, link, bold, italic (`*` or `_`), code. */
const INLINE_RE =
  /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|`([^`]+)`/;

/**
 * Tokenize one line of inline markdown. Unmatched syntax (an unclosed `**`, a
 * link with a rejected protocol) falls through as literal text — a malformed
 * notice degrades to something readable rather than disappearing.
 */
export function parseInline(line: string): NoticeInline[] {
  const out: NoticeInline[] = [];
  let rest = line;

  const pushText = (v: string): void => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.v += v;
    else out.push({ t: 'text', v });
  };

  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest);
    if (!m || m.index === undefined) {
      pushText(rest);
      break;
    }
    pushText(rest.slice(0, m.index));
    const [whole, imgAlt, imgSrc, linkText, linkHref, bold, star, underscore, code] = m;
    if (imgSrc !== undefined) {
      const src = safeUrl(imgSrc, 'image');
      if (src) out.push({ t: 'img', src, alt: imgAlt ?? '' });
      else pushText(whole);
    } else if (linkHref !== undefined) {
      const href = safeUrl(linkHref, 'link');
      if (href) out.push({ t: 'link', href, v: linkText });
      else pushText(linkText);
    } else if (bold !== undefined) {
      out.push({ t: 'strong', v: bold });
    } else if (star !== undefined) {
      out.push({ t: 'em', v: star });
    } else if (underscore !== undefined) {
      out.push({ t: 'em', v: underscore });
    } else if (code !== undefined) {
      out.push({ t: 'code', v: code });
    }
    rest = rest.slice(m.index + whole.length);
  }
  return out;
}

/** Join paragraph lines with soft breaks. */
function parseParagraph(lines: string[]): NoticeInline[] {
  const out: NoticeInline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push({ t: 'br' });
    out.push(...parseInline(line));
  });
  return out;
}

/**
 * Parse a notice body into blocks. Never throws: any line the grammar doesn't
 * recognize becomes paragraph text.
 */
export function parseNoticeBody(body: string): NoticeBlock[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const blocks: NoticeBlock[] = [];
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length === 0) return;
    blocks.push({ t: 'para', children: parseParagraph(para) });
    para = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();

    // Fenced code — consume through the closing fence (or to EOF).
    if (/^```/.test(trimmed)) {
      flushPara();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i += 1;
      }
      blocks.push({ t: 'code', v: buf.join('\n') });
      continue;
    }

    if (trimmed.length === 0) {
      flushPara();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      blocks.push({ t: 'hr' });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      blocks.push({
        t: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        children: parseInline(heading[2]),
      });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      flushPara();
      const buf = [quote[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim())) {
        i += 1;
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
      }
      blocks.push({ t: 'quote', children: parseParagraph(buf) });
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || ordered) {
      flushPara();
      const isOrdered = !bullet;
      const items: NoticeInline[][] = [parseInline((bullet ?? ordered)![1])];
      while (i + 1 < lines.length) {
        const nextTrimmed = lines[i + 1].trim();
        const next = isOrdered
          ? /^\d+[.)]\s+(.*)$/.exec(nextTrimmed)
          : /^[-*]\s+(.*)$/.exec(nextTrimmed);
        if (!next) break;
        i += 1;
        items.push(parseInline(next[1]));
      }
      blocks.push({ t: 'list', ordered: isOrdered, items });
      continue;
    }

    para.push(line);
  }
  flushPara();
  return blocks;
}
