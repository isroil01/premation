/**
 * The plugin API's 1:1 verbs go through the engine API (B3 / ENGINE_API.md
 * §12): the same commands the UI sends, `origin: plugin`, one undo entry per
 * call named after the plugin, exact undo / redo.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getNodeEffects } from '@core/effects/effects';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { createHostApi } from './hostApi';
import type { PluginManifest } from './manifest';

const manifest = {
  id: 'studio.acme.tool', name: 'Tool', version: '1.0.0', description: 'A tool.', apiVersion: 5,
  main: 'main.js', permissions: [], activationEvents: ['onStartup'],
  contributes: { commands: [], panels: [], layerKinds: [], effects: [], net: null },
} as unknown as PluginManifest;

const api = createHostApi(manifest, {
  registerCommand: () => {}, openPanel: () => {}, closePanel: () => {}, warn: () => {},
  granted: () => new Set<never>(),
});

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => { h = await setupAppEngine(); s = await buildScene(h); });
afterEach(async () => { await h.dispose(); });

async function oneEntry(run: () => unknown, label: string): Promise<void> {
  const before = h.doc();
  const n = historyLabels().length;
  await run();
  const after = h.doc();
  expect(after).not.toBe(before);
  expect(historyLabels()).toHaveLength(n + 1);
  expect(historyLabels().at(-1)).toBe(label);
  expect(h.engine.historyState().entries.at(-1)?.origin).toBe('plugin');
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

it('rename / visibility / lock / parent / delete: one engine entry each, origin plugin', async () => {
  await oneEntry(() => api['scene.renameLayer']!(s.A, 'Hero'), 'Tool: rename layer');
  expect(defaultSceneGraph.getNode(s.A)!.name).toBe('Hero');
  await oneEntry(() => api['scene.setVisible']!(s.A, false), 'Tool: hide Hero');
  await oneEntry(() => api['scene.setLocked']!(s.B, true), 'Tool: lock B');
  await oneEntry(() => api['scene.setParent']!(s.T, s.P), 'Tool: reparent T');
  expect(defaultSceneGraph.getNode(s.T)!.parent).toBe(s.P);
  await oneEntry(() => api['scene.deleteLayer']!(s.V), 'Tool: delete V');
  expect(defaultSceneGraph.getNode(s.V)).toBeUndefined();
});

it('effects.add returns the engine id; effects.remove removes it', async () => {
  let fx = '';
  await oneEntry(async () => { fx = await (api['effects.add']!(s.B, 'blur') as Promise<string>); }, 'Tool: add blur');
  expect(getNodeEffects(s.B).map((e) => e.id)).toContain(fx);
  await oneEntry(() => api['effects.remove']!(s.B, fx), 'Tool: remove effect');
});

it('a refused engine command rejects the call and changes nothing', async () => {
  const before = h.doc();
  await api['scene.setParent']!(s.T, s.P);
  await expect(api['scene.setParent']!(s.P, s.T)).rejects.toThrow(/cannot be parented there/);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
});
