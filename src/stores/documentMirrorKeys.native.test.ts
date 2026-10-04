/**
 * The mirror's coarse-versus-narrow keys. A viewport drag step is a value write
 * on one layer; the keys that wake EVERY panel of the editor (`doc`) and every
 * row that resolves names (`struct:`) must stay narrow, or one pointer move
 * re-renders the whole UI (src/layout/dragRenderScope.test.tsx measures that):
 *
 *   value write      → prop: / value: / grp:<layer>|<root> / tree: / doc — NOT struct: / docStruct
 *   header write     → layer: / doc / docStruct
 *   tree shape       → struct: / grp: / doc / docStruct   (an effect added)
 */
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from './documentMirror';

async function setup(): Promise<{ layer: string; count: (key: string) => number; dispose: () => Promise<void>; run: (c: never) => Promise<unknown> }> {
  const h = await setupAppEngine();
  const m = documentMirror().start();
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'S', init: [] });
  await m.whenIdle();
  // Load (and keep) the layer's property tree, as an Inspector does.
  const release = m.retainTree(layer);
  await m.loadTree(layer);
  await m.whenIdle();
  expect(m.tree(layer)).toBeDefined();
  const hits = new Map<string, number>();
  const keys = [`prop:${layer}|transform/position`, `value:${layer}|transform/position`, `tree:${layer}`, `struct:${layer}`,
    `grp:${layer}|transform`, `grp:${layer}|layer`, `grp:${layer}|effects`, `layer:${layer}`, 'doc', 'docStruct'];
  const offs = keys.map((k) => m.subscribe([k], () => hits.set(k, (hits.get(k) ?? 0) + 1)));
  return {
    layer,
    count: (k) => hits.get(k) ?? 0,
    run: (c) => h.run(c as never),
    dispose: async () => {
      for (const o of offs) o();
      release();
      await h.dispose();
    },
  };
}

it('a value write wakes the property / its root group / the tree / doc, and NOT struct or docStruct', async () => {
  const t = await setup();
  try {
    await t.run({ type: 'setProperty', prop: { layer: t.layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 12, y: 34 } }, time: 0 } as never);
    await documentMirror().whenIdle();
    expect(t.count(`prop:${t.layer}|transform/position`)).toBe(1);
    expect(t.count(`value:${t.layer}|transform/position`)).toBe(1);
    expect(t.count(`grp:${t.layer}|transform`)).toBe(1);
    expect(t.count(`tree:${t.layer}`)).toBe(1);
    expect(t.count('doc')).toBe(1);
    // …and nothing that is not about this value.
    expect(t.count(`grp:${t.layer}|layer`)).toBe(0);
    expect(t.count(`grp:${t.layer}|effects`)).toBe(0);
    expect(t.count(`struct:${t.layer}`)).toBe(0);
    expect(t.count('docStruct')).toBe(0);
    expect(t.count(`layer:${t.layer}`)).toBe(0);
  } finally {
    await t.dispose();
  }
});

it('a header write (rename) wakes layer: and docStruct but not the tree keys', async () => {
  const t = await setup();
  try {
    await t.run({ type: 'renameLayer', layer: t.layer, name: 'Renamed' } as never);
    await documentMirror().whenIdle();
    expect(t.count(`layer:${t.layer}`)).toBe(1);
    expect(t.count('docStruct')).toBe(1);
    expect(t.count('doc')).toBe(1);
    expect(t.count(`struct:${t.layer}`)).toBe(0);
    expect(t.count(`tree:${t.layer}`)).toBe(0);
  } finally {
    await t.dispose();
  }
});

it('a shape change (an effect added) wakes struct: and docStruct', async () => {
  const t = await setup();
  try {
    await t.run({ type: 'addEffect', layers: [t.layer], effect: 'glow', params: [] } as never);
    await documentMirror().whenIdle();
    expect(t.count(`struct:${t.layer}`)).toBeGreaterThanOrEqual(1);
    expect(t.count('docStruct')).toBeGreaterThanOrEqual(1);
    expect(documentMirror().tree(t.layer)?.nodes.has('effects')).toBe(true);
  } finally {
    await t.dispose();
  }
});

it('structRevision moves on structure, not on a value write', async () => {
  const t = await setup();
  try {
    const m = documentMirror();
    const before = m.structRevision;
    await t.run({ type: 'setProperty', prop: { layer: t.layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 1, y: 2 } }, time: 0 } as never);
    await m.whenIdle();
    expect(m.structRevision).toBe(before);
    await t.run({ type: 'renameLayer', layer: t.layer, name: 'Again' } as never);
    await m.whenIdle();
    expect(m.structRevision).toBeGreaterThan(before);
  } finally {
    await t.dispose();
  }
});
