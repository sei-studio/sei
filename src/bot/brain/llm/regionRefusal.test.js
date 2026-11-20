// Provider region refusals (261103, T303). The shapes below are the
// providers' own error bodies; the negative cases are the auth and network
// failures that must keep their existing copy.
import { describe, it, expect } from 'vitest'
import {
  PROVIDER_REGION_CODE,
  isProviderRegionRefusal,
  providerRegionError,
  providerRegionLine,
  regionProviderName,
} from './regionRefusal.js'
import { providerFromRegionMessage, regionProviderLabel } from '../../../shared/providerRegion'
import { PROVIDER_LABELS } from '../../../shared/llmCatalog'

/** An SDK-style APIError: status, parsed body, "<status> <json>" message. */
function sdkError(status, body) {
  const err = new Error(`${status} ${JSON.stringify(body)}`)
  err.status = status
  err.error = body
  return err
}

const ANTHROPIC_REGION = { type: 'error', error: { type: 'forbidden', message: 'Request not allowed' } }
const OPENAI_REGION = {
  error: {
    code: 'unsupported_country_region_territory',
    message: 'Country, region, or territory not supported',
    param: null,
    type: 'request_forbidden',
  },
}
const GEMINI_REGION = {
  error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' },
}

describe('isProviderRegionRefusal', () => {
  it('Anthropic: 403 "Request not allowed", SDK shape and message shape', () => {
    expect(isProviderRegionRefusal(sdkError(403, ANTHROPIC_REGION))).toBe(true)
    expect(isProviderRegionRefusal(new Error(`anthropic API 403: ${JSON.stringify(ANTHROPIC_REGION)}`))).toBe(true)
  })

  it('OpenAI: unsupported_country_region_territory, SDK shape and our provider message', () => {
    expect(isProviderRegionRefusal(sdkError(403, OPENAI_REGION))).toBe(true)
    expect(isProviderRegionRefusal(new Error(`openai API 403: ${JSON.stringify(OPENAI_REGION)}`))).toBe(true)
    // The ChatGPT OAuth token endpoint and a bare OAuth error code.
    expect(isProviderRegionRefusal('unsupported_country_region_territory')).toBe(true)
    expect(isProviderRegionRefusal({ oauthError: 'unsupported_country', httpStatus: 403 })).toBe(true)
  })

  it('Gemini: "User location is not supported"', () => {
    expect(isProviderRegionRefusal(new Error(`gemini API 400: ${JSON.stringify(GEMINI_REGION)}`))).toBe(true)
    expect(isProviderRegionRefusal(sdkError(400, GEMINI_REGION))).toBe(true)
  })

  it('gateways that pass the upstream wording through, and a wrapped cause', () => {
    expect(isProviderRegionRefusal(new Error('openrouter API 403: This model is not available in your region.'))).toBe(true)
    const wrapped = new Error('turn failed')
    wrapped.cause = sdkError(403, OPENAI_REGION)
    expect(isProviderRegionRefusal(wrapped)).toBe(true)
  })

  it('our own tag round-trips', () => {
    expect(isProviderRegionRefusal(providerRegionError('openai'))).toBe(true)
    expect(isProviderRegionRefusal(`Error: ${PROVIDER_REGION_CODE}[OpenAI]: x`)).toBe(true)
  })

  it('is false for auth, permission, abort and network failures', () => {
    // A key that may not use a resource is not a region answer.
    const permission = {
      type: 'error',
      error: { type: 'permission_error', message: 'Your API key does not have permission to use the specified resource.' },
    }
    expect(isProviderRegionRefusal(sdkError(403, permission))).toBe(false)
    expect(isProviderRegionRefusal(sdkError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))).toBe(false)
    expect(isProviderRegionRefusal(new Error('openai API 401: {"error":{"code":"invalid_api_key"}}'))).toBe(false)
    expect(isProviderRegionRefusal(new Error('openai API 403: Forbidden'))).toBe(false)
    // "Request not allowed" counts only with the 403.
    expect(isProviderRegionRefusal(new Error('Request not allowed'))).toBe(false)
    const abort = new Error('This operation was aborted')
    abort.name = 'AbortError'
    expect(isProviderRegionRefusal(abort)).toBe(false)
    expect(isProviderRegionRefusal(new TypeError('fetch failed'))).toBe(false)
    expect(isProviderRegionRefusal(null)).toBe(false)
    expect(isProviderRegionRefusal('')).toBe(false)
  })
})

describe('providerRegionError', () => {
  it('carries the code, the name and the one plain line', () => {
    const cause = sdkError(403, OPENAI_REGION)
    const err = providerRegionError('openai', cause)
    expect(err.code).toBe(PROVIDER_REGION_CODE)
    expect(err.providerName).toBe('OpenAI')
    expect(err.cause).toBe(cause)
    expect(err.message).toBe('PROVIDER_REGION_UNSUPPORTED[OpenAI]: OpenAI does not support your region.')
    expect(err.message).not.toMatch(/—|VPN/i)
  })

  it('the renderer reads the name back, through the IPC wrapper too', () => {
    for (const kind of ['anthropic', 'gemini', 'deepseek', 'qwen', 'chatgpt', 'nope']) {
      const err = providerRegionError(kind)
      const name = regionProviderName(kind)
      expect(providerFromRegionMessage(err.message)).toBe(name)
      expect(providerFromRegionMessage(`Error invoking remote method 'chat:send': Error: ${err.message}`)).toBe(name)
    }
    expect(providerFromRegionMessage(providerRegionLine('DeepSeek'))).toBe('DeepSeek')
    expect(providerFromRegionMessage('PROVIDER_REGION_UNSUPPORTED')).toBe('Your AI provider')
    expect(providerFromRegionMessage('The provider rejected this API key.')).toBeNull()
  })
})

describe('provider names', () => {
  it('the bot map and the renderer label agree for every provider kind', () => {
    for (const kind of Object.keys(PROVIDER_LABELS)) {
      expect(regionProviderName(kind), kind).toBe(regionProviderLabel(kind))
    }
    expect(regionProviderName('chatgpt')).toBe('OpenAI')
    expect(regionProviderLabel('chatgpt')).toBe('OpenAI')
    expect(regionProviderName(undefined)).toBe(regionProviderLabel(undefined))
  })
})
