/**
 * The local index's WRITER — the half that was missing.
 *
 * The index (SQLite on desktop, in-memory in the browser) shipped with a full
 * read/write API, an IPC bridge, tests, and ZERO production writers: nothing
 * ever called `upsertProject`, so `listProjects()` was forever `[]` and every
 * surface that could have been built on it (the project browser, recents with
 * facts, recovery) had nothing to read. This module is the one place rows are
 * written, called from the bundle save/open path in bundleProjectIO.
 *
 * Row identity is the BUNDLE PATH: bundles are directories the user places,
 * so the path is the stable name for "this project" across sessions, and the
 * one join key the MRU (`RecentProjects`) shares. Facts come from
 * `deriveProjectFacts` on the document being saved/opened — the index stays a
 * rebuildable cache, never an authority (see types.ts).
 *
 * Failures are swallowed after a console warning: an index write must never
 * break a SAVE. A save that lands on disk but misses the index costs a stale
 * card; a save aborted by an index hiccup costs work.
 */

import { getLocalIndex } from './LocalIndex';
import { deriveProjectFacts } from './projectFacts';
import type { EditorDocument } from '@core/api/cloudDocument';
import type { ProjectIndexRow } from './types';

/** The project name a path implies: the basename, `.motion` stripped. */
export function projectNameFromPath(bundlePath: string): string {
  const base = bundlePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? bundlePath;
  return base.replace(/\.motion$/i, '') || bundlePath;
}

async function upsert(
  bundlePath: string,
  doc: EditorDocument,
  stamp: { openedAt?: number },
): Promise<void> {
  try {
    const index = getLocalIndex();
    const prev = await index.getProject(bundlePath);
    const facts = deriveProjectFacts(doc);
    const now = Date.now();
    const row: ProjectIndexRow = {
      id: bundlePath,
      bundlePath,
      name: projectNameFromPath(bundlePath),
      ...facts,
      // rev bumps on SAVES; an open re-records the same content.
      rev: (prev?.rev ?? 0) + (stamp.openedAt === undefined ? 1 : 0),
      updatedAt: stamp.openedAt === undefined ? now : (prev?.updatedAt ?? now),
      ...(stamp.openedAt !== undefined
        ? { openedAt: stamp.openedAt }
        : prev?.openedAt !== undefined
          ? { openedAt: prev.openedAt }
          : {}),
      // The row exists, so the bundle does — clear any stale missing flag.
      missing: false,
      ...(prev?.thumbHash !== undefined ? { thumbHash: prev.thumbHash } : {}),
    };
    await index.upsertProject(row);
  } catch (err) {
    console.warn('[localIndex] index write failed (save/open unaffected):', err);
  }
}

/** Record a save of `doc` to the bundle at `bundlePath`. */
export function recordProjectSaved(bundlePath: string, doc: EditorDocument): Promise<void> {
  return upsert(bundlePath, doc, {});
}

/** Record that the bundle at `bundlePath` was opened, `doc` being its content. */
export function recordProjectOpened(bundlePath: string, doc: EditorDocument): Promise<void> {
  return upsert(bundlePath, doc, { openedAt: Date.now() });
}

/** Attach a rendered thumbnail's cache hash to a project's row. */
export async function recordProjectThumb(bundlePath: string, thumbHash: string): Promise<void> {
  try {
    const index = getLocalIndex();
    const prev = await index.getProject(bundlePath);
    if (!prev) return; // no row yet — the next save will carry facts; skip.
    await index.upsertProject({ ...prev, thumbHash });
  } catch (err) {
    console.warn('[localIndex] thumb write failed:', err);
  }
}
