/**
 * B3z-c: the last UI writes' engine gaps, closed in both engines (ENGINE_API.md
 * §15.9) — custom label colours, footage labels by palette id, rename with
 * expression repair, Remove Pulldown, … Each: one entry, exact undo, redo.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { useAssetStore } from '@stores/assetStore';
import type { Command } from '@motion/engine-api';
import { setupAppEngine } from '../__testHelpers__/appEngine';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import type { Harness } from '../__testHelpers__/harness';
import type { LocalEngine } from '../LocalEngine';

let h: Harness & { engine: LocalEngine };
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
});
afterEach(async () => {
  await h.dispose();
});

/** Run, check one exact undo and a redo that lands on the same document. */
async function exact(cmd: Command | Command[]): Promise<unknown> {
  const before = h.doc();
  const res = Array.isArray(cmd) ? await h.batch('B', cmd) : await h.run(cmd);
  const after = h.doc();
  await h.run({ type: 'undo' });
  expect(h.doc()).toEqual(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toEqual(after);
  return res;
}

const refused = async (cmd: Command, code: string): Promise<void> => {
  const before = h.doc();
  const r = await h.engine.execute(cmd);
  expect(r.ok ? 'ok' : r.error.code).toBe(code);
  expect(h.doc()).toBe(before);
};

describe('label colours', () => {
  it('a custom layer label colour is stored verbatim and reported as labelColor; a palette colour as its index', async () => {
    await exact({ type: 'setLayerSwitches', layers: [s.A], patch: { labelColor: '#123456' } });
    expect(defaultSceneGraph.getNode(s.A)!.color).toBe('#123456');
    const doc = await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    const a = doc.layers.find((l) => l.id === s.A)!;
    expect(a.switches.label).toBe(0);
    expect(a.switches.labelColor).toBe('#123456');
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { labelColor: '#5282b8' } });
    const doc2 = await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    const a2 = doc2.layers.find((l) => l.id === s.A)!;
    expect(a2.switches.label).toBe(1);
    expect(a2.switches.labelColor).toBeUndefined();
    await exact({ type: 'setLayerSwitches', layers: [s.A], patch: { labelColor: '' } });
    expect(defaultSceneGraph.getNode(s.A)!.color).toBeUndefined();
  });

  it('refuses a malformed colour and label + labelColor together', async () => {
    await refused({ type: 'setLayerSwitches', layers: [s.A], patch: { labelColor: 'red' } }, 'invalidArgument');
    await refused({ type: 'setLayerSwitches', layers: [s.A], patch: { labelColor: '#12345' } }, 'invalidArgument');
    await refused({ type: 'setLayerSwitches', layers: [s.A], patch: { label: 2, labelColor: '#123456' } }, 'invalidArgument');
  });

  it('footage labels are stored as the palette id and read back as the index', async () => {
    await exact({ type: 'setItemLabel', items: [s.footage], label: 3 });
    const a = useAssetStore.getState().assets.find((x) => x.id === s.footage)!;
    expect(a.label).toBe('coral');
    const items = await h.query({ type: 'getItems', items: [s.footage] });
    expect(items.items.find((i) => i.id === s.footage)!.label).toBe(3);
  });
});

describe('renameLayer follows the expressions that name the layer', () => {
  it('repairs references that resolved to the layer, keeps the enabled flag, one entry', async () => {
    await h.run({ type: 'renameLayer', layer: s.A, name: 'Hero' });
    await h.run({ type: 'setExpression', prop: { layer: s.B, path: 'transform/opacity' }, source: "thisComp.layer('Hero').transform.opacity", enabled: false });
    await h.run({ type: 'setExpression', prop: { layer: s.B, path: 'transform/rotation' }, source: 'layer("Hero").rotation + layerAt( "Hero" ).rotation + layer("#x").rotation', enabled: true });
    const res = await exact({ type: 'renameLayer', layer: s.A, name: 'Villain' }) as { repaired: number; captured: number; nameAlreadyInUse: boolean };
    expect(res).toEqual({ repaired: 2, captured: 0, nameAlreadyInUse: false });
    const exprs = defaultAnimation.allExpressions().filter((e) => e.nodeId === s.B);
    expect(exprs.map((e) => e.src).sort()).toEqual([
      "thisComp.layer('Villain').transform.opacity",
      // The rewrite drops the whitespace inside the call (layerNameRefs.ts, both engines).
      'layer("Villain").rotation + layerAt("Villain" ).rotation + layer("#x").rotation',
    ].sort());
    expect(exprs.some((e) => !defaultAnimation.isExpressionEnabled(e.nodeId, e.prop))).toBe(true);
  });

  it('leaves references to ANOTHER layer of the same name, and reports a capture', async () => {
    // B is named 'Twin' first (it resolves 'Twin'); A takes the name → A comes first in document order.
    await h.run({ type: 'renameLayer', layer: s.B, name: 'Twin' });
    await h.run({ type: 'setExpression', prop: { layer: s.B, path: 'transform/opacity' }, source: "layer('Twin').opacity", enabled: true });
    const firstIsA = (() => {
      let first: string | null = null;
      defaultSceneGraph.traverse((n) => { if (first === null && (n.id === s.A || n.id === s.B)) first = n.id; });
      return first === s.A;
    })();
    const res = await exact({ type: 'renameLayer', layer: s.A, name: 'Twin' }) as { repaired: number; captured: number; nameAlreadyInUse: boolean };
    expect(res.repaired).toBe(0);
    expect(res.nameAlreadyInUse).toBe(true);
    expect(res.captured).toBe(firstIsA ? 1 : 0);
  });
});

describe('Remove Pulldown', () => {
  it('arms and clears the phase, read back in the interpretation', async () => {
    await exact({ type: 'setInterpretation', items: [s.footage], patch: { removePulldown: 3 } });
    const items = await h.query({ type: 'getItems', items: [s.footage] });
    expect(items.items.find((i) => i.id === s.footage)!.interpretation?.removePulldown).toBe(3);
    await exact({ type: 'setInterpretation', items: [s.footage], patch: { clearRemovePulldown: true } });
    expect(useAssetStore.getState().assets.find((x) => x.id === s.footage)!.interpret?.pulldownPhase).toBeUndefined();
    await refused({ type: 'setInterpretation', items: [s.footage], patch: { removePulldown: 5 } }, 'outOfRange');
    await refused({ type: 'setInterpretation', items: [s.footage], patch: { removePulldown: 1, clearRemovePulldown: true } }, 'invalidArgument');
  });
});

describe('history: checkpoints and version restore', () => {
  it('a checkpoint is a named entry that changes nothing; undo/redo over it keep the document', async () => {
    await h.run({ type: 'renameLayer', layer: s.A, name: 'One' });
    const before = h.doc();
    await h.run({ type: 'addHistoryCheckpoint', label: 'Client v1' });
    const hist = await h.query({ type: 'getHistory' });
    expect(hist.entries.at(-1)?.label).toBe('Client v1');
    expect(h.doc()).toBe(before);
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(before);
    await h.run({ type: 'redo' });
    await h.run({ type: 'renameLayer', layer: s.A, name: 'Two' });
    await h.run({ type: 'jumpToHistory', position: hist.entries.length });
    expect(h.doc()).toBe(before);
    await refused({ type: 'addHistoryCheckpoint', label: '  ' } as never, 'invalidArgument');
  });

  it('restoreDocument replaces the document as ONE undoable entry (history kept)', async () => {
    await h.run({ type: 'saveProject', path: 'C:/p/v1.motion', copy: true });
    const v1 = h.doc();
    await h.run({ type: 'renameLayer', layer: s.A, name: 'Later' });
    await h.run({ type: 'deleteLayers', layers: [s.B] });
    const later = h.doc();
    const n = (await h.query({ type: 'getHistory' })).entries.length;
    const bytes = new TextEncoder().encode(JSON.stringify(h.files.get('C:/p/v1.motion')));
    await h.run({ type: 'restoreDocument', document: bytes });
    expect(h.doc()).toBe(v1);
    const hist = await h.query({ type: 'getHistory' });
    expect(hist.entries).toHaveLength(n + 1);
    expect(hist.entries.at(-1)?.label).toBe('Restore Version');
    await h.run({ type: 'undo' });
    expect(h.doc()).toBe(later);
    await h.run({ type: 'redo' });
    expect(h.doc()).toBe(v1);
  });

  it('refuses a malformed or newer document and changes nothing', async () => {
    await refused({ type: 'restoreDocument', document: new TextEncoder().encode('{nope') }, 'decode');
    await refused({ type: 'restoreDocument', document: new TextEncoder().encode(JSON.stringify({ version: '99.0.0' })) }, 'unsupported');
  });
});