/**
 * ApiFileAdapter — routes the FileManager (Open/Save) to the motion-back cloud.
 *
 * `path` is a backend project id. The editor's Save path serializes a scene-only
 * ProjectFile; this adapter augments it into a full EditorDocument (scene +
 * animation + comp) on write, and restores animation/comp as a side effect on
 * read — so cloud projects round-trip the whole document while the rest of the
 * app keeps speaking ProjectFile.
 */

import type { FileAdapter, StoredFile, OpenOptions } from './FileManager';
import { api, isAuthenticated } from '@core/api/client';
import { captureDocument, restoreDocument, type EditorDocument } from '@core/api/cloudDocument';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';

export class ApiFileAdapter implements FileAdapter {
  readonly kind = 'api' as const;

  /** Open the most recently updated cloud project (no native picker in-browser). */
  async open(_opts?: OpenOptions): Promise<StoredFile | null> {
    if (!isAuthenticated()) return null;
    const projects = await api.listProjects().catch(() => []);
    const latest = projects[0];
    if (!latest) return null;
    const contents = await this.read(latest.id);
    if (contents == null) return null;
    return { path: latest.id, name: latest.name, contents };
  }

  /** Load a project by id, restore anim/comp, and hand the scene back as JSON. */
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
          version: doc?.version ?? '1.0.0',
          scene: sceneProjectIO.createEmpty('Untitled'),
          animation: doc?.animation ?? { tracks: {}, expressions: {} },
          comp: doc?.comp,
        };
        restoreDocument(seeded);
        return JSON.stringify(seeded.scene);
      }
      // Side-effect: bring animation + comp back into the live engines.
      restoreDocument(doc);
      return JSON.stringify(doc.scene);
    } catch {
      return null;
    }
  }

  /** Persist: merge the scene ProjectFile with the current anim + comp. */
  async write(path: string, contents: string): Promise<void> {
    if (!isAuthenticated()) throw new Error('Sign in to save to the cloud');
    const full = this.mergeContents(contents);
    await api.updateProject(path, { document: full });
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
    const projects = await api.listProjects().catch(() => []);
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

  /** Combine an incoming scene ProjectFile string with live animation + comp. */
  private mergeContents(contents: string): EditorDocument {
    const full = captureDocument();
    try {
      const scene = JSON.parse(contents);
      if (scene && typeof scene === 'object' && Array.isArray(scene.nodes)) {
        full.scene = scene;
      }
    } catch {
      /* keep captured scene */
    }
    return full;
  }
}
