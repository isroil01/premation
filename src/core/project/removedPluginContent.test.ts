/**
 * A project that used JavaScript plugins still opens; their effects and
 * layers are dropped as ONE entry with one notice (G2). Built-in effects and a
 * native SDK plugin's effects (loaded or not) are never touched.
 */

import type { Command, EngineClient } from '@motion/engine-api';
import { dropRemovedPluginContent } from './removedPluginContent';

function doc(nodes: unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version: 1, scene: { nodes } }));
}

function fakeClient(opts: { layers: Array<{ id: string; generator: string }>; nodes: unknown[]; batchOk?: boolean }) {
  const batches: Array<{ label: string; commands: Command[] }> = [];
  const client = {
    query: async (q: { type: string }) => {
      switch (q.type) {
        case 'listEffects': return { ok: true, value: { effects: [{ matchName: 'blur' }, { matchName: 'glow' }] } };
        case 'listPlugins': return { ok: true, value: { plugins: [{ id: 'com.native.fx', effects: ['com.native.fx.ripple'] }] } };
        case 'exportDocument': return { ok: true, value: { document: doc(opts.nodes) } };
        case 'getDocument': return { ok: true, value: { layers: opts.layers } };
        default: return { ok: false, error: { code: 'unsupported', message: q.type } };
      }
    },
    batch: async (label: string, commands: Command[]) => {
      batches.push({ label, commands });
      return opts.batchOk === false ? { ok: false, error: { code: 'internal', message: 'no' } } : { ok: true, value: [] };
    },
  } as unknown as EngineClient;
  return { client, batches };
}

const fx = (id: string, effects: Array<{ id: string; type: string }>) => ({ id, components: [{ id: `${id}_fx`, type: 'fx', props: { effects } }] });

describe('dropRemovedPluginContent', () => {
  it('drops JS plugin effects and plugin layer kinds as one entry, and says so once', async () => {
    const { client, batches } = fakeClient({
      layers: [{ id: 'a', generator: '' }, { id: 'b', generator: 'studio.acme.lab.spiral' }],
      nodes: [
        fx('a', [{ id: 'fx1', type: 'blur' }, { id: 'fx2', type: 'studio.acme.lab.glowish' }, { id: 'fx3', type: 'com.native.fx.ripple' }, { id: 'fx4', type: 'com.native.fx.other' }]),
        fx('b', [{ id: 'fx5', type: 'studio.acme.lab.x' }]),
      ],
    });
    const r = await dropRemovedPluginContent(client);
    expect(r).toMatchObject({ effects: 1, layers: 1 });
    expect(r!.message).toMatch(/1 effect and 1 layer from JavaScript plugins/);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.commands).toEqual([
      { type: 'removePropertyGroups', groups: [{ layer: 'a', path: 'effects/fx2' }] },
      { type: 'deleteLayers', layers: ['b'] },
    ]);
  });

  it('leaves a project with no plugin content alone', async () => {
    const { client, batches } = fakeClient({ layers: [{ id: 'a', generator: '' }], nodes: [fx('a', [{ id: 'fx1', type: 'glow' }])] });
    expect(await dropRemovedPluginContent(client)).toBeNull();
    expect(batches).toHaveLength(0);
  });

  it('never throws: a refused batch leaves the document as it opened', async () => {
    const { client } = fakeClient({ layers: [{ id: 'b', generator: 'x.y.z' }], nodes: [], batchOk: false });
    expect(await dropRemovedPluginContent(client)).toBeNull();
  });
});
