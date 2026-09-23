/**
 * Keyframe id → where the key lives. Rebuilt lazily after any change (one pass
 * over the animation engine + each layer's mask-shape keys), so resolving an id
 * never depends on the key's time (ENGINE_API.md §3.3).
 *
 * Keys written before the API existed may have no id yet; they are addressed
 * by the positional fallback (`@layer|track|t`, props.ts) until a command
 * touches them, at which point they are stamped with a real id.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeMaskAnim } from '@core/effects/mask';
import { getTimelineController } from '@core/timeline/TimelineController';
import { parseFallbackKeyId } from './props';

export interface KeyLoc {
  layer: string;
  /** Scalar track, data track, or `mask:<maskId>`. */
  member: string;
  /** Stored (keyframe-axis) seconds. */
  t: number;
  kind: 'scalar' | 'data' | 'mask';
  maskId?: string;
}

export class KeyIndex {
  private map: Map<string, KeyLoc> | null = null;
  private markers: Set<string> | null = null;

  invalidate(): void {
    this.map = null;
    this.markers = null;
  }

  private build(): Map<string, KeyLoc> {
    const map = new Map<string, KeyLoc>();
    const snap = defaultAnimation.snapshot();
    for (const [layer, byProp] of Object.entries(snap.tracks)) {
      for (const [member, track] of Object.entries(byProp)) {
        for (const k of track.keyframes) if (k.id && !map.has(k.id)) map.set(k.id, { layer, member, t: k.t, kind: 'scalar' });
      }
    }
    for (const [layer, byProp] of Object.entries(snap.data ?? {})) {
      for (const [member, track] of Object.entries(byProp)) {
        for (const k of track.keyframes) if (k.id && !map.has(k.id)) map.set(k.id, { layer, member, t: k.t, kind: 'data' });
      }
    }
    defaultSceneGraph.traverse((n) => {
      const anim = readNodeMaskAnim(n);
      for (const k of anim) {
        const id = (k as { id?: string }).id;
        if (!id) continue;
        for (const p of k.mask.paths) {
          map.set(`${id}@${p.id}`, { layer: n.id, member: `mask:${p.id}`, t: k.t, kind: 'mask', maskId: p.id });
        }
        if (!map.has(id)) map.set(id, { layer: n.id, member: 'mask:', t: k.t, kind: 'mask' });
      }
    });
    return map;
  }

  has(id: string): boolean {
    this.map ??= this.build();
    return this.map.has(id);
  }

  resolve(id: string): KeyLoc | null {
    this.map ??= this.build();
    const hit = this.map.get(id);
    if (hit) return hit;
    const fb = parseFallbackKeyId(id);
    if (!fb) return null;
    if (fb.member.startsWith('mask:')) {
      const maskId = fb.member.slice(5);
      const node = defaultSceneGraph.getNode(fb.layer);
      if (!node || !readNodeMaskAnim(node).some((k) => k.t === fb.t)) return null;
      return { layer: fb.layer, member: fb.member, t: fb.t, kind: 'mask', maskId };
    }
    if (defaultAnimation.getTrackKeyframes(fb.layer, fb.member)?.some((k) => k.t === fb.t)) {
      return { layer: fb.layer, member: fb.member, t: fb.t, kind: 'scalar' };
    }
    if (defaultAnimation.getDataTrack(fb.layer, fb.member)?.keyframes.some((k) => k.t === fb.t)) {
      return { layer: fb.layer, member: fb.member, t: fb.t, kind: 'data' };
    }
    return null;
  }

  /** Every keyframe id in use (for minting). */
  ids(): IterableIterator<string> {
    this.map ??= this.build();
    return this.map.keys();
  }

  markerTaken(id: string): boolean {
    if (!this.markers) {
      const set = new Set<string>();
      const c = getTimelineController();
      for (const comp of c.registeredCompIds()) {
        const reg = c.peekTimeline(comp);
        if (!reg) continue;
        for (const m of reg.timeline.markers.list()) set.add(m.id);
        for (const l of reg.timeline.getTrack(reg.trackId)?.layers ?? []) for (const m of l.markers.list()) set.add(m.id);
      }
      this.markers = set;
    }
    if (this.markers.has(id)) return true;
    this.markers.add(id);
    return false;
  }
}
