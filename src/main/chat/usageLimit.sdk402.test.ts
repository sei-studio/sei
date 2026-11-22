/**
 * The real wire for the credit wall (261120, v0.7.0 release gate): the proxy's
 * 402 reply, read by the SAME Anthropic SDK + options main uses on the cloud
 * (chat/sdk.ts), must classify as 'depleted' and must not be retried, both
 * for a plain create() and for a streamed turn. Before this the chain was
 * only tested on hand-made `{ status: 402 }` objects.
 *
 * It also pins what the bot's orchestrator keys on (err.status === 402) for
 * the same SDK error, and that raiseUsageLimitPopup fans the wall out on the
 * cloud backend and stays quiet for own-key users.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ kind: 'cloud-proxy' as 'cloud-proxy' | 'local' }));
const emitted = vi.hoisted(() => [] as unknown[]);
vi.mock('../apiKeyStore', () => ({ getAiBackendKind: vi.fn(async () => backend.kind) }));
vi.mock('../ipc', () => ({ emitCreditsHardStop: vi.fn((info: unknown) => emitted.push(info)) }));

import { classifyUsageLimit, raiseUsageLimitPopup } from './usageLimit';

let server: http.Server;
let baseURL = '';
let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    // Byte for byte what sei-proxy's sentinel sends for payment_required.
    const body = JSON.stringify({ error: 'payment_required' });
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function cloudClient(): Anthropic {
  // chat/sdk.ts cloud branch: Bearer JWT, no x-api-key, one retry.
  return new Anthropic({ baseURL, authToken: 'jwt', apiKey: null, maxRetries: 1 });
}

const params = { model: 'claude-haiku-4-5', max_tokens: 16, messages: [{ role: 'user' as const, content: 'hi' }] };

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('proxy 402 through the real SDK', () => {
  it('create(): depleted, one request (402 is not retried)', async () => {
    hits = 0;
    const err = await caught(cloudClient().messages.create(params));
    expect(classifyUsageLimit(err)).toBe('depleted');
    expect((err as { status?: number }).status).toBe(402); // orchestrator.js is402
    expect(hits).toBe(1);
  });

  it('stream(): the streamed chat turn rejects the same way', async () => {
    hits = 0;
    const err = await caught(cloudClient().messages.stream(params).finalMessage());
    expect(classifyUsageLimit(err)).toBe('depleted');
    expect(hits).toBe(1);
  });

  it('raiseUsageLimitPopup: cloud fans out the wall, own key does not', async () => {
    const err = await caught(cloudClient().messages.create(params));
    emitted.length = 0;
    backend.kind = 'cloud-proxy';
    expect(await raiseUsageLimitPopup(err, 'chat')).toBe('depleted');
    expect(emitted).toEqual([{ reason: 'depleted' }]);
    backend.kind = 'local';
    expect(await raiseUsageLimitPopup(err, 'chat')).toBeNull();
    expect(emitted).toHaveLength(1);
  });
});




