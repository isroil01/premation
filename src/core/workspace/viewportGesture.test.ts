/**
 * The gesture contract: a viewport drag of N pointer events pays its
 * bookkeeping ONCE — one undo command, one structural SceneGraphChanged —
 * instead of N times. Outside a gesture every helper is the classic
 * per-call path, so nudges and programmatic edits are untouched.
 */

import {
  beginViewportGesture,
  endViewportGesture,
  gestureAnimEdit,
  gestureSceneBump,
  viewportGestureActive,
} from './viewportGesture';
import { defaultAnimation } from '@motion/animation';
import { CommandSystem, setCommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { getEventBus } from '@core/events/EventBus';
import { useSceneRevision } from '@stores/sceneStore';

describe('viewportGesture', () => {
  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    defaultAnimation.removeTrack('g1', 'x');
    // A dangling gesture from a failed test must not leak into the next.
    endViewportGesture();
  });

  it('collapses a whole drag into ONE history command', () => {
    beginViewportGesture();
    expect(viewportGestureActive()).toBe(true);
    for (let i = 1; i <= 50; i++) {
      gestureAnimEdit('Keyframe Position', () => {
        defaultAnimation.setKeyframe('g1', 'x', 0, i * 10);
      }, 'drag:test:g1');
    }
    // Nothing recorded until release.
    expect(getCommandSystem().getHistory().peek()).toBeFalsy();
    endViewportGesture();

    const history = getCommandSystem().getHistory();
    const top = history.peek();
    expect(top).not.toBeNull();
    expect(defaultAnimation.sample('g1', 'x', 0)).toBe(500);
    // One undo restores the pre-drag world — no 49 intermediate steps.
    top!.undo();
    expect(defaultAnimation.sample('g1', 'x', 0)).toBeUndefined();
  });

  it('defers the structural bump to gesture end, once, while revs still tick', () => {
    let structural = 0;
    const sub = getEventBus().on('SceneGraphChanged', () => { structural++; });
    const revBefore = useSceneRevision.getState().rev;

    beginViewportGesture();
    for (let i = 0; i < 20; i++) gestureSceneBump();
    expect(structural).toBe(0);
    // Live views keep re-rendering off the revision during the drag.
    expect(useSceneRevision.getState().rev).toBe(revBefore + 20);
    endViewportGesture();
    expect(structural).toBe(1);
    sub.dispose();
  });

  it('falls through to the classic per-call path outside a gesture', () => {
    let structural = 0;
    const sub = getEventBus().on('SceneGraphChanged', () => { structural++; });
    gestureSceneBump();
    gestureSceneBump();
    expect(structural).toBe(2);
    sub.dispose();

    gestureAnimEdit('Keyframe Position', () => {
      defaultAnimation.setKeyframe('g1', 'x', 0, 42);
    });
    // Recorded immediately — no pending transaction.
    expect(getCommandSystem().getHistory().peek()).toBeTruthy();
    expect(viewportGestureActive()).toBe(false);
  });

  it('a gesture with no writes records nothing and announces nothing', () => {
    let structural = 0;
    const sub = getEventBus().on('SceneGraphChanged', () => { structural++; });
    beginViewportGesture();
    endViewportGesture();
    expect(structural).toBe(0);
    expect(getCommandSystem().getHistory().peek()).toBeFalsy();
    sub.dispose();
  });

  it('unbalanced end calls are harmless', () => {
    endViewportGesture();
    endViewportGesture();
    expect(viewportGestureActive()).toBe(false);
  });
});
