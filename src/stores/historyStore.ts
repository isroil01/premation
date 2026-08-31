/**
 * History store.
 *
 * Holds an ordered list of fully non-destructive snapshots of the editable
 * state (scene graph + animation). Jumping to an entry restores that state;
 * it never mutates source data. Entries can be renamed ("Client v1 look").
 *
 * Recording is driven from Providers: an initial "Open" entry, then a debounced
 * capture after edits. The `restoring` guard stops a jump from recording itself.
 */

import { create } from 'zustand';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { defaultAnimation, type AnimSnapshot } from '@motion/animation';
import type { ProjectFile } from '@core/types';
import { bumpScene } from './sceneStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import type { IUndoableCommand, CommandContext } from '@core/commands/Command';

/** Deep-clone the current editable state into a snapshot. */
function captureState(): { scene: ProjectFile; anim: AnimSnapshot } {
  return {
    scene: structuredClone(sceneProjectIO.capture()),
    anim: defaultAnimation.snapshot(),
  };
}

export class StoreSnapshotCommand implements IUndoableCommand {
  readonly label: string;
  /**
   * A deliberate, user-meaningful entry (the "Open" baseline, a pinned
   * snapshot) rather than an auto-captured edit. `record`'s flag used to be
   * ignored while the History panel read `(e as any).named` — always undefined
   * — so a pinned snapshot looked identical to every auto entry.
   */
  readonly named: boolean;
  private readonly before: { scene: ProjectFile; anim: AnimSnapshot };
  private readonly after: { scene: ProjectFile; anim: AnimSnapshot };

  constructor(
    label: string,
    before: { scene: ProjectFile; anim: AnimSnapshot },
    after: { scene: ProjectFile; anim: AnimSnapshot },
    named = false,
  ) {
    this.label = label;
    this.before = before;
    this.after = after;
    this.named = named;
  }

  execute(_ctx: CommandContext): void {
    sceneProjectIO.restore(structuredClone(this.after.scene));
    defaultAnimation.restore(this.after.anim);
    bumpScene();
  }

  undo(_ctx: CommandContext): void {
    sceneProjectIO.restore(structuredClone(this.before.scene));
    defaultAnimation.restore(this.before.anim);
    bumpScene();
  }
}

function statesEqual(
  a: { scene: ProjectFile; anim: AnimSnapshot } | null,
  b: { scene: ProjectFile; anim: AnimSnapshot } | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Debounce window for coalescing a burst of edits into one history entry. */
const RECORD_DEBOUNCE_MS = 700;

export interface HistoryStore {
  restoring: boolean;
  record: (label?: string, named?: boolean) => void;
  /**
   * Coalesce rapid edits into a single entry. Call on every edit event.
   *
   * `key` identifies WHAT is being edited (node + property, or the kind of
   * structural change). A pending entry whose key differs is committed first,
   * so only a genuine burst on the SAME target coalesces. Without it the window
   * merged whatever happened to fall inside 700 ms — recolour one layer, move
   * another, and both vanished on a single Ctrl+Z with no way to get one back.
   */
  schedule: (key?: string) => void;
  /**
   * Record any pending edit NOW.
   *
   * Undo/redo MUST call this first. Otherwise an edit inside the debounce
   * window is still unrecorded when the user hits Ctrl+Z, so undo pops the
   * PREVIOUS entry — whose "before" predates the pending edit — and both the
   * pending edit and the previous action are discarded by one keystroke.
   */
  flush: () => void;
  /** Run a state restore without recording it as a new edit. */
  runRestoring: (fn: () => void) => void;
  reset: () => void;
}

let seq = 0;
let lastState: { scene: ProjectFile; anim: AnimSnapshot } | null = null;

let recordTimer: ReturnType<typeof setTimeout> | undefined;
/** What the pending debounced entry is editing (see `schedule`). */
let pendingKey: string | undefined;
/** Key forced on every `schedule` inside a `batchHistory` (see below). */
let groupKey: string | undefined;

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  restoring: false,

  record: (label, named = false) => {
    if (get().restoring) return;
    clearTimeout(recordTimer);
    recordTimer = undefined;
    pendingKey = undefined;
    const currentState = captureState();

    // A NAMED record is a deliberate act — the "Open" baseline, or the History
    // panel's pin button — so it always produces a row. Auto-captures only
    // record a real change.
    //
    // Both guards used to block the baseline: `record('Open')` runs right after
    // `reset`, whose `clear` emits UndoStackChanged, whose listener sets
    // `lastState` to the current state. So `statesEqual` was true and nothing
    // was pushed — the document's opening state had no row to jump back to.
    if (!named) {
      if (!lastState || statesEqual(lastState, currentState)) {
        lastState = currentState;
        return;
      }
    }

    getCommandSystem().getHistory().push(
      new StoreSnapshotCommand(
        label ?? `Edit ${(seq += 1)}`,
        lastState ?? currentState,
        currentState,
        named,
      ),
    );
    lastState = currentState;
  },

  schedule: (rawKey) => {
    if (get().restoring) return;
    // Inside a `batchHistory` every write reports the SAME target, so the
    // key-change rule below cannot split one edit into several.
    const key = groupKey ?? rawKey;
    // A different target means a different action: commit the pending one so it
    // keeps its own undo step rather than being absorbed into this one.
    if (recordTimer !== undefined && key !== undefined && pendingKey !== undefined && key !== pendingKey) {
      get().record(); // clears the timer
    }
    pendingKey = key;
    clearTimeout(recordTimer);
    recordTimer = setTimeout(() => {
      recordTimer = undefined;
      pendingKey = undefined;
      get().record();
    }, RECORD_DEBOUNCE_MS);
  },

  flush: () => {
    if (recordTimer === undefined) return;
    get().record(); // clears the timer itself
  },

  runRestoring: (fn) => {
    // `restoring` was declared and never written, so every guard reading it was
    // permanently dead — contradicting this module's own documented contract.
    set({ restoring: true });
    try {
      fn();
    } finally {
      set({ restoring: false });
      // The restore IS the new baseline; without this the next edit would diff
      // against pre-restore state and record a bogus entry.
      lastState = captureState();
    }
  },

  reset: () => {
    clearTimeout(recordTimer);
    recordTimer = undefined;
    pendingKey = undefined;
    lastState = null;
    getCommandSystem().getHistory().clear();
  },
}));

/**
 * The ONLY ways to move through history.
 *
 * Every entry point must flush the pending debounced snapshot first and mark
 * the restore, or it reintroduces the two-actions-per-Ctrl+Z bug. Undo was
 * reachable from four places (the command, both TopNav buttons and the History
 * panel) — so this lives here rather than being repeated at each call site.
 */
/**
 * Re-baseline history onto a freshly LOADED document.
 *
 * The "Open" baseline is captured during boot, right after `seedDefaultScene`
 * — but a project loads AFTERWARDS and asynchronously. Without this, history's
 * `lastState` still described the seeded demo scene, so the load itself became
 * an undoable entry whose "before" was that demo scene: **one Ctrl+Z after
 * opening a project replaced it with the starter content.** That is how a layer
 * could vanish on the first undo of a session.
 *
 * Call this at every LOAD boundary (open a bundle, restore a recovery snapshot),
 * never on incremental sync — a cross-window document push is not a load and
 * must not wipe the user's undo stack.
 */
export function baselineHistory(label = 'Open'): void {
  // Never let history stop a document from loading. `reset`/`record` reach into
  // the CommandSystem, which is not initialized in headless contexts (tests,
  // pop-out boot order) — and a project failing to open because the undo stack
  // was not ready would be a far worse bug than the one this fixes.
  try {
    const h = useHistoryStore.getState();
    h.reset();
    h.record(label, true);
  } catch {
    /* no CommandSystem yet — nothing to baseline against */
  }
}

export function performUndo(): void {
  const h = useHistoryStore.getState();
  h.flush();
  if (!getCommandSystem().getHistory().canUndo()) return;
  h.runRestoring(() => getCommandSystem().getHistory().undo());
}

export function performRedo(): void {
  const h = useHistoryStore.getState();
  h.flush();
  if (!getCommandSystem().getHistory().canRedo()) return;
  h.runRestoring(() => getCommandSystem().getHistory().redo());
}

export function performJumpTo(index: number): void {
  const h = useHistoryStore.getState();
  h.flush();
  h.runRestoring(() => getCommandSystem().getHistory().jumpTo(index));
}

import { getEventBus } from '@core/events/EventBus';
import { isMediaDecodeRepaint } from '@core/rendering/mediaRepaint';

/**
 * Keep `lastState` in step with the undo stack. MUST be called from inside the
 * boot sequence, never at module scope.
 *
 * This was a module-scope `getEventBus().on(...)` and it never fired once.
 * `Application.boot()` calls `setEventBus(new EventBus())`, so any subscription
 * made before boot resolves is attached to a bus that is then discarded — the
 * hazard already recorded at `Providers.tsx` for the cross-window sync, hitting
 * a second victim here. The listener existed, was correct, and was wired to
 * nothing.
 *
 * Two consequences, both live until now:
 *   • every command-covered edit ALSO produced a generic `Edit N` snapshot,
 *     because the baseline was never refreshed after a command push, so
 *     `statesEqual` compared against a stale state and always saw a change.
 *     Ctrl+Z took two presses for one gesture, app-wide;
 *   • after an undo or redo the baseline was stale, so the NEXT snapshot's
 *     `before` was the pre-undo state rather than the current one.
 *
 * Returns its disposer so the caller can tear it down with the rest of boot.
 */
export function attachHistoryBaselineSync(): { dispose(): void } {
  return getEventBus().on('UndoStackChanged', () => {
    lastState = captureState();
  });
}

/**
 * Wire the WHOLE recording mechanism: the debounced edit capture and the
 * baseline sync that decides whether a capture is redundant.
 *
 * These four subscriptions were four separate `track(...)` lines in the boot
 * sequence, and three of them worked while the fourth had been attached at
 * module scope and never fired. Splitting them across two files is what let
 * that happen and what kept it invisible: nothing owned "recording is wired",
 * so nothing could be missing it.
 *
 * They belong together because they are not independent — `schedule` decides
 * WHEN to capture and the baseline decides WHETHER the capture is a real
 * change. With the baseline missing, `schedule` fires into a permanently stale
 * comparison and every commanded edit records a second, generic entry on top of
 * the command's own. Half of this wiring is not a degraded version of it; it is
 * the bug (§2·0 — one attach point makes the half-wired state unrepresentable).
 *
 * MUST be called from inside boot, never at module scope: `Application.boot()`
 * calls `setEventBus(new EventBus())` and discards whatever a module-scope
 * subscription attached to. Returns one disposer for all four.
 */
/**
 * Run `fn` as ONE undoable action, however many props it writes.
 *
 * `schedule` treats a change of target as a change of action, which is what
 * keeps two consecutive edits to different properties out of each other's undo
 * step. An edit that legitimately writes SEVERAL props at once trips over that:
 * the linked corner radius writes `cornerRadius` plus all four corners plus the
 * link flag, and came out as six undo steps for one drag of one field.
 *
 * Not the same tool as `batchScene`, which defers a NOTIFICATION. This renames
 * the TARGET so the debounce can do its job. Nests; the outermost name wins,
 * because an inner group is part of the outer action by construction.
 */
export function batchHistory<T>(key: string, fn: () => T): T {
  const prev = groupKey;
  groupKey = prev ?? key;
  try {
    return fn();
  } finally {
    groupKey = prev;
  }
}

export function attachHistoryRecording(): { dispose(): void } {
  const h = (): HistoryStore => useHistoryStore.getState();
  const subs = [
    // Decoding a video frame is not an undoable edit.
    getEventBus().on('AnimationChanged', (p) => { if (!isMediaDecodeRepaint(p)) h().schedule('anim'); }),
    getEventBus().on('NodeUpdated', (e) => {
      const p = e as { nodeId?: string; propName?: string } | undefined;
      h().schedule(p?.nodeId ? `node:${p.nodeId}:${p.propName ?? ''}` : 'node');
    }),
    // Structural edits (add/delete/reparent) are their own action.
    getEventBus().on('SceneGraphChanged', () => h().schedule('scene')),
    attachHistoryBaselineSync(),
  ];
  return { dispose(): void { for (const s of subs) s.dispose(); } };
}
