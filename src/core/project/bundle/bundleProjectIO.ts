/**
 * bundleProjectIO — the app-level bridge between the live engines and a `.motion`
 * directory bundle.
 *
 * `projectDocumentIO` captures/restores the full `EditorDocument` from the
 * engines; `BundleRepository` writes/reads that document as a chunked bundle.
 * This module joins the two so the save/open path can persist a directory bundle
 * instead of a single blob, WITHOUT `ProjectManager` learning about the bundle
 * format (it stays document-agnostic).
 *
 * Gated by `LOCAL_FIRST` at the call site — while the flag is off, the existing
 * single-file + cloud-autosave path is untouched.
 */

import {   type EditorDocument } from '@core/api/cloudDocument';
import {  recordProjectSaved } from '@core/localIndex/indexWriter';
import { BundleRepository } from './BundleRepository';
import { ProjectBundleService } from './ProjectBundleService';
import type { VersionEntry, VersionKind } from './VersionStore';
import { detectBundleFs } from './bundleFsEnv';
import { liveDocument, saveLiveDocument } from '@core/project/liveDocument';

let shared: BundleRepository | null = null;
let sharedService: ProjectBundleService | null = null;

/** The process-wide repository, bound to the detected environment FS. */
export function getBundleRepository(): BundleRepository {
  return (shared ??= new BundleRepository(detectBundleFs()));
}

/** The process-wide bundle service (doc + versions + assets + AI). */
export function getProjectBundleService(): ProjectBundleService {
  return (sharedService ??= new ProjectBundleService(detectBundleFs()));
}

/** Test seam: swap the repository (e.g. an in-memory one). */
export function setBundleRepository(repo: BundleRepository | null): void {
  shared = repo;
}

/** A path that names a `.motion` bundle (directory), by convention. */
export function isBundlePath(path: string): boolean {
  return path.endsWith('.motion');
}

/** True when a bundle already exists at `root`. */
export async function hasProjectBundle(root: string, repo = getBundleRepository()): Promise<boolean> {
  return repo.has(root);
}

/** Capture the live document and save it, also recording a version snapshot. */
export async function saveProjectBundleVersion(
  root: string,
  kind: VersionKind,
  label?: string,
  svc = getProjectBundleService(),
): Promise<void> {
  // The engine writes the bundle (chunks, footage, manifest last; dirty
  // clears) and hands back the document it wrote; the page records only the
  // version snapshot beside it.
  await saveLiveDocument(root, { copy: false, format: 'bundle' });
  const saved = await liveDocument();
  await svc.snapshotVersion(root, saved, { kind, ...(label != null ? { label } : {}) });
  await recordProjectSaved(root, saved);
}

/** List a bundle's version history (newest first). */
export function listProjectVersions(root: string, svc = getProjectBundleService()): Promise<VersionEntry[]> {
  return svc.listVersions(root);
}

/**
 * A saved bundle version's document (null when the version is gone). The caller
 * lands it through the engine (`restoreDocument`: one undoable entry, B3z).
 */
export async function readProjectVersion(
  root: string,
  rev: number,
  svc = getProjectBundleService(),
): Promise<EditorDocument | null> {
  return (await svc.restoreVersion(root, rev)) ?? null;
}

/**
 * Whether a native `.motion` bundle picker exists in this build at all.
 *
 * Separate from `chooseBundleDir` because that call cannot distinguish its two
 * nulls: "the user cancelled" and "there is no folder picker here". The Open
 * command treated both as "fall through to the file dialog", so cancelling the
 * folder picker on the desktop immediately opened a SECOND dialog — cancel has
 * to mean cancel.
 */
export function bundleDirPickerAvailable(): boolean {
  const bridge = typeof window !== 'undefined' ? window.motionEditor : undefined;
  return typeof bridge?.project?.openBundleDir === 'function';
}

/**
 * Prompt for a `.motion` bundle directory to open (desktop only). Returns the
 * chosen path, or null if cancelled / not on desktop — check
 * `bundleDirPickerAvailable()` first when you need to tell those apart. The
 * caller then hands the path to `ProjectManager.openPath`, which routes to the
 * bundle loader.
 */
export async function chooseBundleDir(): Promise<string | null> {
  const bridge = typeof window !== 'undefined' ? window.motionEditor : undefined;
  if (!bridge?.project?.openBundleDir) return null;
  return bridge.project.openBundleDir();
}
