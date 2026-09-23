import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';

jest.useFakeTimers();

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

test('create a layer, set a property, undo, redo', async () => {
  const start = h.doc();
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', init: [] });
  expect(layer).toBeTruthy();
  const afterCreate = h.doc();
  await h.run({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x: 10, y: 20 } } });
  const v = await h.query({ type: 'getPropertyValues', props: [{ layer, path: 'transform/position' }], time: 0, evaluated: true });
  expect(v.values[0]!.value).toEqual({ kind: 'vec2', value: { x: 10, y: 20 } });
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(afterCreate);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(start);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(afterCreate);
  const k = await h.run({ type: 'setAnimated', prop: { layer, path: 'transform/opacity' }, animated: true, time: sec(1) });
  expect(k.keyframe).toMatch(/^k\d+$/);
});
