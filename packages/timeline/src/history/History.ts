/**
 * History — a bounded undo/redo stack of reversible commands. The Timeline
 * routes every structural mutation through `run`, which executes the change
 * and records its inverse. This is intentionally a *local* history so the engine
 * is self-contained; an app can still mirror commands into a global command
 * system via the event bus. Enabled by default; can be paused for bulk edits.
 */

export interface Command {
  label: string;
  do(): void;
  undo(): void;
}

export interface HistoryOptions {
  /** Max entries kept before the oldest is dropped (default 200). */
  limit?: number;
  /** Custom handler to route commands to a global undo stack instead of the local one. */
  onPush?: (command: Command) => void;
}

export class History {
  private readonly undoStack: Command[] = [];
  private readonly redoStack: Command[] = [];
  private readonly limit: number;
  private readonly onPush?: (command: Command) => void;
  private enabled = true;
  private applying = false;

  constructor(opts: HistoryOptions = {}) {
    this.limit = opts.limit ?? 200;
    this.onPush = opts.onPush;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get depth(): number {
    return this.undoStack.length;
  }

  /** Labels of undoable commands, oldest → newest (for a history panel). */
  undoLabels(): string[] {
    return this.undoStack.map((c) => c.label);
  }

  /**
   * Execute a command's `do` now and record it for undo. When history is
   * disabled (or we're mid-undo/redo) the change still runs but isn't recorded.
   */
  run(command: Command): void {
    command.do();
    if (!this.enabled || this.applying) return;

    if (this.onPush) {
      this.onPush(command);
    } else {
      this.undoStack.push(command);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack.length = 0;
    }
  }

  undo(): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;
    this.applying = true;
    try {
      command.undo();
    } finally {
      this.applying = false;
    }
    this.redoStack.push(command);
    return true;
  }

  redo(): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;
    this.applying = true;
    try {
      command.do();
    } finally {
      this.applying = false;
    }
    this.undoStack.push(command);
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Run `fn` without recording (e.g. deserialization, migrations). */
  silently<T>(fn: () => T): T {
    const before = this.enabled;
    this.enabled = false;
    try {
      return fn();
    } finally {
      this.enabled = before;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}
