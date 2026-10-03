/**
 * The Smoother / Wiggler preview contract, through the engine.
 *
 * Both dialogs apply to the live animation as you type, which is only
 * acceptable if two things hold, and neither is obvious from reading the
 * dialogs:
 *
 *   1. Cancel restores the EXACT keyframes that were there. The transforms are
 *      lossy — the Smoother deletes keyframes and re-tangents the survivors —
 *      so "re-run with the original tolerance" is not a revert.
 *
 *   2. Every intermediate preview is invisible to undo, and OK records exactly
 *      one entry covering the net change (one engine gesture).
 */

import { type Keyframe } from '@motion/animation';
import type { Keyframe as ApiKeyframe } from '@motion/engine-api';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { buildScene } from '@core/engine/__testHelpers__/scene';
import { engineIdle } from '@core/engine/engineInstance';
import { compTime } from '@core/engine/propRefs';
import { fetchMemberTracks } from '@stores/memberTracks';
import { beginTrackPreview } from './assistantPreview';

let h: Harness;
let NODE: string;

const key = (i: number): ApiKeyframe => ({
  id: '', time: compTime(i * 0.1), value: { kind: 'vec2', value: { x: i * 10, y: i } },
  easing: i === 0 ? 'bezier' : 'linear', ...(i === 0 ? { bezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 } } : {}),
  continuous: false, roving: false, spatialInterp: 'linear', spatialIn: [], spatialOut: [], label: 0, dims: [],
});

beforeEach(async () => {
  h = await setupAppEngine();
  const s = await buildScene(h);
  NODE = s.A;
  await h.run({ type: 'setKeyframes', prop: { layer: NODE, path: 'transform/position' }, keys: Array.from({ length: 11 }, (_, i) => key(i)) });
  await engineIdle();
});
afterEach(async () => { await h.dispose(); });

const track = async (prop: string): Promise<Keyframe[]> => (await docView()).getTrackKeyframes(NODE, prop) ?? [];

/** The preview's "before", as the dialogs capture it: the engine's member key lists (`getMemberKeyframes`). */
async function originals(props: string[]): Promise<Map<string, Keyframe[]>> {
  return new Map((await fetchMemberTracks(NODE, props)).map((t) => [t.member, t.keyframes]));
}

it('restores the exact document on cancel, after several lossy previews', async () => {
  const before = (await h.doc());
  const preview = beginTrackPreview(NODE, await originals(['x', 'y']), 'The Smoother');
  for (const keep of [2, 5, 3]) {
    preview.apply(new Map([['x', preview.original('x').filter((_, i) => i % keep === 0)]]));
    await engineIdle();
  }
  expect((await h.doc())).not.toBe(before);
  await preview.restore();
  await engineIdle();
  expect((await h.doc())).toBe(before);
});

it('re-applies from the ORIGINAL each time, never from the last preview', async () => {
  const preview = beginTrackPreview(NODE, await originals(['x', 'y']), 'The Smoother');
  const thin = (keep: (i: number) => boolean) => new Map((['x', 'y'] as const).map((p) => [p, preview.original(p).filter((_, i) => keep(i))]));
  // A preview that deletes almost everything, then one that keeps more: the
  // second is only possible from the originals.
  preview.apply(thin((i) => i === 0 || i === 10));
  preview.apply(thin((i) => i % 2 === 0));
  await preview.commit();
  await engineIdle();
  expect((await track('x'))).toHaveLength(6);
  expect((await track('y'))).toHaveLength(6);
});

it('a member thinned alone is written as thinned; its sibling keeps every key (setMemberKeyframes)', async () => {
  const preview = beginTrackPreview(NODE, await originals(['x', 'y']), 'The Smoother');
  preview.apply(new Map([['x', preview.original('x').filter((_, i) => i % 2 === 0)]]));
  await preview.commit();
  await engineIdle();
  expect((await track('x')).map((k) => Math.round(k.value as number))).toEqual([0, 20, 40, 60, 80, 100]);
  expect((await track('y'))).toHaveLength(11);
});

it('records nothing while previewing and ONE entry on commit', async () => {
  const n = (await historyLabels()).length;
  const preview = beginTrackPreview(NODE, await originals(['x']), 'The Smoother');
  const original = preview.original('x');
  for (const stride of [2, 3, 4, 5]) {
    preview.apply(new Map([['x', original.filter((_, i) => i % stride === 0)]]));
    await engineIdle();
    expect((await historyLabels()).length).toBe(n);
  }
  await preview.commit();
  await engineIdle();
  expect((await historyLabels()).slice(n)).toEqual(['The Smoother']);
});

it('records nothing at all when cancelled', async () => {
  const before = (await h.doc());
  const n = (await historyLabels()).length;
  const preview = beginTrackPreview(NODE, await originals(['x']), 'The Smoother');
  preview.apply(new Map([['x', preview.original('x').slice(0, 3)]]));
  await preview.restore();
  await preview.commit();
  await engineIdle();
  expect((await historyLabels()).length).toBe(n);
  expect((await h.doc())).toBe(before);
});

it('ignores props it did not capture', async () => {
  const yBefore = JSON.stringify((await track('y')).map((k) => [k.t, k.value]));
  const preview = beginTrackPreview(NODE, await originals(['x']), 'The Smoother');
  preview.apply(new Map([['y', []]]));
  await preview.commit();
  await engineIdle();
  expect(JSON.stringify((await track('y')).map((k) => [k.t, k.value]))).toBe(yBefore);
});

it('captures nothing for a track with no keyframes', async () => {
  expect(beginTrackPreview(NODE, await originals(['rotation']), 'The Smoother').props).toEqual([]);
});
