/**
 * F2 — the document lifecycle with the ENGINE as the owner
 * (docs/NATIVE_CORE_PLAN.md §5 Phase F, "The engine owns the document and
 * undo; the UI holds only its mirror").
 *
 * Today's lifecycle (ProjectManager + projectDocumentIO + recovery.ts) moves
 * the document through the UI process: Save calls `captureDocument()` over the
 * TypeScript scene graph, animation engine, timelines and project stores and
 * writes the result; Open parses the file in the page and `restoreDocument()`s
 * it into those stores; autosave captures the same stores into a recovery
 * snapshot. None of that can work once the document lives in
 * `premation-engine`.
 *
 * This is the lifecycle expressed only in engine API requests, so it runs
 * unchanged over the TypeScript engine (in process, with its file ports) and
 * over the C++ engine process (`PREMATION_ENGINE=process`, whose FilePorts
 * write temp-file + rename):
 *
 *   New            newProject                         (history cleared, documentReset)
 *   Open           openProject{path}                  (the engine reads and migrates the file)
 *   Save / Save As saveProject{path}                  (the engine writes; dirty clears, path moves)
 *   Save a Copy    saveProject{path, copy:true}       (path and dirty unchanged — also the
 *                                                     export supervisor's snapshot)
 *   Revert         revertProject
 *   Close          newProject
 *   Autosave       saveProject{recoveryPath, copy:true} when the MIRROR says dirty,
 *                  plus a small recovery record (which project, when, at what revision)
 *   Recover        openProject{record.projectPath} (or newProject when it was never saved),
 *                  then restoreDocument{recovery file} as ONE undoable entry
 *                  ("Recover Unsaved Work"): the document is the recovered one, dirty,
 *                  still bound to its own file, and Undo shows the saved version.
 *
 * What the UI reads back — path, dirty, revision, history — comes from the
 * document mirror (src/stores/documentMirror.ts), never from a UI store. The
 * page never parses or holds the document; the only bytes it touches are the
 * recovery file's, handed straight to `restoreDocument`.
 *
 * No React, no stores (src/core): the mirror is passed in as the narrow view
 * below, and the recovery record lives behind `RecoveryIndex` (editor state
 * on this machine, like recent projects — never in the document).
 */

import type { EngineClient, EngineResult, OpenProjectResult, SaveProjectResult } from '@motion/engine-api';

/** What the session reads from the document mirror (DocumentMirror satisfies it). */
export interface MirrorView {
  readonly projectPath: string;
  readonly dirty: boolean;
  readonly revision: number;
  /** Resolves when no refetch is in flight (a documentReset reloads the mirror). */
  whenIdle(): Promise<void>;
}

/** Files the page reads or removes itself: only the recovery document. */
export interface RecoveryFiles {
  /** The file's UTF-8 text, or null when it does not exist. */
  readText(path: string): Promise<string | null>;
  remove(path: string): Promise<void>;
}

/** Which unsaved session a recovery file holds. */
export interface RecoveryRecord {
  /** Where the engine wrote the recovery copy. */
  recoveryPath: string;
  /** The project file the document belongs to ('' = never saved). */
  projectPath: string;
  /** Wall-clock stamp of the write (shown to the user; never enters rendering). */
  savedAt: number;
  /** Engine revision the copy was taken at. */
  revision: number;
}

/** Where the recovery record is kept between sessions (localStorage in the app). */
export interface RecoveryIndex {
  read(): RecoveryRecord | null;
  write(record: RecoveryRecord | null): void;
}

export interface EngineDocumentSessionOptions {
  /** The engine that owns the document (read at call time: the app may swap it). */
  engine: () => EngineClient;
  mirror: MirrorView;
  /** Where autosave writes the recovery copy. */
  recoveryPath: string;
  files: RecoveryFiles;
  index: RecoveryIndex;
  now: () => number;
}

/** A lifecycle request the engine refused (the message is the engine's). */
export class DocumentLifecycleError extends Error {
  constructor(readonly op: string, readonly code: string, message: string) {
    super(`${op}: ${message}`);
    this.name = 'DocumentLifecycleError';
  }
}

export const RECOVER_LABEL = 'Recover Unsaved Work';

export class EngineDocumentSession {
  private readonly o: EngineDocumentSessionOptions;

  constructor(options: EngineDocumentSessionOptions) {
    this.o = options;
  }

  /** The project file the engine's document is bound to ('' = never saved). */
  get projectPath(): string {
    return this.o.mirror.projectPath;
  }

  /** Unsaved edits, as the engine reports them (dirtyChanged). */
  get dirty(): boolean {
    return this.o.mirror.dirty;
  }

  async newProject(): Promise<void> {
    await this.run('newProject', this.o.engine().execute({ type: 'newProject' }));
    await this.dropRecovery();
  }

  async open(path: string): Promise<OpenProjectResult> {
    const r = await this.run('openProject', this.o.engine().execute({ type: 'openProject', path }));
    await this.dropRecovery();
    return r;
  }

  /** Save (to the bound file, or to `path` = Save As). Clears dirty and the recovery copy. */
  async save(path?: string): Promise<SaveProjectResult> {
    const target = path ?? this.projectPath;
    if (!target) throw new DocumentLifecycleError('saveProject', 'invalidArgument', 'the project has no path yet; pass one');
    const r = await this.run('saveProject', this.o.engine().execute({ type: 'saveProject', path: target, copy: false }));
    await this.dropRecovery();
    return r;
  }

  /** Save a Copy / the export supervisor's snapshot: the document keeps its path and dirty flag. */
  async saveCopy(path: string): Promise<SaveProjectResult> {
    return this.run('saveProject', this.o.engine().execute({ type: 'saveProject', path, copy: true }));
  }

  async revert(): Promise<void> {
    await this.run('revertProject', this.o.engine().execute({ type: 'revertProject' }));
    await this.dropRecovery();
  }

  /** Close Project: the engine holds an empty document again. */
  async close(): Promise<void> {
    await this.newProject();
  }

  /**
   * One autosave tick: when the engine's document is dirty (or `force`, the
   * Files tab's "Autosave now"), the engine writes a copy to the recovery path
   * and the record says which project it belongs to. Returns the stamp, or
   * null when nothing was written. Never throws: autosave must not break the app.
   */
  async autosave(opts: { force?: boolean } = {}): Promise<number | null> {
    try {
      await this.o.mirror.whenIdle();
      if (!opts.force && !this.dirty) return null;
      const res = await this.o.engine().execute({ type: 'saveProject', path: this.o.recoveryPath, copy: true });
      if (!res.ok) return null;
      const savedAt = this.o.now();
      this.o.index.write({ recoveryPath: this.o.recoveryPath, projectPath: this.projectPath, savedAt, revision: res.revision });
      return savedAt;
    } catch {
      return null;
    }
  }

  /** The unsaved session a previous run left behind, if any. */
  pendingRecovery(): RecoveryRecord | null {
    return this.o.index.read();
  }

  /**
   * Restore the unsaved session: the project it belonged to is opened (so Save
   * writes back to it), then the recovery copy replaces the document as ONE
   * undoable entry. The result is dirty; the recovery copy stays until a Save.
   * False when there is nothing to recover (the record or its file is gone).
   */
  async recover(): Promise<boolean> {
    const rec = this.o.index.read();
    if (!rec) return false;
    const text = await this.o.files.readText(rec.recoveryPath);
    if (text === null) {
      this.o.index.write(null);
      return false;
    }
    const engine = this.o.engine();
    let opened = false;
    if (rec.projectPath) {
      const r = await engine.execute({ type: 'openProject', path: rec.projectPath });
      opened = r.ok;
    }
    if (!opened) await this.run('newProject', engine.execute({ type: 'newProject' }));
    await this.run('restoreDocument', engine.execute({ type: 'restoreDocument', document: new TextEncoder().encode(text), label: RECOVER_LABEL }));
    await this.o.mirror.whenIdle();
    return true;
  }

  /** "Discard" in the recovery prompt. */
  async discardRecovery(): Promise<void> {
    await this.dropRecovery();
  }

  private async dropRecovery(): Promise<void> {
    const rec = this.o.index.read();
    if (!rec) return;
    this.o.index.write(null);
    try {
      await this.o.files.remove(rec.recoveryPath);
    } catch {
      // A recovery copy that cannot be removed is overwritten by the next autosave.
    }
  }

  private async run<T>(op: string, p: Promise<EngineResult<T>>): Promise<T> {
    const r = await p;
    if (!r.ok) throw new DocumentLifecycleError(op, r.error.code, r.error.message);
    // The response comes after its events (§8.1); a documentReset starts a
    // mirror refetch — wait for it so callers read the new document.
    await this.o.mirror.whenIdle();
    return r.value;
  }
}
