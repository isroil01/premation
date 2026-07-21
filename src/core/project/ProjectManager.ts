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
  dirty: boolean;
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
  now?: () => number;
  newId?: () => string;
}

export class ProjectManager {
  private state: ProjectState = { current: null, dirty: false };
  private io: ProjectDocumentIO;
  private readonly listeners = new Set<(s: ProjectState) => void>();
  private readonly deps: Required<Omit<ProjectManagerDeps, 'logger' | 'io'>> & Pick<ProjectManagerDeps, 'logger'>;

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

  markDirty(dirty = true): void {
    if (this.state.dirty === dirty) return;
    this.state = { ...this.state, dirty };
    this.emit();
    getEventBus().emit('ProjectDirtyChanged', { dirty });
  }

  newProject(name = 'Untitled'): ProjectRef {
    const ref: ProjectRef = { id: this.deps.newId(), name, path: null };
    this.io.restore(this.io.createEmpty(name));
    this.state = { current: ref, dirty: false };
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
    const contents = await this.deps.files.read(path);
    if (contents == null) {
      this.deps.logger?.warn(`Project not found at ${path}`);
      return null;
    }
    return this.load(contents, path.replace(/\.[^.]+$/, ''), path);
  }

  private load(contents: string, name: string, path: string | null): ProjectRef | null {
    try {
      const file = this.deps.service.parse(contents);
      this.io.restore(file);
      const ref: ProjectRef = { id: this.deps.newId(), name, path };
      this.state = { current: ref, dirty: false };
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

  async save(): Promise<boolean> {
    const current = this.state.current;
    if (!current) return false;
    if (!current.path) return this.saveAs(current.name);
    return this.writeTo(current, current.path);
  }

  async saveAs(name: string): Promise<boolean> {
    const path = await this.deps.files.chooseSavePath(`${name}.motion`);
    if (!path) return false;
    const ref: ProjectRef = this.state.current
      ? { ...this.state.current, name, path }
      : { id: this.deps.newId(), name, path };
    return this.writeTo(ref, path);
  }

  private async writeTo(ref: ProjectRef, path: string): Promise<boolean> {
    try {
      const file = this.io.capture();
      await this.deps.files.write(path, this.deps.service.serialize(file));
      this.state = { current: { ...ref, path }, dirty: false };
      this.emit();
      this.recordRecent(this.state.current!);
      this.deps.logger?.info(`Saved project to ${path}`);
      getEventBus().emit('ProjectSaved', { projectId: ref.id });
      return true;
    } catch (err) {
      this.deps.logger?.error('Failed to save project', err);
      return false;
    }
  }

  close(): void {
    const prev = this.state.current;
    this.state = { current: null, dirty: false };
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
