/**
 * WebGL2Backend.dispose() — the context-leak regression suite.
 *
 * Each editor enter/leave creates a fresh backend on a fresh canvas; dispose()
 * used to delete ONLY the VAO, leaking the WebGL2 context until Chrome's
 * per-page cap (~16) made getContext('webgl2') return null → blank canvas on
 * re-entry. dispose() must now release every GL object the backend allocated
 * AND explicitly lose the context so the slot frees immediately.
 */

import { WebGL2Backend } from '../gpu/backends/WebGL2Backend';

interface GlStub {
  gl: Record<string, jest.Mock | number>;
  loseContext: jest.Mock;
}

function makeGl(): GlStub {
  const loseContext = jest.fn();
  const gl: Record<string, jest.Mock | number> = {
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
    getExtension: jest.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null)),
  };
  return { gl, loseContext };
}

function surfaceFor(gl: unknown): { canvas: HTMLCanvasElement } {
  return { canvas: { getContext: jest.fn(() => gl) } as unknown as HTMLCanvasElement };
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
});
