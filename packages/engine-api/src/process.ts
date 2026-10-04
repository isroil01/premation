/**
 * ProcessEngineClient — the `EngineClient` backend that talks to the C++
 * engine process `premation-engine` (docs/NATIVE_CORE_PLAN.md §5 C3).
 *
 *   page ──EngineBridge (preload, IPC)──▶ Electron main (EngineSupervisor) ──pipes──▶ premation-engine
 *
 * The bridge carries ENCODED EngineMessages both ways (main is a relay and
 * never decodes a document); this class owns the codec, so it needs nothing
 * from `src/`.
 *
 * What it adds over a plain wire client:
 *
 *  - **§8.2 revision rule** on every event batch: `fromRevision` ahead of the
 *    mirror = a gap → drop it and resync (a `documentReset{resync}` at the
 *    engine's revision); an already-applied revisioned batch is ignored.
 *    `revision` (the base class's) is the newest revision seen anywhere;
 *    `eventRevision` is what subscribers have been given — kept apart so a
 *    response that overtakes its events can never make them look stale.
 *  - **Crash recovery.** It records a command log (`LogRecord` per applied non-query request, ENGINE_API.md §12). When
 *    the supervisor reports `engine-restarted` the fresh engine is EMPTY; the
 *    log is replayed into it (ids are deterministic in the engine, so the same
 *    requests mint the same ids) before any new request is sent, then
 *    subscribers get one `documentReset{engineRestarted}`. Requests made
 *    meanwhile wait, in order.
 *  - **Unavailable.** There is no other engine (docs/TS_ENGINE_REMOVAL.md).
 *    When the supervisor gives up (crash loop, no GPU, protocol mismatch,
 *    engine missing) requests answer `busy` ("the engine is unavailable") and
 *    the reason is surfaced ONCE through `onNotice`; main shows the blocking
 *    dialog. A successful retry (main's "Try Again") arrives as a restart the
 *    host replayed, and the client is ready again.
 *
 * Copy discipline: `encodeEngineMessage` returns bytes the bridge may retain
 * or transfer, so each request is encoded into its own buffer (`slice`).
 */

import type {
  EngineMessage,
  EventBatch,
  LogRecord,
  OverlayLayerGeometry,
  OverlayView,
  Request,
  Response,
  Revision,
} from './generated/types';
import { decodeEngineMessage, encodeEngineMessage } from './generated/codec';
import { EngineClientBase, engineError, type EventListener } from './client';

// ── the bridge (what the preload exposes as `window.motionEditor.engine`) ──

export type EngineHostState = 'stopped' | 'starting' | 'running' | 'restarting' | 'stopping' | 'unavailable';

export interface EngineHostStatus {
  /** Always true from main (the engine is the only one); false only from a test bridge. */
  enabled: boolean;
  state: EngineHostState;
  engine?: string;
  engineVersion?: string;
  /** Revision the engine reported at its last handshake. */
  revision?: number;
  /** Why the engine is `unavailable` (with that state). */
  unavailableReason?: string;
  /** F2: the engine owns the document — the editor's lifecycle goes through engine requests (always, from main). */
  ownsDocument?: boolean;
  /** F2 / D5: where the engine-owned document's autosave writes its recovery copy (with ownsDocument). */
  recoveryPath?: string;
  /** F2: main keeps the command log and replays it after a restart; the client records none. */
  hostCommandLog?: boolean;
}

export type EngineWireReply =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'gone' | 'invalid'; message: string };

export interface EngineRestartNotice {
  attempt: number;
  cause: 'crash' | 'hang' | 'requested';
  exitCode: number | null;
  signal: string | null;
  logTail: string[];
  /**
   * F2: main replayed ITS command log into the restarted engine (the log lives
   * in main, electron/engineCommandLog.ts) — the client must not replay its
   * own. Absent: an older host; the client replays as before.
   */
  replayedByHost?: boolean;
  replayed?: number;
  mismatches?: number;
  ms?: number;
}

/** Per-batch facts the host adds (F2). */
export interface EngineEventMeta {
  /** The batch was caused by ANOTHER window's request (a pop-out editing the same engine). */
  foreign?: boolean;
}

export interface EngineUnavailableNotice {
  reason: string;
  /** No executable / no GPU / protocol mismatch (main quits) rather than a crash loop (main offers a retry). */
  fatal?: boolean;
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
  /**
   * B4 round 2: the overlay geometry of THIS frame (setOverlayGeometry), the
   * FrameGeometry records the engine sent before it, in arrival order (one
   * layer's records merge, arrays concatenating). Absent without a subscription.
   */
  geometry?: OverlayLayerGeometry[];
  /** B4 round 5: the subscribed views' cameras of THIS frame (setOverlayGeometry `views`). Absent without views. */
  geometryViews?: OverlayView[];
  /** How the frame travelled: a shared GPU texture (route C) or a pixel copy (route A). Absent = shared. */
  route?: 'shared' | 'copy';
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
  onEvents(handler: (bytes: Uint8Array, meta?: EngineEventMeta) => void): () => void;
  onState(handler: (state: EngineHostState) => void): () => void;
  onRestarted(handler: (info: EngineRestartNotice) => void): () => void;
  onUnavailable(handler: (info: EngineUnavailableNotice) => void): () => void;
  /** Frames from the shared-texture ring (null stops). Absent outside Electron. */
  onFrame?(consumer: EngineFrameConsumer | null): void;
  /**
   * C (multiple viewports): the first engine viewport id this window may use —
   * 0 in the editor window (its viewports are 1, 2, …), a block of 256 of its
   * own in a pop-out. Absent outside Electron (then 0).
   */
  viewportBase?(): Promise<number>;
}

// ── notices ──

export type ProcessEngineNotice =
  | { kind: 'restarted'; attempt: number; cause: EngineRestartNotice['cause']; replayed: number; mismatches: number; ms: number }
  | { kind: 'unavailable'; reason: string };

export interface ProcessEngineOptions {
  /** Restart / unavailable notices for the UI (a toast). Unavailable is reported once per outage. */
  onNotice?: (notice: ProcessEngineNotice) => void;
  /** Keep the command log for crash recovery (default true). A host that replays its own log (F2) makes it unused. */
  recordLog?: boolean;
}

/** Transport commands a crash-recovery replay skips: the clock restarts stopped. */
const REPLAY_SKIP = new Set(['play', 'pause', 'step']);

type Mode = 'connecting' | 'ready' | 'recovering' | 'unavailable' | 'closed';

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
  /** F2: main keeps the log (EngineHostStatus.hostCommandLog): this client records nothing. */
  private hostLogs = false;
  private suppressEvents = false;
  private recoveryGen = 0;
  private resyncing = false;
  private unavailableNoticeSent = false;
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
      bridge.onUnavailable((info) => this.becomeUnavailable(info.reason)),
    );
    void this.connect();
  }

  /** The revision subscribers have been brought to (the mirror's revision, §8.2). */
  get eventRevision(): Revision {
    return this.eventRevisionValue;
  }

  /** Which backend answers now. */
  get backend(): 'process' | 'unavailable' | 'pending' | 'closed' {
    if (this.mode === 'unavailable') return 'unavailable';
    if (this.mode === 'closed') return 'closed';
    return this.mode === 'ready' ? 'process' : 'pending';
  }

  /** The recorded command log (crash recovery). */
  commandLog(): LogRecord[] {
    return this.log.map((r) => deepCopy(r));
  }

  /** The last crash recovery's replay numbers (tests, HUD). */
  get lastRecovery(): { replayed: number; mismatches: number; ms: number } | null {
    return this.lastRestart;
  }

  /** Resolves once the backend answers requests (process ready, or unavailable). */
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
    if (this.mode === 'unavailable') return errorResponse(req.seq, this.revision, 'busy', 'the engine is unavailable');
    if ((this.mode as Mode) === 'closed') return errorResponse(req.seq, this.revision, 'cancelled', 'the engine client is closed');
    const res = await this.wire(req);
    this.noteRevision(res.revision);
    this.record(req, res);
    return res;
  }

  async close(): Promise<void> {
    if (this.mode === 'closed') return;
    for (const d of this.disposers.splice(0)) d();
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
    if (this.mode === 'ready' || this.mode === 'unavailable' || this.mode === 'closed') return Promise.resolve();
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
      this.becomeUnavailable(`engine status unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!st.enabled) {
      this.becomeUnavailable('the engine is not running');
      return;
    }
    this.hostLogs = st.hostCommandLog === true;
    if (st.state === 'unavailable') {
      this.becomeUnavailable(st.unavailableReason ?? 'the engine is unavailable');
      return;
    }
    if (st.state === 'running') await this.becomeReady('connected');
    // Otherwise onHostState('running') finishes the connection.
  }

  private onHostState(s: EngineHostState): void {
    if (this.mode === 'closed' || this.mode === 'unavailable') return;
    if (s === 'restarting' && this.mode === 'ready') {
      this.mode = 'recovering';  // hold requests until the replay (onRestarted) is done
      return;
    }
    if (s === 'running' && this.mode === 'connecting') void this.becomeReady('connected');
  }

  /** Learn the engine's revision, give subscribers a starting point, open the gate. */
  private async becomeReady(why: 'connected' | 'engineRestarted'): Promise<void> {
    const res = await this.wire({ seq: this.nextInternalSeq(), body: { kind: 'query', value: { type: 'getHistory' } }, origin: 'engine' });
    if (this.mode === 'unavailable' || this.mode === 'closed') return;
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
    if (this.options.recordLog === false || this.hostLogs) return;
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

  /** True when the batch was delivered to subscribers. */
  private onBatch(b: EventBatch): boolean {
    if (this.mode === 'unavailable' || this.mode === 'closed') return false;  // a stale engine's last words
    this.noteRevision(b.toRevision);
    if (this.suppressEvents || this.mode !== 'ready') {
      // Connecting or replaying: the documentReset that ends it covers these.
      return false;
    }
    const revisioned = b.fromRevision !== b.toRevision;
    if (b.fromRevision > this.eventRevisionValue) {
      void this.resync();  // §8.2: a gap — drop and refetch
      return false;
    }
    if (revisioned && b.toRevision <= this.eventRevisionValue) return false;  // duplicate
    if (b.toRevision > this.eventRevisionValue) this.eventRevisionValue = b.toRevision;
    this.deliver(b);
    return true;
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
    if (this.mode === 'closed') return;
    // After an outage (main's "Try Again" succeeded): the next outage is reported again.
    this.unavailableNoticeSent = false;
    if (info.replayedByHost) {
      // F2: main already replayed its command log (every window's requests,
      // once); this window only refetches. Its own log would replay twice.
      const gen = ++this.recoveryGen;
      this.mode = 'recovering';
      this.suppressEvents = false;
      const replayed = info.replayed ?? 0;
      const mismatches = info.mismatches ?? 0;
      const ms = info.ms ?? 0;
      this.lastRestart = { replayed, mismatches, ms };
      await this.becomeReady('engineRestarted');
      if (gen !== this.recoveryGen) return;
      this.options.onNotice?.({ kind: 'restarted', attempt: info.attempt, cause: info.cause, replayed, mismatches, ms });
      return;
    }
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

  /** The engine cannot run: requests answer `busy` until a retry brings it back (recover). */
  private becomeUnavailable(reason: string): void {
    if (this.mode === 'unavailable' || this.mode === 'closed') return;
    this.recoveryGen += 1;  // abandon a replay in progress
    this.suppressEvents = false;
    this.mode = 'unavailable';
    if (!this.unavailableNoticeSent) {
      this.unavailableNoticeSent = true;
      this.options.onNotice?.({ kind: 'unavailable', reason });
    }
    this.release();
  }
}

/** Build the process backend over a bridge (the preload's `motionEditor.engine`). */
export function createProcessEngineClient(bridge: EngineBridge, options: ProcessEngineOptions = {}): ProcessEngineClient {
  return new ProcessEngineClient(bridge, options);
}
