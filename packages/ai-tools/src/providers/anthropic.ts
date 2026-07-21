/**
 * Anthropic Messages adapter.
 *
 * Tool-call quirk: a call is framed by `content_block_start` (which carries id
 * and name) → N× `content_block_delta` with `input_json_delta.partial_json` →
 * `content_block_stop`. Unlike OpenAI, the block index is positional and the
 * JSON is only complete at `stop`, so we assemble per block.
 *
 * Also unlike the others: tool *results* are `user` messages containing
 * `tool_result` blocks, not a dedicated role.
 */

import type { AiEvent, AiMessage, AiRequest } from '../types';
import { toAnthropicTools } from '../emit';
import { SseReader, safeJson } from './sse';
import type { ProviderAdapter, StreamParser } from './types';

function toAnthropicMessages(messages: readonly AiMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'user': {
        // Attached reference images lead the turn as base64 image blocks.
        const content: unknown[] = (m.images ?? []).map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 },
        }));
        content.push({ type: 'text', text: m.content });
        out.push({ role: 'user', content });
        break;
      }
      case 'assistant': {
        const content: unknown[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) {
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
        }
        if (content.length) out.push({ role: 'assistant', content });
        break;
      }
      case 'tool': {
        const block = { type: 'tool_result', tool_use_id: m.id, content: m.content, is_error: m.isError };
        // Consecutive tool results must be merged into ONE user message —
        // Anthropic rejects a tool_result that isn't the first content of the
        // turn following the tool_use.
        const prev = out[out.length - 1] as { role?: string; content?: unknown[] } | undefined;
        const prevIsToolResult =
          prev?.role === 'user' &&
          Array.isArray(prev.content) &&
          (prev.content[0] as { type?: string } | undefined)?.type === 'tool_result';
        if (prevIsToolResult) prev!.content!.push(block);
        else out.push({ role: 'user', content: [block] });
        break;
      }
    }
  }
  return out;
}

interface Block {
  kind: 'text' | 'tool_use';
  id: string;
  name: string;
  json: string;
}

class AnthropicParser implements StreamParser {
  private readonly sse = new SseReader();
  private readonly blocks = new Map<number, Block>();
  private stopReason: string | null = null;
  private readonly done: AiEvent[] = [];

  push(chunk: string): AiEvent[] {
    const out: AiEvent[] = [];
    for (const ev of this.sse.push(chunk)) {
      const json = safeJson(ev.data) as Record<string, unknown> | undefined;
      if (!json) continue;
      const type = (json.type as string) ?? ev.event ?? '';

      switch (type) {
        case 'content_block_start': {
          const index = json.index as number;
          const cb = json.content_block as { type?: string; id?: string; name?: string } | undefined;
          this.blocks.set(index, {
            kind: cb?.type === 'tool_use' ? 'tool_use' : 'text',
            id: cb?.id ?? '',
            name: cb?.name ?? '',
            json: '',
          });
          break;
        }
        case 'content_block_delta': {
          const index = json.index as number;
          const delta = json.delta as { type?: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            out.push({ type: 'text_delta', text: delta.text });
          } else if (delta?.type === 'input_json_delta') {
            const b = this.blocks.get(index);
            if (b) b.json += delta.partial_json ?? '';
          }
          break;
        }
        case 'content_block_stop': {
          const index = json.index as number;
          const b = this.blocks.get(index);
          this.blocks.delete(index);
          if (!b || b.kind !== 'tool_use') break;
          // Anthropic sends no partial_json at all for a no-argument tool.
          const args = b.json.trim() ? safeJson(b.json) : {};
          if (args === undefined) {
            this.done.push({
              type: 'error',
              code: 'bad_response',
              message: `Claude sent unparseable input for ${b.name}: ${b.json.slice(0, 200)}`,
            });
          } else {
            this.done.push({ type: 'tool_call', id: b.id || `toolu_${b.name}`, name: b.name, args });
          }
          break;
        }
        case 'message_delta': {
          const delta = json.delta as { stop_reason?: string } | undefined;
          if (delta?.stop_reason) this.stopReason = delta.stop_reason;
          break;
        }
        case 'error': {
          const err = json.error as { type?: string; message?: string } | undefined;
          const code =
            err?.type === 'rate_limit_error' ? 'rate_limit'
            : err?.type === 'authentication_error' || err?.type === 'permission_error' ? 'auth'
            : err?.type === 'overloaded_error' ? 'overloaded'
            : 'bad_response';
          out.push({ type: 'error', code, message: err?.message ?? 'Anthropic error' });
          break;
        }
        default:
          break;
      }
    }
    return out;
  }

  end(): AiEvent[] {
    for (const ev of this.sse.end()) {
      if (ev.data) this.push(`${ev.event ? `event: ${ev.event}\n` : ''}data: ${ev.data}\n\n`);
    }
    const out = [...this.done];
    this.done.length = 0;
    const reason =
      this.stopReason === 'tool_use' ? 'tool_use' : this.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn';
    out.push({ type: 'stop', reason });
    return out;
  }
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  defaultModel: 'claude-sonnet-5',
  buildBody(req: AiRequest): unknown {
    return {
      model: req.model,
      stream: true,
      // Anthropic takes the system prompt as a top-level field, not a message.
      system: req.system,
      max_tokens: req.maxTokens ?? 8192,
      messages: toAnthropicMessages(req.messages),
      ...(req.responseSchema
        ? {
            tools: [
              {
                name: 'record_stage_output',
                description: 'Record the structured output of this planning stage.',
                input_schema: req.responseSchema,
              },
            ],
            tool_choice: { type: 'tool', name: 'record_stage_output' },
          }
        : req.tools.length
          ? { tools: toAnthropicTools(req.tools) }
          : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
  },
  createParser(): StreamParser {
    return new AnthropicParser();
  },
};
