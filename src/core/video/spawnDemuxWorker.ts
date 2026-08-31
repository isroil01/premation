/**
 * Isolated worker-spawn seam. `import.meta.url` lives here alone so the rest of
 * the demux code (and its Jest suites) never has to parse it — this module is
 * only ever reached via a dynamic import at runtime, which Vite bundles and
 * Jest simply never loads. Same shape as `spawnEncodeWorker`.
 */

export function spawnDemuxWorker(): Worker {
  return new Worker(new URL('./demux.worker.ts', import.meta.url), { type: 'module' });
}
