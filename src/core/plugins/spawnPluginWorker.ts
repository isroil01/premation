/**
 * The one line that constructs the plugin sandbox.
 *
 * It lives alone in its own module for a mechanical reason: `import.meta.url`
 * is ESM-only syntax, and the test runner parses these files as CommonJS, so a
 * bundler-specific worker URL anywhere in `PluginHost.ts` would make the host
 * untestable. Jest maps this module to `spawnPluginWorker.stub.ts`; the tests
 * inject a fake worker through `PluginHost.setWorkerFactory` anyway.
 *
 * Note what this is NOT: it is not a dynamic import of plugin code. The URL is
 * OUR worker module, resolved by Vite at build time. A plugin's own source is
 * sent to that worker as data and imported inside the sandbox.
 */

export function spawnPluginWorker(): Worker {
  return new Worker(new URL('./pluginWorker.ts', import.meta.url), { type: 'module' });
}
