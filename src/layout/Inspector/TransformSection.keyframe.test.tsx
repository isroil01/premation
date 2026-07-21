/**
 * Reported bug: "I add a keyframe at 1s with x:-400, then at 5s set x:0 — they
 * overwrite each other, both end up the same."
 *
 * Root cause: the inspector WROTE keyframes at the layer's time
 * (`toLayerTime`) but READ them back at the raw composition time. On a layer
 * whose clip does not start at 0 those are different axes, so the field showed
 * a point part-way along the curve instead of the keyframe you set — and the
 * next edit "corrected" it, which looks exactly like the later keyframe
 * reaching back and overwriting the earlier one.
 *
 * The invariant these tests hold: **the value the inspector shows at a given
 * playhead time is the value that is stored for that time.**
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { TransformSection } from './TransformSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { getTimelineController, getRemappedTime } from '@core/timeline/TimelineController';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

const NODE = 'kf-node';

// Every keyframe edit is an undoable command, so the panel needs a history.
beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  // The AnimationEngine is framework-independent and announces edits through a
  // change sink that Providers binds onto the event bus at boot. Without that
  // bridge nothing tells React a keyframe moved, so bind it here too.
  defaultAnimation.setChangeListener((nodeId) =>
    getEventBus().emit('AnimationChanged', { nodeId }),
  );
});

function addNode(x: number): void {
  defaultSceneGraph.addNode({
    id: NODE, name: NODE, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${NODE}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100 } },
      { id: `${NODE}_s`, type: 'Style', props: { fill: '#fff', opacity: 100 } },
    ],
  } as unknown as SceneNode);
}

/**
 * Give the node a timeline layer whose bar starts at `startFrames`.
 *
 * It MUST go on the controller's composition track: `getLayersForNode` only
 * consults `compositionTrackId`, so a layer parked on any other track is
 * invisible to it — both time axes then collapse to identity and a test that
 * thinks it has an offset clip silently proves nothing.
 */
function addClip(startFrames: number): void {
  const c = getTimelineController();
  // The controller's composition track is its timeline's only track (created
  // by initTimeline) — the old private `compositionTrackId` cast went stale
  // when the controller grew a per-comp map and silently returned undefined.
  const trackId = c.timeline.getTracks()[0]!.id;
  c.timeline.addLayer(String(trackId), {
    name: NODE, sourceId: NODE, clip: { start: startFrames, duration: 300 },
  });
  c.invalidateLayerIndex();
}

const setTime = (t: number): void => {
  act(() => {
    useProjectStore.getState().actions.setTime(t, Math.round(t * 30));
  });
};

const xField = (): HTMLElement => screen.getByRole('spinbutton', { name: 'Position X' });
const shownX = (): number => Number(xField().getAttribute('aria-valuenow'));

/** The stopwatch in the Position X row — what makes the property animated. */
function lightXStopwatch(): void {
  // CSS-module class names are stubbed under jest, so walk by structure:
  // row > [ stopwatch + label | field ]. The field is itself a div -> up twice.
  const row = xField().parentElement?.parentElement;
  const box = row?.querySelector('input[type="checkbox"]');
  if (!box) throw new Error('no stopwatch in the Position X row');
  fireEvent.click(box);
}

/** Type an exact value into a resting ValueField (Enter opens the input). */
function typeValue(field: HTMLElement, value: string): void {
  fireEvent.keyDown(field, { key: 'Enter' });
  const input = field.querySelector('input');
  if (!input) throw new Error('ValueField did not open an input on Enter');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('keyframing position from the inspector', () => {
  beforeEach(() => {
    defaultAnimation.removeTrack(NODE, 'x');
    try { defaultSceneGraph.removeNode(NODE); } catch { /* first run */ }
    const c = getTimelineController();
    const track = c.timeline.getTracks()[0];
    for (const l of [...(track?.layers ?? [])]) c.timeline.removeLayer(String(l.id));
    c.invalidateLayerIndex();
    addNode(-400);
    setTime(0);
  });

  afterEach(cleanup);

  it('a value set at 5s does not disturb the keyframe at 1s', () => {
    setTime(1);
    defaultAnimation.setKeyframe(NODE, 'x', getRemappedTime(NODE, 1), -400);

    setTime(5);
    render(<TransformSection nodeId={NODE} />);
    typeValue(xField(), '0');

    expect(defaultAnimation.sample(NODE, 'x', getRemappedTime(NODE, 5))).toBeCloseTo(0);
    expect(defaultAnimation.sample(NODE, 'x', getRemappedTime(NODE, 1))).toBeCloseTo(-400);
  });

  it('shows the value you set at each time, on a layer whose clip starts at 1s', () => {
    // THE REPRODUCTION. Before the fix the field read -300 here: the write went
    // to layer time 0/4 while the read sampled raw comp time 1, landing a
    // quarter of the way along the curve.
    addClip(30); // bar dragged to start at 1s — an everyday AE move
    const { rerender } = render(<TransformSection nodeId={NODE} />);

    setTime(1);
    rerender(<TransformSection nodeId={NODE} />);
    lightXStopwatch();          // stopwatch on -> keyframe at 1s
    typeValue(xField(), '-400');

    setTime(5);
    rerender(<TransformSection nodeId={NODE} />);
    typeValue(xField(), '0');
    expect(shownX()).toBeCloseTo(0);

    // Go back: the first keyframe must still read exactly what was set.
    setTime(1);
    rerender(<TransformSection nodeId={NODE} />);
    expect(shownX()).toBeCloseTo(-400);
  });

  it('agrees with the renderer about the value at a given comp time', () => {
    // The inspector and buildSnapshot must sample the same axis, or the number
    // in the panel disagrees with the pixels on the canvas.
    addClip(30);
    const { rerender } = render(<TransformSection nodeId={NODE} />);

    setTime(1);
    rerender(<TransformSection nodeId={NODE} />);
    lightXStopwatch();
    typeValue(xField(), '-400');
    setTime(5);
    rerender(<TransformSection nodeId={NODE} />);
    typeValue(xField(), '0');

    for (const t of [1, 3, 5]) {
      setTime(t);
      rerender(<TransformSection nodeId={NODE} />);
      expect(shownX()).toBeCloseTo(defaultAnimation.sample(NODE, 'x', getRemappedTime(NODE, t))!);
    }
  });
});
