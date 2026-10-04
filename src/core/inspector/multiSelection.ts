/**
 * Multi-selection editing model for the inspector.
 *
 * ## The one rule
 *
 * A property row in the inspector describes the SELECTION, not the first
 * selected layer. With three layers selected, "Position X" is one of two
 * things: a number every layer agrees on, or MIXED — and both are still
 * editable. Typing a value sets every layer to it; dragging a mixed field
 * moves every layer by the same delta from where each one was; `+10` and
 * `*2` are evaluated per layer against that layer's own value. The stopwatch,
 * the keyframe toggle and the reset act on all of them.
 *
 * ## Why this is a module and not a hook
 *
 * These are the pre-engine writers (the engine's property handlers and the
 * remaining legacy callers use them). Static writes go straight to the scene
 * graph; keyframe writes run in ONE `runAnimEdit` around ONE animation batch.
 * The debounced recorder that used to give the static writes an undo entry is
 * gone (B5 round 2): called from an engine command they are part of its
 * inverse; called around the engine they have no undo of their own.
 *
 * ## Readers and writers are pluggable
 *
 * The default read/write path is the property-value seam
 * (`readStaticPropertyValue` / `writeStaticPropertyValue`), which covers
 * transform, effect, mask, path-op and text-animator paths. A caller whose
 * value lives somewhere that seam cannot see — stroke width inside the paint
 * stack, a material percentage — supplies its own `read`/`writeStatic`, and
 * the mixed detection, relative apply and undo grouping are unchanged.
 */

import type { Command } from '@motion/engine-api';

/** Values closer than this are "the same" — sub-display-precision noise. */
export const MIXED_EPSILON = 1e-6;

export interface MultiValue {
  /** The primary (first) node's value; what the field shows when not mixed. */
  value: number;
  /** True when at least two nodes disagree. */
  mixed: boolean;
  /** How many of the nodes actually HAVE this property. */
  present: number;
  /** Nodes whose value could be read, in selection order. */
  nodeIds: string[];
  /** True when the property is animated on ANY node. */
  animated: boolean;
  /** True when animated on EVERY node that has it. */
  allAnimated: boolean;
}

export interface PropertyAccess {
  /** Static (un-keyframed) value on one node; `undefined` = node lacks it. */
  read?: (nodeId: string) => number | undefined;
  /** Static write on one node. Return false when nothing could take it. */
  writeStatic?: (nodeId: string, value: number) => boolean;
  /**
   * B3z: the ENGINE route of a property the catalog may not list yet (a plugin
   * panel's param before its panel group exists — layout/Inspector/
   * pluginParamEdits.ts): the commands for per-layer values (stored units) and
   * for the stopwatch ON, addressed by path and self-seeding.
   */
  engine?: {
    commands: (writes: ReadonlyArray<{ nodeId: string; value: number }>, opts: { seconds: number; autoKeyframe: boolean }) => Command[];
    stopwatchOn: (nodeIds: ReadonlyArray<string>, seconds: number) => Command[];
  };
}

export interface ApplyOptions extends PropertyAccess {
  /** Composition time — each node's keyframe axis is derived from it. */
  compTime: number;
  /** Auto-keyframe preference: an unanimated node still gets a keyframe. */
  autoKeyframe?: boolean;
  /** History label. */
  label?: string;
  /** Coalesces consecutive edits (a drag) into one undo step. */
  mergeKey?: string;
}

/** How close (seconds) the playhead must be to count as "on" a keyframe. */
export const KEYFRAME_EPS = 1e-4;
