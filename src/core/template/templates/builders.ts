/**
 * Minimal node builders shared by authored templates. These mirror the exact
 * SceneNode/Component shapes seedSaaSAd uses (Transform carries SCENE_KIND_PROP
 * + geometry; Style carries fill/opacity; Text carries content/font/fill), so
 * templates render through the same buildSnapshot pipeline as everything else.
 *
 * Every builder takes the target `graph` so a template's `layout` can be built
 * into either the live singleton (real apply) or a throwaway SceneGraph (gallery
 * thumbnail). Ids are STABLE so exposed fields target nodes reliably.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import type { SceneNode, Transform } from '@core/types';
import type { FillPaint } from '@core/paint/fill';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { defaultAnimation } from '@motion/animation';
import { compToKeyframeTime } from '@core/timeline/TimelineController';

export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
export type Frame = [number, number, Ease?];

/** Abstract keyframe setter — hides whether we're driving the LIVE engine
 *  (timeline-mapped seconds) or a throwaway PREVIEW engine (raw seconds), so a
 *  template's choreography is defined ONCE and replayed by both the real apply
 *  and the isolated gallery-card animation. Mirrors animPresets' SetKf. */
export type SetKf = (id: string, prop: string, timeSec: number, value: number, ease?: Ease) => void;

/** Writes into the LIVE scene's animation engine (seconds → canonical keyframe time). */
export const liveKf: SetKf = (id, prop, timeSec, value, ease) => {
  defaultAnimation.setKeyframe(id, prop, compToKeyframeTime(id, timeSec), value, ease ?? 'easeInOut');
};

/** The largest keyframe time (seconds) a choreography sets — its loop length. */
export function choreographyDuration(animate: (set: SetKf) => void): number {
  let max = 0;
  animate((_id, _prop, t) => { if (t > max) max = t; });
  return max;
}

/**
 * The time (seconds) at which a choreography shows the MOST of itself — the
 * frame to park a playhead on so the thing that was just inserted is actually
 * on screen.
 *
 * "The end" is the obvious answer and it is wrong for a whole class of item: a
 * particle burst, a ripple, a glitch stinger and every exit all finish at
 * opacity 0 on purpose, so their last frame is an empty comp. Deriving the
 * answer from the keyframes instead of hardcoding one per item means the
 * catalogs can keep growing without each new entry having to remember to
 * declare where its own visible frame is.
 *
 * Pure: replays `animate` into a table and evaluates it, touching no engine.
 * Ties go to the LATEST time, so an ordinary entrance still rests settled
 * rather than mid-flight.
 */
export function choreographyRestTime(animate: (set: SetKf) => void, samples = 48): number {
  // id → prop → sorted (t, value) pairs. Only opacity and scale decide
  // visibility; position can move a layer off-frame but no authored item
  // relies on that as its finish.
  const tracks = new Map<string, Map<string, Array<[number, number]>>>();
  let duration = 0;
  animate((id, prop, t, value) => {
    if (t > duration) duration = t;
    if (prop !== 'opacity' && prop !== 'scaleX' && prop !== 'scaleY') return;
    let byProp = tracks.get(id);
    if (!byProp) { byProp = new Map(); tracks.set(id, byProp); }
    const list = byProp.get(prop);
    if (list) list.push([t, value]);
    else byProp.set(prop, [[t, value]]);
  });
  if (duration <= 0 || tracks.size === 0) return duration;
  for (const byProp of tracks.values()) for (const list of byProp.values()) list.sort((a, b) => a[0] - b[0]);

  // Linear read-back. Easing changes the shape between keys but never whether a
  // value is zero AT a key, which is all this scoring needs.
  const at = (list: Array<[number, number]> | undefined, t: number, fallback: number): number => {
    if (!list || list.length === 0) return fallback;
    if (t <= list[0]![0]) return list[0]![1];
    if (t >= list[list.length - 1]![0]) return list[list.length - 1]![1];
    for (let i = 1; i < list.length; i++) {
      const [t1, v1] = list[i]!;
      if (t <= t1) {
        const [t0, v0] = list[i - 1]!;
        const span = t1 - t0;
        return span <= 0 ? v1 : v0 + (v1 - v0) * ((t - t0) / span);
      }
    }
    return list[list.length - 1]![1];
  };

  let bestT = duration;
  let bestScore = -1;
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * duration;
    let score = 0;
    for (const byProp of tracks.values()) {
      // Authoring units here, not render units: opacity is 0..100 and scale is
      // a 1-is-natural multiplier.
      const opacity = at(byProp.get('opacity'), t, 100);
      const sx = at(byProp.get('scaleX'), t, 1);
      const sy = at(byProp.get('scaleY'), t, 1);
      if (opacity > 1 && Math.abs(sx) > 0.01 && Math.abs(sy) > 0.01) score++;
    }
    if (score >= bestScore) { bestScore = score; bestT = t; }
  }
  return bestT;
}

export function tf(x: number, y: number, rotation = 0): Transform {
  return { position: { x, y }, rotation, scale: { x: 1, y: 1 } };
}

/** Add the composition root (a group node) and return its id. */
export function addRoot(graph: SceneGraph, id: string, name: string): string {
  const root = {
    id, name, parent: null, children: [], transform: tf(0, 0), visible: true, locked: false,
    components: [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode;
  graph.addNode(root);
  return id;
}

/** Add a filled rectangle (Style.fill is the exposed colour). */
export function addShape(
  graph: SceneGraph, id: string, parent: string, x: number, y: number, w: number, h: number, fill: string,
): string {
  const node = {
    id, name: id, parent, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: 0, width: w, height: h } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
    ],
  } as unknown as SceneNode;
  graph.addChild(parent, node);
  return id;
}

/** A linear gradient paint (angle in degrees, 0=→, 90=↓). Stops: [offset, css]. */
let stopSeq = 0;
export function linearFill(angle: number, stops: Array<[number, string]>): FillPaint {
  return { type: 'linear', angle, stops: stops.map(([offset, color]) => ({ id: `gs_${(stopSeq += 1)}`, offset, color })) };
}
/** A radial gradient paint centred at (cx,cy) in the [0..1] box, radius as a
 *  fraction of the half-diagonal. Fade the last stop to a transparent colour
 *  (#rrggbb00) for a soft glow. */
export function radialFill(cx: number, cy: number, radius: number, stops: Array<[number, string]>): FillPaint {
  return { type: 'radial', cx, cy, radius, stops: stops.map(([offset, color]) => ({ id: `gs_${(stopSeq += 1)}`, offset, color })) };
}

/** Add a gradient-filled rectangle. The paint lives on an `fx` component (key
 *  'fill'), the canonical home buildSnapshot + the Fill panel read, so it
 *  renders through the same pipeline as a hand-authored gradient. */
export function addGradientShape(
  graph: SceneGraph, id: string, parent: string, x: number, y: number, w: number, h: number,
  paint: FillPaint, opacity = 100,
): string {
  const node = {
    id, name: id, parent, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation: 0, width: w, height: h } },
      { id: `${id}_s`, type: 'Style', props: { opacity } },
      { id: `${id}_fx`, type: 'fx', props: { fill: paint } },
    ],
  } as unknown as SceneNode;
  graph.addChild(parent, node);
  return id;
}

/** Add a text layer (Text.content / Text.fill are the exposed props). */
export function addText(
  graph: SceneGraph, id: string, parent: string, content: string, x: number, y: number,
  size: number, weight: number, fill: string, align: 'left' | 'center' | 'right' = 'center',
): string {
  const node = {
    id, name: id, parent, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x, y, rotation: 0 } },
      { id: `${id}_c`, type: 'Text', props: { content, fontSize: size, fontWeight: weight, opacity: 100, fill, align } },
    ],
  } as unknown as SceneNode;
  graph.addChild(parent, node);
  return id;
}

/** Add an image layer. `src` starts empty (placeholder quad) — an exposed image
 *  field writes a URL to Transform.src to swap the picture. The image stretches
 *  to the authored w×h box. */
export function addImage(
  graph: SceneGraph, id: string, parent: string, x: number, y: number, w: number, h: number, src = '',
): string {
  const node = {
    id, name: id, parent, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'image', x, y, rotation: 0, width: w, height: h, src, assetId: '' } },
    ],
  } as unknown as SceneNode;
  graph.addChild(parent, node);
  return id;
}

/** Keyframe a prop on a node in the LIVE scene (seconds → layer time). Only used
 *  by build — thumbnails render the static resting state, no animation. */
export function kf(id: string, prop: string, frames: Frame[]): void {
  for (const [t, v, e] of frames) liveKf(id, prop, t, v, e);
}
