/**
 * Application — top-level façade that owns the lifecycle of all core systems.
 *
 * Boot order (in `boot()`):
 *   1. Service container
 *   2. EventBus
 *   3. CommandRegistry + CommandSystem
 *   4. ShortcutManager
 *   5. UI stores (Zustand) are created separately and exposed to commands
 *      via the getState provider.
 *
 * Future engines register themselves as plugins at boot:
 *   application.registerPlugin(timelineEngine)
 *   application.registerPlugin(sceneGraphEngine)
 * etc.
 */

import { getEventBus, setEventBus, EventBus } from '@core/events/EventBus';
import {
  getCommandRegistry,
  type Command,
  type CommandServices,
  type PanelService,
  type SelectionService,
  type WorkspaceService,
} from '@core/commands/Command';
import { CommandSystem, setCommandSystem } from '@core/commands/CommandSystem';
import { ShortcutManager, setShortcutManager } from '@core/commands/ShortcutManager';
import { createUndoService } from '@core/commands/undoService';
import { createServiceContainer, type ServiceContainer } from '../services/ServiceContainer';
import { registerCoreServices } from '@core/bootstrap/registerCoreServices';

export interface ApplicationBootOptions {
  /** Provider of read-only state snapshots for commands. */
  getState: () => Readonly<Record<string, unknown>>;
  /** Concrete UI service implementations. */
  selection: SelectionService;
  panels: PanelService;
  workspace: WorkspaceService;
  /** Optional plugins to register at boot. */
  plugins?: ReadonlyArray<ApplicationPlugin>;
}

/** Engine-side adapter for plugging into Application. */
export interface ApplicationPlugin {
  readonly name: string;
  onAttach?(ctx: Application): void;
  onDetach?(ctx: Application): void;
  /** Optional commands the plugin wants to register. */
  commands?(): ReadonlyArray<Command>;
  /** Optional services the plugin wants to expose. */
  services?(): ReadonlyArray<{ name: string; service: unknown }>;
}

export class Application {
  readonly eventBus: EventBus;
  readonly services: ServiceContainer;
  readonly commandSystem: CommandSystem;
  readonly shortcuts: ShortcutManager;
  private readonly plugins = new Map<string, ApplicationPlugin>();
  private booted = false;

  private constructor(
    eventBus: EventBus,
    services: ServiceContainer,
    commandSystem: CommandSystem,
    shortcuts: ShortcutManager,
  ) {
    this.eventBus = eventBus;
    this.services = services;
    this.commandSystem = commandSystem;
    this.shortcuts = shortcuts;
  }

  static boot(opts: ApplicationBootOptions): Application {
    if (instance) return instance;

    const eventBus = new EventBus();
    setEventBus(eventBus);

    const services = createServiceContainer();

    // Register framework-agnostic core services (logger, settings, theme,
    // loading, files, recent, project) into the DI container up front.
    registerCoreServices(services);

    // Build a stable CommandServices facade. The undo service pushes through
    // the CommandSystem's history; selection/panels/workspace come from the
    // caller (Zustand adapters in the UI layer).
    const commandServices: CommandServices = {
      undo: createUndoService(() => { /* bound after CS construction */ }),
      selection: opts.selection,
      panels: opts.panels,
      workspace: opts.workspace,
      get: <T,>(name: string): T | undefined => services.get<T>(name),
    };

    const commandSystem = new CommandSystem({
      getState: opts.getState,
      services: commandServices,
    });
    setCommandSystem(commandSystem);

    // Wire the undo push to the real history now that CommandSystem exists.
    (commandServices.undo as { push: (cmd: Command) => void }).push = (cmd) => {
      commandSystem.getHistory().push(cmd);
    };

    const shortcuts = new ShortcutManager();
    setShortcutManager(shortcuts);

    const app = new Application(eventBus, services, commandSystem, shortcuts);

    // Register plugin-provided commands/services.
    for (const plugin of opts.plugins ?? []) {
      app.registerPlugin(plugin);
    }

    app.booted = true;
    eventBus.emit('ApplicationReady', undefined);
    return app;
  }

  registerPlugin(plugin: ApplicationPlugin): void {
    if (this.plugins.has(plugin.name)) {
      // eslint-disable-next-line no-console
      console.warn(`[Application] plugin "${plugin.name}" already registered`);
      return;
    }
    this.plugins.set(plugin.name, plugin);
    for (const svc of plugin.services?.() ?? []) {
      this.services.register(svc.name, svc.service);
    }
    for (const cmd of plugin.commands?.() ?? []) {
      getCommandRegistry().register(cmd);
    }
    plugin.onAttach?.(this);
    this.shortcuts.rehydrateFromRegistry();
  }

  unregisterPlugin(name: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    plugin.onDetach?.(this);
    this.plugins.delete(name);
    // Services/commands are best-effort removed; the registry has no
    // per-owner tracking yet, so we just clear shortcuts and rehydrate.
    this.shortcuts.rehydrateFromRegistry();
  }

  shutdown(): void {
    this.eventBus.emit('ApplicationShutdown', undefined);
    for (const plugin of this.plugins.values()) {
      plugin.onDetach?.(this);
    }
    this.plugins.clear();
    this.shortcuts.detach();
    this.eventBus.clear();
    this.services['names']().forEach((n) => this.services.unregister(n));
    getCommandRegistry().clear();
    instance = null;
  }

  isBooted(): boolean {
    return this.booted;
  }
}

let instance: Application | null = null;

export function getApplication(): Application {
  if (!instance) {
    throw new Error('Application not booted — call Application.boot() first.');
  }
  return instance;
}

// Convenient re-exports for callers.
export { getEventBus };
