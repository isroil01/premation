import { NullBackend } from '../gpu/backends/NullBackend';
import { ShaderCache } from '../shaders/ShaderCache';
import { ShaderRegistry } from '../shaders/ShaderRegistry';
import type { ShaderSource } from '../shaders/builtin';

const A: ShaderSource = { name: 'a', wgsl: 'A_WGSL', glsl: { vertex: 'AV', fragment: 'AF' } };
const B: ShaderSource = { name: 'b', wgsl: 'B_WGSL', glsl: { vertex: 'BV', fragment: 'BF' } };

describe('ShaderCache', () => {
  it('compiles a source once and reuses it', () => {
    const backend = new NullBackend();
    const cache = new ShaderCache(backend);
    const m1 = cache.get(A);
    const m2 = cache.get(A);
    expect(m1).toBe(m2);
    expect(cache.compileCount).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('compiles distinct sources separately', () => {
    const cache = new ShaderCache(new NullBackend());
    cache.get(A);
    cache.get(B);
    expect(cache.compileCount).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('dispose frees compiled modules', () => {
    const backend = new NullBackend();
    const cache = new ShaderCache(backend);
    cache.get(A);
    cache.get(B);
    cache.dispose();
    expect(cache.size).toBe(0);
  });

  it('registry pre-registers the built-ins', () => {
    const reg = new ShaderRegistry();
    expect(reg.has('solid')).toBe(true);
    expect(reg.has('textured')).toBe(true);
    expect(() => reg.require('missing')).toThrow();
  });
});
