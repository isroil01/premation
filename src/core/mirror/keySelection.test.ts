/**
 * The keyframe selection's id adapter (core/mirror/keySelection.ts): the codec,
 * and resolving an id through the document mirror to the key, its property and
 * the tracks the diamond stands for — against the real engine.
 */

import { POSITION_PSEUDO_PROP } from '@motion/animation';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { sec, type Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { documentMirror } from '@stores/documentMirror';
import {
  parseSelectionKey,
  resolveSelectionKey,
  selectionKeyId,
  selectionLayerOf,
  selectionStoredRefs,
  trackSelectionId,
} from './keySelection';

describe('codec', () => {
  it('round-trips a whole key and a member row', () => {
    expect(parseSelectionKey(selectionKeyId('layer_1', 'k7'))).toEqual({ id: 'layer_1::k7', layer: 'layer_1', keyId: 'k7' });
    expect(parseSelectionKey(selectionKeyId('layer_1', 'k7', 1))).toEqual({ id: 'layer_1::k7#1', layer: 'layer_1', keyId: 'k7', member: 1 });
  });

  it('keeps engine ids that carry their own separators (mask snapshots, positional fallbacks)', () => {
    expect(parseSelectionKey(selectionKeyId('L', 'k3@m1'))?.keyId).toBe('k3@m1');
    expect(parseSelectionKey(selectionKeyId('L', '@L|x|1.5', 0))).toMatchObject({ keyId: '@L|x|1.5', member: 0 });
  });

  it('rejects what is not a selection id', () => {
    expect(parseSelectionKey('not-an-id')).toBeNull();
    expect(parseSelectionKey('::k1')).toBeNull();
    expect(parseSelectionKey('L::')).toBeNull();
    expect(selectionLayerOf('L::k1#0')).toBe('L');
  });
});

describe('resolving through the mirror', () => {
  let h: Harness & { engine: LocalEngine };
  let L = '';
  beforeEach(async () => {
    h = await setupAppEngine();
    L = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'L', init: [] })).layer;
    await h.run({
      type: 'addKeyframes',
      keys: [0, 1].flatMap((s) => [
        { prop: { layer: L, path: 'transform/scale' }, time: sec(s), value: { kind: 'vec2' as const, value: { x: 100 - s * 50, y: 100 } }, easing: 'linear' as const, spatialIn: [], spatialOut: [] },
        { prop: { layer: L, path: 'transform/position' }, time: sec(s), value: { kind: 'vec2' as const, value: { x: s * 10, y: 0 } }, easing: 'linear' as const, spatialIn: [], spatialOut: [] },
      ]),
    });
  });
  afterEach(async () => {
    await h.dispose();
  });

  const keyId = (path: string, i: number): string => documentMirror().keyframes(L, path)[i]!.id;

  it('a member row names one member; the whole key names every member', () => {
    const m = documentMirror();
    const id = keyId('transform/scale', 1);
    const y = resolveSelectionKey(m, trackSelectionId(m, L, 'scaleY', id));
    expect(y).toMatchObject({ path: 'transform/scale', index: 1, tracks: ['scaleY'], rowProp: 'scaleY', lookup: 'scaleY' });
    const whole = resolveSelectionKey(m, selectionKeyId(L, id));
    expect(whole?.tracks).toEqual(['scaleX', 'scaleY']);
  });

  it('the whole Position key is the merged Position row', () => {
    const m = documentMirror();
    const r = resolveSelectionKey(m, selectionKeyId(L, keyId('transform/position', 0)));
    expect(r?.rowProp).toBe(POSITION_PSEUDO_PROP);
    expect(r?.tracks.slice(0, 2)).toEqual(['x', 'y']);
  });

  it('decodes to stored positions for the core helpers', () => {
    const m = documentMirror();
    const refs = selectionStoredRefs(m, [trackSelectionId(m, L, 'scaleX', keyId('transform/scale', 1)), 'garbage', selectionKeyId(L, 'no-such-key')]);
    expect(refs).toEqual([{ nodeId: L, prop: 'scaleX', t: 1 }]);
  });

  it('a stale id resolves to nothing', () => {
    expect(resolveSelectionKey(documentMirror(), selectionKeyId(L, 'k999999'))).toBeNull();
  });
});
