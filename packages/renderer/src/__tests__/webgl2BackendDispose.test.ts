/**
 * WebGL2Backend.dispose — the context-leak regression suite.
 *
 * Each editor enter/leave creates a fresh backend on a fresh canvas; dispose
 * used to delete ONLY the VAO, leaking the WebGL2 context until Chrome's
 * per-page cap (~16) made getContext('webgl2') return null → blank canvas on
 * re-entry. dispose must now release every GL object the backend allocated
 * AND explicitly lose the context so the slot frees immediately.
 */

import { WebGL2Backend } from '../gpu/backends/WebGL2Backend';

interface GlStub {
  gl: Record<string, jest.Mock | number>;
  loseContext: jest.Mock;
  restoreContext: jest.Mock;
}

function makeGl(opts: { lost?: boolean; restorable?: boolean } = {}): GlStub {
  const loseContext = jest.fn();
  // A canvas hands back the SAME (still-lost) context object after
  // loseContext, so `initialize` must probe isContextLost rather than trust a
  // non-null getContext. `lost` models that state.
  let lost = opts.lost ?? false;
  const restoreContext = jest.fn(() => {
    if (opts.restorable !== false) lost = false;
  });
  const gl: Record<string, jest.Mock | number> = {
    isContextLost: jest.fn(() => lost),
    MAX_TEXTURE_SIZE: 0x0d33,
    FRAMEBUFFER: 0x8d40,
    getParameter: jest.fn(() => 4096),
    createVertexArray: jest.fn(() => ({ kind: 'vao' })),
    deleteVertexArray: jest.fn(),
    bindVertexArray: jest.fn(),
    enable: jest.fn(),
    createBuffer: jest.fn(() => ({ kind: 'buffer' })),
    bindBuffer: jest.fn(),
    bufferData: jest.fn(),
    deleteBuffer: jest.fn(),
    createTexture: jest.fn(() => ({ kind: 'texture' })),
    bindTexture: jest.fn(),
    texImage2D: jest.fn(),
    deleteTexture: jest.fn(),
    createSampler: jest.fn(() => ({ kind: 'sampler' })),
    samplerParameteri: jest.fn(),
    deleteSampler: jest.fn(),
    createFramebuffer: jest.fn(() => ({ kind: 'fbo' })),
    bindFramebuffer: jest.fn(),
    framebufferTexture2D: jest.fn(),
    deleteFramebuffer: jest.fn(),
    RENDERBUFFER: 0x8d41,
    DEPTH_COMPONENT24: 0x81a6,
    DEPTH_ATTACHMENT: 0x8d00,
    createRenderbuffer: jest.fn(() => ({ kind: 'renderbuffer' })),
    bindRenderbuffer: jest.fn(),
    renderbufferStorage: jest.fn(),
    framebufferRenderbuffer: jest.fn(),
    deleteRenderbuffer: jest.fn(),
    deleteProgram: jest.fn(),
    getExtension: jest.fn((name: string) =>
      name === 'WEBGL_lose_context' ? { loseContext, restoreContext } : null,
    ),
  };
  return { gl, loseContext, restoreContext };
}

function surfaceFor(gl: unknown): { canvas: HTMLCanvasElement } {
  // addEventListener/removeEventListener are real canvas members — the backend
  // now subscribes to webglcontextlost/restored so a driver reset surfaces as an
  // error instead of a silently frozen viewport.
  return {
    canvas: {
      getContext: jest.fn(() => gl),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as HTMLCanvasElement,
  };
}

describe('WebGL2Backend.dispose', () => {
  test('releases every allocated GL resource and loses the context', async () => {
    const { gl, loseContext } = makeGl();
    const backend = new WebGL2Backend();
    await backend.initialize(surfaceFor(gl));

    const buf = backend.createBuffer({ sizeBytes: 64, usage: ['vertex'] });
    const tex = backend.createTexture({ width: 4, height: 4, format: 'rgba8unorm' });
    const sampler = backend.createSampler({});
    const target = backend.createRenderTarget({ width: 8, height: 8, format: 'rgba8unorm' });
    void buf;
    void tex;
    void sampler;
    void target;

    backend.dispose();

    // Buffer, texture (standalone + render-target's), sampler, fbo, vao all freed.
    expect((gl.deleteBuffer as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((gl.deleteTexture as jest.Mock)).toHaveBeenCalledTimes(2);
    expect((gl.deleteSampler as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((gl.deleteFramebuffer as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((gl.deleteVertexArray as jest.Mock)).toHaveBeenCalledTimes(1);
    // The context slot itself is released — the actual leak fix.
    expect((gl.getExtension as jest.Mock)).toHaveBeenCalledWith('WEBGL_lose_context');
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  test('depth render targets track and release their renderbuffer', async () => {
    const { gl, loseContext } = makeGl();
    const backend = new WebGL2Backend();
    await backend.initialize(surfaceFor(gl));

    // A depth target allocates a renderbuffer and attaches it.
    const withDepth = backend.createRenderTarget({ width: 8, height: 8, format: 'rgba8unorm', depth: true });
    expect((gl.createRenderbuffer as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((gl.framebufferRenderbuffer as jest.Mock)).toHaveBeenCalledTimes(1);
    // A colour-only target does not.
    backend.createRenderTarget({ width: 8, height: 8, format: 'rgba8unorm' });
    expect((gl.createRenderbuffer as jest.Mock)).toHaveBeenCalledTimes(1);

    // Individual destroy releases the renderbuffer with the target…
    backend.destroyRenderTarget(withDepth);
    expect((gl.deleteRenderbuffer as jest.Mock)).toHaveBeenCalledTimes(1);

    // …and dispose does not double-free it (live-set bookkeeping).
    backend.dispose();
    expect((gl.deleteRenderbuffer as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  test('an undisposed depth renderbuffer is released by dispose()', async () => {
    const { gl, loseContext } = makeGl();
    const backend = new WebGL2Backend();
    await backend.initialize(surfaceFor(gl));
    backend.createRenderTarget({ width: 8, height: 8, format: 'rgba8unorm', depth: true });
    backend.dispose();
    expect((gl.deleteRenderbuffer as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  test('resources already destroyed individually are not double-deleted', async () => {
    const { gl, loseContext } = makeGl();
    const backend = new WebGL2Backend();
    await backend.initialize(surfaceFor(gl));

    const buf = backend.createBuffer({ sizeBytes: 64, usage: ['vertex'] });
    backend.destroyBuffer(buf);
    expect((gl.deleteBuffer as jest.Mock)).toHaveBeenCalledTimes(1);

    backend.dispose();
    expect((gl.deleteBuffer as jest.Mock)).toHaveBeenCalledTimes(1); // not again
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  test('double dispose is safe and loses the context only once', async () => {
    const { gl, loseContext } = makeGl();
    const backend = new WebGL2Backend();
    await backend.initialize(surfaceFor(gl));

    backend.dispose();
    expect(() => backend.dispose()).not.toThrow();
    expect(loseContext).toHaveBeenCalledTimes(1);
    expect((gl.deleteVertexArray as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  test('dispose before a successful initialize is a no-op', () => {
    const backend = new WebGL2Backend();
    expect(() => backend.dispose()).not.toThrow();
  });

  test('initialize still throws when the context cannot be created', async () => {
    const backend = new WebGL2Backend();
    const surface = { canvas: { getContext: jest.fn(() => null) } as unknown as HTMLCanvasElement };
    await expect(backend.initialize(surface)).rejects.toThrow('WebGL2 is not available');
    // And disposing that failed backend must not throw either.
    expect(() => backend.dispose()).not.toThrow();
  });

  // Re-attaching to a canvas whose context was killed by a previous dispose.
  // getContext returns the same LOST context rather than null, so the plain
  // null-check passes and every later GL call silently no-ops — the blank
  // viewport after a StrictMode/HMR remount.
  test('initialize restores a lost context instead of returning a dead one', async () => {
    const { gl, restoreContext } = makeGl({ lost: true });
    const backend = new WebGL2Backend();
    await expect(backend.initialize(surfaceFor(gl))).resolves.toBeUndefined();
    expect(restoreContext).toHaveBeenCalledTimes(1);
    expect(gl.getParameter).toHaveBeenCalled(); // proceeded to real setup
  });

  test('initialize throws when a lost context cannot be restored', async () => {
    const { gl } = makeGl({ lost: true, restorable: false });
    const backend = new WebGL2Backend();
    await expect(backend.initialize(surfaceFor(gl))).rejects.toThrow(/context is lost/);
  });

  test('dispose detaches the context-loss listeners it registered', async () => {
    const { gl } = makeGl();
    const surface = surfaceFor(gl);
    const backend = new WebGL2Backend();
    await backend.initialize(surface);
    expect(surface.canvas.addEventListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function));
    expect(surface.canvas.addEventListener).toHaveBeenCalledWith('webglcontextrestored', expect.any(Function));
    backend.dispose();
    // Must come off BEFORE dispose's own loseContext fires, or the backend
    // reports its own teardown as an unexpected context loss.
    expect(surface.canvas.removeEventListener).toHaveBeenCalledWith('webglcontextlost', expect.any(Function));
    expect(surface.canvas.removeEventListener).toHaveBeenCalledWith('webglcontextrestored', expect.any(Function));
  });
});
