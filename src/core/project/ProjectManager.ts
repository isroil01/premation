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
import { trackProjectCreated } from '@core/analytics/productEvents';
import { projectNameFromFilePath } from '@core/project/projectName';

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
  return projectNameFromFilePath(path, fallback);
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
  /**
   * Drop the live document entirely — Close Project.
   *
   * Optional: without it `close()` restores `createEmpty()`, which is the
   * document half of an unload. The app's IO also has session state an empty
   * document cannot express (precomp tabs, timelines, undo, the asset list) and
   * overrides this to clear those in the same step.
   */
  unload?(): void;
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
  /**
   * Editor state kept beside a project FILE (tabs, playhead, timeline zoom —
   * never in the document, B4): remembered on save and close, recalled on open.
   * The app passes core/project/editorView.ts.
   */
  editorView?: { remember(path: string | null): void; recall(path: string | null): void };
  /**
   * F2 (NATIVE_CORE_PLAN §5 Phase F): the ENGINE owns the document. When set,
   * New / Open / Save / Save As / snapshot / Close are engine requests
   * (core/project/engineDocumentSession.ts) — the page never captures,
   * parses or restores the document, and `io` / `storage` are not used for
   * them. Unset (the default, the TypeScript engine as owner): unchanged.
   */
  engineDocument?: EngineOwnedDocument;
}

/** The engine-owned lifecycle ProjectManager delegates to (EngineDocumentSession implements it). */
export interface EngineOwnedDocument {
  newProject(): Promise<void>;
  open(path: string): Promise<unknown>;
  save(path: string): Promise<unknown>;
  saveCopy(path: string): Promise<unknown>;
  close(): Promise<void>;
}

export class ProjectManager {
  private state: ProjectState = { current: null };
  private io: ProjectDocumentIO;
  private readonly storage: ProjectStorage;
  private readonly listeners = new Set<(s: ProjectState) => void>();
  private readonly deps: Required<Omit<ProjectManagerDeps, 'logger' | 'io' | 'storage' | 'editorView' | 'engineDocument'>> & Pick<ProjectManagerDeps, 'logger' | 'editorView'>;
  private engineDocument: EngineOwnedDocument | null;

  constructor(deps: ProjectManagerDeps) {
    this.io = deps.io ?? emptyDocumentIO;
    this.engineDocument = deps.engineDocument ?? null;
    this.deps = {
      service: deps.service,
      files: deps.files,
      recent: deps.recent,
      logger: deps.logger,
      editorView: deps.editorView,
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

  /** F2: is the document owned by the engine (lifecycle through engine requests)? */
  get engineOwned(): boolean { return this.engineDocument !== null; }

  /**
   * F2 / D5: hand the lifecycle to the engine (or back, with null). The app
   * builds ProjectManager before it knows the owner flag (coreServices), so
   * Providers attaches the engine's session here once main has answered.
   */
  setEngineDocument(doc: EngineOwnedDocument | null): void {
    this.engineDocument = doc;
  }

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
    if (this.engineDocument) {
      // Requests are applied in order: an edit sent after this lands on the new document.
      this.engineDocument.newProject().catch((err: unknown) => this.deps.logger?.error('Failed to create project', err));
    } else {
      this.io.restore(this.io.createEmpty(name));
    }
    this.state = { current: ref };
    this.emit();
    this.deps.logger?.info(`New project "${name}"`);
    // Before ProjectLoaded, so a creation reads as created-then-opened.
    trackProjectCreated();
    getEventBus().emit('ProjectLoaded', { projectId: ref.id });
    return ref;
  }

  async open(): Promise<ProjectRef | null> {
    const picked = await this.deps.files.open({ extensions: ['motion', 'json'] });
    if (!picked) return null;
    // F2: the engine reads the file itself; the page's copy of the contents is unused.
    if (this.engineDocument && picked.path) return this.openInEngine(picked.path, picked.name);
    return this.load(picked.contents, picked.name, picked.path);
  }

  async openPath(path: string): Promise<ProjectRef | null> {
    if (this.engineDocument) return this.openInEngine(path, projectNameFromFilePath(path));
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
    // The file's BASE name. This was `path.replace(ext, '')` — the whole path —
    // so the title bar and the recent list both read "C:/Users/…/files/qa1".
    return this.applyLoadedDoc(file, projectNameFromFilePath(path), path);
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
    this.deps.editorView?.recall(path);
    const ref: ProjectRef = { id: this.deps.newId(), name, path };
    this.state = { current: ref };
    this.emit();
    this.recordRecent(ref);
    getEventBus().emit('ProjectLoaded', { projectId: ref.id });
    return ref;
  }

  /**
   * Become the current project again after crash recovery restored its
   * document. Unlike `adopt` this is not an open: nothing is added to the
   * recent list (a never-saved project has no file to reopen) and no
   * ProjectLoaded fires — it only rebinds, so Save writes back to `path`.
   */
  resume(name: string, path: string | null): ProjectRef {
    const ref: ProjectRef = { id: this.deps.newId(), name, path };
    this.state = { current: ref };
    this.emit();
    return ref;
  }

  /** F2: the engine opens (reads, migrates, loads) the file; become the current project. */
  private async openInEngine(path: string, name: string): Promise<ProjectRef | null> {
    try {
      await this.engineDocument!.open(path);
    } catch (err) {
      this.deps.logger?.error('Failed to open project', err);
      return null;
    }
    this.deps.editorView?.recall(path);
    const ref: ProjectRef = { id: this.deps.newId(), name, path };
    this.state = { current: ref };
    this.emit();
    this.recordRecent(ref);
    this.deps.logger?.info(`Opened project "${name}"`);
    getEventBus().emit('ProjectLoaded', { projectId: ref.id });
    return ref;
  }

  /** Restore a parsed document into the engines and become the current project. */
  private applyLoadedDoc(file: VersionedDocument, name: string, path: string | null): ProjectRef | null {
    try {
      this.io.restore(file);
      // B4: tabs / playhead / timeline zoom are editor state kept beside the
      // file on this machine, not in it (core/project/editorView.ts).
      this.deps.editorView?.recall(path);
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

  /**
   * Write the document AS IT IS NOW to `path` without becoming that path.
   *
   * The export supervisor's jobs render from a project on disk — the same
   * `openPath` the CLI uses — and this is how the editor hands one over: the
   * same capture and the same storage a Save goes through (a `.motion` path
   * lands as a bundle, footage collected in), but the current project keeps
   * its own path, its dirty flag and its recent-list entry. Nothing the user
   * would call "saving" happens.
   */
  async snapshotTo(path: string): Promise<void> {
    if (this.engineDocument) {
      await this.engineDocument.saveCopy(path);
      return;
    }
    await this.storage.save(path, this.io.capture());
  }

  /**
   * Read a document from `path` through this manager's storage (bundle or
   * single file) WITHOUT restoring it or becoming it — the engine API's file
   * port (src/core/engine/appPorts.ts). Null when there is nothing there.
   */
  async readDocument(path: string): Promise<VersionedDocument | null> {
    return this.storage.load(path);
  }

  /**
   * Write `doc` to `path` through this manager's storage (temp file + rename,
   * footage collected into a bundle) without changing the current project —
   * the engine API's file port. The caller decides what the write means.
   */
  async writeDocument(path: string, doc: VersionedDocument): Promise<void> {
    await this.storage.save(path, doc);
  }

  private async writeTo(ref: ProjectRef, path: string): Promise<SaveOutcome> {
    try {
      if (this.engineDocument) {
        // F2: the engine serializes and writes (temp file + rename); dirty clears there.
        await this.engineDocument.save(path);
      } else {
        const file = this.io.capture();
        await this.storage.save(path, file);
      }
      this.deps.editorView?.remember(path);
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

  /**
   * Close the project: unload its document AND drop the reference.
   *
   * This used to drop only the reference. The scene, compositions, timeline
   * and undo stack all stayed live and editable under a "No project" title —
   * and because Save with no current project routes to Save As, the "closed"
   * project could then be written straight back out under a new name.
   *
   * The unload runs BEFORE the reference drops and before ProjectUnloaded, so
   * every listener that re-reads the scene on that event sees the empty one.
   * A failed unload still closes: a reference to a project the user asked to
   * close is the worse thing to be left holding.
   */
  close(): void {
    const prev = this.state.current;
    this.deps.editorView?.remember(prev?.path ?? null);
    try {
      if (this.engineDocument) this.engineDocument.close().catch((err: unknown) => this.deps.logger?.error('Failed to unload project document', err));
      else if (this.io.unload) this.io.unload();
      else this.io.restore(this.io.createEmpty('Untitled'));
    } catch (err) {
      this.deps.logger?.error('Failed to unload project document', err);
    }
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
