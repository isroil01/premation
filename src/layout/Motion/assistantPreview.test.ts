/**
 * The Smoother / Wiggler preview contract.
 *
 * Both dialogs apply to the live animation as you type, which is only
 * acceptable if two things hold, and neither is obvious from reading the
 * dialogs:
 *
 *   1. Cancel restores the EXACT keyframes that were there. The transforms are
 *      lossy — the Smoother deletes keyframes and re-tangents the survivors —
 *      so "re-run with the original tolerance" is not a revert, and a diff of
 *      the last preview against the one before it would restore the wrong
 *      thing entirely.
 *
 *   2. Every intermediate write is invisible to undo, and OK records exactly
 *      one entry covering the net change. Otherwise a slow drag through the
 *      tolerance field would leave a dozen undo steps for one decision.
 */

import { defaultAnimation, type Keyframe } from '@motion/animation';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { beginTrackPreview } from './assistantPreview';

const NODE = 'preview_test_node';

function seed(): void {
  defaultAnimation.removeTrack(NODE, 'x');
  defaultAnimation.removeTrack(NODE, 'y');
  for (let i = 0; i <= 10; i++) {
    defaultAnimation.setKeyframe(NODE, 'x', i * 0.1, i * 10);
    defaultAnimation.setKeyframe(NODE, 'y', i * 0.1, i);
  }
  defaultAnimation.updateKeyframe(NODE, 'x', 0, { easing: 'bezier', bezier: [0.2, 0, 0.8, 1] });
}

function snapshot(prop: string): string {
  return JSON.stringify(defaultAnimation.getTrackKeyframes(NODE, prop));
}

function historyDepth(): number {
  // `getIndex()` is the top of the UNDO stack; `getEntries()` also carries the
  // redo tail, which a preview never touches.
  return getCommandSystem().getHistory().getIndex() + 1;
}

describe('beginTrackPreview', () => {
  beforeAll(() => {
    // `recordAnimEdit` pushes onto the app history, which is a boot-time
    // singleton. Nothing else in this file needs the core.
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  });

  beforeEach(() => {
    getCommandSystem().getHistory().clear();
    seed();
  });

  afterEach(() => {
    defaultAnimation.removeTrack(NODE, 'x');
    defaultAnimation.removeTrack(NODE, 'y');
  });

  it('restores the exact keyframes — easing and handles included — on cancel', () => {
    const before = { x: snapshot('x'), y: snapshot('y') };
    const preview = beginTrackPreview(NODE, ['x', 'y']);

    // Three successive previews, each a different lossy result.
    for (const keep of [2, 5, 3]) {
      const thinned: Keyframe[] = (defaultAnimation.getTrackKeyframes(NODE, 'x') ?? [])
        .filter((_, i) => i % keep === 0)
        .map((k) => ({ t: k.t, value: k.value }));
      preview.apply(new Map([['x', thinned]]));
    }
    expect(snapshot('x')).not.toBe(before.x);

    preview.restore();
    expect(snapshot('x')).toBe(before.x);
    expect(snapshot('y')).toBe(before.y);
  });

  it('re-applies from the ORIGINAL each time, never from the last preview', () => {
    const preview = beginTrackPreview(NODE, ['x']);
    const original = preview.original('x');

    // A preview that deletes almost everything…
    preview.apply(new Map([['x', [original[0]!, original[10]!]]]));
    // …followed by one that keeps more. Applying against the previous preview
    // instead of the original would make this second result impossible: the
    // keyframes it needs are gone.
    preview.apply(new Map([['x', original.filter((_, i) => i % 2 === 0)]]));
    expect(defaultAnimation.getTrackKeyframes(NODE, 'x')).toHaveLength(6);
  });

  it('records nothing while previewing and one entry on commit', () => {
    const depth = historyDepth();
    const preview = beginTrackPreview(NODE, ['x']);
    const original = preview.original('x');

    for (const stride of [2, 3, 4, 5]) {
      preview.apply(new Map([['x', original.filter((_, i) => i % stride === 0)]]));
      expect(historyDepth()).toBe(depth);
    }

    preview.commit('The Smoother');
    expect(historyDepth()).toBe(depth + 1);
  });

  it('records nothing at all when the net change is nil', () => {
    const depth = historyDepth();
    const preview = beginTrackPreview(NODE, ['x']);
    preview.apply(new Map([['x', preview.original('x').slice(0, 3)]]));
    preview.restore();
    preview.commit('The Smoother');
    expect(historyDepth()).toBe(depth);
  });

  it('ignores props it did not capture', () => {
    const preview = beginTrackPreview(NODE, ['x']);
    const yBefore = snapshot('y');
    preview.apply(new Map([['y', []]]));
    expect(snapshot('y')).toBe(yBefore);
  });

  it('captures nothing for a track with no keyframes', () => {
    expect(beginTrackPreview(NODE, ['rotation']).props).toEqual([]);
  });
});
