/**
 * Authored template-field edits through the engine API (B3): the manifest
 * lives on the composition (`CompSettings.templateFields`, JSON), and
 * `setCompositionSettings.templateFields` replaces it as one undoable entry.
 * The list is read from the document mirror (B4) and transformed here.
 */
import { edit } from '@core/engine/uiEdits';
import { isPublicFieldId, slugFieldId, uniqueFieldId } from '@core/automation/fieldIds';
import type { TemplateField } from '@core/template/templateTypes';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import type { Command } from '@motion/engine-api';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { channelsToHex } from '@core/mirror/paintFields';
import { apiUnitFactor } from '@core/engine/props';
import { trackRef } from '@layout/Inspector/inspectorEdits';
import { getTime } from '@stores/playbackClockStore';
import { propertyValuesAt } from './templateFieldEdits';

/** The comp's authored fields, from the mirror (empty when none or malformed). */
export function mirrorAuthoredFields(comp: string): TemplateField[] {
  const json = documentMirror().comp(comp)?.settings.templateFields;
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v as TemplateField[] : [];
  } catch {
    return [];
  }
}

/** `fields` without `fieldId`. */
export function withoutField(fields: readonly TemplateField[], fieldId: string): TemplateField[] {
  return fields.filter((f) => f.id !== fieldId);
}

/** `fields` with `fieldId` relabelled. */
export function withFieldLabel(fields: readonly TemplateField[], fieldId: string, label: string): TemplateField[] {
  return fields.map((f) => (f.id === fieldId ? { ...f, label } : f));
}

/**
 * `fields` with the public input id n8n will send changed. Null when the
 * rename is rejected: a collision, or an id that is not a public slug.
 */
export function withFieldId(fields: readonly TemplateField[], fieldId: string, nextId: string): TemplateField[] | null {
  const id = nextId.trim();
  if (!isPublicFieldId(id)) return null;
  if (fields.some((f) => f.id === id && f.id !== fieldId)) return null;
  return fields.map((f) => (f.id === fieldId ? { ...f, id } : f));
}

async function saveFields(label: string, change: (fields: TemplateField[]) => TemplateField[] | null): Promise<boolean> {
  const comp = activeCompIdNow();
  if (!comp) return false;
  const next = change(mirrorAuthoredFields(comp));
  if (!next) return false;
  const res = await edit(label, { type: 'setCompositionSettings', comp, patch: { templateFields: JSON.stringify(next) } });
  return res.ok;
}

export function removeAuthoredFieldEdit(fieldId: string): Promise<boolean> {
  return saveFields('Remove Template Field', (fields) => withoutField(fields, fieldId));
}

export function renameAuthoredFieldEdit(fieldId: string, label: string): Promise<boolean> {
  return saveFields('Rename Template Field', (fields) => withFieldLabel(fields, fieldId, label));
}

/** False when the id is rejected (collision / not a public slug) or the edit failed. */
export function renameAuthoredFieldIdEdit(fieldId: string, nextId: string): Promise<boolean> {
  return saveFields('Change Template Input Id', (fields) => withFieldId(fields, fieldId, nextId));
}

// ── Expose as field (B4 round 5) ──────────────────────────────────────

/** Layers that show a source: a MEDIA slot (templateAuthoring.ts `inferFieldForNode`'s kinds). */
const SLOT_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'svg', 'precomp']);

/**
 * Expose `layerId` as a template field of the active composition — templateAuthoring.ts
 * `exposeNodeAsField` through the engine: the field is inferred from the layer as the mirror and the
 * engine state it (a text layer's Source Text, a layer that shows a source as a MEDIA slot, else its Fill
 * Color), a media slot is declared with its fit (`layer/slotFit`, contain) and — the first time — its
 * current box captured as the authored slot rect (`layer/slotWidth|slotHeight`: re-filling must never
 * compound), and the manifest is replaced (`setCompositionSettings.templateFields`), ONE undo entry.
 * Re-exposing the same target keeps its id. Resolves to the field, or null when the layer has nothing
 * exposable or the engine refused.
 */
export async function exposeLayerAsFieldEdit(layerId: string, seconds: number = getTime()): Promise<TemplateField | null> {
  const comp = activeCompIdNow();
  const m = documentMirror();
  const layer = m.layer(layerId);
  if (!comp || !layer) return null;
  // The slot rect's Width / Height resolve on the layer's property tree.
  await m.loadTree(layerId);
  const label = layer.name || 'Field';
  const existing = mirrorAuthoredFields(comp);
  const id = uniqueFieldId(slugFieldId(label) || 'input', new Set(existing.map((f) => f.id)));
  const cmds: Command[] = [];
  let field: TemplateField;
  if (layer.kind === 'text') {
    const v = (await propertyValuesAt(layerId, ['text/sourceText'], seconds)).get('text/sourceText');
    field = {
      id, label, kind: 'text', group: 'Text',
      default: v?.kind === 'textDocument' ? v.value.text : '',
      target: { nodeId: layerId, componentType: 'Text', prop: 'content' },
    };
  } else if (SLOT_KINDS.has(layer.kind)) {
    const slot = await propertyValuesAt(layerId, ['layer/slotWidth'], seconds);
    cmds.push({ type: 'setProperty', prop: { layer: layerId, path: 'layer/slotFit' }, value: { kind: 'choice', value: 'contain' } });
    if (!((numbersOfValue(slot.get('layer/slotWidth'))[0] ?? 0) > 0)) {
      // Capture the placeholder's box as the slot rect NOW, while it is still the authored design.
      const wRef = trackRef(layerId, 'width');
      const hRef = trackRef(layerId, 'height');
      const box = await propertyValuesAt(layerId, [wRef?.ref.path, hRef?.ref.path].filter((x): x is string => !!x), seconds);
      const w = wRef ? (numbersOfValue(box.get(wRef.ref.path))[0] ?? 0) / apiUnitFactor('width') : 0;
      const h = hRef ? (numbersOfValue(box.get(hRef.ref.path))[0] ?? 0) / apiUnitFactor('height') : 0;
      if (w > 0 && h > 0) {
        cmds.push(
          { type: 'setProperty', prop: { layer: layerId, path: 'layer/slotWidth' }, value: { kind: 'scalar', value: w } },
          { type: 'setProperty', prop: { layer: layerId, path: 'layer/slotHeight' }, value: { kind: 'scalar', value: h } },
        );
      }
    }
    const source = layer.source ? m.item(layer.source) : undefined;
    field = {
      id, label, kind: 'media', group: 'Media', fit: 'contain',
      default: source?.mediaUrl ?? '',
      target: { nodeId: layerId, componentType: 'Transform', prop: 'src' },
    };
  } else {
    const r = trackRef(layerId, 'layer/fill');
    if (!r) return null;
    const v = (await propertyValuesAt(layerId, [r.ref.path], seconds)).get(r.ref.path);
    field = {
      id, label, kind: 'color', group: 'Colours',
      default: v?.kind === 'color' ? channelsToHex(v.value) : '#000000',
      target: { nodeId: layerId, componentType: 'Style', prop: 'fill' },
    };
  }
  const prior = existing.find((f) => f.target.nodeId === field.target.nodeId && f.target.prop === field.target.prop);
  const next = prior ? { ...field, id: prior.id } : field;
  cmds.push({ type: 'setCompositionSettings', comp, patch: { templateFields: JSON.stringify([...existing.filter((f) => f.id !== next.id), next]) } });
  const res = await edit('Expose Template Field', cmds);
  return res.ok ? next : null;
}
