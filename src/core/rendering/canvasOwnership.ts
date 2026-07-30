/**
 * Which canvases belong to a GPU render backend.
 *
 * `HTMLCanvasElement.getContext` binds an element to ONE context type forever,
 * and there is no DOM API to ask "is this canvas already bound, and to what".
 * That makes an innocent-looking `getContext('2d')` a destructive act: called
 * on a canvas a GPU backend has claimed but not yet initialized (backend init
 * is async — the WebGPU probe alone is hundreds of ms on a cold start), it
 * binds the element to 2d and every later `getContext('webgpu'/'webgl2')`
 * returns null. That was the packaged-build "GPU unavailable / WebGL2 is not
 * available" bug: the viewport's mousemove pixel-sampler won the race against
 * the backend's first real getContext and burned the element.
 *
 * The registry closes the race structurally: a backend marks its canvas
 * synchronously in `attach()` (same task as handler setup, so no event can
 * observe the canvas unmarked), and read-only consumers check it before ever
 * calling `getContext('2d')` on a canvas they did not create.
 */

const gpuOwned = new WeakSet<HTMLCanvasElement>();

/** Claim `canvas` for a GPU backend. Call synchronously, before any await. */
export function markGpuOwned(canvas: HTMLCanvasElement): void {
  gpuOwned.add(canvas);
}

/** True when a GPU backend has claimed `canvas` (even if not yet initialized). */
export function isGpuOwned(canvas: HTMLCanvasElement): boolean {
  return gpuOwned.has(canvas);
}
