/**
 * Authored template-field edits through the engine API: the manifest lives on
 * the comp root (`__templateFields`), which `setCompositionSettings.templateFields`
 * writes as one undoable entry. The list transforms are the pure helpers in
 * templateAuthoring.ts; this file only sends the result.
 */
import { edit } from '@core/engine/uiEdits';
import { activeCompRootId } from '@core/scene/activeComp';
import {
  readAuthoredFields, withoutField, withFieldLabel, withFieldId,
} from '@core/template/templateAuthoring';
import type { TemplateField } from '@core/template/templateTypes';

async function saveFields(label: string, rootId: string, fields: readonly TemplateField[]): Promise<boolean> {
  const res = await edit(label, {
    type: 'setCompositionSettings',
    comp: rootId,
    patch: { templateFields: JSON.stringify(fields) },
  });
  return res.ok;
}

export function removeAuthoredFieldEdit(fieldId: string): Promise<boolean> {
  const rootId = activeCompRootId();
  return saveFields('Remove Template Field', rootId, withoutField(readAuthoredFields(rootId), fieldId));
}

export function renameAuthoredFieldEdit(fieldId: string, label: string): Promise<boolean> {
  const rootId = activeCompRootId();
  return saveFields('Rename Template Field', rootId, withFieldLabel(readAuthoredFields(rootId), fieldId, label));
}

/** False when the id is rejected (collision / not a public slug) or the edit failed. */
export async function renameAuthoredFieldIdEdit(fieldId: string, nextId: string): Promise<boolean> {
  const rootId = activeCompRootId();
  const next = withFieldId(readAuthoredFields(rootId), fieldId, nextId);
  if (!next) return false;
  return saveFields('Change Template Input Id', rootId, next);
}
