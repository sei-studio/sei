/**
 * 261017 (issue #46): the main half of the ChatGPT-plan token hand-off to the
 * forked game bot (the bot half is src/bot/brain/llm/chatgptTokenBridge.js).
 *
 * The refresh token never leaves main. The bot is given the current ACCESS
 * token in its init payload, gets every rotation pushed as
 * {type:'chatgpt-token', token, expiresAt}, and asks for one with
 * {type:'request-chatgpt-token', force} when its token is about to expire or
 * a call came back 401. Refreshes stay single-flight in the session, so any
 * number of bots plus the chat surface share one refresh.
 *
 * Pure over an injected session so botSupervisor stays thin and this is
 * testable without Electron.
 */
import type { ChatgptSession } from './session';
import { buildChatgptInitSection, type LlmInitSection } from '../llmInitSection';

/** Port message shapes (main -> bot). */
export interface ChatgptTokenMessage {
  type: 'chatgpt-token';
  token: string | null;
  expiresAt: number | null;
  /** Set when token is null: the session's error code (terminal or transient). */
  code?: string;
  error?: string;
}

export type ResolveModel = () => Promise<{ model: string; reasoningEffort: string | null; vision: boolean }>;

/** The error the supervisor turns into a summon refusal status. */
export class ChatgptSummonError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChatgptSummonError';
  }
}

const KNOWN_REFUSALS = new Set([
  'CHATGPT_USAGE_LIMIT',
  'CHATGPT_NOT_ELIGIBLE',
  'CHATGPT_FORBIDDEN',
  'CHATGPT_AUTH_REJECTED',
  'CHATGPT_REQUEST_REJECTED',
  'CHATGPT_SIGNED_OUT',
  'CHATGPT_PLAN_DISABLED',
]);

function codeOf(err: unknown): string | undefined {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'string' ? c : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The `llm` init section for a ChatGPT-plan bot, or a ChatgptSummonError the
 * supervisor reports as the status error (before any fork). A paused plan
 * (usage limit latch) refuses here with no network call.
 */
export async function chatgptBotInitSection(
  session: ChatgptSession,
  resolveModel: ResolveModel,
): Promise<LlmInitSection> {
  try {
    session.assertUsable();
    const tok = await session.getAccessToken();
    const m = await resolveModel();
    return buildChatgptInitSection({
      accessToken: tok.token,
      expiresAt: tok.expiresAt ?? Date.now() + 60_000,
      model: m.model,
      reasoningEffort: m.reasoningEffort,
      vision: m.vision,
    });
  } catch (err) {
    const code = codeOf(err);
    // A transient refresh failure is not one of the dialogs: report it as a
    // network problem so the launch panel offers a retry.
    throw new ChatgptSummonError(code && KNOWN_REFUSALS.has(code) ? code : 'NETWORK_OFFLINE', messageOf(err));
  }
}

/** Answer one {type:'request-chatgpt-token'} from a bot. Never throws. */
export async function answerChatgptTokenRequest(
  session: ChatgptSession,
  post: (msg: ChatgptTokenMessage) => void,
  force: boolean,
): Promise<void> {
  let msg: ChatgptTokenMessage;
  try {
    const tok = await session.getAccessToken({ force });
    msg = { type: 'chatgpt-token', token: tok.token, expiresAt: tok.expiresAt ?? null };
  } catch (err) {
    msg = { type: 'chatgpt-token', token: null, expiresAt: null, code: codeOf(err) ?? 'CHATGPT_UNAVAILABLE', error: messageOf(err).slice(0, 200) };
  }
  try {
    post(msg);
  } catch {
    /* port closed during teardown */
  }
}

/**
 * Push every rotation (and sign-out, as a null token) to one bot. Returns the
 * unsubscribe the supervisor calls before closing the port.
 */
export function pushChatgptTokens(session: ChatgptSession, post: (msg: ChatgptTokenMessage) => void): () => void {
  return session.onToken((t) => {
    try {
      post(
        t
          ? { type: 'chatgpt-token', token: t.token, expiresAt: t.expiresAt ?? null }
          : { type: 'chatgpt-token', token: null, expiresAt: null, code: 'CHATGPT_SIGNED_OUT' },
      );
    } catch {
      /* port closed during teardown */
    }
  });
}




