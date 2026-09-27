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
 *
 * The measuring is the ENGINE's (`getTextLayout`, ENGINE_API.md §15.12): the
 * render box, the wrap, the paragraph box and where the line block sits, for
 * the stored style and for the style the conversion is about to write (the
 * query's overrides). The pose comes from `getPropertyValues` at the time;
 * the facts that decide what a layer is (box width, text path, lock, keyed
 * Source Text) come from the mirror.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import type { Command as ApiCommand, TextLayout, TextLayoutOverrides } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { compTime, values as apiValues } from '@core/engine/propRefs';
import { edit } from '@core/engine/uiEdits';
import { storedNumber, trackRefIn } from '@core/mirror/trackIndex';
import { uiKindOf } from '@core/mirror/layerKinds';
import { documentMirror, type MirrorTree } from '@stores/documentMirror';
import { getTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { fieldCommands, sourceTextCommand } from '@layout/Text/textEdits';
import { isSourceTextAnimated, sourceTextOf, SOURCE_TEXT_PATH, textField, textPathOf } from '@layout/Text/textMirror';
import { trackWrites } from './inspectorEdits';
import { MIN_BOX_SIZE, TEXT_PAD_X, type BoxAutoSize } from '@core/text/textExtras';
import { compensatePosition, type Vec2 } from '@core/text/paragraphBox';

export const TEXT_CONVERT_TO_POINT_COMMAND = asCommandId('text.convertToPointText');
export const TEXT_CONVERT_TO_PARAGRAPH_COMMAND = asCommandId('text.convertToParagraphText');

/** Padding added around the measured text when it becomes a box, px. */
export const CONVERT_BOX_PADDING = 4;

/** The layer's text layout as the engine measures it (overrides = the style about to be written); null when it cannot. */
async function layoutOf(id: string, overrides?: TextLayoutOverrides, seconds: number = getTime()): Promise<TextLayout | null> {
  const res = await engine().query({ type: 'getTextLayout', layer: id, time: compTime(seconds), ...(overrides ? { overrides } : {}) });
  return res.ok ? res.value : null;
}

/** A layer's property tree, fetched when the mirror has not loaded it yet. */
async function treeOf(id: string): Promise<MirrorTree | undefined> {
  const m = documentMirror();
  const now = m.tree(id);
  if (now) return now;
  await m.whenIdle();
  return m.tree(id);
}

interface Pose { x: number; y: number; rotationDeg: number; scaleX: number; scaleY: number }

/** Position / Rotation / Scale evaluated at `seconds` (stored units: scale 1 = 100 %). */
async function poseAt(id: string, seconds: number): Promise<Pose> {
  const tree = await treeOf(id);
  const tracks = ['x', 'y', 'rotation', 'scaleX', 'scaleY'] as const;
  const refs = tracks.map((t) => trackRefIn(tree, t));
  const pathsWanted = [...new Set(refs.flatMap((r) => (r ? [r.path] : [])))];
  const res = pathsWanted.length > 0
    ? await engine().query({ type: 'getPropertyValues', props: pathsWanted.map((path) => ({ layer: id, path })), time: compTime(seconds), evaluated: true })
    : null;
  const byPath = new Map((res?.ok ? res.value.values : []).map((v) => [v.prop.path, v.value]));
  const read = (i: number, fallback: number): number => {
    const r = refs[i];
    const v = r ? storedNumber(r, byPath.get(r.path)) : undefined;
    return v ?? fallback;
  };
  return { x: read(0, 0), y: read(1, 0), rotationDeg: read(2, 0), scaleX: read(3, 1), scaleY: read(4, 1) };
}

/** The Position write that holds the text still when its line block moves inside the layer. */
async function holdStillCommands(id: string, before: Vec2, after: Vec2, seconds: number): Promise<ApiCommand[]> {
  const shift = { x: after.x - before.x, y: after.y - before.y };
  if (Math.abs(shift.x) < 1e-6 && Math.abs(shift.y) < 1e-6) return [];
  const next = compensatePosition(await poseAt(id, seconds), shift);
  // Keyed at the playhead where Position is animated (AE setValueAtTime), else static.
  const writes = trackWrites(id, { x: next.x, y: next.y }, seconds);
  return writes.length > 0 ? [{ type: 'setProperties', writes }] : [];
}

/** The paragraph-box fields as path writes (`text/boxWidth`, `text/boxHeight`, `text/boxAutoSize`). */
function boxCommands(id: string, box: Readonly<{ boxWidth?: number; boxHeight?: number; boxAutoSize?: string }>): ApiCommand[] {
  return Object.entries(box).flatMap(([k, v]) => (v === undefined ? [] : fieldCommands(id, `text/${k}`, v)));
}

function isTextLayerNow(id: string): boolean {
  return uiKindOf(documentMirror().layer(id)) === 'text';
}

/** Point or paragraph, from the mirror: a box width makes paragraph text; text on a path has no box. Null when not a text layer (or its tree is not loaded yet). */
function textKindOf(id: string): 'point' | 'paragraph' | 'path' | null {
  const m = documentMirror();
  if (!isTextLayerNow(id) || !m.tree(id)) return null;
  if (textPathOf(m, id) !== '') return 'path';
  const w = textField(m, id, 'boxWidth');
  return typeof w === 'number' && w > 0 ? 'paragraph' : 'point';
}

/**
 * Selected text layers, split by kind. Text on a path is point text that
 * cannot become paragraph text, so it is neither.
 */
export function selectedTextLayers(kind: 'point' | 'paragraph'): string[] {
  return useSelectionStore.getState().ids.filter((id) => textKindOf(id) === kind);
}

function lockedNow(id: string): boolean {
  return documentMirror().layer(id)?.switches.locked === true;
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
    await treeOf(id);
    // Text on a path is point text: it has no box to convert into.
    if (textKindOf(id) !== 'point' || lockedNow(id)) continue;
    const now = await layoutOf(id, undefined, seconds);
    // The engine's word on a text path (a path option riding no mask reads '' in the mirror).
    if (!now || now.onPath) continue;
    // The render box's content width, unscaled — at least as wide as every
    // line, so the new box does not re-wrap the text it was made from.
    const boxWidth = Math.max(MIN_BOX_SIZE, Math.ceil((now.size.x - 2 * TEXT_PAD_X) / (now.styleScale.x || 1)) + CONVERT_BOX_PADDING);
    const auto = await layoutOf(id, { boxWidth, boxHeight: 0 }, seconds);
    const boxHeight = Math.max(MIN_BOX_SIZE, Math.ceil(auto?.paragraph?.contentHeight ?? now.fontSize * lineHeightOf(id)) + CONVERT_BOX_PADDING);
    const box = { boxWidth, boxHeight, boxAutoSize: 'off' };
    const after = await layoutOf(id, box, seconds);
    cmds.push(...boxCommands(id, box));
    if (after) cmds.push(...await holdStillCommands(id, now.lineBlock, after.lineBlock, seconds));
    done.push(id);
  }
  if (cmds.length === 0) return [];
  const res = await edit('Convert to Paragraph Text', cmds);
  return res.ok ? done : [];
}

/** The layer's stored leading (Character panel line height, a font-size multiple). */
function lineHeightOf(id: string): number {
  const v = textField(documentMirror(), id, 'lineHeight');
  return typeof v === 'number' && v > 0 ? v : 1.2;
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
  const m = documentMirror();
  for (const id of ids) {
    await treeOf(id);
    if (textKindOf(id) !== 'paragraph' || lockedNow(id)) continue;
    const now = await layoutOf(id, undefined, seconds);
    if (!now) continue;
    const fit = now.paragraph?.fitScale;
    const k = fit && fit > 0 ? fit : 1;
    // The wrapped content is the raw content with each soft-wrap space
    // replaced by '\n' one-for-one, so character runs keep their indices.
    const raw = sourceTextOf(m.property(id, SOURCE_TEXT_PATH)?.value) ?? now.wrapped;
    const content = now.wrapped.length !== raw.length ? raw : now.wrapped;
    if (isSourceTextAnimated(m, id)) {
      // Keyframed Source Text: every key's text is wrapped through the same box
      // it rendered in (its OWN wrap, taken while the box still exists).
      const patches = [];
      for (const kf of m.keyframes(id, SOURCE_TEXT_PATH)) {
        if (kf.value.kind !== 'textDocument') continue;
        const text = kf.value.value.text;
        const wrapped = (await layoutOf(id, { content: text }, seconds))?.wrapped;
        if (wrapped === undefined || wrapped === text || wrapped.length !== text.length) continue;
        patches.push({ id: kf.id, value: apiValues.string(wrapped), spatialIn: [], spatialOut: [] });
      }
      if (patches.length > 0) cmds.push({ type: 'updateKeyframes', patches });
    } else if (content !== raw) {
      cmds.push(...(sourceTextCommand(id, content, seconds) ?? []));
    }
    const bake: { fontSize?: number; letterSpacing?: number; paragraphSpacing?: number } = {};
    if (k < 1) {
      bake.fontSize = now.fontSize * k;
      if (now.letterSpacing) bake.letterSpacing = now.letterSpacing * k;
      if (now.paragraphSpacing) bake.paragraphSpacing = now.paragraphSpacing * k;
    }
    const after = await layoutOf(id, { content, boxWidth: 0, boxHeight: 0, ...bake }, seconds);
    const bakeNums = Object.fromEntries(Object.entries(bake).filter((e): e is [string, number] => typeof e[1] === 'number'));
    const bakeWrites = trackWrites(id, bakeNums, seconds);
    if (bakeWrites.length > 0) cmds.push({ type: 'setProperties', writes: bakeWrites });
    const storedHeight = textField(m, id, 'boxHeight');
    cmds.push(...boxCommands(id, { boxWidth: 0, ...(typeof storedHeight === 'number' && storedHeight !== 0 ? { boxHeight: 0 } : {}) }));
    if (after) cmds.push(...await holdStillCommands(id, now.lineBlock, after.lineBlock, seconds));
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
  await treeOf(id);
  if (textKindOf(id) !== 'paragraph') return false;
  const now = await layoutOf(id, undefined, seconds);
  const box = now?.paragraph;
  if (!now || !box) return false;
  // Exactly the text's height, not rounded: a top-aligned box one fraction
  // of a pixel taller than its lines would nudge them up by half of it.
  const contentH = Math.max(MIN_BOX_SIZE, box.contentHeight);
  const patch: { boxHeight?: number; boxAutoSize: string } = { boxAutoSize: mode };
  if (mode !== 'height' ? !box.fixedHeight : !(box.storedHeight > 0)) patch.boxHeight = contentH;
  const after = await layoutOf(id, patch, seconds);
  const cmds = [...boxCommands(id, patch), ...(after ? await holdStillCommands(id, now.lineBlock, after.lineBlock, seconds) : [])];
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
