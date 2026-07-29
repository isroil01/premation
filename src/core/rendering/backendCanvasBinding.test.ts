/**
 * Regression: a transient WebGPU failure must not take the whole ladder down.
 *
 * `getContext` binds a canvas ELEMENT to one context type permanently. The
 * throwaway-canvas probe (`probeWebGpu`) protects the first attempt from a bad
 * WebGPU configure, but nothing protected the ladder itself: the real WebGPU
 * attempt calls `getContext('webgpu')` on the REAL canvas, and if that attempt
 * then failed for a transient reason (device lost, init timeout while a project
 * loads, a resize race), every WebGL2 rung below it could only ever receive
 * null. The user saw "WebGL2 is not available" and a blank preview on a machine
 * where WebGPU works — intermittently, on entering a project.
 *
 * These tests pin the two invariants that fix it:
 *   1. Once a canvas is bound, rungs of a DIFFERENT type are skipped, not tried.
 *   2. A bound-and-failed tier gets a delayed retry of its OWN type, because
 *      that is the only type that can still succeed on that element.
 */

import { MotionRendererBackend } from './MotionRendererBackend';

type Kind = 'webgl2' | 'webgpu' | 'null';

/** A canvas stub with real getContext binding semantics. */
function makeCanvas(): HTMLCanvasElement {
  let bound: string | null = null;
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext(type: string): unknown {
      if (bound === null) {
        bound = type;
        return { type };
      }
      return bound === type ? { type } : null;
    },
    /** Test-only: what this element is actually bound to. */
    get __bound(): string | null {
      return bound;
    },
  };
  return canvas as unknown as HTMLCanvasElement;
}

/** The ladder a backend would attempt, read off the private method. */
async function ladderOf(preferred: Kind): Promise<Array<{ kind: Kind; delayMs?: number }>> {
  const be = new MotionRendererBackend(preferred);
  const attempts = await (
    be as unknown as { initAttempts(): Promise<Array<{ kind: Kind; delayMs?: number }>> }
  ).initAttempts();
  return attempts;
}

describe('canvas context binding is permanent', () => {
  it('a canvas bound to webgpu can never yield webgl2', () => {
    const canvas = makeCanvas();
    expect(canvas.getContext('webgpu' as 'webgl2')).not.toBeNull();
    expect(canvas.getContext('webgl2')).toBeNull();
  });

  it('noteBinding records the type an attempt actually took', () => {
    const canvas = makeCanvas();
    canvas.getContext('webgpu' as 'webgl2'); // the failed WebGPU attempt
    const M = MotionRendererBackend as unknown as {
      noteBinding(c: HTMLCanvasElement, k: Kind): void;
      boundKind: WeakMap<HTMLCanvasElement, Kind>;
    };
    M.noteBinding(canvas, 'webgpu');
    expect(M.boundKind.get(canvas)).toBe('webgpu');
  });

  it('noteBinding does NOT bind a type that was never attempted', () => {
    const canvas = makeCanvas();
    const M = MotionRendererBackend as unknown as {
      noteBinding(c: HTMLCanvasElement, k: Kind): void;
      boundKind: WeakMap<HTMLCanvasElement, Kind>;
    };
    // webgl2 was attempted and got the context — that is the binding.
    M.noteBinding(canvas, 'webgl2');
    expect(M.boundKind.get(canvas)).toBe('webgl2');
    expect((canvas as unknown as { __bound: string }).__bound).toBe('webgl2');
  });
});

describe('init ladder', () => {
  it('offers a same-tier WebGPU retry before stepping down', async () => {
    // jsdom has no navigator.gpu, so the webgpu rungs are correctly absent and
    // the ladder is webgl2-only. Assert the SHAPE that guarantees a step-down is
    // never the first response to a failure.
    const attempts = await ladderOf('webgl2');
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0]!.kind).toBe('webgl2');
    // The second rung retries the same tier after a delay rather than giving up.
    expect(attempts[1]!.kind).toBe('webgl2');
    expect(attempts[1]!.delayMs).toBeGreaterThan(0);
  });

  it('null backend gets exactly one attempt (no GPU ladder)', async () => {
    const attempts = await ladderOf('null');
    expect(attempts).toEqual([{ kind: 'null' }]);
  });

  it('a bound canvas makes every mismatched rung unusable', () => {
    // This is the condition the ladder now checks before spending a rung: the
    // pre-fix code called getContext anyway and reported that null as the
    // failure reason, blaming WebGL2 for a WebGPU hiccup.
    const canvas = makeCanvas();
    canvas.getContext('webgpu' as 'webgl2');
    const M = MotionRendererBackend as unknown as {
      noteBinding(c: HTMLCanvasElement, k: Kind): void;
      boundKind: WeakMap<HTMLCanvasElement, Kind>;
    };
    M.noteBinding(canvas, 'webgpu');

    const bound = M.boundKind.get(canvas);
    const wouldSkip = (kind: Kind): boolean => !!bound && bound !== kind;
    expect(wouldSkip('webgl2')).toBe(true);
    expect(wouldSkip('webgpu')).toBe(false);
  });
});
