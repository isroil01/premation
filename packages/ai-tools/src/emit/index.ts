/**
 * One tool definition → four wire formats.
 *
 * This file is the entire reason the registry exists. Every provider wants the
 * same information in a slightly different envelope; describing a tool four
 * times is how schemas rot apart. Describe once, emit four ways.
 */

import type { AiToolDef, JsonSchema } from '../types';

/** OpenAI Chat Completions `tools[]`. */
export function toOpenAiTools(defs: readonly AiToolDef[]): unknown[] {
  return defs.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** Anthropic Messages `tools[]` — same content, `input_schema` not `parameters`. */
export function toAnthropicTools(defs: readonly AiToolDef[]): unknown[] {
  return defs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/**
 * Gemini `functionDeclarations`, wrapped in a single `tools` entry.
 *
 * Gemini's schema dialect is a subset — it rejects `additionalProperties` and
 * `$schema` outright, so those are stripped here. This is the only place any
 * provider-specific schema surgery is allowed to live.
 */
export function toGeminiDeclarations(defs: readonly AiToolDef[]): unknown[] {
  return [
    {
      functionDeclarations: defs.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: stripUnsupported(t.inputSchema),
      })),
    },
  ];
}

/** MCP `tools/list`. Our AiToolDef is already this shape, minus `kind`. */
export function toMcpToolList(defs: readonly AiToolDef[]): { tools: unknown[] } {
  return {
    tools: defs.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

/** Recursively drop keywords Gemini's schema dialect rejects. */
export function stripUnsupported(schema: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema' || key === 'default') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, JsonSchema> = {};
      for (const [k, v] of Object.entries(value as Record<string, JsonSchema>)) {
        props[k] = stripUnsupported(v);
      }
      out[key] = props;
      continue;
    }
    if (key === 'items' && value && typeof value === 'object') {
      out[key] = stripUnsupported(value as JsonSchema);
      continue;
    }
    out[key] = value;
  }
  return out as JsonSchema;
}
