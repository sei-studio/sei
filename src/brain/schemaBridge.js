// src/llm/schemaBridge.js
import { zodToJsonSchema } from 'zod-to-json-schema'

/**
 * Convert every action in `registry` into the Anthropic `tools` shape:
 *   { name, description, input_schema: <JSON Schema> }
 * @param {{list:()=>string[], schema:(n:string)=>import('zod').ZodObject<any>}} registry
 * @param {Record<string,string>} descriptions  // { actionName: human description }
 */
export function buildAnthropicTools(registry, descriptions = {}) {
  return registry.list().map(name => {
    const zodSchema = registry.schema(name)
    const json = zodToJsonSchema(zodSchema, { name, $refStrategy: 'none' })
    // zodToJsonSchema wraps in { $ref, definitions } when name is given — unwrap to definitions[name]
    const inputSchema = json.definitions?.[name] ?? json
    return {
      name,
      description: descriptions[name] ?? `Action: ${name}`,
      input_schema: inputSchema,
    }
  })
}

