/**
 * The device-loss hook is actually connected.
 *
 * `pluginEffects.test.ts` proves the attribution logic; this proves anything
 * ever calls it. Those are different failures, and the second is the quiet one:
 * a handler with no production caller passes every unit test it has, reads as
 * finished in review, and does nothing on the day a plugin hangs the GPU.
 *
 * Asserted by reading the source rather than by launching a GPU. The defect
 * being guarded against is the ABSENCE of a call — and a test that needed a
 * real device could not run here at all, which is how "we will wire it up
 * later" becomes permanent.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) =>
  readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the WebGPU backend', () => {
  const backend = read('packages/renderer/src/gpu/backends/WebGPUBackend.ts');

  it('★ subscribes to device.lost', () => {
    expect(backend).toMatch(/this\.device\.lost\s*\.\s*then/);
  });

  it('★ does not use .catch, which would never fire', () => {
    /*
      `GPUDevice.lost` RESOLVES on a device reset; it does not reject. A
      `.catch` compiles, reads correctly, and is dead code — the single most
      plausible way for this whole path to look wired while being inert.
    */
    expect(backend).not.toMatch(/device\.lost\s*\.\s*catch/);
  });

  it('attaches the handler before the device is used', () => {
    // A device lost during initialisation is exactly the case a later
    // attachment misses, and it is a real one on a machine already in trouble.
    const acquired = backend.indexOf('adapter.requestDevice');
    const subscribed = backend.indexOf('this.device.lost');
    const configured = backend.indexOf('this.context.configure');

    expect(acquired).toBeGreaterThan(-1);
    expect(subscribed).toBeGreaterThan(acquired);
    expect(subscribed).toBeLessThan(configured);
  });
});

describe('★ the app forwards it to attribution', () => {
  const app = read('src/core/rendering/MotionRendererBackend.ts');

  it('calls noteDeviceLoss', () => {
    // The production caller. Without this line every assertion in
    // `pluginEffects.test.ts` is about code nothing reaches.
    expect(app).toMatch(/noteDeviceLoss\s*\(/);
    expect(app).toMatch(/from '@core\/plugins\/pluginEffects'/);
  });

  it('registers the handler on the backend it just created', () => {
    expect(app).toMatch(/onDeviceLost\s*\(/);
  });

  it('does so before initialize is awaited', () => {
    /*
      `createGpuBackendFor` returns the backend that `initialize` is then called
      on, so attaching inside that factory is what puts the handler in place
      first. If the wiring ever moves after the await, this fails.
    */
    const hooked = app.indexOf('onDeviceLost');
    const initialised = app.indexOf('renderer.initialize(');
    expect(hooked).toBeGreaterThan(-1);
    expect(hooked).toBeLessThan(initialised);
  });
});
