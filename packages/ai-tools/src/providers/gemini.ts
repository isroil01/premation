/**
 * Google Gemini adapter.
 *
 * Two quirks that make this the odd one out:
 *
 *  1. `functionCall` arrives **already parsed** (`{name, args}`) — no fragment
 *     accumulation, no JSON.parse.
 *  2. It carries **no call id**. Gemini matches a `functionResponse` to its
 *     call by *name and position*, not by id. So we mint synthetic ids here and
 *     strip them again in `toGeminiContents` — the loop above gets to pretend
 *     every provider has ids.
 *
 * Roles differ too: Gemini says `model` (not `assistant`), and tool results are
 * `user` turns containing `functionResponse` parts.
 */

import type { AiEvent, AiMessage, AiRequest } from '../types';
import { toGeminiDeclarations, stripUnsupported } from '../emit';
import { SseReader, safeJson } from './sse';
import type { ProviderAdapter, StreamParser } from './types';

function toGeminiContents(messages: readonly AiMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'user': {
        // Attached reference images ride as inlineData parts.
        const parts: unknown[] = (m.images ?? []).map((img) => ({
          inlineData: { mimeType: img.mediaType, data: img.dataBase64 },
        }));
        parts.push({ text: m.content });
        out.push({ role: 'user', parts });
        break;
      }
      case 'assistant': {
        const parts: unknown[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const c of m.toolCalls ?? []) {
          // Drop our synthetic id — Gemini has no field for it. But the
          // thoughtSignature Gemini 3+ attached MUST be returned verbatim, or the
          // next request 400s ("Function call is missing a thought_signature").
          parts.push({
            functionCall: { name: c.name, args: c.args ?? {} },
            ...(c.signature ? { thoughtSignature: c.signature } : {}),
          });
        }
        if (parts.length) out.push({ role: 'model', parts });
        break;
      }
      case 'tool': {
        const part = {
          functionResponse: {
            name: m.name,
            response: m.isError ? { error: m.content } : { result: m.content },
          },
        };
        // Merge consecutive results into one turn, mirroring how the model
        // emitted the batch of calls.
        const prev = out[out.length - 1] as { role?: string; parts?: unknown[] } | undefined;
        const prevIsFnResponse =
          prev?.role === 'user' &&
          Array.isArray(prev.parts) &&
          (prev.parts[0] as { functionResponse?: unknown } | undefined)?.functionResponse !== undefined;
        if (prevIsFnResponse) prev!.parts!.push(part);
        else out.push({ role: 'user', parts: [part] });
        break;
      }
    }
  }
  return out;
}

class GeminiParser implements StreamParser {
  private readonly sse = new SseReader();
  private finishReason: string | null = null;
  private seq = 0;
  private sawCall = false;

  push(chunk: string): AiEvent[] {
    const out: AiEvent[] = [];
    for (const ev of this.sse.push(chunk)) {
      const json = safeJson(ev.data) as
        | {
            candidates?: { content?: { parts?: unknown[] }; finishReason?: string }[];
            error?: { code?: number; message?: string; status?: string };
            promptFeedback?: { blockReason?: string };
          }
        | undefined;
      if (!json) continue;

      if (json.error) {
        const code =
          json.error.code === 429 ? 'rate_limit'
          : json.error.code === 401 || json.error.code === 403 ? 'auth'
          : json.error.code === 503 ? 'overloaded'
          : 'bad_response';
        out.push({ type: 'error', code, message: json.error.message ?? 'Gemini error' });
        continue;
      }
      if (json.promptFeedback?.blockReason) {
        out.push({
          type: 'error',
          code: 'bad_response',
          message: `Gemini blocked the prompt: ${json.promptFeedback.blockReason}`,
        });
        continue;
      }

      const cand = json.candidates?.[0];
      if (!cand) continue;

      for (const rawPart of cand.content?.parts ?? []) {
        const part = rawPart as {
          text?: string;
          functionCall?: { name?: string; args?: unknown };
          thoughtSignature?: string;
        };
        if (part.text) out.push({ type: 'text_delta', text: part.text });
        if (part.functionCall?.name) {
          this.sawCall = true;
          // Gemini gives no id; mint a stable one for this run. Capture the
          // thoughtSignature (Gemini 3+) so the loop can hand it back next turn.
          out.push({
            type: 'tool_call',
            id: `gem_${this.seq++}_${part.functionCall.name}`,
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
            ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
          });
        }
      }
      if (cand.finishReason) this.finishReason = cand.finishReason;
    }
    return out;
  }

  end(): AiEvent[] {
    const out: AiEvent[] = [];
    for (const ev of this.sse.end()) {
      if (ev.data) out.push(...this.push(`data: ${ev.data}\n\n`));
    }
    // Gemini reports STOP even when it emitted calls, so infer tool_use from
    // whether any actually arrived — otherwise the loop would end early.
    const reason = this.sawCall ? 'tool_use' : this.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
    out.push({ type: 'stop', reason });
    return out;
  }
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  defaultModel: 'gemini-3.5-flash',
  buildBody(req: AiRequest): unknown {
    return {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      ...(req.tools.length ? { tools: toGeminiDeclarations(req.tools) } : {}),
      generationConfig: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
        ...(req.responseSchema
          ? {
              responseMimeType: 'application/json',
              responseSchema: stripUnsupported(req.responseSchema),
            }
          : {}),
      },
    };
  },
  createParser(): StreamParser {
    return new GeminiParser();
  },
};

