/**
 * `kind` is what was ASKED for; `resolvedKind` is what actually rendered.
 *
 * Keeping only the first was a quiet, expensive bug. `MotionRendererBackend`
 * steps WebGPU → WebGL2 whenever WebGPU cannot start, which is right for the
 * product — but `kind` was fixed at construction, so after a step-down the
 * backend still answered `motion-webgpu`. The render-tests harness believed it:
 * on a machine with no WebGPU adapter it rendered WebGL2 pixels, read them back
 * through the WebGPU path, and filed them under `actual/webgpu/`. Every WebGPU
 * parity figure the suite ever reported was therefore measured on pixels no
 * WebGPU device produced, and the harness had no way to notice.
 *
 * The distinction has to survive BOTH directions to be useful:
 *   • before init resolves there is no answer, and `null` says so — a caller
 *     must not be able to mistake "not yet" for "WebGL2";
 *   • after dispose there is no answer either, because nothing is rendering.
 *
 * The consumer is packages/render-tests/harness/renderEntry.ts, which refuses
 * to record a frame when `resolvedKind` is not the backend it asked for.
 */

import { MotionRendererBackend } from './MotionRendererBackend';

describe('resolvedKind is the tier that actually rendered', () => {
  it('is null before init has resolved, while kind already answers', () => {
    const be = new MotionRendererBackend('webgpu');
    // The requested tier is readable immediately — that is what `kind` is for.
    expect(be.kind).toBe('motion-webgpu');
    // The resolved tier is not, and must not fall back to a plausible guess.
    expect(be.resolvedKind).toBeNull();
  });

  it('null is distinguishable from a resolved tier, so "not yet" cannot read as "webgl2"', () => {
    // The regression this pins: seeding the resolved tier with the FALLBACK
    // value is indistinguishable from a machine that genuinely fell back. The
    // same mistake was already made once in renderBackendStore, whose initial
    // tier had to be changed from 'webgl2' to an explicit 'pending'.
    const be = new MotionRendererBackend('webgpu');
    expect(be.resolvedKind).not.toBe('webgl2');
    expect(be.resolvedKind).not.toBe('webgpu');
  });

  it('dispose clears it — a disposed backend is rendering nothing', () => {
    const be = new MotionRendererBackend('webgl2');
    // Reach past init: the ladder needs a real canvas, and what is under test
    // is the lifecycle of the field, not the ladder that sets it.
    (be as unknown as { resolvedKind: string | null }).resolvedKind = 'webgl2';
    expect(be.resolvedKind).toBe('webgl2');
    be.dispose();
    expect(be.resolvedKind).toBeNull();
  });

  it('kind keeps reporting the REQUEST after a step-down, and the two disagree', () => {
    // This disagreement is the whole point: a caller that wants "what did the
    // user get" must read resolvedKind, and one that wants "what did we try"
    // reads kind. Collapsing them back into one field reintroduces the bug.
    const be = new MotionRendererBackend('webgpu');
    (be as unknown as { resolvedKind: string | null }).resolvedKind = 'webgl2';
    expect(be.kind).toBe('motion-webgpu');
    expect(be.resolvedKind).toBe('webgl2');
  });
});
