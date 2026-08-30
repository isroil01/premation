/**
 * The clip-geometry fingerprint the viewport frame cache keys on.
 *
 * ── The bug this exists for ────────────────────────────────────────────
 * `sceneContentHash` is exhaustive over the scene graph and the animation
 * engine, and says so in its own header: "a field that affects pixels and is
 * not hashed produces a cache that serves a stale frame after a real edit,
 * silently."
 *
 * A clip bar is exactly such a field, and it is in NEITHER of those two places
 * — start, duration and source-in live in the Timeline Engine, whose edits
 * deliberately never bump the scene revision. So moving a bar changed the
 * picture and left the cache key identical. Frames rendered before the drag
 * stayed servable afterwards, playback interleaved them with fresh ones, and a
 * moved layer flickered in and out at times it no longer occupied until every
 * frame had been re-rendered.
 *
 * The properties that matter are all here: it CHANGES when geometry changes, it
 * does NOT change when geometry returns (or an undo would throw away a warm
 * cache for nothing), and it is blind to things that move no pixels.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import { clipGeometrySignature, getTimelineController } from './TimelineController';

const ROOT = 'comp_root';

function layer(id: string): void {
  defaultSceneGraph.addChild(ROOT, {
    id,
    name: id,
    parent: ROOT,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 100, y: 100, width: 50, height: 50 } },
    ],
  } as unknown as SceneNode);
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: ROOT,
    name: 'Composition 1',
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  layer('a');
  layer('b');
  /*
    A FULL controller reset per test, not just a scene one.

    The registries outlive `defaultSceneGraph.clear()`, and `syncFromScene`
    deliberately never touches the geometry of a clip it already has ("that's
    user-edited") — so without this, one test's trim and the next test's slip
    accumulate on the same bars, and the first test runs before any registry
    exists at all.
  */
  const controller = getTimelineController();
  controller.reset();
  // Lazily creates the composition's timeline, which `syncFromScene` needs to
  // exist before it will seed anything.
  controller.getLayersForNode('a');
  controller.syncFromScene(ROOT);
});

/** The clip backing `nodeId`. */
const clipOf = (nodeId: string) => getTimelineController().getLayersForNode(nodeId)[0]!;

describe('clipGeometrySignature', () => {
  it('covers every bar in the composition', () => {
    const sig = clipGeometrySignature(ROOT);
    expect(sig).toContain('a:');
    expect(sig).toContain('b:');
  });

  it('CHANGES when a bar moves — the whole point', () => {
    const before = clipGeometrySignature(ROOT);
    getTimelineController().setClipStart(clipOf('a').id, 2);
    expect(clipGeometrySignature(ROOT)).not.toBe(before);
  });

  it('changes when a bar is trimmed', () => {
    const before = clipGeometrySignature(ROOT);
    getTimelineController().trimClipTo(clipOf('a').id, 'end', 3);
    expect(clipGeometrySignature(ROOT)).not.toBe(before);
  });

  it('changes when the source is slipped under a fixed bar', () => {
    // Same bar, different content in it — pixels move, so the cache must turn
    // over even though start and duration are untouched.
    getTimelineController().trimClipTo(clipOf('a').id, 'end', 5);
    const before = clipGeometrySignature(ROOT);
    getTimelineController().slipClip(clipOf('a').id, 1);
    expect(clipGeometrySignature(ROOT)).not.toBe(before);
  });

  it('returns to its previous value when the geometry does', () => {
    // A counter would not: undo would then throw away a warm cache for a scene
    // byte-identical to one already rendered. `sceneContentHash` is a hash for
    // this reason and this must match it.
    const before = clipGeometrySignature(ROOT);
    const controller = getTimelineController();
    controller.setClipStart(clipOf('a').id, 3);
    expect(clipGeometrySignature(ROOT)).not.toBe(before);
    controller.setClipStart(clipOf('a').id, 0);
    expect(clipGeometrySignature(ROOT)).toBe(before);
  });

  it('is blind to a rename, which moves no pixels of its own', () => {
    const before = clipGeometrySignature(ROOT);
    clipOf('a').name = 'renamed';
    expect(clipGeometrySignature(ROOT)).toBe(before);
  });

  it('is empty for a composition with no timeline', () => {
    expect(clipGeometrySignature('comp_that_does_not_exist')).toBe('');
  });
});
