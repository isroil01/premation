/**
 * Authored template-field edits through the engine API (B3): the manifest
 * lives on the composition (`CompSettings.templateFields`, JSON), and
 * `setCompositionSettings.templateFields` replaces it as one undoable entry.
 * The list is read from the document mirror (B4) and transformed here.
 */
import { edit } from '@core/engine/uiEdits';
import { isPublicFieldId } from '@core/automation/fieldIds';
import type { TemplateField } from '@core/template/templateTypes';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';

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
