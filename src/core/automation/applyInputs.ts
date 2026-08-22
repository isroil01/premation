/**
 * Apply named template inputs to a captured EditorDocument.
 *
 * This is the automation write path: n8n sends `{ character, caption, … }` and
 * this resolves those names onto the authored TemplateFields, then writes the
 * values into the document JSON. It does not touch the live scene graph, so
 * the same function runs in the editor (preview) and on the server (render).
 *
 * Motion stays put. Keyframes live on Transform properties; `src` / `content`
 * are different props. Replacing a PNG does not drop Position/Scale/Rotation/
 * Opacity tracks — that is the whole "create once, automate many times" deal.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
import type { SceneNode } from '@core/types';
import type { TemplateField } from '@core/template/templateTypes';
import { isAllowedAssetUrl } from './assetUrls';

const FIELDS_PROP = '__templateFields';

export type TemplateInputValue = string | number;

export interface ApplyInputsResult {
  document: EditorDocument;
  applied: string[];
  errors: ApplyInputError[];
}

export interface ApplyInputError {
  field: string;
  message: string;
}

/** Fields authored onto a captured document (empty when none). */
export function readFieldsFromDocument(doc: EditorDocument): TemplateField[] {
  const nodes = doc.scene?.nodes;
  if (!Array.isArray(nodes)) return [];
  for (const node of nodes) {
    for (const c of node.components ?? []) {
      const v = (c.props as Record<string, unknown>)[FIELDS_PROP];
      if (Array.isArray(v)) return v as TemplateField[];
    }
  }
  return [];
}

function cloneDoc(doc: EditorDocument): EditorDocument {
  return structuredClone(doc);
}

function findNode(nodes: SceneNode[], id: string): SceneNode | undefined {
  return nodes.find((n) => n.id === id);
}

function writeProp(node: SceneNode, componentType: string, prop: string, value: unknown): boolean {
  const comp = node.components.find((c) => c.type === componentType);
  if (!comp) return false;
  (comp.props as Record<string, unknown>)[prop] = value;
  return true;
}

function validateValue(field: TemplateField, value: TemplateInputValue): string | null {
  if (field.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `Input "${field.id}" must be a number.`;
    }
    return null;
  }
  if (typeof value !== 'string') {
    return `Input "${field.id}" must be a string.`;
  }
  if ((field.kind === 'image' || field.kind === 'media') && value.startsWith('http')) {
    if (!isAllowedAssetUrl(value)) {
      return `Input "${field.id}" is not a public http(s) URL.`;
    }
  }
  return null;
}

/**
 * Write `inputs` onto a copy of `doc`. Unknown keys and missing required
 * fields become errors; successful writes are listed in `applied`.
 *
 * `fields` defaults to the document's authored manifest. Pass an explicit list
 * when the API row stores the contract separately from the snapshot.
 */
export function applyTemplateInputs(
  doc: EditorDocument,
  inputs: Record<string, TemplateInputValue>,
  fields: readonly TemplateField[] = readFieldsFromDocument(doc),
): ApplyInputsResult {
  const next = cloneDoc(doc);
  const nodes = next.scene?.nodes ?? [];
  const errors: ApplyInputError[] = [];
  const applied: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));

  for (const key of Object.keys(inputs)) {
    if (!byId.has(key)) {
      errors.push({ field: key, message: `Unknown input "${key}".` });
    }
  }

  for (const field of fields) {
    if (!(field.id in inputs)) continue;
    const value = inputs[field.id]!;
    const invalid = validateValue(field, value);
    if (invalid) {
      errors.push({ field: field.id, message: invalid });
      continue;
    }
    const node = findNode(nodes, field.target.nodeId);
    if (!node) {
      errors.push({
        field: field.id,
        message: `Layer for input "${field.id}" is missing from the template.`,
      });
      continue;
    }
    if (!writeProp(node, field.target.componentType, field.target.prop, value)) {
      errors.push({
        field: field.id,
        message: `Could not write input "${field.id}" — component ${field.target.componentType} is gone.`,
      });
      continue;
    }
    applied.push(field.id);
  }

  return { document: next, applied, errors };
}

/** True when every authored field either has an input or a usable default. */
export function missingRequiredInputs(
  fields: readonly TemplateField[],
  inputs: Record<string, TemplateInputValue>,
): string[] {
  return fields
    .filter((f) => f.kind === 'image' || f.kind === 'media')
    .filter((f) => {
      const v = inputs[f.id];
      if (typeof v === 'string' && v.trim()) return false;
      if (typeof f.default === 'string' && f.default.startsWith('http')) return false;
      return true;
    })
    .map((f) => f.id);
}
