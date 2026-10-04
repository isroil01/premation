/**
 * History: where the app's undo / redo / jump go, and the stack reset at a
 * load boundary.
 *
 * Every document edit is an engine command with its own exact inverse
 * (ENGINE_API.md §4.1, §5.3); the engine's `undo` / `redo` / `jumpToHistory`
 * walk that stack. The 700 ms debounced recorder that used to turn a legacy
 * writer's bus traffic into a whole-document snapshot entry is gone (B5 round
 * 2): a write made around the engine has no undo of its own.
 */

import { getCommandSystem } from '@core/commands/CommandSystem';
import { getEventBus } from '@core/events/EventBus';
import { documentMirror } from './documentMirror';

/**
 * Empty the undo stack (the app's history service). A LOAD boundary — open a
 * bundle, restore a recovery snapshot, swap the project — must not let one
 * Ctrl+Z step back into the previous document. With an engine running, prefer
 * `baselineHistoryEdit` (core/engine/historyBaseline.ts), which also adds the
 * named "Open" checkpoint the History panel starts from.
 *
 * Never lets history stop a document from loading: the CommandSystem is not
 * built in headless contexts (tests, pop-out boot order).
 */
export function resetHistory(): void {
  try {
    getCommandSystem().getHistory().clear();
  } catch {
    /* no CommandSystem yet — nothing to reset */
  }
}

/**
 * Where the app's undo/redo/jump go when a document engine is running: the
 * engine's own `undo` / `redo` / `jumpToHistory` commands (ENGINE_API.md §4.1),
 * so a keyboard undo is a REQUEST — it lands in the command log and a recorded
 * session replays revision-exact. The engine walks the same shared stack
 * (foreign entries included). Registered by `core/engine/engineInstance` for
 * the current instance.
 */
export interface HistoryRoute {
  step(dir: 'undo' | 'redo'): Promise<unknown>;
  /** `position` = entries applied afterwards (HistoryService index + 1). */
  jump(position: number): Promise<unknown>;
}

let historyRoute: HistoryRoute | null = null;

export function setHistoryRoute(route: HistoryRoute | null): void {
  historyRoute = route;
}

/**
 * Undo (Ctrl+Z, Edit ▸ Undo, the toolbar). With an engine, resolves once the
 * engine applied it (callers may fire and forget); a refusal (a drag still
 * open, nothing to undo) changes nothing. Without one (headless), the history
 * service steps directly.
 */
export function performUndo(): Promise<void> {
  // The engine refuses an undo with nothing to undo (nothingToUndo): no gate.
  if (historyRoute) return historyRoute.step('undo').then(() => undefined, () => undefined);
  if (!getCommandSystem().getHistory().canUndo()) return Promise.resolve();
  getCommandSystem().getHistory().undo();
  return Promise.resolve();
}

export function performRedo(): Promise<void> {
  if (historyRoute) return historyRoute.step('redo').then(() => undefined, () => undefined);
  if (!getCommandSystem().getHistory().canRedo()) return Promise.resolve();
  getCommandSystem().getHistory().redo();
  return Promise.resolve();
}

/** One row of the history list, oldest first. */
export interface HistoryRow {
  label: string;
}

/** The history as the UI shows it: the rows, the applied one (-1 = none) and what can step. */
export interface HistoryView {
  entries: readonly HistoryRow[];
  index: number;
  canUndo: boolean;
  canRedo: boolean;
}

const EMPTY_VIEW: HistoryView = { entries: [], index: -1, canUndo: false, canRedo: false };

/**
 * The history the engine walks (the mirror's `historyChanged`), with an engine
 * running; else the page history service (headless). Nothing yet = empty.
 */
export function historyView(): HistoryView {
  if (historyRoute) {
    let h;
    try {
      h = documentMirror().history;
    } catch {
      h = null;
    }
    if (!h) return EMPTY_VIEW;
    return {
      entries: h.state.entries.map((e) => ({ label: e.label })),
      index: h.state.position - 1,
      canUndo: h.state.canUndo,
      canRedo: h.state.canRedo,
    };
  }
  try {
    const s = getCommandSystem().getHistory();
    return { entries: s.getEntries().map((e) => ({ label: e.label })), index: s.getIndex(), canUndo: s.canUndo(), canRedo: s.canRedo() };
  } catch {
    return EMPTY_VIEW;
  }
}

/** Told whenever `historyView()` may have changed. Returns the unsubscribe. */
export function subscribeHistory(listener: () => void): () => void {
  let offMirror: (() => void) | null = null;
  try {
    offMirror = documentMirror().subscribe(['history'], listener);
  } catch {
    // No engine registered (headless): the page history's own event only.
  }
  const sub = getEventBus().on('UndoStackChanged', listener);
  return () => {
    offMirror?.();
    sub.dispose();
  };
}

export function performJumpTo(index: number): Promise<void> {
  if (historyRoute) return historyRoute.jump(index + 1).then(() => undefined, () => undefined);
  getCommandSystem().getHistory().jumpTo(index);
  return Promise.resolve();
}
