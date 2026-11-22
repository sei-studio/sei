/**
 * Model-rejection test for the CHAT_MODEL fallbacks (261024). PURE.
 */

/**
 * 261024: true only when an error says the request's MODEL or its THINKING
 * field was refused, the two things the CHAT_MODEL retry in the summary fold
 * (continuity.ts) and chat memory compaction (memoryCompaction.ts) changes.
 * Both used to match any 400 that mentioned "model" next to "invalid", and
 * every Anthropic 400 carries "invalid_request_error", so a transcript or size
 * problem also retried. Shapes matched:
 * - the cloud proxy's model allowlist: `400 {"error":"invalid_model"}`;
 * - an unknown model id: Anthropic `404 ... not_found_error ... model: <id>`,
 *   OpenAI-compatible `model_not_found` / "The model `x` does not exist",
 *   Gemini "models/x is not found";
 * - a request shape the model refuses: a 400 whose message names the
 *   `thinking` field (unsupported adaptive thinking, budget rules).
 */
export function isModelRequestRejection(msg: string): boolean {
  if (/\binvalid_model\b|\bmodel_not_found\b/i.test(msg)) return true;
  if (/\b404\b|not_found_error/i.test(msg) && /\bmodels?\b/i.test(msg)) return true;
  if (/\bmodels?\b[^\n]{0,80}?\b(does not exist|is not found|not found|is not supported|unsupported)\b/i.test(msg)) return true;
  if (/\b400\b/.test(msg) && /\bthinking\b/i.test(msg)) return true;
  return false;
}




