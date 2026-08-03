/**
 * The AE keyframing contract, and the structural guard that keeps it.
 *
 * A property with a lit stopwatch ALWAYS keyframes on direct manipulation.
 * Writing a static value to a tracked property is silently discarded, because
 * the renderer reads animated values first (`av.get(prop) ?? transform.prop`) —
 * the store changes, the screen does not.
 *
 * That is not hypothetical. Reproduced in a running build before the fix: with
 * Position X animated, stepping Anchor X from 1 → 11 left Position X at 961
 * instead of 971, so the pan-behind compensation vanished and the layer jumped
 * by exactly the compensation amount. Align and Fit had the same defect from the
 * same cause.
 */

import { writeTransformProps, writesAsKeyframe, hasAnyTrack } from './transformWrite';

const tracks: Array<{ prop: string }> = [];
const setKeyframe = jest.fn();
const writeProp = jest.fn(() => true);
let autoKeyframe = false;

jest.mock('@motion/animation', () => ({
  defaultAnimation: {
    tracksFor: () => tracks,
    setKeyframe: (...a: unknown[]) => setKeyframe(...a),
  },
}));

jest.mock('@core/scene/DefaultSceneGraph', () => ({
  __esModule: true,
  default: {
    getNode: () => ({
      id: 'n1',
      locked: false,
      components: [{ id: 't1', type: 'Transform', props: {} }],
    }),
    writeProp: (...a: unknown[]) => writeProp(...(a as [])),
  },
}));

jest.mock('@core/animation/animationCommands', () => ({
  // Run the edit inline; history batching is not what this test is about.
  runAnimEdit: (_label: string, fn: () => void) => fn(),
}));

jest.mock('@core/timeline/TimelineController', () => ({
  getRemappedTime: () => 2.5,
}));

jest.mock('@stores/projectStore', () => ({
  useProjectStore: { getState: () => ({ activeTabId: 'a', tabs: { a: { time: 7 } } }) },
}));

jest.mock('@stores/preferenceStore', () => ({
  usePreferenceStore: { getState: () => ({ timelineAutoKeyframe: autoKeyframe }) },
}));

jest.mock('@stores/sceneStore', () => ({ bumpScene: () => {} }));

beforeEach(() => {
  tracks.length = 0;
  setKeyframe.mockClear();
  writeProp.mockClear();
  autoKeyframe = false;
});

describe('writesAsKeyframe', () => {
  it('is false for an un-animated property with auto-keyframe off', () => {
    expect(writesAsKeyframe('n1', 'x')).toBe(false);
  });

  it('is true once the property carries a track', () => {
    tracks.push({ prop: 'x' });
    expect(writesAsKeyframe('n1', 'x')).toBe(true);
  });

  it('groups x and y — a track on one axis keyframes both', () => {
    // Otherwise a diagonal move lands x and y on different keyframe times and
    // reads as two motions instead of one.
    tracks.push({ prop: 'x' });
    expect(writesAsKeyframe('n1', 'y')).toBe(true);
  });

  it('groups the scale axes', () => {
    tracks.push({ prop: 'scaleY' });
    expect(writesAsKeyframe('n1', 'scaleX')).toBe(true);
  });

  it('groups the anchor axes', () => {
    tracks.push({ prop: 'anchorY' });
    expect(writesAsKeyframe('n1', 'anchorX')).toBe(true);
  });

  it('auto-keyframe makes even an un-animated property record', () => {
    autoKeyframe = true;
    expect(writesAsKeyframe('n1', 'rotation')).toBe(true);
  });

  it('does NOT bleed across unrelated properties', () => {
    tracks.push({ prop: 'rotation' });
    expect(writesAsKeyframe('n1', 'x')).toBe(false);
  });
});

describe('writeTransformProps', () => {
  it('writes only the base prop when nothing is animated', () => {
    writeTransformProps('n1', [{ prop: 'x', value: 100 }]);
    expect(writeProp).toHaveBeenCalledWith('n1', 't1', 'x', 100);
    expect(setKeyframe).not.toHaveBeenCalled();
  });

  it('ALSO keyframes when the property is animated — the whole point', () => {
    tracks.push({ prop: 'x' });
    writeTransformProps('n1', [{ prop: 'x', value: 971 }]);
    // The base write stays, so the static value is right if the track is later
    // removed; the keyframe is what the renderer actually reads today.
    expect(writeProp).toHaveBeenCalledWith('n1', 't1', 'x', 971);
    expect(setKeyframe).toHaveBeenCalledWith('n1', 'x', 2.5, 971);
  });

  it('writes keyframes on the LAYER time axis, not raw comp time', () => {
    // getRemappedTime is the only axis keyframes may be written on; the raw tab
    // time here is 7, the layer time 2.5.
    tracks.push({ prop: 'y' });
    writeTransformProps('n1', [{ prop: 'y', value: 5 }]);
    expect(setKeyframe).toHaveBeenCalledWith('n1', 'y', 2.5, 5);
  });

  it('keyframes only the animated members of a mixed write', () => {
    // Exactly the pan-behind case: anchor static, position animated.
    tracks.push({ prop: 'x' });
    writeTransformProps('n1', [
      { prop: 'anchorX', value: 11 },
      { prop: 'x', value: 971 },
    ]);
    const keyed = setKeyframe.mock.calls.map((c) => c[1]);
    expect(keyed).toContain('x');
    expect(keyed).not.toContain('anchorX');
  });

  it('ignores non-finite values rather than writing NaN into the scene', () => {
    writeTransformProps('n1', [{ prop: 'x', value: Number.NaN }]);
    expect(writeProp).not.toHaveBeenCalled();
  });
});

describe('hasAnyTrack', () => {
  it('answers over the supplied property list', () => {
    tracks.push({ prop: 'rotation' });
    expect(hasAnyTrack('n1', ['rotation'])).toBe(true);
    expect(hasAnyTrack('n1', ['x', 'y'])).toBe(false);
  });
});
