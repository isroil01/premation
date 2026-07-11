/**
 * AnimationEngine — the value authority.
 *
 * Holds property tracks keyed by (nodeId, prop). Given a time it samples every
 * track and returns a SceneValueSnapshot the renderer merges over the scene's
 * base values. It never mutates the scene graph during playback (TAD §8.2):
 * authoring keyframes are the truth; sampled values are derived and disposable.
 */

import type { PropPath, PropertyTrack, SceneValueSnapshot, EasingKind, BezierHandles, Keyframe } from './types';
import { sampleTrack, upsertKeyframe } from './interpolate';
import { compileExpression, type CompiledExpression } from './expressions';
import { getEventBus } from '@core/events/EventBus';

export class AnimationEngine {
  private tracks = new Map<string, Map<PropPath, PropertyTrack>>();
  /** Per-property expressions that override the sampled value each frame. */
  private expressions = new Map<string, Map<PropPath, CompiledExpression>>();

  /** All property tracks for a node. */
  tracksFor(nodeId: string): PropertyTrack[] {
    const byProp = this.tracks.get(nodeId);
    return byProp ? Array.from(byProp.values()) : [];
  }

  hasAnimation(nodeId: string): boolean {
    return (this.tracks.get(nodeId)?.size ?? 0) > 0;
  }

  /** Add/replace a keyframe on (nodeId, prop). */
  setKeyframe(nodeId: string, prop: PropPath, t: number, value: number, easing?: EasingKind): void {
    let byProp = this.tracks.get(nodeId);
    if (!byProp) {
      byProp = new Map();
      this.tracks.set(nodeId, byProp);
    }
    const track = byProp.get(prop) ?? { nodeId, prop, keyframes: [] };
    track.keyframes = upsertKeyframe(track.keyframes, { t, value, easing });
    byProp.set(prop, track);
    getEventBus().emit('AnimationChanged', { nodeId });
  }

  removeKeyframe(nodeId: string, prop: PropPath, t: number): void {
    const track = this.tracks.get(nodeId)?.get(prop);
    if (!track) return;
    track.keyframes = track.keyframes.filter((k) => k.t !== t);
    if (track.keyframes.length === 0) this.tracks.get(nodeId)?.delete(prop);
    getEventBus().emit('AnimationChanged', { nodeId });
  }

  /** Move a keyframe from `fromT` to `toT` (preserving its value/easing). */
  moveKeyframe(nodeId: string, prop: PropPath, fromT: number, toT: number): void {
    if (fromT === toT) return;
    const track = this.tracks.get(nodeId)?.get(prop);
    const kf = track?.keyframes.find((k) => k.t === fromT);
    if (!track || !kf) return;
    const without = track.keyframes.filter((k) => k.t !== fromT);
    track.keyframes = upsertKeyframe(without, { ...kf, t: toT });
    getEventBus().emit('AnimationChanged', { nodeId });
  }

  /** Set the easing on the segment that starts at keyframe `t`. */
  setEasing(nodeId: string, prop: PropPath, t: number, easing: EasingKind): void {
    const kf = this.tracks.get(nodeId)?.get(prop)?.keyframes.find((k) => k.t === t);
    if (!kf) return;
    kf.easing = easing;
    // Seed default handles when switching to a custom bezier curve.
    if (easing === 'bezier' && !kf.bezier) kf.bezier = [0.25, 0.1, 0.25, 1];
    getEventBus().emit('AnimationChanged', { nodeId });
  }

  /** Replace the keyframe at `oldT` with new time/value/easing/bezier. */
  updateKeyframe(
    nodeId: string,
    prop: PropPath,
    oldT: number,
    patch: { t?: number; value?: number; easing?: EasingKind; bezier?: BezierHandles },
  ): void {
    const track = this.tracks.get(nodeId)?.get(prop);
    const kf = track?.keyframes.find((k) => k.t === oldT);
    if (!track || !kf) return;
    const next: Keyframe = {
      t: patch.t ?? kf.t,
      value: patch.value ?? kf.value,
      easing: patch.easing ?? kf.easing,
      bezier: patch.bezier ?? kf.bezier,
    };
    track.keyframes = upsertKeyframe(track.keyframes.filter((k) => k.t !== oldT), next);
    getEventBus().emit('AnimationChanged', { nodeId });
  }

  /** Remove all keyframes for a property (turn animation off). */
  removeTrack(nodeId: string, prop: PropPath): void {
    const byProp = this.tracks.get(nodeId);
    if (!byProp?.delete(prop)) return;
    if (byProp.size === 0) this.tracks.delete(nodeId);
    getEventBus().emit('AnimationChanged', { nodeId });
  }

  isAnimated(nodeId: string, prop: PropPath): boolean {
    return (this.tracks.get(nodeId)?.get(prop)?.keyframes.length ?? 0) > 0;
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
      getEventBus().emit('AnimationChanged', { nodeId });
      return;
    }
    let byProp = this.tracks.get(nodeId);
    if (!byProp) {
      byProp = new Map();
      this.tracks.set(nodeId, byProp);
    }
    byProp.set(prop, { nodeId, prop, keyframes: keyframes.map((k) => ({ ...k })) });
    getEventBus().emit('AnimationChanged', { nodeId });
  }

  /**
   * Sample one property at time `t`. If the property has a valid expression it
   * overrides the keyframed value (the keyframed value is passed in as `value`).
   * Returns `undefined` when neither keyframes nor an expression apply.
   */
  sample(nodeId: string, prop: PropPath, t: number): number | undefined {
    const track = this.tracks.get(nodeId)?.get(prop);
    const base = track ? sampleTrack(track, t) : undefined;
    const expr = this.expressions.get(nodeId)?.get(prop);
    if (expr) {
      const r = expr.run({ time: t, value: base ?? 0 });
      if (r.value !== null) return r.value;
    }
    return base;
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

  // ── Expressions ─────────────────────────────────────────────────
  /** Attach/replace an expression on a property (compiles immediately). */
  setExpression(nodeId: string, prop: PropPath, src: string): void {
    if (src.trim() === '') { this.removeExpression(nodeId, prop); return; }
    let byProp = this.expressions.get(nodeId);
    if (!byProp) { byProp = new Map(); this.expressions.set(nodeId, byProp); }
    byProp.set(prop, compileExpression(src));
    getEventBus().emit('AnimationChanged', { nodeId });
  }

  removeExpression(nodeId: string, prop: PropPath): void {
    const byProp = this.expressions.get(nodeId);
    if (!byProp?.delete(prop)) return;
    if (byProp.size === 0) this.expressions.delete(nodeId);
    getEventBus().emit('AnimationChanged', { nodeId });
  }

  getExpressionSrc(nodeId: string, prop: PropPath): string | undefined {
    return this.expressions.get(nodeId)?.get(prop)?.src;
  }

  /** Compile error for the property's expression (null if valid or none). */
  getExpressionError(nodeId: string, prop: PropPath): string | null {
    return this.expressions.get(nodeId)?.get(prop)?.compileError ?? null;
  }

  hasExpression(nodeId: string, prop: PropPath): boolean {
    return this.expressions.get(nodeId)?.has(prop) ?? false;
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
  }

  clear(): void {
    this.tracks.clear();
    this.expressions.clear();
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
      const props: Record<string, string> = {};
      for (const [prop, expr] of byProp) props[prop] = expr.src;
      expressions[nodeId] = props;
    }
    return { tracks, expressions };
  }

  /** Replace all tracks + expressions from a snapshot (History jump). */
  restore(data: AnimSnapshot): void {
    this.tracks.clear();
    this.expressions.clear();
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
    for (const nodeId of Object.keys(data.expressions)) {
      const props = data.expressions[nodeId];
      if (!props) continue;
      const byProp = new Map<PropPath, CompiledExpression>();
      for (const prop of Object.keys(props)) {
        const src = props[prop];
        if (src) byProp.set(prop, compileExpression(src));
      }
      if (byProp.size) this.expressions.set(nodeId, byProp);
    }
    getEventBus().emit('AnimationChanged', { nodeId: '*' });
  }
}

/** Serializable animation state: keyframe tracks + expression sources. */
export interface AnimSnapshot {
  tracks: Record<string, Record<string, PropertyTrack>>;
  expressions: Record<string, Record<string, string>>;
}

/** Process-wide default instance (mirrors defaultSceneGraph). */
export const defaultAnimation = new AnimationEngine();

export default defaultAnimation;
