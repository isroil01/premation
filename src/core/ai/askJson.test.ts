/**
 * `askJson`: the shared JSON call. What is pinned here is the part author
 * mode added — knowing a response was cut off, and keeping what was complete
 * — plus the Anthropic structured-output shape (a forced tool call, not text).
 */

import { askJson, extractJson, extractJsonArrayItems } from './askJson';
import { setTransportOverride } from './aiTransport';
import { installScriptedTransport } from './__testHelpers__/scriptedTransport';

const T = { provider: 'anthropic' as const, dialect: 'anthropic' as const, model: 'claude-opus-5', signal: new AbortController().signal };

beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { setTransportOverride(null); jest.restoreAllMocks(); });

describe('extractJsonArrayItems', () => {
  it('keeps the complete items of a cut-off array and drops the cut one', () => {
    const text = '{"beats":[{"index":0,"layers":[{"id":"a"}]},{"index":1,"layers":[]},{"index":2,"layers":[{"id":"b","text":"cut her';
    expect(extractJsonArrayItems(text, 'beats')).toEqual([{ index: 0, layers: [{ id: 'a' }] }, { index: 1, layers: [] }]);
  });

  it('reads inside an unclosed code fence, and handles braces inside strings', () => {
    const text = '```json\n{"beats":[{"t":"a } b"},{"t":"[x]"},{"t":"cu';
    expect(extractJsonArrayItems(text, 'beats')).toEqual([{ t: 'a } b' }, { t: '[x]' }]);
  });

  it('returns nothing when the array never opened, and reads a bare top-level array', () => {
    expect(extractJsonArrayItems('{"title":"x","bea', 'beats')).toEqual([]);
    expect(extractJsonArrayItems('[{"a":1},{"a":2},{"a"')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('still reads a complete answer whole through extractJson', () => {
    expect(extractJson('sure: {"beats":[{"index":0}]} done')).toEqual({ beats: [{ index: 0 }] });
  });
});

describe('askJson', () => {
  it('reports a cut-off answer as truncated, with its text for salvage', async () => {
    installScriptedTransport(() => ({ text: '{"beats":[{"index":0},{"ind', stop: 'max_tokens' }));
    const r = await askJson(T, 'sys', 'user', { path: 'author' });
    expect(r.truncated).toBe(true);
    expect(r.value).toBeUndefined();
    expect(extractJsonArrayItems(r.text, 'beats')).toEqual([{ index: 0 }]);
  });

  it('parses a complete answer and says it was not cut off', async () => {
    installScriptedTransport(() => ({ text: 'Here:\n```json\n{"ok":true}\n```' }));
    const r = await askJson(T, 'sys', 'user', { path: 'author' });
    expect(r).toMatchObject({ value: { ok: true }, truncated: false });
  });

  it('reads an Anthropic schema answer from the forced tool call', async () => {
    setTransportOverride(() => (async function* () {
      yield 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"record_stage_output"}}\n\n';
      yield 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"picks\\":[1,2]}"}}\n\n';
      yield 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
      yield 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n';
    })());
    const r = await askJson(T, 'sys', 'user', { schema: { type: 'object', properties: { picks: { type: 'array' } } }, path: 'caster' });
    expect(r.value).toEqual({ picks: [1, 2] });
  });

  it('sends the images and the token cap it was given', async () => {
    const t = installScriptedTransport(() => ({ text: '{}' }));
    await askJson(T, 'sys', 'look', { images: [{ mediaType: 'image/png', dataBase64: 'AA' }], maxTokens: 1234, path: 'author' });
    expect(t.requests[0]!.images).toBe(1);
    expect((t.requests[0]!.raw.body as { max_tokens: number }).max_tokens).toBe(1234);
  });
});
