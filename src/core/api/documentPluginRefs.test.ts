/**
 * A saved document says which plugins it needs.
 *
 * The invariant this replaces was load-bearing: documents never referenced
 * plugins, so a `.premation` file opened identically everywhere. Now one can,
 * and the whole value of that trade depends on the document being able to NAME
 * what it depends on. Without this list the editor can tell a user "this layer
 * needs a plugin" and not which — and an id alone is what
 * `premation://plugin/<id>` needs to offer them the install.
 *
 * The case that matters most is the one where nothing is installed. That is
 * exactly the machine whose user needs to be told, and exactly the machine
 * where a list derived from "what is installed" would be empty.
 */

import { captureDocument, restoreDocument } from './cloudDocument';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { buildCustomLayerNode } from '@core/plugins/customLayers';
import { usePluginStore } from '@stores/pluginStore';
import type { LayerKindContribution } from '@core/plugins/layerKindSchema';

const KIND = (id: string): LayerKindContribution => ({
  id,
  label: id,
  render: 'proxy',
  schemaVersion: 1,
  props: { focal: { type: 'number', default: 50 } },
});

const ACME = 'studio.acme.lab';
const OTHER = 'studio.other.tools';

/** Only the field under test — the rest of a document is not this test's business. */
const refs = (): unknown => captureDocument().plugins;

beforeEach(async () => {
  await usePluginStore.getState().hydrate();
  for (const p of [...usePluginStore.getState().plugins]) usePluginStore.getState().remove(p.manifest.id);
  // `seedDefaultScene` seeds; it does not clear. Without this, nodes added by
  // one test are still in the graph for the next, and every assertion after
  // the first is reading someone else's document.
  defaultSceneGraph.clear();
  seedDefaultScene();
});

describe('what a captured document records', () => {
  it('is absent when there are no custom layers', () => {
    // Absent rather than `[]`, so every document written before this field
    // existed reads back byte-identical and needs no migration.
    expect(refs()).toBeUndefined();
  });

  it('names both plugins in a two-plugin document, and the kinds each is used for', () => {
    defaultSceneGraph.addNode(buildCustomLayerNode('n1', ACME, KIND('depthImage')));
    defaultSceneGraph.addNode(buildCustomLayerNode('n2', ACME, KIND('rig')));
    defaultSceneGraph.addNode(buildCustomLayerNode('n3', OTHER, KIND('gizmo')));

    expect(refs()).toEqual([
      { id: ACME, kinds: ['depthImage', 'rig'] },
      { id: OTHER, kinds: ['gizmo'] },
    ]);
  });

  it('lists a plugin that is NOT installed', () => {
    /*
      The decisive case. A list derived from the installed set would be empty
      here — on the one machine whose user cannot open the document properly and
      needs to be told why.
    */
    defaultSceneGraph.addNode(buildCustomLayerNode('n1', 'studio.ghost.app', KIND('phantom')));
    expect(refs()).toEqual([{ id: 'studio.ghost.app', kinds: ['phantom'] }]);
  });

  it('adds version and publisher when the plugin IS installed', () => {
    // Advisory: enough to say "you have 1.0.0, this was made with 1.2.0", and
    // never used to gate opening the document.
    usePluginStore.getState().put({
      manifest: {
        id: ACME, name: 'Acme Lab', version: '1.2.0', description: 'x', author: 'Acme Studio',
        apiVersion: 3, main: 'main.js', permissions: [],
        contributes: { commands: [], panels: [], layerKinds: [], effects: [] },
        activationEvents: ['onStartup'],
      },
      granted: [],
      enabled: true,
      files: {},
      binaries: {},
      installedAt: 0,
      source: 'file',
    } as never);

    defaultSceneGraph.addNode(buildCustomLayerNode('n1', ACME, KIND('depthImage')));

    expect(refs()).toEqual([
      { id: ACME, version: '1.2.0', publisher: 'Acme Studio', kinds: ['depthImage'] },
    ]);
  });

  it('finds custom layers nested inside groups, not only at the root', () => {
    // A depth layer parented under a group is the normal case, and a capture
    // that only walked roots would list nothing for a document full of them.
    defaultSceneGraph.addNode({
      id: 'g1',
      name: 'Group',
      children: [],
      parent: null,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'g1_t', type: 'Transform', props: { __kind: 'group', x: 0, y: 0 } }],
    });
    defaultSceneGraph.addChild('g1', buildCustomLayerNode('n1', ACME, KIND('depthImage')));

    expect(refs()).toEqual([{ id: ACME, kinds: ['depthImage'] }]);
  });

  it('keeps a version the document already recorded, with nothing installed', () => {
    /*
      The re-save case, and the one that used to lose information silently.

      Version and publisher cannot be derived from the node tree — only looked
      up in the installed set or remembered. Deriving them from the installed
      set alone meant that opening a project on a machine WITHOUT the plugin and
      saving it back erased the version the document was carrying. Every
      subsequent reader then knew a plugin was missing but not which build of
      it, and the erasure was permanent.
    */
    restoreDocument({
      version: '1.1.0',
      scene: { version: '1.0.0', nodes: [buildCustomLayerNode('n1', ACME, KIND('depthImage'))] },
      animation: { tracks: {}, expressions: {} },
      plugins: [{ id: ACME, version: '1.4.0', publisher: 'Acme Studio', kinds: ['depthImage'] }],
    } as never);

    expect(refs()).toEqual([
      { id: ACME, version: '1.4.0', publisher: 'Acme Studio', kinds: ['depthImage'] },
    ]);
  });

  it('does not carry one document s versions into the next', () => {
    // The remembered map is per-document. A version leaking across an open
    // would be worse than losing it: the document would assert something false.
    restoreDocument({
      version: '1.1.0',
      scene: { version: '1.0.0', nodes: [buildCustomLayerNode('n1', ACME, KIND('depthImage'))] },
      animation: { tracks: {}, expressions: {} },
      plugins: [{ id: ACME, version: '1.4.0', kinds: ['depthImage'] }],
    } as never);
    restoreDocument({
      version: '1.1.0',
      scene: { version: '1.0.0', nodes: [buildCustomLayerNode('n1', ACME, KIND('depthImage'))] },
      animation: { tracks: {}, expressions: {} },
    } as never);

    expect(refs()).toEqual([{ id: ACME, kinds: ['depthImage'] }]);
  });

  it('prefers the installed version over the recorded one', () => {
    // The recorded value may be years old; the installed copy is what will
    // actually open the layer.
    usePluginStore.getState().put({
      manifest: {
        id: ACME, name: 'Acme Lab', version: '2.0.0', description: 'x', author: 'Acme Studio',
        apiVersion: 3, main: 'main.js', permissions: [],
        contributes: { commands: [], panels: [], layerKinds: [], effects: [] },
        activationEvents: ['onStartup'],
      },
      granted: [], enabled: true, files: {}, binaries: {}, installedAt: 0, source: 'file',
    } as never);

    restoreDocument({
      version: '1.1.0',
      scene: { version: '1.0.0', nodes: [buildCustomLayerNode('n1', ACME, KIND('depthImage'))] },
      animation: { tracks: {}, expressions: {} },
      plugins: [{ id: ACME, version: '1.4.0', kinds: ['depthImage'] }],
    } as never);

    expect(refs()).toEqual([
      { id: ACME, version: '2.0.0', publisher: 'Acme Studio', kinds: ['depthImage'] },
    ]);
  });

  it('is stable across repeated captures, so a re-save is not a diff', () => {
    defaultSceneGraph.addNode(buildCustomLayerNode('n1', OTHER, KIND('zed')));
    defaultSceneGraph.addNode(buildCustomLayerNode('n2', ACME, KIND('beta')));
    defaultSceneGraph.addNode(buildCustomLayerNode('n3', ACME, KIND('alpha')));

    expect(JSON.stringify(refs())).toBe(JSON.stringify(refs()));
    expect((refs() as Array<{ id: string }>)[0]!.id).toBe(ACME);
  });
});
