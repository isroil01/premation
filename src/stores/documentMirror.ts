/**
 * The document mirror (NATIVE_CORE_PLAN §5 B4, ENGINE_API.md §8, docs/B4_MIRROR.md).
 *
 * The UI's read-only copy of the engine's document, built ONLY from the
 * engine API: an initial `getDocument` and then the revisioned change events,
 * applied in revision order. Nothing here reads the scene graph, the animation
 * engine, the timeline controller or a document store — so the panels that
 * render from it do not care which engine owns the document (F2: the C++
 * process), and the same mirror runs over `LocalEngine` and
 * `ProcessEngineClient`.
 *
 * ## The rules (§8.2)
 *
 * A batch with `fromRevision == revision` is applied event by event and the
 * mirror moves to `toRevision`; `toRevision <= revision` is a duplicate and is
 * dropped; `fromRevision > revision` is a gap — the mirror refetches. A
 * `documentReset` anywhere (open / new / revert / engine restart / a write made
 * around the engine that could not be described incrementally) refetches.
 * Ephemeral batches (`from == to`: history, dirty, per-layer errors) are
 * applied whenever they arrive. While a refetch is in flight, batches are
 * buffered and replayed on top of the snapshot.
 *
 * ## What is held, and how it is shared
 *
 *   layer headers   every layer (`LayerInfo`), eagerly
 *   keyframes       every animated property of every layer, eagerly
 *   compositions    settings, stack order, markers
 *   items, project settings, render queue, history, dirty, layer errors
 *   property trees  PER LAYER, on demand: a panel that draws a layer's
 *                   properties retains its tree (`retainTree`); the Inspector
 *                   and the timeline's expanded rows are the retainers. 2,000
 *                   layers' trees are ~57,000 PropertyInfos (26 MB of JSON,
 *                   1.1 s to build in the TS engine), so they are never
 *                   fetched wholesale.
 *
 * Every record is a plain immutable object. An event that restates a record
 * unchanged (upserts are full records, and engines over-report, §8.1 rule 4)
 * keeps the OLD object, so identity is a valid change test for selectors and
 * `React.memo`: a property drag on layer A never re-renders layer B's row.
 *
 * ## Subscriptions
 *
 * Keyed, so a component wakes only for what it reads: `layer:<id>`,
 * `layers` (membership), `comp:<id>`, `comps`, `items`, `tree:<id>`,
 * `prop:<id>|<path>`, `keys:<id>`, `key:<id>|<path>`, `value:<id>|<path>`,
 * `history`, `status`, `settings`, `renderQueue`, `errors:<comp>`, `doc`
 * (anything revisioned). Listeners are called ONCE per batch however many
 * keys they matched — one React update per engine batch, never per event
 * (CLAUDE.md "no React render per played frame"; the playhead is not in here
 * at all: `playbackClockStore` carries it by subscription).
 *
 * ## Values at a time
 *
 * A static property's value is in its PropertyInfo. An animated one (or one
 * with an expression) depends on the time asked: `valueAt` answers from a
 * per-revision cache filled by batched `getPropertyValues` queries — one query
 * per (time, revision) for every row that asked, synchronously on the
 * in-process backend (`querySync`), asynchronously over the pipe. The last
 * known value is shown until the new one lands, never a blank.
 *
 * No React here: the hooks are in src/hooks/useMirror.ts.
 */

import type {
  CompSettings,
  DocumentSnapshot,
  EngineResult,
  Event,
  EventBatch,
  HistoryState,
  ItemInfo,
  Keyframe,
  LayerError,
  LayerInfo,
  Marker,
  ProjectSettings,
  PropertyInfo,
  PropertyValues,
  PropertyTree,
  QueryOf,
  QueryResults,
  QueryType,
  RenderItemInfo,
  Revision,
  Value,
} from '@motion/engine-api';

// ── Source ───────────────────────────────────────────────────────────────

/** What the mirror needs from an engine: its events and its queries. */
export interface MirrorSource {
  subscribe(listener: (batch: EventBatch) => void): () => void;
  query<T extends QueryType>(q: QueryOf<T>): Promise<EngineResult<QueryResults[T]>>;
  /**
   * In-process fast path (LocalEngine.querySync): answer NOW, at the revision
   * every delivered event has reached, or null (a request is in flight).
   */
  querySync?<T extends QueryType>(q: QueryOf<T>): EngineResult<QueryResults[T]> | null;
  /** Told when the engine instance behind the source is replaced without an event. */
  onReplaced?(listener: () => void): () => void;
}

// ── Records ──────────────────────────────────────────────────────────────

export type MirrorStatus = 'empty' | 'loading' | 'ready' | 'error';

export interface MirrorComp {
  readonly id: string;
  readonly settings: CompSettings;
  /** Layer ids, top of the stack first. */
  readonly layers: readonly string[];
  readonly markers: readonly Marker[];
}

export interface MirrorTree {
  readonly layer: string;
  /** Every node (groups and properties) of the layer's property tree, by path. */
  readonly nodes: ReadonlyMap<string, PropertyInfo>;
  /** Top-level paths, in order. */
  readonly roots: readonly string[];
}

export interface MirrorHistory {
  readonly state: HistoryState;
  readonly undoLabel: string;
  readonly redoLabel: string;
}

const EMPTY_KEYS: readonly Keyframe[] = Object.freeze([]) as readonly Keyframe[];
const EMPTY_LAYER_KEYS: ReadonlyMap<string, readonly Keyframe[]> = new Map();
const EMPTY_ERRORS: readonly LayerError[] = Object.freeze([]) as readonly LayerError[];

// ── Structural equality (keeps identity for restated records) ────────────

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** `next` unless it equals `prev`, in which case `prev` (identity survives a restatement). */
function keep<T>(prev: T | undefined, next: T): T {
  return prev !== undefined && same(prev, next) ? prev : next;
}

// ── Trees ────────────────────────────────────────────────────────────────

interface TreeEntry {
  tree: MirrorTree | null;
  /** Revision the tree reflects (events at or below it are already in it). */
  revision: Revision;
  /** A fetch is in flight. */
  loading: boolean;
  /** Newest revision whose property events were DROPPED because the tree was absent. */
  dirtyRev: Revision;
  retain: number;
  lastUse: number;
  /** The engine could not describe the layer at this revision: do not ask again until it moves. */
  failedRev: Revision;
}

const MAX_UNRETAINED_TREES = 256;

function treeFromNodes(layer: string, nodes: readonly PropertyInfo[]): MirrorTree {
  const map = new Map<string, PropertyInfo>();
  const roots: string[] = [];
  for (const n of nodes) {
    map.set(n.path, n);
    if (!n.path.includes('/')) roots.push(n.path);
  }
  return { layer, nodes: map, roots };
}

/** Remove `path` and everything under it. */
function dropSubtree(map: Map<string, PropertyInfo>, path: string): void {
  const node = map.get(path);
  map.delete(path);
  if (node) for (const c of node.children) dropSubtree(map, c);
  const prefix = `${path}/`;
  for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
}

// ── The mirror ───────────────────────────────────────────────────────────

type Listener = () => void;

export class DocumentMirror {
  private readonly source: MirrorSource;
  private unsubscribe: (() => void) | null = null;
  private unreplaced: (() => void) | null = null;

  private statusValue: MirrorStatus = 'empty';
  private errorValue: string | null = null;
  private rev: Revision = 0;
  private generationValue = 0;

  private projectPathValue = '';
  private dirtyValue = false;
  private settingsValue: ProjectSettings | null = null;
  private itemsValue: ReadonlyMap<string, ItemInfo> = new Map();
  private compsValue: ReadonlyMap<string, MirrorComp> = new Map();
  private compIdsValue: readonly string[] = [];
  private readonly layerMap = new Map<string, LayerInfo>();
  private layerIdsValue: readonly string[] | null = null;
  private readonly keyMap = new Map<string, ReadonlyMap<string, readonly Keyframe[]>>();
  private readonly trees = new Map<string, TreeEntry>();
  private renderQueueValue: readonly RenderItemInfo[] = [];
  private historyValue: MirrorHistory | null = null;
  private readonly errors = new Map<string, readonly LayerError[]>();

  /** Stack order / markers of a composition whose settings have not arrived yet. */
  private readonly early = new Map<string, { layers?: readonly string[]; markers?: readonly Marker[] }>();
  /** Batches that arrived while a refetch was in flight (null: not loading). */
  private buffer: EventBatch[] | null = null;
  private loadSeq = 0;
  private useClock = 0;

  private readonly subs = new Map<string, Set<Listener>>();
  private pending: Set<string> | null = null;

  // values at a time
  private readonly values = new Map<string, { rev: Revision; value: Value | undefined }>();
  private readonly valueRequests = new Map<number, Map<string, { layer: string; path: string }>>();
  private valueFlushScheduled = false;

  constructor(source: MirrorSource) {
    this.source = source;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Subscribe to the engine and load the document. Idempotent. */
  start(): this {
    if (this.unsubscribe) return this;
    this.unsubscribe = this.source.subscribe((b) => this.onBatch(b));
    this.unreplaced = this.source.onReplaced?.(() => this.reload()) ?? null;
    this.reload();
    return this;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unreplaced?.();
    this.unreplaced = null;
    this.loadSeq += 1;
    this.buffer = null;
  }

  // ── Reads (plain, synchronous; the hooks wrap these) ───────────────────

  get status(): MirrorStatus { return this.statusValue; }
  get error(): string | null { return this.errorValue; }
  /** The document revision the mirror shows. */
  get revision(): Revision { return this.rev; }
  /** Bumped by every (re)load: a different document may be showing. */
  get generation(): number { return this.generationValue; }
  get projectPath(): string { return this.projectPathValue; }
  get dirty(): boolean { return this.dirtyValue; }
  get settings(): ProjectSettings | null { return this.settingsValue; }
  get items(): ReadonlyMap<string, ItemInfo> { return this.itemsValue; }
  get comps(): ReadonlyMap<string, MirrorComp> { return this.compsValue; }
  /** Composition ids in document order. */
  get compIds(): readonly string[] { return this.compIdsValue; }
  get renderQueue(): readonly RenderItemInfo[] { return this.renderQueueValue; }
  get history(): MirrorHistory | null { return this.historyValue; }

  item(id: string): ItemInfo | undefined { return this.itemsValue.get(id); }
  comp(id: string): MirrorComp | undefined { return this.compsValue.get(id); }
  layer(id: string): LayerInfo | undefined {
    const hit = this.layerMap.get(id);
    if (hit || !id) return hit;
    return this.fetchLayer(id);
  }
  hasLayer(id: string): boolean { return this.layer(id) !== undefined; }

  /** Ids asked for and not found, with the revision they were not found at. */
  private readonly missing = new Map<string, Revision>();

  /**
   * A layer the snapshot did not list (one in a composition the document does
   * not register — tests and legacy scratch trees build those) is fetched on
   * demand with `getLayers`; its later events keep it current like any other.
   */
  private fetchLayer(id: string): LayerInfo | undefined {
    if (this.statusValue !== 'ready' || this.missing.get(id) === this.rev) return undefined;
    this.missing.set(id, this.rev);
    const q: QueryOf<'getLayers'> = { type: 'getLayers', layers: [id] };
    const sync = this.source.querySync?.(q);
    if (sync) {
      const l = sync.ok ? sync.value.layers[0] : undefined;
      if (!l) return undefined;
      this.missing.delete(id);
      this.layerMap.set(id, l);
      this.layerIdsValue = null;
      // Its keyframes were not in the snapshot either.
      const tree = this.tree(id);
      const animated = tree ? [...tree.nodes.values()].filter((n) => n.kind === 'property' && n.animated).map((n) => ({ layer: id, path: n.path })) : [];
      if (animated.length > 0) {
        const k = this.source.querySync?.({ type: 'getKeyframes', props: animated });
        if (k?.ok) {
          const m = new Map<string, readonly Keyframe[]>();
          for (const s of k.value.sets) if (s.keyframes.length) m.set(s.prop.path, s.keyframes);
          if (m.size) this.keyMap.set(id, m);
        }
      }
      return l;
    }
    const gen = this.generationValue;
    this.track(this.source.query(q)).then((r) => {
      const l = r.ok ? r.value.layers[0] : undefined;
      if (!l || gen !== this.generationValue || this.layerMap.has(id)) return;
      this.missing.delete(id);
      this.layerMap.set(id, l);
      this.layerIdsValue = null;
      this.touch(`layer:${id}`);
      this.touch('layers');
      this.flushNotify();
    }, () => { /* next ask retries at a new revision */ });
    return undefined;
  }

  /** Every layer id the mirror holds (stable identity until membership changes). */
  layerIds(): readonly string[] {
    if (!this.layerIdsValue) this.layerIdsValue = [...this.layerMap.keys()];
    return this.layerIdsValue;
  }

  /** Every animated property's keyframes of one layer (path → keys). */
  layerKeyframes(layer: string): ReadonlyMap<string, readonly Keyframe[]> {
    return this.keyMap.get(layer) ?? EMPTY_LAYER_KEYS;
  }

  /** The keyframes of one property (empty when not animated). */
  keyframes(layer: string, path: string): readonly Keyframe[] {
    return this.keyMap.get(layer)?.get(path) ?? EMPTY_KEYS;
  }

  layerErrors(comp: string): readonly LayerError[] {
    return this.errors.get(comp) ?? EMPTY_ERRORS;
  }

  /**
   * The layer's property tree, or undefined until it is loaded. Asking loads
   * it (synchronously on the in-process backend); keep it loaded while you
   * draw it with `retainTree`.
   */
  tree(layer: string): MirrorTree | undefined {
    if (!this.layer(layer)) return undefined;
    let e = this.trees.get(layer);
    if (!e) {
      e = { tree: null, revision: -1, loading: false, dirtyRev: -1, retain: 0, lastUse: 0, failedRev: -1 };
      this.trees.set(layer, e);
    }
    e.lastUse = ++this.useClock;
    if (!e.tree && !e.loading && e.failedRev !== this.rev) this.fetchTree(layer, e);
    return e.tree ?? undefined;
  }

  /** One node of a layer's property tree (loads the tree like `tree`). */
  property(layer: string, path: string): PropertyInfo | undefined {
    return this.tree(layer)?.nodes.get(path);
  }

  /** Keep a layer's tree loaded (and fetched) until the returned release runs. */
  retainTree(layer: string): () => void {
    this.tree(layer);
    const e = this.trees.get(layer);
    if (!e) {
      // No such layer (yet): nothing to hold. A later `tree()` loads it.
      return () => {};
    }
    e.retain += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      e.retain = Math.max(0, e.retain - 1);
      this.evictTrees();
    };
  }

  /**
   * The value of a property at `time` (flicks, composition time). Static
   * properties answer from their PropertyInfo; animated ones (and expressions)
   * from the per-revision value cache, fetched in batches — the last known
   * value until the answer lands. Undefined when the property is unknown.
   */
  valueAt(layer: string, path: string, time: number): Value | undefined {
    const info = this.property(layer, path);
    if (!info) return undefined;
    if (!info.animated && !(info.expressionEnabled && info.expression !== '')) return info.value;
    const key = `${layer}\u0000${path}\u0000${time}`;
    const hit = this.values.get(key);
    if (hit && hit.rev === this.rev) return hit.value;
    this.requestValue(layer, path, time);
    const now = this.values.get(key);
    if (now && now.rev === this.rev) return now.value;
    return hit?.value ?? info.value;
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  /** Call `listener` (once per batch) whenever any of `keys` changes. */
  subscribe(keys: readonly string[], listener: Listener): () => void {
    for (const k of keys) {
      let set = this.subs.get(k);
      if (!set) {
        set = new Set();
        this.subs.set(k, set);
      }
      set.add(listener);
    }
    return () => {
      for (const k of keys) {
        const set = this.subs.get(k);
        if (!set) continue;
        set.delete(listener);
        if (set.size === 0) this.subs.delete(k);
      }
    };
  }

  private touch(key: string): void {
    (this.pending ?? (this.pending = new Set())).add(key);
  }

  private flushNotify(all = false): void {
    const keys = this.pending;
    this.pending = null;
    const fns = new Set<Listener>();
    if (all) {
      for (const set of this.subs.values()) for (const f of set) fns.add(f);
    } else if (keys) {
      for (const k of keys) {
        const set = this.subs.get(k);
        if (set) for (const f of set) fns.add(f);
      }
    }
    for (const f of fns) {
      try {
        f();
      } catch {
        // One subscriber's failure never reaches the mirror or the others.
      }
    }
  }

  // ── Loading ────────────────────────────────────────────────────────────

  /** Refetch the whole document (documentReset, a gap, an engine swap). */
  reload(): void {
    const seq = ++this.loadSeq;
    this.buffer = [];
    if (this.statusValue !== 'ready') this.statusValue = 'loading';
    const q: QueryOf<'getDocument'> = { type: 'getDocument', includeProperties: false, includeKeyframes: true };
    const sync = this.source.querySync?.(q);
    if (sync) {
      this.finishLoad(seq, sync);
      return;
    }
    this.track(this.source.query(q)).then(
      (r) => this.finishLoad(seq, r),
      (err: unknown) => this.finishLoad(seq, { ok: false, error: { code: 'internal', message: err instanceof Error ? err.message : String(err) }, revision: this.rev }),
    );
  }

  private asyncInFlight = 0;
  private idleWaiters: Array<() => void> = [];

  private track<T>(p: Promise<T>): Promise<T> {
    this.asyncInFlight += 1;
    const done = (): void => {
      this.asyncInFlight -= 1;
      // Let the continuation (which may start another fetch) run first.
      void Promise.resolve().then(() => {
        if (this.asyncInFlight === 0 && !this.buffer) {
          const w = this.idleWaiters;
          this.idleWaiters = [];
          for (const f of w) f();
        }
      });
    };
    p.then(done, done);
    return p;
  }

  /** Resolves when no fetch is in flight (tests, and the benchmark's settle step). */
  whenIdle(): Promise<void> {
    if (this.asyncInFlight === 0 && !this.buffer && !this.valueFlushScheduled) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Layers whose property tree is loaded (tests). */
  loadedTreeLayers(): string[] {
    return [...this.trees].filter(([, e]) => e.tree !== null).map(([l]) => l);
  }

  private finishLoad(seq: number, r: EngineResult<DocumentSnapshot>): void {
    if (seq !== this.loadSeq) return;
    const buffered = this.buffer ?? [];
    this.buffer = null;
    if (!r.ok) {
      this.statusValue = 'error';
      this.errorValue = `${r.error.code}: ${r.error.message}`;
      this.flushNotify(true);
      return;
    }
    this.install(r.value);
    this.flushNotify(true);
    for (const b of buffered) {
      const pending = this.buffer as EventBatch[] | null;
      if (pending) {
        // A replayed batch started another reload: the rest are its problem.
        pending.push(b);
        continue;
      }
      this.onBatch(b);
    }
  }

  private install(doc: DocumentSnapshot): void {
    this.generationValue += 1;
    this.statusValue = 'ready';
    this.errorValue = null;
    this.rev = doc.revision;
    this.projectPathValue = doc.projectPath;
    this.dirtyValue = doc.dirty;
    this.settingsValue = keep(this.settingsValue ?? undefined, doc.settings);
    const items = new Map<string, ItemInfo>();
    for (const i of doc.items) items.set(i.id, keep(this.itemsValue.get(i.id), i));
    this.itemsValue = items;
    const comps = new Map<string, MirrorComp>();
    for (const c of doc.comps) {
      const prev = this.compsValue.get(c.id);
      comps.set(c.id, keep(prev, { id: c.id, settings: c.settings, layers: c.layers, markers: c.markers }));
    }
    this.compsValue = comps;
    this.compIdsValue = keep(this.compIdsValue as string[], doc.comps.map((c) => c.id));
    const layers = new Map<string, LayerInfo>();
    for (const l of doc.layers) layers.set(l.id, keep(this.layerMap.get(l.id), l));
    this.layerMap.clear();
    for (const [k, v] of layers) this.layerMap.set(k, v);
    this.layerIdsValue = null;
    const byLayer = new Map<string, Map<string, readonly Keyframe[]>>();
    for (const s of doc.keyframes) {
      if (s.keyframes.length === 0) continue;
      let m = byLayer.get(s.prop.layer);
      if (!m) {
        m = new Map();
        byLayer.set(s.prop.layer, m);
      }
      m.set(s.prop.path, keep(this.keyMap.get(s.prop.layer)?.get(s.prop.path), s.keyframes));
    }
    this.keyMap.clear();
    for (const [layer, m] of byLayer) {
      const prev = this.keyMap.get(layer);
      this.keyMap.set(layer, prev && same([...prev], [...m]) ? prev : m);
    }
    this.renderQueueValue = keep(this.renderQueueValue as RenderItemInfo[], doc.renderQueue);
    this.values.clear();
    this.early.clear();
    // Trees describe the previous document: refetch the retained ones, drop the rest.
    for (const [layer, e] of [...this.trees]) {
      if (e.retain > 0 && this.layerMap.has(layer)) {
        e.revision = -1;
        e.dirtyRev = -1;
        e.loading = false;
        this.fetchTree(layer, e, true);
      } else {
        this.trees.delete(layer);
      }
    }
  }

  private fetchTree(layer: string, e: TreeEntry, keepOld = false): void {
    if (!keepOld) e.tree = null;
    e.loading = true;
    const q: QueryOf<'getPropertyTree'> = { type: 'getPropertyTree', layer, path: '', depth: 0 };
    const sync = this.source.querySync?.(q);
    if (sync) {
      this.finishTree(layer, e, sync, true);
      return;
    }
    const gen = this.generationValue;
    this.track(this.source.query(q)).then(
      (r) => {
        if (gen !== this.generationValue || this.trees.get(layer) !== e) {
          e.loading = false;
          return;
        }
        this.finishTree(layer, e, r, false);
      },
      () => {
        e.loading = false;
      },
    );
  }

  private finishTree(layer: string, e: TreeEntry, r: EngineResult<PropertyTree>, sync: boolean): void {
    e.loading = false;
    if (!r.ok) {
      // The layer is gone (or the engine cannot describe it): no tree until
      // the document moves on.
      e.failedRev = this.rev;
      return;
    }
    if (e.dirtyRev > r.revision) {
      // Property events newer than this answer were dropped while it was in
      // flight: ask again rather than show a tree older than the headers.
      this.fetchTree(layer, e, true);
      return;
    }
    const next = treeFromNodes(layer, r.value.nodes);
    e.tree = e.tree && same([...e.tree.nodes.entries()], [...next.nodes.entries()]) ? e.tree : next;
    e.revision = r.revision;
    e.dirtyRev = -1;
    if (!sync) {
      this.touch(`tree:${layer}`);
      for (const p of next.nodes.keys()) this.touch(`prop:${layer}|${p}`);
      this.flushNotify();
    }
  }

  private evictTrees(): void {
    let unretained = 0;
    for (const e of this.trees.values()) if (e.retain === 0) unretained += 1;
    if (unretained <= MAX_UNRETAINED_TREES) return;
    const victims = [...this.trees].filter(([, e]) => e.retain === 0).sort((a, b) => a[1].lastUse - b[1].lastUse);
    for (const [layer] of victims.slice(0, unretained - MAX_UNRETAINED_TREES)) this.trees.delete(layer);
  }

  // ── Events ─────────────────────────────────────────────────────────────

  private onBatch(b: EventBatch): void {
    if (this.buffer) {
      if (b.events.some((e) => e.type === 'documentReset')) {
        this.applyEphemeral(b);
        this.reload();
        return;
      }
      this.buffer.push(b);
      return;
    }
    const revisioned = b.fromRevision !== b.toRevision;
    if (b.events.some((e) => e.type === 'documentReset')) {
      // Whatever its revisions say (a fresh engine starts at 0 → 0).
      this.applyEphemeral(b);
      this.flushNotify();
      this.reload();
      return;
    }
    if (revisioned) {
      if (b.toRevision <= this.rev) {
        // Already applied (a duplicate); its status events may still be news.
        this.applyEphemeral(b);
        this.flushNotify();
        return;
      }
      if (b.fromRevision !== this.rev) {
        // A gap (a lost batch, a restart): the snapshot is the truth.
        this.reload();
        return;
      }
    }
    const trees = new Map<string, Map<string, PropertyInfo>>();
    const roots = new Map<string, string[]>();
    const keyMaps = new Map<string, Map<string, readonly Keyframe[]>>();
    let items: Map<string, ItemInfo> | null = null;
    let comps: Map<string, MirrorComp> | null = null;
    const treeMap = (layer: string): Map<string, PropertyInfo> | null => {
      const e = this.trees.get(layer);
      // A fetch in flight will answer at some revision; if these events are
      // newer than that answer, it is asked again (finishTree).
      if (e?.loading) e.dirtyRev = Math.max(e.dirtyRev, b.toRevision);
      if (!e || !e.tree || b.toRevision <= e.revision) {
        if (e && !e.tree) e.dirtyRev = Math.max(e.dirtyRev, b.toRevision);
        return null;
      }
      let m = trees.get(layer);
      if (!m) {
        m = new Map(e.tree.nodes);
        trees.set(layer, m);
        roots.set(layer, [...e.tree.roots]);
      }
      return m;
    };
    const compOf = (id: string): MirrorComp | undefined => (comps ?? this.compsValue).get(id);
    const setComp = (c: MirrorComp): void => {
      if (!comps) comps = new Map(this.compsValue);
      if (!comps.has(c.id)) this.compIdsValue = [...this.compIdsValue, c.id];
      comps.set(c.id, c);
      this.touch(`comp:${c.id}`);
      this.touch('comps');
    };

    for (const e of b.events) {
      switch (e.type) {
        case 'projectSettingsChanged': {
          const next = keep(this.settingsValue ?? undefined, e.settings);
          if (next !== this.settingsValue) {
            this.settingsValue = next;
            this.touch('settings');
          }
          break;
        }
        case 'itemsChanged':
          for (const i of e.items) {
            const prev = (items ?? this.itemsValue).get(i.id);
            const next = keep(prev, i);
            if (next === prev) continue;
            if (!items) items = new Map(this.itemsValue);
            items.set(i.id, next);
            this.touch(`item:${i.id}`);
            this.touch('items');
          }
          break;
        case 'itemsRemoved':
          for (const id of e.items) {
            if (!(items ?? this.itemsValue).has(id)) continue;
            if (!items) items = new Map(this.itemsValue);
            items.delete(id);
            this.touch(`item:${id}`);
            this.touch('items');
          }
          break;
        case 'compositionChanged': {
          const prev = compOf(e.comp);
          const settings = keep(prev?.settings, e.settings);
          if (prev && settings === prev.settings) break;
          const early = this.early.get(e.comp);
          this.early.delete(e.comp);
          setComp({ id: e.comp, settings, layers: prev?.layers ?? early?.layers ?? [], markers: prev?.markers ?? early?.markers ?? [] });
          break;
        }
        case 'layersChanged':
          for (const l of e.layers) {
            const prev = this.layerMap.get(l.id);
            const next = keep(prev, l);
            if (next === prev) continue;
            this.layerMap.set(l.id, next);
            if (!prev) {
              this.layerIdsValue = null;
              this.touch('layers');
            }
            this.touch(`layer:${l.id}`);
          }
          break;
        case 'layersRemoved':
          for (const id of e.layers) {
            if (this.layerMap.delete(id)) {
              this.layerIdsValue = null;
              this.touch('layers');
            }
            this.touch(`layer:${id}`);
            if (this.keyMap.delete(id)) this.touch(`keys:${id}`);
            if (this.trees.delete(id)) this.touch(`tree:${id}`);
            trees.delete(id);
            keyMaps.delete(id);
          }
          break;
        case 'layerOrderChanged': {
          const prev = compOf(e.comp);
          if (!prev) {
            // Order before settings (an engine may send them either way round):
            // held until its compositionChanged arrives in this batch.
            this.early.set(e.comp, { ...this.early.get(e.comp), layers: e.layers });
            break;
          }
          const layers = keep(prev.layers as string[], e.layers);
          if (layers === prev.layers) break;
          setComp({ ...prev, layers });
          this.touch(`order:${e.comp}`);
          break;
        }
        case 'propertiesChanged': {
          const m = treeMap(e.layer);
          if (!m) break;
          for (const p of e.properties) {
            const prev = m.get(p.path);
            const next = keep(prev, p);
            if (next === prev) continue;
            m.set(p.path, next);
            if (!p.path.includes('/') && !roots.get(e.layer)!.includes(p.path)) roots.get(e.layer)!.push(p.path);
            this.touch(`prop:${e.layer}|${p.path}`);
            this.touch(`value:${e.layer}|${p.path}`);
            this.touch(`tree:${e.layer}`);
          }
          break;
        }
        case 'propertyGroupsChanged': {
          const m = treeMap(e.layer);
          if (!m) break;
          const childPaths = e.children.map((c) => c.path);
          const before = e.parent === '' ? roots.get(e.layer)! : m.get(e.parent)?.children ?? [];
          for (const old of before) {
            if (!childPaths.includes(old)) {
              dropSubtree(m, old);
              this.touch(`prop:${e.layer}|${old}`);
            }
          }
          for (const c of e.children) {
            const prev = m.get(c.path);
            const next = keep(prev, c);
            if (next !== prev) {
              m.set(c.path, next);
              this.touch(`prop:${e.layer}|${c.path}`);
              this.touch(`value:${e.layer}|${c.path}`);
            }
          }
          if (e.parent === '') {
            roots.set(e.layer, childPaths);
          } else {
            const parent = m.get(e.parent);
            if (parent && !same(parent.children, childPaths)) {
              m.set(e.parent, { ...parent, children: childPaths });
              this.touch(`prop:${e.layer}|${e.parent}`);
            }
          }
          this.touch(`tree:${e.layer}`);
          break;
        }
        case 'keyframesChanged':
          for (const s of e.sets) {
            const layer = s.prop.layer;
            let m = keyMaps.get(layer);
            const cur = m ?? this.keyMap.get(layer);
            const prev = cur?.get(s.prop.path);
            if (s.keyframes.length === 0) {
              if (!prev) continue;
              if (!m) {
                m = new Map(cur);
                keyMaps.set(layer, m);
              }
              m.delete(s.prop.path);
            } else {
              const next = keep(prev, s.keyframes);
              if (next === prev) continue;
              if (!m) {
                m = new Map(cur ?? []);
                keyMaps.set(layer, m);
              }
              m.set(s.prop.path, next);
            }
            this.touch(`keys:${layer}`);
            this.touch(`key:${layer}|${s.prop.path}`);
            this.touch(`value:${layer}|${s.prop.path}`);
          }
          break;
        case 'markersChanged': {
          const owner = e.owner;
          if (owner.layer !== undefined && owner.layer !== '') {
            const prev = this.layerMap.get(owner.layer);
            if (!prev) break;
            const markers = keep(prev.markers as Marker[], e.markers);
            if (markers === prev.markers) break;
            this.layerMap.set(owner.layer, { ...prev, markers });
            this.touch(`layer:${owner.layer}`);
          } else {
            const prev = compOf(owner.comp);
            if (!prev) {
              this.early.set(owner.comp, { ...this.early.get(owner.comp), markers: e.markers });
              break;
            }
            const markers = keep(prev.markers as Marker[], e.markers);
            if (markers === prev.markers) break;
            setComp({ ...prev, markers });
          }
          break;
        }
        case 'renderQueueChanged': {
          const next = keep(this.renderQueueValue as RenderItemInfo[], e.items);
          if (next !== this.renderQueueValue) {
            this.renderQueueValue = next;
            this.touch('renderQueue');
          }
          break;
        }
        default:
          this.applyEphemeralEvent(e);
          break;
      }
    }

    // Commit the copy-on-write collections.
    if (items) this.itemsValue = items;
    if (comps) this.compsValue = comps;
    for (const [layer, m] of trees) {
      const e = this.trees.get(layer);
      if (!e || !e.tree) continue;
      e.tree = { layer, nodes: m, roots: roots.get(layer) ?? e.tree.roots };
      e.revision = b.toRevision;
    }
    for (const [layer, m] of keyMaps) {
      if (m.size === 0) this.keyMap.delete(layer);
      else this.keyMap.set(layer, m);
    }
    if (revisioned) {
      this.rev = b.toRevision;
      this.touch('doc');
    }
    this.flushNotify();
  }

  private applyEphemeral(b: EventBatch): void {
    for (const e of b.events) this.applyEphemeralEvent(e);
  }

  private applyEphemeralEvent(e: Event): void {
    switch (e.type) {
      case 'historyChanged': {
        const next = keep(this.historyValue ?? undefined, { state: e.state, undoLabel: e.undoLabel, redoLabel: e.redoLabel });
        if (next !== this.historyValue) {
          this.historyValue = next;
          this.touch('history');
        }
        break;
      }
      case 'dirtyChanged':
        if (this.dirtyValue !== e.dirty || this.projectPathValue !== e.projectPath) {
          this.dirtyValue = e.dirty;
          this.projectPathValue = e.projectPath;
          this.touch('status');
        }
        break;
      case 'projectSaved':
        if (this.projectPathValue !== e.path) {
          this.projectPathValue = e.path;
          this.touch('status');
        }
        break;
      case 'layerErrors': {
        const prev = this.errors.get(e.comp);
        const next = keep(prev as LayerError[] | undefined, e.errors);
        if (next !== prev) {
          this.errors.set(e.comp, next);
          this.touch(`errors:${e.comp}`);
        }
        break;
      }
      default:
        // transport / playhead / stats / cache / jobs: not document state.
        break;
    }
  }

  // ── Values at a time ───────────────────────────────────────────────────

  private requestValue(layer: string, path: string, time: number): void {
    let set = this.valueRequests.get(time);
    if (!set) {
      set = new Map();
      this.valueRequests.set(time, set);
    }
    set.set(`${layer}\u0000${path}`, { layer, path });
    // In-process: answer now (the caller reads the cache right after).
    if (this.source.querySync) {
      this.flushValues(true);
      if (this.valueRequests.size === 0) return;
    }
    if (this.valueFlushScheduled) return;
    this.valueFlushScheduled = true;
    void Promise.resolve().then(() => {
      this.valueFlushScheduled = false;
      this.flushValues(false);
    });
  }

  private flushValues(syncOnly: boolean): void {
    for (const [time, refs] of [...this.valueRequests]) {
      const props = [...refs.values()].map((r) => ({ layer: r.layer, path: r.path }));
      const q: QueryOf<'getPropertyValues'> = { type: 'getPropertyValues', props, time, evaluated: true };
      const sync = this.source.querySync?.(q);
      if (sync) {
        this.valueRequests.delete(time);
        this.storeValues(time, sync, true);
        continue;
      }
      if (syncOnly) continue;
      this.valueRequests.delete(time);
      const gen = this.generationValue;
      this.track(this.source.query(q)).then((r) => {
        if (gen === this.generationValue) this.storeValues(time, r, false);
      }, () => { /* the next ask retries */ });
    }
  }

  private storeValues(time: number, r: EngineResult<PropertyValues>, sync: boolean): void {
    if (!r.ok) return;
    // An answer from before the mirror's revision is stale; from after it, the
    // events that got there are on their way — cache it at the mirror's
    // revision only when it matches, else show it once and let the next ask refresh.
    const rev = r.revision === this.rev ? this.rev : -1;
    for (const v of r.value.values) {
      const key = `${v.prop.layer}\u0000${v.prop.path}\u0000${time}`;
      const prev = this.values.get(key);
      const value = keep(prev?.value, v.value);
      this.values.set(key, { rev, value });
      if (!sync && value !== prev?.value) this.touch(`value:${v.prop.layer}|${v.prop.path}`);
    }
    if (this.values.size > 20_000) {
      // Old times pile up while scrubbing; keep the current revision's answers.
      for (const [k, v] of this.values) if (v.rev !== this.rev) this.values.delete(k);
    }
    if (!sync) this.flushNotify();
  }
}

// ── The app's mirror ─────────────────────────────────────────────────────

let appMirror: DocumentMirror | null = null;
let appSourceFactory: (() => MirrorSource) | null = null;

/**
 * Wire the app mirror to the session's engine (engineInstance.ts does this at
 * import, so src/stores never imports src/core/engine directly for it).
 */
export function setAppMirrorSource(factory: () => MirrorSource): void {
  appSourceFactory = factory;
}

/** The editor session's mirror, started on first use. */
export function documentMirror(): DocumentMirror {
  if (!appMirror) {
    if (!appSourceFactory) throw new Error('documentMirror: no engine source registered (import @core/engine/engineInstance)');
    appMirror = new DocumentMirror(appSourceFactory()).start();
  }
  return appMirror;
}

/** Whether the app mirror exists (without starting it). */
export function hasDocumentMirror(): boolean {
  return appMirror !== null;
}

/** Drop the app mirror (tests; a fresh one starts on next use). */
export function resetDocumentMirror(): void {
  appMirror?.stop();
  appMirror = null;
}
