/**
 * A composition's authored template fields over the document MIRROR (B4):
 * `CompSettings.templateFields` is the manifest as JSON (what
 * `setCompositionSettings.templateFields` writes). Pure.
 */

import type { CompSettings } from '@motion/engine-api';
import type { TemplateField } from '@core/template/templateTypes';

/** The authored fields in `settings` (empty when none or malformed). */
export function authoredFieldsOf(settings: Pick<CompSettings, 'templateFields'> | undefined): TemplateField[] {
  const json = settings?.templateFields;
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v as TemplateField[] : [];
  } catch {
    return [];
  }
}
