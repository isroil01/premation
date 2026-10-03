/**
 * Captions as an ENGINE CLIENT fragment: one styled text layer per cue
 * (captionLayers.ts `makeCaptionNode`'s layer), each with the bar its cue
 * times — `[start, end)` in frames of the target composition, the source
 * mapping the identity (`sourceIn` = `start`, what the legacy trims left) —
 * laid into a {@link FragmentBuilder}. The caller pastes it as ONE
 * `pasteLayers` (core/engine/captionEdit.ts). No page replica; pinned against
 * the off-document `buildCaptionLayers` by engine-client/captionFragment.test.ts.
 */

import { FragmentBuilder, type BuiltFragment } from '@/engine-client/fragmentBuilder';
import { DEFAULT_CAPTION_STYLE, makeCaptionNode, type CaptionStyle, type CaptionTarget } from './captionLayers';
import { deoverlap, type Cue } from './captionFormat';

export interface CaptionFragment {
  built: BuiltFragment | null;
  /** Cues dropped because they overlapped into nothing. */
  skipped: number;
}

/** A cue's bar (frames at `fps`): end before start, as the legacy trims ran; never shorter than a frame. */
function cueBar(cue: Cue, fps: number): { start: number; duration: number; sourceIn: number; sourceDuration: null } {
  const start = Math.max(0, Math.round(cue.start * fps));
  const end = Math.max(start + 1, Math.round(cue.end * fps));
  return { start, duration: end - start, sourceIn: start, sourceDuration: null };
}

/** The caption layers for `cues` in `target` (at `fps`), front-most = the last cue. */
export function buildCaptionFragment(
  cues: readonly Cue[],
  target: CaptionTarget,
  fps: number,
  style: CaptionStyle = DEFAULT_CAPTION_STYLE,
): CaptionFragment {
  const usable = deoverlap(cues);
  if (usable.length === 0) return { built: null, skipped: cues.length };
  const b = new FragmentBuilder({ idPrefix: 'cap' });
  for (const [index, cue] of usable.entries()) {
    const node = makeCaptionNode(cue, style, target, index);
    b.addChild(target.rootId, node);
    b.setBars(node.id, [cueBar(cue, fps)]);
  }
  return { built: b.build(), skipped: cues.length - usable.length };
}
