import { Ollama } from 'ollama'
import { logOllamaQuery, logOllamaResponse } from '../log.js'

/**
 * @param {{ollama:{host:string,model:string,timeout_ms:number}}} config
 */
export function createOllamaClient(config) {
  const host = config.ollama.host
  const model = config.ollama.model
  const defaultTimeoutMs = config.ollama.timeout_ms

  /**
   * Probe `/api/tags` with a 2s wall-clock timeout (Pitfall 8 — keep retry policy in caller).
   * @returns {Promise<boolean>}
   */
  async function probe() {
    try {
      const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Tool-calling chat. Per-call Ollama instance so abort() never cancels another call (Pitfall 3).
   * @param {object} req
   * @param {{role:string,content:string}[]} req.messages
   * @param {Array<{type:'function',function:{name:string,description:string,parameters:object}}>} req.tools
   * @param {AbortSignal} [req.signal]
   * @param {number} [req.timeoutMs]
   * @returns {Promise<{toolCalls:Array<{name:string,args:any}>, text:string}>}
   */
  async function call({ messages, tools, signal, timeoutMs }) {
    const client = new Ollama({ host })
    const effectiveTimeoutMs = timeoutMs ?? defaultTimeoutMs

    // Chain external signal + per-call timeout into a single AbortController.
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timeoutId = setTimeout(() => ctrl.abort(new Error(`ollama timeout after ${effectiveTimeoutMs}ms`)), effectiveTimeoutMs)
    const onCtrlAbort = () => client.abort()
    ctrl.signal.addEventListener('abort', onCtrlAbort, { once: true })

    try {
      logOllamaQuery({ messages, tools })
      const resp = await client.chat({
        model,
        messages,
        tools: tools?.length ? tools : undefined,
        stream: false,
      })
      // ollama-js returns arguments as a parsed OBJECT (not a string — Pitfall in Pattern 4)
      const toolCalls = (resp.message?.tool_calls ?? []).map(c => ({
        name: c.function.name,
        args: c.function.arguments,
      }))
      const text = resp.message?.content ?? ''
      logOllamaResponse({ text, toolCalls })
      return { toolCalls, text }
    } finally {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return { call, probe, host, model }
}
