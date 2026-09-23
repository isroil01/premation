/**
 * LocalEngine — the engine API (docs/ENGINE_API.md) implemented in TypeScript on
 * top of today's engine (NATIVE_CORE_PLAN §5 B2). In-process, transport-free:
 * a `Request` goes in, a `Response` and `EventBatch`es come out, exactly as they
 * will from the C++ process in C3.
 *
 * ## Undo
 *
 * The client owns ONE history, and it is the app's `HistoryService` (the T1
 * unified stack): every applied request pushes one `EngineHistoryEntry` onto it
 * (a batch or a gesture is one entry). An entry holds the PARTS the request
 * changed, before and after (state.ts) — the concrete inverse recorded at apply
 * time. Undo writes the befores back, redo the afters; both are ordinary
 * revisions with change events. Because the entries live on the same stack as
 * the pre-API recorders (the 700 ms debounce, engine-timeline commands,
 * `runAnimEdit`), the two worlds interleave in one strictly linear order until
 * B3 removes the old recorders (see ENGINE_API.md "B2 implementation notes").
 *
 * Coexistence rules while the debounce recorder still exists:
 *   • every edit runs inside `historyStore.runRestoring` after a `flush()` — a
 *     pending UI edit gets its own entry first, and nothing this engine writes
 *     is captured a second time by the recorder (same contract `runAsOneHistoryEntry`
 *     uses);
 *   • `HistoryService` pushes from helpers the engine calls (timeline commands,
 *     runAnimEdit inside a helper) are suspended while it applies;
 *   • a document change NOT made through the engine marks it stale; the next
 *     request first sends `documentReset{resync}` so a mirror refetches.
 */

import {
  EngineClientBase,
  COMMANDS,
  codecs,
  type Command,
  type CommandResult,
  type CommandType,
  type EngineError,
  type EngineResult,
  type Event,
  type EventBatch,
  type EventListener,
  type QueryOf,
  type QueryResults,
  type QueryType,
  type HistoryState,
  type LogRecord,
  type Origin,
  type Query,
  type QueryResult,
  type Request,
  type Response,
  type Revision,
  type ResetReason,
} from '@motion/engine-api';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { HistoryService } from '@core/commands/HistoryService';
import type { IUndoableCommand } from '@core/commands/Command';
import { useHistoryStore } from '@stores/historyStore';
import { getEventBus } from '@core/events/EventBus';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';
import { restoreDocument, captureDocument, type EditorDocument } from '@core/api/cloudDocument';
import { projectDocumentIO } from '@core/project/projectDocumentIO';
import { useProjectStore } from '@stores/projectStore';
import { useAssetStore, replaceProjectItems, getDocumentItems } from '@stores/assetStore';
import { EngineFail, fail, toEngineError } from './errors';
import { IdAllocator, allKeyframeIds, type IdCounters } from './ids';
import { captureScope, applyParts, changedKeys, documentScope, type Parts, type Scope } from './state';
import { EventBuilder } from './events';
import { idTaken, compItemIds } from './doc';
import { getTimelineController } from '@core/timeline/TimelineController';
import { documentHash } from './canonical';
import type { EnginePorts } from './ports';
import type { HandlerCtx, Plan } from './handler';
import { EDIT_HANDLERS } from './handlers';
import { runQuery, type QueryCtx } from './queries';
import { Transport } from './transport';
import { KeyIndex } from './keyIndex';
import { stampMissingKeyIds } from './stamp';
import { refreshLegacyUi } from './legacyRefresh';

/** Bars mirror their node (name, enabled, locked, membership) — refresh every comp's mirror. */
function syncTimelines(): void {
  const c = getTimelineController();
  for (const comp of c.registeredCompIds()) c.syncFromScene(comp);
}

export interface LocalEngineOptions {
  /** Also diff the whole document around every command and fail one that changed a part outside its scope (tests). */
  verifyScopes?: boolean;
  /** Round-trip every request, response and event batch through the binary codec (tests: proves every payload is encodable). */
  wire?: boolean;
  /** Record the command log (§12). Default true. */
  recordLog?: boolean;
  /** Put a document hash on every log record (costs a canonical capture per request). Default false. */
  hashes?: boolean;
  ports?: EnginePorts;
  /** The history the entries go on; default the app's CommandSystem history. */
  history?: () => HistoryService | null;
  /**
   * Announce every forward edit on the app bus so today's panels re-read the
   * document (legacyRefresh.ts). The app's engine sets it (engineInstance.ts);
   * B4's mirror removes it. Undo/redo always refresh (applyParts).
   */
  legacyUiRefresh?: boolean;
  /** The project file this document was opened from / saved to ('' = never saved). */
  projectPath?: string;
}

/** One undo entry: the parts a request (or a gesture) changed, before and after. */
export class EngineHistoryEntry implements IUndoableCommand {
  readonly named = false;
  label: string;
  readonly origin: Origin;
  readonly before: Parts;
  readonly after: Parts;
  private readonly engine: LocalEngine;

  constructor(engine: LocalEngine, label: string, origin: Origin, before: Parts, after: Parts) {
    this.engine = engine;
    this.label = label;
    this.origin = origin;
    this.before = before;
    this.after = after;
  }

  execute(): void {
    this.engine.replayEntry(this, 'redo');
  }

  undo(): void {
    this.engine.replayEntry(this, 'undo');
  }
}

interface OpenGesture {
  id: number;
  label: string;
  origin: Origin;
  before: Parts;
  after: Parts;
  /** Revision when the gesture opened (commit:false restores to an equal document). */
  startRevision: Revision;
}

interface LogHeader {
  document: EditorDocument;
  ids: IdCounters;
  revision: Revision;
}

export interface CommandLogData {
  header: LogHeader;
  records: LogRecord[];
}

const humanize = (type: string): string =>
  type.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

export class LocalEngine extends EngineClientBase {
  private readonly listeners = new Set<EventListener>();
  private readonly options: LocalEngineOptions;
  readonly ids = new IdAllocator();
  private readonly builder = new EventBuilder();
  readonly transport: Transport;
  readonly keyIndex = new KeyIndex();
  private queue: Promise<unknown> = Promise.resolve();
  private docRevision: Revision = 0;
  private savedRevision: Revision = 0;
  private projectPath = '';
  private gesture: OpenGesture | null = null;
  /** Open while jumpToHistory walks the stack: the steps fold into one revision. */
  private jump: { from: Parts; to: Parts } | null = null;
  /** The request's single EventBatch, delivered just before its response (§8.1). */
  private pendingBatch: EventBatch | null = null;
  private applying = 0;
  private stale = false;
  private currentSeq: number | undefined;
  private currentOrigin: Origin = 'ui';
  private log: LogRecord[] = [];
  private logHeader: LogHeader | null = null;
  /** Recovery cadence the app's autosave reads (a preference, not document state). */
  autosave = { enabled: false, intervalSeconds: 0, keep: 0 };
  private busDisposers: Array<{ dispose(): void }> = [];
  private closed = false;

  constructor(options: LocalEngineOptions = {}) {
    super();
    this.options = { recordLog: true, hashes: false, ...options };
    this.projectPath = options.projectPath ?? '';
    this.transport = new Transport((events) => this.emitEphemeral(events));
    this.attachBus();
    this.seedIds();
    if (this.options.recordLog) this.startLog();
  }

  // ── Public surface beyond EngineClient ──────────────────────────────

  get documentRevision(): Revision {
    return this.docRevision;
  }

  get isGestureOpen(): boolean {
    return this.gesture !== null;
  }

  /** Re-subscribe to the app bus (call after `Application.boot()` swaps it). */
  attachBus(): void {
    for (const d of this.busDisposers) d.dispose();
    const bus = getEventBus();
    // A document change made AROUND the engine (a legacy writer). The mirror
    // (B4, src/stores/documentMirror.ts) must hear about it without waiting
    // for the next request: `flushExternal` runs on the next microtask and
    // reports it — incrementally when the bus named the one layer it touched
    // (the drag hot path: `AnimationChanged{nodeId}` / `NodeUpdated{nodeId}`),
    // as `documentReset{resync}` otherwise.
    const mark = (nodeId?: string): void => {
      if (this.applying !== 0) return;
      this.stale = true;
      const ext = this.external ?? (this.external = { nodes: new Set<string>(), all: false });
      if (nodeId) ext.nodes.add(nodeId);
      else ext.all = true;
      // An attributed write is reported NOW (as the legacy bus listeners
      // re-rendered synchronously, so does the mirror); a structural one is
      // coalesced to the next microtask — a legacy edit often announces
      // several, and each would refetch the whole document.
      if (nodeId && !ext.all && this.inFlight === 0) this.flushExternal();
      else this.scheduleExternalFlush();
    };
    this.busDisposers = [
      bus.on('SceneGraphChanged', () => mark()),
      bus.on('NodeUpdated', (p) => mark(p?.nodeId || undefined)),
      bus.on('AnimationChanged', (p) => {
        if (!isMediaDecodeRepaint(p as never)) mark(p?.nodeId || undefined);
      }),
      bus.on('DocumentChanged', () => mark()),
    ];
  }

  /** Writes made around the engine since the last flush (see `attachBus`). */
  private external: { nodes: Set<string>; all: boolean } | null = null;
  private externalScheduled = false;
  /** Requests between the start of `handle` and their response (a command may await its `prepare`). */
  private inFlight = 0;

  private scheduleExternalFlush(): void {
    if (this.externalScheduled || this.closed) return;
    this.externalScheduled = true;
    // A promise microtask, not queueMicrotask/setTimeout: fake timers never hold it.
    void Promise.resolve().then(() => {
      this.externalScheduled = false;
      this.flushExternal();
    });
  }

  /**
   * Report the writes made around the engine as a revision of their own
   * (origin `engine`, no `causedBy` — `isWriteAroundEngine` recognises it).
   * While a request runs, the request's own start (`resyncIfStale`) or the
   * next idle moment reports them instead.
   */
  flushExternal(): void {
    if (!this.external || this.closed) return;
    if (this.inFlight > 0 || this.applying > 0) {
      void this.queue.then(() => this.scheduleExternalFlush());
      return;
    }
    const ext = this.external;
    this.external = null;
    if (!this.stale) return; // a request already resynced
    if (ext.all) {
      this.resyncIfStale();
      this.emitStatus();
      return;
    }
    this.stale = false;
    this.keyIndex.invalidate();
    const keys: string[] = [];
    for (const id of ext.nodes) {
      if (!idTaken(id)) continue;
      keys.push(`node:${id}`, `anim:${id}`);
    }
    if (keys.length === 0) return;
    let events: Event[];
    try {
      events = this.builder.build(keys, new Map(), new Map());
    } catch {
      // Cannot describe it incrementally: the mirror refetches.
      this.stale = true;
      this.resyncIfStale();
      return;
    }
    if (events.length === 0) return;
    const prev = this.docRevision;
    this.docRevision += 1;
    this.emitBatch(prev, this.docRevision, events);
    this.emitStatus();
  }

  /**
   * Answer a query synchronously when no request is running (the in-process
   * backend's fast path for the document mirror, B4): the document is then
   * exactly at `documentRevision` and every event up to it has been delivered.
   * Null while a request is in flight — ask asynchronously then.
   */
  querySync<T extends QueryType>(query: QueryOf<T>): EngineResult<QueryResults[T]> | null {
    if (this.inFlight > 0 || this.applying > 0 || this.closed) return null;
    this.flushExternal();
    try {
      const { type: _type, ...value } = runQuery(query, this.queryCtx()) as unknown as Record<string, unknown>;
      return { ok: true, value: value as unknown as QueryResults[T], revision: this.docRevision };
    } catch (err) {
      return { ok: false, error: toEngineError(err), revision: this.docRevision };
    }
  }

  /**
   * Run `fn` with the external-change detector held: the document changes it
   * makes are NOT a write around the engine. Only for code that restores the
   * document exactly before returning — the off-document builders
   * (offDocument.ts), whose net change reaches the document as a command.
   */
  holdDetection<T>(fn: () => T): T {
    this.applying += 1;
    try {
      return fn();
    } finally {
      this.applying -= 1;
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // A gesture still open when the client goes away is COMMITTED (§5.1).
    if (this.gesture) await this.execute({ type: 'endGesture', gesture: this.gesture.id, commit: true });
    for (const d of this.busDisposers) d.dispose();
    this.busDisposers = [];
    this.closed = true;
  }

  /**
   * Resolves when no request is queued or running — including requests that
   * were sent by continuations of earlier ones (a gesture's next message).
   */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const q = this.queue;
      await q;
      // Let continuations of the answered requests send their follow-ups.
      for (let k = 0; k < 20; k++) await Promise.resolve();
      if (q === this.queue) return;
    }
  }

  /** Attach (or replace) the file/media ports — the app attaches its real ones at boot. */
  attachPorts(ports: EnginePorts): void {
    this.options.ports = ports;
  }

  /**
   * Drop this instance because the DOCUMENT under it was replaced (the app
   * opened/created/closed a project around the API): unlike `close`, an open
   * gesture is abandoned, not committed — its entry would describe the old
   * document and land on the new one's freshly reset history.
   */
  dispose(): void {
    this.gesture = null;
    for (const d of this.busDisposers) d.dispose();
    this.busDisposers = [];
    this.listeners.clear();
    this.closed = true;
  }

  request(req: Request): Promise<Response> {
    const run = async (): Promise<Response> => {
      const r = this.options.wire ? roundTrip('Request', req) : req;
      this.inFlight += 1;
      let res: Response;
      try {
        res = await this.handle(r);
      } finally {
        this.inFlight -= 1;
      }
      return this.options.wire ? roundTrip('Response', res) : res;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** The recorded log since the last reset (§12), with the header a replay starts from. */
  commandLog(): CommandLogData {
    return { header: this.logHeader ?? this.makeHeader(), records: this.log.map((r) => deepCopy(r)) };
  }

  /** Start a fresh log at the current document (the header captures it and the id counters). */
  startLog(): void {
    this.log = [];
    this.logHeader = this.makeHeader();
  }

  /**
   * Replace the document with `doc` (a log header, a test fixture, an opened
   * file): clears history, reseeds or restores the id counters, and emits
   * `documentReset`. `resetWorkspace` = New/Open semantics (tabs, timelines,
   * session assets reset first).
   */
  loadDocument(doc: EditorDocument, opts: { ids?: IdCounters; revision?: Revision; reason?: ResetReason; resetWorkspace?: boolean } = {}): void {
    this.applying += 1;
    try {
      if (opts.resetWorkspace) {
        // New/Open semantics, minus dropping the session's footage: the
        // document's own item list decides which items the project holds.
        useProjectStore.getState().actions.resetTabs();
        getTimelineController().reset();
      }
      restoreDocument(structuredClone(doc));
      if (opts.resetWorkspace) this.lastMissing = this.reconcileItems();
      this.clearHistoryStacks();
      this.ensureTimelines();
    } finally {
      this.applying -= 1;
    }
    this.gesture = null;
    if (opts.ids) this.ids.restore(opts.ids);
    else this.seedIds();
    this.keyIndex.invalidate();
    this.builder.reset();
    this.stale = false;
    this.external = null;
    const from = this.docRevision;
    this.docRevision = opts.revision ?? this.docRevision + 1;
    this.savedRevision = this.docRevision;
    this.emitBatch(from, this.docRevision, [{ type: 'documentReset', revision: this.docRevision, reason: opts.reason ?? 'opened' }]);
    this.emitStatus();
  }

  private lastMissing: string[] = [];

  /**
   * The project's items are the ones its document lists. Footage the session
   * holds that the document does not list leaves the project; listed footage
   * the session does not hold is reported missing (AE's missing footage).
   */
  private reconcileItems(): string[] {
    // What `restoreDocument` APPLIED, not the file's key: a document written
    // before items existed carries none, and reading its absent key as "the
    // project lists nothing" emptied the item list and the folders on every
    // open of an older file (and of every bundle, which dropped the key).
    const stated = getDocumentItems() ?? { folders: [], footage: {} };
    const listed = stated.footage;
    const store = useAssetStore.getState();
    const keep = store.assets.filter((a) => a.id in listed);
    const missing = Object.keys(listed).filter((id) => !keep.some((a) => a.id === id));
    // Missing footage stays an ITEM (AE): a placeholder record with no bytes
    // (`src` empty → ItemInfo.missing), so the project still lists it and a
    // later relink or library hydration fills it in.
    const placeholders = missing.map((id) => {
      const r = listed[id]!;
      return {
        id, name: r.name ?? id, type: r.type ?? 'video', src: '', size: 0,
        ...(r.path ? { path: r.path } : {}), ...(r.folderId ? { folderId: r.folderId } : {}),
        ...(r.interpret ? { interpret: { ...r.interpret } } : {}), ...(r.label ? { label: r.label } : {}),
        ...(r.tags ? { tags: [...r.tags] } : {}), ...(r.comment ? { comment: r.comment } : {}),
      };
    });
    if (placeholders.length > 0 || keep.length !== store.assets.length) {
      replaceProjectItems({ assets: [...keep, ...placeholders], folders: stated.folders });
    }
    return missing;
  }

  /** Undo/redo of one of this engine's entries — called by HistoryService (engine undo, or the app's Ctrl+Z). */
  replayEntry(entry: EngineHistoryEntry, dir: 'undo' | 'redo'): void {
    const target = dir === 'undo' ? entry.before : entry.after;
    const from = dir === 'undo' ? entry.after : entry.before;
    this.applying += 1;
    try {
      applyParts(target);
    } finally {
      this.applying -= 1;
    }
    this.keyIndex.invalidate();
    const keys = [...target.keys()];
    if (this.jump) {
      // jumpToHistory: every step folds into ONE revision (ENGINE_API.md §8.1 —
      // one revision per request); first-seen "from", last-seen "to" per part.
      for (const k of keys) {
        if (!this.jump.from.has(k)) this.jump.from.set(k, from.get(k));
        this.jump.to.set(k, target.get(k));
      }
      return;
    }
    const prev = this.docRevision;
    this.docRevision += 1;
    const events = this.builder.build(keys, from, target);
    this.emitBatch(prev, this.docRevision, events);
    this.emitStatus();
  }

  // ── Request handling ────────────────────────────────────────────────

  private async handle(req: Request): Promise<Response> {
    this.noteRevision(this.docRevision);
    this.currentSeq = req.seq;
    this.currentOrigin = req.origin;
    try {
      if (req.baseRevision !== undefined && req.baseRevision !== this.docRevision) {
        fail('conflict', `the document is at revision ${this.docRevision}, not ${req.baseRevision}`, { detail: JSON.stringify({ revision: this.docRevision }) });
      }
      if (req.body.kind !== 'query') {
        this.ensureTimelines();
        this.resyncIfStale();
      }
      switch (req.body.kind) {
        case 'query': {
          const value = runQuery(req.body.value, this.queryCtx());
          return this.respond(req, { kind: 'query', value });
        }
        case 'command': {
          const value = await this.command(req.body.value, req.origin);
          this.record(req);
          return this.respond(req, { kind: 'command', value });
        }
        case 'batch': {
          const results = await this.batchEdit(req.body.value.label, req.body.value.commands, req.origin);
          this.record(req);
          return this.respond(req, { kind: 'batch', value: { results } });
        }
      }
    } catch (err) {
      return this.respond(req, { kind: 'error', value: toEngineError(err) });
    } finally {
      this.flushPendingBatch();  // normally already flushed by respond()
      this.currentSeq = undefined;
    }
  }

  private respond(req: Request, outcome: Response['outcome']): Response {
    // Events before the response: the request's one batch reaches subscribers
    // before the caller's await resumes (ENGINE_API.md §8.1).
    this.flushPendingBatch();
    this.noteRevision(this.docRevision);
    return { seq: req.seq, revision: this.docRevision, outcome };
  }

  private flushPendingBatch(): void {
    const b = this.pendingBatch;
    this.pendingBatch = null;
    if (b) this.deliver(b);
  }

  private record(req: Request): void {
    if (!this.options.recordLog) return;
    this.log.push({
      request: deepCopy(req),
      revisionAfter: this.docRevision,
      documentHash: this.options.hashes ? documentHash() : 0,
    });
  }

  private makeHeader(): LogHeader {
    return { document: structuredClone(captureDocument()), ids: this.ids.state(), revision: this.docRevision };
  }

  private seedIds(): void {
    this.ids.reset();
    this.ids.seedKeyframes(allKeyframeIds());
  }

  /**
   * Every composition's timeline exists before a command runs. The timeline is
   * a lazily built mirror in the TS engine; built INSIDE a command it would be
   * captured as created-by-the-command and undo could not un-build it. Not a
   * document change (structural mirror), so it is not an edit either.
   */
  private ensureTimelines(): void {
    const c = getTimelineController();
    this.applying += 1;
    try {
      for (const comp of compItemIds()) if (!c.peekTimeline(comp)) c.timelineForComp(comp);
    } finally {
      this.applying -= 1;
    }
  }

  private resyncIfStale(): void {
    if (!this.stale) return;
    this.stale = false;
    this.external = null;
    this.keyIndex.invalidate();
    this.builder.reset();
    const from = this.docRevision;
    this.docRevision += 1;
    this.emitBatch(from, this.docRevision, [{ type: 'documentReset', revision: this.docRevision, reason: 'resync' }]);
  }

  private async command(cmd: Command, origin: Origin): Promise<CommandResult> {
    const info = COMMANDS[cmd.type];
    if (!info) fail('unsupported', `unknown command '${(cmd as { type: string }).type}'`);
    if (info.kind === 'edit') {
      const results = await this.runEdits([cmd], origin, null);
      return results[0]!;
    }
    const value = await this.control(cmd, origin);
    return { type: cmd.type, ...value } as CommandResult;
  }

  private async batchEdit(label: string, commands: Command[], origin: Origin): Promise<CommandResult[]> {
    commands.forEach((c, i) => {
      const info = COMMANDS[c.type];
      if (!info) fail('unsupported', `unknown command '${(c as { type: string }).type}'`, { commandIndex: i });
      if (info.kind !== 'edit') fail('invalidArgument', `'${c.type}' is a ${info.kind} command and cannot be part of a batch`, { commandIndex: i });
    });
    if (commands.length === 0) return [];
    return this.runEdits(commands, origin, label);
  }

  private handlerCtx(origin: Origin): HandlerCtx {
    const ids = this.ids;
    const keyIndex = this.keyIndex;
    return {
      origin,
      ids,
      ports: this.options.ports ?? {},
      time: this.transport.time,
      keys: keyIndex,
      mintId: (prefix) => ids.next(prefix, idTaken),
      mintGroupId: (prefix, taken) => ids.next(prefix, taken),
      mintKeyId: () => ids.nextKeyframe((id) => keyIndex.has(id)),
      mintMarkerId: () => ids.next('mk', (id) => keyIndex.markerTaken(id)),
    };
  }

  /**
   * Apply edit commands atomically: validate + apply one after another,
   * accumulating the first-seen before and last-seen after of every part; on a
   * failure restore every before and report the failing index.
   */
  private async runEdits(commands: Command[], origin: Origin, batchLabel: string | null): Promise<CommandResult[]> {
    const ctx = this.handlerCtx(origin);
    const before: Parts = new Map();
    const after: Parts = new Map();
    const results: CommandResult[] = [];
    const store = useHistoryStore.getState();
    const history = this.history();
    const fullBefore = this.options.verifyScopes ? captureScope(documentScope()) : null;
    let label = batchLabel ?? '';
    store.flush();
    let failure: { error: EngineError } | null = null;
    this.applying += 1;
    history?.suspend();
    try {
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]!;
        const handler = EDIT_HANDLERS[cmd.type] as ((c: Command, x: HandlerCtx) => Plan<Record<string, unknown>>) | undefined;
        if (!handler) fail('unsupported', `'${cmd.type}' is not implemented by this engine`, { commandIndex: commands.length > 1 ? i : undefined });
        let plan: Plan<Record<string, unknown>>;
        try {
          plan = handler(cmd, ctx);
          if (plan.prepare) await plan.prepare();
        } catch (err) {
          failure = { error: withIndex(toEngineError(err), commands.length > 1 || batchLabel !== null ? i : undefined) };
          break;
        }
        const scope: Scope = plan.scope;
        const b = captureScope(scope);
        let result: Record<string, unknown>;
        try {
          useHistoryStore.setState({ restoring: true });
          result = plan.apply();
          stampMissingKeyIds(scope, ctx.mintKeyId);
          syncTimelines();
        } catch (err) {
          applyParts(b);
          failure = { error: withIndex(toEngineError(err), commands.length > 1 || batchLabel !== null ? i : undefined) };
          break;
        } finally {
          useHistoryStore.setState({ restoring: false });
        }
        const a = captureScope(scope);
        for (const [k, v] of b) if (!before.has(k)) before.set(k, v);
        // A key only the AFTER capture has did not exist before this command
        // (document scope enumerates the parts that exist). Its first-seen
        // before is "absent" — a later command's before capture must not make
        // it look pre-existing, or undoing the batch keeps what the earlier
        // commands created (two createComposition in one batch left the first).
        for (const k of a.keys()) if (!before.has(k)) before.set(k, undefined);
        for (const [k, v] of a) after.set(k, v);
        // …and a key only the BEFORE capture has is gone after it: its
        // last-seen after is "absent", not what an earlier command's after
        // capture saw (an editWorkArea removing a layer after another comp's
        // editWorkArea left the layer in the batch's after → no layersRemoved,
        // and undo did not restore it).
        for (const k of b.keys()) if (!a.has(k)) after.set(k, undefined);
        results.push({ type: cmd.type, ...result } as CommandResult);
        if (!batchLabel) label = plan.label ?? humanize(cmd.type);
        this.keyIndex.invalidate();
      }
      if (failure) {
        this.applyQuiet(before);
      } else if (this.options.legacyUiRefresh) {
        this.refreshUi(changedKeys(before, after));
      }
    } finally {
      history?.resume();
      this.applying -= 1;
      // Re-baseline the debounce recorder on what the engine wrote (no entry).
      store.runRestoring(() => {});
    }
    if (failure) throw new EngineFail(failure.error);

    const changed = changedKeys(before, after);
    if (fullBefore) {
      const fullAfter = captureScope(documentScope());
      const all = changedKeys(fullBefore, fullAfter);
      const inScope = new Set(changed);
      const outside = all.filter((k) => !inScope.has(k) && !(before.has(k) && after.has(k)));
      if (outside.length > 0) {
        throw new EngineFail({ code: 'internal', message: `scope violation: ${commands.map((c) => c.type).join(',')} changed ${outside.join(', ')} outside its declared scope` });
      }
    }
    if (changed.length === 0) return results;

    const b: Parts = new Map(changed.map((k) => [k, before.get(k)]));
    const a: Parts = new Map(changed.map((k) => [k, after.get(k)]));
    const prev = this.docRevision;
    this.docRevision += 1;
    if (this.gesture) {
      for (const [k, v] of b) if (!this.gesture.before.has(k)) this.gesture.before.set(k, v);
      for (const [k, v] of a) this.gesture.after.set(k, v);
    } else {
      const entry = new EngineHistoryEntry(this, label, origin, b, a);
      this.pushEntry(entry);
    }
    const events = this.builder.build(changed, b, a);
    this.emitBatch(prev, this.docRevision, events);
    this.emitStatus();
    return results;
  }

  private applyQuiet(parts: Parts): void {
    if (parts.size === 0) return;
    useHistoryStore.setState({ restoring: true });
    try {
      applyParts(parts);
    } finally {
      useHistoryStore.setState({ restoring: false });
    }
    this.keyIndex.invalidate();
  }

  /** Legacy bus/revision announcements for what just changed (legacyRefresh.ts), recorder held. */
  private refreshUi(keys: string[]): void {
    if (keys.length === 0) return;
    const prev = useHistoryStore.getState().restoring;
    useHistoryStore.setState({ restoring: true });
    try {
      refreshLegacyUi(keys);
    } catch {
      // A panel listener's failure must not fail a command that already applied.
    } finally {
      useHistoryStore.setState({ restoring: prev });
    }
  }

  private pushEntry(entry: EngineHistoryEntry): void {
    const history = this.history();
    if (!history) return;
    const store = useHistoryStore.getState();
    // Pushed inside runRestoring so the baseline sync does not capture again.
    store.runRestoring(() => history.push(entry));
  }

  private history(): HistoryService | null {
    if (this.options.history) return this.options.history();
    try {
      return getCommandSystem().getHistory();
    } catch {
      return null;
    }
  }

  private clearHistoryStacks(): void {
    const h = this.history();
    if (!h) return;
    h.clear();
    useHistoryStore.getState().runRestoring(() => {});
  }

  // ── Controls and io ─────────────────────────────────────────────────

  private async control(cmd: Command, origin: Origin): Promise<Record<string, unknown>> {
    switch (cmd.type) {
      case 'undo':
      case 'redo':
        return this.historyStep(cmd.type);
      case 'jumpToHistory': {
        if (this.gesture) fail('gestureOpen', 'close the gesture before moving through history');
        const h = this.requireHistory();
        const entries = h.getEntries();
        if (cmd.position > entries.length) fail('outOfRange', `history has ${entries.length} entries`);
        const target = cmd.position - 1;
        let label = '';
        const store = useHistoryStore.getState();
        store.flush();
        // One revision for the whole jump, like the C++ engine (replayEntry folds
        // the steps into `this.jump`; a foreign entry still resyncs on its own).
        this.jump = { from: new Map(), to: new Map() };
        try {
          while (h.getIndex() > target) {
            const top = entries[h.getIndex()]!;
            label = top.label;
            this.moveHistory(h, 'undo');
          }
          while (h.getIndex() < target) {
            const next = h.getEntries()[h.getIndex() + 1]!;
            label = next.label;
            this.moveHistory(h, 'redo');
          }
        } finally {
          const jump = this.jump;
          this.jump = null;
          const keys = changedKeys(jump.from, jump.to);
          if (keys.length > 0) {
            const prev = this.docRevision;
            this.docRevision += 1;
            this.emitBatch(prev, this.docRevision, this.builder.build(keys, jump.from, jump.to));
            this.emitStatus();
          }
        }
        return { label, position: h.getIndex() + 1 };
      }
      case 'beginGesture': {
        if (this.gesture) fail('gestureOpen', `gesture '${this.gesture.label}' is already open`);
        useHistoryStore.getState().flush();
        // The id comes from the id state (ids.ts), so a log header carries it.
        const id = this.ids.nextGesture();
        this.gesture = { id, label: cmd.label, origin, before: new Map(), after: new Map(), startRevision: this.docRevision };
        this.emitStatus();
        return { gesture: id };
      }
      case 'endGesture': {
        const g = this.gesture;
        if (!g) fail('noGesture', 'no gesture is open');
        if (cmd.gesture !== 0 && cmd.gesture !== g.id) fail('invalidArgument', `gesture ${cmd.gesture} is not the open gesture (${g.id})`);
        this.gesture = null;
        const changed = changedKeys(g.before, g.after);
        if (changed.length === 0) {
          this.emitStatus();
          return {};
        }
        const b: Parts = new Map(changed.map((k) => [k, g.before.get(k)]));
        const a: Parts = new Map(changed.map((k) => [k, g.after.get(k)]));
        if (cmd.commit) {
          this.pushEntry(new EngineHistoryEntry(this, g.label, g.origin, b, a));
        } else {
          // Esc: every edit of the gesture reverts; a new revision with events.
          this.applying += 1;
          const history = this.history();
          history?.suspend();
          try {
            this.applyQuiet(b);
            if (this.options.legacyUiRefresh) this.refreshUi(changed);
          } finally {
            history?.resume();
            this.applying -= 1;
            useHistoryStore.getState().runRestoring(() => {});
          }
          const prev = this.docRevision;
          this.docRevision += 1;
          this.emitBatch(prev, this.docRevision, this.builder.build(changed, a, b));
        }
        this.emitStatus();
        return {};
      }
      case 'clearHistory':
        if (this.gesture) fail('gestureOpen', 'close the gesture first');
        this.clearHistoryStacks();
        this.emitStatus();
        return {};
      case 'setHistoryLimit':
        if (!(cmd.entries > 0)) fail('outOfRange', 'the history limit must be at least 1');
        this.requireHistory().setCapacity(cmd.entries);
        this.emitStatus();
        return {};
      case 'setAutosave':
        this.autosave = { enabled: cmd.enabled, intervalSeconds: cmd.intervalSeconds, keep: cmd.keep };
        return {};
      case 'newProject': {
        if (this.gesture) fail('gestureOpen', 'close the gesture first');
        this.loadDocument(projectDocumentIO.createEmpty('Untitled'), { reason: 'created', resetWorkspace: true });
        this.projectPath = '';
        this.emitStatus();
        return {};
      }
      case 'openProject': {
        if (this.gesture) fail('gestureOpen', 'close the gesture first');
        const port = this.options.ports?.readProject;
        if (!port) fail('unsupported', 'no project file port is attached to this engine');
        let doc: EditorDocument;
        try {
          doc = await port(cmd.path);
        } catch (err) {
          fail('io', `could not read '${cmd.path}': ${err instanceof Error ? err.message : String(err)}`);
        }
        this.loadDocument(doc, { reason: 'opened', resetWorkspace: true });
        this.projectPath = cmd.path;
        this.emitStatus();
        return { warnings: [], missingItems: [...this.lastMissing] };
      }
      case 'revertProject': {
        if (this.gesture) fail('gestureOpen', 'close the gesture first');
        const port = this.options.ports?.readProject;
        if (!port || !this.projectPath) fail('unsupported', 'nothing to revert to: no saved project path or file port');
        const doc = await port(this.projectPath);
        this.loadDocument(doc, { reason: 'reverted', resetWorkspace: true });
        return {};
      }
      case 'saveProject': {
        const port = this.options.ports?.writeProject;
        if (!port) fail('unsupported', 'no project file port is attached to this engine');
        const path = cmd.path ?? this.projectPath;
        if (!path) fail('invalidArgument', 'the project has no path yet; pass one');
        let bytes = 0;
        try {
          bytes = (await port(path, captureDocument())).bytes;
        } catch (err) {
          fail('io', `could not write '${path}': ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!cmd.copy) {
          this.projectPath = path;
          this.savedRevision = this.docRevision;
          this.emitEphemeral([{ type: 'projectSaved', path, revision: this.docRevision }]);
          this.emitStatus();
        }
        return { path, bytes };
      }
      case 'collectFiles': {
        const port = this.options.ports?.collectFiles;
        if (!port) fail('unsupported', 'no collect-files port is attached to this engine');
        const r = await port(cmd.folder, captureDocument(), cmd.onlyUsed);
        return { path: r.path, bytes: r.bytes };
      }
      case 'reloadItems':
        // Re-reading from disk is not a document change; the asset store
        // re-probes on its own schedule until media moves into the engine (E1).
        return {};
      case 'startJob':
        return fail('unsupported', `jobs run in the editor today (tracking, stabilize, object matte, transcription, render); the ${cmd.job.kind} job moves into the engine in phase E/F`);
      case 'cancelJob':
        return fail('notFound', `no job '${cmd.job}'`);
      case 'setPluginEnabled':
        return this.transport.setPluginEnabled(cmd.plugin, cmd.enabled);
      default: {
        // Transport never edits the document; bus noise it causes (a seek
        // re-rendering, a tab playhead commit) must not read as an external edit.
        this.applying += 1;
        try {
          return this.transport.handle(cmd);
        } finally {
          this.applying -= 1;
        }
      }
    }
  }

  private requireHistory(): HistoryService {
    const h = this.history();
    if (!h) fail('unsupported', 'no history service is attached');
    return h;
  }

  private historyStep(dir: 'undo' | 'redo'): Record<string, unknown> {
    if (this.gesture) fail('gestureOpen', `'${dir}' is refused while a gesture is open`);
    const h = this.requireHistory();
    useHistoryStore.getState().flush();
    const entries = h.getEntries();
    if (dir === 'undo' && !h.canUndo()) fail('nothingToUndo', 'nothing to undo');
    if (dir === 'redo' && !h.canRedo()) fail('nothingToRedo', 'nothing to redo');
    const entry = dir === 'undo' ? entries[h.getIndex()]! : entries[h.getIndex() + 1]!;
    this.moveHistory(h, dir);
    return { label: entry.label, position: h.getIndex() + 1 };
  }

  /** One step through the shared stack; a non-engine entry leaves the mirror stale → resync. */
  private moveHistory(h: HistoryService, dir: 'undo' | 'redo'): void {
    const entries = h.getEntries();
    const entry = dir === 'undo' ? entries[h.getIndex()] : entries[h.getIndex() + 1];
    const foreign = !(entry instanceof EngineHistoryEntry);
    const store = useHistoryStore.getState();
    this.applying += 1;
    try {
      store.runRestoring(() => (dir === 'undo' ? h.undo() : h.redo()));
    } finally {
      this.applying -= 1;
    }
    if (foreign) {
      this.stale = true;
      this.resyncIfStale();
    }
    this.emitStatus();
  }

  // ── Events ──────────────────────────────────────────────────────────

  private emitBatch(from: Revision, to: Revision, events: Event[]): void {
    if (events.length === 0 && from === to) return;
    if (this.currentSeq !== undefined) {
      // Inside a request: ONE EventBatch per request (§8.1) — the revisioned
      // change and the status events (history, dirty, transport) ride together,
      // exactly as the C++ engine sends them.
      const p = this.pendingBatch;
      if (p) {
        p.toRevision = Math.max(p.toRevision, to);
        p.events.push(...events);
        return;
      }
      this.pendingBatch = { fromRevision: from, toRevision: to, events: [...events], causedBy: this.currentSeq, origin: this.currentOrigin };
      return;
    }
    const batch: EventBatch = {
      fromRevision: from,
      toRevision: to,
      events,
      ...(this.currentSeq !== undefined ? { causedBy: this.currentSeq } : {}),
      origin: this.currentSeq !== undefined ? this.currentOrigin : 'engine',
    };
    this.deliver(batch);
  }

  private emitEphemeral(events: Event[]): void {
    if (events.length === 0) return;
    this.emitBatch(this.docRevision, this.docRevision, events);
  }

  private deliver(batch: EventBatch): void {
    this.noteRevision(batch.toRevision);
    const b = this.options.wire ? roundTrip('EventBatch', batch) : batch;
    for (const l of [...this.listeners]) {
      try {
        l(b);
      } catch {
        // A subscriber's failure never breaks the engine or other subscribers.
      }
    }
  }

  historyState(): HistoryState {
    const h = this.history();
    const entries = h?.getEntries() ?? [];
    return {
      entries: entries.map((e) => ({ label: e.label, origin: e instanceof EngineHistoryEntry ? e.origin : 'ui' })),
      position: h ? h.getIndex() + 1 : 0,
      canUndo: h?.canUndo() ?? false,
      canRedo: h?.canRedo() ?? false,
      gestureOpen: this.gesture !== null,
      limit: h?.getCapacity() ?? 0,
    };
  }

  private emitStatus(): void {
    const state = this.historyState();
    const h = this.history();
    const entries = h?.getEntries() ?? [];
    const idx = h ? h.getIndex() : -1;
    this.emitEphemeral([
      { type: 'historyChanged', state, undoLabel: entries[idx]?.label ?? '', redoLabel: entries[idx + 1]?.label ?? '' },
      { type: 'dirtyChanged', dirty: this.docRevision !== this.savedRevision, projectPath: this.projectPath },
    ]);
  }

  private queryCtx(): QueryCtx {
    return {
      revision: this.docRevision,
      projectPath: this.projectPath,
      dirty: this.docRevision !== this.savedRevision,
      history: () => this.historyState(),
      log: (from) => this.log.filter((r) => r.revisionAfter > from).map((r) => deepCopy(r)),
      transport: this.transport,
      keyIndex: this.keyIndex,
    };
  }
}

/**
 * Deep copy that keeps byte arrays as byte arrays (a JSON-based structuredClone
 * polyfill, as some test environments install, turns them into plain objects).
 */
function deepCopy<T>(v: T): T {
  if (v instanceof Uint8Array) return new Uint8Array(v) as unknown as T;
  if (Array.isArray(v)) return v.map(deepCopy) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deepCopy(x);
    return out as T;
  }
  return v;
}

function withIndex(e: EngineError, index: number | undefined): EngineError {
  return index === undefined || e.commandIndex !== undefined ? e : { ...e, commandIndex: index };
}

function roundTrip<T>(name: 'Request' | 'Response' | 'EventBatch', v: T): T {
  const codec = codecs[name] as unknown as { encode(x: T): Uint8Array; decode(b: Uint8Array): T };
  // encode() returns a view of the codec's SHARED writer, and decode() returns
  // bytes fields as views of its input: copy, or the next encode rewrites them.
  return codec.decode(codec.encode(v).slice());
}

export type { CommandType, Query, QueryResult };
