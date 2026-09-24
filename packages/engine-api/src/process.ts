/**
 * ProcessEngineClient — the `EngineClient` backend that talks to the C++
 * engine process `premation-engine` (docs/NATIVE_CORE_PLAN.md §5 C3).
 *
 *   page ──EngineBridge (preload, IPC)──▶ Electron main (EngineSupervisor) ──pipes──▶ premation-engine
 *
 * The bridge carries ENCODED EngineMessages both ways (main is a relay and
 * never decodes a document); this class owns the codec, so it needs nothing
 * from `src/` and is interchangeable with the TypeScript backend
 * (src/core/engine/LocalEngine.ts) behind `EngineClient`.
 *
 * What it adds over a plain wire client:
 *
 *  - **§8.2 revision rule** on every event batch: `fromRevision` ahead of the
 *    mirror = a gap → drop it and resync (a `documentReset{resync}` at the
 *    engine's revision); an already-applied revisioned batch is ignored.
 *    `revision` (the base class's) is the newest revision seen anywhere;
 *    `eventRevision` is what subscribers have been given — kept apart so a
 *    response that overtakes its events can never make them look stale.
 *  - **Crash recovery.** It records a command log exactly as the TS engine
 *    does (`LogRecord` per applied non-query request, ENGINE_API.md §12). When
 *    the supervisor reports `engine-restarted` the fresh engine is EMPTY; the
 *    log is replayed into it (ids are deterministic in the engine, so the same
 *    requests mint the same ids) before any new request is sent, then
 *    subscribers get one `documentReset{engineRestarted}`. Requests made
 *    meanwhile wait, in order.
 *  - **Fallback.** When the supervisor gives up (crash loop, no GPU, protocol
 *    mismatch, engine missing) every later request goes to the TypeScript
 *    backend `options.fallback()`, its events are forwarded, and the reason is
 *    surfaced ONCE through `onNotice`.
 *
 * Copy discipline: `encodeEngineMessage` returns bytes the bridge may retain
 * or transfer, so each request is encoded into its own buffer (`slice`).
 */

import type {
  EngineMessage,
  EventBatch,
  LogRecord,
  Request,
  Response,
  Revision,
} from './generated/types';
import { decodeEngineMessage, encodeEngineMessage } from './generated/codec';
import { EngineClientBase, engineError, type EngineClient, type EventListener } from './client';

// ── the bridge (what the preload exposes as `window.motionEditor.engine`) ──

export type EngineHostState = 'disabled' | 'stopped' | 'starting' | 'running' | 'restarting' | 'stopping' | 'fallback';

export interface EngineHostStatus {
  /** The process backend is switched on (PREMATION_ENGINE=process or the preference). */
  enabled: boolean;
  state: EngineHostState;
  engine?: string;
  engineVersion?: string;
  /** Revision the engine reported at its last handshake. */
  revision?: number;
  fallbackReason?: string;
  /** F2: the engine owns the document — the editor's lifecycle goes through engine requests. */
  ownsDocument?: boolean;
}

export type EngineWireReply =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'gone' | 'disabled' | 'invalid'; message: string };

export interface EngineRestartNotice {
  attempt: number;
  cause: 'crash' | 'hang' | 'requested';
  exitCode: number | null;
  signal: string | null;
  logTail: string[];
}

export interface EngineFallbackNotice {
  reason: string;
  logTail: string[];
}

/** One frame from the engine's shared-texture ring, as the preload hands it to the page. */
export interface EngineFrameMeta {
  viewport: number;
  generation: number;
  slot: number;
  frame: number;
  /** Comp time, flicks. */
  time: number;
  revision: number;
  width: number;
  height: number;
  dropped: number;
  renderStartUs: number;
  renderDoneUs: number;
  /** Epoch µs when main handed the frame to Chromium (measurement only). */
  sentUs: number;
}

/** Receives a frame; must call `release()` exactly once when done (after drawing). */
export type EngineFrameConsumer = (frame: VideoFrameLike, meta: EngineFrameMeta, release: () => void) => void;

/** The subset of WebCodecs' VideoFrame the consumer needs (the page gets a real VideoFrame). */
export interface VideoFrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}

export interface EngineBridge {
  request(bytes: Uint8Array): Promise<EngineWireReply>;
  status(): Promise<EngineHostStatus>;
  onEvents(handler: (bytes: Uint8Array) => void): () => void;
  onState(handler: (state: EngineHostState) => void): () => void;
  onRestarted(handler: (info: EngineRestartNotice) => void): () => void;
  onFallback(handler: (info: EngineFallbackNotice) => void): () => void;
  /** Frames from the shared-texture ring (null stops). Absent outside Electron. */
  onFrame?(consumer: EngineFrameConsumer | null): void;
}

// ── notices ──

export type ProcessEngineNotice =
  | { kind: 'restarted'; attempt: number; cause: EngineRestartNotice['cause']; replayed: number; mismatches: number; ms: number }
  | { kind: 'fallback'; reason: string };

export interface ProcessEngineOptions {
  /** The TypeScript backend to switch to when the process backend gives up. */
  fallback?: () => EngineClient;
  /** Restart / fallback notices for the UI (a toast). Fallback is reported once. */
  onNotice?: (notice: ProcessEngineNotice) => void;
  /** Keep the command log for crash recovery (default true). */
  recordLog?: boolean;
}

/** Transport commands a crash-recovery replay skips: the clock restarts stopped. */
const REPLAY_SKIP = new Set(['play', 'pause', 'step']);

type Mode = 'connecting' | 'ready' | 'recovering' | 'fallback' | 'closed';

function deepCopy<T>(v: T): T {
  return structuredClone(v);
}

function errorResponse(seq: number, revision: Revision, code: Parameters<typeof engineError>[0], message: string): Response {
  return { seq, revision, outcome: { kind: 'error', value: engineError(code, message) } };
}

export class ProcessEngineClient extends EngineClientBase {
  private mode: Mode = 'connecting';
  private readonly listeners = new Set<EventListener>();
  private readonly disposers: Array<() => void> = [];
  private waiters: Array<() => void> = [];
  private eventRevisionValue: Revision = 0;
  private log: LogRecord[] = [];
  private suppressEvents = false;
  private recoveryGen = 0;
  private resyncing = false;
  private fallbackClient: EngineClient | null = null;
  private fallbackUnsub: (() => void) | null = null;
  private fallbackNoticeSent = false;
  private lastRestart: { replayed: number; mismatches: number; ms: number } | null = null;
  /** Seqs for the client's own queries: far above the base class's counter, never in flight twice. */
  private internalSeq = 2 ** 50;

  constructor(
    private readonly bridge: EngineBridge,
    private readonly options: ProcessEngineOptions = {},
  ) {
    super();
    this.disposers.push(
      bridge.onEvents((bytes) => this.onEventBytes(bytes)),
      bridge.onState((s) => this.onHostState(s)),
      bridge.onRestarted((info) => void this.recover(info)),
      bridge.onFallback((info) => this.switchToFallback(info.reason)),
    );
    void this.connect();
  }

  /** The revision subscribers have been brought to (the mirror's revision, §8.2). */
  get eventRevision(): Revision {
    return this.eventRevisionValue;
  }

  /** Which backend answers now. */
  get backend(): 'process' | 'fallback' | 'pending' | 'closed' {
    if (this.mode === 'fallback') return 'fallback';
    if (this.mode === 'closed') return 'closed';
    return this.mode === 'ready' ? 'process' : 'pending';
  }

  /** The recorded command log (crash recovery; the same format as the TS engine's). */
  commandLog(): LogRecord[] {
    return this.log.map((r) => deepCopy(r));
  }

  /** The last crash recovery's replay numbers (tests, HUD). */
  get lastRecovery(): { replayed: number; mismatches: number; ms: number } | null {
    return this.lastRestart;
  }

  /** Resolves once the backend accepts requests (process ready, or fell back). */
  whenReady(): Promise<void> {
    return this.gate();
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(req: Request): Promise<Response> {
    if (this.mode === 'closed') return errorResponse(req.seq, this.revision, 'cancelled', 'the engine client is closed');
    await this.gate();
    if (this.mode === 'fallback') return this.viaFallback(req);
    if ((this.mode as Mode) === 'closed') return errorResponse(req.seq, this.revision, 'cancelled', 'the engine client is closed');
    const res = await this.wire(req);
    this.noteRevision(res.revision);
    this.record(req, res);
    return res;
  }

  async close(): Promise<void> {
    if (this.mode === 'closed') return;
    for (const d of this.disposers.splice(0)) d();
    this.fallbackUnsub?.();
    this.mode = 'closed';
    this.release();
    this.listeners.clear();
  }

  // ── internals ──

  private nextInternalSeq(): number {
    this.internalSeq += 1;
    return this.internalSeq;
  }

  private gate(): Promise<void> {
    if (this.mode === 'ready' || this.mode === 'fallback' || this.mode === 'closed') return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  private async connect(): Promise<void> {
    let st: EngineHostStatus;
    try {
      st = await this.bridge.status();
    } catch (e) {
      this.switchToFallback(`engine status unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!st.enabled) {
      this.switchToFallback('the engine process backend is switched off');
      return;
    }
    if (st.state === 'fallback') {
      this.switchToFallback(st.fallbackReason ?? 'the engine process is unavailable');
      return;
    }
    if (st.state === 'running') await this.becomeReady('connected');
    // Otherwise onHostState('running') finishes the connection.
  }

  private onHostState(s: EngineHostState): void {
    if (this.mode === 'closed' || this.mode === 'fallback') return;
    if (s === 'restarting' && this.mode === 'ready') {
      this.mode = 'recovering';  // hold requests until the replay (onRestarted) is done
      return;
    }
    if (s === 'running' && this.mode === 'connecting') void this.becomeReady('connected');
  }

  /** Learn the engine's revision, give subscribers a starting point, open the gate. */
  private async becomeReady(why: 'connected' | 'engineRestarted'): Promise<void> {
    const res = await this.wire({ seq: this.nextInternalSeq(), body: { kind: 'query', value: { type: 'getHistory' } }, origin: 'engine' });
    if (this.mode === 'fallback' || this.mode === 'closed') return;
    this.noteRevision(res.revision);
    const rev = res.revision;
    this.eventRevisionValue = rev;
    if (why === 'engineRestarted' || rev > 0) {
      this.deliver({
        fromRevision: rev,
        toRevision: rev,
        events: [{ type: 'documentReset', revision: rev, reason: why === 'engineRestarted' ? 'engineRestarted' : 'resync' }],
        origin: 'engine',
      });
    }
    this.mode = 'ready';
    this.release();
  }

  private async wire(req: Request): Promise<Response> {
    const message: EngineMessage = { kind: 'request', value: req };
    // Own buffer per request: the bridge (IPC) may keep or transfer it.
    const bytes = encodeEngineMessage(message).slice();
    let reply: EngineWireReply;
    try {
      reply = await this.bridge.request(bytes);
    } catch (e) {
      return errorResponse(req.seq, this.revision, 'busy', `engine unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!reply.ok) {
      const code = reply.reason === 'gone' ? 'busy' : reply.reason === 'invalid' ? 'decode' : 'unsupported';
      return errorResponse(req.seq, this.revision, code, reply.message);
    }
    let msg: EngineMessage;
    try {
      msg = decodeEngineMessage(new Uint8Array(reply.bytes));
    } catch (e) {
      return errorResponse(req.seq, this.revision, 'decode', `undecodable response: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (msg.kind !== 'response') return errorResponse(req.seq, this.revision, 'internal', `expected a response, got ${msg.kind}`);
    return msg.value;
  }

  private record(req: Request, res: Response): void {
    if (this.options.recordLog === false) return;
    if (req.body.kind === 'query' || res.outcome.kind === 'error') return;
    if (req.body.kind === 'command' && req.body.value.type === 'newProject') this.log = [];  // nothing before it matters
    this.log.push({ request: deepCopy(req), revisionAfter: res.revision, documentHash: 0 });
  }

  private onEventBytes(bytes: Uint8Array): void {
    let msg: EngineMessage;
    try {
      msg = decodeEngineMessage(new Uint8Array(bytes));
    } catch {
      return;  // an undecodable batch is a gap the next batch will reveal
    }
    if (msg.kind !== 'events') return;
    this.onBatch(msg.value);
  }

  private onBatch(b: EventBatch): void {
    if (this.mode === 'fallback' || this.mode === 'closed') return;  // a stale engine's last words
    this.noteRevision(b.toRevision);
    if (this.suppressEvents || this.mode !== 'ready') {
      // Connecting or replaying: the documentReset that ends it covers these.
      return;
    }
    const revisioned = b.fromRevision !== b.toRevision;
    if (b.fromRevision > this.eventRevisionValue) {
      void this.resync();  // §8.2: a gap — drop and refetch
      return;
    }
    if (revisioned && b.toRevision <= this.eventRevisionValue) return;  // duplicate
    if (b.toRevision > this.eventRevisionValue) this.eventRevisionValue = b.toRevision;
    this.deliver(b);
  }

  private async resync(): Promise<void> {
    if (this.resyncing) return;
    this.resyncing = true;
    try {
      const res = await this.wire({ seq: this.nextInternalSeq(), body: { kind: 'query', value: { type: 'getHistory' } }, origin: 'engine' });
      if (this.mode !== 'ready' || res.outcome.kind === 'error') return;
      this.eventRevisionValue = res.revision;
      this.deliver({
        fromRevision: res.revision,
        toRevision: res.revision,
        events: [{ type: 'documentReset', revision: res.revision, reason: 'resync' }],
        origin: 'engine',
      });
    } finally {
      this.resyncing = false;
    }
  }

  private deliver(b: EventBatch): void {
    for (const l of [...this.listeners]) {
      try {
        l(b);
      } catch {
        // A subscriber's failure never breaks the client or other subscribers.
      }
    }
  }

  /** The engine came back empty: replay the log into it, then reopen the gate. */
  private async recover(info: EngineRestartNotice): Promise<void> {
    if (this.mode === 'fallback' || this.mode === 'closed') return;
    const gen = ++this.recoveryGen;
    this.mode = 'recovering';
    this.suppressEvents = true;
    const t0 = Date.now();
    let replayed = 0;
    let mismatches = 0;
    // View controls only matter as their LAST value (per viewport): replaying
    // every resize would rebuild the frame ring each time.
    const lastControl = new Map<string, number>();
    this.log.forEach((rec, i) => {
      const b = rec.request.body;
      if (b.kind !== 'command') return;
      const c = b.value;
      if (c.type === 'setViewport' || c.type === 'closeViewport') lastControl.set(`viewport:${c.viewport}`, i);
      else if (c.type === 'seek' || c.type === 'setActiveComposition' || c.type === 'setPreviewQuality' || c.type === 'setLoop') lastControl.set(c.type, i);
    });
    const superseded = (i: number): boolean => {
      const b = this.log[i]!.request.body;
      if (b.kind !== 'command') return false;
      const c = b.value;
      const key = c.type === 'setViewport' || c.type === 'closeViewport' ? `viewport:${c.viewport}` : c.type;
      const last = lastControl.get(key);
      // The last one replays at its own place in the log (after whatever it names was created).
      return last !== undefined && last !== i;
    };
    try {
      for (let i = 0; i < this.log.length; i++) {
        const rec = this.log[i]!;
        if (gen !== this.recoveryGen || this.mode !== 'recovering') return;  // crashed again mid-replay
        const body = rec.request.body;
        if (body.kind === 'command' && REPLAY_SKIP.has(body.value.type)) continue;
        if (superseded(i)) continue;
        const res = await this.wire(rec.request);
        replayed += 1;
        if (res.outcome.kind === 'error' || res.revision !== rec.revisionAfter) mismatches += 1;
      }
    } finally {
      if (gen === this.recoveryGen) this.suppressEvents = false;
    }
    if (gen !== this.recoveryGen || this.mode !== 'recovering') return;
    const ms = Date.now() - t0;
    this.lastRestart = { replayed, mismatches, ms };
    await this.becomeReady('engineRestarted');
    this.options.onNotice?.({ kind: 'restarted', attempt: info.attempt, cause: info.cause, replayed, mismatches, ms });
  }

  private switchToFallback(reason: string): void {
    if (this.mode === 'fallback' || this.mode === 'closed') return;
    this.recoveryGen += 1;  // abandon a replay in progress
    this.suppressEvents = false;
    try {
      this.fallbackClient = this.options.fallback?.() ?? null;
    } catch {
      this.fallbackClient = null;  // requests then answer `unsupported`
    }
    this.mode = 'fallback';
    if (this.fallbackClient) {
      const fb = this.fallbackClient;
      this.fallbackUnsub = fb.subscribe((b) => {
        if (b.toRevision > this.eventRevisionValue) this.eventRevisionValue = b.toRevision;
        this.noteRevision(b.toRevision);
        this.deliver(b);
      });
      // The mirror now follows another document: refetch. Revisions are that
      // document's from here on (the base class keeps a max; reset it).
      this.eventRevisionValue = fb.revision;
      this.lastRevision = fb.revision;
      this.deliver({ fromRevision: fb.revision, toRevision: fb.revision, events: [{ type: 'documentReset', revision: fb.revision, reason: 'resync' }], origin: 'engine' });
    }
    if (!this.fallbackNoticeSent) {
      this.fallbackNoticeSent = true;
      this.options.onNotice?.({ kind: 'fallback', reason });
    }
    this.release();
  }

  private viaFallback(req: Request): Promise<Response> {
    const fb = this.fallbackClient;
    if (!fb) return Promise.resolve(errorResponse(req.seq, this.revision, 'unsupported', 'the engine process is unavailable and no fallback engine is attached'));
    return fb.request(req);
  }
}

/** Build the process backend over a bridge (the preload's `motionEditor.engine`). */
export function createProcessEngineClient(bridge: EngineBridge, options: ProcessEngineOptions = {}): ProcessEngineClient {
  return new ProcessEngineClient(bridge, options);
}
