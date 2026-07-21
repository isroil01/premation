/**
 * OpenAI Chat Completions adapter.
 *
 * Tool-call quirk: arguments arrive as a **JSON string sliced across many
 * deltas**, addressed by an `index` that is stable for the life of the call —
 * `id` and `name` only appear on the first fragment. So we accumulate per index
 * and parse once, at `finish_reason`.
 */

import type { AiEvent, AiMessage, AiRequest } from '../types';
import { toOpenAiTools } from '../emit';
import { SseReader, safeJson } from './sse';
import type { ProviderAdapter, StreamParser } from './types';

function toOpenAiMessages(system: string, messages: readonly AiMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    switch (m.role) {
      case 'user':
        // Attached reference images ride as data-URL image_url parts.
        out.push({
          role: 'user',
          content: m.images?.length
            ? [
                ...m.images.map((img) => ({
                  type: 'image_url',
                  image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
                })),
                { type: 'text', text: m.content },
              ]
            : m.content,
        });
        break;
      case 'assistant':
        out.push({
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
                })),
              }
            : {}),
        });
        break;
      case 'tool':
        // OpenAI has no error flag on tool results — the text carries it.
        out.push({ role: 'tool', tool_call_id: m.id, content: m.content });
        break;
    }
  }
  return out;
}

interface Pending {
  id: string;
  name: string;
  args: string;
}

class OpenAiParser implements StreamParser {
  private readonly sse = new SseReader();
  private readonly pending = new Map<number, Pending>();
  private finish: string | null = null;

  push(chunk: string): AiEvent[] {
    const out: AiEvent[] = [];
    for (const ev of this.sse.push(chunk)) {
      if (ev.data === '[DONE]') continue;
      const json = safeJson(ev.data) as
        | { choices?: { delta?: { content?: string; tool_calls?: unknown[] }; finish_reason?: string }[]; error?: { message?: string } }
        | undefined;
      if (!json) continue;

      if (json.error) {
        out.push({ type: 'error', code: 'bad_response', message: json.error.message ?? 'OpenAI error' });
        continue;
      }

      const choice = json.choices?.[0];
      if (!choice) continue;

      const text = choice.delta?.content;
      if (text) out.push({ type: 'text_delta', text });

      for (const raw of choice.delta?.tool_calls ?? []) {
        const tc = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
        const idx = tc.index ?? 0;
        const cur = this.pending.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        this.pending.set(idx, cur);
      }

      if (choice.finish_reason) this.finish = choice.finish_reason;
    }
    return out;
  }

  end(): AiEvent[] {
    const out: AiEvent[] = [];
    for (const ev of this.sse.end()) {
      if (ev.data && ev.data !== '[DONE]') out.push(...this.push(`${ev.data}\n\n`));
    }
    // Emit assembled calls in index order — the model's intended sequence.
    for (const [, p] of [...this.pending.entries()].sort((a, b) => a[0] - b[0])) {
      if (!p.name) continue;
      const args = p.args.trim() ? safeJson(p.args) : {};
      if (args === undefined) {
        out.push({
          type: 'error',
          code: 'bad_response',
          message: `OpenAI sent unparseable arguments for ${p.name}: ${p.args.slice(0, 200)}`,
        });
        continue;
      }
      out.push({ type: 'tool_call', id: p.id || `call_${p.name}`, name: p.name, args });
    }
    this.pending.clear();

    const reason = this.finish === 'tool_calls' ? 'tool_use' : this.finish === 'length' ? 'max_tokens' : 'end_turn';
    out.push({ type: 'stop', reason });
    return out;
  }
}

export const openAiAdapter: ProviderAdapter = {
  id: 'openai',
  defaultModel: 'gpt-4o',
  buildBody(req: AiRequest): unknown {
    return {
      model: req.model,
      stream: true,
      messages: toOpenAiMessages(req.system, req.messages),
      ...(req.tools.length ? { tools: toOpenAiTools(req.tools), tool_choice: 'auto' } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.responseSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'stage_output',
                strict: true,
                schema: req.responseSchema,
              },
            },
          }
        : {}),
    };
  },
  createParser(): StreamParser {
    return new OpenAiParser();
  },
};

