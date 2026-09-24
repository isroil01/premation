/**
 * The join between the property tree and the engine's keyframes.
 *
 * What is being pinned here is the SPLIT: a group row stands in for its members
 * while none of them is keyed, and gives way to their real per-property rows the
 * moment one is — except Position, which stays one row because a position
 * keyframe is one keyframe holding two numbers.
 */

import { POSITION_PSEUDO_PROP } from '@motion/animation';
import { getNodeEffects, effectPropPath, effectDefFor, effectOpacityPath } from '@core/effects/effects';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import type { Value } from '@motion/engine-api';
import { buildPropertyRows } from './buildPropertyRows';

// The rows are the document MIRROR's keyframes (B4), so the fixture is a real
// shape layer in the app engine, keyed through the engine API.
let h: Harness & { engine: LocalEngine };
let A = '';

const byLabel = (nodeId: string) => new Map(buildPropertyRows(nodeId).map((r) => [r.label, r]));

/** Key one property of layer A at each of `times` (seconds), all to `value`. */
async function key(path: string, times: number[], value: Value): Promise<void> {
  await h.run({
    type: 'addKeyframes',
    keys: times.map((t) => ({ prop: { layer: A, path }, time: sec(t), value, spatialIn: [], spatialOut: [] })),
  });
}

/** Glow on A through the engine: its id and the key of its first number param. */
async function addGlow(): Promise<{ group: string; fxId: string; param: string }> {
  const { groups: [group] } = await h.run({ type: 'addEffect', layers: [A], effect: 'glow', params: [] });
  const fx = getNodeEffects(A)[0]!;
  expect(group).toBe(`effects/${fx.id}`);
  const param = effectDefFor(fx.type)!.params.find((p) => p.type === 'number')!.key;
  return { group: group!, fxId: fx.id, param };
}

beforeEach(async () => {
  h = await setupAppEngine();
  A = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: 'a', init: [] })).layer;
});

afterEach(async () => {
  await h.dispose();
});

describe('placeholder rows', () => {
  it('stand in for their members, unlit, with a stopwatch that keys all of them', () => {
    const scale = byLabel(A).get('Scale')!;
    expect(scale.animated).toBe(false);
    expect(scale.keyframes).toHaveLength(0);
    expect(scale.stopwatchProps).toEqual(['scaleX', 'scaleY']);
  });

  it('give way to the real per-property rows once the property is keyed', async () => {
    // One key on Scale is one key holding both numbers (ENGINE_API.md §3.3),
    // so both member rows appear and each draws that key.
    await key('transform/scale', [0], { kind: 'vec2', value: { x: 100, y: 100 } });
    const rows = byLabel(A);
    expect(rows.has('Scale')).toBe(false);
    expect(rows.get('Scale X')!.keyframes).toHaveLength(1);
    expect(rows.get('Scale Y')!.keyframes).toHaveLength(1);
    // Nothing that was NOT keyed splits: its placeholder stays one unlit line.
    expect(rows.get('Anchor Point')!.animated).toBe(false);
    expect(rows.has('Anchor Point X')).toBe(false);
  });
});

describe('Position stays one row', () => {
  it('draws one diamond per Position key, X and Y together', async () => {
    await key('transform/position', [0], { kind: 'vec2', value: { x: 0, y: 0 } });
    await key('transform/position', [1], { kind: 'vec2', value: { x: 100, y: 0 } });
    const rows = byLabel(A);
    const position = rows.get('Position')!;
    expect(position.prop).toBe(POSITION_PSEUDO_PROP);
    expect(position.keyframes).toHaveLength(2); // t=0 (both axes) and t=1
    expect(position.stopwatchProps).toEqual(['x', 'y']);
    expect(rows.has('Position X')).toBe(false);
    expect(rows.has('Position Y')).toBe(false);
  });
});

describe('effect parameters', () => {
  it('appear as rows before they are keyed, under the Effects group', async () => {
    const { fxId, param } = await addGlow();
    const row = buildPropertyRows(A).find((r) => r.stopwatchProps?.[0] === effectPropPath(fxId, param));
    expect(row).toBeDefined();
    expect(row!.animated).toBe(false);
    expect(row!.group).toBe('effects');
  });

  it('carry their keyframes once keyed', async () => {
    const { group, fxId, param } = await addGlow();
    const path = effectPropPath(fxId, param);
    await key(`${group}/${param}`, [0], { kind: 'scalar', value: 10 });
    await key(`${group}/${param}`, [1], { kind: 'scalar', value: 40 });
    const row = buildPropertyRows(A).find((r) => r.prop === path)!;
    expect(row.animated).not.toBe(false);
    expect(row.keyframes).toHaveLength(2);
    expect(row.group).toBe('effects');
  });
  it('Compositing ▸ Effect Opacity keeps its own row once keyed (no stray engine-named row)', async () => {
    const { group, fxId } = await addGlow();
    await key(`${group}/compositing/opacity`, [0, 1], { kind: 'scalar', value: 50 });
    const rows = buildPropertyRows(A);
    expect(rows.some((r) => r.label.includes('ADBE Effect Mask Opacity'))).toBe(false);
    const opacity = rows.filter((r) => r.prop === effectOpacityPath(fxId));
    expect(opacity).toHaveLength(1);
    expect(opacity[0]!.keyframes).toHaveLength(2);
  });
});

describe('tracks the tree does not describe', () => {
  it('are appended rather than dropped, and still get a heading', async () => {
    // Skew is a keyframeable property of the layer that the timeline's static
    // property tree has no row for. The keyframes are real, so hiding them
    // would hide real work: the row goes after every tree row, under a heading.
    const staticRows = buildPropertyRows(A);
    expect(staticRows.some((r) => r.prop === 'skew' || r.stopwatchProps?.includes('skew'))).toBe(false);

    await key('layer/skew', [0], { kind: 'scalar', value: 5 });
    const rows = buildPropertyRows(A);
    const row = rows.find((r) => r.prop === 'skew');
    expect(row).toBeDefined();
    expect(row!.group).toBe('transform');
    expect(row!.keyframes).toHaveLength(1);
    expect(rows.indexOf(row!)).toBe(rows.length - 1);
    expect(rows).toHaveLength(staticRows.length + 1);
  });
});
