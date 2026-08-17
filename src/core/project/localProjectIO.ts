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
  PortableMotionError,
  type UnpackResult,
} from './portableMotion';
import { DocumentVersionError } from './migrations';
import { findMissingAssets, relinkNodeSrc, type MissingAssetRef } from './missingAssets';
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
}) => Promise<{ createWritable: () => Promise<{ write: (d: BufferSource) => Promise<void>; close: () => Promise<void> }> }>;

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

/** Capture the live project and write a portable `.motion` file. */
export async function saveToComputer(name = suggestedName()): Promise<LocalSaveResult> {
  try {
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

function materializeAssets(unpacked: UnpackResult): { document: EditorDocument; missing: MissingAssetRef[] } {
  const doc = structuredClone(unpacked.document);
  for (const a of unpacked.assets) {
    const url = URL.createObjectURL(new Blob([a.bytes as BlobPart], { type: a.mime }));
    const packaged = `assets/${a.fileName}`;
    for (const node of doc.scene?.nodes ?? []) {
      for (const c of node.components) {
        const src = (c.props as Record<string, unknown>).src;
        if (src === packaged) (c.props as Record<string, unknown>).src = url;
      }
    }
  }
  return { document: doc, missing: findMissingAssets(doc) };
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

/** Open a packed `.motion` / legacy JSON file into the live editor. */
export async function openLocalMotionFile(): Promise<LocalOpenResult> {
  try {
    const picked = await pickLocalFile();
    if (!picked) return { status: 'cancelled', missing: [] };
    const unpacked = unpackPortableMotion(picked.bytes);
    const { document, missing } = materializeAssets(unpacked);
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

/** Apply a relink (new blob/http src) to the LIVE document via capture/restore. */
export function relinkLiveAsset(nodeId: string, src: string): boolean {
  const doc = captureDocument();
  if (!relinkNodeSrc(doc, nodeId, src)) return false;
  restoreDocument(doc);
  bumpScene();
  return true;
}
