/**
 * Plugin host (spec §Extensibility). A documented, native extension point:
 * plugins register commands (which become searchable in Universal Search),
 * effects, and get scripting access to the object model. Plugins install and
 * uninstall at runtime — no restart — and cleanly unregister what they added.
 */

import { getCommandRegistry, type Command } from '@core/commands/Command';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, type AnimationEngine } from '@motion/animation';
import type SceneGraph from '@core/scene/SceneGraph';
import type { CommandId } from '@app-types/common';

/** A registered visual effect a plugin contributes. */
export interface PluginEffect {
  id: string;
  label: string;
  /** Apply to a node at a time — should author editable keyframes. */
  apply: (nodeId: string, time: number) => void;
}

/** Everything a plugin may touch. Scripting access to the object model. */
export interface PluginContext {
  registerCommand: (cmd: Command) => void;
  registerEffect: (effect: PluginEffect) => void;
  readonly scene: SceneGraph;
  readonly animation: AnimationEngine;
  /** Current selection ids (wired from the app at boot). */
  getSelection: () => ReadonlyArray<string>;
  notify: (message: string) => void;
}

export interface MotionPlugin {
  id: string;
  name: string;
  description: string;
  /** Called on install. Return a disposer for any extra teardown. */
  activate: (ctx: PluginContext) => void | (() => void);
}

interface Installed {
  plugin: MotionPlugin;
  commandIds: CommandId[];
  effectIds: string[];
  dispose?: () => void;
}

class PluginHost {
  private readonly installed = new Map<string, Installed>();
  private readonly effects = new Map<string, PluginEffect>();
  private selectionProvider: () => ReadonlyArray<string> = () => [];
  private notifier: (msg: string) => void = () => {};
  private onChange: (() => void)[] = [];

  /** Wire app services the plugin context needs (called once at boot). */
  configure(opts: { getSelection: () => ReadonlyArray<string>; notify: (msg: string) => void }): void {
    this.selectionProvider = opts.getSelection;
    this.notifier = opts.notify;
  }

  install(plugin: MotionPlugin): void {
    if (this.installed.has(plugin.id)) return;
    const commandIds: CommandId[] = [];
    const effectIds: string[] = [];
    const ctx: PluginContext = {
      registerCommand: (cmd) => { getCommandRegistry().register(cmd); commandIds.push(cmd.id); },
      registerEffect: (effect) => { this.effects.set(effect.id, effect); effectIds.push(effect.id); },
      scene: defaultSceneGraph,
      animation: defaultAnimation,
      getSelection: () => this.selectionProvider(),
      notify: (m) => this.notifier(m),
    };
    const dispose = plugin.activate(ctx) ?? undefined;
    this.installed.set(plugin.id, { plugin, commandIds, effectIds, dispose });
    this.emit();
  }

  uninstall(id: string): void {
    const entry = this.installed.get(id);
    if (!entry) return;
    entry.dispose?.();
    for (const cid of entry.commandIds) getCommandRegistry().unregister(cid);
    for (const eid of entry.effectIds) this.effects.delete(eid);
    this.installed.delete(id);
    this.emit();
  }

  isInstalled(id: string): boolean {
    return this.installed.has(id);
  }

  listEffects(): PluginEffect[] {
    return [...this.effects.values()];
  }

  subscribe(fn: () => void): () => void {
    this.onChange.push(fn);
    return () => { this.onChange = this.onChange.filter((f) => f !== fn); };
  }

  private emit(): void {
    for (const fn of this.onChange) fn();
  }
}

export const pluginHost = new PluginHost();
export default pluginHost;
