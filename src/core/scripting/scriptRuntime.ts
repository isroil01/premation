/**
 * The script runtime, WORKER side (imported only by `scriptWorker.ts` and by
 * the in-process test worker). It never runs in the editor's realm: the host
 * hands a script's source to a Worker as data (see scriptHost.ts and the
 * no-host-realm-eval guard in core/plugins).
 *
 * A script is the body of an async function with one global, `premation` —
 * ExtendScript's `app`, reduced to the engine API (ENGINE_API.md §12: scripts
 * use exactly the API the UI, AI tools and plugins use):
 *
 *   // @permissions document.read, document.write
 *   const doc = await premation.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
 *   const { layer } = await premation.execute({ type: 'createLayer', comp: doc.comps[0].id, kind: 'null', name: 'Rig', init: [] });
 *   await premation.execute({ type: 'setProperty', prop: { layer, path: 'transform/rotation' }, value: { kind: 'scalar', value: 45 } });
 *   return layer;          // the run's result
 *
 * `execute`/`batch`/`query` THROW on a typed engine refusal (an uncaught one
 * fails the run, and a failed run leaves the document unchanged).
 */

import type { ScriptHostMessage, ScriptWorkerMessage, ScriptCallMethod, ScriptPermission } from './protocol';

export interface ScriptPort {
  post(msg: ScriptWorkerMessage): void;
  /** Install the handler for host messages. */
  listen(handler: (msg: ScriptHostMessage) => void): void;
}

export class ScriptEngineError extends Error {
  readonly code: string;
  readonly commandIndex: number | undefined;
  constructor(code: string, message: string, commandIndex?: number) {
    super(`${code}: ${message}`);
    this.name = 'ScriptEngineError';
    this.code = code;
    this.commandIndex = commandIndex;
  }
}

const show = (v: unknown): string => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

/** Wire the port; the first `run` message evaluates the script. */
export function startScriptRuntime(port: ScriptPort): void {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const eventListeners = new Set<(batch: unknown) => void>();
  let started = false;

  const call = (method: ScriptCallMethod, args: unknown[]): Promise<unknown> => {
    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.post({ k: 'call', id, method, args });
    });
  };

  const run = async (source: string, permissions: ScriptPermission[]): Promise<void> => {
    const premation = Object.freeze({
      /** One edit command, inside the run's undo entry. Resolves to its result. */
      execute: (command: unknown) => call('execute', [command]),
      /** Several edit commands, all-or-nothing (still inside the run's one undo entry). */
      batch: (label: string, commands: unknown[]) => call('batch', [label, commands]),
      /** Any query (`getDocument`, `getLayers`, `getPropertyValues`, `getKeyframes`, …). */
      query: (query: unknown) => call('query', [query]),
      /** Change events while the script runs (`document.read`). Returns an unsubscribe. */
      onEvents: (fn: (batch: unknown) => void) => {
        eventListeners.add(fn);
        if (eventListeners.size === 1) void call('subscribe', []);
        return () => eventListeners.delete(fn);
      },
      log: (...xs: unknown[]) => port.post({ k: 'log', level: 'log', text: xs.map(show).join(' ') }),
      permissions: Object.freeze([...permissions]),
      /** Seconds → API time (flicks). */
      seconds: (s: number) => Math.round(s * 705_600_000),
    });
    try {
      // The script is the body of an async function. `new Function` here runs
      // in the WORKER realm (this module is never imported by the editor).
      const body = new Function('premation', `"use strict"; return (async () => {\n${source}\n})();`) as (p: unknown) => Promise<unknown>;
      const value = await body(premation);
      let clean: unknown = null;
      try { clean = value === undefined ? null : JSON.parse(JSON.stringify(value)); } catch { clean = show(value); }
      port.post({ k: 'done', ok: true, value: clean });
    } catch (err) {
      port.post({ k: 'done', ok: false, error: err instanceof Error ? err.message : show(err) });
    }
  };

  port.listen((msg) => {
    switch (msg.k) {
      case 'run':
        if (started) return;
        started = true;
        void run(msg.source, msg.permissions);
        return;
      case 'reply': {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new ScriptEngineError(msg.error.code, msg.error.message, msg.error.commandIndex));
        return;
      }
      case 'events':
        for (const l of [...eventListeners]) {
          try { l(msg.batch); } catch { /* a listener's failure is the script's own */ }
        }
        return;
    }
  });
}
