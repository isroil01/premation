/**
 * Template fields through the engine API (B3, docs/B3_PATTERNS.md): the
 * fill-in panel's field controls and Batch Fill's "Apply this row".
 *
 * A field targets one prop of one layer (templateTypes.ts). The ones the API
 * addresses become ordinary commands at the playhead:
 *
 *   Text.content      → Source Text (`text/sourceText`, style runs kept —
 *                       `sourceTextCommand`; a key there when it is animated)
 *   *.fill (colour)   → the layer's Fill Color (`layer/fill`; a key at the
 *                       playhead when the fill is animated, AE setValueAtTime)
 *   a number          → the catalog property of that prop (`scalarValueCommands`)
 *
 * A MEDIA field is a slot fill of a picked browser `File`: the bytes are
 * imported (`importBytes`), then the layer's source is swapped and its size
 * set to the slot's fitted box (`replaceLayerSource` + `layer/width|height`)
 * in one entry — `fillMediaFieldEdit`.
 *
 * The values a field shows (`templateFieldValues`) and a slot's rect / fit (`slotBoxOf`) are asked of
 * the engine (B4).
 */

import type { Command } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { compTime, values as apiValues } from '@core/engine/propRefs';
import { hexToColor } from '@core/engine/model';
import { coerceCell, type FillResult } from '@core/template/dataFill';
import type { DataRow } from '@core/template/dataTable';
import type { BatchFieldOps } from '@core/template/batchRender';
import type { TemplateField } from '@core/template/templateTypes';
import { sourceTextCommand } from '@layout/Text/textEdits';
import { scalarValueCommands, trackRef } from '@layout/Inspector/inspectorEdits';
import { importBrowserFilesEdit } from '@layout/Assets/assetEdits';
import { fittedBoxFor } from '@core/template/mediaSlots';
import type { SlotFit } from '@core/template/templateTypes';
import type { PropRef, Value } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { apiUnitFactor } from '@core/engine/props';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { channelsToHex } from '@core/mirror/paintFields';
import { documentMirror } from '@stores/documentMirror';
import type { ImportedAsset } from '@stores/assetStore';

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Field kinds Batch Fill writes (dataFill.ts: media columns are reported, not filled). */
const FILLABLE_KINDS: ReadonlySet<string> = new Set(['text', 'color', 'number']);

/** True for a field that swaps a layer's SOURCE (templateFields.isMediaField, without its module's scene reads). */
export function isMediaField(field: TemplateField): boolean {
  return (field.kind === 'image' || field.kind === 'media') && field.target.prop === 'src';
}

/**
 * The commands for "field := value" at comp time `seconds`, or null when the
 * API does not address the field's target (the layer is gone, is not a layer,
 * has no such property, or the field is a media slot).
 */
export function templateFieldCommands(field: TemplateField, value: string | number, seconds: number): Command[] | null {
  if (isMediaField(field)) return null;
  const { nodeId, componentType, prop } = field.target;
  if (componentType === 'Text' && prop === 'content') {
    return sourceTextCommand(nodeId, String(value), seconds);
  }
  if (prop === 'fill') {
    if (typeof value !== 'string' || !HEX.test(value.trim())) return null;
    // Present only while the layer's fill is a solid colour (a gradient fill has no Fill Color).
    const r = trackRef(nodeId, 'layer/fill');
    if (!r) return null;
    const c = hexToColor(value);
    return [{ type: 'setProperty', prop: r.ref, value: apiValues.color(c.r, c.g, c.b, c.a), time: compTime(seconds) }];
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const r = trackRef(nodeId, prop);
    if (!r || r.members.length !== 1 || r.valueType === 'color') return null;
    const cmds = scalarValueCommands(prop, [{ nodeId, value }], { seconds });
    return cmds.length > 0 ? cmds : null;
  }
  return null;
}

/**
 * Batch Fill ▸ Apply this row: every field the row has a column for, as ONE
 * undo entry named `label` (not one per field — "apply this row" is the action
 * the user took). Columns with no field are ignored; fields with no column keep
 * their value. A media column is reported in `skippedKind`; a cell that cannot
 * be the field's kind, or a field whose layer the API cannot address, in
 * `failed`. When the engine refuses the batch (a locked layer, …) nothing is
 * written and every field is `failed` (the refusal is toasted).
 */
export async function fillDataRowEdit(
  fields: ReadonlyArray<TemplateField>,
  row: DataRow,
  label: string,
  seconds: number,
): Promise<FillResult> {
  const result: FillResult = { filled: [], skippedKind: [], failed: [] };
  const cmds: Command[] = [];
  for (const field of fields) {
    const cell = row[field.id];
    if (cell === undefined) continue;
    if (isMediaField(field) || !FILLABLE_KINDS.has(field.kind)) {
      result.skippedKind.push(field.id);
      continue;
    }
    const value = coerceCell(field.kind, cell);
    const fc = value === null ? null : templateFieldCommands(field, value, seconds);
    if (!fc || fc.length === 0) {
      result.failed.push(field.id);
      continue;
    }
    cmds.push(...fc);
    result.filled.push(field.id);
  }
  if (cmds.length === 0) return result;
  const res = await edit(label, cmds);
  if (!res.ok) return { filled: [], skippedKind: result.skippedKind, failed: [...result.filled, ...result.failed] };
  return result;
}

/**
 * Fill a media field with a picked `File`: import it (its own entry, like any
 * import), then swap the slot layer's source and reframe it to the slot rect
 * as ONE entry, "Edit <label>". Resolves to the imported item, or null when
 * the import or the edit was refused (toasted).
 */
export async function fillMediaFieldEdit(field: TemplateField, file: File, seconds: number): Promise<ImportedAsset | null> {
  if (!isMediaField(field)) return null;
  const { imported: [asset] } = await importBrowserFilesEdit([{ file }]);
  if (!asset) return null;
  const nodeId = field.target.nodeId;
  const cmds: Command[] = [{ type: 'replaceLayerSource', layer: nodeId, source: asset.id, keepSize: true }];
  const w = asset.metadata?.width;
  const h = asset.metadata?.height;
  // B4: the slot rect and fit are layer properties (`layer/slotFit|slotWidth|slotHeight`), asked of the engine.
  const box = await slotBoxOf(nodeId, w && h ? { width: Math.round(w * (asset.interpret?.par ?? 1)), height: h } : null, seconds);
  if (box) {
    cmds.push(
      ...scalarValueCommands('width', [{ nodeId, value: box.width }], { seconds }),
      ...scalarValueCommands('height', [{ nodeId, value: box.height }], { seconds }),
    );
  }
  const res = await edit(`Edit ${field.label}`, cmds);
  return res.ok ? asset : null;
}

// ── Reads (B4 round 5) ─────────────────────────────────────────────────

/** Static values at `seconds` (pre-expression), keyed by path; a query that fails answers nothing. */
export async function propertyValuesAt(layer: string, paths: readonly string[], seconds: number): Promise<Map<string, Value>> {
  const out = new Map<string, Value>();
  if (paths.length === 0) return out;
  const res = await engine().query({ type: 'getPropertyValues', props: paths.map((path) => ({ layer, path })), time: compTime(seconds), evaluated: false });
  if (res.ok) for (const v of res.value.values) out.set(v.prop.path, v.value);
  return out;
}

/**
 * The box a slot layer takes for a source of `source` size (mediaSlots.ts `slotBoxFor` over the engine): the
 * AUTHORED slot rect (`layer/slotWidth|slotHeight`, else the layer's own width / height — a slot declared
 * before the rect was captured) and its fit (`layer/slotFit`, `contain` when unset). Null when the source size
 * is unknown or the layer has no box.
 */
export async function slotBoxOf(nodeId: string, source: { width: number; height: number } | null, seconds: number): Promise<{ width: number; height: number } | null> {
  if (!source || !(source.width > 0) || !(source.height > 0)) return null;
  const slot = await propertyValuesAt(nodeId, ['layer/slotFit', 'layer/slotWidth', 'layer/slotHeight'], seconds);
  const wRef = trackRef(nodeId, 'width');
  const hRef = trackRef(nodeId, 'height');
  const box = await propertyValuesAt(nodeId, [wRef?.ref.path, hRef?.ref.path].filter((x): x is string => !!x), seconds);
  const positive = (v: Value | undefined, factor = 1): number | undefined => {
    const n = numbersOfValue(v)[0];
    return n !== undefined && n > 0 ? n / factor : undefined;
  };
  const width = positive(slot.get('layer/slotWidth')) ?? (wRef ? positive(box.get(wRef.ref.path), apiUnitFactor('width')) : undefined);
  const height = positive(slot.get('layer/slotHeight')) ?? (hRef ? positive(box.get(hRef.ref.path), apiUnitFactor('height')) : undefined);
  if (width === undefined || height === undefined) return null;
  const fitValue = slot.get('layer/slotFit');
  const stored = fitValue?.kind === 'choice' ? fitValue.value : 'none';
  // Unset: mediaSlots.ts DEFAULT_SLOT_FIT.
  const fit: SlotFit = stored === 'contain' || stored === 'cover' || stored === 'native' ? stored : 'contain';
  return fittedBoxFor(source, { width, height }, fit);
}

/**
 * The value each field shows now (the fill-in panel's controls): Source Text's text, the Fill Color as hex, a
 * number in its stored units (static values at `seconds`, pre-expression), a media slot's playable media (its
 * source item's `mediaUrl`). Fields the engine does not address are left out.
 */
export async function templateFieldValues(fields: readonly TemplateField[], seconds: number): Promise<Record<string, string | number>> {
  const out: Record<string, string | number> = {};
  const m = documentMirror();
  const asks: Array<{ field: TemplateField; ref: PropRef; read: (v: Value) => string | number | undefined }> = [];
  for (const field of fields) {
    const { nodeId, componentType, prop } = field.target;
    if (isMediaField(field)) {
      const src = m.layer(nodeId)?.source;
      const url = src ? m.item(src)?.mediaUrl : undefined;
      if (url !== undefined) out[field.id] = url;
      continue;
    }
    if (componentType === 'Text' && prop === 'content') {
      asks.push({ field, ref: { layer: nodeId, path: 'text/sourceText' }, read: (v) => (v.kind === 'textDocument' ? v.value.text : undefined) });
      continue;
    }
    if (prop === 'fill') {
      const r = trackRef(nodeId, 'layer/fill');
      if (r) asks.push({ field, ref: r.ref, read: (v) => (v.kind === 'color' ? channelsToHex(v.value) : undefined) });
      continue;
    }
    const r = trackRef(nodeId, prop);
    if (r && r.members.length === 1 && r.valueType !== 'color') {
      asks.push({ field, ref: r.ref, read: (v) => { const n = numbersOfValue(v)[0]; return n === undefined ? undefined : n / apiUnitFactor(prop); } });
    }
  }
  for (const a of asks) {
    const v = (await propertyValuesAt(a.ref.layer, [a.ref.path], seconds)).get(a.ref.path);
    const shown = v ? a.read(v) : undefined;
    if (shown !== undefined) out[a.field.id] = shown;
  }
  return out;
}

/**
 * The batch render's field read / fill / restore through the engine
 * (batchRender.ts `BatchFieldOps`): the values asked of the engine at
 * `seconds`, each row applied by `fillDataRowEdit`, the template put back as
 * ONE "Restore template after batch" entry of `templateFieldCommands`.
 */
export function engineBatchFieldOps(seconds: number): BatchFieldOps {
  return {
    read: async (fields) => {
      const values = await templateFieldValues(fields.filter((f) => !isMediaField(f)), seconds);
      return fields.filter((f) => values[f.id] !== undefined).map((field) => ({ field, value: values[field.id]! }));
    },
    fill: (fields, row, label) => fillDataRowEdit(fields, row, label, seconds),
    restore: async (saved, label) => {
      const cmds = saved.flatMap(({ field, value }) => templateFieldCommands(field, value, seconds) ?? []);
      if (cmds.length > 0) await edit(label, cmds);
    },
  };
}
