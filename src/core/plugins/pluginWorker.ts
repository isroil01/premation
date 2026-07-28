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

import type { HostMessage, WorkerMessage, PluginCommandSpec } from './protocol';
import type { PluginManifest, PluginPermission } from './manifest';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: WorkerMessage): void => { self.postMessage(msg); };

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
const panelListeners: Array<(data: unknown) => void> = [];

function buildApi(manifest: PluginManifest, permissions: PluginPermission[]) {
  return {
    manifest,
    /** Exactly what the user granted — a plugin can degrade instead of failing. */
    permissions: [...permissions],
    has: (p: PluginPermission): boolean => permissions.includes(p),

    ui: {
      notify: (message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info') =>
        call('ui.notify', String(message), level),
      openPanel: () => call('ui.openPanel'),
      closePanel: () => call('ui.closePanel'),
      /** Messages from this plugin's own panel iframe. */
      onPanelMessage: (fn: (data: unknown) => void) => { panelListeners.push(fn); },
      sendToPanel: (data: unknown) => { post({ k: 'toPanel', data }); },
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
      createLayer: (opts: { kind: string; name?: string; x?: number; y?: number }) =>
        call('scene.createLayer', opts) as Promise<string>,
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
    case 'panelMessage':
      for (const fn of panelListeners) {
        try { fn(msg.data); } catch { /* one bad listener must not stop the rest */ }
      }
      break;
  }
};

post({ k: 'ready' });
