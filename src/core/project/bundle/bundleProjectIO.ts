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

import { captureDocument, restoreDocument } from '@core/api/cloudDocument';
import { baselineHistory } from '@stores/historyStore';
import { BundleRepository } from './BundleRepository';
import { ProjectBundleService } from './ProjectBundleService';
import type { VersionEntry, VersionKind } from './VersionStore';
import { detectBundleFs } from './bundleFsEnv';

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

/** Capture the live document and persist it to the bundle at `root`. */
export async function saveProjectBundle(root: string, repo = getBundleRepository()): Promise<void> {
  await repo.save(root, captureDocument());
}

/**
 * Load the bundle at `root` into the engines. Returns false (restoring nothing)
 * when there is no bundle there, so the caller can fall back to a single-file
 * open.
 */
export async function openProjectBundle(root: string, repo = getBundleRepository()): Promise<boolean> {
  const doc = await repo.load(root);
  if (!doc) return false;
  restoreDocument(doc);
  // The loaded document IS the baseline. Without this, undo's "before" is still
  // the seeded starter scene from boot, so one Ctrl+Z replaces the project the
  // user just opened.
  baselineHistory('Open');
  return true;
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
  await svc.save(root, captureDocument(), { version: { kind, ...(label != null ? { label } : {}) } });
}

/** List a bundle's version history (newest first). */
export function listProjectVersions(root: string, svc = getProjectBundleService()): Promise<VersionEntry[]> {
  return svc.listVersions(root);
}

/** Restore a specific version of a bundle into the live engines. Returns false if unknown. */
export async function restoreProjectVersion(
  root: string,
  rev: number,
  svc = getProjectBundleService(),
): Promise<boolean> {
  const doc = await svc.restoreVersion(root, rev);
  if (!doc) return false;
  restoreDocument(doc);
  baselineHistory(`Restored v${rev}`);
  return true;
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
