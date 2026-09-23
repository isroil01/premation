/**
 * The one line that constructs the script sandbox (see spawnPluginWorker.ts for
 * why it lives alone: `import.meta.url` is ESM-only and the test runner parses
 * CJS). The host loads this module lazily, and tests inject a worker instead.
 * The URL is OUR worker module; a script's source only ever crosses as data.
 */

export function spawnScriptWorker(): Worker {
  return new Worker(new URL('./scriptWorker.ts', import.meta.url), { type: 'module' });
}
