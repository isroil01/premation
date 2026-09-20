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
  /** Non-null while a {@link transaction} is open — commands land here
   *  instead of on the stack, and are pushed as one composite on close. */
  private collecting: Command[] | null = null;

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

    // Inside a transaction the command is only COLLECTED. It has already run,
    // so the caller sees the change immediately; what is deferred is the
    // recording, which `transaction` closes as a single composite entry.
    if (this.collecting) {
      this.collecting.push(command);
      return;
    }

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

  /**
   * Run `fn` and record everything it changes as ONE undo entry.
   *
   * A gesture that moves twenty selected bars calls `setLayerStart` twenty
   * times, and each of those is a reversible command in its own right — so
   * without this the user's single drag costs twenty Ctrl+Z presses. The
   * commands still `do()` as they are issued (the change is live, which is
   * what a drag release needs); only the RECORDING is deferred, and closing
   * the transaction pushes one composite whose `undo` replays the parts in
   * reverse order.
   *
   * Reverse order is not cosmetic: two moves that pass through the same frame
   * only land back where they started if they are undone last-in-first-out.
   *
   * Nests — an inner transaction folds into the outer one, because an inner
   * group is part of the outer action by construction. A transaction that
   * collects nothing pushes nothing, so an all-no-op gesture leaves the stack
   * alone rather than seeding an undo entry that does nothing.
   */
  transaction<T>(label: string, fn: () => T): T {
    if (this.collecting) return fn(); // nested — the outer entry owns it
    const collected: Command[] = [];
    this.collecting = collected;
    let result: T;
    try {
      result = fn();
    } finally {
      this.collecting = null;
    }
    if (collected.length === 0) return result;
    // A lone command keeps its own identity (and its own label) rather than
    // being wrapped in a composite that says the same thing less precisely.
    const composite: Command =
      collected.length === 1
        ? collected[0]!
        : {
            label,
            do: () => {
              for (const c of collected) c.do();
            },
            undo: () => {
              for (let i = collected.length - 1; i >= 0; i--) collected[i]!.undo();
            },
          };
    if (this.onPush) {
      this.onPush(composite);
    } else {
      this.undoStack.push(composite);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    return result;
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
