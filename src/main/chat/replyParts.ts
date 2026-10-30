/**
 * Reply bubbling with face cues (261028, facepack pilot), split out of
 * chatService so it has no Electron dependency: offline harnesses
 * (scripts/facepack-tag-probe.ts) run the exact function the app runs.
 * chatService re-exports it; splitReply there maps it to text.
 */
import { readFaceTags, type FacePalette } from '../../bot/brain/faceExpressions.js';
import { stripAudioTags, SUPPORTS_AUDIO_TAGS } from '../voice/audioTags';

/** One bubble of a reply plus the face cues read off it (facepack pilot). */
export interface ReplyPart {
  text: string;
  face: { lead: string | null; trail: string | null } | null;
}

/**
 * splitReply, keeping the face cues (261028, facepack pilot). The bubble TEXT
 * is exactly what splitReply always produced: the leading `[expression]` tag
 * is READ here (readFaceTags) before stripAudioTags removes it, which it
 * already did for every bracket tag of that shape. A tag-only line (the model
 * wrote "[happy]" on its own line) leaves no bubble, so its cue is carried to
 * the next bubble's start, or to the previous bubble's end when it was last.
 * Callers emit the cues only while the facepack dev flag is on. `palette`
 * (261028) is the character's pack palette: tags are mapped onto its faces,
 * and a tag it cannot show is ignored like an unknown one.
 */
export function splitReplyParts(
  text: string,
  punctuation: 'casual' | 'deliberate' = 'casual',
  spoken = false,
  palette: FacePalette | null = null,
): ReplyPart[] {
  const parts: ReplyPart[] = [];
  let carry: string | null = null;
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    const tags = readFaceTags(line, palette);
    // Bracketed stage directions never reach a bubble (260730). They are not a
    // thing the model is offered — the shipped TTS model reads `[laughs]` aloud
    // as a word instead of performing it, so audioTags.ts keeps the vocabulary
    // switched off — but models write them unprompted, and on a call the SAME
    // text is the caption and the clip. Removed here so a stray one cannot be
    // read on screen, and again at the synthesis boundary so it cannot be
    // spoken (speechTextFor), the same belt-and-braces as the markdown strip.
    let s = stripAudioTags(line, SUPPORTS_AUDIO_TAGS);
    // 260705: casual texters (the default) drop a single trailing period per
    // bubble — how people actually text. ONLY a lone period: an ellipsis
    // ("hm...") carries tone and is kept, and ? / ! always stay. 'deliberate'
    // characters (character.metadata.punctuation) keep their full stops.
    // Mirrors splitChatMessages in src/bot/brain/orchestrator.js.
    if (!(spoken || punctuation === 'deliberate')) s = s.replace(/(?<!\.)\.$/, '');
    if (!s) {
      // Tag-only line: its last cue applies from the next bubble.
      carry = tags.trail ?? tags.lead ?? carry;
      continue;
    }
    const lead = tags.lead ?? carry;
    carry = null;
    parts.push({ text: s, face: lead || tags.trail ? { lead, trail: tags.trail } : null });
  }
  if (carry) {
    const last = parts[parts.length - 1];
    if (last) last.face = { lead: last.face?.lead ?? null, trail: carry };
  }
  return parts.length ? parts : [{ text: '…', face: carry ? { lead: carry, trail: null } : null }];
}
