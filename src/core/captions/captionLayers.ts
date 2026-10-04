/* eslint-disable no-restricted-syntax -- F11: every `.props` write in this
 * file is on a node literal from `makeNode` that has not been added to the
 * graph yet, which is the case the rule's own message calls legitimate. The
 * node is handed to `addChild` immediately afterwards, and there is no
 * `getNode()` read-then-mutate anywhere in this file — the one shape the rule
 * exists to catch. `readCaptionCues` only reads. */
/**
 * Cues ↔ layers — the scene-touching half of captions.
 *
 * A caption is an ordinary text layer whose clip bar is its cue window. That is
 * the whole design, and it is deliberate: captions built from a bespoke layer
 * kind would need their own renderer, their own inspector, their own export
 * path and their own reason not to support text animators. As plain text
 * layers they get all of it for free — per-glyph animators, styles, 3D, the
 * graph editor — and the user can hand-fix a caption the way they fix anything
 * else, by dragging its bar and typing in it.
 *
 * What makes them findable again is one marked prop, `__caption`, on the Text
 * component. Same `__` convention as `__templateFields` and `__kind`: it
 * travels with the scene, and the generic inspector hides it. That is what lets
 * "export the captions" mean something after the user has moved, restyled and
 * re-timed them.
 *
 * ── Timing ─────────────────────────────────────────────────────────────
 * The clip bar IS the cue, so re-timing a caption is dragging a bar and
 * exporting picks the change up. Nothing stores the original cue times, on
 * purpose: two sources of truth for "when does this caption show" is how an
 * export ends up disagreeing with the picture.
 */

import { makeNode } from '@core/scene/layerBuilders';
import type { Command } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import {  wrapCaption, type Cue } from './captionFormat';

/** Marks a text layer as a caption. Hidden from the inspector by convention. */
export const CAPTION_PROP = '__caption';

/**
 * How captions look and sit when they are created.
 *
 * Sizes are FRACTIONS of the composition, not pixels: the same style has to
 * produce readable captions on a 1080×1920 vertical cut and a 3840×2160
 * master, and a fixed 48px is wrong on both.
 */
export interface CaptionStyle {
  /** Cap height as a fraction of comp height. 0.05 ≈ broadcast subtitle size. */
  fontSizeRatio: number;
  fontWeight: number;
  fill: string;
  /** Distance from the bottom edge, as a fraction of comp height. */
  bottomMarginRatio: number;
  /** Characters per line before wrapping. Broadcast practice is ~42. */
  maxCharsPerLine: number;
  maxLines: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSizeRatio: 0.05,
  fontWeight: 700,
  fill: '#ffffff',
  // A tenth of the frame keeps captions clear of a 16:9 letterbox and of the
  // UI chrome every social platform draws along the bottom edge.
  bottomMarginRatio: 0.1,
  maxCharsPerLine: 42,
  maxLines: 2,
};

/** True for a node this module created (or the user marked) as a caption. */
export function isCaptionNode(node: SceneNode): boolean {
  return node.components.some((c) => (c.props as Record<string, unknown>)[CAPTION_PROP] === true);
}

/** Build one caption text node, styled and placed but not yet timed. */
export function makeCaptionNode(
  cue: Cue,
  style: CaptionStyle,
  comp: { width: number; height: number },
  index: number,
): SceneNode {
  const node = makeNode('text', `Caption ${index + 1}`);
  const fontSize = Math.max(8, Math.round(comp.height * style.fontSizeRatio));
  const text = wrapCaption(cue.text, style.maxCharsPerLine, style.maxLines);
  const lines = text.split('\n').length;

  const transform = node.components.find((c) => c.type === 'Transform');
  if (transform) {
    transform.props.x = Math.round(comp.width / 2);
    // Anchored off the BOTTOM, and lifted by the number of lines it has: a
    // two-line caption positioned like a one-line one either runs off the
    // frame or floats, depending on which end the renderer grows from.
    transform.props.y = Math.round(
      comp.height - comp.height * style.bottomMarginRatio - fontSize * (lines - 1),
    );
    transform.props.width = Math.round(comp.width * 0.8);
  }

  const textComponent = node.components.find((c) => c.type === 'Text');
  if (textComponent) {
    textComponent.props.content = text;
    textComponent.props.fontSize = fontSize;
    textComponent.props.fontWeight = style.fontWeight;
    textComponent.props.fill = style.fill;
    textComponent.props.align = 'center';
    textComponent.props[CAPTION_PROP] = true;
  }

  node.name = text.split('\n')[0]?.slice(0, 40) || `Caption ${index + 1}`;
  return node;
}

/**
 * Which composition captions go into, and how big it is.
 *
 * Explicit rather than derived, because "the active composition" is a UI fact
 * and captions are not only inserted from the UI. The headless CLI opens a
 * project and renders a composition it names — there may be no matching tab at
 * all — and `useCompositionStore` answers for the ACTIVE tab, falling back to a
 * 1920×1080 default when there is none. That default is what put burned-in
 * captions at y=1728 of a 360-pixel-tall frame: off screen, no error, and a
 * rendered file that simply had no subtitles in it.
 */
export interface CaptionTarget {
  rootId: string;
  width: number;
  height: number;
}

export interface InsertCaptionsResult {
  nodeIds: string[];
  /** Cues dropped because they overlapped into nothing. */
  skipped: number;
}

export interface CaptionEdit {
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
