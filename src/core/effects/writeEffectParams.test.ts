/**
 * The one write path for effect params, shared by the numeric field and the
 * canvas handle.
 *
 * Two things are under test and the SECOND is the one that regresses silently:
 * a drag with the stopwatch on must create a keyframe, and a drag with it off
 * must not. The first announces itself the moment you scrub; the second only
 * shows up as an animation nobody asked for, weeks later, on someone else's
 * project.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getNodeEffects, effectPropPath, writeNodeEffects } from './effects';
import { writeEffectParams } from './writeEffectParams';
import { getCommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';

const NODE = 'L';
const FX = 'fx_1';
const pX = effectPropPath(FX, 'topLeftX');
const pY = effectPropPath(FX, 'topLeftY');

function reset(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Comp', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
  defaultSceneGraph.addChild('comp_root', {
    id: NODE, name: NODE, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${NODE}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 100, height: 100 } },
    ],
  } as unknown as SceneNode);
  writeNodeEffects(NODE, [{ id: FX, type: 'corner-pin', params: {} }]);
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
}

/**
 * Undo-stack depth, probed non-destructively — the same drain-and-restore
 * helper `rigGestureUndo.test.tsx` uses, because "how deep is the stack" should
 * not have two answers in one repo.
 */
function undoDepth(): number {
  const hist = getCommandSystem().getHistory();
  let n = 0;
  while (hist.canUndo()) { hist.undo(); n++; }
  for (let i = 0; i < n; i++) hist.redo();
  return n;
}
beforeEach(reset);

const storedX = (): unknown => getNodeEffects(NODE)[0]!.params?.topLeftX;

describe('the stopwatch decides, per parameter', () => {
  it('WITH the stopwatch on: writes a keyframe at the playhead', () => {
    defaultAnimation.setKeyframe(NODE, pX, 0, 0);
    const keyed = writeEffectParams(NODE, FX, { topLeftX: 40 }, { time: 1, mergeKey: 'g1' });
    expect(keyed).toEqual([pX]);
    expect(defaultAnimation.sample(NODE, pX, 1)).toBe(40);
    // The value at t=0 is untouched: a keyframe at the playhead, not a rewrite.
    expect(defaultAnimation.sample(NODE, pX, 0)).toBe(0);
  });

  /**
   * The half that regresses silently. Asserted on THREE observables, because
   * "no keyframe" is easy to claim and easy to get subtly wrong: nothing
   * returned, no track created, and the static param actually updated.
   */
  it('WITHOUT it: writes the static value and creates NO track', () => {
    const keyed = writeEffectParams(NODE, FX, { topLeftX: 40 }, { time: 1, mergeKey: 'g1' });
    expect(keyed).toEqual([]);
    expect(defaultAnimation.isAnimated(NODE, pX)).toBe(false);
    expect(storedX()).toBe(40);
  });

  /**
   * PER PARAM, not per call. A handle carries an X and a Y and a user can have
   * keyframed only one. Keyframing both because one is animated starts an
   * animation they did not ask for; keyframing neither throws away the one they
   * did. Neither failure is visible without scrubbing.
   */
  it('splits a two-axis write when only ONE axis is animated', () => {
    defaultAnimation.setKeyframe(NODE, pY, 0, 0);
    const keyed = writeEffectParams(NODE, FX, { topLeftX: 11, topLeftY: 22 }, { time: 1, mergeKey: 'g1' });
    expect(keyed).toEqual([pY]);
    expect(defaultAnimation.isAnimated(NODE, pX)).toBe(false);
    expect(storedX()).toBe(11);
    expect(defaultAnimation.sample(NODE, pY, 1)).toBe(22);
  });

  it('ignores a non-finite value rather than poisoning the param', () => {
    // Set a real value FIRST. Asserting against the unwritten state would prove
    // nothing: `getNodeEffects` folds in each param's declared default, so an
    // untouched `topLeftX` reads 0 whether it was skipped or written as 0.
    writeEffectParams(NODE, FX, { topLeftX: 42 }, { time: 0, mergeKey: 'g1' });
    expect(storedX()).toBe(42);
    writeEffectParams(NODE, FX, { topLeftX: Number.NaN }, { time: 0, mergeKey: 'g1' });
    expect(storedX()).toBe(42);
  });
});

describe('one gesture is one undo entry', () => {
  /**
   * A drag emits a write per pointer-move — hundreds of them. Without a stable
   * merge key each would be its own history entry and a single drag would take
   * hundreds of undos to reverse, which is the behaviour `PuppetEditCommand`'s
   * transaction and `applyNodePropsKeyframed`'s merge key both exist to avoid.
   */
  it('collapses a whole animated drag into ONE history entry', () => {
    defaultAnimation.setKeyframe(NODE, pX, 0, 0);
    const before = undoDepth();
    for (let i = 1; i <= 25; i++) {
      writeEffectParams(NODE, FX, { topLeftX: i }, { time: 0, mergeKey: 'drag:L:fx_1:topLeft' });
    }
    expect(undoDepth() - before).toBe(1);
    expect(defaultAnimation.sample(NODE, pX, 0)).toBe(25);
  });

  it('a SECOND gesture is a second entry — merging is per key, not global', () => {
    defaultAnimation.setKeyframe(NODE, pX, 0, 0);
    const before = undoDepth();
    writeEffectParams(NODE, FX, { topLeftX: 5 }, { time: 0, mergeKey: 'drag:a' });
    writeEffectParams(NODE, FX, { topLeftX: 9 }, { time: 0, mergeKey: 'drag:b' });
    expect(undoDepth() - before).toBe(2);
  });
});
