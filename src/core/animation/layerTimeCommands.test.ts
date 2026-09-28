import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { useSelectionStore } from '@stores/selectionStore';
import { getNodeLayerTime } from '@core/scene/layerTime';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import {
  toggleReverse,
  toggleFreeze,
  applyStretch,
  setFrameBlend,
  toggleTimeRemap,
  hasTimeRemap,
  stretchClipGeometry,
  holdFrameFor,
  lastFrameHoldKeys,
  clampStretch,
  type ClipGeometry,
} from './layerTimeCommands';

/**
 * The source second comp frame `f` shows — the renderer's two-step map (clip,
 * then stretch anchored at the keyframe span start `a`).
 */
function sourceAt(g: ClipGeometry, f: number, stretch: number, fps: number, a = 0): number {
  const c = (g.sourceIn + f - g.start) / fps;
  return a + (c - a) * (100 / stretch);
}

describe('Time Stretch — Hold in Place maths', () => {
  const fps = 30;

  it('hold frame is the span edge or the playhead', () => {
    const span = { start: 10, end: 40 };
    expect(holdFrameFor(span, 'in', 25)).toBe(10);
    expect(holdFrameFor(span, 'out', 25)).toBe(40);
    expect(holdFrameFor(span, 'current', 25)).toBe(25);
  });

  it('Layer In-point: the bar keeps its start and doubles, the in and out source frames are unchanged', () => {
    const clip = { start: 10, duration: 30, sourceIn: 0 };
    const next = stretchClipGeometry(clip, 100, 200, 10, fps);
    expect(next).toEqual({ start: 10, duration: 60, sourceIn: 0 });
    expect(sourceAt(next, 10, 200, fps)).toBeCloseTo(sourceAt(clip, 10, 100, fps));
    expect(sourceAt(next, 70, 200, fps)).toBeCloseTo(sourceAt(clip, 40, 100, fps));
  });

  it('Layer Out-point: the bar keeps its end and the in-point moves earlier', () => {
    const clip = { start: 100, duration: 30, sourceIn: 0 };
    const next = stretchClipGeometry(clip, 100, 200, 130, fps);
    expect(next.start + next.duration).toBe(130);
    expect(next.start).toBe(70);
    expect(sourceAt(next, 130, 200, fps)).toBeCloseTo(sourceAt(clip, 130, 100, fps));
  });

  it('Current Frame: the frame under the playhead shows the same source, with a keyframe span anchor and a slipped source', () => {
    const clip = { start: 50, duration: 40, sourceIn: 12 };
    const a = 0.5;
    const next = stretchClipGeometry(clip, 120, 180, 70, 24, a);
    expect(next.duration).toBe(60);
    expect(Math.abs(sourceAt(next, 70, 180, 24, a) - sourceAt(clip, 70, 120, 24, a))).toBeLessThan(1 / 24);
  });

  it('a bar that would start before frame 0 clamps, and still holds the frame', () => {
    const clip = { start: 0, duration: 30, sourceIn: 0 };
    const next = stretchClipGeometry(clip, 100, 200, 30, fps);
    expect(next.start).toBe(0);
    expect(sourceAt(next, 30, 200, fps)).toBeCloseTo(sourceAt(clip, 30, 100, fps));
    // A bounded source cannot start before its first frame.
    expect(stretchClipGeometry({ start: 0, duration: 30, sourceIn: 0 }, 200, 100, 30, fps, 0, true).sourceIn).toBeGreaterThanOrEqual(0);
  });

  it('keyframes follow: a keyframe at source 1 s draws at the same comp frame the stretch predicts', () => {
    // 100 → 50 %, hold in-point at 0: source 1 s moves from comp frame 30 to 15.
    const clip = { start: 0, duration: 60, sourceIn: 0 };
    const next = stretchClipGeometry(clip, 100, 50, 0, fps);
    expect(next.duration).toBe(30);
    expect(sourceAt(next, 15, 50, fps)).toBeCloseTo(1);
  });

  it('an unchanged factor is a no-op; the stored factor clamps to 1…1000', () => {
    const clip = { start: 5, duration: 10, sourceIn: 3 };
    expect(stretchClipGeometry(clip, 150, 150, 5, fps)).toEqual(clip);
    expect(clampStretch(0.2)).toBe(1);
    expect(clampStretch(4000)).toBe(1000);
  });
});

describe('Freeze On Last Frame — keyframe times', () => {
  it('identity from the in-point to the LAST visible frame (end is exclusive)', () => {
    expect(lastFrameHoldKeys({ start: 30, end: 90 }, 30)).toEqual({ inSec: 1, lastSec: 89 / 30 });
    // A one-frame layer holds its only frame.
    expect(lastFrameHoldKeys({ start: 12, end: 13 }, 24)).toEqual({ inSec: 0.5, lastSec: 0.5 });
  });
});

function bootCommandSystem(): void {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) as never }));
}

const VIDEO = 'lt_video';
const SHAPE = 'lt_shape';

function addNode(id: string, kind: string): void {
  defaultSceneGraph.addChild('comp_root', {
    id,
    name: id,
    parent: 'comp_root',
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: kind } }],
  } as never);
}

beforeEach(() => {
  bootCommandSystem();
  for (const id of [VIDEO, SHAPE]) {
    if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode?.(id);
  }
  addNode(VIDEO, 'video');
  addNode(SHAPE, 'shape');
  defaultAnimation.removeTrack(VIDEO, 'timeRemap');
  useSelectionStore.setState({ ids: [VIDEO, SHAPE] });
});

describe('Layer ▸ Time commands', () => {
  it('reverse and freeze toggle, freeze holding the playhead time', () => {
    toggleReverse([VIDEO]);
    expect(getNodeLayerTime(VIDEO).reverse).toBe(true);
    toggleReverse([VIDEO]);
    expect(getNodeLayerTime(VIDEO).reverse).toBe(false);

    toggleFreeze([VIDEO], 2.5);
    expect(getNodeLayerTime(VIDEO)).toMatchObject({ freeze: true, freezeTime: 2.5 });
    toggleFreeze([VIDEO], 4);
    expect(getNodeLayerTime(VIDEO).freeze).toBe(false);
  });

  it('stretch is clamped to 1…1000 %, frame blend writes the mode', () => {
    applyStretch([VIDEO], 200);
    expect(getNodeLayerTime(VIDEO).stretch).toBe(200);
    applyStretch([VIDEO], 0);
    expect(getNodeLayerTime(VIDEO).stretch).toBe(1);
    applyStretch([VIDEO], 5000);
    expect(getNodeLayerTime(VIDEO).stretch).toBe(1000);
    setFrameBlend([VIDEO], 'pixelMotion');
    expect(getNodeLayerTime(VIDEO).frameBlend).toBe('pixelMotion');
  });

  it('time remap enables with one identity keyframe at the playhead and removes cleanly', () => {
    expect(hasTimeRemap(VIDEO)).toBe(false);
    toggleTimeRemap([VIDEO], 1.5);
    expect(hasTimeRemap(VIDEO)).toBe(true);
    expect(defaultAnimation.sample(VIDEO, 'timeRemap', 1.5)).toBeCloseTo(1.5);
    toggleTimeRemap([VIDEO], 1.5);
    expect(hasTimeRemap(VIDEO)).toBe(false);
  });
});
