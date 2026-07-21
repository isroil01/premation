/**
 * Provider adapters — the highest-risk surface in the AI stack.
 *
 * Three vendors encode the same tool call three incompatible ways, and the
 * whole architecture rests on the claim that they normalize to one event
 * stream. So these tests replay recorded SSE and assert the SAME `AiEvent`
 * sequence comes out of each — including when the bytes are sliced at hostile
 * boundaries, which is what actually happens on a real socket.
 */

import { openAiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { geminiAdapter } from './gemini';
import { SseReader } from './sse';
import type { AiEvent, AiRequest } from '../types';
import type { ProviderAdapter } from './types';

/** Feed a fixture through a parser in one go. */
function run(adapter: ProviderAdapter, sse: string): AiEvent[] {
  const p = adapter.createParser();
  return [...p.push(sse), ...p.end()];
}

/** Feed the same fixture one character at a time — the real-socket worst case. */
function runSliced(adapter: ProviderAdapter, sse: string): AiEvent[] {
  const p = adapter.createParser();
  const out: AiEvent[] = [];
  for (const ch of sse) out.push(...p.push(ch));
  out.push(...p.end());
  return out;
}

// ── Fixtures ──────────────────────────────────────────────────────
// Each says the same thing: stream the text "Fading it in.", then call
// set_keyframes with two keyframes.

const OPENAI_SSE = [
  `data: {"choices":[{"delta":{"role":"assistant","content":"Fading "}}]}`,
  `data: {"choices":[{"delta":{"content":"it in."}}]}`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"set_keyframes","arguments":""}}]}}]}`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"keyframes\\":[{\\"nodeId\\":\\"t1\\",\\"pr"}}]}}]}`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"op\\":\\"opacity\\",\\"t\\":0,\\"value\\":0},{\\"nodeId\\":\\"t1\\",\\"prop\\":\\"opacity\\",\\"t\\":1.2,\\"value\\":100}]}"}}]}}]}`,
  `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
  `data: [DONE]`,
].map((l) => `${l}\n\n`).join('');

const ANTHROPIC_SSE = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Fading "}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"it in."}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc","name":"set_keyframes","input":{}}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"keyframes\\":[{\\"nodeId\\":\\"t1\\",\\"pr"}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"op\\":\\"opacity\\",\\"t\\":0,\\"value\\":0},{\\"nodeId\\":\\"t1\\",\\"prop\\":\\"opacity\\",\\"t\\":1.2,\\"value\\":100}]}"}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
].map((l) => `${l}\n\n`).join('');

const GEMINI_SSE = [
  `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Fading "}]}}]}`,
  `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"it in."}]}}]}`,
  `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"set_keyframes","args":{"keyframes":[{"nodeId":"t1","prop":"opacity","t":0,"value":0},{"nodeId":"t1","prop":"opacity","t":1.2,"value":100}]}}}]},"finishReason":"STOP"}]}`,
].map((l) => `${l}\n\n`).join('');

const EXPECTED_ARGS = {
  keyframes: [
    { nodeId: 't1', prop: 'opacity', t: 0, value: 0 },
    { nodeId: 't1', prop: 'opacity', t: 1.2, value: 100 },
  ],
};

const CASES: { adapter: ProviderAdapter; sse: string; label: string }[] = [
  { adapter: openAiAdapter, sse: OPENAI_SSE, label: 'openai' },
  { adapter: anthropicAdapter, sse: ANTHROPIC_SSE, label: 'anthropic' },
  { adapter: geminiAdapter, sse: GEMINI_SSE, label: 'gemini' },
];

describe('all three providers normalize to the same event stream', () => {
  it.each(CASES)('$label yields text, then an assembled tool call, then stop', ({ adapter, sse }) => {
    const events = run(adapter, sse);

    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Fading it in.');

    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    const call = calls[0] as { name: string; args: unknown; id: string };
    expect(call.name).toBe('set_keyframes');
    expect(call.args).toEqual(EXPECTED_ARGS);      // ← the whole point
    expect(call.id).toBeTruthy();                   // Gemini has none; we mint one

    const stop = events[events.length - 1] as { type: string; reason: string };
    expect(stop.type).toBe('stop');
    expect(stop.reason).toBe('tool_use');
  });

  it.each(CASES)('$label survives being sliced byte-by-byte', ({ adapter, sse }) => {
    // A real socket splits mid-escape; buffering bugs only show up here.
    expect(runSliced(adapter, sse)).toEqual(run(adapter, sse));
  });

  it.each(CASES)('$label emits tool_call only once assembled, never partially', ({ adapter, sse }) => {
    const p = adapter.createParser();
    const during: AiEvent[] = [];
    for (const ch of sse) during.push(...p.push(ch));
    // Any call surfaced mid-stream must already carry complete args.
    for (const e of during.filter((x) => x.type === 'tool_call')) {
      expect((e as { args: unknown }).args).toEqual(EXPECTED_ARGS);
    }
    p.end();
  });
});

describe('text-only turns', () => {
  it.each([
    { label: 'openai', adapter: openAiAdapter, sse: `data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n` },
    { label: 'anthropic', adapter: anthropicAdapter, sse: `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done."}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n` },
    { label: 'gemini', adapter: geminiAdapter, sse: `data: {"candidates":[{"content":{"parts":[{"text":"Done."}]},"finishReason":"STOP"}]}\n\n` },
  ])('$label stops with end_turn so the loop terminates', ({ adapter, sse }) => {
    const events = run(adapter, sse);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(0);
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'end_turn' });
  });
});

describe('parallel tool calls', () => {
  it('openai keeps calls in index order', () => {
    const sse = [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"get_selection","arguments":"{}"}}]}}]}`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"list_presets","arguments":"{}"}}]}}]}`,
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
    ].map((l) => `${l}\n\n`).join('');
    const calls = run(openAiAdapter, sse).filter((e) => e.type === 'tool_call') as { name: string }[];
    expect(calls.map((c) => c.name)).toEqual(['get_selection', 'list_presets']);
  });

  it('gemini mints distinct ids for calls it gives no ids for', () => {
    const sse = `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_selection","args":{}}},{"functionCall":{"name":"list_presets","args":{}}}]},"finishReason":"STOP"}]}\n\n`;
    const calls = run(geminiAdapter, sse).filter((e) => e.type === 'tool_call') as { id: string; name: string }[];
    expect(calls.map((c) => c.name)).toEqual(['get_selection', 'list_presets']);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
  });

  it('gemini captures the thoughtSignature on a function call (Gemini 3+)', () => {
    const sse = `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"describe_scene","args":{}},"thoughtSignature":"SIG_ABC"}]},"finishReason":"STOP"}]}\n\n`;
    const calls = run(geminiAdapter, sse).filter((e) => e.type === 'tool_call') as { name: string; signature?: string }[];
    expect(calls[0]!.name).toBe('describe_scene');
    expect(calls[0]!.signature).toBe('SIG_ABC');
  });

  it('anthropic assembles a no-argument tool call (it sends no partial_json)', () => {
    const sse = [
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t0","name":"get_selection","input":{}}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
    ].map((l) => `${l}\n\n`).join('');
    const calls = run(anthropicAdapter, sse).filter((e) => e.type === 'tool_call') as { name: string; args: unknown }[];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({});
  });
});

describe('failure surfacing', () => {
  it('openai reports unparseable tool arguments rather than dropping the call', () => {
    const sse = [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"set_keyframes","arguments":"{\\"keyframes\\": ["}}]}}]}`,
      `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
    ].map((l) => `${l}\n\n`).join('');
    const events = run(openAiAdapter, sse);
    const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
    expect(err?.message).toContain('set_keyframes');
  });

  it.each([
    { label: 'anthropic', adapter: anthropicAdapter, sse: `event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n`, code: 'rate_limit' },
    { label: 'gemini', adapter: geminiAdapter, sse: `data: {"error":{"code":429,"message":"quota"}}\n\n`, code: 'rate_limit' },
    { label: 'gemini-auth', adapter: geminiAdapter, sse: `data: {"error":{"code":403,"message":"bad key"}}\n\n`, code: 'auth' },
  ])('$label maps a provider error to a typed code', ({ adapter, sse, code }) => {
    const err = run(adapter, sse).find((e) => e.type === 'error') as { code: string } | undefined;
    expect(err?.code).toBe(code);
  });

  it('ignores malformed JSON frames instead of throwing', () => {
    expect(() => run(openAiAdapter, `data: {not json}\n\ndata: [DONE]\n\n`)).not.toThrow();
  });
});

describe('SseReader', () => {
  it('buffers a line split across chunks', () => {
    const r = new SseReader();
    expect(r.push('data: {"a"')).toEqual([]);
    expect(r.push(':1}\n\n')).toEqual([{ event: null, data: '{"a":1}' }]);
  });

  it('handles CRLF', () => {
    expect(new SseReader().push('data: x\r\n\r\n')).toEqual([{ event: null, data: 'x' }]);
  });

  it('skips comments and heartbeats', () => {
    expect(new SseReader().push(': ping\n\ndata: x\n\n')).toEqual([{ event: null, data: 'x' }]);
  });

  it('flushes a trailing event with no terminating blank line', () => {
    const r = new SseReader();
    expect(r.push('data: x')).toEqual([]);
    expect(r.end()).toEqual([{ event: null, data: 'x' }]);
  });
});

describe('request bodies', () => {
  const req: AiRequest = {
    model: 'm',
    system: 'You are a motion designer.',
    messages: [
      { role: 'user', content: 'fade the title in' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_selection', args: {} }] },
      { role: 'tool', id: 'c1', name: 'get_selection', content: 'title_1', isError: false },
    ],
    tools: [{ name: 'get_selection', description: 'x'.repeat(40), kind: 'read', inputSchema: { type: 'object', properties: {} } }],
  };

  it('openai carries system as a message and tool results by id', () => {
    const body = openAiAdapter.buildBody(req) as { messages: { role: string; tool_call_id?: string }[]; stream: boolean };
    expect(body.stream).toBe(true);
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });

  it('anthropic hoists system out of messages and wraps tool results in a user turn', () => {
    const body = anthropicAdapter.buildBody(req) as { system: string; messages: { role: string; content: { type: string }[] }[] };
    expect(body.system).toBe('You are a motion designer.');
    expect(body.messages.some((m) => m.role === 'system')).toBe(false);
    const last = body.messages[body.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content[0]!.type).toBe('tool_result');
  });

  it('gemini uses model/user roles and drops our synthetic call id', () => {
    const body = geminiAdapter.buildBody(req) as { systemInstruction: unknown; contents: { role: string; parts: Record<string, unknown>[] }[] };
    expect(body.systemInstruction).toBeDefined();
    const modelTurn = body.contents.find((c) => c.role === 'model')!;
    const fc = modelTurn.parts[0]!.functionCall as Record<string, unknown>;
    expect(fc.name).toBe('get_selection');
    expect(fc.id).toBeUndefined();   // Gemini has no field for it
    const last = body.contents[body.contents.length - 1]!;
    expect(last.parts[0]!.functionResponse).toBeDefined();
  });

  it('gemini echoes the thoughtSignature back on the model turn (fixes the 400)', () => {
    const withSig: AiRequest = {
      model: 'gemini-3.5-flash',
      system: 'x',
      tools: [],
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'gem_0_describe_scene', name: 'describe_scene', args: {}, signature: 'SIG_ABC' }],
        },
        { role: 'tool', id: 'gem_0_describe_scene', name: 'describe_scene', content: 'ok' },
      ],
    };
    const body = geminiAdapter.buildBody(withSig) as { contents: { role: string; parts: Record<string, unknown>[] }[] };
    const modelTurn = body.contents.find((c) => c.role === 'model')!;
    // Without this field Gemini 3+ rejects the follow-up request with a 400.
    expect(modelTurn.parts[0]!.thoughtSignature).toBe('SIG_ABC');
    expect((modelTurn.parts[0]!.functionCall as Record<string, unknown>).name).toBe('describe_scene');
  });

  it('anthropic merges consecutive tool results into one user turn', () => {
    const multi: AiRequest = {
      ...req,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'get_selection', args: {} }, { id: 'b', name: 'list_presets', args: {} }] },
        { role: 'tool', id: 'a', name: 'get_selection', content: 'x', isError: false },
        { role: 'tool', id: 'b', name: 'list_presets', content: 'y', isError: false },
      ],
    };
    const body = anthropicAdapter.buildBody(multi) as { messages: { role: string; content: unknown[] }[] };
    const last = body.messages[body.messages.length - 1]!;
    expect(last.content).toHaveLength(2);   // one turn, two tool_result blocks
  });

  it('marks an errored tool result so the model knows it failed', () => {
    const failing: AiRequest = {
      ...req,
      messages: [{ role: 'tool', id: 'c1', name: 'set_keyframes', content: 'bad prop', isError: true }],
    };
    const a = anthropicAdapter.buildBody(failing) as { messages: { content: { is_error: boolean }[] }[] };
    expect(a.messages[0]!.content[0]!.is_error).toBe(true);
    const g = geminiAdapter.buildBody(failing) as { contents: { parts: { functionResponse: { response: Record<string, unknown> } }[] }[] };
    expect(g.contents[0]!.parts[0]!.functionResponse.response.error).toBe('bad prop');
  });

  it('attached reference images ride each provider in its native shape', () => {
    const withImage: AiRequest = {
      ...req,
      messages: [
        { role: 'user', content: 'match this style', images: [{ mediaType: 'image/jpeg', dataBase64: 'AAAA' }] },
      ],
    };

    const o = openAiAdapter.buildBody(withImage) as { messages: { content: unknown }[] };
    expect(o.messages[1]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      { type: 'text', text: 'match this style' },
    ]);

    const a = anthropicAdapter.buildBody(withImage) as { messages: { content: unknown[] }[] };
    expect(a.messages[0]!.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
    });
    expect(a.messages[0]!.content[1]).toEqual({ type: 'text', text: 'match this style' });

    const g = geminiAdapter.buildBody(withImage) as { contents: { parts: unknown[] }[] };
    expect(g.contents[0]!.parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    expect(g.contents[0]!.parts[1]).toEqual({ text: 'match this style' });
  });

  it('a plain text turn stays a plain string for openai (no needless array)', () => {
    const o = openAiAdapter.buildBody(req) as { messages: { role: string; content: unknown }[] };
    expect(typeof o.messages[1]!.content).toBe('string');
  });
});
