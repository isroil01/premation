/**
 * Content whose plugin is missing is never deleted: the scan only reports it,
 * with one notice naming the plugins. Built-in effects and a native SDK
 * plugin's effects (loaded or not) do not count as missing.
 */

import type { Command, EngineClient } from '@motion/engine-api';
import { findMissingPluginContent, pluginOfType } from './missingPluginContent';

function doc(nodes: unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version: 1, scene: { nodes } }));
}

function fakeClient(opts: { layers: Array<{ id: string; generator: string }>; nodes: unknown[]; failDoc?: boolean }) {
  const writes: Array<{ label: string; commands: Command[] }> = [];
  const client = {
    query: async (q: { type: string }) => {
      switch (q.type) {
        case 'listEffects': return { ok: true, value: { effects: [{ matchName: 'blur' }, { matchName: 'glow' }] } };
        case 'listPlugins': return { ok: true, value: { plugins: [{ id: 'com.native.fx', effects: ['com.native.fx.ripple'] }] } };
        case 'exportDocument':
          return opts.failDoc ? { ok: false, error: { code: 'internal', message: 'no' } } : { ok: true, value: { document: doc(opts.nodes) } };
        case 'getDocument': return { ok: true, value: { layers: opts.layers } };
        default: return { ok: false, error: { code: 'unsupported', message: q.type } };
      }
    },
    batch: async (label: string, commands: Command[]) => {
      writes.push({ label, commands });
      return { ok: true, value: [] };
    },
    execute: async (command: Command) => {
      writes.push({ label: '', commands: [command] });
      return { ok: true, value: {} };
    },
  } as unknown as EngineClient;
  return { client, writes };
}

const fx = (id: string, effects: Array<{ id: string; type: string }>) => ({ id, components: [{ id: `${id}_fx`, type: 'fx', props: { effects } }] });

describe('findMissingPluginContent', () => {
  it('reports unknown effects and plugin layers, names their plugins, and deletes nothing', async () => {
    const { client, writes } = fakeClient({
      layers: [{ id: 'a', generator: '' }, { id: 'b', generator: 'studio.acme.lab.spiral' }],
      nodes: [
        fx('a', [{ id: 'fx1', type: 'blur' }, { id: 'fx2', type: 'com.vendor.pack.glowish' }, { id: 'fx3', type: 'com.native.fx.ripple' }, { id: 'fx4', type: 'com.native.fx.other' }]),
        fx('b', [{ id: 'fx5', type: 'studio.acme.lab.x' }]),
      ],
    });
    const r = await findMissingPluginContent(client);
    expect(r).toMatchObject({ effects: 2, layers: 1, plugins: ['com.vendor.pack', 'studio.acme.lab'] });
    expect(r!.message).toMatch(/^Missing plugins com\.vendor\.pack, studio\.acme\.lab\./);
    expect(r!.message).toMatch(/2 effects and 1 layer are kept/);
    expect(writes).toHaveLength(0);
  });

  it('leaves a project with no missing plugin alone', async () => {
    const { client } = fakeClient({ layers: [{ id: 'a', generator: '' }], nodes: [fx('a', [{ id: 'fx1', type: 'glow' }])] });
    expect(await findMissingPluginContent(client)).toBeNull();
  });

  it('never throws: a failed query reports nothing', async () => {
    const { client } = fakeClient({ layers: [{ id: 'b', generator: 'x.y.z' }], nodes: [], failDoc: true });
    expect(await findMissingPluginContent(client)).toBeNull();
  });

  it('names an effect type by its namespace', () => {
    expect(pluginOfType('com.vendor.pack.glow')).toBe('com.vendor.pack');
    expect(pluginOfType('legacy')).toBe('legacy');
  });
});
