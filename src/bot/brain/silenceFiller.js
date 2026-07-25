// src/bot/brain/silenceFiller.js
//
// THE single "(silence)" sentinel detector, shared by every consumer:
//   - src/bot/brain/orchestrator.js   postProcessSay() say()-side backstop
//   - src/main/chat/chatService.ts    voice reply paths (persistReplies +
//                                     the streaming bubble emitter)
//   - src/main/chess/chessService.ts  game turn runner (speak())
//   - src/main/watch/watchService.ts  watch turn runner (bufferLine())
// It lives on the bot side because the bot ships as raw ESM source and cannot
// import main-process TypeScript, while main happily bundles bot .js modules
// (fsm.js, memoryLog.js precedent). Before 260721 the pattern was duplicated
// in orchestrator.js and chatService.ts with a "keep in sync" comment, and
// the game services had no filter at all — a chess idle tick persisted a
// literal "(silence)" chat row.
//
// Silence-by-convention (260707): models cannot produce an empty reply, but
// they reliably WRITE a placeholder — "(silence)", "(staying silent)",
// "[says nothing]" — when told quiet is fine. The voice-call and game prompts
// sanction staying quiet (voice: "reply with exactly (silence)"; chess/watch:
// "silence at a chess board is normal"), so a line that is nothing but a
// bracketed/asterisked silence marker is the model acting out the instruction
// and must be dropped before it is persisted, pushed, or spoken. Typed plain
// chat never prompts the convention, so there a "*stays silent*" is a real
// in-character beat and its caller does NOT apply this filter.
//
// Shape rules:
//   - Only bracketed/asterisked forms match: a bare in-character "silence!"
//     is a real line and passes through.
//   - Models embellish the marker with a trailing clause — real captured
//     examples: "(staying silent, letting it rest)", "(saying nothing, the
//     thread has landed)", "(nothing)" — so after a silence keyword the rest
//     of the aside is allowed (anything up to the closing bracket), and bare
//     "(nothing)" matches too. A line with content AFTER the closing bracket
//     is real and passes.
//   - Trailing punctuation after the bracket is tolerated ("(silence).",
//     "(Silence)!") — captured leaking from a live chess transcript 260721.
//   - "(no comment)" joined 260721: the chess move prompt says "many moves
//     deserve no comment at all" and the model can echo that phrasing.
//
// 260709 (conversation language): the # LANGUAGE directive tells the model to
// keep the marker as the literal English "(silence)", but under a "speak
// Japanese" instruction it sometimes localizes it anyway, so the pattern also
// accepts the common localized forms: silen[a-z]* covers silence / silent /
// silencio / silencieux..., nada / rien are the "(nothing)" equivalents, and
// the silen-stem and CJK keywords (沉默 / 无言 zh, 沈黙 / 無言 ja, 침묵 / 조용 ko)
// allow a short lead-in ("reste silencieux", 保持沉默, 계속 침묵) — CJK also
// needs this shape because \b never matches between two non-word chars.

export const SILENCE_FILLER_RE =
  /^\s*[([*]+\s*(?:nothing|(?:(?:stay(?:s|ing)?\s+(?:silent|quiet)|remain(?:s|ing)?\s+(?:silent|quiet)|say(?:s|ing)?\s+nothing|no\s+(?:reply|response|comment)|nada|rien)\b|[^)\]]{0,12}(?:silen[a-z]*|沉默|无言|沈黙|無言|침묵|조용))[^)\]]*)\s*[)\]*.!]*\s*$/i

/** True when the reply is the silence sentinel (any tolerated variant): the
 * caller must treat it as no message at all — no persist, no push, no TTS. */
export function isSilenceFiller(text) {
  return SILENCE_FILLER_RE.test(String(text ?? ''))
}
