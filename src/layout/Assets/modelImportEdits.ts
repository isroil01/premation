/**
 * 3D model import through the engine (B4 round 8, the owner-write audit): the
 * glTF importer lays its layer tree (root null + mesh / node layers, the first
 * clip baked as keys, the model bytes on the root) into a fragment — no page
 * replica — and it lands as ONE `pasteLayers` in the active composition, the
 * root selected.
 */

import type { ModelImportResult } from '@core/scene/modelImport';
import type { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import { insertFragment, type InsertFrame } from '@/engine-client/insertFragment';
import { diskPathOf } from '@core/assets/local/diskPathOf';
import { runEngineJob } from '@core/engine/engineJobs';
import { edit } from '@core/engine/uiEdits';

/** Run `build` (buildGltfModel / buildModelFiles) as one engine entry. Null when it failed or the engine refused (toasted). */
export async function importModelEdit(
  label: string,
  build: (b: FragmentBuilder, frame: InsertFrame) => ModelImportResult,
): Promise<ModelImportResult | null> {
  let result: ModelImportResult | null = null;
  const ids = await insertFragment(label, (b, frame) => {
    result = build(b, frame);
    return result.rootId;
  });
  return ids && ids.length > 0 ? result : null;
}

/** The `modelImport` job's summary (kind_model_import.cpp). */
interface ModelImportJobSummary {
  glb: string;
  name: string;
  warnings: string[];
}

/** The file's extension, lower case without the dot. */
const extOf = (name: string): string => (name.split('.').pop() ?? '').toLowerCase();

/** What the importer does with one selection: the outcome and its toast line. */
export interface ModelSelectionOutcome {
  result: ModelImportResult;
  /** The model's file name (for the toast). */
  name: string;
  /** Converter notes (skins an FBX dropped, a texture it could not decode). */
  warnings: string[];
}

/**
 * Import one model selection (AE parity 4.7): the model plus its sidecars
 * (.bin, .mtl, textures), in any format the engine's importer converts —
 * .glb / .gltf (compressed geometry and textures included), .obj, .fbx,
 * .usda / .usdz.
 *
 * In the desktop app the files have disk paths: the engine's `modelImport`
 * job normalizes them into one plain .glb beside the project, the .glb is
 * imported as a project item (`importFiles`), and the layer tree references
 * that item (`modelAsset`) instead of carrying the bytes. Without paths (the
 * browser build, files made in the page) a glTF still imports the old way,
 * packed into the document; the other formats need the engine's converter.
 *
 * @throws Error with the message the toast shows.
 */
export async function importModelSelection(
  files: readonly File[],
  onProgress?: (fraction: number, message: string) => void,
): Promise<ModelSelectionOutcome> {
  const { ANY_MODEL_FILE_PATTERN, MODEL_FILE_PATTERN, buildGltfModel, buildModelFiles } = await import('@core/scene/modelImport');
  // The model first: the job converts files[0] with the rest as its sidecars.
  // A .gltf beats a .bin-less .glb only by order; a selection holds one model.
  const model = files.find((f) => ANY_MODEL_FILE_PATTERN.test(f.name));
  if (!model) throw new Error('Select a 3D model: .glb, .gltf, .obj, .fbx, .usda or .usdz (with its sidecar files, if it has them).');
  const paths = files.map((f) => diskPathOf(f));
  const ordered = [model, ...files.filter((f) => f !== model)];
  const orderedPaths = ordered.map((f) => paths[files.indexOf(f)]);

  if (orderedPaths.every((p): p is string => typeof p === 'string')) {
    const outcome = await runEngineJob<ModelImportJobSummary>(
      { kind: 'modelImport', value: { files: orderedPaths, outputFolder: '' } },
      { ...(onProgress ? { onProgress } : {}) },
    );
    if (outcome) {
      if (outcome.status !== 'done' || !outcome.result) {
        throw new Error(outcome.error?.message ?? (outcome.status === 'cancelled' ? 'cancelled' : 'the model could not be converted'));
      }
      const { glb, warnings } = outcome.result;
      const readBytes = window.motionEditor?.file?.readBytes;
      if (typeof readBytes !== 'function') throw new Error('the converted model could not be read back');
      const raw = (await readBytes(glb)) as Uint8Array | ArrayBuffer | null;
      if (!raw) throw new Error(`the converted model could not be read back (${glb})`);
      const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const bytes = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
      const imported = await edit(`Import ${model.name}`, {
        type: 'importFiles',
        files: [{ path: glb, asSequence: false, createComposition: false }],
      }, { quiet: true });
      const itemId = imported.ok ? (imported.value[0] as { items?: string[] } | undefined)?.items?.[0] : undefined;
      if (!itemId) throw new Error(imported.ok ? 'the engine did not take the model' : imported.error.message);
      const result = await importModelEdit(`Import ${model.name}`, (b, f) => buildGltfModel(b, f, bytes, model.name, { modelAsset: itemId }));
      if (!result) throw new Error('the engine did not take the model');
      return { result, name: model.name, warnings };
    }
  }

  // No disk paths (or an engine without the converter): glTF only, packed into the document.
  if (!MODEL_FILE_PATTERN.test(model.name)) {
    throw new Error(`.${extOf(model.name)} models are converted by the desktop app's engine; import the file from disk there, or export it as .glb.`);
  }
  const sources = await Promise.all(files.map(async (f) => ({
    name: f.name,
    // Present when the selection came from a folder drop; it is what lets
    // `textures/albedo.png` resolve as the path it actually is.
    ...(f.webkitRelativePath ? { path: f.webkitRelativePath } : {}),
    bytes: await f.arrayBuffer(),
  })));
  const result = await importModelEdit(`Import ${model.name}`, (b, f) => buildModelFiles(b, f, sources));
  if (!result) throw new Error('the engine did not take the model');
  return { result, name: model.name, warnings: [] };
}

/** The toast line for a finished import. */
export function modelImportMessage(o: ModelSelectionOutcome): { level: 'success' | 'warning'; message: string } {
  const { result } = o;
  const clip = result.clip
    ? ` · clip “${result.clip.name}” baked as keyframes (${result.clip.duration.toFixed(1)}s${result.clip.extraClips > 0 ? `, ${result.clip.extraClips} more clip${result.clip.extraClips === 1 ? '' : 's'} in file` : ''})`
    : '';
  const notes = [result.warning, ...o.warnings].filter((w): w is string => !!w);
  if (notes.length > 0) return { level: 'warning', message: `Imported “${o.name}” — ${notes.join(' · ')}` };
  return { level: 'success', message: `Imported “${o.name}” — ${result.layerCount} layer${result.layerCount === 1 ? '' : 's'}${clip}` };
}
