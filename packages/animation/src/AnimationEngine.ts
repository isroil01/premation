/**
 * AnimationEngine — the value authority.
 *
 * Holds property tracks keyed by (nodeId, prop). Given a time it samples every
 * track and returns a SceneValueSnapshot the renderer merges over the scene's
 * base values. It never mutates the scene graph during playback (TAD §8.2):
 * authoring keyframes are the truth; sampled values are derived and disposable.
 */

import type { PropPath, PropertyTrack, SceneValueSnapshot, EasingKind, BezierHandles, Keyframe } from './types';
import { sampleTrack, upsertKeyframe, applyRoving, applyRovingSpatial, smoothTrackTangents, clearTrackTangents } from './interpolate';
import { compileExpression, type CompiledExpression, type ExprContext, type ExprResult } from './expressions';
import {
  sampleDataTrack,
  upsertDataKeyframe,
  cloneDataValue,
  type DataKind,
  type DataTrack,
  type DataValue,
  type DataKeyframe,
} from './dataTracks';

/**
 * Notified whenever a node's animation changes. `'*'` means "all nodes"
 * (e.g. after a wholesale restore). The app binds this to its EventBus at boot;
 * keeping it injectable is what lets this engine stay framework-independent.
 */
export type AnimationChangeListener = (nodeId: string) => void;
/** Supplies the audio amplitude (0..1) at time `t` for the `audio` expression
 *  accessor. Injected by the host so this engine stays framework-independent. */
export type AudioLevelProvider = (t: number) => number;
/** Resolves a named slider control's value at time `t` for the `ctrl(name)`
 *  expression accessor. Injected by the host (reads the scene's control rigs). */
export type ControlProvider = (name: string, t: number) => number;
/** Resolves a layer NAME to a nodeId for the `layer(name, prop)` expression
 *  accessor. Injected by the host (the engine doesn't know scene names).
 *  `null` = no such layer. */
export type LayerResolver = (name: string) => string | null;

/**
 * The prefix that makes a cross-layer reference survive a rename.
 *
 * `layer('Hero depth', 'x')` resolves a NAME at evaluation time, every frame,
 * which means renaming the layer silently breaks the reference — and the
 * symptom (a value quietly reading 0) appears nowhere near the rename that
 * caused it.
 *
 * `layer('#n_a1b2c3', 'x')` names the layer's stable id instead. The `#` is
 * what makes the two unambiguous: without it, a layer whose NAME happened to
 * equal another layer's id would resolve to the wrong one, and that bug would
 * be essentially undiagnosable.
 *
 * Fixed HERE, in the one place every cross-layer read passes through, rather
 * than in the proxy path that found it. `layer`, `layerAt`, `toComp` and every
 * other name-taking API gets it from one change, and a user-authored
 * expression can use the id form the same way a plugin-written one does.
 */
export const LAYER_ID_PREFIX = '#';

/** True for a reference that names an id rather than a layer name. */
export function isLayerIdRef(ref: string): boolean {
  return ref.startsWith(LAYER_ID_PREFIX);
}

/** `#<id>` → the id; anything else → whatever the host's name lookup says. */
export function resolveLayerRef(ref: string, byName: LayerResolver): string | null {
  if (isLayerIdRef(ref)) {
    const id = ref.slice(LAYER_ID_PREFIX.length);
    return id.length > 0 ? id : null;
  }
  return byName(ref);
}

/** `n_a1b2c3` → `#n_a1b2c3`. What an author-time resolution should write. */
export function layerIdRef(nodeId: string): string {
  return `${LAYER_ID_PREFIX}${nodeId}`;
}
/** Supplies a node's static/base value for a prop (e.g. the Transform
 *  component's x/y) when a cross-layer read finds no keyframe track. Injected
 *  by the host; `undefined` = no base value either. */
export type BaseValueProvider = (nodeId: string, prop: PropPath) => number | undefined;
/** Supplies composition metadata (`thisComp`) for expressions. */
export type CompInfoProvider = () => {
  width: number;
  height: number;
  duration: number;
  fps: number;
  numLayers: number;
};
/** Supplies layer metadata (`thisLayer`) for expressions. */
/** Content bounds of a layer at a time — see `setSourceRectProvider`. */
export type SourceRectProvider = (
  nodeId: string,
  t: number,
  extents: boolean,
) => import('./expressions').SourceRect | undefined;

/**
 * A layer's layer-local → composition placement at a time — see
 * `setLayerSpaceProvider`. Backs `toComp` / `toWorld` / `fromComp` /
 * `fromWorld`.
 *
 * `name` is null for the layer the expression is ON, or another layer's NAME,
 * matching how `layer(name, prop)` addresses layers. `self` is that node's id,
 * so the provider can resolve the null case without the engine having to.
 */
export type LayerSpaceProvider = (
  self: string,
  name: string | null,
  t: number,
) => import('./expressions').LayerSpace | undefined;

export type LayerInfoProvider = (nodeId: string) => {
  name: string;
  width: number;
  height: number;
};

/**
 * Markers for `marker.*` — see `setMarkerProvider`.
 *
 * `scope: 'layer'` asks for `nodeId`'s own markers; `'comp'` ignores `nodeId`
 * and asks for the composition's. Both must be in COMPOSITION seconds, which
 * for layer markers means the host has already undone the layer-relative
 * storage — the engine cannot do that conversion because it does not know
 * where a layer starts.
 */
export type MarkerProvider = (
  nodeId: string,
  scope: 'comp' | 'layer',
) => readonly import('./expressions').ExprMarkerData[];

/** Which vector component a decomposed track reads from an `[x, y, z]`
 *  expression return. Unknown props read component 0. */
function componentIndexOf(prop: PropPath): number {
  if (prop === 'y' || prop === 'scaleY' || prop === 'anchorY') return 1;
  if (prop === 'z' || prop === 'rotationZ') return 2;
  return 0;
}

/**
 * A property's expression as the engine holds it: the compiled source plus
 * whether it currently drives the value.
 *
 * `enabled` is deliberately NOT a field of `CompiledExpression`. Compilation is
 * a pure function of the source text and is shared by `previewExpression`,
 * which compiles a draft that is not attached to anything; enablement is state
 * that belongs to the (node, prop) slot. Putting the bit on the compilation
 * would make a preview carry an enabled-ness it has no business having.
 */
interface ExpressionEntry {
  compiled: CompiledExpression;
  enabled: boolean;
  /** See `ExpressionState.authoredBy`. */
  authoredBy?: string;
}

/**
 * The serializable form of the above — the undo seam and the persisted shape.
 *
 * It is what `snapshot()` writes, what `setExpressionState` takes back, and
 * what a command stores as its before and after. Carrying `enabled` here rather
 * than encoding presence in a `string | null` is what makes "disable" and
 * "delete" different undo steps.
 */
export interface ExpressionState {
  src: string;
  enabled: boolean;
  /**
   * The plugin id that wrote this expression, when a plugin did.
   *
   * Absent means a person typed it, which is the overwhelmingly common case and
   * the reason this is optional rather than defaulted.
   *
   * It exists because an expression written through `animation.setExpression`
   * PERSISTS IN THE SAVED DOCUMENT and re-evaluates for whoever opens the
   * project next — it survives uninstalling the plugin, and it travels to
   * collaborators who never had it. Without provenance, a user seeing wrong
   * animation has no way to tell a formula they wrote from one a plugin left
   * behind, and no way to find the rest of them.
   *
   * One field, and it is what makes an origin label, a "this project contains
   * expressions from a plugin you do not have" state, and a bulk revert
   * possible at all. None of those can be added later to expressions already
   * written without it.
   */
  authoredBy?: string;
}

/** Small deterministic string hash → a noise-phase seed (NOT crypto). */
function stringSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0) % 10007;
}

export class AnimationEngine {
  private tracks = new Map<string, Map<PropPath, PropertyTrack>>();
  /**
   * Per-property expressions that override the sampled value each frame —
   * unless DISABLED, in which case the entry is retained and ignored.
   *
   * Presence and enablement are two questions, not one. `hasExpression` answers
   * the first (is there a formula to show in the editor?) and
   * `isExpressionEnabled` the second (does it drive the value?). Anything that
   * conflates them reads a disabled expression as an active one, which compiles
   * fine and is wrong at every frame.
   */
  private expressions = new Map<string, Map<PropPath, ExpressionEntry>>();
  /** Change sink — no-op until the host binds one via setChangeListener. */
  private changeListener: AnimationChangeListener = () => {};
  /** >0 while inside batch; notifications are held until the batch closes. */
  private batchDepth = 0;
  /** True when any mutation happened inside the current batch. */
  private batchDirty = false;

  /**
   * Route every mutation's change signal through here.
   *
   * The app's listener chain is EXPENSIVE — a scene bump, a hit-test rebuild,
   * autosave scheduling — and it runs synchronously. That is the right trade
   * for one interactive edit, and exactly wrong for a bulk write: importing an
   * animated SVG fired it once per track and froze the app for the sum.
   */
  private notifyChange(nodeId: string): void {
    if (this.batchDepth > 0) {
      this.batchDirty = true;
      return;
    }
    this.changeListener(nodeId);
  }

  /**
   * Run `fn` with change notifications held, then emit ONE `'*'` (all nodes)
   * notification if anything changed. Nests; only the outermost batch flushes.
   * The flush fires even when `fn` throws — listeners must not be left stale
   * about mutations that happened before the error.
   */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.batchDirty) {
        this.batchDirty = false;
        this.changeListener('*');
      }
    }
  }
  /** Audio amplitude source — 0 until the host binds the AudioEngine. */
  private audioLevel: AudioLevelProvider = () => 0;
  /** Slider-control source — 0 until the host binds the scene rig lookup. */
  private controlProvider: ControlProvider = () => 0;
  /** Layer name → nodeId lookup for `layer` — unknown until the host binds. */
  private layerResolver: LayerResolver = () => null;
  /** Base (un-keyframed) value source for cross-layer reads — none by default. */
  private baseValueProvider: BaseValueProvider = () => undefined;
  /** Composition metadata provider for `thisComp`. */
  private compInfoProvider: CompInfoProvider = () => ({
    width: 1920,
    height: 1080,
    duration: 10,
    fps: 60,
    numLayers: 1,
  });
  /** Layer metadata provider for `thisLayer`. */
  private sourceRectProvider: SourceRectProvider = () => undefined;

  /** Layer placement provider for the coordinate-space functions. */
  private layerSpaceProvider: LayerSpaceProvider = () => undefined;

  private layerInfoProvider: LayerInfoProvider = () => ({
    name: 'Layer',
    width: 1920,
    height: 1080,
  });

  /**
   * Defaults to NO markers rather than throwing, unlike `layerSpaceProvider`.
   * An empty marker list is an ordinary state — most comps have none — so
   * `marker.numKeys === 0` is the honest answer here, not a missing wire.
   */
  private markerProvider: MarkerProvider = () => [];

  /**
   * Bind the change sink (the app maps this onto its EventBus 'AnimationChanged'
   * so the render cache, timeline, inspector and history stay in sync).
   */
  setChangeListener(listener: AnimationChangeListener): void {
    this.changeListener = listener;
  }

  /** Bind the audio-amplitude source used by the `audio` expression accessor. */
  setAudioLevelProvider(provider: AudioLevelProvider): void {
    this.audioLevel = provider;
  }

  /** Bind the slider-control source used by the `ctrl(name)` accessor. */
  setControlProvider(provider: ControlProvider): void {
    this.controlProvider = provider;
  }

  /** Bind the layer-name → nodeId lookup used by `layer`/`layerAt`. */
  setLayerResolver(resolver: LayerResolver): void {
    this.layerResolver = resolver;
  }

  /** Bind the base-value fallback used by `layer`/`layerAt` when the
   *  referenced layer has no keyframe track for the prop (the host reads the
   *  node's static Transform/component props). */
  setBaseValueProvider(provider: BaseValueProvider): void {
    this.baseValueProvider = provider;
  }

  /** Bind composition metadata (`thisComp`) provider. */
  setCompInfoProvider(provider: CompInfoProvider): void {
    this.compInfoProvider = provider;
  }

  /** Bind layer metadata (`thisLayer`) provider. */
  setLayerInfoProvider(provider: LayerInfoProvider): void {
    this.layerInfoProvider = provider;
  }

  /**
   * Supplies `sourceRectAtTime` with a layer's CONTENT bounds at a time.
   *
   * Defaults to undefined rather than to the layer box: the expression falls
   * back to the box itself, and having the default here too would make an
   * unwired provider indistinguishable from a correctly wired one that happens
   * to return the box — which is how a provider stays unwired for months (see
   * the four that did exactly that before the layer/comp providers were
   * connected).
   */
  setSourceRectProvider(provider: SourceRectProvider): void {
    this.sourceRectProvider = provider;
  }

  /**
   * Supplies the coordinate-space functions with a layer's placement.
   *
   * Defaults to undefined for the same reason `sourceRectProvider` does, and
   * the consequence here is stronger: with no provider the host THROWS a stated
   * error rather than converting. An unwired provider that silently returned
   * identity would make `toComp` report its input back as the answer, which is
   * correct-looking for a layer at the origin and wrong for every other one.
   */
  setLayerSpaceProvider(provider: LayerSpaceProvider): void {
    this.layerSpaceProvider = provider;
  }

  /**
   * Bind `marker.*` to the timeline's markers.
   *
   * The engine holds keyframes, not markers — markers live on the timeline
   * (`packages/timeline`), which the engine has no reference to and should
   * not grow one. Same separation as `sourceRectProvider` and
   * `layerSpaceProvider`: the host owns the lookup, the engine owns the AE
   * semantics built on top of it.
   */
  setMarkerProvider(provider: MarkerProvider): void {
    this.markerProvider = provider;
  }

  /** All property tracks for a node. */
  tracksFor(nodeId: string): PropertyTrack[] {
    const byProp = this.tracks.get(nodeId);
    return byProp ? Array.from(byProp.values()) : [];
  }

  hasAnimation(nodeId: string): boolean {
    return (this.tracks.get(nodeId)?.size ?? 0) > 0;
  }

  /**
   * Replace a whole track in one shot.
   *
   * `setKeyframe` is built for interactive authoring: it re-scans and re-sorts
   * the track and fires a change notification PER CALL. That is right for one
   * keyframe from one drag and quadratic for a generated track — importing an
   * animated SVG drove it with hundreds of keyframes per track and thousands of
   * notifications, which froze the app for as long as the import took. Bulk
   * writes sort once and notify once.
   *
   * Existing keyframes on the track are discarded; callers building a track
   * from scratch are the only intended users.
   */
  setKeyframes(nodeId: string, prop: PropPath, keyframes: readonly Keyframe[]): void {
    if (keyframes.length === 0) {
      this.tracks.get(nodeId)?.delete(prop);
      this.notifyChange(nodeId);
      return;
    }
    let byProp = this.tracks.get(nodeId);
    if (!byProp) {
      byProp = new Map();
      this.tracks.set(nodeId, byProp);
    }
    // De-duplicate by time (last wins), then sort — one pass, not one per key.
    const byTime = new Map<number, Keyframe>();
    for (const kf of keyframes) byTime.set(kf.t, { ...kf });
    const sorted = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
    byProp.set(prop, { nodeId, prop, keyframes: sorted });
    this.notifyChange(nodeId);
  }

  /**
   * Add/replace a keyframe on (nodeId, prop). Re-keying an existing time keeps
   * its auxiliary fields (easing/bezier/roving/spatial tangents) unless a new
   * easing is passed — changing a value shouldn't silently reset its curve.
   */
  setKeyframe(nodeId: string, prop: PropPath, t: number, value: number, easing?: EasingKind): void {
    let byProp = this.tracks.get(nodeId);
    if (!byProp) {
      byProp = new Map();
      this.tracks.set(nodeId, byProp);
    }
    const track = byProp.get(prop) ?? { nodeId, prop, keyframes: [] };
    const existing = track.keyframes.find((k) => k.t === t);
    const next: Keyframe = existing
      ? { ...existing, value, easing: easing ?? existing.easing }
      : { t, value, easing };
    track.keyframes = upsertKeyframe(track.keyframes, next);
    byProp.set(prop, track);
    this.notifyChange(nodeId);
  }

  removeKeyframe(nodeId: string, prop: PropPath, t: number): void {
    const track = this.tracks.get(nodeId)?.get(prop);
    if (!track) return;
    track.keyframes = track.keyframes.filter((k) => k.t !== t);
    if (track.keyframes.length === 0) this.tracks.get(nodeId)?.delete(prop);
    this.notifyChange(nodeId);
  }

  /** Move a keyframe from `fromT` to `toT` (preserving its value/easing). */
  moveKeyframe(nodeId: string, prop: PropPath, fromT: number, toT: number): void {
    if (fromT === toT) return;
    const track = this.tracks.get(nodeId)?.get(prop);
    const kf = track?.keyframes.find((k) => k.t === fromT);
    if (!track || !kf) return;
    const without = track.keyframes.filter((k) => k.t !== fromT);
    track.keyframes = upsertKeyframe(without, { ...kf, t: toT });
    this.notifyChange(nodeId);
  }

  /** Set the easing on the segment that starts at keyframe `t`. */
  setEasing(nodeId: string, prop: PropPath, t: number, easing: EasingKind): void {
    const kf = this.tracks.get(nodeId)?.get(prop)?.keyframes.find((k) => k.t === t);
    if (!kf) return;
    kf.easing = easing;
    // Seed default handles when switching to a custom bezier curve.
    if (easing === 'bezier') {
      if (!kf.bezier) kf.bezier = [0.25, 0.1, 0.25, 1];
      if (kf.continuous === undefined) kf.continuous = true;
    }
    if ((easing === 'autoBezier' || easing === 'continuousBezier') && !kf.bezier) kf.bezier = [0.333, 0, 0.667, 1];
    this.notifyChange(nodeId);
  }

  /** Apply an Easy-Ease-style bezier to the segment starting at `t`. */
  setBezier(nodeId: string, prop: PropPath, t: number, bezier: BezierHandles, continuous?: boolean): void {
    const kf = this.tracks.get(nodeId)?.get(prop)?.keyframes.find((k) => k.t === t);
    if (!kf) return;
    kf.easing = 'bezier';
    kf.bezier = [...bezier] as BezierHandles;
    if (continuous !== undefined) {
      kf.continuous = continuous;
    } else if (kf.continuous === undefined) {
      kf.continuous = true;
    }
    this.notifyChange(nodeId);
  }

  /**
   * Set/clear the spatial bezier tangents on the keyframe at `t` (value-space
   * offsets — see Keyframe.si/so). `undefined` leaves a side untouched; `null`
   * clears it. Position tracks (x + y) edited together bend the motion path.
   */
  setSpatialTangent(
    nodeId: string,
    prop: PropPath,
    t: number,
    tangent: { si?: number | null; so?: number | null },
  ): void {
    const kf = this.tracks.get(nodeId)?.get(prop)?.keyframes.find((k) => k.t === t);
    if (!kf) return;
    if (tangent.si !== undefined) {
      if (tangent.si === null) delete kf.si;
      else kf.si = tangent.si;
    }
    if (tangent.so !== undefined) {
      if (tangent.so === null) delete kf.so;
      else kf.so = tangent.so;
    }
    this.notifyChange(nodeId);
  }

  /** Auto-bezier the whole track (Catmull-Rom spatial tangents — smooth path). */
  smoothSpatialTangents(nodeId: string, prop: PropPath): void {
    const track = this.tracks.get(nodeId)?.get(prop);
    if (!track || track.keyframes.length < 2) return;
    track.keyframes = smoothTrackTangents(track.keyframes);
    this.notifyChange(nodeId);
  }

  /** Remove every spatial tangent on the track (straight-line path). */
  clearSpatialTangents(nodeId: string, prop: PropPath): void {
    const track = this.tracks.get(nodeId)?.get(prop);
    if (!track) return;
    track.keyframes = clearTrackTangents(track.keyframes);
    this.notifyChange(nodeId);
  }

  /** Toggle a keyframe's roving flag and re-time the track for constant speed.
   *  On a position axis whose sibling track shares the same keyframe grid, the
   *  pair roves together along the 2D spatial ARC (AE's Rove Across Time);
   *  roving x and y independently by their own value distance is constant-speed
   *  only on an axis-aligned path. The UI toggles both axes of a merged
   *  Position row in turn, and the paired retime is deterministic on the same
   *  input, so the second call is a no-op rather than a double-move. */
  setRoving(nodeId: string, prop: PropPath, t: number, roving: boolean): void {
    const track = this.tracks.get(nodeId)?.get(prop);
    if (!track) return;
    const flagged = track.keyframes.map((k) => (k.t === t ? { ...k, roving } : { ...k }));
    const sibling: PropPath | null = prop === 'x' ? 'y' : prop === 'y' ? 'x' : null;
    const sibTrack = sibling ? this.tracks.get(nodeId)?.get(sibling) : undefined;
    if (sibTrack) {
      const sibFlagged = sibTrack.keyframes.map((k) => (k.t === t ? { ...k, roving } : { ...k }));
      const paired = prop === 'x'
        ? applyRovingSpatial(flagged, sibFlagged)
        : applyRovingSpatial(sibFlagged, flagged);
      if (paired) {
        track.keyframes = prop === 'x' ? paired.x : paired.y;
        sibTrack.keyframes = prop === 'x' ? paired.y : paired.x;
        this.notifyChange(nodeId);
        return;
      }
    }
    track.keyframes = applyRoving(flagged);
    this.notifyChange(nodeId);
  }

  /** Replace the keyframe at `oldT` with new time/value/easing/bezier. */
  updateKeyframe(
    nodeId: string,
    prop: PropPath,
    oldT: number,
    patch: { t?: number; value?: number; easing?: EasingKind; bezier?: BezierHandles; roving?: boolean; continuous?: boolean },
  ): void {
    const track = this.tracks.get(nodeId)?.get(prop);
    const kf = track?.keyframes.find((k) => k.t === oldT);
    if (!track || !kf) return;
    const next: Keyframe = {
      t: patch.t ?? kf.t,
      value: patch.value ?? kf.value,
      easing: patch.easing ?? kf.easing,
      bezier: patch.bezier ?? kf.bezier,
      continuous: patch.continuous ?? kf.continuous,
      roving: patch.roving ?? kf.roving,
      si: kf.si,
      so: kf.so,
    };
    track.keyframes = upsertKeyframe(track.keyframes.filter((k) => k.t !== oldT), next);
    this.notifyChange(nodeId);
  }

  /** Remove all keyframes for a property (turn animation off). */
  removeTrack(nodeId: string, prop: PropPath): void {
    const byProp = this.tracks.get(nodeId);
    if (!byProp?.delete(prop)) return;
    if (byProp.size === 0) this.tracks.delete(nodeId);
    this.notifyChange(nodeId);
  }

  isAnimated(nodeId: string, prop: PropPath): boolean {
    return (this.tracks.get(nodeId)?.get(prop)?.keyframes.length ?? 0) > 0;
  }

  /** All prop-paths with at least one keyframe for `nodeId`. Used by the
   *  AE-style `U` shortcut to filter the timeline to animated properties. */
  getAnimatedPropPaths(nodeId: string): PropPath[] {
    const byProp = this.tracks.get(nodeId);
    if (!byProp) return [];
    return [...byProp.entries()]
      .filter(([, track]) => track.keyframes.length > 0)
      .map(([prop]) => prop);
  }

  /** All nodeIds that have at least one keyframe track (used by `UU`). */
  getAnimatedNodeIds(): string[] {
    return [...this.tracks.entries()]
      .filter(([, byProp]) => [...byProp.values()].some((t) => t.keyframes.length > 0))
      .map(([nodeId]) => nodeId);
  }

  // ── Atomic track capture/restore ────────────────────────────────
  // These give the command layer a precise before/after handle on a single
  // (nodeId, prop) track — the basis for typed, reversible keyframe commands
  // (as opposed to the coarse whole-document history snapshot). They return /
  // accept deep copies so callers can hold the state across an undo/redo.

  /** Deep copy of a track's keyframes, or `null` when the track is absent. */
  getTrackKeyframes(nodeId: string, prop: PropPath): Keyframe[] | null {
    const track = this.tracks.get(nodeId)?.get(prop);
    if (!track) return null;
    return track.keyframes.map((k) => ({ ...k }));
  }

  /**
   * Replace a track's keyframes wholesale (deep-copied in). Passing `null` or an
   * empty array removes the track. Emits `AnimationChanged` like the other
   * mutators so the UI, render cache and history observers stay in sync.
   */
  setTrackKeyframes(nodeId: string, prop: PropPath, keyframes: Keyframe[] | null): void {
    if (!keyframes || keyframes.length === 0) {
      const byProp = this.tracks.get(nodeId);
      if (byProp?.delete(prop) && byProp.size === 0) this.tracks.delete(nodeId);
      this.notifyChange(nodeId);
      return;
    }
    let byProp = this.tracks.get(nodeId);
    if (!byProp) {
      byProp = new Map();
      this.tracks.set(nodeId, byProp);
    }
    byProp.set(prop, { nodeId, prop, keyframes: keyframes.map((k) => ({ ...k })) });
    this.notifyChange(nodeId);
  }

  /**
   * Sample one property at time `t`. If the property has a valid expression it
   * overrides the keyframed value (the keyframed value is passed in as `value`).
   * Returns `undefined` when neither keyframes nor an expression apply.
   */
  sample(nodeId: string, prop: PropPath, t: number): number | undefined {
    // Fast path: no enabled expression on THIS property means no cycle is
    // possible from here, so skip the visited-Set + try/catch machinery — this
    // is the per-property-per-frame hot path and the Set alone dominated it.
    // Expression chains that *reach* a plain property go through
    // sampleInternal directly (layerAt → crossLayerValue) and keep their guards.
    const entry = this.expressions.get(nodeId)?.get(prop);
    if (!entry?.enabled) {
      const track = this.tracks.get(nodeId)?.get(prop);
      return (track ? sampleTrack(track, t) : undefined) ?? this.baseValueProvider(nodeId, prop);
    }
    try {
      return this.sampleInternal(nodeId, prop, t, new Set(), 0);
    } catch (e) {
      // If cycle or max depth exceeded during viewport rendering, safely fall back to track/base
      const track = this.tracks.get(nodeId)?.get(prop);
      return (track ? sampleTrack(track, t) : undefined) ?? this.baseValueProvider(nodeId, prop);
    }
  }

  private sampleInternal(
    nodeId: string,
    prop: PropPath,
    t: number,
    visited: Set<string>,
    depth: number,
  ): number | undefined {
    const key = `${nodeId}:${prop}`;
    if (visited.has(key)) {
      throw new Error(`Cycle detected across expression evaluation (${nodeId}:${prop})`);
    }
    if (depth > 16) {
      throw new Error(`Maximum cross-layer evaluation depth (16) exceeded (${nodeId}:${prop})`);
    }

    visited.add(key);
    try {
      const track = this.tracks.get(nodeId)?.get(prop);
      const base = track ? sampleTrack(track, t) : undefined;
      const entry = this.expressions.get(nodeId)?.get(prop);
      // The one line where enablement decides anything. A disabled expression
      // is skipped entirely — not run-and-discarded — so it costs nothing per
      // frame and cannot raise a cycle error from a formula nobody is using.
      if (entry?.enabled) {
        const r = entry.compiled.run(this.exprContext(nodeId, prop, t, base, visited, depth + 1));
        if (r.error) {
          if (/Cycle detected/i.test(r.error) || /Maximum cross-layer/i.test(r.error)) {
            throw new Error(r.error);
          }
        }
        if (r.value !== null) {
          // Vector return (`[x, y]`): pick the component matching THIS track.
          if (Array.isArray(r.value)) {
            const idx = componentIndexOf(prop);
            return r.value[Math.min(idx, r.value.length - 1)];
          }
          return r.value;
        }
      }
      return base ?? this.baseValueProvider(nodeId, prop);
    } finally {
      visited.delete(key);
    }
  }

  /**
   * Build the run context for an expression on (nodeId, prop) at time `t`.
   * `selfAt` samples the property's own KEYFRAMES (never the expression — no
   * recursion); `layerAt` resolves cross-layer reads with cycle/depth checks.
   */
  private exprContext(
    nodeId: string,
    prop: PropPath,
    t: number,
    base?: number,
    visited = new Set<string>(),
    depth = 0,
  ): ExprContext {
    const track = this.tracks.get(nodeId)?.get(prop);
    const kfs = track?.keyframes ?? [];
    return {
      time: t,
      value: base ?? 0,
      audio: this.audioLevel(t),
      ctrl: (name) => this.controlProvider(name, t),
      selfAt: (tt) => (track ? sampleTrack(track, tt) : undefined) ?? 0,
      selfSpan: kfs.length > 0 ? { start: kfs[0]!.t, end: kfs[kfs.length - 1]!.t } : null,
      layerAt: (name, p, tt) => this.crossLayerValue(name, p, tt, visited, depth),
      comp: this.compInfoProvider(),
      layerInfo: this.layerInfoProvider(nodeId),
      // Needs no provider: the engine already holds this property's track, so
      // numKeys / key(n) / nearestKey() are free.
      keyTimes: kfs.map((k) => k.t),
      // Does need one — measuring content bounds requires the scene graph and,
      // for text, a DOM measuring context, neither of which belongs in here.
      sourceRectAt: (tt, extents) => this.sourceRectProvider(nodeId, tt, extents),
      // Same reason: composing a layer's world matrix needs the scene graph.
      spaceAt: (name, tt) => this.layerSpaceProvider(nodeId, name, tt),
      // And again: markers belong to the timeline, not to the engine.
      markersAt: (which) => this.markerProvider(nodeId, which),
      // Per-(node, prop) noise phase so `wiggle` on x and y move
      // independently (AE) — still deterministic run to run.
      propSeed: stringSeed(`${nodeId}:${prop}`),
    };
  }

  /**
   * Resolve `layer(name, prop)` across layers with cycle detection and depth caps.
   * Chaining expressions across layers is supported up to depth 16; if a cycle
   * or depth overflow occurs, an explicit error is thrown.
   */
  private crossLayerValue(
    name: string,
    prop: PropPath,
    t: number,
    visited: Set<string>,
    depth: number,
  ): number | undefined {
    const targetNodeId = resolveLayerRef(name, this.layerResolver);
    if (!targetNodeId) return undefined;
    return this.sampleInternal(targetNodeId, prop, t, visited, depth);
  }

  /**
   * Evaluate an arbitrary expression source against (nodeId, prop) at time
   * `t` with the SAME context sample uses — so editor previews see
   * valueAtTime/layer/loopOut and cycle errors exactly as playback will.
   */
  previewExpression(nodeId: string, prop: PropPath, src: string, t: number): ExprResult {
    const track = this.tracks.get(nodeId)?.get(prop);
    const base = track ? sampleTrack(track, t) : undefined;
    const visited = new Set<string>([`${nodeId}:${prop}`]);
    return compileExpression(src).run(this.exprContext(nodeId, prop, t, base, visited, 1));
  }

  /** Evaluate a single node's animated/expressed properties at time `t`.
   *  Used by per-layer time remapping (each layer samples at its own time). */
  evaluateNode(nodeId: string, t: number): Map<PropPath, number> {
    const values = new Map<PropPath, number>();
    // Iterate the two key sources directly instead of unioning them through a
    // throwaway Set — this runs once per node per frame.
    const byProp = this.tracks.get(nodeId);
    const byExpr = this.expressions.get(nodeId);
    if (byProp) {
      for (const prop of byProp.keys()) {
        const v = this.sample(nodeId, prop, t);
        if (v !== undefined) values.set(prop, v);
      }
    }
    if (byExpr) {
      for (const prop of byExpr.keys()) {
        if (byProp?.has(prop)) continue;
        const v = this.sample(nodeId, prop, t);
        if (v !== undefined) values.set(prop, v);
      }
    }
    return values;
  }

  /** The node's animated time span (first→last keyframe across all its tracks),
   *  or `null` when it has no keyframes. Anchors time-stretch and reverse. */
  timeSpan(nodeId: string): { start: number; end: number } | null {
    const byProp = this.tracks.get(nodeId);
    if (!byProp) return null;
    let start = Infinity;
    let end = -Infinity;
    for (const track of byProp.values()) {
      const kfs = track.keyframes;
      if (kfs.length === 0) continue;
      start = Math.min(start, kfs[0]!.t);
      end = Math.max(end, kfs[kfs.length - 1]!.t);
    }
    return Number.isFinite(start) ? { start, end } : null;
  }

  /** Evaluate every animated/expressed property at time `t`. */
  evaluateScene(t: number): SceneValueSnapshot {
    const out = new Map<string, Map<PropPath, number>>();
    const nodeIds = new Set<string>([...this.tracks.keys(), ...this.expressions.keys()]);
    for (const nodeId of nodeIds) {
      const props = new Set<PropPath>([
        ...(this.tracks.get(nodeId)?.keys() ?? []),
        ...(this.expressions.get(nodeId)?.keys() ?? []),
      ]);
      const values = new Map<PropPath, number>();
      for (const prop of props) {
        const v = this.sample(nodeId, prop, t);
        if (v !== undefined) values.set(prop, v);
      }
      if (values.size) out.set(nodeId, values);
    }
    return out;
  }

  // ── Data tracks (non-scalar keyframes) ──────────────────────────
  // Typed values beside the number tracks: Source Text (hold), path points
  // and gradient stops (pairwise lerp). Same change-notification contract as
  // the scalar mutators, so autosave, the render cache and the timeline react
  // identically. See dataTracks.ts for the interpolation rules.

  private dataTracksMap = new Map<string, Map<PropPath, DataTrack>>();

  /**
   * Add/replace a data keyframe at `t` (deep-copies the value in).
   *
   * `easing` is optional and, when omitted on an EXISTING keyframe, leaves the
   * curve alone — mirroring `setKeyframe`, so re-keying a gradient's colour
   * does not silently flatten the ease it was travelling along.
   */
  setDataKeyframe(
    nodeId: string,
    prop: PropPath,
    kind: DataKind,
    t: number,
    value: DataValue,
    easing?: EasingKind,
  ): void {
    let byProp = this.dataTracksMap.get(nodeId);
    if (!byProp) {
      byProp = new Map();
      this.dataTracksMap.set(nodeId, byProp);
    }
    const track = byProp.get(prop) ?? { nodeId, prop, kind, keyframes: [] as DataKeyframe[] };
    track.keyframes = upsertDataKeyframe(track.keyframes, {
      t,
      value: cloneDataValue(value),
      ...(easing ? { easing } : {}),
    });
    byProp.set(prop, track);
    this.notifyChange(nodeId);
  }

  /**
   * Set the easing on the data-track segment that starts at `t`.
   *
   * The counterpart of `setEasing` for non-scalar tracks — animated gradients,
   * mask outlines and baked paths. Seeds default handles when switching to a
   * custom bezier, exactly as the scalar path does.
   */
  setDataEasing(nodeId: string, prop: PropPath, t: number, easing: EasingKind, bezier?: BezierHandles): void {
    const kf = this.dataTracksMap.get(nodeId)?.get(prop)?.keyframes.find((k) => k.t === t);
    if (!kf) return;
    kf.easing = easing;
    if (easing === 'bezier') kf.bezier = bezier ? ([...bezier] as BezierHandles) : (kf.bezier ?? [0.25, 0.1, 0.25, 1]);
    this.notifyChange(nodeId);
  }

  removeDataKeyframe(nodeId: string, prop: PropPath, t: number): void {
    const byProp = this.dataTracksMap.get(nodeId);
    const track = byProp?.get(prop);
    if (!byProp || !track) return;
    track.keyframes = track.keyframes.filter((k) => k.t !== t);
    if (track.keyframes.length === 0) {
      byProp.delete(prop);
      if (byProp.size === 0) this.dataTracksMap.delete(nodeId);
    }
    this.notifyChange(nodeId);
  }

  /** Move a data keyframe in time, keeping its value. */
  moveDataKeyframe(nodeId: string, prop: PropPath, fromT: number, toT: number): void {
    if (fromT === toT) return;
    const track = this.dataTracksMap.get(nodeId)?.get(prop);
    const kf = track?.keyframes.find((k) => k.t === fromT);
    if (!track || !kf) return;
    track.keyframes = upsertDataKeyframe(
      track.keyframes.filter((k) => k.t !== fromT),
      { ...kf, t: toT },
    );
    this.notifyChange(nodeId);
  }

  /** Sample a data track at `t` (undefined when the track is absent/empty). */
  sampleData(nodeId: string, prop: PropPath, t: number): DataValue | undefined {
    const track = this.dataTracksMap.get(nodeId)?.get(prop);
    return track ? sampleDataTrack(track, t) : undefined;
  }

  isDataAnimated(nodeId: string, prop: PropPath): boolean {
    return (this.dataTracksMap.get(nodeId)?.get(prop)?.keyframes.length ?? 0) > 0;
  }

  /** All data tracks for a node (deep values shared — treat as read-only). */
  dataTracksFor(nodeId: string): DataTrack[] {
    const byProp = this.dataTracksMap.get(nodeId);
    return byProp ? Array.from(byProp.values()) : [];
  }

  /** Deep copy of a data track, or null — the undo seam (mirrors getTrackKeyframes). */
  getDataTrack(nodeId: string, prop: PropPath): DataTrack | null {
    const track = this.dataTracksMap.get(nodeId)?.get(prop);
    if (!track) return null;
    return {
      ...track,
      keyframes: track.keyframes.map((k) => ({ ...k, value: cloneDataValue(k.value) })),
    };
  }

  /** Replace a data track wholesale (null/empty removes). Mirrors setTrackKeyframes. */
  setDataTrack(nodeId: string, prop: PropPath, track: DataTrack | null): void {
    if (!track || track.keyframes.length === 0) {
      const byProp = this.dataTracksMap.get(nodeId);
      if (byProp?.delete(prop) && byProp.size === 0) this.dataTracksMap.delete(nodeId);
      this.notifyChange(nodeId);
      return;
    }
    let byProp = this.dataTracksMap.get(nodeId);
    if (!byProp) {
      byProp = new Map();
      this.dataTracksMap.set(nodeId, byProp);
    }
    byProp.set(prop, {
      nodeId,
      prop,
      kind: track.kind,
      keyframes: track.keyframes.map((k) => ({ ...k, value: cloneDataValue(k.value) })),
    });
    this.notifyChange(nodeId);
  }

  /** All data-animated prop paths for a node. */
  getDataAnimatedPropPaths(nodeId: string): PropPath[] {
    const byProp = this.dataTracksMap.get(nodeId);
    if (!byProp) return [];
    return [...byProp.entries()]
      .filter(([, track]) => track.keyframes.length > 0)
      .map(([prop]) => prop);
  }

  // ── Expressions ─────────────────────────────────────────────────
  /**
   * Attach/replace an expression on a property (compiles immediately).
   *
   * PRESERVES the enabled bit when one is already attached. Editing the text of
   * a disabled expression must not silently re-enable it — the user turned it
   * off, and a keystroke is not a request to turn it back on. A newly attached
   * expression is enabled, which is the only sensible default for something the
   * user just typed.
   */
  setExpression(nodeId: string, prop: PropPath, src: string, authoredBy?: string): void {
    if (src.trim() === '') { this.removeExpression(nodeId, prop); return; }
    let byProp = this.expressions.get(nodeId);
    if (!byProp) { byProp = new Map(); this.expressions.set(nodeId, byProp); }
    const enabled = byProp.get(prop)?.enabled ?? true;
    // Authorship is REPLACED, not inherited. Editing a plugin-written
    // expression by hand makes it yours — carrying the old plugin id forward
    // would mislabel the user's own work, and a bulk "revert what this plugin
    // wrote" would then silently discard it.
    byProp.set(prop, {
      compiled: compileExpression(src),
      enabled,
      ...(authoredBy ? { authoredBy } : {}),
    });
    this.notifyChange(nodeId);
  }

  /**
   * Every (node, prop) carrying an expression a given plugin wrote.
   *
   * The read that makes provenance worth storing: it backs an origin label, a
   * "this project contains expressions from a plugin you do not have" notice,
   * and a bulk revert.
   */
  expressionsAuthoredBy(pluginId: string): Array<{ nodeId: string; prop: PropPath }> {
    const out: Array<{ nodeId: string; prop: PropPath }> = [];
    for (const [nodeId, byProp] of this.expressions) {
      for (const [prop, entry] of byProp) {
        if (entry.authoredBy === pluginId) out.push({ nodeId, prop });
      }
    }
    return out;
  }

  /**
   * Every expression in the document, with its source and its provenance.
   *
   * `expressionsAuthoredBy` answers "which are this plugin's". This answers
   * "which exist at all", which is what any operation over expression TEXT
   * needs — repairing cross-layer references after a rename, most of all.
   * Filtering to one author cannot serve that: the references at risk are
   * overwhelmingly the ones a person typed.
   *
   * A read, and a copy. Handing out the live `ExpressionEntry` would expose the
   * compiled form, and a caller that mutated it would corrupt evaluation with
   * no path back to who did it.
   */
  allExpressions(): Array<{ nodeId: string; prop: PropPath; src: string; authoredBy?: string }> {
    const out: Array<{ nodeId: string; prop: PropPath; src: string; authoredBy?: string }> = [];
    for (const [nodeId, byProp] of this.expressions) {
      for (const [prop, entry] of byProp) {
        out.push({
          nodeId,
          prop,
          src: entry.compiled.src,
          ...(entry.authoredBy ? { authoredBy: entry.authoredBy } : {}),
        });
      }
    }
    return out;
  }

  removeExpression(nodeId: string, prop: PropPath): void {
    const byProp = this.expressions.get(nodeId);
    if (!byProp?.delete(prop)) return;
    if (byProp.size === 0) this.expressions.delete(nodeId);
    this.notifyChange(nodeId);
  }

  /**
   * Turn an attached expression on or off WITHOUT discarding its source.
   *
   * A disabled expression is not evaluated: the property falls back to its
   * keyframes, and to its static value when it has none. No-op when the
   * property has no expression — there is nothing to enable, and creating an
   * empty one here would put an expression-shaped hole in the snapshot.
   */
  setExpressionEnabled(nodeId: string, prop: PropPath, enabled: boolean): void {
    const entry = this.expressions.get(nodeId)?.get(prop);
    if (!entry || entry.enabled === enabled) return;
    entry.enabled = enabled;
    this.notifyChange(nodeId);
  }

  getExpressionSrc(nodeId: string, prop: PropPath): string | undefined {
    return this.expressions.get(nodeId)?.get(prop)?.compiled.src;
  }

  /** Compile error for the property's expression (null if valid or none). */
  getExpressionError(nodeId: string, prop: PropPath): string | null {
    return this.expressions.get(nodeId)?.get(prop)?.compiled.compileError ?? null;
  }

  /**
   * Is there an expression attached at all — enabled or not?
   *
   * This is the question the EDITOR asks (show the source, offer the toggle).
   * It is NOT the question the sampler asks; see `isExpressionEnabled`.
   */
  hasExpression(nodeId: string, prop: PropPath): boolean {
    return this.expressions.get(nodeId)?.has(prop) ?? false;
  }

  /**
   * Does an expression currently DRIVE this property?
   *
   * False both when none is attached and when one is attached but disabled —
   * the two cases a caller asking "will the keyframes win?" wants merged, and
   * exactly the two `hasExpression` must keep apart.
   */
  isExpressionEnabled(nodeId: string, prop: PropPath): boolean {
    return this.expressions.get(nodeId)?.get(prop)?.enabled ?? false;
  }

  /**
   * Replace a property's expression wholesale (null removes).
   *
   * This is what undo/redo applies: one call restores source and enablement
   * together, so no ordering of two setters can leave a half-restored state.
   *
   * There is deliberately NO matching `getExpressionState`. One was written, to
   * mirror `getDataTrack`, and breaking it failed exactly one test — its own —
   * which is what a unit no production path touches looks like. The reader on
   * the undo path is `snapshot()`, which `diffTracks` already consumes; a second
   * accessor beside it would be dead API carrying a false claim about where the
   * before/after states come from. `getExpressionSrc` + `isExpressionEnabled`
   * answer the two questions callers actually ask.
   */
  setExpressionState(nodeId: string, prop: PropPath, state: ExpressionState | null): void {
    if (!state || state.src.trim() === '') { this.removeExpression(nodeId, prop); return; }
    let byProp = this.expressions.get(nodeId);
    if (!byProp) { byProp = new Map(); this.expressions.set(nodeId, byProp); }
    byProp.set(prop, {
      compiled: compileExpression(state.src),
      enabled: state.enabled,
      ...(state.authoredBy ? { authoredBy: state.authoredBy } : {}),
    });
    this.notifyChange(nodeId);
  }

  /** All props on a node that are keyframed and/or expressed. */
  animatedProps(nodeId: string): PropPath[] {
    return [
      ...new Set<PropPath>([
        ...(this.tracks.get(nodeId)?.keys() ?? []),
        ...(this.expressions.get(nodeId)?.keys() ?? []),
      ]),
    ];
  }

  /** Drop all animation for a node (e.g. on delete). */
  clearNode(nodeId: string): void {
    this.tracks.delete(nodeId);
    this.expressions.delete(nodeId);
    this.dataTracksMap.delete(nodeId);
  }

  clear(): void {
    this.tracks.clear();
    this.expressions.clear();
    this.dataTracksMap.clear();
  }

  /** Deep-clone tracks + expressions into a serializable snapshot (History). */
  snapshot(): AnimSnapshot {
    const tracks: AnimSnapshot['tracks'] = {};
    for (const [nodeId, byProp] of this.tracks) {
      const props: Record<string, PropertyTrack> = {};
      for (const [prop, track] of byProp) {
        props[prop] = { nodeId, prop, keyframes: track.keyframes.map((k) => ({ ...k })) };
      }
      tracks[nodeId] = props;
    }
    const expressions: AnimSnapshot['expressions'] = {};
    for (const [nodeId, byProp] of this.expressions) {
      const props: Record<string, ExpressionState> = {};
      for (const [prop, entry] of byProp) {
        props[prop] = {
          src: entry.compiled.src,
          enabled: entry.enabled,
          // Carried into the snapshot, which IS the saved document. A field
          // that lived only in memory would answer 'who wrote this' for the
          // session that wrote it and for nobody who opens the file later —
          // which is the only audience that needs the answer.
          ...(entry.authoredBy ? { authoredBy: entry.authoredBy } : {}),
        };
      }
      expressions[nodeId] = props;
    }
    const data: NonNullable<AnimSnapshot['data']> = {};
    let hasData = false;
    for (const [nodeId, byProp] of this.dataTracksMap) {
      const props: Record<string, DataTrack> = {};
      for (const [prop, track] of byProp) {
        props[prop] = {
          nodeId,
          prop,
          kind: track.kind,
          keyframes: track.keyframes.map((k) => ({ ...k, value: cloneDataValue(k.value) })),
        };
        hasData = true;
      }
      data[nodeId] = props;
    }
    // Optional field: pre-data snapshots restore unchanged.
    return hasData ? { tracks, expressions, data } : { tracks, expressions };
  }

  /** Replace all tracks + expressions from a snapshot (History jump). */
  restore(data: AnimSnapshot): void {
    this.tracks.clear();
    this.expressions.clear();
    this.dataTracksMap.clear();
    if (data.data) {
      for (const nodeId of Object.keys(data.data)) {
        const props = data.data[nodeId];
        if (!props) continue;
        const byProp = new Map<PropPath, DataTrack>();
        for (const prop of Object.keys(props)) {
          const track = props[prop];
          if (track && track.keyframes.length > 0) {
            byProp.set(prop, {
              nodeId,
              prop,
              kind: track.kind,
              keyframes: track.keyframes.map((k) => ({ ...k, value: cloneDataValue(k.value) })),
            });
          }
        }
        if (byProp.size) this.dataTracksMap.set(nodeId, byProp);
      }
    }
    for (const nodeId of Object.keys(data.tracks)) {
      const byProp = new Map<PropPath, PropertyTrack>();
      const props = data.tracks[nodeId];
      if (!props) continue;
      for (const prop of Object.keys(props)) {
        const track = props[prop];
        if (track) byProp.set(prop, { nodeId, prop, keyframes: track.keyframes.map((k) => ({ ...k })) });
      }
      this.tracks.set(nodeId, byProp);
    }
    // `?? {}` because a snapshot predating the expression feature has no
    // `expressions` key at all — an ABSENT optional field, not a second shape.
    // This path now carries pre-1.1 recovery snapshots, which is where such a
    // blob actually turns up, and `Object.keys(undefined)` threw.
    for (const nodeId of Object.keys(data.expressions ?? {})) {
      const props = data.expressions[nodeId];
      if (!props) continue;
      const byProp = new Map<PropPath, ExpressionEntry>();
      for (const prop of Object.keys(props)) {
        // ONE SHAPE ONLY. The pre-1.6.0 form was a bare `src` string; it is
        // upgraded by the document migration, never here. A reader that quietly
        // accepted both would let documents stay un-migrated indefinitely and
        // the two shapes drift — same precedent as fx.repeater in 1.5.0.
        const state = props[prop];
        if (state?.src) {
          byProp.set(prop, {
            compiled: compileExpression(state.src),
            enabled: state.enabled !== false,
            ...(state.authoredBy ? { authoredBy: state.authoredBy } : {}),
          });
        }
      }
      if (byProp.size) this.expressions.set(nodeId, byProp);
    }
    this.notifyChange('*');
  }
}

/** Serializable animation state: keyframe tracks + expression states +
 *  (optionally) non-scalar data tracks. `data` is absent on old documents.
 *
 *  `expressions` values were a bare source STRING before document 1.6.0 and are
 *  `{ src, enabled }` from 1.6.0 on. The upgrade lives in
 *  `migrations/v1_5_0_to_v1_6_0.ts`; nothing here reads the old shape. */
export interface AnimSnapshot {
  tracks: Record<string, Record<string, PropertyTrack>>;
  expressions: Record<string, Record<string, ExpressionState>>;
  data?: Record<string, Record<string, DataTrack>>;
}

/** Process-wide default instance (mirrors defaultSceneGraph). */
export const defaultAnimation = new AnimationEngine();

export default defaultAnimation;
