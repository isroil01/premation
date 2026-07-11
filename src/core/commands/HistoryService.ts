/**
 * History / UndoRedo service.
 *
 * Maintains two stacks of commands. A command participates in undo only if
 * it provides an `undo()` method. The service itself is engine-agnostic
 * — it does not know what state commands mutate.
 */

import { getEventBus } from '@core/events/EventBus';
import type { Command } from './Command';

export class HistoryService {
  private readonly undoStack: Command[] = [];
  private readonly redoStack: Command[] = [];
  private readonly capacity: number;
  private suspended = 0;

  constructor(capacity = 500) {
    this.capacity = capacity;
  }

  /** Push a command onto the undo stack. */
  push(command: Command): void {
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
    if (!command || !command.undo) return;
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
    return !!top && typeof top.undo === 'function';
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit();
  }

  /** Temporary suppression — used by macro commands. */
  withSuppressed(fn: () => void): void {
    this.suspended++;
    try { fn(); } finally { this.suspended--; }
  }

  private ctxFor(_command: Command): never {
    // Real context is built by Application and passed in via execute().
    // HistoryService only re-executes commands; the context is supplied by
    // the caller of undo()/redo() through the CommandSystem entry point.
    throw new Error(
      'HistoryService.ctxFor should not be called directly — ' +
      'use CommandSystem.execute() which builds the context.',
    );
  }

  private emit(): void {
    getEventBus().emit('UndoStackChanged', {
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    });
  }
}
