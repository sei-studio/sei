/**
 * 261024: the summary fold and chat memory compaction retry with CHAT_MODEL
 * only when the error says the model or the thinking field was refused. Every Anthropic 400 carries
 * "invalid_request_error", so matching "invalid" + "model" retried unrelated
 * request errors too.
 */
import { describe, it, expect } from 'vitest';
import { isModelRequestRejection } from './modelRejection';

describe('isModelRequestRejection', () => {
  it.each([
    ['cloud proxy allowlist', '400 {"error":"invalid_model"}'],
    ['unknown Anthropic model', '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-haiku-5-5"}}'],
    ['thinking refused', '400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking.type: adaptive thinking is not supported on this model"}}'],
    ['thinking budget rule', '400 {"type":"error","error":{"type":"invalid_request_error","message":"`max_tokens` must be greater than `thinking.budget_tokens`"}}'],
    ['OpenAI-compatible unknown model', '404 The model `claude-haiku-5-5` does not exist or you do not have access to it. (model_not_found)'],
    ['Gemini unknown model', 'models/claude-haiku-5-5 is not found for API version v1beta'],
    ['unknown model id with dots', 'models/gemini-2.5-flash-lite is not found for API version v1beta, or is not supported for generateContent.'],
  ])('retries on %s', (_label, msg) => {
    expect(isModelRequestRejection(msg)).toBe(true);
  });

  it.each([
    ['roles must alternate', '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: roles must alternate between \\"user\\" and \\"assistant\\""}}'],
    ['prompt too long', '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}'],
    ['context length on OpenAI', "400 This model's maximum context length is 128000 tokens."],
    ['empty text block', '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.0.text: text content blocks must be non-empty"}}'],
    ['auth', '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
    ['rate limit', '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'],
    ['overloaded', '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'],
    ['timeout', 'Request timed out.'],
  ])('does not retry on %s', (_label, msg) => {
    expect(isModelRequestRejection(msg)).toBe(false);
  });
});




