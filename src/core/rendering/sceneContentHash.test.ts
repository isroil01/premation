/**
 * The content hash.
 *
 * Two failure modes, pulling in opposite directions, and both silent:
 *
 *  • **Too coarse** — the hash misses a field that changes pixels, and the
 *    cache serves a stale frame after a real edit. This is the dangerous one,
 *    and it is why the hash serializes components wholesale instead of naming
 *    the props it thinks matter.
 *  • **Too sensitive** — the hash moves when nothing meaningful changed, and we
 *    are back to the revision counter this replaces, having paid a scene walk
 *    for it. Undo returning to a previously-hashed state is the case that
 *    motivated the whole change.
 *
 * So the tests come in pairs: this must change it, that must not.
 */

import {
  sceneContentHash,
  memoizedSceneContentHash,
  resetSceneContentHashMemo,
  type HashableGraph,
} from './sceneContentHash';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';

const node = (
  id: string,
  patch: Partial<{ parent: string | null; visible: boolean; locked: boolean; props: Record<string, unknown>; type: string }> = {},
): SceneNode =>
  ({
    id,
    name: id,
    parent: patch.parent ?? null,
    children: [],
    visible: patch.visible ?? true,
    locked: patch.locked ?? false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_c`, type: patch.type ?? 'Transform', props: patch.props ?? { x: 0, y: 0 } }],
  }) as unknown as SceneNode;

const graphOf = (nodes: SceneNode[]): HashableGraph => ({
  traverse: (visit) => { for (const n of nodes) visit(n); },
});

const emptyAnim = (): AnimationEngine => new AnimationEngine();

const hash = (nodes: SceneNode[], anim: AnimationEngine = emptyAnim()): string =>
  sceneContentHash(graphOf(nodes), anim);

beforeEach(resetSceneContentHashMemo);

describe('identical content hashes identically', () => {
  it('the same scene twice', () => {
    expect(hash([node('a'), node('b')])).toBe(hash([node('a'), node('b')]));
  });

  it('regardless of the order traverse happens to visit in', () => {
    // Sibling order IS meaningful, but it reaches the hash through each node's
    // own `parent`, not through walk order. Sorting makes the hash independent
    // of how the walk is implemented.
    expect(hash([node('a'), node('b')])).toBe(hash([node('b'), node('a')]));
  });

  it('regardless of the KEY ORDER inside a props bag', () => {
    // Object key order is insertion order in JS. Without stable stringify, a
    // prop rewritten to the same value in a different order reads as a change —
    // reintroducing the spurious invalidation this exists to remove.
    const a = node('a', { props: { x: 1, y: 2 } });
    const b = node('a', { props: { y: 2, x: 1 } });
    expect(hash([a])).toBe(hash([b]));
  });

  it('after a round trip — the case undo hits', () => {
    // THE motivating case. Edit and undo leaves the scene bit-identical, and
    // the hash must agree, or the cache is thrown away for nothing.
    const before = hash([node('a', { props: { x: 0 } })]);
    hash([node('a', { props: { x: 250 } })]);   // the edit
    const after = hash([node('a', { props: { x: 0 } })]); // the undo
    expect(after).toBe(before);
  });
});

describe('anything that moves pixels moves the hash', () => {
  it.each([
    ['a prop value', () => [node('a', { props: { x: 1 } })]],
    ['an added prop', () => [node('a', { props: { x: 0, y: 0, rotation: 5 } })]],
    ['a removed node', () => [node('a')]],
    ['an added node', () => [node('a'), node('b'), node('c')]],
    ['a renamed id', () => [node('z'), node('b')]],
    ['a reparent', () => [node('a', { parent: 'b' }), node('b')]],
    ['visibility', () => [node('a', { visible: false }), node('b')]],
    ['lock state', () => [node('a', { locked: true }), node('b')]],
    ['a component type', () => [node('a', { type: 'Style' }), node('b')]],
  ])('%s', (_label, build) => {
    const base = hash([node('a'), node('b')]);
    expect(hash(build())).not.toBe(base);
  });

  it('a nested prop, not just a top-level one', () => {
    const base = hash([node('a', { props: { fill: { type: 'solid', color: '#000' } } })]);
    const changed = hash([node('a', { props: { fill: { type: 'solid', color: '#fff' } } })]);
    expect(changed).not.toBe(base);
  });

  it('field boundaries are part of the content', () => {
    // Without a separator, ['ab','c'] and ['a','bc'] hash alike — so two
    // different scenes whose serialized text happens to concatenate the same
    // way would share a cache.
    expect(hash([node('ab'), node('c')])).not.toBe(hash([node('a'), node('bc')]));
  });
});

describe('animation is hashed too', () => {
  const scene = [node('a')];

  it('adding a keyframe changes it', () => {
    const before = hash(scene);
    const anim = emptyAnim();
    anim.setKeyframe('a', 'x', 0, 100);
    expect(hash(scene, anim)).not.toBe(before);
  });

  it('moving a keyframe VALUE changes it', () => {
    const one = emptyAnim();
    one.setKeyframe('a', 'x', 0, 100);
    const two = emptyAnim();
    two.setKeyframe('a', 'x', 0, 250);
    expect(hash(scene, one)).not.toBe(hash(scene, two));
  });

  it('moving a keyframe in TIME changes it', () => {
    const one = emptyAnim();
    one.setKeyframe('a', 'x', 0, 100);
    const two = emptyAnim();
    two.setKeyframe('a', 'x', 1, 100);
    expect(hash(scene, one)).not.toBe(hash(scene, two));
  });

  it('changing only the EASING changes it', () => {
    // Easing moves every in-between pixel while leaving both keyframe values
    // untouched — a hash over values alone would miss the entire curve.
    const one = emptyAnim();
    one.setKeyframe('a', 'x', 0, 0, 'linear');
    one.setKeyframe('a', 'x', 1, 100, 'linear');
    const two = emptyAnim();
    two.setKeyframe('a', 'x', 0, 0, 'linear');
    two.setKeyframe('a', 'x', 1, 100, 'linear');
    two.setBezier('a', 'x', 0, [0.7, 0, 0.84, 0]);
    expect(hash(scene, one)).not.toBe(hash(scene, two));
  });

  it('a track on a DIFFERENT property changes it', () => {
    const one = emptyAnim();
    one.setKeyframe('a', 'x', 0, 100);
    const two = emptyAnim();
    two.setKeyframe('a', 'y', 0, 100);
    expect(hash(scene, one)).not.toBe(hash(scene, two));
  });

  it('an identical animation built twice hashes the same', () => {
    const one = emptyAnim();
    one.setKeyframe('a', 'x', 0, 100);
    one.setKeyframe('a', 'x', 2, 300);
    const two = emptyAnim();
    two.setKeyframe('a', 'x', 2, 300); // authored in the other order
    two.setKeyframe('a', 'x', 0, 100);
    expect(hash(scene, one)).toBe(hash(scene, two));
  });
});

describe('the memo', () => {
  it('recomputes only when a revision moves', () => {
    let walks = 0;
    const counting: HashableGraph = {
      traverse: (visit) => { walks++; visit(node('a')); },
    };
    const anim = emptyAnim();
    memoizedSceneContentHash(counting, anim, 1, 1);
    memoizedSceneContentHash(counting, anim, 1, 1);
    memoizedSceneContentHash(counting, anim, 1, 1);
    expect(walks).toBe(1);

    memoizedSceneContentHash(counting, anim, 2, 1);
    expect(walks).toBe(2);
    memoizedSceneContentHash(counting, anim, 2, 2);
    expect(walks).toBe(3);
  });

  it('returns the same value the uncached call would', () => {
    const g = graphOf([node('a')]);
    const anim = emptyAnim();
    expect(memoizedSceneContentHash(g, anim, 5, 5)).toBe(sceneContentHash(g, anim));
  });
});

describe('distinctness at scale', () => {
  it('a thousand single-pixel edits produce a thousand distinct hashes', () => {
    // One 32-bit lane collides around the birthday bound (~77k), which a real
    // edit history reaches — and a collision here means showing a stale frame.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(hash([node('a', { props: { x: i } })]));
    expect(seen.size).toBe(1000);
  });
});
