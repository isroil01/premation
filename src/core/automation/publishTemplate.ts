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
    const named = unrenderableAssetsMessage(err);
    if (named) return { ok: false, error: named };
    return { ok: false, error: err instanceof Error ? err.message : 'Could not publish the template.' };
  }
}

/**
 * Turn the server's `unrenderable_assets` refusal into something actionable.
 *
 * The backend now refuses to publish a document whose media it could not fetch
 * — footage imported from local storage carries a `blob:` src that means
 * nothing off this machine, and a template built on one used to render that
 * layer as nothing at all while reporting success.
 *
 * The refusal's top-level `message` says only that SOME layers are affected,
 * which in a project with thirty layers is not a thing anyone can act on. The
 * body also carries `layers: [{ layer, reason }]`, so name them. Without this
 * the new check trades a silent wrong render for an opaque error, which is not
 * obviously the better bargain.
 */
function unrenderableAssetsMessage(err: unknown): string | null {
  const body = (err as { body?: unknown })?.body;
  if (!body || typeof body !== 'object') return null;
  // Nest sends a thrown object flat on the body; some paths wrap it under
  // `message`. Accept either, the same way `readOnlyDetail` does in transport.
  const flat = body as { code?: string; layers?: unknown; message?: unknown };
  const nested = (typeof flat.message === 'object' ? flat.message : null) as
    | { code?: string; layers?: unknown }
    | null;
  const source = flat.code === 'unrenderable_assets' ? flat : nested?.code === 'unrenderable_assets' ? nested : null;
  if (!source || !Array.isArray(source.layers) || source.layers.length === 0) return null;

  const named = (source.layers as { layer?: string; reason?: string }[])
    .map((entry) => `“${entry.layer ?? 'A layer'}” — ${entry.reason ?? 'its source cannot be fetched'}`)
    .join('; ');
  return (
    `These layers would render empty, so the template was not published: ${named}. ` +
    'Re-import them from a public URL, or expose them as template inputs so an automation supplies them.'
  );
}
