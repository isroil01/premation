/**
 * User scripts on the engine API (NATIVE_CORE_PLAN §5 B5, ENGINE_API.md §12) —
 * the host side. `runScript(source)`:
 *
 *   1. PERMISSIONS. A script declares what it needs (`// @permissions
 *      document.read, document.write`); the run asks the consent prompt for
 *      exactly that, like a plugin's install consent. Refused = nothing runs.
 *   2. ONE UNDO ENTRY. The run is one engine gesture, `Script: <name>`, origin
 *      `script` — the same transaction an AI turn uses (core/ai/aiTransaction):
 *      every command the script sends lands in it; it is replayable from the
 *      command log.
 *   3. ERRORS ROLL BACK. A script that throws, times out, or crashes its
 *      worker is cancelled with the engine's own cancel
 *      (`endGesture{commit:false}`): the document is exactly as before and no
 *      entry is pushed.
 *   4. SANDBOX. The source runs in a dedicated Worker (scriptWorker.ts): no
 *      DOM, no storage, no network. It reaches the document only through the
 *      calls below, each checked here: edit commands need `document.write`,
 *      queries and events need `document.read`, and control / io commands
 *      (undo, redo, gestures, save, open, transport) are never available —
 *      the run owns its one entry.
 */

import { COMMANDS, type Command, type EngineClient, type Query } from '@motion/engine-api';
import { AiEngineError } from '@motion/ai-tools';
import { engine } from '@core/engine/engineInstance';
import { beginAiTransaction, type AiTurnOutcome } from '@core/ai/aiTransaction';
import { declaredPermissions, type ScriptHostMessage, type ScriptPermission, type ScriptWorkerMessage } from './protocol';

/** What the host needs of a worker (a real `Worker`, or the in-process test worker). */
export interface ScriptWorkerLike {
  postMessage(msg: ScriptHostMessage): void;
  onmessage: ((ev: { data: ScriptWorkerMessage }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  terminate(): void;
}

export interface ScriptConsentRequest {
  name: string;
  permissions: readonly ScriptPermission[];
}

export type ScriptConsent = (req: ScriptConsentRequest) => boolean | Promise<boolean>;

export interface RunScriptOptions {
  /** Shown in the undo entry (`Script: <name>`) and the consent prompt. */
  name?: string;
  /** Override the permissions the source declares. */
  permissions?: ScriptPermission[];
  /** The consent prompt; default: the registered app prompt, else refuse. */
  consent?: ScriptConsent;
  /** Default: the app engine. */
  client?: EngineClient;
  /** The run is cancelled (and rolled back) after this long. Default 30 s. */
  timeoutMs?: number;
  /** Tests inject a worker; default: the real sandbox Worker. */
  workerFactory?: () => ScriptWorkerLike | Promise<ScriptWorkerLike>;
  onLog?: (level: 'log' | 'warn' | 'error', text: string) => void;
}

export interface ScriptRunResult {
  ok: boolean;
  /** The script's return value (JSON-safe). */
  value?: unknown;
  error?: string;
  /**
   * `engine` / `snapshot` / `empty` — the run committed (see AiTurnOutcome);
   * `rolledBack` — it failed and the document is unchanged;
   * `refused` — consent was not given, nothing ran.
   */
  outcome: AiTurnOutcome['kind'] | 'rolledBack' | 'refused';
  logs: string[];
}

let appConsent: ScriptConsent | null = null;

/** The app's consent prompt (a dialog), registered by the UI. */
export function setScriptConsentPrompt(prompt: ScriptConsent | null): void {
  appConsent = prompt;
}

const DEFAULT_TIMEOUT_MS = 30_000;

async function defaultWorker(): Promise<ScriptWorkerLike> {
  const { spawnScriptWorker } = await import('./spawnScriptWorker');
  return spawnScriptWorker() as unknown as ScriptWorkerLike;
}

/** Why a call is refused, or null when the run's permissions allow it. */
function refusal(method: string, args: unknown[], granted: ReadonlySet<ScriptPermission>): string | null {
  if (method === 'query' || method === 'subscribe') {
    return granted.has('document.read') ? null : `${method} needs the document.read permission`;
  }
  const cmds = method === 'execute' ? [args[0]] : Array.isArray(args[1]) ? args[1] : [];
  if (!granted.has('document.write')) return `${method} needs the document.write permission`;
  for (const c of cmds) {
    const type = (c as { type?: string } | null)?.type ?? '';
    const info = COMMANDS[type as Command['type']];
    if (!info) return `unknown command '${type}'`;
    if (info.kind !== 'edit') {
      return `'${type}' is a ${info.kind} command; scripts send edit commands only (the run is one undo entry)`;
    }
  }
  return null;
}

/** Run a user script. Never throws; the result says what happened. */
export async function runScript(source: string, opts: RunScriptOptions = {}): Promise<ScriptRunResult> {
  const name = opts.name?.trim() || 'Untitled script';
  const permissions = opts.permissions ?? declaredPermissions(source);
  const logs: string[] = [];
  const consent = opts.consent ?? appConsent;
  const granted = consent ? await consent({ name, permissions }) : false;
  if (!granted) return { ok: false, error: 'The script was not given permission to run.', outcome: 'refused', logs };
  const grantedSet = new Set(permissions);

  const client = opts.client ?? engine();
  const tx = await beginAiTransaction(`Script: ${name}`, { client, origin: 'script' });
  let worker: ScriptWorkerLike;
  try {
    worker = await (opts.workerFactory ?? defaultWorker)();
  } catch (err) {
    await tx.rollback();
    return { ok: false, error: `The script sandbox could not start: ${err instanceof Error ? err.message : String(err)}`, outcome: 'rolledBack', logs };
  }

  const events: { unsubscribe: (() => void) | null } = { unsubscribe: null };
  const reply = (id: number, work: () => Promise<unknown>): void => {
    void work().then(
      (value) => worker.postMessage({ k: 'reply', id, ok: true, value }),
      (err: unknown) => {
        const e = err instanceof AiEngineError
          ? { code: err.code, message: err.message, ...(err.commandIndex !== undefined ? { commandIndex: err.commandIndex } : {}) }
          : { code: 'refused', message: err instanceof Error ? err.message : String(err) };
        worker.postMessage({ k: 'reply', id, ok: false, error: e });
      },
    );
  };

  const finished = new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: `The script ran longer than ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s and was stopped.` }), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const settle = (r: { ok: boolean; value?: unknown; error?: string }): void => {
      clearTimeout(timer);
      resolve(r);
    };
    worker.onerror = (ev) => settle({ ok: false, error: `The script crashed: ${ev.message ?? 'worker error'}` });
    worker.onmessage = (ev) => {
      const msg = ev.data;
      switch (msg.k) {
        case 'log':
          logs.push(msg.text);
          opts.onLog?.(msg.level, msg.text);
          return;
        case 'done':
          settle(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error });
          return;
        case 'call': {
          const why = refusal(msg.method, msg.args, grantedSet);
          if (why) {
            reply(msg.id, () => Promise.reject(new AiEngineError('refused', why)));
            return;
          }
          switch (msg.method) {
            case 'execute':
              reply(msg.id, async () => {
                const [r] = await tx.session.apply([msg.args[0] as Command]);
                const { type: _t, ...value } = r as unknown as Record<string, unknown>;
                return value;
              });
              return;
            case 'batch':
              reply(msg.id, () => tx.session.apply(msg.args[1] as Command[], String(msg.args[0] ?? '')));
              return;
            case 'query':
              reply(msg.id, () => tx.session.query(msg.args[0] as Query as never));
              return;
            case 'subscribe':
              reply(msg.id, async () => {
                events.unsubscribe ??= client.subscribe((batch) => {
                  try { worker.postMessage({ k: 'events', batch: structuredClone(batch) }); } catch { /* worker gone */ }
                });
                return null;
              });
              return;
          }
        }
      }
    };
  });

  worker.postMessage({ k: 'run', name, source, permissions });
  const end = await finished;
  events.unsubscribe?.();
  worker.terminate();
  if (!end.ok) {
    await tx.rollback();
    return { ok: false, error: end.error, outcome: 'rolledBack', logs };
  }
  const outcome = await tx.commit();
  return { ok: true, value: end.value, outcome: outcome.kind, logs };
}
