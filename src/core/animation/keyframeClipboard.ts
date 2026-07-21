/**
 * keyframeClipboard — in-memory copy/paste for keyframes (AE-style).
 *
 * Copy: captures (nodeId, prop, t, value, easing, bezier) tuples.
 * Paste: re-applies them to any selected layer at the playhead, offsetting
 *        times so the earliest copied keyframe lands at the playhead.
 *        Works across layers — paste applies to each currently-selected node.
 *
 * Clipboard is module-level (survives re-renders, resets on page unload).
 * All mutations are wrapped in runAnimEdit so they are fully undoable.
 */

import type { EasingKind, BezierHandles } from '@motion/animation';
import { defaultAnimation, parseKeyframeId, expandKeyframeProp } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime } from '@core/timeline/TimelineController';

export interface ClipboardEntry {
  nodeId: string;
  prop: string;
  t: number;
  value: number;
  easing?: EasingKind;
  bezier?: BezierHandles;
}

let _clipboard: ClipboardEntry[] = [];

/** True when the clipboard holds at least one keyframe. */
export function hasClipboard(): boolean {
  return _clipboard.length > 0;
}

/**
 * Copy the specified keyframe IDs into the clipboard.
 *
 * Ids are decoded with `parseKeyframeId` — the codec that made them. This once
 * hand-parsed `nodeId::prop@time`, a format that has never existed
 * (`makeKeyframeId` joins on `::`), so the `@` lookup failed on every id and
 * copy silently collected nothing.
 */
export function copyKeyframes(ids: ReadonlySet<string>): void {
  const entries: ClipboardEntry[] = [];
  for (const id of ids) {
    const ref = parseKeyframeId(id);
    if (!ref) continue;
    // A selected "Position" row stands for the underlying x/y/z tracks.
    for (const prop of expandKeyframeProp(ref.prop)) {
    const { nodeId, t } = ref;
    const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
    const kf = kfs?.find((k) => Math.abs(k.t - t) < 1e-6);
    if (!kf) continue;
    entries.push({
      nodeId,
      prop,
      t: kf.t,
      value: kf.value,
      easing: kf.easing,
      bezier: kf.bezier ? [...kf.bezier] as BezierHandles : undefined,
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
      }
    }
  });
}
