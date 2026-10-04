/**
 * Save to Computer / Open local `.motion` — portable file I/O that does NOT
 * go through the cloud FileManager adapter.
 *
 * The ENGINE owns the document, so it packs and unpacks the zip itself: Save
 * to Computer is `saveProject{format:'portable'}` (footage embedded), Open is
 * `openProject` of the file (chunks decoded, footage unpacked where the engine
 * can read it, the document migrated). The page never sees the bytes. Desktop
 * only: the engine reads and writes paths, so the native dialogs pick them.
 */

import { getProjectManager } from '@core/services/coreServices';
import type { MissingAssetRef } from './missingAssets';

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

/** Write a portable `.motion` copy of the live project where the user picks. */
export async function saveToComputer(name = suggestedName()): Promise<LocalSaveResult> {
  try {
    const choose = window.motionEditor?.project?.chooseSavePath;
    if (!choose) return { status: 'failed', error: 'Saving a portable copy needs the desktop app.' };
    const path = await choose(`${stem(name)}.motion`);
    if (!path) return { status: 'cancelled' };
    if (!(await getProjectManager().snapshotPortableTo(path))) {
      return { status: 'failed', error: 'Saving a portable copy needs the desktop app.' };
    }
    return { status: 'saved', path, skipped: [] };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Could not save the project.',
    };
  }
}

/** Open a packed `.motion` / legacy JSON file into the live editor (it opens untitled). */
export async function openLocalMotionFile(): Promise<LocalOpenResult> {
  try {
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
  } catch (err) {
    return {
      status: 'failed',
      missing: [],
      error: err instanceof Error ? err.message : 'Could not open that project.',
    };
  }
}
