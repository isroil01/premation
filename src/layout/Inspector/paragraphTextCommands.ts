/**
 * Point ↔ Paragraph text, and the paragraph box's auto-size mode — registered
 * as first-class COMMANDS (same pattern as `textCommands.ts`).
 *
 * AE: Layer ▸ Convert to Paragraph Text / Convert to Point Text, also on the
 * right-click menu while editing text. Both conversions hold the text still
 * on screen:
 *   • point → paragraph: the box is the measured text bounds plus a little
 *     padding (so nothing re-wraps), fixed height, top aligned;
 *   • paragraph → point: every soft wrap becomes a hard return (AE inserts a
 *     return at each line end), the box is removed. A Fit Text to Box scale is
 *     baked into the font size, because point text has no box to fit.
 * Position is compensated through the layer's own rotation and scale for the
 * line block's move inside its (centre-origin) layer — see paragraphBox.ts.
 *
 * Menu rows wanted (orchestrator owns menuModel): Layer ▸ Text ▸
 * "Convert to Paragraph Text" (`text.convertToParagraphText`) and
 * "Convert to Point Text" (`text.convertToPointText`); the same two rows in
 * the viewport/timeline layer context menu for text layers.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { readTransformProp, writeTransformProps } from '@core/scene/transformWrite';
import {
  measureParagraphBox,
  measureTextSize,
  readMeasuredTextStyle,
  textStyleTransform,
  type MeasuredTextStyle,
} from '@core/text/measureText';
import { MIN_BOX_SIZE, TEXT_PAD_X, firstParagraphDirection, hasTextPath, readParagraphBox, type BoxAutoSize } from '@core/text/textExtras';
import { compensatePosition, lineBlockAnchorX, type Vec2 } from '@core/text/paragraphBox';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';

export const TEXT_CONVERT_TO_POINT_COMMAND = asCommandId('text.convertToPointText');
export const TEXT_CONVERT_TO_PARAGRAPH_COMMAND = asCommandId('text.convertToParagraphText');

/** Padding added around the measured text when it becomes a box, px. */
export const CONVERT_BOX_PADDING = 4;

function textComponent(node: SceneNode | null | undefined): { id: string; props: Record<string, unknown> } | null {
  const c = node?.components.find((x) => x.type === 'Text');
  return c ? { id: c.id, props: c.props as Record<string, unknown> } : null;
}

function alignOf(node: SceneNode): string | undefined {
  let align: string | undefined;
  for (const c of node.components) {
    const a = (c.props as Record<string, unknown>).align;
    if (typeof a === 'string') align = a;
  }
  return align;
}

function directionOf(node: SceneNode): 'ltr' | 'rtl' {
  let dir: unknown;
  let content: string | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (p.direction === 'rtl' || p.direction === 'ltr' || p.direction === 'auto') dir = p.direction;
    if (typeof p.content === 'string') content = p.content;
  }
  // The line block's anchor follows the FIRST paragraph ('auto' resolves it).
  return firstParagraphDirection(dir, content);
}

/**
 * Where the line block sits in its layer (local units, after the Character
 * panel's scale): the x its lines start/centre/end at, and its vertical offset
 * from the centred position. Null without text metrics.
 */
export function lineBlockPlacement(style: MeasuredTextStyle, align: string | undefined, direction?: 'ltr' | 'rtl'): Vec2 | null {
  const size = measureTextSize(style);
  if (!size) return null;
  const tr = textStyleTransform(style);
  const box = style.boxWidth ? measureParagraphBox(style) : null;
  const k = box?.fitScale ?? 1;
  const indents = style.boxWidth
    ? { left: (style.leftIndent ?? 0) * k, right: (style.rightIndent ?? 0) * k }
    : undefined;
  return {
    x: tr.sx * lineBlockAnchorX(align, size.w, indents, direction),
    // A fixed box aligns its lines INSIDE the character-scaled space; an
    // auto-height box's top-anchor offset is applied outside it (textPaint).
    y: box?.fixedHeight ? tr.sy * box.lineOffsetY : box?.lineOffsetY ?? 0,
  };
}

function poseOf(id: string): { x: number; y: number; rotationDeg: number; scaleX: number; scaleY: number } {
  return {
    x: readTransformProp(id, 'x'),
    y: readTransformProp(id, 'y'),
    rotationDeg: readTransformProp(id, 'rotation'),
    scaleX: readTransformProp(id, 'scaleX', 1),
    scaleY: readTransformProp(id, 'scaleY', 1),
  };
}

function holdStill(id: string, before: Vec2, after: Vec2, label: string): void {
  const shift = { x: after.x - before.x, y: after.y - before.y };
  if (Math.abs(shift.x) < 1e-6 && Math.abs(shift.y) < 1e-6) return;
  const next = compensatePosition(poseOf(id), shift);
  // B3-legacy: engine gap — paragraph / box text props (strings, runs, box size) are not API properties; Source Text runs arrive later (ENGINE_API.md §15.4).
  writeTransformProps(id, [{ prop: 'x', value: next.x }, { prop: 'y', value: next.y }], label);
}

/**
 * Selected text layers, split by kind. Text on a path is point text that
 * cannot become paragraph text (see `readParagraphBox`), so it is neither.
 */
export function selectedTextLayers(kind: 'point' | 'paragraph'): string[] {
  return useSelectionStore.getState().ids.filter((id) => {
    const node = defaultSceneGraph.getNode(id);
    if (!node || !textComponent(node) || hasTextPath(node)) return false;
    return (readParagraphBox(node) !== null) === (kind === 'paragraph');
  });
}

/** Point text → paragraph text with a box that fits it. Returns the converted ids. */
export function convertToParagraphText(ids: ReadonlyArray<string>): string[] {
  const done: string[] = [];
  // B3-legacy: engine gap — paragraph / box text props (strings, runs, box size) are not API properties; Source Text runs arrive later (ENGINE_API.md §15.4).
  runDocumentEdit('Convert to Paragraph Text', () => {
    for (const id of ids) {
      const node = defaultSceneGraph.getNode(id);
      const tc = textComponent(node);
      // Text on a path is point text: it has no box to convert into.
      if (!node || !tc || node.locked || hasTextPath(node) || readParagraphBox(node)) continue;
      const style = readMeasuredTextStyle(node);
      const size = style ? measureTextSize(style) : null;
      if (!style || !size) continue;
      const align = alignOf(node);
      const dir = directionOf(node);
      const before = lineBlockPlacement(style, align, dir);
      const tr = textStyleTransform(style);
      // The render box's content width, unscaled — at least as wide as every
      // line, so the new box does not re-wrap the text it was made from.
      const boxWidth = Math.max(MIN_BOX_SIZE, Math.ceil((size.w - 2 * TEXT_PAD_X) / (tr.sx || 1)) + CONVERT_BOX_PADDING);
      const auto = measureParagraphBox({ ...style, boxWidth });
      const boxHeight = Math.max(MIN_BOX_SIZE, Math.ceil(auto?.contentHeight ?? style.fontSize * style.lineHeight) + CONVERT_BOX_PADDING);
      const override = { boxWidth, boxHeight, boxAutoSize: 'off' };
      const afterStyle = readMeasuredTextStyle(node, override);
      const after = afterStyle ? lineBlockPlacement(afterStyle, align, dir) : null;
      // B3-legacy: engine gap — paragraph / box text props (strings, runs, box size) are not API properties; Source Text runs arrive later (ENGINE_API.md §15.4).
      updateNodeComponentProp(defaultSceneGraph, id, tc.id, 'boxWidth', boxWidth);
      updateNodeComponentProp(defaultSceneGraph, id, tc.id, 'boxHeight', boxHeight);
      updateNodeComponentProp(defaultSceneGraph, id, tc.id, 'boxAutoSize', 'off');
      if (before && after) holdStill(id, before, after, 'Convert to Paragraph Text');
      done.push(id);
    }
  });
  return done;
}

/** Paragraph text → point text: soft wraps become returns, the box goes. */
export function convertToPointText(ids: ReadonlyArray<string>): string[] {
  const done: string[] = [];
  // B3-legacy: engine gap — paragraph / box text props (strings, runs, box size) are not API properties; Source Text runs arrive later (ENGINE_API.md §15.4).
  runDocumentEdit('Convert to Point Text', () => {
    for (const id of ids) {
      const node = defaultSceneGraph.getNode(id);
      const tc = textComponent(node);
      if (!node || !tc || node.locked || !readParagraphBox(node)) continue;
      const style = readMeasuredTextStyle(node);
      if (!style) continue;
      const align = alignOf(node);
      const dir = directionOf(node);
      const before = lineBlockPlacement(style, align, dir);
      const k = style.fitScale && style.fitScale > 0 ? style.fitScale : 1;
      // The wrapped content is the raw content with each soft-wrap space
      // replaced by '\n' one-for-one, so character runs keep their indices.
      const raw = typeof tc.props.content === 'string' ? tc.props.content : style.content;
      const content = style.content.length !== raw.length ? raw : style.content;
      // Keyframed Source Text: every hold keyframe's text is wrapped through
      // the same box it rendered in (its OWN wrap, taken while the box still
      // exists) and its soft wraps become returns — in the same undo step.
      const track = defaultAnimation.isDataAnimated(id, 'text.source')
        ? defaultAnimation.getDataTrack(id, 'text.source')
        : null;
      if (track) {
        let changed = false;
        const keyframes = track.keyframes.map((kf) => {
          if (typeof kf.value !== 'string') return kf;
          const wrapped = readMeasuredTextStyle(node, { content: kf.value })?.content;
          if (wrapped === undefined || wrapped === kf.value || wrapped.length !== kf.value.length) return kf;
          changed = true;
          return { ...kf, value: wrapped };
        });
        // B3-legacy: engine gap — paragraph / box text props (strings, runs, box size) are not API properties; Source Text runs arrive later (ENGINE_API.md §15.4).
        if (changed) defaultAnimation.setDataTrack(id, 'text.source', { ...track, keyframes });
      }
      const bake: Record<string, number> = {};
      if (k < 1) {
        bake.fontSize = style.fontSize * k;
        if (style.letterSpacing) bake.letterSpacing = style.letterSpacing * k;
        if (style.paragraphSpacing) bake.paragraphSpacing = style.paragraphSpacing * k;
      }
      const afterStyle = readMeasuredTextStyle(node, { content, boxWidth: 0, boxHeight: 0, ...bake });
      const after = afterStyle ? lineBlockPlacement(afterStyle, align, dir) : null;
      // B3-legacy: engine gap — paragraph / box text props (strings, runs, box size) are not API properties; Source Text runs arrive later (ENGINE_API.md §15.4).
      if (content !== raw) updateNodeComponentProp(defaultSceneGraph, id, tc.id, 'content', content);
      for (const [key, value] of Object.entries(bake)) updateNodeComponentProp(defaultSceneGraph, id, tc.id, key, value);
      updateNodeComponentProp(defaultSceneGraph, id, tc.id, 'boxWidth', 0);
      if (typeof tc.props.boxHeight === 'number' && tc.props.boxHeight !== 0) {
        updateNodeComponentProp(defaultSceneGraph, id, tc.id, 'boxHeight', 0);
      }
      if (before && after) holdStill(id, before, after, 'Convert to Point Text');
      done.push(id);
    }
  });
  return done;
}

/**
 * Set a paragraph box's auto-size mode without moving the text.
 *
 *   • to a FIXED mode from auto height: the box takes the text's current
 *     height (AE keeps the box's current size);
 *   • to AUTO HEIGHT: the box's height becomes the AUTHORED height whose top
 *     edge holds while the text grows downward (a box that never had one takes
 *     the text's current height).
 *
 * Whatever moves the line block inside the layer (vertical alignment, the
 * anchor) is compensated through Position, in the same undo step.
 */
export function setBoxAutoSize(id: string, mode: BoxAutoSize): boolean {
  const node = defaultSceneGraph.getNode(id);
  const tc = textComponent(node);
  const box = node ? readParagraphBox(node) : null;
  if (!node || !tc || !box) return false;
  // B3-legacy: engine gap — paragraph / box text props (strings, runs, box size) are not API properties; Source Text runs arrive later (ENGINE_API.md §15.4).
  runDocumentEdit('Box Auto-Size', () => {
    const align = alignOf(node);
    const dir = directionOf(node);
    const style = readMeasuredTextStyle(node);
    const before = style ? lineBlockPlacement(style, align, dir) : null;
    const m = style ? measureParagraphBox(style) : null;
    // Exactly the text's height, not rounded: a top-aligned box one fraction
    // of a pixel taller than its lines would nudge them up by half of it.
    const contentH = Math.max(MIN_BOX_SIZE, m?.contentHeight ?? (style ? style.fontSize * style.lineHeight : MIN_BOX_SIZE));
    if (mode !== 'height' ? !box.fixedHeight : !(box.boxHeight > 0)) {
      // B3-legacy: engine gap — paragraph / box text props (strings, runs, box size) are not API properties; Source Text runs arrive later (ENGINE_API.md §15.4).
      updateNodeComponentProp(defaultSceneGraph, id, tc.id, 'boxHeight', contentH);
    }
    updateNodeComponentProp(defaultSceneGraph, id, tc.id, 'boxAutoSize', mode);
    const afterNode = defaultSceneGraph.getNode(id);
    const afterStyle = afterNode ? readMeasuredTextStyle(afterNode) : null;
    const after = afterStyle ? lineBlockPlacement(afterStyle, align, dir) : null;
    if (before && after) holdStill(id, before, after, 'Box Auto-Size');
  });
  return true;
}

export function buildParagraphTextCommands(): ReadonlyArray<Command> {
  return [
    {
      id: TEXT_CONVERT_TO_PARAGRAPH_COMMAND,
      label: 'Convert to Paragraph Text',
      description: 'Turn the selected point text into paragraph (box) text without moving it.',
      enabled: () => selectedTextLayers('point').length > 0,
      execute: () => {
        convertToParagraphText(selectedTextLayers('point'));
      },
    },
    {
      id: TEXT_CONVERT_TO_POINT_COMMAND,
      label: 'Convert to Point Text',
      description: 'Turn the selected paragraph text into point text; each wrapped line ends in a return.',
      enabled: () => selectedTextLayers('paragraph').length > 0,
      execute: () => {
        convertToPointText(selectedTextLayers('paragraph'));
      },
    },
  ];
}

let installed = false;

/** Register the paragraph-text commands. Safe to call repeatedly. */
export function installParagraphTextCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildParagraphTextCommands()) registry.register(command);
  getShortcutManager().rehydrateFromRegistry();
}

/** Test seam — forget that the commands were installed. */
export function resetParagraphTextCommandsForTest(): void {
  installed = false;
}
