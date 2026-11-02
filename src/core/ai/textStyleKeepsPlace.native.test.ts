/**
 * A style edit (weight, size, family) re-lays out point text around the point
 * it is anchored at; it never moves the layer. Guards the 2026-11-02 audit
 * report of a 12 px title that sat ~77 px lower after a fontWeight change —
 * not reproduced through the tools, sequentially or with edits in parallel.
 */

import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { runToolTurn } from './aiTurn';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });

let h: Harness;
beforeEach(async () => { h = await setupAppEngine(); });
afterEach(async () => { await h.dispose(); });

interface Box { x: number; y: number; width: number; height: number }

async function call(name: string, args: Record<string, unknown>) {
  const r = (await runToolTurn(`AI: ${name}`, [{ name, args }])).results[0];
  if (!r?.ok) throw new Error(`${name} failed: ${r?.content ?? 'no result'}`);
  return r;
}

async function centre(id: string): Promise<{ x: number; y: number }> {
  const r = await call('inspect_layers', { nodeIds: [id], t: 0.5 });
  const b = (r.data as { layers: Array<{ bounds: Box }> }).layers[0]?.bounds;
  if (!b) throw new Error(`no bounds for ${id}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

it('point text stays centred on its position through weight, size and family edits', async () => {
  const id = (await call('create_layer', { kind: 'text', name: 'small', text: 'The quick brown fox jumps over the lazy dog', x: 960, y: 120 })).data as { id: string };
  const other = (await call('create_layer', { kind: 'text', name: 'big', text: 'Rg&@', stroke: '#1b1f2a', strokeWidth: 6, x: 1500, y: 260 })).data as { id: string };
  await call('update_layer', { nodeId: id.id, fontSize: 12, fontFamily: 'Arial' });
  const at = await centre(id.id);
  expect(Math.abs(at.x - 960)).toBeLessThan(1);
  expect(Math.abs(at.y - 120)).toBeLessThan(4);

  // Edits of two layers in flight at once, as an MCP client sends them.
  await Promise.all([
    call('update_layer', { nodeId: id.id, fontWeight: 400 }),
    call('update_layer', { nodeId: other.id, strokeWidth: 24 }),
  ]);
  await call('update_layer', { nodeId: id.id, fontWeight: 700 });
  const after = await centre(id.id);
  expect(Math.abs(after.x - at.x)).toBeLessThan(1);
  expect(Math.abs(after.y - at.y)).toBeLessThan(1);
});
