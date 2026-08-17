/**
 * ProjectManager — owns the project lifecycle: new / open / save / close, the
 * current project reference and the dirty flag.
 *
 * It orchestrates the pieces (ProjectService for (de)serialization, FileManager
 * for I/O, RecentProjects for the MRU) but stays decoupled from the actual
 * document: the scene/animation content is read and written through an injected
 * `ProjectDocumentIO`. That keeps this class free of any engine dependency — the
 * scene engine registers its IO later without ProjectManager changing.
 */

import type { VersionedDocument } from '@core/types';
import type { ProjectService } from '@core/persistence/ProjectService';
import type { FileManager } from '@core/files/FileManager';
import type { ProjectStorage } from '@core/persistence/ProjectStorage';
import type { RecentProjects } from '@core/project/RecentProjects';
import type { Logger } from '@core/logging/Logger';
import { getEventBus } from '@core/events/EventBus';

export interface ProjectRef {
  id: string;
  name: string;
  path: string | null;
}

export interface ProjectState {
  current: ProjectRef | null;
}

/**
 * What a save actually did.
 *
 * `save`/`saveAs` used to return a bare boolean, and `false` meant three
 * different things — no project open, the user cancelled the dialog, the write
 * threw. The one caller collapsed all three into a SUCCESS toast reading
 * "Saved" and then cleared the dirty flag and the crash-recovery snapshot, so a
 * failed write was indistinguishable from a good one and took the user's last
 * copy with it. Cancelling is not failing and failing is not saving; the type
 * says so now.
 */
export type SaveOutcome =
  | { status: 'saved'; ref: ProjectRef }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown };

/**
 * The project's name after a Save As: the file the user actually chose.
 *
 * `chooseSavePath` returns a FILE PATH for the local adapters and a backend
 * project ID for the cloud one, and an id is not a name — deriving one would
 * rename the project to a uuid. So the path only overrides the requested name
 * when it looks like a path: a directory separator, or a project extension.
 */
function nameFromSavePath(path: string, fallback: string): string {
  const looksLikePath = /[\\/]/.test(path) || /\.(motion|json)$/i.test(path);
  if (!looksLikePath) return fallback;
  const stem = (path.split(/[\\/]/).pop() ?? '').replace(/\.(motion|json)$/i, '').trim();
  return stem || fallback;
}

/** Bridge between the project file format and the live document (scene, etc.). */
/**
 * How the app turns its live state into a saveable document and back.
 *
 * Typed to `VersionedDocument`, not to any concrete shape: this was
 * `ProjectFile` (scene-only), so `Save` wrote the scene graph and nothing else
 * — every keyframe, comp setting and timeline edit was dropped on the floor.
 * The app registers `projectDocumentIO` (a full EditorDocument) at boot.
 */
export interface ProjectDocumentIO<T extends VersionedDocument = VersionedDocument> {
  createEmpty(name: string): T;
  capture(): T;
  restore(file: T): void;
}

/** Default IO — an empty document. The app replaces this at boot. */
const emptyDocumentIO: ProjectDocumentIO = {
  createEmpty: () => ({ version: '1.0.0' }),
  capture: () => ({ version: '1.0.0' }),
  restore: () => { /* no-op */ },
};

export interface ProjectManagerDeps {
  service: ProjectService;
  files: FileManager;
  recent: RecentProjects;
  logger?: Logger;
  io?: ProjectDocumentIO;
  /** How documents reach disk. Defaults to the legacy single-file blob. */
  storage?: ProjectStorage;
  now?: () => number;
  newId?: () => string;
}

export class ProjectManager {
  private state: ProjectState = { current: null };
  private io: ProjectDocumentIO;
  private readonly storage: ProjectStorage;
  private readonly listeners = new Set<(s: ProjectState) => void>();
  private readonly deps: Required<Omit<ProjectManagerDeps, 'logger' | 'io' | 'storage'>> & Pick<ProjectManagerDeps, 'logger'>;

  constructor(deps: ProjectManagerDeps) {
    this.io = deps.io ?? emptyDocumentIO;
    this.deps = {
      service: deps.service,
      files: deps.files,
      recent: deps.recent,
      logger: deps.logger,
      now: deps.now ?? (() => Date.now()),
      newId: deps.newId ?? (() => `proj_${Math.random().toString(36).slice(2, 10)}`),
    };
    // Default storage reproduces the legacy single-file behaviour exactly, so a
    // ProjectManager built without a `storage` dep is byte-for-byte unchanged.
    this.storage = deps.storage ?? {
      save: (path, doc) => this.deps.files.write(path, this.deps.service.serialize(doc)),
      load: async (path) => {
        const contents = await this.deps.files.read(path);
        return contents == null ? null : this.deps.service.parse(contents);
      },
    };
  }

  getState(): ProjectState { return this.state; }

  subscribe(listener: (s: ProjectState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Let the scene/document engine plug in its real capture/restore. */
  setDocumentIO(io: ProjectDocumentIO): void {
    this.io = io;
  }

  newProject(name = 'Untitled'): ProjectRef {
    const ref: ProjectRef = { id: this.deps.newId(), name, path: null };
    this.io.restore(this.io.createEmpty(name));
    this.state = { current: ref };
    this.emit();
    this.deps.logger?.info(`New project "${name}"`);
    getEventBus().emit('ProjectLoaded', { projectId: ref.id });
    return ref;
  }

  async open(): Promise<ProjectRef | null> {
    const picked = await this.deps.files.open({ extensions: ['motion', 'json'] });
    if (!picked) return null;
    return this.load(picked.contents, picked.name, picked.path);
  }

  async openPath(path: string): Promise<ProjectRef | null> {
    let file: VersionedDocument | null;
    try {
      file = await this.storage.load(path);
    } catch (err) {
      this.deps.logger?.error('Failed to open project', err);
      return null;
    }
    if (file == null) {
      this.deps.logger?.warn(`Project not found at ${path}`);
      return null;
    }
    return this.applyLoadedDoc(file, path.replace(/\.[^.]+$/, ''), path);
  }

  /** Open from an already-read string (the native Open dialog path). */
  private load(contents: string, name: string, path: string | null): ProjectRef | null {
    let file: VersionedDocument;
    try {
      file = this.deps.service.parse(contents);
    } catch (err) {
      this.deps.logger?.error('Failed to open project', err);
      return null;
    }
    return this.applyLoadedDoc(file, name, path);
  }

  /**
   * Become the current project after the document has already been restored
   * (portable `.motion` zip, relink). Does not touch the scene graph.
   */
  adopt(name: string, path: string | null): ProjectRef {
    const ref: ProjectRef = { id: this.deps.newId(), name, path };
    this.state = { current: ref };
    this.emit();
    this.recordRecent(ref);
    getEventBus().emit('ProjectLoaded', { projectId: ref.id });
    return ref;
  }

  /** Restore a parsed document into the engines and become the current project. */
  private applyLoadedDoc(file: VersionedDocument, name: string, path: string | null): ProjectRef | null {
    try {
      this.io.restore(file);
      const ref: ProjectRef = { id: this.deps.newId(), name, path };
      this.state = { current: ref };
      this.emit();
      this.recordRecent(ref);
      this.deps.logger?.info(`Opened project "${name}"`);
      getEventBus().emit('ProjectLoaded', { projectId: ref.id });
      return ref;
    } catch (err) {
      this.deps.logger?.error('Failed to open project', err);
      return null;
    }
  }

  /**
   * Write the current project back to where it came from.
   *
   * A document with no destination yet (a scratch scene, or the very first save
   * of a new project) routes to `saveAs` rather than reporting a failure — that
   * is what Ctrl+S means everywhere else, and returning `false` here is how
   * "Ctrl+S saved nothing at all" used to be reported as success.
   */
  async save(): Promise<SaveOutcome> {
    const current = this.state.current;
    if (!current) return this.saveAs('Untitled');
    if (!current.path) return this.saveAs(current.name);
    return this.writeTo(current, current.path);
  }

  /**
   * Write the document to a NEW destination the user picks.
   *
   * The result is a separate document, so it takes a fresh id: keeping the
   * previous one made the MRU (which dedupes by id) treat the copy as the
   * original and silently evict the source project from the recent list, even
   * though it was still on disk.
   *
   * `name` is only a SUGGESTION for the dialog — the project takes the name of
   * the file that was actually chosen. It used to keep the suggestion, so a
   * project saved to `Promo.motion` stayed called "Untitled" in the recent
   * list, in the discard prompt, and in the next Increment and Save.
   */
  async saveAs(name: string): Promise<SaveOutcome> {
    const path = await this.deps.files.chooseSavePath(`${name}.motion`);
    if (!path) return { status: 'cancelled' };
    const ref: ProjectRef = { id: this.deps.newId(), name: nameFromSavePath(path, name), path };
    return this.writeTo(ref, path);
  }

  private async writeTo(ref: ProjectRef, path: string): Promise<SaveOutcome> {
    try {
      const file = this.io.capture();
      await this.storage.save(path, file);
      const saved: ProjectRef = { ...ref, path };
      this.state = { current: saved };
      this.emit();
      this.recordRecent(saved);
      this.deps.logger?.info(`Saved project to ${path}`);
      getEventBus().emit('ProjectSaved', { projectId: ref.id });
      return { status: 'saved', ref: saved };
    } catch (err) {
      this.deps.logger?.error('Failed to save project', err);
      return { status: 'failed', error: err };
    }
  }

  close(): void {
    const prev = this.state.current;
    this.state = { current: null };
    this.emit();
    if (prev) getEventBus().emit('ProjectUnloaded', { projectId: prev.id });
  }

  private recordRecent(ref: ProjectRef): void {
    this.deps.recent.add({ id: ref.id, name: ref.name, path: ref.path, openedAt: this.deps.now() });
  }

  private emit(): void {
    for (const l of this.listeners) {
      try { l(this.state); } catch { /* isolate */ }
    }
  }
}
