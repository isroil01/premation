import { getCommandRegistry, type Command } from '@core/commands/Command';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, type AnimationEngine } from '@motion/animation';
import { useCompositionStore, type CompositionSettings } from '@stores/compositionStore';
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
  /** Access active composition settings (FPS, width, height, duration). */
  getComposition: () => CompositionSettings;
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
  private readonly userPlugins: MotionPlugin[] = [];
  private selectionProvider: () => ReadonlyArray<string> = () => [];
  private notifier: (msg: string) => void = () => {};
  private onChange: (() => void)[] = [];
  /** Plugin frames allowed on the postMessage bridge → their expected origin. */
  private readonly frames = new Map<MessageEventSource, string>();

  constructor() {
    this.setupPostMessageBridge();
  }

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
      getComposition: () => useCompositionStore.getState(),
    };
    const dispose = plugin.activate(ctx) ?? undefined;
    this.installed.set(plugin.id, { plugin, commandIds, effectIds, dispose });
    this.emit();
  }

  /**
   * Evaluates JS source code defining a MotionPlugin object.
   * Allows authors to load external .js script files at runtime without compiling.
   */
  installFromSource(jsCode: string): MotionPlugin {
    const fn = new Function(
      'pluginHost',
      'defaultSceneGraph',
      'defaultAnimation',
      `${jsCode}; return typeof plugin !== "undefined" ? plugin : (typeof exports !== "undefined" ? exports.default || exports : null);`
    );
    const loaded = fn(this, defaultSceneGraph, defaultAnimation) as MotionPlugin;
    if (!loaded || !loaded.id || !loaded.name || typeof loaded.activate !== 'function') {
      throw new Error('Plugin script must define a "plugin" object with id, name, and activate(ctx) function.');
    }
    if (!this.userPlugins.some((p) => p.id === loaded.id)) {
      this.userPlugins.push(loaded);
    }
    this.install(loaded);
    return loaded;
  }

  getUserPlugins(): MotionPlugin[] {
    return this.userPlugins;
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

  /**
   * Register a plugin frame as allowed to drive the postMessage bridge.
   *
   * Whoever creates a plugin iframe/webview calls this with the window it
   * created and the origin it was loaded from. Nothing else can talk to the
   * bridge — see `setupPostMessageBridge`.
   */
  registerFrame(source: MessageEventSource, origin: string): () => void {
    this.frames.set(source, origin);
    return () => { this.frames.delete(source); };
  }

  /**
   * postMessage bridge for plugin frames — keyframe commands and notifications.
   *
   * Gated on `registerFrame`. It used to accept ANY message from ANY window:
   * `window.addEventListener('message')` fires for anything that can reach this
   * window (an embedder, an opener, an injected frame), and the handler wrote
   * straight into the user's animation data and popped arbitrary toast text. No
   * frame is registered until the app itself creates one, so an unsolicited
   * message now has no sender it can claim to be.
   */
  private setupPostMessageBridge(): () => void {
    if (typeof window === 'undefined') return () => {};
    const listener = (event: MessageEvent) => {
      // Sender must be a frame we created, still registered, and still on the
      // origin it was registered with (a navigated frame is a different app).
      const expected = event.source ? this.frames.get(event.source) : undefined;
      if (expected === undefined || event.origin !== expected) return;

      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'SET_KEYFRAME' && typeof data.nodeId === 'string' && typeof data.property === 'string') {
        const time = Number(data.time);
        const value = Number(data.value);
        // A NaN would poison the track silently; reject rather than coerce to 0,
        // which would look like a deliberate keyframe at the start of the comp.
        if (!Number.isFinite(time) || !Number.isFinite(value)) return;
        defaultAnimation.setKeyframe(data.nodeId, data.property, time, value);
        this.notifier(`Extension updated keyframe: ${data.property}`);
      } else if (data.type === 'NOTIFY' && typeof data.message === 'string') {
        this.notifier(data.message);
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  private emit(): void {
    for (const fn of this.onChange) fn();
  }
}

export const pluginHost = new PluginHost();
export default pluginHost;
