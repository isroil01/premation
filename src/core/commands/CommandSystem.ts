/**
 * CommandSystem — the only sanctioned entry point for executing commands.
 *
 * Responsibilities:
 *   1. Resolve a Command by id or shortcut.
 *   2. Build a CommandContext with current state + services.
 *   3. Execute the command, capturing it on the undo stack if undoable.
 *   4. Emit feedback on the event bus.
 *
 * This is the layer that knows about Application. Commands themselves never do.
 */

import { getCommandRegistry } from './Command';
import type {
  Command,
  CommandContext,
  CommandServices,
  IUndoableCommand,
} from './Command';
import { HistoryService } from './HistoryService';
import type { CommandId } from '@app-types/common';

export interface CommandSystemOptions {
  /** Provider of the live read-only state snapshot. */
  getState: () => Readonly<Record<string, unknown>>;
  /** Provider of named services. Engines register their services here. */
  services: CommandServices;
}

export class CommandSystem {
  private readonly history: HistoryService;
  private readonly opts: CommandSystemOptions;

  constructor(opts: CommandSystemOptions) {
    this.opts = opts;
    // Give history a context builder so undo/redo can re-run commands with
    // the same services execute saw (buildContext reads this.opts, set above).
    this.history = new HistoryService(500, (cmd) => this.buildContext(cmd));
    // Wire built-in undo/redo services to the registry's history.
    this.attachBuiltinHistory();
  }

  /** Expose the history service so the UI can render undo/redo state. */
  getHistory(): HistoryService {
    return this.history;
  }

  async execute(id: CommandId): Promise<void> {
    const cmd = getCommandRegistry().get(id);
    if (!cmd) {
      // eslint-disable-next-line no-console
      console.warn(`[CommandSystem] unknown command: ${id}`);
      return;
    }
    if (cmd.enabled && !cmd.enabled()) return;

    const ctx = this.buildContext(cmd);
    await cmd.execute(ctx);
    if (cmd.undo) this.history.push(cmd as IUndoableCommand);
  }

  /** Execute a command bypassing the enabled check (used by scripts / tests). */
  async forceExecute(id: CommandId): Promise<void> {
    const cmd = getCommandRegistry().get(id);
    if (!cmd) return;
    const ctx = this.buildContext(cmd);
    await cmd.execute(ctx);
    if (cmd.undo) this.history.push(cmd as IUndoableCommand);
  }

  async executeByShortcut(chord: import('@app-types/common').KeyChord): Promise<boolean> {
    const cmd = getCommandRegistry().findByShortcut(chord);
    if (!cmd) return false;
    await this.execute(cmd.id);
    return true;
  }

  canUndo(): boolean { return this.history.canUndo(); }
  canRedo(): boolean { return this.history.canRedo(); }
  undo(): void { this.history.undo(); }
  redo(): void { this.history.redo(); }

  private buildContext(_cmd: Command | IUndoableCommand): CommandContext {
    const state = this.opts.getState();
    const services: CommandServices = {
      ...this.opts.services,
      get: (name) => this.opts.services.get(name),
    };
    return { state, services };
  }

  /**
   * Provide the history service to the rest of the system so the UndoService
   * facade inside CommandServices is actually wired to this CommandSystem.
   */
  private attachBuiltinHistory(): void {
    const services = this.opts.services as CommandServices & {
      __undo?: (cmd: IUndoableCommand) => void;
    };
    services.__undo = (cmd) => this.history.push(cmd);
  }
}

/** Default Application-wide instance. */
let commandSystemInstance: CommandSystem | null = null;

export function getCommandSystem(): CommandSystem {
  if (!commandSystemInstance) {
    throw new Error('CommandSystem not initialized — call setCommandSystem() at boot.');
  }
  return commandSystemInstance;
}

export function setCommandSystem(cs: CommandSystem): void {
  commandSystemInstance = cs;
}

// ── Default key-chord utilities ────────────────────────────────────
export const isMeta = (e: KeyboardEvent): boolean => e.metaKey || e.ctrlKey;

/**
 * The key a chord should be matched on.
 *
 * `e.key` is the PRODUCED CHARACTER, not the physical key, and on the digit row
 * those differ the moment a modifier or a non-US layout is involved:
 *
 *   • US layout, Shift+1  → `e.key === '!'`. A chord registered as
 *     `{ key: '1', shift: true }` could therefore never match — Shift+digit was
 *     unexpressible in this system, silently. Nothing failed; the binding just
 *     never fired.
 *   • AZERTY, bare Digit1 → `e.key === '&'`, so the existing bare-digit chords
 *     (`1`/`2` for 3D views) did not fire there either.
 *
 * `e.code` is layout- and modifier-independent, so the digit row is resolved
 * from it. Scoped to `Digit0`–`Digit9` deliberately: letters already behave
 * (Shift+A gives 'A', which `chordKey` lowercases), and remapping the whole
 * keyboard to physical codes would change every existing chord on non-US
 * layouts — a much larger behaviour change than this fixes.
 */
function chordKeyFromEvent(e: KeyboardEvent): string {
  const m = /^Digit([0-9])$/.exec(e.code ?? '');
  return m && e.key !== m[1] ? m[1]! : e.key;
}

export const chordFromEvent = (e: KeyboardEvent): import('@app-types/common').KeyChord => ({
  key: chordKeyFromEvent(e),
  ctrl:  e.ctrlKey,
  meta:  e.metaKey,
  alt:   e.altKey,
  shift: e.shiftKey,
});
