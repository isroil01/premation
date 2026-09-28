/**
 * Captions as ONE engine edit, built engine-side (B4 round 5) — the commands
 * that REPLACE a composition's captions with `cues`: `deleteLayers` of the
 * caption layers the caller names (the UI reads them off the document mirror:
 * `LayerInfo.caption`), then ONE `pasteLayers` of the styled caption layers the
 * builder (captions/captionLayers.ts `buildCaptionLayers`) makes OFF-DOCUMENT
 * (offDocument.ts `buildLayerFragment`: a scratch tree, never the document).
 *
 * A query-shaped seam: plain data in (cues, style, the composition and its
 * size, the ids to replace), plain data out (the commands and their counts),
 * one call per edit. Nothing is sent here. In the engine process this is the
 * captions import's own command.
 */

import type { Command } from '@motion/engine-api';
import { buildCaptionLayers, DEFAULT_CAPTION_STYLE, type CaptionStyle, type CaptionTarget } from '@core/captions/captionLayers';
import type { Cue } from '@core/captions/captionFormat';
import { buildLayerFragment } from './offDocument';

export interface CaptionEditPlan {
  /** The commands of the edit (send them as ONE batch). */
  commands: Command[];
  /** Captions the edit adds / removes. */
  added: number;
  removed: number;
  /** Cues dropped because they overlapped into nothing. */
  skipped: number;
  /** Scratch ids of the added captions in paste order, to map the result through. */
  scratchIds: string[];
}

export function captionReplaceCommands(
  cues: readonly Cue[],
  target: CaptionTarget,
  replace: readonly string[],
  style: CaptionStyle = DEFAULT_CAPTION_STYLE,
): CaptionEditPlan {
  let skipped = 0;
  const built = buildLayerFragment(target.rootId, () => { skipped = buildCaptionLayers(cues, style, target).skipped; });
  const commands: Command[] = [];
  if (replace.length > 0) commands.push({ type: 'deleteLayers', layers: [...replace] } as Command);
  // The builder appends the captions at the FRONT of the comp (index 0), which
  // the deletion before the paste does not move.
  if (built) commands.push({ type: 'pasteLayers', comp: target.rootId, fragment: built.fragment, index: 0 } as Command);
  if (built === null && cues.length > 0) skipped = cues.length;
  return { commands, added: built?.scratchIds.length ?? 0, removed: replace.length, skipped, scratchIds: built?.scratchIds ?? [] };
}
