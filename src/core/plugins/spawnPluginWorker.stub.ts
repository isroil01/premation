/**
 * Test stub for `spawnPluginWorker` — see the note in that file.
 *
 * jsdom has no module-worker loader, so there is nothing honest to return here.
 * Throwing is correct: any test that reaches this line forgot to install a fake
 * worker via `PluginHost.setWorkerFactory`, and a silently inert worker would
 * make the host's supervision look like it passed when it never ran.
 */

export function spawnPluginWorker(): Worker {
  throw new Error('spawnPluginWorker is not available under test — use PluginHost.setWorkerFactory().');
}
