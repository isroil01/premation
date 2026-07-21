/**
 * Minimal node builders shared by authored templates. These mirror the exact
 * SceneNode/Component shapes seedSaaSAd uses (Transform carries SCENE_KIND_PROP
 * + geometry; Style carries fill/opacity; Text carries content/font/fill), so
 * templates render through the same buildSnapshot pipeline as everything else.
 *
 * Every builder takes the target `graph` so a template's `layout()` can be built
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
 *  by build() — thumbnails render the static resting state, no animation. */
export function kf(id: string, prop: string, frames: Frame[]): void {
  for (const [t, v, e] of frames) liveKf(id, prop, t, v, e);
}
