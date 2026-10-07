/**
 * A scripted model for tests: answers each request with text, encoded as the
 * provider's own SSE stream, through `setTransportOverride`.
 *
 * Everything above the transport runs for real — the adapter's parser, the
 * stop event, `askJson`'s extraction and truncation handling — so a test
 * driven by this exercises the same path a live provider does.
 */

import type { TransportRequest } from '../aiTransport';
import { setTransportOverride } from '../aiTransport';

export interface ScriptedAnswer {
  text: string;
  /** `max_tokens` marks the answer as cut off. */
  stop?: 'end_turn' | 'max_tokens';
}

/** A request as the responder sees it: the Anthropic body's parts, flattened. */
export interface SeenRequest {
  system: string;
  /** The last user message's text. */
  user: string;
  /** How many images the last user message carried. */
  images: number;
  raw: TransportRequest;
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** One answer as Anthropic's stream, split into a few chunks like a real one. */
export function anthropicStream(a: ScriptedAnswer): string[] {
  const text = a.text;
  const parts = [text.slice(0, Math.ceil(text.length / 3)), text.slice(Math.ceil(text.length / 3), Math.ceil((2 * text.length) / 3)), text.slice(Math.ceil((2 * text.length) / 3))].filter(Boolean);
  return [
    sse('message_start', { type: 'message_start', message: { id: 'msg_test', role: 'assistant', content: [] } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...parts.map((p) => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: a.stop ?? 'end_turn' } }),
    sse('message_stop', { type: 'message_stop' }),
  ];
}

function seen(req: TransportRequest): SeenRequest {
  const body = (req.body ?? {}) as { system?: string; messages?: Array<{ role: string; content: unknown }> };
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  let user = '';
  let images = 0;
  if (typeof last?.content === 'string') user = last.content;
  else if (Array.isArray(last?.content)) {
    for (const block of last!.content as Array<{ type?: string; text?: string }>) {
      if (block.type === 'text') user += block.text ?? '';
      if (block.type === 'image') images++;
    }
  }
  return { system: body.system ?? '', user, images, raw: req };
}

/**
 * Install a scripted transport. `respond` sees each request and returns the
 * answer; every request is recorded in order. Call the returned function (or
 * `setTransportOverride(null)`) to remove it.
 */
export function installScriptedTransport(respond: (r: SeenRequest, n: number) => ScriptedAnswer): { requests: SeenRequest[]; remove: () => void } {
  const requests: SeenRequest[] = [];
  setTransportOverride((req) => {
    const r = seen(req);
    const n = requests.length;
    requests.push(r);
    const answer = respond(r, n);
    return (async function* () {
      for (const chunk of anthropicStream(answer)) yield chunk;
    })();
  });
  return { requests, remove: () => setTransportOverride(null) };
}
