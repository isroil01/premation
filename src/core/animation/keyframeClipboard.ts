/**
 * keyframeClipboard — in-memory copy/paste for keyframes (AE-style).
 *
 * Copy: captures value + temporal easing + spatial tangents (`si`/`so`) +
 *       continuous / roving flags so motion-path shape survives Ctrl+C/V.
 * Paste: re-applies them to any selected layer at the playhead, offsetting
 *        times so the earliest copied keyframe lands at the playhead.
 *        Works across layers — paste applies to each currently-selected node.
 *
 * Clipboard is module-level (survives re-renders, resets on page unload).
 * All mutations are wrapped in runAnimEdit so they are fully undoable.
 */

import type { EasingKind, BezierHandles, SpatialInterp } from '@motion/animation';
import { defaultAnimation, expandKeyframeProp, sampleTrack } from '@motion/animation';
import { selectionStoredRefs } from '@core/mirror/keySelection';
import { documentMirror } from '@stores/documentMirror';
import { propRefForTrack } from '@core/engine/propRefs';
import { readStaticPropertyValue } from '@core/inspector/propertyValue';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';

export interface ClipboardEntry {
  nodeId: string;
  prop: string;
  t: number;
  value: number;
  easing?: EasingKind;
  bezier?: BezierHandles;
  /** Spatial in/out tangents (value-space offsets) — motion-path shape. */
  si?: number;
  so?: number;
  /** AE spatial interpolation mode of the motion-path vertex. */
  spatialInterp?: SpatialInterp;
  continuous?: boolean;
  roving?: boolean;
}

let _clipboard: ClipboardEntry[] = [];

/** True when the clipboard holds at least one keyframe. */
export function hasClipboard(): boolean {
  return _clipboard.length > 0;
}

/** What Ctrl+C captured (read-only) — the engine-API paste builds its commands from it. */
export function clipboardEntries(): readonly ClipboardEntry[] {
  return _clipboard;
}

/** Test helper — wipe the module clipboard between cases. */
export function clearClipboard(): void {
  _clipboard = [];
}

/**
 * Copy the selected keyframes (keyframe SELECTION ids — engine key ids, see
 * core/mirror/keySelection.ts) into the clipboard. Each id is decoded by the
 * selection adapter into the stored positions of the tracks the diamond stands
 * for, which is what this clipboard reads.
 */
export function copyKeyframes(ids: ReadonlySet<string>): void {
  copyKeyframeRefs(selectionStoredRefs(documentMirror(), ids));
}

/**
 * Copy the key of `prop` at STORED time `t` (the layer's keyframe axis) — the
 * inspector row menu's Copy Keyframe, which holds a property and the playhead
 * rather than a timeline selection. A clipboard read, not a document write.
 */
export function copyKeyframeAt(nodeId: string, prop: string, t: number): void {
  copyKeyframeRefs([{ nodeId, prop, t }]);
}

/**
 * Copy keys by STORED position (`nodeId`, track, stored `t`) — what a keyframe
 * selection decodes to (`selectionStoredRefs`).
 */
export function copyKeyframeRefs(refs: ReadonlyArray<{ nodeId: string; prop: string; t: number }>): void {
  const entries: ClipboardEntry[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    // A selected "Position" row stands for the underlying x/y/z tracks; a
    // member row (Scale X, a colour channel) for its whole property — AE has
    // ONE key per time for every dimension (ENGINE_API.md §3.3), so Copy takes
    // them all. A member with no key there (a legacy document) is copied at
    // its value, with the keyed member's easing.
    const tracks = expandKeyframeProp(ref.prop).flatMap((p) => {
      const members = propRefForTrack(ref.nodeId, p)?.members ?? [];
      return members.length > 1 ? members : [p];
    });
    const { nodeId, t } = ref;
    const at = (prop: string) => defaultAnimation.getTrackKeyframes(nodeId, prop)?.find((k) => Math.abs(k.t - t) < 1e-6);
    const lead = tracks.map(at).find((k) => k !== undefined);
    if (!lead) continue;
    for (const prop of tracks) {
      if (seen.has(`${nodeId}|${prop}|${lead.t}`)) continue;
      seen.add(`${nodeId}|${prop}|${lead.t}`);
      const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
      const kf = at(prop) ?? {
        ...lead,
        value: kfs && kfs.length > 0 ? sampleTrack({ nodeId, prop, keyframes: kfs }, lead.t) ?? 0 : readStaticPropertyValue(nodeId, prop) ?? 0,
        si: undefined,
        so: undefined,
      };
      entries.push({
        nodeId,
        prop,
        t: kf.t,
        value: kf.value,
        easing: kf.easing,
        bezier: kf.bezier ? [...kf.bezier] as BezierHandles : undefined,
        si: kf.si,
        so: kf.so,
        spatialInterp: kf.spatialInterp,
        continuous: kf.continuous,
        roving: kf.roving,
      });
    }
  }
  if (entries.length > 0) _clipboard = entries;
}

/**
 * Paste clipboard keyframes onto each target node at `atCompTime`.
 * The earliest clipboard keyframe is offset to land at `atCompTime`.
 */
export function pasteKeyframes(targetNodeIds: readonly string[], atCompTime: number): void {
  if (_clipboard.length === 0 || targetNodeIds.length === 0) return;
  const minT = Math.min(..._clipboard.map((e) => e.t));

  runAnimEdit('Paste keyframes', () => {
    for (const nodeId of targetNodeIds) {
      // The earliest clipboard keyframe lands at the TARGET's canonical time
      // for the playhead; the rest keep their stored spacing. The old code
      // added a comp-time offset to stored keyframe times — two different
      // axes, which scattered pastes on any moved/trimmed clip.
      const base = compToKeyframeTime(nodeId, atCompTime);
      for (const entry of _clipboard) {
        const layerT = base + (entry.t - minT);
        defaultAnimation.setKeyframe(nodeId, entry.prop, layerT, entry.value, entry.easing);
        if (entry.bezier) defaultAnimation.setBezier(nodeId, entry.prop, layerT, entry.bezier);
        if (entry.si !== undefined || entry.so !== undefined) {
          defaultAnimation.setSpatialTangent(nodeId, entry.prop, layerT, {
            si: entry.si,
            so: entry.so,
          });
        }
        if (entry.spatialInterp !== undefined) {
          defaultAnimation.setSpatialInterp(nodeId, entry.prop, layerT, entry.spatialInterp);
        }
        if (entry.continuous !== undefined || entry.roving !== undefined) {
          defaultAnimation.updateKeyframe(nodeId, entry.prop, layerT, {
            continuous: entry.continuous,
            roving: entry.roving,
          });
        }
      }
    }
  });
}
