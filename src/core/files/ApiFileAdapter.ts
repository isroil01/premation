/**
 * ApiFileAdapter — routes the FileManager (Open/Save) to the motion-back cloud.
 *
 * `path` is a backend project id. The editor's Save path serializes the
 * full EditorDocument (see projectDocumentIO), so this adapter is a pure
 * transport: read fetches the document, write PUTs it. It used to hand back
 * only `doc.scene` and restore animation/comp as a hidden side effect, because
 * the IO layer spoke scene-only.
 */

import type { FileAdapter, StoredFile, OpenOptions } from './FileManager';
import { api, isAuthenticated } from '@core/api/client';
import { captureDocument, type EditorDocument } from '@core/api/cloudDocument';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';

export class ApiFileAdapter implements FileAdapter {
  readonly kind = 'api' as const;

  /**
   * Cloud projects are chosen from the dashboard, not a file picker.
   *
   * This used to ignore the picker and return whichever project was updated
   * most recently — so "Open…" silently loaded the wrong project. Returning
   * null lets the caller route to the dashboard instead; opening the wrong
   * document is worse than opening none.
   */
  async open(_opts?: OpenOptions): Promise<StoredFile | null> {
    return null;
  }

  /**
   * Load a project by id and hand the WHOLE document back as JSON.
   *
   * It used to return only `doc.scene` and restore animation/comp as a side
   * effect, because the ProjectManager's IO spoke scene-only. The IO now takes
   * the full document (see projectDocumentIO), so the adapter can just be a
   * transport — no hidden restore, one restore path for cloud and local files.
   */
  async read(path: string): Promise<string | null> {
    if (!isAuthenticated()) return null;
    try {
      const project = await api.getProject(path);
      const doc = project.document as EditorDocument | null | undefined;
      // A freshly-created project has no real scene yet: the backend seeds
      // `emptyDocument()` with `scene.nodes: []`, so we must treat an empty node
      // list the same as a missing scene. Seed a default composition root (so the
      // Scene panel shows "Composition 1" and inserted layers have a parent),
      // while still restoring the doc's default comp/animation. Only a genuinely
      // missing project (getProject throws) should error.
      if (!doc?.scene?.nodes?.length) {
        const seeded: EditorDocument = {
          ...doc,
          version: doc?.version ?? '1.0.0',
          scene: sceneProjectIO.createEmpty('Untitled'),
          animation: doc?.animation ?? { tracks: {}, expressions: {} },
        };
        return JSON.stringify(seeded);
      }
      return JSON.stringify(doc);
    } catch {
      return null;
    }
  }

  /** Persist the document the ProjectManager captured. */
  async write(path: string, contents: string): Promise<void> {
    if (!isAuthenticated()) throw new Error('Sign in to save to the cloud');
    await api.updateProject(path, { document: JSON.parse(contents) as EditorDocument });
  }

  /** Create a new cloud project and return its id as the "path". */
  async chooseSavePath(defaultName: string): Promise<string | null> {
    if (!isAuthenticated()) return null;
    const name = defaultName.replace(/\.(motion|json)$/i, '');
    const project = await api.createProject(name, captureDocument());
    return project.id;
  }

  async list(): Promise<string[]> {
    if (!isAuthenticated()) return [];
    const projects = (await api.listProjects({ limit: 100 }).catch(() => null))?.items ?? [];
    return projects.map((p) => p.id);
  }

  async exists(path: string): Promise<boolean> {
    if (!isAuthenticated()) return false;
    try {
      await api.getProject(path);
      return true;
    } catch {
      return false;
    }
  }

}
