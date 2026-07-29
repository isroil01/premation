/**
 * Command System.
 *
 * Commands are the only sanctioned way to mutate application state from
 * user input (menus, shortcuts, context menus, scripts). They are
 * engine-agnostic: a command can live in the UI layer (e.g. ToggleSidebar)
 * or be registered by a future engine (e.g. SceneGraph.AddKeyframeCommand).
 *
 * Properties:
 *   - Engine-agnostic (no React / no DOM references inside execute)
 *   - Idempotent registration (re-registering the same id replaces)
 *   - Undo/redo capable when paired with the History service
 *   - Observable (commands can be queried for menus, palettes, shortcuts)
 */

import type { CommandId } from '@app-types/common';
import { asCommandId } from '@app-types/common';

/** Runtime context passed to every command invocation. */
export interface CommandContext {
  /** Read-only snapshot of current app state (provided by Application). */
  readonly state: Readonly<Record<string, unknown>>;
  /** Imperative services available to the command (undo, io, selection,...). */
  readonly services: CommandServices;
}

/** Services a command may need. All implementations come from Application. */
export interface CommandServices {
  readonly undo: UndoService;
  readonly selection: SelectionService;
  readonly panels: PanelService;
  readonly workspace: WorkspaceService;
  // Engines register additional services (timeline, scene, render, ai,...).
  // Commands should access them via services.get('timeline') etc.
  get<T>(name: string): T | undefined;
}

export interface UndoService {
  push(command: IUndoableCommand): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

export interface SelectionService {
  get(): ReadonlyArray<string>;
  set(ids: ReadonlyArray<string>): void;
  clear(): void;
}

export interface PanelService {
  open(id: string): void;
  close(id: string): void;
  toggle(id: string): void;
  isOpen(id: string): boolean;
}

export interface WorkspaceService {
  setActive(id: string): void;
  getActive(): string;
}

/** What every undoable action must implement for the global stack. */
export interface IUndoableCommand {
  readonly label: string;
  /**
   * Display hint for the History panel: a deliberate, user-meaningful entry (a
   * pinned snapshot, the "Open" baseline) rather than an auto-captured edit.
   */
  readonly named?: boolean;
  execute(ctx: CommandContext): void | Promise<void>;
  undo(ctx: CommandContext): void | Promise<void>;
}

/** What every command must implement. */
export interface Command {
  readonly id: CommandId;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  /** When false the command still appears in menus but cannot be invoked. */
  readonly enabled?: () => boolean;
  /** Optional check invoked by menus to show toggled state. */
  readonly isChecked?: () => boolean;
  /** Optional keyboard chord. Shortcuts register independently. */
  readonly shortcut?: import('@app-types/common').KeyChord;
  /** Mutate state. Must be deterministic given the same context. */
  execute(ctx: CommandContext): void | Promise<void>;
  /** Optional reverse — if absent, the command is non-undoable. */
  undo?(ctx: CommandContext): void | Promise<void>;
}

class CommandRegistryImpl {
  private readonly byId = new Map<CommandId, Command>();
  private readonly byShortcut = new Map<string, CommandId>();

  register(command: Command): void {
    this.byId.set(command.id, command);
    if (command.shortcut) {
      this.byShortcut.set(chordKey(command.shortcut), command.id);
    }
  }

  unregister(id: CommandId): void {
    const existing = this.byId.get(id);
    if (existing?.shortcut) {
      this.byShortcut.delete(chordKey(existing.shortcut));
    }
    this.byId.delete(id);
  }

  get(id: CommandId): Command | undefined {
    return this.byId.get(id);
  }

  /** Lookup a command by its keyboard chord. */
  findByShortcut(chord: import('@app-types/common').KeyChord): Command | undefined {
    const id = this.byShortcut.get(chordKey(chord));
    return id ? this.byId.get(id) : undefined;
  }

  /** All registered commands — used by menus, command palettes, settings. */
  all(): ReadonlyArray<Command> {
    return Array.from(this.byId.values());
  }

  clear(): void {
    this.byId.clear();
    this.byShortcut.clear();
  }
}

export type CommandRegistry = CommandRegistryImpl;

/** Stable key for chord lookup. */
export function chordKey(chord: import('@app-types/common').KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrl)  parts.push('Ctrl');
  if (chord.meta)  parts.push('Meta');
  if (chord.alt)   parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(chord.key.toLowerCase());
  return parts.join('+');
}

/** Singleton accessor — Application owns the lifecycle. */
let registryInstance: CommandRegistryImpl | null = null;

export function getCommandRegistry(): CommandRegistryImpl {
  if (!registryInstance) registryInstance = new CommandRegistryImpl();
  return registryInstance;
}

export function setCommandRegistry(r: CommandRegistryImpl): void {
  registryInstance = r;
}

// ── Built-in commands (UI-level, always present) ──────────────────

export const BuiltinCommands = {
  ToggleLeftSidebar:    asCommandId('view.toggleLeftSidebar'),
  ToggleRightInspector: asCommandId('view.toggleRightInspector'),
  ToggleTimeline:       asCommandId('view.toggleTimeline'),
  FocusWorkspace:       asCommandId('view.focusWorkspace'),
  ResetLayout:          asCommandId('layout.reset'),
  SwitchTheme:          asCommandId('theme.switch'),
  Undo:                 asCommandId('edit.undo'),
  Redo:                 asCommandId('edit.redo'),
  SelectAll:            asCommandId('edit.selectAll'),
  Deselect:             asCommandId('edit.deselect'),
  DeleteSelected:       asCommandId('edit.deleteSelected'),
  DuplicateSelected:    asCommandId('edit.duplicateSelected'),
  Cut:                  asCommandId('edit.cut'),
  Copy:                 asCommandId('edit.copy'),
  Paste:                asCommandId('edit.paste'),
} as const;

export class CompositeCommand implements IUndoableCommand {
  readonly label: string;
  private readonly commands: IUndoableCommand[];

  constructor(label: string, commands: IUndoableCommand[]) {
    this.label = label;
    this.commands = commands;
  }

  async execute(ctx: CommandContext): Promise<void> {
    for (const cmd of this.commands) {
      await cmd.execute(ctx);
    }
  }

  async undo(ctx: CommandContext): Promise<void> {
    // Undo in reverse order
    for (let i = this.commands.length - 1; i >= 0; i--) {
      await this.commands[i]!.undo(ctx);
    }
  }
}


