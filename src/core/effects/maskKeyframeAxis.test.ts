/**
 * Mask SHAPE keyframes are written on the axis the renderer reads them on.
 *
 * `buildSnapshot` resolves a layer's mask at `remapOf(id)(t)` — the layer's
 * keyframe time, through its clip (`sourceIn + (frame − start)`). The canvas
 * reshape (`updateMaskPathCmd`) and the Effects panel's keyframe button wrote
 * at raw COMP time instead. The two are the same number only for an untrimmed
 * bar at 0, which hid it: on a bar moved to start at 1s, an edit made at comp
 * 2s landed on keyframe 2s — which the renderer shows at comp 3s — while the
 * shape at 2s stayed an interpolation the user never drew.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { commands } from '@motion/workspace';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getTimelineController, compToKeyframeTime } from '@core/timeline/TimelineController';
import { MASK_ANIM_PROP } from '@core/timeline/propertyTree';
import { createCommandPort } from '@core/workspace/ports';
import { engineIdle } from '@core/engine/engineInstance';
import { buildPropertyRows } from '../../layout/Timeline/buildPropertyRows';
import { readNodeMaskAnim, type LayerMask, type MaskPoint } from './mask';
import type { SceneNode } from '@core/types';

const ROOT = 'comp_root';
const LAYER = 'mask_axis_layer';
const COMP = { width: 1920, height: 1080, background: '#000000', rootId: ROOT };

const corner = (x: number, y: number): MaskPoint => ({ x, y, inX: x, inY: y, outX: x, outY: y });
const square = (s: number): MaskPoint[] => [corner(-s, -s), corner(s, -s), corner(s, s), corner(-s, s)];
const maskOf = (s: number): LayerMask => ({
  paths: [{ id: 'm1', mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false, points: square(s) }],
});

function makeNode(id: string, components: SceneNode['components']): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components,
  } as unknown as SceneNode;
}

function compTrackId(): string {
  const track = getTimelineController().timeline.getTracks()[0];
  if (!track) throw new Error('composition track missing');
  return track.id;
}

function clearClips(): void {
  const c = getTimelineController();
  const track = c.timeline.getTrack(compTrackId());
  for (const l of [...(track?.layers ?? [])]) c.timeline.removeLayer(String(l.id));
  c.invalidateLayerIndex();
}

const fps = (): number => getTimelineController().timeline.getFrameRate().fps;

beforeEach(() => {
  clearClips();
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode(makeNode(ROOT, [
    { id: `${ROOT}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } },
  ] as SceneNode['components']));
  const layer = makeNode(LAYER, [
    { id: `${LAYER}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 960, y: 540, width: 200, height: 200 } },
    { id: `${LAYER}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    // An animated mask: a 10px square at keyframe 0s growing to 50px at 4s.
    { id: `${LAYER}_fx`, type: 'fx', props: { mask: maskOf(10), maskAnim: [{ t: 0, mask: maskOf(10) }, { t: 4, mask: maskOf(50) }] } },
  ] as SceneNode['components']);
  defaultSceneGraph.addNode(layer);
  defaultSceneGraph.addChild(ROOT, layer);
  // The bar MOVED to start at 1s (sourceIn 0): comp time ≠ keyframe time.
  const c = getTimelineController();
  c.timeline.addLayer(compTrackId(), {
    name: LAYER, sourceId: LAYER, clip: { start: 1 * fps(), duration: 5 * fps(), sourceIn: 0 },
  });
  c.invalidateLayerIndex();
});

afterEach(() => {
  clearClips();
  getTimelineController().seekSeconds(0);
  defaultAnimation.clear();
  defaultSceneGraph.clear();
});

/** The mask the renderer resolves for the layer at comp time `t`. */
function renderedMaskAt(t: number): LayerMask | undefined {
  const layers = buildSnapshot(defaultSceneGraph, defaultAnimation, t, undefined, undefined, undefined, undefined, COMP).layers;
  return layers.find((l) => l.id === LAYER)?.mask as LayerMask | undefined;
}

describe('mask shape keyframes — one time axis for write and read', () => {
  it('a canvas reshape at comp 2s lands on the keyframe the renderer reads at 2s', async () => {
    // Guard: the premise. With the bar at 1s, comp 2s is keyframe 1s — if the
    // axes coincided this test could not tell a fix from the bug.
    expect(compToKeyframeTime(LAYER, 2)).toBeCloseTo(1);

    getTimelineController().seekSeconds(2);
    createCommandPort().execute(commands.updateMaskPath(LAYER as never, 'm1', square(30) as never));
    // The reshape is an engine command (B3): it lands asynchronously.
    await engineIdle();

    const node = defaultSceneGraph.getNode(LAYER)!;
    const times = readNodeMaskAnim(node).map((k) => k.t);
    expect(times.some((t) => Math.abs(t - 1) < 1e-6)).toBe(true);
    expect(times.some((t) => Math.abs(t - 2) < 1e-6)).toBe(false);

    // And the pixels agree: at comp 2s the renderer draws exactly the drawn
    // shape (the bug drew the 0s→2s interpolation, a 20px square, here).
    const m = renderedMaskAt(2);
    expect(m?.paths[0]?.points[2]?.x).toBeCloseTo(30);
    expect(m?.paths[0]?.points[2]?.y).toBeCloseTo(30);
  });

  it("the timeline's Mask Shape diamonds sit where the shape changes", async () => {
    getTimelineController().seekSeconds(2);
    createCommandPort().execute(commands.updateMaskPath(LAYER as never, 'm1', square(30) as never));
    // The reshape is an engine command (B3): it lands asynchronously.
    await engineIdle();

    const row = buildPropertyRows(LAYER).find((r) => r.prop === MASK_ANIM_PROP);
    expect(row).toBeDefined();
    // Keyframes 0s / 1s / 4s on a bar that starts at 1s → comp 1s / 2s / 5s.
    expect(row!.keyframes.map((k) => Math.round(k.time * 1000) / 1000)).toEqual([1, 2, 5]);
  });
});
