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
 * Display reads stay direct until B4's mirror.
 */

import type { Command } from '@motion/engine-api';
import { edit } from '@core/engine/uiEdits';
import { compTime, values as apiValues } from '@core/engine/propRefs';
import { hexToColor } from '@core/engine/model';
import { coerceCell, type FillResult } from '@core/template/dataFill';
import type { DataRow } from '@core/template/dataTable';
import type { TemplateField } from '@core/template/templateTypes';
import { sourceTextCommand } from '@layout/Text/textEdits';
import { scalarValueCommands, trackRef } from '@layout/Inspector/inspectorEdits';
import { importBrowserFilesEdit } from '@layout/Assets/assetEdits';
import { slotBoxFor } from '@core/template/mediaSlots';
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
  const box = slotBoxFor(nodeId, w && h ? { width: Math.round(w * (asset.interpret?.par ?? 1)), height: h } : null);
  if (box) {
    cmds.push(
      ...scalarValueCommands('width', [{ nodeId, value: box.width }], { seconds }),
      ...scalarValueCommands('height', [{ nodeId, value: box.height }], { seconds }),
    );
  }
  const res = await edit(`Edit ${field.label}`, cmds);
  return res.ok ? asset : null;
}
