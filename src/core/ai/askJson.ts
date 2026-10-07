/**
 * One JSON-returning model call over the gateway, shared by the caster and
 * author mode.
 *
 * Moved out of `CasterRunner` when author mode needed the same call with one
 * more answer: whether the response was CUT OFF. A five-beat caster brief is
 * a few hundred tokens and never hits the output cap; an authored beat chunk
 * can. `truncated` comes from the stream's stop event (`max_tokens`), not from
 * guessing at the JSON, and `extractJsonArrayItems` keeps the complete items
 * of a cut-off array so the caller can ask again for only the rest.
 *
 * ## Why parsing is lenient
 *
 * Every caller validates what comes back (`coerceBrief`, `coerceDesign`, …),
 * because a model can return malformed JSON inside a schema-constrained
 * response too. The parser's job is to extract what it can.
 */

import type { AiImage, AiRequest, JsonSchema, ProviderId } from '@motion/ai-tools';
import type { GatewayProviderId } from '@core/api/client';
import { recordAiPathFailure, streamTurn, type AiPathFailure } from './AgentLoop';

export interface AskTarget {
  provider: GatewayProviderId;
  dialect: ProviderId;
  model: string;
  signal: AbortSignal;
}

export interface AskOptions {
  /** A response schema the provider enforces where it can. */
  schema?: JsonSchema;
  images?: readonly AiImage[];
  maxTokens?: number;
  temperature?: number;
  /** Where failures are recorded. */
  path: AiPathFailure['path'];
}

export interface AskResult {
  /** The parsed JSON, or undefined when nothing parsed. */
  value: unknown;
  /** The provider stopped at its output cap — the text is incomplete. */
  truncated: boolean;
  /** The raw text (for salvage, and for the failure record). */
  text: string;
}

/** Pull the first balanced JSON object or array out of a model's prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Fenced block first — the most common wrapper and the cheapest to strip.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;

  const start = body.search(/[[{]/);
  if (start < 0) return undefined;
  const open = body[start]!;
  const close = open === '{' ? '}' : ']';

  // Balance-scan rather than a greedy regex: a prose tail after the object is
  // common, and `body.slice(start, body.lastIndexOf(close) + 1)` swallows it when
  // the prose itself contains a brace.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * The COMPLETE items of the array under `key` in a possibly cut-off JSON
 * object (or of a top-level array when `key` is omitted).
 *
 * `{"beats":[{…},{…},{"index":2,"lay` → the first two items. Each item is
 * balance-scanned and parsed on its own, so one item cut mid-string costs
 * that item only. Returns [] when the array never opened.
 */
export function extractJsonArrayItems(text: string, key?: string): unknown[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)(?:```|$)/.exec(text);
  const body = fenced?.[1] ?? text;
  let i: number;
  if (key) {
    const m = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*\\[`).exec(body);
    if (!m) return [];
    i = m.index + m[0].length;
  } else {
    i = body.indexOf('[');
    if (i < 0) return [];
    i++;
  }
  const out: unknown[] = [];
  while (i < body.length) {
    // Skip to the next item.
    while (i < body.length && /[\s,]/.test(body[i]!)) i++;
    if (i >= body.length || body[i] === ']') break;
    const open = body[i]!;
    if (open !== '{' && open !== '[') break; // scalars are not items worth salvaging here
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < body.length; j++) {
      const ch = body[j]!;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          if (ch === close) end = j;
          break;
        }
      }
    }
    if (end < 0) break; // the cut-off item
    try {
      out.push(JSON.parse(body.slice(i, end + 1)));
    } catch {
      break;
    }
    i = end + 1;
  }
  return out;
}

/**
 * A compact, human-readable sketch of a JSON schema — the shape instruction
 * on the schema-less retry, generated from the schema so it cannot drift.
 */
export function shapeHint(schema: unknown, depth = 0): string {
  if (!schema || typeof schema !== 'object' || depth > 4) return '...';
  const s = schema as Record<string, unknown>;
  if (s.type === 'array') return `[${shapeHint(s.items, depth + 1)}]`;
  if (s.type === 'object' && s.properties) {
    const required: string[] = Array.isArray(s.required) ? (s.required as string[]) : [];
    const parts = Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => {
      const mark = required.includes(k) ? '' : '?';
      return `"${k}"${mark}: ${shapeHint(v, depth + 1)}`;
    });
    return `{ ${parts.join(', ')} }`;
  }
  if (Array.isArray(s.enum)) return s.enum.map((e: unknown) => JSON.stringify(e)).join('|');
  return String(s.type ?? 'any');
}

/** The tool a schema-constrained Anthropic answer arrives in (`anthropicAdapter.buildBody`). */
const STAGE_TOOL = 'record_stage_output';

/**
 * Ask for JSON. Never throws on a provider or parse failure — it records the
 * failure under `o.path` and returns `value: undefined` — but a cancel still
 * propagates as the caller's abort.
 */
export async function askJson(t: AskTarget, system: string, user: string, o: AskOptions): Promise<AskResult> {
  const req: AiRequest = {
    model: t.model,
    system,
    messages: [{ role: 'user', content: user, ...(o.images?.length ? { images: o.images } : {}) }],
    // No tools: these calls decide, they never act.
    tools: [],
    ...(o.schema ? { responseSchema: o.schema } : {}),
    ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}),
    ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
  };

  const attempt = async (request: AiRequest): Promise<{ text: string; truncated: boolean; toolArgs?: unknown } | { error: string }> => {
    let text = '';
    let truncated = false;
    let toolArgs: unknown;
    try {
      for await (const ev of streamTurn(t.provider, t.dialect, t.model, request, t.signal)) {
        if (ev.type === 'text_delta') text += ev.text;
        // A schema-constrained Anthropic answer is a forced tool call, not text.
        else if (ev.type === 'tool_call' && ev.name === STAGE_TOOL) toolArgs = ev.args;
        else if (ev.type === 'stop') truncated = ev.reason === 'max_tokens';
        else if (ev.type === 'error') return { error: `${ev.code}: ${ev.message}` };
      }
    } catch (err) {
      if (t.signal.aborted) throw err;
      return { error: err instanceof Error ? err.message : String(err) };
    }
    return { text, truncated, ...(toolArgs !== undefined ? { toolArgs } : {}) };
  };

  let res = await attempt(req);

  // Structured output is not one feature — each provider implements a different
  // subset of JSON Schema (Gemini's is the narrowest). The schema is a
  // convenience: on a rejection, retry without it and spell the shape out in
  // the prompt instead. Recorded, never silent.
  if ('error' in res && req.responseSchema) {
    recordAiPathFailure(o.path, `schema rejected by ${t.dialect} (${res.error}); retrying without it`);
    const { responseSchema: _dropped, ...withoutSchema } = req;
    res = await attempt({
      ...withoutSchema,
      system:
        `${system}\n\nReturn ONLY a single JSON object matching this shape — no prose, ` +
        `no code fences, and every listed key present:\n${shapeHint(req.responseSchema)}`,
    });
  }

  if ('error' in res) {
    recordAiPathFailure(o.path, res.error);
    return { value: undefined, truncated: false, text: '' };
  }

  const value = res.toolArgs !== undefined ? res.toolArgs : extractJson(res.text);
  if (value === undefined && !res.truncated) {
    recordAiPathFailure(o.path, `unparseable response (${res.text.length} chars): ${res.text.slice(0, 160)}`);
  }
  return { value, truncated: res.truncated, text: res.text };
}
