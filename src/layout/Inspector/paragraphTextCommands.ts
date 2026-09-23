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
import type { Command as ApiCommand } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { readTransformProp } from '@core/scene/transformWrite';
import { isLayer } from '@core/engine/doc';
import { engine } from '@core/engine/engineInstance';
import { paths, values as apiValues } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { getTime } from '@stores/playbackClockStore';
import { sourceTextCommand } from '@layout/Text/textEdits';
import { componentPropsCommands } from './useComponentProp';
import { trackWrites } from './inspectorEdits';
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

/** The Position write that holds the text still when its line block moves inside the layer. */
function holdStillCommands(id: string, before: Vec2, after: Vec2, seconds: number): ApiCommand[] {
  const shift = { x: after.x - before.x, y: after.y - before.y };
  if (Math.abs(shift.x) < 1e-6 && Math.abs(shift.y) < 1e-6) return [];
  const next = compensatePosition(poseOf(id), shift);
  // Keyed at the playhead where Position is animated (AE setValueAtTime), else static.
  const writes = trackWrites(id, { x: next.x, y: next.y }, seconds);
  return writes.length > 0 ? [{ type: 'setProperties', writes }] : [];
}

/** Text component props → field / property writes (every one addressed by the engine). */
function textPropCommands(id: string, tcId: string, values: Readonly<Record<string, unknown>>, seconds: number): ApiCommand[] {
  return componentPropsCommands(id, tcId, values, seconds).cmds;
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

/**
 * Point text → paragraph text with a box that fits it: ONE engine batch — the
 * box fields (`text/boxWidth`, `text/boxHeight`, `text/boxAutoSize`) and the
 * compensating Position. Resolves the converted ids.
 */
export async function convertToParagraphText(ids: ReadonlyArray<string>, seconds: number = getTime()): Promise<string[]> {
  const done: string[] = [];
  const cmds: ApiCommand[] = [];
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    const tc = textComponent(node);
    // Text on a path is point text: it has no box to convert into.
    if (!node || !tc || !isLayer(id) || node.locked || hasTextPath(node) || readParagraphBox(node)) continue;
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
    cmds.push(...textPropCommands(id, tc.id, override, seconds));
    if (before && after) cmds.push(...holdStillCommands(id, before, after, seconds));
    done.push(id);
  }
  if (cmds.length === 0) return [];
  const res = await edit('Convert to Paragraph Text', cmds);
  return res.ok ? done : [];
}

/**
 * Paragraph text → point text: soft wraps become returns, the box goes — ONE
 * engine batch: Source Text (static: the text + its style runs re-sent, which
 * index the same characters because each wrap replaces one space; keyed: every
 * Source Text key's own wrap through `updateKeyframes`), a Fit Text to Box
 * scale baked into Font Size / Tracking / Paragraph spacing, the box fields
 * cleared, and the compensating Position. Resolves the converted ids.
 */
export async function convertToPointText(ids: ReadonlyArray<string>, seconds: number = getTime()): Promise<string[]> {
  const done: string[] = [];
  const cmds: ApiCommand[] = [];
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    const tc = textComponent(node);
    if (!node || !tc || !isLayer(id) || node.locked || !readParagraphBox(node)) continue;
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
    if (defaultAnimation.isDataAnimated(id, 'text.source')) {
      // Keyframed Source Text: every key's text is wrapped through the same box
      // it rendered in (its OWN wrap, taken while the box still exists).
      const q = await engine().query({ type: 'getKeyframes', props: [{ layer: id, path: paths.sourceText() }] });
      const patches = q.ok ? (q.value.sets[0]?.keyframes ?? []).flatMap((kf) => {
        if (kf.value.kind !== 'textDocument') return [];
        const text = kf.value.value.text;
        const wrapped = readMeasuredTextStyle(node, { content: text })?.content;
        if (wrapped === undefined || wrapped === text || wrapped.length !== text.length) return [];
        return [{ id: kf.id, value: apiValues.string(wrapped), spatialIn: [], spatialOut: [] }];
      }) : [];
      if (patches.length > 0) cmds.push({ type: 'updateKeyframes', patches });
    } else if (content !== raw) {
      cmds.push(...(sourceTextCommand(id, content, seconds) ?? []));
    }
    const bake: Record<string, number> = {};
    if (k < 1) {
      bake.fontSize = style.fontSize * k;
      if (style.letterSpacing) bake.letterSpacing = style.letterSpacing * k;
      if (style.paragraphSpacing) bake.paragraphSpacing = style.paragraphSpacing * k;
    }
    const afterStyle = readMeasuredTextStyle(node, { content, boxWidth: 0, boxHeight: 0, ...bake });
    const after = afterStyle ? lineBlockPlacement(afterStyle, align, dir) : null;
    const box: Record<string, unknown> = { ...bake, boxWidth: 0 };
    if (typeof tc.props.boxHeight === 'number' && tc.props.boxHeight !== 0) box.boxHeight = 0;
    cmds.push(...textPropCommands(id, tc.id, box, seconds));
    if (before && after) cmds.push(...holdStillCommands(id, before, after, seconds));
    done.push(id);
  }
  if (cmds.length === 0) return [];
  const res = await edit('Convert to Point Text', cmds);
  return res.ok ? done : [];
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
 * anchor) is compensated through Position — ONE engine batch.
 */
export async function setBoxAutoSize(id: string, mode: BoxAutoSize, seconds: number = getTime()): Promise<boolean> {
  const node = defaultSceneGraph.getNode(id);
  const tc = textComponent(node);
  const box = node ? readParagraphBox(node) : null;
  if (!node || !tc || !box || !isLayer(id)) return false;
  const align = alignOf(node);
  const dir = directionOf(node);
  const style = readMeasuredTextStyle(node);
  const before = style ? lineBlockPlacement(style, align, dir) : null;
  const m = style ? measureParagraphBox(style) : null;
  // Exactly the text's height, not rounded: a top-aligned box one fraction
  // of a pixel taller than its lines would nudge them up by half of it.
  const contentH = Math.max(MIN_BOX_SIZE, m?.contentHeight ?? (style ? style.fontSize * style.lineHeight : MIN_BOX_SIZE));
  const patch: Record<string, unknown> = {};
  if (mode !== 'height' ? !box.fixedHeight : !(box.boxHeight > 0)) patch.boxHeight = contentH;
  patch.boxAutoSize = mode;
  const afterStyle = readMeasuredTextStyle(node, patch);
  const after = afterStyle ? lineBlockPlacement(afterStyle, align, dir) : null;
  const cmds = [...textPropCommands(id, tc.id, patch, seconds), ...(before && after ? holdStillCommands(id, before, after, seconds) : [])];
  const res = await edit('Box Auto-Size', cmds);
  return res.ok;
}

export function buildParagraphTextCommands(): ReadonlyArray<Command> {
  return [
    {
      id: TEXT_CONVERT_TO_PARAGRAPH_COMMAND,
      label: 'Convert to Paragraph Text',
      description: 'Turn the selected point text into paragraph (box) text without moving it.',
      enabled: () => selectedTextLayers('point').length > 0,
      execute: () => {
        void convertToParagraphText(selectedTextLayers('point'));
      },
    },
    {
      id: TEXT_CONVERT_TO_POINT_COMMAND,
      label: 'Convert to Point Text',
      description: 'Turn the selected paragraph text into point text; each wrapped line ends in a return.',
      enabled: () => selectedTextLayers('paragraph').length > 0,
      execute: () => {
        void convertToPointText(selectedTextLayers('paragraph'));
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
