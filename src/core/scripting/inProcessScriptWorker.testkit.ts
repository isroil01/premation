/**
 * The script sandbox for TESTS: the real worker runtime (scriptRuntime.ts) in
 * this realm, behind the same message interface as a Worker — messages are
 * structured-cloned and delivered asynchronously, as `postMessage` would.
 * jsdom has no module workers; this keeps the host's permission gate, the
 * one-entry transaction and the rollback testable. Not used by the app (the
 * app only ever hands a script to a real Worker).
 */

import { startScriptRuntime } from './scriptRuntime';
import type { ScriptHostMessage, ScriptWorkerMessage } from './protocol';
import type { ScriptWorkerLike } from './scriptHost';

export class InProcessScriptWorker implements ScriptWorkerLike {
  onmessage: ((ev: { data: ScriptWorkerMessage }) => void) | null = null;
  onerror: ((ev: { message?: string }) => void) | null = null;
  terminated = false;
  private toWorker: ((msg: ScriptHostMessage) => void) | null = null;

  constructor() {
    startScriptRuntime({
      post: (msg) => {
        const copy = structuredClone(msg);
        void Promise.resolve().then(() => {
          if (!this.terminated) this.onmessage?.({ data: copy });
        });
      },
      listen: (handler) => { this.toWorker = handler; },
    });
  }

  postMessage(msg: ScriptHostMessage): void {
    const copy = structuredClone(msg);
    void Promise.resolve().then(() => {
      if (!this.terminated) this.toWorker?.(copy);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}
