/**
 * The canonical keyframe time axis.
 *
 * Keyframes are stored on ONE axis — the time `buildSnapshot` hands the
 * animation engine (`remapOf`): precomp-ancestor time remaps, then the active
 * clip's retime (`sourceIn + (frame − start)`), then the layer's own
 * stretch/reverse/freeze. `compToKeyframeTime` must reproduce that exactly,
 * and `keyframeToCompTime` must be its true inverse wherever an inverse
 * exists — that is what makes timeline diamonds, the graph editor and every
 * inspector agree with the pixels.
 *
 * History: the app once had TWO conversions (`getRemappedTime` — clip-only —
 * and the naive bar-relative `toLayerTime`) and surfaces mixed them, so a
 * value typed at 5s could overwrite the keyframe set at 1s the moment a clip
 * was moved or trimmed. `toLayerTime` survives for layer-BAR geometry
 * (markers) only.
 */

import { AnimationEngine, defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import {
  getTimelineController,
  getRemappedTime,
  compToKeyframeTime,
  keyframeToCompTime,
} from '@core/timeline/TimelineController';

function makeNode(id: string, kind: 'shape' | 'group' = 'shape'): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100 } },
    ],
  } as unknown as SceneNode;
}

function addNode(id: string, kind: 'shape' | 'group' = 'shape', parentId?: string): void {
  const node = makeNode(id, kind);
  if (parentId) {
    defaultSceneGraph.addNode(node);
    defaultSceneGraph.addChild(parentId, node);
  } else {
    defaultSceneGraph.addNode(node);
  }
}

/** The controller's composition track (the only one `getLayersForNode` reads). */
function compTrackId(): string {
  const c = getTimelineController();
  const track = c.timeline.getTracks()[0];
  if (!track) throw new Error('composition track missing');
  return track.id;
}

function addClip(nodeId: string, clip: { start: number; duration: number; sourceIn?: number }): void {
  const c = getTimelineController();
  c.timeline.addLayer(compTrackId(), { name: nodeId, sourceId: nodeId, clip });
  c.invalidateLayerIndex();
}

function clearClips(): void {
  const c = getTimelineController();
  const track = c.timeline.getTrack(compTrackId());
  for (const l of [...(track?.layers ?? [])]) c.timeline.removeLayer(String(l.id));
  c.invalidateLayerIndex();
}

function removeNode(id: string): void {
  try { defaultSceneGraph.removeNode(id); } catch { /* not added in this test */ }
}

const NODE = 'axis-node';
const GROUP = 'axis-precomp';
const CHILD = 'axis-child';

afterEach(() => {
  clearClips();
  for (const id of [NODE, CHILD, GROUP]) {
    for (const prop of ['x', 'y', 'opacity', 'timeRemap', 'precompTime']) {
      defaultAnimation.removeTrack(id, prop);
    }
  }
  removeNode(CHILD);
  removeNode(GROUP);
  removeNode(NODE);
});

describe('compToKeyframeTime — the renderer axis', () => {
  it('is the identity when the node has no clips (renderer fall-through)', () => {
    expect(compToKeyframeTime('nope', 5)).toBe(5);
    expect(keyframeToCompTime('nope', 5)).toBe(5);
    expect(getRemappedTime('nope', 5)).toBe(5); // deprecated alias, same axis
  });

  it('honors a trimmed clip (sourceIn ≠ 0)', () => {
    addNode(NODE);
    addClip(NODE, { start: 30, duration: 120, sourceIn: 15 });
    // comp 2s = frame 60 → source 15 + (60 − 30) = 45 frames = 1.5s
    expect(compToKeyframeTime(NODE, 2)).toBeCloseTo(1.5);
    expect(keyframeToCompTime(NODE, 1.5)).toBeCloseTo(2);
  });

  it('honors a clip slid off 0, and falls through to raw time outside it', () => {
    addNode(NODE);
    addClip(NODE, { start: 30, duration: 150, sourceIn: 0 });
    expect(compToKeyframeTime(NODE, 2)).toBeCloseTo(1); // (60 − 30)/30
    expect(keyframeToCompTime(NODE, 1)).toBeCloseTo(2);
    // Before the clip's in-point the renderer samples the raw time — match it.
    expect(compToKeyframeTime(NODE, 0.5)).toBeCloseTo(0.5);
  });

  it('uses the clip ACTIVE at the playhead after split + slide, not clips[0]', () => {
    addNode(NODE);
    // A split at 2s, right half slid 1s later: [0,2s) shows source 0–2s,
    // [3s,5s) shows source 2s–4s.
    addClip(NODE, { start: 0, duration: 60, sourceIn: 0 });
    addClip(NODE, { start: 90, duration: 60, sourceIn: 60 });
    expect(compToKeyframeTime(NODE, 1)).toBeCloseTo(1);   // left clip
    expect(compToKeyframeTime(NODE, 4)).toBeCloseTo(3);   // right clip: 60+(120−90)=90f
    expect(keyframeToCompTime(NODE, 3)).toBeCloseTo(4);   // back through the RIGHT clip
    expect(keyframeToCompTime(NODE, 0.5)).toBeCloseTo(0.5); // back through the LEFT clip
  });

  it('clamps a keyframe no clip reaches to the nearest clip edge', () => {
    addNode(NODE);
    // Trimmed head: source 0–0.5s exists but is never shown.
    addClip(NODE, { start: 0, duration: 120, sourceIn: 15 });
    // Source 0s → ideal comp frame −15 → clamped to the clip's in-point.
    expect(keyframeToCompTime(NODE, 0)).toBeCloseTo(0);
    // And a reachable time still round-trips.
    expect(keyframeToCompTime(NODE, compToKeyframeTime(NODE, 3))).toBeCloseTo(3);
  });

  it('folds time-stretch on top of the clip map, and inverts it', () => {
    addNode(NODE);
    addClip(NODE, { start: 0, duration: 300, sourceIn: 0 });
    // Span anchors stretch: keyframes at 0s and 2s.
    defaultAnimation.setKeyframe(NODE, 'x', 0, 0);
    defaultAnimation.setKeyframe(NODE, 'x', 2, 100);
    defaultSceneGraph.setLayerTime(NODE, { stretch: 200, reverse: false, freeze: false, freezeTime: 0, frameBlend: 'none' });
    // 200% stretch = half speed: comp 4s samples source 2s.
    expect(compToKeyframeTime(NODE, 4)).toBeCloseTo(2);
    expect(keyframeToCompTime(NODE, 2)).toBeCloseTo(4);
    expect(keyframeToCompTime(NODE, compToKeyframeTime(NODE, 1))).toBeCloseTo(1);
  });

  it('folds reverse, and inverts it', () => {
    addNode(NODE);
    addClip(NODE, { start: 0, duration: 300, sourceIn: 0 });
    defaultAnimation.setKeyframe(NODE, 'x', 0, 0);
    defaultAnimation.setKeyframe(NODE, 'x', 2, 100);
    defaultSceneGraph.setLayerTime(NODE, { stretch: 100, reverse: true, freeze: false, freezeTime: 0, frameBlend: 'none' });
    // Mirrored within the span [0,2]: comp 0.5s samples source 1.5s.
    expect(compToKeyframeTime(NODE, 0.5)).toBeCloseTo(1.5);
    expect(keyframeToCompTime(NODE, 1.5)).toBeCloseTo(0.5);
  });

  it('freeze samples freezeTime everywhere; the inverse deliberately unfreezes', () => {
    addNode(NODE);
    addClip(NODE, { start: 0, duration: 300, sourceIn: 0 });
    defaultAnimation.setKeyframe(NODE, 'x', 0, 0);
    defaultAnimation.setKeyframe(NODE, 'x', 2, 100);
    defaultSceneGraph.setLayerTime(NODE, { stretch: 100, reverse: false, freeze: true, freezeTime: 1.5, frameBlend: 'none' });
    // Forward: every comp time collapses onto the freeze frame — the renderer's
    // behavior, so a write while frozen lands where the pixels sample.
    expect(compToKeyframeTime(NODE, 0)).toBeCloseTo(1.5);
    expect(compToKeyframeTime(NODE, 4)).toBeCloseTo(1.5);
    // Inverse: non-invertible by construction. Documented choice — invert as if
    // unfrozen so the diamonds keep their spread instead of stacking on 1.5s.
    expect(keyframeToCompTime(NODE, 0.5)).toBeCloseTo(0.5);
  });

  it('folds an ancestor precomp time remap and inverts it by frame scan', () => {
    addNode(GROUP, 'group');
    addNode(CHILD, 'shape', GROUP);
    defaultSceneGraph.setPrecomp(GROUP, true);
    // Half-speed ramp: comp 0→2s maps the inner content to 0→1s.
    defaultAnimation.setKeyframe(GROUP, 'timeRemap', 0, 0, 'linear');
    defaultAnimation.setKeyframe(GROUP, 'timeRemap', 2, 1, 'linear');
    expect(compToKeyframeTime(CHILD, 2)).toBeCloseTo(1);
    expect(keyframeToCompTime(CHILD, 1)).toBeCloseTo(2);
    expect(keyframeToCompTime(CHILD, 0.5)).toBeCloseTo(1);
  });

  it('a hold remap inverts to the EARLIEST comp time that lands on the keyframe', () => {
    addNode(GROUP, 'group');
    addNode(CHILD, 'shape', GROUP);
    defaultSceneGraph.setPrecomp(GROUP, true);
    defaultAnimation.setKeyframe(GROUP, 'timeRemap', 0, 0, 'linear');
    defaultAnimation.setKeyframe(GROUP, 'timeRemap', 1, 1, 'hold');
    defaultAnimation.setKeyframe(GROUP, 'timeRemap', 4, 1, 'hold');
    // Comp 1s..4s all sample inner 1s — the earliest wins.
    expect(compToKeyframeTime(CHILD, 3)).toBeCloseTo(1);
    expect(keyframeToCompTime(CHILD, 1)).toBeCloseTo(1);
  });

  it("the remap track ITSELF lives on the chain axis — a group's own clip does not fold into it", () => {
    addNode(GROUP, 'group');
    defaultSceneGraph.setPrecomp(GROUP, true);
    addClip(GROUP, { start: 30, duration: 120, sourceIn: 0 });
    // Regular props go through the clip retime…
    expect(compToKeyframeTime(GROUP, 2)).toBeCloseTo(1);
    // …but `timeRemap` keyframes are sampled by the renderer at chain time
    // (raw comp time for a top-level precomp), so they must be written there.
    expect(compToKeyframeTime(GROUP, 2, 'timeRemap')).toBeCloseTo(2);
    expect(keyframeToCompTime(GROUP, 2, 'timeRemap')).toBeCloseTo(2);
  });

  it('round-trips comp → keyframe → comp on frame boundaries across the clip', () => {
    addNode(NODE);
    addClip(NODE, { start: 45, duration: 150, sourceIn: 20 });
    for (const t of [1.5, 2, 3, 4, 6]) {
      expect(keyframeToCompTime(NODE, compToKeyframeTime(NODE, t))).toBeCloseTo(t);
    }
  });
});

describe('read/write domain symmetry', () => {
  /**
   * The invariant that actually matters, independent of clips: whatever time
   * function a surface uses to WRITE a keyframe, it must use the SAME one to
   * READ the value back. Otherwise typing a value at 5s stores it at one time
   * and displays a sample from another — and the next edit "corrects" the
   * display by overwriting the keyframe you already made.
   */
  it('a value written at t reads back at t', () => {
    const anim = new AnimationEngine();
    anim.setKeyframe('n', 'x', 1, -400);
    anim.setKeyframe('n', 'x', 5, 0);
    expect(anim.sample('n', 'x', 1)).toBeCloseTo(-400);
    expect(anim.sample('n', 'x', 5)).toBeCloseTo(0);
    // Distinct times interpolate rather than collapsing to one value.
    expect(anim.sample('n', 'x', 3)).toBeGreaterThan(-400);
    expect(anim.sample('n', 'x', 3)).toBeLessThan(0);
  });

  it('writing at a DIFFERENT time than you read collapses the animation', () => {
    // This is the failure mode, made explicit: write at (t - offset), read at t.
    const anim = new AnimationEngine();
    const OFFSET = 1; // e.g. a clip starting at 1s
    anim.setKeyframe('n', 'x', 1 - OFFSET, -400); // naive: bar-local
    anim.setKeyframe('n', 'x', 5, 0);             // canonical: keyframe axis
    // The keyframes exist, but they are on two different axes: sampling the
    // comp's 1s gives the interpolated middle, not the -400 the user set.
    expect(anim.sample('n', 'x', 1)).not.toBeCloseTo(-400);
  });

  it('the surviving bar-relative helper is NOT the keyframe axis on a trimmed clip', () => {
    // toLayerTime remains for layer-bar geometry (markers). Document — as a
    // test — that on a trimmed clip it diverges from the canonical axis, so
    // nobody re-adopts it for keyframes because "they look the same at 0".
    addNode(NODE);
    addClip(NODE, { start: 30, duration: 120, sourceIn: 15 });
    const c = getTimelineController();
    expect(c.toLayerTime(NODE, 2)).toBeCloseTo(1);          // bar-relative
    expect(compToKeyframeTime(NODE, 2)).toBeCloseTo(1.5);   // renderer axis
  });
});
