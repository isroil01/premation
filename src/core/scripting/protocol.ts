/**
 * The script sandbox wire protocol (host ⇄ worker). Plain structured-clone
 * data only — engine commands, queries and results are already plain JSON
 * shapes from `@motion/engine-api`.
 */

/** What a script may do. Granted per run, like a plugin's install consent. */
export type ScriptPermission =
  /** Queries (`premation.query`) and change events (`premation.onEvents`). */
  | 'document.read'
  /** Edit commands (`premation.execute`, `premation.batch`) — all inside the run's one undo entry. */
  | 'document.write';

export const SCRIPT_PERMISSIONS: readonly ScriptPermission[] = ['document.read', 'document.write'];

export type ScriptCallMethod = 'execute' | 'batch' | 'query' | 'subscribe';

/** Host → worker. */
export type ScriptHostMessage =
  | { k: 'run'; name: string; source: string; permissions: ScriptPermission[] }
  | { k: 'reply'; id: number; ok: true; value: unknown }
  | { k: 'reply'; id: number; ok: false; error: { code: string; message: string; commandIndex?: number } }
  | { k: 'events'; batch: unknown };

/** Worker → host. */
export type ScriptWorkerMessage =
  | { k: 'call'; id: number; method: ScriptCallMethod; args: unknown[] }
  | { k: 'log'; level: 'log' | 'warn' | 'error'; text: string }
  | { k: 'done'; ok: true; value: unknown }
  | { k: 'done'; ok: false; error: string };

/**
 * `// @permissions document.read, document.write` in the first lines of a
 * script declares what it asks for (the manifest of a one-file script).
 * Unknown words are ignored; absent = read only.
 */
export function declaredPermissions(source: string): ScriptPermission[] {
  const head = source.split(/\r?\n/).slice(0, 20).join('\n');
  const m = /@permissions\s+([^\n]*)/.exec(head);
  if (!m) return ['document.read'];
  const words = m[1]!.split(/[\s,]+/).filter(Boolean);
  return SCRIPT_PERMISSIONS.filter((p) => words.includes(p));
}
