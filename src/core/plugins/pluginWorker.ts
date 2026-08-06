/// <reference lib="webworker" />
/**
 * The plugin sandbox, worker side.
 *
 * A plugin runs HERE — in a dedicated Worker — and nowhere else. That is the
 * whole security model, and it is a property of the realm rather than of a
 * policy someone has to remember to apply:
 *
 *   • **No DOM.** A worker has no `document` and no `window`, so a plugin cannot
 *     read the editor's UI, forge clicks, or attach itself to the page.
 *   • **No `localStorage`.** Which is where this app keeps the account bearer
 *     token and the user's own AI provider keys. `WorkerGlobalScope` simply does
 *     not expose it — the previous host-realm evaluator handed both away.
 *   • **No network.** `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` /
 *     `importScripts` are replaced with throwing stubs BEFORE plugin code is
 *     imported, so a plugin cannot exfiltrate the project it was given access to.
 *   • **Interruptible.** A `while (true)` in a plugin blocks this worker's event
 *     loop, not the editor's. The host pings; a plugin that stops answering is
 *     terminated. In the host realm the same loop froze the app permanently.
 *
 * Everything the plugin *can* do goes through `postMessage` to the host, which
 * checks each call against the permissions the user granted at install time.
 */

import { collectTransferables, type HostMessage, type WorkerMessage, type PluginCommandSpec } from './protocol';
import type { PluginManifest, PluginPermission } from './manifest';

declare const self: DedicatedWorkerGlobalScope;

/**
 * Post, transferring any binary payload rather than copying it.
 *
 * `collectTransferables` returns an empty list for every message that has no
 * buffers in it, which is all of them but `assets.createImage` — so this is the
 * ordinary path, not a special case someone has to remember to take.
 */
const post = (msg: WorkerMessage): void => {
  const transfer = collectTransferables(msg);
  if (transfer.length > 0) self.postMessage(msg, transfer);
  else self.postMessage(msg);
};

/**
 * Replace the escape hatches with stubs that explain themselves.
 *
 * Deleting them outright would surface as `undefined is not a function` in the
 * plugin author's console, which reads as an editor bug. A throwing stub names
 * the rule instead.
 */
function lockdown(): void {
  const denied = (what: string) => () => {
    throw new Error(
      `${what} is not available to plugins. Plugins run sandboxed with no network access — ` +
      'ask the host for what you need through the plugin API.',
    );
  };
  const scope = self as unknown as Record<string, unknown>;
  for (const name of [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
    'Worker', 'SharedWorker', 'indexedDB', 'caches', 'BroadcastChannel',
  ]) {
    try {
      Object.defineProperty(scope, name, { value: denied(name), configurable: false, writable: false });
    } catch {
      // A non-configurable built-in in some engine — the host's permission
      // gate is still in force, so this is a defence-in-depth miss, not a hole.
    }
  }
  try {
    Object.defineProperty(self.navigator, 'sendBeacon', { value: denied('navigator.sendBeacon') });
  } catch { /* not present in every engine */ }

  forwardConsole();
}

/**
 * Send the plugin's own `console` output to the host.
 *
 * A worker's console lands in DevTools, which a user of the packaged app does
 * not have — so a plugin author debugging their own plugin had nowhere to look,
 * and a user reporting "it does nothing" had nothing to send. The host keeps the
 * last lines per plugin and the manager shows them.
 *
 * Console is NOT removed: the plugin keeps its own output where an author with
 * DevTools open expects it.
 */
function forwardConsole(): void {
  const MAX_LINE = 400;
  const levels: Array<['log' | 'warn' | 'error', keyof Console]> = [
    ['log', 'log'], ['log', 'info'], ['log', 'debug'], ['warn', 'warn'], ['error', 'error'],
  ];
  for (const [level, method] of levels) {
    const original = (console as unknown as Record<string, unknown>)[method as string];
    (console as unknown as Record<string, unknown>)[method as string] = (...args: unknown[]): void => {
      try {
        const text = args
          .map((a) => {
            if (typeof a === 'string') return a;
            // A plugin can log a cyclic object; a throwing logger would be a
            // worse bug than the one being debugged.
            try { return JSON.stringify(a); } catch { return String(a); }
          })
          .join(' ')
          .slice(0, MAX_LINE);
        post({ k: 'log', level, text });
      } catch { /* never let logging break the plugin */ }
      if (typeof original === 'function') (original as (...a: unknown[]) => void).apply(console, args);
    };
  }
}

// ── RPC ──────────────────────────────────────────────────────────────────
let callSeq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function call(method: string, ...args: unknown[]): Promise<unknown> {
  const id = (callSeq += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ k: 'call', id, method, args });
  });
}

// ── The plugin-facing API ────────────────────────────────────────────────
const commandHandlers = new Map<string, (ctx: { selection: string[] }) => unknown>();
/** Panel id → its listeners. Keyed, because a plugin with two panels must not
 *  have one panel's handler woken by the other's messages. */
const panelListeners = new Map<string, Array<(data: unknown) => void>>();

/** Raw pixels as they cross the boundary — see `assets.ts` for the format. */
export interface PluginImage {
  assetId: string;
  width: number;
  height: number;
  /** Always `'image/rgba8'` on the way out: straight, un-premultiplied RGBA8. */
  mime: string;
  bytes: Uint8Array;
}

/** `kindId` → the plugin's authored-edit callback. One per kind. */
const layerChangeListeners = new Map<string, (e: { layerId: string; props: string[] }) => void>();

function buildApi(manifest: PluginManifest, permissions: PluginPermission[]) {
  const panels = manifest.contributes?.panels ?? [];
  /**
   * Resolve an optional panel id worker-side too.
   *
   * The host validates this again — it must, the argument crossed a
   * `postMessage` from third-party code — but resolving here means
   * `onPanelMessage(fn)` on a single-panel plugin can subscribe to the right
   * key without a round trip.
   */
  const solePanel = (id?: string): string => {
    if (id !== undefined) return id;
    if (panels.length === 1) return panels[0]!.id;
    throw new Error(
      panels.length === 0
        ? 'This plugin declares no panels in its manifest.'
        : `This plugin declares ${panels.length} panels — pass one of: ${panels.map((p) => p.id).join(', ')}.`,
    );
  };

  return {
    manifest,
    /** Exactly what the user granted — a plugin can degrade instead of failing. */
    permissions: [...permissions],
    has: (p: PluginPermission): boolean => permissions.includes(p),

    ui: {
      notify: (message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info') =>
        call('ui.notify', String(message), level),
      /** The id is optional when the plugin declares exactly one panel. */
      openPanel: (panelId?: string) => call('ui.openPanel', panelId),
      closePanel: (panelId?: string) => call('ui.closePanel', panelId),
      /**
       * Messages from one of this plugin's own panel iframes.
       *
       * Both spellings are supported, and they are told apart by ARITY, not by
       * argument type. `sendToPanel('hi')` on a single-panel plugin has to mean
       * "send the string 'hi'", while `sendToPanel('side', 'hi')` means "send
       * 'hi' to the panel called side" — sniffing the type of the first
       * argument would make the first of those unsendable, and it is the older
       * of the two spellings.
       */
      onPanelMessage: (...args: unknown[]) => {
        const [id, handler] = args.length >= 2
          ? [solePanel(args[0] as string), args[1] as (data: unknown) => void]
          : [solePanel(), args[0] as (data: unknown) => void];
        if (typeof handler !== 'function') throw new Error('onPanelMessage expects a function.');
        const list = panelListeners.get(id) ?? [];
        list.push(handler);
        panelListeners.set(id, list);
      },
      sendToPanel: (...args: unknown[]) => {
        const [id, payload] = args.length >= 2
          ? [solePanel(args[0] as string), args[1]]
          : [solePanel(), args[0]];
        post({ k: 'toPanel', panelId: id, data: payload });
      },
    },

    commands: {
      /** Contribute a command to the palette and the Plugins menu. */
      register: (spec: PluginCommandSpec, handler: (ctx: { selection: string[] }) => unknown) => {
        commandHandlers.set(spec.id, handler);
        return call('commands.register', spec);
      },
    },

    composition: {
      get: () => call('composition.get') as Promise<{
        width: number; height: number; fps: number; durationSeconds: number; name: string;
      }>,
    },

    scene: {
      getSelection: () => call('scene.getSelection') as Promise<string[]>,
      setSelection: (ids: string[]) => call('scene.setSelection', ids),
      getLayers: () => call('scene.getLayers') as Promise<Array<{
        id: string; name: string; kind: string; parent: string | null; visible: boolean; locked: boolean;
      }>>,
      getLayer: (id: string) => call('scene.getLayer', id),
      createLayer: (opts: { kind: string; name?: string; x?: number; y?: number; props?: Record<string, unknown> }) =>
        call('scene.createLayer', opts) as Promise<string>,

      /**
       * Replace this layer's generated children.
       *
       * `key` must be STABLE across regenerations: the host diffs on it, and a
       * child whose key is unchanged keeps its layer id. Churn the keys and the
       * user's selection jumps and other layers' expressions referencing your
       * output go dead.
       *
       * Bind rather than bake. A child property set to
       * `layer('<your layer name>', 'plugin.focal')` is evaluated by the
       * animation engine, so your subtree keeps animating without you — and
       * keeps animating in a document opened without your plugin installed.
       */
      setProxyChildren: (
        layerId: string,
        children: Array<{
          key: string;
          kind: string;
          name?: string;
          props?: Record<string, unknown>;
          expressions?: Record<string, string>;
        }>,
      ) => call('scene.setProxyChildren', layerId, children),

      /**
       * Be told when a user AUTHORS one of your layers.
       *
       * **Never fires for animated value changes.** An animatable property
       * changes every frame during playback; if that reached you, regenerating
       * sixty times a second would be the normal case rather than a bug. Bursts
       * are coalesced, so a drag delivers one call.
       */
      onLayerChanged: (kindId: string, fn: (e: { layerId: string; props: string[] }) => void) => {
        layerChangeListeners.set(kindId, fn);
        void call('scene.onLayerChanged', kindId);
        return () => layerChangeListeners.delete(kindId);
      },
      setProperty: (id: string, prop: string, value: unknown) => call('scene.setProperty', id, prop, value),
      renameLayer: (id: string, name: string) => call('scene.renameLayer', id, name),
      deleteLayer: (id: string) => call('scene.deleteLayer', id),
    },

    animation: {
      getTracks: (id: string) => call('animation.getTracks', id) as Promise<Array<{
        prop: string; keyframes: Array<{ t: number; value: number; easing?: string }>;
      }>>,
      sample: (id: string, prop: string, time: number) =>
        call('animation.sample', id, prop, time) as Promise<number | null>,
      setKeyframe: (id: string, prop: string, time: number, value: number, easing?: string) =>
        call('animation.setKeyframe', id, prop, time, value, easing),
      setKeyframes: (id: string, prop: string, kfs: Array<{ t: number; value: number; easing?: string }>) =>
        call('animation.setKeyframes', id, prop, kfs),
      removeKeyframe: (id: string, prop: string, time: number) =>
        call('animation.removeKeyframe', id, prop, time),
      setExpression: (id: string, prop: string, source: string) =>
        call('animation.setExpression', id, prop, source),
    },

    assets: {
      /**
       * Read an image's pixels — by the layer showing it, or by asset id.
       *
       * `bytes` is straight (un-premultiplied) RGBA8, `width * height * 4` long,
       * the same layout `getImageData` produces. It arrives by transfer, so it
       * costs a pointer rather than a copy.
       */
      getImage: (ref: { layerId?: string; assetId?: string }) =>
        call('assets.getImage', ref) as Promise<PluginImage>,
      /**
       * Add an image to the project's asset library.
       *
       * `mime` may be `'image/rgba8'` (raw, and then `bytes.length` must be
       * exactly `width * height * 4`) or `image/png` `image/jpeg` `image/webp`,
       * in which case the real dimensions come from decoding and the declared
       * ones are ignored. Use `scene.createLayer({ kind: 'image', assetId })` to
       * put it in the composition.
       */
      createImage: (opts: {
        width?: number; height?: number; bytes: Uint8Array; mime?: string; name?: string;
      }) => call('assets.createImage', opts) as Promise<{ assetId: string; width: number; height: number }>,
    },

    timeline: {
      getTime: () => call('timeline.getTime') as Promise<number>,
      setTime: (seconds: number) => call('timeline.setTime', seconds),
    },
  };
}

export type PluginApi = ReturnType<typeof buildApi>;

// ── Boot ─────────────────────────────────────────────────────────────────
let booted = false;

async function boot(msg: Extract<HostMessage, { k: 'boot' }>): Promise<void> {
  if (booted) return;
  booted = true;
  lockdown();

  const api = buildApi(msg.manifest, msg.permissions);
  const url = URL.createObjectURL(new Blob([msg.code], { type: 'text/javascript' }));
  try {
    const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    const activate =
      typeof mod.activate === 'function'
        ? (mod.activate as (a: unknown) => unknown)
        : typeof (mod.default as { activate?: unknown } | undefined)?.activate === 'function'
          ? ((mod.default as { activate: (a: unknown) => unknown }).activate)
          : typeof mod.default === 'function'
            ? (mod.default as (a: unknown) => unknown)
            : null;
    if (!activate) {
      throw new Error(
        'The entry module exports no activate(). Export `export function activate(motion) {…}` ' +
        'or `export default { activate(motion) {…} }`.',
      );
    }
    await activate(api);
    post({ k: 'activated' });
  } catch (err) {
    post({ k: 'fatal', error: err instanceof Error ? `${err.message}` : String(err) });
  } finally {
    URL.revokeObjectURL(url);
  }
}

self.onmessage = (ev: MessageEvent<HostMessage>): void => {
  const msg = ev.data;
  switch (msg.k) {
    case 'boot':
      void boot(msg);
      break;
    case 'ping':
      // Answering proves the event loop is not wedged. A plugin spinning in a
      // synchronous loop never reaches this line, which is exactly the signal
      // the host uses to terminate it.
      post({ k: 'pong', id: msg.id });
      break;
    case 'result': {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error));
      break;
    }
    case 'invoke': {
      const handler = commandHandlers.get(msg.commandId);
      if (!handler) return;
      try {
        void Promise.resolve(handler({ selection: msg.selection })).catch((err: unknown) => {
          post({ k: 'fatal', error: `command "${msg.commandId}" failed: ${String(err)}` });
        });
      } catch (err) {
        post({ k: 'fatal', error: `command "${msg.commandId}" failed: ${String(err)}` });
      }
      break;
    }
    case 'layerChanged': {
      const fn = layerChangeListeners.get(msg.kindId);
      // No listener is normal: most plugins never register one, and the host
      // only sends this for kinds that did.
      if (fn) {
        try { fn({ layerId: msg.layerId, props: msg.props }); }
        catch (err) { post({ k: 'log', level: 'error', text: `onLayerChanged threw: ${String(err)}` }); }
      }
      break;
    }
    case 'panelMessage':
      // Delivered only to the listeners for the panel it came from. The host
      // decides which panel that is, from which FRAME sent it — never from
      // anything in the message body.
      for (const fn of panelListeners.get(msg.panelId) ?? []) {
        try { fn(msg.data); } catch { /* one bad listener must not stop the rest */ }
      }
      break;
  }
};

post({ k: 'ready' });
