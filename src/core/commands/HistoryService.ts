/**
 * History / UndoRedo service.
 *
 * Maintains two stacks of commands. A command participates in undo only if
 * it provides an `undo()` method. The service itself is engine-agnostic
 * — it does not know what state commands mutate.
 */

import { getEventBus } from '@core/events/EventBus';
import type { CommandContext, IUndoableCommand } from './Command';

/** Builds the context a command's execute()/undo() runs with during undo/redo. */
export type ContextBuilder = (command: IUndoableCommand) => CommandContext;

export class HistoryService {
  private readonly undoStack: IUndoableCommand[] = [];
  private readonly redoStack: IUndoableCommand[] = [];
  private readonly capacity: number;
  private readonly buildContext?: ContextBuilder;
  private suspended = 0;

  constructor(capacity = 500, buildContext?: ContextBuilder) {
    this.capacity = capacity;
    this.buildContext = buildContext;
  }

  /** Top of the undo stack without popping (used to coalesce edits). */
  peek(): IUndoableCommand | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  /** Returns all commands in chronological order for UI display. */
  getEntries(): IUndoableCommand[] {
    return [...this.undoStack, ...[...this.redoStack].reverse()];
  }

  /** Returns the index of the currently applied command in the combined entries list. */
  getIndex(): number {
    return this.undoStack.length - 1;
  }

  /** Rename the entry at combined-index `i` (as returned by getEntries) for
   *  display in the History panel. Returns false if the index is out of range. */
  setLabel(i: number, label: string): boolean {
    const entry = this.getEntries()[i];
    if (!entry) return false;
    (entry as { label: string }).label = label;
    this.emit();
    return true;
  }

  /** Push a command onto the undo stack. */
  push(command: IUndoableCommand): void {
    if (this.suspended > 0) return;
    this.undoStack.push(command);
    if (this.undoStack.length > this.capacity) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.emit();
  }

  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    this.suspended++;
    try {
      void command.undo(this.ctxFor(command));
    } finally {
      this.suspended--;
    }
    this.redoStack.push(command);
    this.emit();
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    this.suspended++;
    try {
      void command.execute(this.ctxFor(command));
    } finally {
      this.suspended--;
    }
    this.undoStack.push(command);
    this.emit();
  }

  canUndo(): boolean {
    const top = this.undoStack[this.undoStack.length - 1];
    return !!top;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  jumpTo(index: number): void {
    const currentIndex = this.getIndex();
    if (index === currentIndex) return;

    this.withSuppressed(() => {
      if (index < currentIndex) {
        // Undo until we reach the desired index
        const steps = currentIndex - index;
        for (let i = 0; i < steps; i++) {
          const cmd = this.undoStack.pop();
          if (cmd) {
            void cmd.undo(this.ctxFor(cmd));
            this.redoStack.push(cmd);
          }
        }
      } else {
        // Redo until we reach the desired index
        const steps = index - currentIndex;
        for (let i = 0; i < steps; i++) {
          const cmd = this.redoStack.pop();
          if (cmd) {
            void cmd.execute(this.ctxFor(cmd));
            this.undoStack.push(cmd);
          }
        }
      }
    });
    this.emit();
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit();
  }

  /** Temporary suppression — used by macro commands. */
  withSuppressed(fn: () => void): void {
    this.suspend();
    try { fn(); } finally { this.resume(); }
  }

  /**
   * Suppress pushes until the matching `resume()`. Re-entrant (counted).
   *
   * The scoped `withSuppressed` can't cover an ASYNC macro — an AI run spans
   * many awaits — so callers that span ticks pair these manually and must
   * guarantee `resume()` (e.g. in a finally). Prefer `withSuppressed` whenever
   * the work is synchronous.
   */
  suspend(): void {
    this.suspended++;
  }

  resume(): void {
    if (this.suspended > 0) this.suspended--;
  }

  private ctxFor(command: IUndoableCommand): CommandContext {
    // CommandSystem injects a context builder at construction so undo()/redo()
    // can re-run commands with the same services execute() saw. Commands whose
    // execute()/undo() are self-contained (e.g. keyframe edits that close over
    // their engine) ignore the context, but it must still be well-formed.
    if (!this.buildContext) {
      throw new Error(
        'HistoryService has no context builder — construct it via CommandSystem ' +
        'so undo()/redo() can build a CommandContext.',
      );
    }
    return this.buildContext(command);
  }

  private emit(): void {
    getEventBus().emit('UndoStackChanged', {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    });
  }
}
