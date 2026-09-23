/// <reference lib="webworker" />
/**
 * The script sandbox, worker side. A user script runs HERE and nowhere else —
 * the plugin sandbox's model (core/plugins/pluginWorker.ts): no DOM, no
 * `localStorage` (the account token and AI keys live there), no network, and a
 * `while (true)` blocks this worker, not the editor (the host times the run
 * out and terminates it). Everything a script can do goes through `postMessage`
 * to the host, which checks it against the permissions granted for the run.
 */

import { startScriptRuntime } from './scriptRuntime';
import type { ScriptHostMessage, ScriptWorkerMessage } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

/** The escape hatches become stubs that name the rule, BEFORE any script code runs. */
function lockdown(): void {
  const denied = (what: string) => () => {
    throw new Error(`${what} is not available to scripts. A script reaches the document only through \`premation\`.`);
  };
  const scope = self as unknown as Record<string, unknown>;
  for (const name of [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
    'Worker', 'SharedWorker', 'indexedDB', 'caches', 'BroadcastChannel',
  ]) {
    try {
      Object.defineProperty(scope, name, { value: denied(name), configurable: false, writable: false });
    } catch {
      // Non-configurable in some engine: the host's permission gate still holds.
    }
  }
}

lockdown();
startScriptRuntime({
  post: (msg: ScriptWorkerMessage) => self.postMessage(msg),
  listen: (handler) => {
    self.onmessage = (ev: MessageEvent<ScriptHostMessage>) => handler(ev.data);
  },
});
