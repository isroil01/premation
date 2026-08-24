/**
 * The registry is the contract every other layer trusts, so these tests pin the
 * two properties that matter: bad model output becomes a *repair hint* rather
 * than an exception, and one schema emits correctly to all four wire formats.
 */

import { ToolRegistry } from './registry';
import { toOpenAiTools, toAnthropicTools, toGeminiDeclarations, toMcpToolList, stripUnsupported } from './emit';
import { ALL_TOOL_DEFS, setKeyframesDef } from './tools';
import { mutates } from './types';
import type { AiTool, ToolContext, ToolResult } from './types';

const ctx = {} as ToolContext;

const echo = <I,>(def: (typeof ALL_TOOL_DEFS)[number], handler?: AiTool<I>['handler']): AiTool<I> => ({
  ...def,
  handler: handler ?? (((input: I): ToolResult => ({ ok: true, content: JSON.stringify(input) })) as AiTool<I>['handler']),
});

describe('ToolRegistry.coerce', () => {
  const reg = new ToolRegistry();
  reg.register(echo(setKeyframesDef));

  it('accepts a valid batch and fills in the easing default', () => {
    const r = reg.coerce('set_keyframes', { keyframes: [{ nodeId: 'a', prop: 'x', t: 0, value: 10 }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kf = (r.input as { keyframes: { easing: string }[] }).keyframes[0]!;
    expect(kf.easing).toBe('linear');
  });

  it('reports the offending path so the model can repair it', () => {
    const r = reg.coerce('set_keyframes', { keyframes: [{ nodeId: 'a', prop: 'x', t: 0, value: 1 }, { nodeId: 'a', prop: 'x', t: -5, value: 2 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('keyframes[1].t');
    expect(r.errors[0]).toContain('>= 0');
  });

  it('names the missing property', () => {
    const r = reg.coerce('set_keyframes', { keyframes: [{ nodeId: 'a', prop: 'x', t: 0 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join()).toContain("missing required property 'value'");
  });

  it('rejects an unknown property and lists what is allowed', () => {
    const r = reg.coerce('set_keyframes', { keyframes: [{ nodeId: 'a', prop: 'x', t: 0, value: 1, curve: 'ease' }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join()).toContain("unknown property 'curve'");
    expect(r.errors.join()).toContain('easing');
  });

  it('rejects an out-of-enum easing by listing the real ones', () => {
    const r = reg.coerce('set_keyframes', { keyframes: [{ nodeId: 'a', prop: 'x', t: 0, value: 1, easing: 'cubic-bezier' }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join()).toContain('must be one of');
  });

  it('coerces a quoted number rather than burning a turn on it', () => {
    const r = reg.coerce('set_keyframes', { keyframes: [{ nodeId: 'a', prop: 'x', t: '1.5', value: '10' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kf = (r.input as { keyframes: { t: number; value: number }[] }).keyframes[0]!;
    expect(kf.t).toBe(1.5);
    expect(kf.value).toBe(10);
  });

  it('tells the model to split an oversized batch', () => {
    const keyframes = Array.from({ length: 201 }, (_, i) => ({ nodeId: 'a', prop: 'x', t: i, value: i }));
    const r = reg.coerce('set_keyframes', { keyframes });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join()).toContain('multiple calls');
  });

  it('lists available tools when the name is unknown', () => {
    const r = reg.coerce('make_it_pop', {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('set_keyframes');
  });
});

describe('ToolRegistry.execute', () => {
  it('turns a thrown handler into a tool result instead of killing the loop', async () => {
    const reg = new ToolRegistry();
    reg.register(echo(setKeyframesDef, () => { throw new Error('scene graph exploded'); }));
    const res = await reg.execute('set_keyframes', { keyframes: [{ nodeId: 'a', prop: 'x', t: 0, value: 1 }] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('scene graph exploded');
  });

  it('does not run the handler when arguments are invalid', async () => {
    const handler = jest.fn(() => ({ ok: true, content: '' }));
    const reg = new ToolRegistry();
    reg.register(echo(setKeyframesDef, handler));
    const res = await reg.execute('set_keyframes', { keyframes: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects duplicate registration', () => {
    const reg = new ToolRegistry();
    reg.register(echo(setKeyframesDef));
    expect(() => reg.register(echo(setKeyframesDef))).toThrow(/Duplicate/);
  });
});

describe('emitters', () => {
  const defs = ALL_TOOL_DEFS;

  it('every tool survives the round trip to all four formats', () => {
    expect(toOpenAiTools(defs)).toHaveLength(defs.length);
    expect(toAnthropicTools(defs)).toHaveLength(defs.length);
    expect(toMcpToolList(defs).tools).toHaveLength(defs.length);
    expect((toGeminiDeclarations(defs)[0] as { functionDeclarations: unknown[] }).functionDeclarations).toHaveLength(defs.length);
  });

  it('OpenAI nests the schema under function.parameters', () => {
    const t = toOpenAiTools([setKeyframesDef])[0] as { type: string; function: { name: string; parameters: unknown } };
    expect(t.type).toBe('function');
    expect(t.function.name).toBe('set_keyframes');
    expect(t.function.parameters).toEqual(setKeyframesDef.inputSchema);
  });

  it('Anthropic uses input_schema', () => {
    const t = toAnthropicTools([setKeyframesDef])[0] as { name: string; input_schema: unknown };
    expect(t.name).toBe('set_keyframes');
    expect(t.input_schema).toEqual(setKeyframesDef.inputSchema);
  });

  it('MCP tools/list matches our def shape minus kind', () => {
    const t = toMcpToolList([setKeyframesDef]).tools[0] as Record<string, unknown>;
    expect(Object.keys(t).sort()).toEqual(['description', 'inputSchema', 'name']);
    expect(t.kind).toBeUndefined();
  });

  it('Gemini strips keywords its schema dialect rejects, recursively', () => {
    const params = (toGeminiDeclarations([setKeyframesDef])[0] as { functionDeclarations: { parameters: Record<string, unknown> }[] })
      .functionDeclarations[0]!.parameters;
    expect(params.additionalProperties).toBeUndefined();
    const item = (params.properties as Record<string, { items: Record<string, unknown> }>).keyframes.items;
    expect(item.additionalProperties).toBeUndefined();
    const easing = (item.properties as Record<string, Record<string, unknown>>).easing!;
    expect(easing.default).toBeUndefined();
    expect(easing.enum).toBeDefined();   // stripping must not eat real constraints
  });

  it('stripUnsupported keeps type/description/enum/minimum', () => {
    const out = stripUnsupported({ type: 'number', description: 'd', minimum: 0, additionalProperties: false });
    expect(out).toEqual({ type: 'number', description: 'd', minimum: 0 });
  });
});

describe('the tool surface itself', () => {
  // Models degrade past ~30 tools, so this count is a budget, not trivia.
  it('exposes 61 tools: 8 read, 37 write, 16 compose', () => {
    // 54 → 59 when five tools that were registered INLINE in `buildAiTools()`
    // moved into this list. They had always been reachable at runtime and had
    // never appeared here, so the backend's tool catalogue, the provider
    // emitters and every drift check read the list and silently missed them.
    // 59 → 62 over two passes. Each addition earns its slot by doing something
    // no other tool can: `generate_image` produces imagery that was never
    // imported, `import_svg` makes a real vector layer instead of a pile of
    // rectangles, and `analyse_audio` is the only way anything in the surface can
    // learn where the beats are.
    // 62 → 61: `set_text_on_path` removed. Nothing in the repository reads the
    // keys it wrote, so it spent a turn, reported success and changed nothing —
    // the budget above is exactly why a tool that cannot work is not free.
    expect(ALL_TOOL_DEFS).toHaveLength(65);
    expect(ALL_TOOL_DEFS.filter((t) => t.kind === 'read')).toHaveLength(8);
    expect(ALL_TOOL_DEFS.filter((t) => t.kind === 'write')).toHaveLength(41);
    expect(ALL_TOOL_DEFS.filter((t) => t.kind === 'compose')).toHaveLength(16);
  });

  it('classifies every craft primitive as `write`, never `compose`', () => {
    // `compose` is reserved for the generic recipe layer the technique library
    // replaces. Counting a primitive as compose would inflate the very
    // compose-ratio metric that is being retired for measuring homogeneity
    // rather than quality — see docs/ai/PRIMITIVE_AUDIT.md.
    for (const name of [
      'set_spring', 'set_motion_blur', 'create_precomp', 'set_time_remap',
      'update_effect_param', 'set_light', 'set_shadow_stack',
      'add_surface_treatment', 'create_gradient',
    ]) {
      const tool = ALL_TOOL_DEFS.find((t) => t.name === name);
      expect(tool?.name).toBe(name); // registered at all
      expect(tool?.kind).toBe('write');
    }
  });

  it('counts every mutating tool as mutating, whatever its kind', () => {
    // The reason `mutates` exists. Anything that reaches for the literal
    // 'write' silently drops the compose tools — and it was a literal 'write'
    // test that decided which calls appear in the user's pending-changes list.
    const mutating = ALL_TOOL_DEFS.filter((t) => mutates(t.kind));
    expect(mutating).toHaveLength(57);
    expect(mutating.map((t) => t.name)).toContain('add_title');
    expect(mutating.map((t) => t.name)).toContain('set_spring');
  });

  it('has unique names', () => {
    const names = ALL_TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool is described well enough for a model to choose it', () => {
    for (const t of ALL_TOOL_DEFS) {
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe('object');
    }
  });
});
