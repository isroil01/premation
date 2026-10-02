/**
 * What a layer BUILDER writes into — the subset of the old scene graph +
 * animation engine an insert needs, as an interface.
 *
 * The inserts (a shape, a text preset, a camera, a UI mock-up, an imported SVG
 * icon…) were written against the page replica's singletons. Written against
 * a `LayerSink` instead, the same builder lays its layers into a
 * {@link FragmentBuilder} (the app: one `pasteLayers`, no replica) — and,
 * while the TypeScript scene graph still exists, into that graph too, which is
 * how the parity tests pin the fragment against the old off-document build.
 *
 * `FragmentBuilder` implements it directly. `parent` is a layer of the sink or
 * the composition (any id that is not a layer of the sink = top level).
 */

import type { FragmentBar, FragmentKeyframe, FragmentNodeInput } from './fragmentBuilder';

export interface LayerSink {
  /** Add a node literal IN FRONT of the siblings added before it. */
  addChild(parent: string, node: FragmentNodeInput): void;
  /** Write a key on the layer's `fx` component (created on demand); undefined deletes. */
  setFxKey(id: string, key: string, value: unknown): void;
  /** One scalar keyframe (layer seconds). */
  setKeyframe(id: string, prop: string, t: number, value: number, easing?: string): void;
  /** A whole scalar track. */
  setKeyframes(id: string, prop: string, keyframes: readonly FragmentKeyframe[]): void;
  /** An expression on a property (empty removes it). */
  setExpression(id: string, prop: string, src: string): void;
  /**
   * The layer's timeline bars, in frames of the target comp. Optional: the
   * page replica's timeline derives a new layer's bar itself (a media layer's
   * bounded by its footage); a fragment has to carry it.
   */
  setBars?(id: string, bars: readonly FragmentBar[]): void;
}

/** A new MEDIA layer's bar (TimelineController.syncFromScene's rule): bounded by its footage, `sourceFrames` long; null = unbounded (the engine's default bar). */
export function mediaBar(sourceFrames: number | null, compFrames: number): FragmentBar[] {
  if (sourceFrames === null) return [];
  return [{ start: 0, duration: Math.min(compFrames, sourceFrames), sourceIn: 0, sourceDuration: sourceFrames }];
}
