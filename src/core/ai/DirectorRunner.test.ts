/**
 * The director's last mile: an SSE `tool_calls` event actually executing
 * against the real tool registry.
 *
 * Two independent bugs sat here, and the first hid the second:
 *
 *  1. Plans never arrived — the ToolPlanner's single-array output overran the
 *     model's output cap and was truncated (fixed by chunking in motion-back).
 *  2. **Even when one arrived, nothing would have run.** The backend's
 *     `ToolCall` names the tool in `tool`; this file read `call.name`, which is
 *     always `undefined` on that payload. Every director call would have
 *     executed as `registry.execute(undefined, …)`.
 *
 * Bug 2 could not surface until bug 1 was fixed, so no run in the audit's seven
 * ever reached it. This test reaches it without a provider: it feeds the exact
 * wire shape the backend emits and asserts real layers come out the other side.
 */

import { ToolRegistry } from '@motion/ai-tools';
import { runBackendDirector } from './DirectorRunner';
import { buildAiTools } from './toolHandlers';
import { createToolContext } from './toolContext';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { setToken } from '@core/api/client';

function bootCommandSystem(): void {
  const services: any = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) }));
}

function resetDocument(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  });
  getCommandSystem().getHistory().clear();
}

/** A Response whose body streams the given SSE events, as the backend sends them. */
function sseResponse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => undefined,
      }),
    },
  } as unknown as Response;
}

let registry: ToolRegistry;
let lastRequestBody: any;

beforeAll(() => {
  bootCommandSystem();
  registry = new ToolRegistry();
  for (const t of buildAiTools()) registry.register(t);
  setToken('test-token');
});

beforeEach(() => {
  resetDocument();
  lastRequestBody = undefined;
});

function mockFetch(events: unknown[]): void {
  (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
    lastRequestBody = JSON.parse(init.body);
    return sseResponse(events);
  });
}

const run = async () => {
  const ctx = createToolContext(new AbortController().signal);
  const writeNames = new Set(registry.list().filter((t) => t.kind !== 'read').map((t) => t.name));
  const res = await runBackendDirector(
    { provider: 'openai', model: 'gpt-4o', prompt: 'test', signal: new AbortController().signal },
    ctx,
    registry,
    writeNames,
  );
  return { ...res, layers: ctx.scene.all() };
};

describe('a backend tool_calls payload executes against the real registry', () => {
  it("reads the tool name from `tool`, the field the backend actually sends", async () => {
    // THE regression test. Before the fix this executed `undefined` three
    // times, reported three successful calls, and produced zero layers —
    // silently, because a failed tool result is not an exception.
    mockFetch([
      {
        type: 'tool_calls',
        iteration: 0,
        data: [
          { id: '1', tool: 'add_background', args: {}, reversible: true, order: 1, sourceStepId: 's1' },
          { id: '2', tool: 'add_title', args: { text: 'Cadence' }, reversible: true, order: 2, sourceStepId: 's2' },
          { id: '3', tool: 'add_light_sweep', args: {}, reversible: true, order: 3, sourceStepId: 's3' },
        ],
      },
    ]);

    const res = await run();

    expect(res.toolCallCount).toBe(3);
    // The point of the test: LAYERS EXIST. A count of executed calls proves
    // nothing on its own — the broken version reported three of those too, and
    // produced an empty composition.
    const names = res.layers.map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining([expect.stringMatching(/Background/i)]));
    expect(names).toEqual(expect.arrayContaining([expect.stringMatching(/Light Sweep/i)]));
    expect(res.changes).toHaveLength(3);
  });

  it('still accepts `name`, so any other producer keeps working', async () => {
    mockFetch([
      { type: 'tool_calls', iteration: 0, data: [{ id: '1', name: 'add_background', args: {} }] },
    ]);
    const res = await run();
    expect(res.toolCallCount).toBe(1);
    expect(res.changes).toHaveLength(1);
  });

  it('skips a malformed entry rather than aborting the whole plan', async () => {
    // The directors spend minutes building a plan. One bad entry should cost
    // one layer, not the run.
    mockFetch([
      {
        type: 'tool_calls',
        iteration: 0,
        data: [
          { id: '1', args: {} }, // no tool, no name
          { id: '2', tool: 'add_background', args: {} },
        ],
      },
    ]);
    const res = await run();
    expect(res.toolCallCount).toBe(1);
    expect(res.changes).toHaveLength(1);
  });

  it('sends the live tool registry so the backend plans in a vocabulary that exists', async () => {
    // The backend's own copy of this list had drifted to eleven camelCase names
    // against a registry of forty-five snake_case ones.
    mockFetch([{ type: 'tool_calls', iteration: 0, data: [] }]);
    await run();

    const cat = lastRequestBody.toolCatalog;
    const names: string[] = cat.map((t: any) => t.name);

    // Schemas, not just names. Names alone produced 39 rejected calls out of 45
    // in a live run — every tool sets additionalProperties:false, so the
    // planner must be given the argument contract, not a prose description.
    const camera = cat.find((t: any) => t.name === 'add_camera_move');
    expect(camera.inputSchema).toBeDefined();
    expect(camera.inputSchema.properties.kind.enum).toEqual(['push_in', 'pull_out']);
    expect(cat.every((t: any) => t.inputSchema && t.inputSchema.type === 'object')).toBe(true);
    expect(names).toContain('add_title');
    expect(names).toContain('define_style');
    expect(names).not.toContain('createLayer'); // the stale backend vocabulary
    expect(names.length).toBeGreaterThan(40);
  });
});
