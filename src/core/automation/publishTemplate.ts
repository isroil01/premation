/**
 * Publish the current composition as an automation template.
 *
 * The canonical project (EditorDocument + authored TemplateFields) is what
 * the API stores. n8n later sends named inputs; it never sees layer ids.
 */

import { api, isAuthenticated } from '@core/api/client';
import { captureDocument } from '@core/api/cloudDocument';
import { readAuthoredFields } from '@core/template/templateAuthoring';
import { useCompositionStore } from '@stores/compositionStore';
import { getCloudProjectId } from '@stores/cloudProjectStore';
import { isPublicFieldId } from './fieldIds';

export interface PublishTemplateResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export async function publishCurrentTemplate(name: string, description?: string): Promise<PublishTemplateResult> {
  if (!isAuthenticated()) {
    return { ok: false, error: 'Sign in to save an automation template.' };
  }
  const fields = readAuthoredFields();
  if (!fields.length) {
    return { ok: false, error: 'Expose at least one input (character, video, caption…) first.' };
  }
  const bad = fields.filter((f) => !isPublicFieldId(f.id));
  if (bad.length) {
    return {
      ok: false,
      error: `Rename input ids to n8n-friendly slugs (e.g. character): ${bad.map((f) => f.id).join(', ')}`,
    };
  }
  const comp = useCompositionStore.getState().comp();
  try {
    const row = await api.publishAutomationTemplate({
      name: name.trim(),
      description,
      document: captureDocument(),
      inputs: fields.map((f) => ({
        id: f.id,
        label: f.label,
        kind: f.kind,
        required: f.kind === 'image' || f.kind === 'media',
      })),
      width: comp.width,
      height: comp.height,
      fps: comp.fps,
      durationSeconds: comp.durationSeconds,
      projectId: getCloudProjectId() ?? undefined,
    });
    return { ok: true, id: row.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not publish the template.' };
  }
}
