/**
 * Save to Computer / Open local `.motion` — portable file I/O that does NOT
 * go through the cloud FileManager adapter.
 *
 * Cloud Save As stays on the dashboard. This path packs the canonical
 * EditorDocument into a `.motion` zip (bundle chunks + assets/) and writes it
 * via the File System Access API, Electron's save dialog, or a download
 * fallback. Opening reverses that, migrates, and reports missing assets so the
 * caller can offer a relink instead of a blank layer.
 */

import { captureDocument, restoreDocument } from '@core/api/cloudDocument';
import { getProjectManager } from '@core/services/coreServices';
import { downloadBlob } from '@core/export/exportManager';
import { bumpScene } from '@stores/sceneStore';
import { baselineProjectHistory, afterProjectLoaded } from '@core/project/projectSession';
import {
  embedLiveAssets,
  packPortableMotion,
  unpackPortableMotion,
  materializePortableAssets,
  PortableMotionError,
} from './portableMotion';
import { DocumentVersionError } from './migrations';
import type { MissingAssetRef } from './missingAssets';
import type { EditorDocument } from '@core/api/cloudDocument';

export type LocalSaveStatus = 'saved' | 'cancelled' | 'failed';

export interface LocalSaveResult {
  status: LocalSaveStatus;
  path?: string;
  error?: string;
  skipped?: MissingAssetRef[];
}

export interface LocalOpenResult {
  status: 'opened' | 'cancelled' | 'failed';
  name?: string;
  missing: MissingAssetRef[];
  error?: string;
}

function stem(name: string): string {
  return name.replace(/\.(motion|json|zip)$/i, '') || 'Untitled';
}

function suggestedName(): string {
  return getProjectManager().getState().current?.name || 'Untitled';
}

type SavePicker = (opts: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
  // `write` is typed to what THIS file passes — a Uint8Array — rather than the
  // spec's `BufferSource`. Under TS 5.7 a bare Uint8Array is
  // `Uint8Array<ArrayBufferLike>` and no longer satisfies `BufferSource`, and
  // this is a local shape describing one call site, not the DOM lib's contract.
}) => Promise<{ createWritable: () => Promise<{ write: (d: Uint8Array) => Promise<void>; close: () => Promise<void> }> }>;

async function writeViaFilePicker(bytes: Uint8Array, filename: string): Promise<string | null> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker !== 'function') return null;
  try {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description: 'Premation Project', accept: { 'application/zip': ['.motion'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return filename;
  } catch (err) {
    // AbortError = user cancelled.
    if (err instanceof DOMException && err.name === 'AbortError') return '';
    throw err;
  }
}

async function writeViaElectron(bytes: Uint8Array, filename: string): Promise<string | null> {
  const bridge = window.motionEditor;
  if (!bridge?.project?.chooseSavePath || !bridge.file?.writeBytes) return null;
  const path = await bridge.project.chooseSavePath(filename);
  if (!path) return '';
  await bridge.file.writeBytes(path, bytes);
  return path;
}

/**
 * F2: the ENGINE owns the document — it packs the zip itself (the page holds
 * only a mirror, so there is nothing here to capture). Desktop only: the engine
 * writes to a path, so the native save dialog picks one.
 */
async function saveToComputerThroughEngine(filename: string): Promise<LocalSaveResult> {
  const choose = window.motionEditor?.project?.chooseSavePath;
  if (!choose) return { status: 'failed', error: 'Saving a portable copy needs the desktop app.' };
  const path = await choose(filename);
  if (!path) return { status: 'cancelled' };
  await getProjectManager().snapshotPortableTo(path);
  return { status: 'saved', path, skipped: [] };
}

/** Capture the live project and write a portable `.motion` file. */
export async function saveToComputer(name = suggestedName()): Promise<LocalSaveResult> {
  try {
    if (getProjectManager().engineOwned) return await saveToComputerThroughEngine(`${stem(name)}.motion`);
    const captured = captureDocument();
    const { document, assets, skipped } = await embedLiveAssets(captured);
    const bytes = packPortableMotion(document, assets);
    const filename = `${stem(name)}.motion`;

    const viaPicker = await writeViaFilePicker(bytes, filename);
    if (viaPicker === '') return { status: 'cancelled' };
    if (viaPicker) return { status: 'saved', path: viaPicker, skipped };

    const viaElectron = await writeViaElectron(bytes, filename);
    if (viaElectron === '') return { status: 'cancelled' };
    if (viaElectron) return { status: 'saved', path: viaElectron, skipped };

    downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), filename);
    return { status: 'saved', path: filename, skipped };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Could not save the project.',
    };
  }
}

function installDocument(doc: EditorDocument, name: string): void {
  restoreDocument(doc);
  getProjectManager().adopt(name, null);
  baselineProjectHistory('Open');
  bumpScene();
  afterProjectLoaded();
}

async function pickLocalFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const bridge = window.motionEditor;
  if (bridge?.project?.chooseSavePath && bridge.file?.readBytes && bridge.project.open) {
    // Native open dialog returns text today; prefer a file picker in the renderer
    // so a zip is not decoded as UTF-8. Fall through to <input> when that's all
    // we have.
  }
  return pickViaInput();
}

function pickViaInput(): Promise<{ name: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.motion,.json,application/zip,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      resolve({ name: file.name, bytes: buf });
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * F2: the ENGINE owns the document — it opens the zip itself (openProject of a
 * portable `.motion`: chunks decoded, footage unpacked where the engine can
 * read it). The page never sees the bytes; the copy opens untitled, as below.
 * Desktop only: the engine reads a path, so the native dialog picks one.
 */
async function openThroughEngine(): Promise<LocalOpenResult> {
  const choose = window.motionEditor?.project?.chooseOpenPath;
  if (!choose) return { status: 'failed', missing: [], error: 'Opening a portable copy needs the desktop app.' };
  const path = await choose();
  if (!path) return { status: 'cancelled', missing: [] };
  const name = stem(path.replace(/^.*[\\/]/, ''));
  const opened = await getProjectManager().openPortable(path, name);
  if (!opened) return { status: 'failed', missing: [], error: 'Could not open that project.' };
  // Missing footage is reported by id (openProject.missingItems); the Assets
  // panel shows those items as offline for relink.
  return { status: 'opened', name, missing: [] };
}

/** Open a packed `.motion` / legacy JSON file into the live editor. */
export async function openLocalMotionFile(): Promise<LocalOpenResult> {
  try {
    if (getProjectManager().engineOwned) return await openThroughEngine();
    const picked = await pickLocalFile();
    if (!picked) return { status: 'cancelled', missing: [] };
    const unpacked = unpackPortableMotion(picked.bytes);
    const { document, missing } = materializePortableAssets(unpacked);
    installDocument(document, stem(picked.name));
    return { status: 'opened', name: stem(picked.name), missing };
  } catch (err) {
    if (err instanceof PortableMotionError || err instanceof DocumentVersionError) {
      return { status: 'failed', missing: [], error: err.message };
    }
    return {
      status: 'failed',
      missing: [],
      error: err instanceof Error ? err.message : 'Could not open that project.',
    };
  }
}
