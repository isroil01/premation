/**
 * F2: the editor's document lifecycle with the ENGINE as the owner — New,
 * Open, Save, Save As, Save a Copy, Revert, Close, autosave and crash recovery
 * as engine requests, the UI reading path / dirty / history from the document
 * mirror only (engineDocumentSession.ts).
 *
 * The script runs on the C++ engine process `premation-engine[-headless]`
 * through `ProcessEngineClient` — its real FilePorts writing temp-file + rename in
 *     a temp directory (skipped, saying so, when the engine is not built;
 *     PREMATION_ENGINE_PATH picks the Dawn-free headless build).
 * A "crash" is the app going away: the engine and its client are dropped and
 * a fresh engine recovers from the recovery file the old one autosaved.
 *
 * ProjectManager with `engineDocument` (the F2 flag) is exercised too:
 * it opens, saves, saves as, snapshots and closes through the engine without
 * touching the page's document IO.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProcessEngineClient,
  unwrap,
  type DocumentSnapshot,
  type EngineClient,
  type EngineResult,
  type QueryOf,
  type QueryResults,
  type QueryType,
} from '@motion/engine-api';
import { DocumentMirror, type MirrorSource } from '@stores/documentMirror';
import { sec } from '@core/engine/__testHelpers__/appEngine';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { EngineDocumentSession, RECOVER_LABEL, type RecoveryFiles, type RecoveryIndex, type RecoveryRecord } from './engineDocumentSession';
import { ProjectManager, type ProjectDocumentIO } from './ProjectManager';
import type { FileManager } from '@core/files/FileManager';
import { setLiveDocumentSource } from './liveDocument';
import type { ProjectService } from '@core/persistence/ProjectService';
import type { RecentProjects } from '@core/project/RecentProjects';

jest.useFakeTimers();

/** One running engine of a backend, with the pieces the session needs. */
interface Running {
  client: EngineClient;
  mirror: DocumentMirror;
  stop(): Promise<void>;
}

interface Backend {
  name: string;
  /** A project path this backend's file port can write. */
  file(name: string): string;
  files: RecoveryFiles;
  /** Start an engine (the app launching). */
  start(): Promise<Running>;
  /** What the engine wrote at `path` (parsed), or null. */
  saved(p: string): unknown;
  dispose(): Promise<void>;
}

function mirrorOver(client: EngineClient): DocumentMirror {
  const source: MirrorSource = {
    subscribe: (l) => client.subscribe(l),
    query: <T extends QueryType>(q: QueryOf<T>): Promise<EngineResult<QueryResults[T]>> => client.query(q),
  };
  return new DocumentMirror(source).start();
}

function processBackend(): Backend {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'premation-f2-'));
  return {
    name: 'C++ engine process',
    file: (n) => path.join(dir, `${n}.motion`),
    files: {
      readText: async (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
      remove: async (p) => {
        if (existsSync(p)) unlinkSync(p);
      },
      writeText: async (p, text) => {
        writeFileSync(p, text, 'utf8');
      },
    },
    start: async () => {
      const native: NativeEngine = await startNativeEngine();
      const client = new ProcessEngineClient(native.bridge);
      await client.whenReady();
      const mirror = mirrorOver(client);
      await mirror.whenIdle();
      return {
        client,
        mirror,
        stop: async () => {
          mirror.stop();
          await client.close();
          await native.stop();
        },
      };
    },
    saved: (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null),
    dispose: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function memoryIndex(): RecoveryIndex & { record: RecoveryRecord | null } {
  const box = {
    record: null as RecoveryRecord | null,
    read: () => box.record,
    write: (r: RecoveryRecord | null) => {
      box.record = r;
    },
  };
  return box;
}

/** The document as the engine describes it, minus what moves with every request. */
async function contentOf(c: EngineClient): Promise<Omit<DocumentSnapshot, 'revision' | 'dirty' | 'projectPath'>> {
  const d = unwrap(await c.query({ type: 'getDocument', includeProperties: true, includeKeyframes: true }));
  const { revision: _r, dirty: _d, projectPath: _p, ...rest } = d;
  return rest;
}

async function labels(c: EngineClient): Promise<string[]> {
  return unwrap(await c.query({ type: 'getHistory' })).entries.map((e) => e.label);
}

const backends: Array<[string, () => Backend]> = [['C++ engine process', processBackend]];
if (!nativeEngineExe()) console.log('[F2 lifecycle] premation-engine is not built — skipped (PREMATION_ENGINE_PATH=<premation-engine-headless>)');
const maybe = nativeEngineExe() ? describe : describe.skip;

maybe.each(backends)('F2: the document lifecycle through the engine — %s', (_name, make) => {
  let backend: Backend;
  let running: Running | null = null;

  beforeEach(() => {
    backend = make();
  });
  afterEach(async () => {
    await running?.stop();
    running = null;
    await backend.dispose();
  });

  it('new → edit → save → autosave → crash → recover → undo shows the saved version → save → revert → copy → open → close', async () => {
    const index = memoryIndex();
    const recoveryPath = backend.file('recovery');
    running = await backend.start();
    let r = running;
    const session = (run: Running): EngineDocumentSession =>
      new EngineDocumentSession({ engine: () => run.client, mirror: run.mirror, recoveryPath, files: backend.files, index, now: () => 1_000 });
    let s = session(r);

    await s.newProject();
    expect(s.projectPath).toBe('');
    expect(s.dirty).toBe(false);

    const comp = unwrap(await r.client.execute({ type: 'createComposition', settings: { name: 'F2', width: 640, height: 360 }, fromItems: [] })).item;
    const layer = unwrap(await r.client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] })).layer;
    const rot = async (deg: number): Promise<void> => {
      unwrap(await r.client.execute({ type: 'setProperty', prop: { layer, path: 'transform/rotation' }, value: { kind: 'scalar', value: deg } }));
    };
    await rot(10);
    await r.mirror.whenIdle();
    expect(s.dirty).toBe(true);
    // Nothing to autosave into a clean slot yet? It is dirty: it writes.
    expect(await s.autosave()).toBe(1_000);
    expect(index.record).toMatchObject({ recoveryPath, projectPath: '' });

    // Save: the engine writes the file; dirty clears; the recovery copy goes.
    const main = backend.file('main');
    const saved = await s.save(main);
    expect(saved.path).toBe(main);
    expect(s.projectPath).toBe(main);
    expect(s.dirty).toBe(false);
    expect(index.record).toBeNull();
    expect(backend.saved(main)).not.toBeNull();
    expect(backend.saved(recoveryPath)).toBeNull();
    const savedContent = await contentOf(r.client);
    expect(await s.autosave()).toBeNull();  // clean: nothing written

    // Unsaved work, autosaved; then the app goes away.
    await rot(45);
    unwrap(await r.client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'B', init: [] }));
    await r.mirror.whenIdle();
    expect(s.dirty).toBe(true);
    expect(await s.autosave()).toBe(1_000);
    expect(index.record).toMatchObject({ recoveryPath, projectPath: main });
    expect(s.projectPath).toBe(main);  // Save a Copy semantics: still bound to its file
    const unsavedContent = await contentOf(r.client);
    await r.stop();

    // Relaunch: a fresh engine recovers.
    running = await backend.start();
    r = running;
    s = session(r);
    expect(s.pendingRecovery()).toMatchObject({ projectPath: main });
    expect(await s.recover()).toBe(true);
    expect(await contentOf(r.client)).toEqual(unsavedContent);
    expect(s.projectPath).toBe(main);
    expect(s.dirty).toBe(true);
    expect(await labels(r.client)).toEqual([RECOVER_LABEL]);
    // Undo shows the saved version; redo the recovered one.
    unwrap(await r.client.undo());
    expect(await contentOf(r.client)).toEqual(savedContent);
    unwrap(await r.client.redo());
    expect(await contentOf(r.client)).toEqual(unsavedContent);
    expect(index.record).not.toBeNull();  // kept until a Save

    await s.save();
    await r.mirror.whenIdle();
    expect(s.dirty).toBe(false);
    expect(index.record).toBeNull();
    expect(backend.saved(recoveryPath)).toBeNull();

    // Revert: back to the file, history cleared.
    const layers = unwrap(await r.client.query({ type: 'getComposition', comp })).comp.layers;
    unwrap(await r.client.execute({ type: 'deleteLayers', layers: [layers[0]!] }));
    await r.mirror.whenIdle();
    expect(s.dirty).toBe(true);
    await s.revert();
    expect(await contentOf(r.client)).toEqual(unsavedContent);
    expect(s.dirty).toBe(false);
    expect(await labels(r.client)).toEqual([]);

    // Save a Copy: the document keeps its path and its dirty flag.
    await rot(90);
    await r.mirror.whenIdle();
    const copy = backend.file('copy');
    await s.saveCopy(copy);
    expect(s.projectPath).toBe(main);
    expect(s.dirty).toBe(true);
    expect(backend.saved(copy)).not.toBeNull();

    // Open the copy; Close leaves an empty document.
    await s.open(copy);
    expect(s.projectPath).toBe(copy);
    expect(s.dirty).toBe(false);
    const opened = await contentOf(r.client);
    expect(opened.layers.length).toBe(unsavedContent.layers.length);
    await s.close();
    expect(s.projectPath).toBe('');
    expect((await contentOf(r.client)).layers).toEqual([]);

    // Refusals come back as errors, and change nothing.
    await expect(s.open(backend.file('missing'))).rejects.toThrow(/openProject/);
    await expect(s.save()).rejects.toThrow(/no path/);
  }, 120_000);

  it('recovery of a never-saved project, and a recovery record whose file is gone', async () => {
    const index = memoryIndex();
    const recoveryPath = backend.file('recovery');
    running = await backend.start();
    let r = running;
    let s = new EngineDocumentSession({ engine: () => r.client, mirror: r.mirror, recoveryPath, files: backend.files, index, now: () => 7 });
    await s.newProject();
    const comp = unwrap(await r.client.execute({ type: 'createComposition', settings: { name: 'Scratch' }, fromItems: [] })).item;
    unwrap(await r.client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'S', init: [] }));
    await r.mirror.whenIdle();
    expect(await s.autosave()).toBe(7);
    const content = await contentOf(r.client);
    await r.stop();

    running = await backend.start();
    r = running;
    s = new EngineDocumentSession({ engine: () => r.client, mirror: r.mirror, recoveryPath, files: backend.files, index, now: () => 7 });
    expect(await s.recover()).toBe(true);
    expect(await contentOf(r.client)).toEqual(content);
    expect(s.projectPath).toBe('');
    expect(s.dirty).toBe(true);
    await s.discardRecovery();
    expect(index.record).toBeNull();
    expect(backend.saved(recoveryPath)).toBeNull();
    expect(await s.recover()).toBe(false);

    index.write({ recoveryPath: backend.file('gone'), projectPath: '', savedAt: 1, revision: 1 });
    expect(await s.recover()).toBe(false);
    expect(index.record).toBeNull();
  }, 120_000);

  it('a cloud project: opened from the fetched text, marked saved after an upload, and its unsent work restored on the next open — never a prompt', async () => {
    const index = memoryIndex();
    const recoveryPath = backend.file('recovery');
    running = await backend.start();
    let r = running;
    // A fresh engine has made no document yet: the boot tells a reload from a start by this.
    expect((await r.client.query({ type: 'getHistory' })).revision).toBe(0);
    const session = (run: Running): EngineDocumentSession =>
      new EngineDocumentSession({ engine: () => run.client, mirror: run.mirror, recoveryPath, files: backend.files, index, now: () => 5 });
    let s = session(r);

    // The server's copy: a document with one comp and one layer.
    await s.newProject();
    const comp = unwrap(await r.client.execute({ type: 'createComposition', settings: { name: 'Cloud' }, fromItems: [] })).item;
    unwrap(await r.client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'Server', init: [] }));
    const serverText = new TextDecoder().decode(unwrap(await r.client.query({ type: 'exportDocument' })).document);
    const serverContent = await contentOf(r.client);
    await s.newProject();

    // Open it the way ProjectLoader does: bound to its local copy, clean, no history.
    expect(await s.openText('proj 42', serverText)).toEqual({ recovered: false });
    const local = s.localCopyPath('proj 42');
    expect(local).toMatch(/cloud-proj_42\.json$/);
    expect(s.projectPath).toBe(local);
    expect(s.dirty).toBe(false);
    expect(await contentOf(r.client)).toEqual(serverContent);

    // An edit, uploaded: markSaved clears dirty and the recovery copy.
    unwrap(await r.client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'Uploaded', init: [] }));
    await r.mirror.whenIdle();
    expect(await s.autosave()).toBe(5);
    expect(index.record).toMatchObject({ projectPath: local });
    const uploadedAt = r.mirror.revision;
    await s.markSaved(uploadedAt + 1);  // an edit after the export: not marked
    expect(s.dirty).toBe(true);
    await s.markSaved(uploadedAt);
    expect(s.dirty).toBe(false);
    expect(index.record).toBeNull();
    const uploadedText = new TextDecoder().decode(unwrap(await r.client.query({ type: 'exportDocument' })).document);

    // Another edit that never reaches the server; autosaved; the app dies.
    unwrap(await r.client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'Unsent', init: [] }));
    await r.mirror.whenIdle();
    expect(await s.autosave()).toBe(5);
    const unsentContent = await contentOf(r.client);
    await r.stop();

    // Next start: the same project opens from the server's (older) copy and the unsent work comes back on top.
    running = await backend.start();
    r = running;
    s = session(r);
    expect(await s.openText('proj 42', uploadedText)).toEqual({ recovered: true });
    expect(await contentOf(r.client)).toEqual(unsentContent);
    expect(s.dirty).toBe(true);
    expect(await labels(r.client)).toEqual([RECOVER_LABEL]);

    // A different project's open never takes that copy.
    await s.autosave();
    expect(await s.openText('other', serverText)).toEqual({ recovered: false });
    expect(await contentOf(r.client)).toEqual(serverContent);
  }, 120_000);

  it('ProjectManager on cloud files: open loads the fetched document into the engine; Save uploads and never hands the engine a cloud id', async () => {
    const index = memoryIndex();
    running = await backend.start();
    const r = running;
    const s = new EngineDocumentSession({ engine: () => r.client, mirror: r.mirror, recoveryPath: backend.file('recovery'), files: backend.files, index, now: () => 1 });
    setLiveDocumentSource({ engine: () => r.client, owned: () => true });
    try {
      await s.newProject();
      const comp = unwrap(await r.client.execute({ type: 'createComposition', settings: { name: 'Cloud' }, fromItems: [] })).item;
      unwrap(await r.client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'On the server', init: [] }));
      const cloud = new Map<string, string>([['abc-123', new TextDecoder().decode(unwrap(await r.client.query({ type: 'exportDocument' })).document)]]);
      const serverContent = await contentOf(r.client);
      await s.newProject();

      const files = {
        environment: 'api',
        open: async () => null,
        chooseSavePath: async () => null,
        read: async (id: string) => cloud.get(id) ?? null,
        write: async (id: string, text: string) => {
          cloud.set(id, text);
        },
      } as unknown as FileManager;
      const recent = { add: () => undefined } as unknown as RecentProjects;
      const pm = new ProjectManager({ service: {} as ProjectService, files, recent, engineDocument: s, newId: () => 'c1' });

      expect(await pm.openPath('missing')).toBeNull();
      const ref = await pm.openPath('abc-123');
      expect(ref?.path).toBe('abc-123');
      expect(await contentOf(r.client)).toEqual(serverContent);
      expect(r.mirror.dirty).toBe(false);

      unwrap(await r.client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'Edited', init: [] }));
      await r.mirror.whenIdle();
      expect(r.mirror.dirty).toBe(true);
      expect((await pm.save()).status).toBe('saved');
      expect(r.mirror.dirty).toBe(false);
      const uploaded = JSON.parse(cloud.get('abc-123')!) as { scene?: unknown };
      expect(JSON.stringify(uploaded)).toContain('Edited');
      expect(existsSync(path.join(process.cwd(), 'abc-123'))).toBe(false);
    } finally {
      setLiveDocumentSource(null);
    }
  }, 120_000);

  it('ProjectManager with the F2 flag: open / save / save as / snapshot / close go through the engine, never the page document IO', async () => {
    const index = memoryIndex();
    running = await backend.start();
    const r = running;
    const s = new EngineDocumentSession({ engine: () => r.client, mirror: r.mirror, recoveryPath: backend.file('recovery'), files: backend.files, index, now: () => 1 });
    const pageIO: ProjectDocumentIO = {
      createEmpty: () => ({ version: '1.0.0' }),
      capture: () => {
        throw new Error('the page captured the document');
      },
      restore: () => {
        throw new Error('the page restored the document');
      },
    };
    const saveAsPath = backend.file('saved-as');
    const files = {
      open: async () => null,
      chooseSavePath: async () => saveAsPath,
      read: async () => null,
      write: async () => {
        throw new Error('the page wrote a project file');
      },
    } as unknown as FileManager;
    const recent = { add: () => undefined } as unknown as RecentProjects;
    const pm = new ProjectManager({ service: {} as ProjectService, files, recent, io: pageIO, engineDocument: s, newId: () => 'p1' });
    expect(pm.engineOwned).toBe(true);

    pm.newProject('F2');
    const comp = unwrap(await r.client.execute({ type: 'createComposition', settings: { name: 'PM' }, fromItems: [] })).item;
    const layer = unwrap(await r.client.execute({ type: 'createLayer', comp, kind: 'solid', name: 'L', init: [] })).layer;
    unwrap(await r.client.execute({ type: 'addKeyframes', keys: [0, 1].map((i) => ({ prop: { layer, path: 'transform/rotation' }, time: sec(i), value: { kind: 'scalar' as const, value: 30 * i }, spatialIn: [], spatialOut: [] })) }));
    await r.mirror.whenIdle();
    expect(r.mirror.dirty).toBe(true);

    // First save of a new project routes to Save As.
    const out = await pm.save();
    expect(out.status).toBe('saved');
    expect(pm.getState().current?.path).toBe(saveAsPath);
    expect(r.mirror.projectPath).toBe(saveAsPath);
    expect(r.mirror.dirty).toBe(false);
    const content = await contentOf(r.client);

    // The export supervisor's snapshot: a copy, the project stays itself.
    const snap = backend.file('snapshot');
    await pm.snapshotTo(snap);
    expect(backend.saved(snap)).not.toBeNull();
    expect(r.mirror.projectPath).toBe(saveAsPath);

    pm.close();
    await r.client.query({ type: 'getHistory' });  // after the close request
    await r.mirror.whenIdle();
    expect((await contentOf(r.client)).layers).toEqual([]);

    const ref = await pm.openPath(snap);
    expect(ref?.path).toBe(snap);
    expect(r.mirror.projectPath).toBe(snap);
    expect(await contentOf(r.client)).toEqual(content);
    expect(await pm.openPath(backend.file('missing'))).toBeNull();
  }, 120_000);
});
