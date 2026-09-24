/**
 * Viewport drag gesture — one transaction per pointer GESTURE instead of one
 * per pointer EVENT.
 *
 * The transform ports (`moveNodes`, `resizeNode`, `rotateNode`,
 * `applyGizmo3DTransforms`, …) are called once per pointermove — 120-240×/s on
 * a modern mouse. Each call used to pay two O(project) costs that exist only
 * for bookkeeping, not pixels:
 *
 *   • `runAnimEdit` takes TWO full `engine.snapshot()`s (every keyframe of
 *     every track in the project, deep-copied) plus a whole-project diff, per
 *     event — when `beginAnimEdit`/`commit` exists precisely so a drag can pay
 *     that once. The graph editor, puppet and bone overlays already use the
 *     transaction; the viewport never did.
 *   • `bumpScene()` announces a STRUCTURAL change, whose subscribers walk the
 *     whole scene (timeline syncFromScene, selection pruning, autosave and
 *     thumbnail scheduling) — for a write that moved a value on an existing
 *     node. `InspectorAPI.ts` documents `bumpSceneRevision()` as the correct
 *     call for value-only writes; the live UI reads `NodeUpdated` anyway.
 *
 * While a gesture is open, `gestureAnimEdit` mutates the engine directly under
 * one lazily-started transaction, and `gestureSceneBump` degrades to the cheap
 * revision bump. `endViewportGesture` records the single undo command (same
 * label/mergeKey the per-event path would have used, so cross-drag coalescing
 * at the same playhead is unchanged) and fires ONE structural `bumpScene()` —
 * which the coarse history store still needs, because a static (un-keyframed)
 * drag's undo lives there and nowhere else.
 *
 * Outside a gesture every helper falls through to the classic path, so
 * keyboard nudges, AI tools and tests behave exactly as before.
 *
 * ── The engine side (B3) ─────────────────────────────────────────────────
 *
 * The tools' writes now go to the engine API as ONE engine gesture per pointer
 * gesture: `sendToolEdit` opens a `ToolTransaction` (a `GestureSession`) on the
 * gesture's first write and sends each message through it — latest wins, so
 * every message must carry ABSOLUTE values (docs/B3_PATTERNS.md §3); the
 * transaction's `memo` holds the drag-start state the writers compute them
 * from. `endViewportGesture` commits it (one undo entry), `cancelToolGesture`
 * (Esc) reverts it. A write outside any pointer gesture is a one-shot `edit`,
 * or — for key/wheel repeats that should read as one action — a BURST: one
 * transaction kept open while the presses keep coming, committed after a
 * short idle (the timeline's keyframe nudge does the same).
 */

import type { Command } from '@motion/engine-api';
import { beginAnimEdit, recordAnimEdit, runAnimEdit } from '@core/animation/animationCommands';
import { edit, GestureSession } from '@core/engine/uiEdits';
import { bumpScene, bumpSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';

type AnimTx = ReturnType<typeof beginAnimEdit>;

/** Nesting depth — a stray second pointer must not end the first drag's tx. */
let depth = 0;
let tx: AnimTx | null = null;
let txLabel = '';
let txMergeKey: string | undefined;
let structuralDirty = false;

/** True while a viewport pointer gesture is in flight. */
export function viewportGestureActive(): boolean {
  return depth > 0;
}

/** Open a gesture. Pair with `endViewportGesture` on pointerup/cancel/blur. */
export function beginViewportGesture(): void {
  depth++;
  // A press ends any key/wheel burst: the burst and the drag are two actions.
  if (depth === 1) flushToolBursts();
  /*
    The gesture IS the drag, so it raises the drag flag itself.

    `useUIStore.isDragging` is what the render loop reads (through
    `renderQualityStore.interacting`) to decide whether the RAM preview may be
    SERVED: mid-gesture the cache key does not move, so a served frame is the
    pre-drag picture. The canvas selection drag set the flag from its own
    pointer handlers; the 3D gizmo, the light / camera handles and the focus
    plane did not — they opened a gesture and wrote props, and the viewport
    kept blitting the cached frame over their live renders. On screen: the
    gizmo wireframe followed the pointer while the object stayed put, then
    jumped when the idle pump or the release invalidated the cache. Raising it
    here covers every gesture caller at once instead of one handler at a time.
  */
  if (depth === 1) useUIStore.getState().setDragging(true);
}

/**
 * Close the gesture: record the drag's single undo command and announce the
 * one structural change. Safe to call without a matching begin (no-op).
 */
export function endViewportGesture(): void {
  if (depth === 0) return;
  depth--;
  if (depth > 0) return;
  useUIStore.getState().setDragging(false);
  const txn = pointerTxn;
  pointerTxn = null;
  if (txn) void txn.end();
  const pending = tx;
  tx = null;
  if (pending) recordAnimEdit(pending.commit(txLabel, txMergeKey));
  if (structuralDirty) {
    structuralDirty = false;
    bumpScene();
  }
}

/**
 * B3-gap: the legacy writers' transaction (`gestureAnimEdit` below and the
 * record in `endViewportGesture`). Every viewport gizmo / tool drag already
 * runs as ONE engine gesture (`ToolTransaction` above), outlines included
 * (B3 paths); this path is only reached by the node-prop writer
 * `applyNodePropsKeyframed` (ports.ts) — `cameraCommands`' synchronous
 * callers and a node outside a composition. Deleted with it.
 *
 * `runAnimEdit`, gesture-aware: inside a gesture the mutation applies directly
 * under the gesture's single transaction; outside it is the classic
 * capture-per-call. The LAST label/mergeKey of the gesture wins — they are
 * stable for a drag by construction (`drag:move:<t>:<ids>` etc.).
 */
export function gestureAnimEdit(label: string, mutate: () => void, mergeKey?: string): void {
  if (depth === 0) {
    runAnimEdit(label, mutate, mergeKey);
    return;
  }
  if (!tx) tx = beginAnimEdit();
  txLabel = label;
  txMergeKey = mergeKey;
  mutate();
}

/**
 * `bumpScene()`, gesture-aware: inside a gesture only the revision advances
 * (live views re-render off `NodeUpdated`/rev); the structural announcement is
 * deferred to `endViewportGesture`, once.
 */
export function gestureSceneBump(): void {
  if (depth === 0) {
    bumpScene();
    return;
  }
  structuralDirty = true;
  bumpSceneRevision();
}

// ── Engine transactions (B3) ──────────────────────────────────────────────

/**
 * One tool action as ONE engine gesture = one undo entry.
 *
 * The session opens lazily, on the first write, with that write's label — a
 * press that edits nothing (a click that only selects) records nothing. After
 * `cancel` every later write of the same action is dropped: the pointer is
 * still down and the tool keeps sending, but the user has said no.
 */
/** Commands, or a builder that makes them when the message can be sent. */
export type ToolCommands = readonly Command[] | (() => readonly Command[] | null);

function resolveCommands(c: ToolCommands): readonly Command[] {
  return (typeof c === 'function' ? c() : c) ?? [];
}

export class ToolTransaction {
  private session: GestureSession | null = null;
  /** Waiting for the previous action's gesture to close before opening ours. */
  private opening: Promise<void> | null = null;
  /** Messages sent while `opening`: latest wins over a droppable one, a kept one stays (as in a session). */
  private queued: Array<{ label: string; commands: ToolCommands; keep: boolean }> = [];
  private cancelled = false;
  private done = false;
  private readonly scratch = new Map<string, unknown>();

  /**
   * Send the edit for the CURRENT state (absolute values; latest wins).
   *
   * `commands` may be a BUILDER: it runs when the message can actually go —
   * at once while the gesture is open, else once the previous action's
   * gesture has closed — so a drag-start state it captures (`memo`) is read
   * from a document that already holds the previous action. Only the latest
   * builder runs; a builder returning null or [] sends nothing.
   *
   * `keep`: a STRUCTURAL step the later absolute messages build on (a vertex
   * inserted at pointer down) — never dropped for a later message (GestureSession).
   */
  send(label: string, commands: ToolCommands, opts: { keep?: boolean } = {}): void {
    if (this.cancelled || this.done) return;
    const keep = opts.keep === true;
    if (this.session) {
      const list = resolveCommands(commands);
      if (list.length > 0) this.session.send(list, { keep });
      return;
    }
    // The engine holds ONE gesture at a time, and the previous action's end
    // is asynchronous (a nudge burst committed by this very press, a drag
    // released a frame ago): open ours only once that one has closed, or the
    // engine would see two and commit the older one into ours.
    const open = (msgs: ReadonlyArray<{ label: string; commands: ToolCommands; keep: boolean }>): void => {
      for (const m of msgs) {
        const list = resolveCommands(m.commands);
        if (list.length === 0) continue;
        this.session ??= new GestureSession(m.label);
        this.session.send(list, { keep: m.keep });
      }
    };
    if (pendingEnds === 0 && !this.opening) {
      // Nothing is closing: open now (the common case — no extra hop).
      open([{ label, commands, keep }]);
      return;
    }
    const last = this.queued[this.queued.length - 1];
    if (!keep && last && !last.keep) this.queued[this.queued.length - 1] = { label, commands, keep };
    else this.queued.push({ label, commands, keep });
    this.opening ??= settleToolEdits().then(() => {
      const q = this.queued;
      this.queued = [];
      if (q.length === 0 || this.cancelled) return;
      open(q);
    });
  }

  /** Per-action state (the drag-start values): computed once, then reused. */
  memo<T>(key: string, init: () => T): T {
    if (this.scratch.has(key)) return this.scratch.get(key) as T;
    const v = init();
    this.scratch.set(key, v);
    return v;
  }

  /** The memo under `key`, if this action made one. */
  peek<T>(key: string): T | undefined {
    return this.scratch.get(key) as T | undefined;
  }

  /** True once a write has been sent. */
  get hasEdits(): boolean {
    return this.session !== null || this.opening !== null;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Commit (default) or revert. Idempotent. */
  end(commit = true): Promise<void> {
    if (this.done) return Promise.resolve();
    this.done = true;
    return trackEnd((async () => {
      if (this.opening) await this.opening;
      const s = this.session;
      this.session = null;
      this.scratch.clear();
      if (s) await s.end(commit && !this.cancelled);
    })());
  }

  /** Esc: revert everything this action wrote; ignore what it sends next. */
  cancel(): Promise<void> {
    this.cancelled = true;
    this.queued = [];
    return trackEnd((async () => {
      if (this.opening) await this.opening;
      const s = this.session;
      this.session = null;
      if (s) await s.cancel();
    })());
  }
}

/** Every tool action's close (commit / revert), chained in order. */
let endsSettled: Promise<void> = Promise.resolve();

/** Ends still in flight — while 0, a new action opens without waiting. */
let pendingEnds = 0;

function trackEnd(p: Promise<void>): Promise<void> {
  pendingEnds += 1;
  const chained = endsSettled.then(() => p).catch(() => { /* reported by the session */ })
    .finally(() => { pendingEnds -= 1; });
  endsSettled = chained;
  return chained;
}

/**
 * Resolves once every tool action ended so far has closed its engine
 * gesture. A one-shot edit (Delete, a click) and the next action's gesture
 * wait for it; tests await it before `engineIdle()`.
 */
export function settleToolEdits(): Promise<void> {
  return endsSettled;
}

/** The transaction of the pointer gesture in flight (created on first use). */
let pointerTxn: ToolTransaction | null = null;

/**
 * The open pointer gesture's transaction, or null outside a pointer gesture
 * (a keyboard edit, a test calling a port directly).
 */
export function currentToolTransaction(): ToolTransaction | null {
  if (depth === 0) return null;
  pointerTxn ??= new ToolTransaction();
  return pointerTxn;
}

/**
 * Esc during a viewport drag: revert what the drag has written so far and
 * ignore the rest of it. Returns whether there was anything to revert.
 */
export function cancelToolGesture(): boolean {
  const txn = pointerTxn;
  if (!txn || !txn.hasEdits || txn.isCancelled) return false;
  void txn.cancel();
  return true;
}

// ── Bursts (key repeats, wheel ticks) ─────────────────────────────────────

interface Burst {
  key: string;
  txn: ToolTransaction;
  timer: ReturnType<typeof setTimeout> | null;
  idleMs: number;
}

let burst: Burst | null = null;
let burstListening = false;

const onBurstKey = (e: KeyboardEvent): void => {
  // Arrow repeats continue a nudge burst; anything else (Ctrl+Z included) is
  // a new action and must find the burst committed.
  if (burst && !(burst.key.startsWith('nudge') && e.key.startsWith('Arrow'))) flushToolBursts();
};
const onBurstPointer = (): void => {
  flushToolBursts();
};

function listenForBurstEnd(on: boolean): void {
  if (typeof window === 'undefined' || on === burstListening) return;
  burstListening = on;
  if (on) {
    window.addEventListener('keydown', onBurstKey, true);
    window.addEventListener('pointerdown', onBurstPointer, true);
  } else {
    window.removeEventListener('keydown', onBurstKey, true);
    window.removeEventListener('pointerdown', onBurstPointer, true);
  }
}

/**
 * The transaction of the burst `key` — opened on the first call, kept while
 * calls keep coming within `idleMs` of each other, committed after that idle
 * (or at once by another key, a press, or a burst with a different key).
 */
export function burstTransaction(key: string, idleMs: number): ToolTransaction {
  if (burst && burst.key !== key) flushToolBursts();
  if (!burst) {
    burst = { key, txn: new ToolTransaction(), timer: null, idleMs };
    listenForBurstEnd(true);
  }
  const b = burst;
  if (b.timer !== null) clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    if (burst === b) flushToolBursts();
  }, b.idleMs);
  return b.txn;
}

/** The OPEN burst `key`'s transaction, without opening or extending one. */
export function openBurstTransaction(key: string): ToolTransaction | null {
  return burst && burst.key === key ? burst.txn : null;
}

/** Commit any open burst now. */
export function flushToolBursts(): void {
  const b = burst;
  if (!b) return;
  burst = null;
  if (b.timer !== null) clearTimeout(b.timer);
  listenForBurstEnd(false);
  void b.txn.end();
}

/** Whether a burst is open (tests). */
export function toolBurstOpen(): boolean {
  return burst !== null;
}

/**
 * Send a tool's edit: into the open pointer gesture's transaction, else into
 * `txn` when the caller has one (a burst), else as a one-shot `edit`.
 */
export function sendToolEdit(
  label: string,
  commands: ToolCommands,
  txn: ToolTransaction | null = currentToolTransaction(),
  opts: { keep?: boolean } = {},
): void {
  if (txn) {
    txn.send(label, commands, opts);
    return;
  }
  void runToolEdit(label, commands);
}

/**
 * A one-shot tool edit (a key press, a click) as ONE entry — after any tool
 * action still closing, so it never meets that action's open gesture.
 */
export function runToolEdit(label: string, commands: ToolCommands): Promise<Awaited<ReturnType<typeof edit>> | null> {
  const run = async (): Promise<Awaited<ReturnType<typeof edit>> | null> => {
    const list = resolveCommands(commands);
    return list.length > 0 ? edit(label, list) : null;
  };
  return pendingEnds === 0 ? run() : settleToolEdits().then(run);
}
