/**
 * 260816 (china-compat W1): the main-process multi-provider LLM layer's shared
 * contract. TypeScript port of the bot's provider factory contract
 * (src/bot/brain/llm/index.js) plus what main's call sites need on top:
 * streaming text deltas, completed-content-block events, stop sequences,
 * forced tool_choice, and a SYNTHESIZED anthropic-shaped assistant content
 * array from every provider so the existing tool loops (chat, chess, Draw!)
 * can push `result.content` back into their messages verbatim.
 *
 * The Anthropic adapter passes every parameter through to the SDK untouched
 * (cache_control breakpoints included), so cloud-proxy and local-Anthropic
 * behavior is byte-identical to the pre-layer code. Non-Anthropic adapters
 * map the shapes and strip cache_control (block ORDER is preserved so
 * providers with implicit prefix caching still benefit).
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { VisionVerdict } from '../../shared/llmCatalog';

export type LlmBackend = 'cloud-proxy' | 'local';

export interface LlmToolDef {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface LlmToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Normalized usage. Zeros/absent where a provider does not report a field. */
export interface LlmUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface LlmCallParams {
  /**
   * Requested model override (e.g. the Sonnet fold/compaction upgrade).
   * Honored ONLY by the Anthropic adapter; every other provider uses its
   * single configured model, so the invalid_model fallback machinery at the
   * fold/compaction sites is naturally a no-op off Anthropic.
   */
  model?: string;
  maxTokens: number;
  /** Anthropic-shaped: a plain string or text blocks (cache_control allowed). */
  system?: string | Anthropic.TextBlockParam[];
  tools?: LlmToolDef[];
  /** Forced tool call (chess profile). Mapped per provider; providers with no
   * support fall back to a strong prompt + JSON-parse of the text output. */
  toolChoice?: { type: 'tool'; name: string };
  stopSequences?: string[];
  /** Anthropic-shaped messages. Non-Anthropic adapters map them. */
  messages: LlmMessage[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Streaming text sink. Anthropic: SDK stream text_delta events (awaited, in
   * order). OpenAI-compat: SSE deltas. Gemini/Ollama (non-streaming v1): one
   * call with the whole text when the response lands.
   */
  onTextDelta?: (text: string) => void | Promise<void>;
  /**
   * Completed-content-block sink (the Draw! stroke reveal). Anthropic: the
   * SDK stream's contentBlock events, each block delivered exactly once.
   * Non-Anthropic: every synthesized block, delivered after the response
   * completes (per-hop reveal is the accepted degradation).
   */
  onContentBlock?: (block: Anthropic.Messages.ContentBlock) => void;
}

export interface LlmResult {
  /** Anthropic-shaped assistant content blocks. Real for Anthropic;
   * synthesized (text block + tool_use blocks) for everyone else. Safe to
   * push back into `messages` as an assistant turn. */
  content: Anthropic.Messages.ContentBlock[];
  toolUses: LlmToolUse[];
  /** All text blocks joined ('' separator), trimmed. */
  text: string;
  usage: LlmUsage;
  /** Normalized: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence',
   * or the provider's raw value when it maps to none of those. */
  stopReason: string | null;
}

export interface LlmProvider {
  call(params: LlmCallParams): Promise<LlmResult>;
  backend: LlmBackend;
  /** Provider kind ('anthropic' covers both cloud-proxy and local BYOK). */
  kind: string;
  /** The configured default model. */
  model: string;
  vision: VisionVerdict;
  /** True when onTextDelta receives real incremental deltas. */
  streaming: boolean;
}
