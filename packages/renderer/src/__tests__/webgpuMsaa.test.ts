/**
 * WebGPU MSAA — the parts WebGL2's version cannot share.
 *
 * The two APIs differ in where multisampling lives: WebGL2 attaches a
 * multisample renderbuffer to a framebuffer and blits, so nothing else needs to
 * know. WebGPU bakes the sample count into the PIPELINE and validates it against
 * the pass's attachments, and a multisampled texture is not sampleable at all —
 * so the target has to carry a resolve texture and the pass has to resolve into
 * it. Each of those is a way to get a validation error or a blank frame, and
 * none of them are covered by the WebGL2 tests.
 *
 * Driven through a recording fake device: the real one is unavailable in jsdom,
 * and what matters here is the shape of the requests, not the pixels.
 */

import { WebGPUBackend } from '../gpu/backends/WebGPUBackend';

interface FakeTexture {
  desc: Record<string, unknown>;
  createView: () => { __view: Record<string, unknown> };
  destroy: () => void;
}

function makeFakeDevice() {
  const textures: FakeTexture[] = [];
  const pipelines: Record<string, unknown>[] = [];
  const passes: Record<string, unknown>[] = [];

  const passEncoder = {
    setPipeline: () => {}, setBindGroup: () => {}, setVertexBuffer: () => {},
    setIndexBuffer: () => {}, setViewport: () => {}, setScissorRect: () => {},
    draw: () => {}, drawIndexed: () => {}, end: () => {},
  };

  const device = {
    createTexture(desc: Record<string, unknown>) {
      const tex: FakeTexture = { desc, createView: () => ({ __view: desc }), destroy: () => {} };
      textures.push(tex);
      return tex;
    },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline(desc: Record<string, unknown>) {
      pipelines.push(desc);
      return desc;
    },
    createCommandEncoder: () => ({
      beginRenderPass(desc: Record<string, unknown>) {
        passes.push(desc);
        return passEncoder;
      },
      finish: () => ({}),
    }),
    queue: { submit: () => {}, writeBuffer: () => {}, writeTexture: () => {}, copyExternalImageToTexture: () => {} },
    createBuffer: () => ({ destroy: () => {} }),
    createSampler: () => ({}),
  };
  return { device, textures, pipelines, passes };
}

/** A backend wired to the fake device, bypassing real adapter negotiation. */
function makeBackend() {
  const fake = makeFakeDevice();
  const backend = Object.create(WebGPUBackend.prototype) as WebGPUBackend;
  Object.assign(backend, {
    device: fake.device,
    context: { getCurrentTexture: () => ({ createView: () => ({ __view: 'surface' }) }) },
    format: 'bgra8unorm',
    surfaceW: 800,
    surfaceH: 600,
    frameClip: null,
  });
  return { backend, ...fake };
}

const TARGET = { label: 't', width: 64, height: 64, format: 'rgba8unorm' as const };

describe('WebGPU MSAA', () => {
  it('creates only ONE texture for a single-sample target', () => {
    const { backend, textures } = makeBackend();
    backend.createRenderTarget({ ...TARGET });
    expect(textures).toHaveLength(1);
    expect(textures[0]!.desc.sampleCount).toBeUndefined();
  });

  it('pairs a multisample attachment with a sampleable resolve texture', () => {
    const { backend, textures } = makeBackend();
    backend.createRenderTarget({ ...TARGET, samples: 4 });
    expect(textures).toHaveLength(2);
    const msaa = textures.find((t) => t.desc.sampleCount === 4)!;
    const resolve = textures.find((t) => t.desc.sampleCount === undefined)!;
    expect(msaa).toBeDefined();
    expect(resolve).toBeDefined();
    // A multisampled texture cannot be bound as a shader resource; only the
    // resolved one is ever read.
    const TEXTURE_BINDING = 4;
    expect((msaa.desc.usage as number) & TEXTURE_BINDING).toBe(0);
    expect((resolve.desc.usage as number) & TEXTURE_BINDING).not.toBe(0);
  });

  it('matches the depth attachment sample count to the colour one', () => {
    const { backend, textures } = makeBackend();
    backend.createRenderTarget({ ...TARGET, samples: 4, depth: true });
    const depth = textures.find((t) => t.desc.format === 'depth24plus')!;
    expect(depth).toBeDefined();
    // Mismatched sample counts are a validation error, not a soft fallback.
    expect(depth.desc.sampleCount).toBe(4);
  });

  it('leaves depth single-sample when the colour target is', () => {
    const { backend, textures } = makeBackend();
    backend.createRenderTarget({ ...TARGET, depth: true });
    const depth = textures.find((t) => t.desc.format === 'depth24plus')!;
    expect(depth.desc.sampleCount).toBeUndefined();
  });

  it('clamps an unsupported sample count down to single-sample', () => {
    // WebGPU guarantees 1 and 4 only; asking for 2 must not create a texture
    // the device will reject.
    const { backend, textures } = makeBackend();
    backend.createRenderTarget({ ...TARGET, samples: 2 });
    expect(textures).toHaveLength(1);
  });

  it('resolves the pass into the sampleable texture', () => {
    const { backend, passes } = makeBackend();
    const target = backend.createRenderTarget({ ...TARGET, samples: 4 });
    backend.beginFrame();
    backend.beginRenderPass({ label: 'p', color: { target } });
    const attachment = (passes[0]!.colorAttachments as Array<Record<string, unknown>>)[0]!;
    // Without a resolveTarget the multisample buffer never reaches the texture
    // everything binds, and the target reads back empty.
    expect(attachment.resolveTarget).toBeDefined();
  });

  it('KEEPS the multisample samples so a later load-op pass can continue', () => {
    // The composition re-opens its target with loadOp 'load' to keep drawing
    // into it. Discarding the samples after resolving (tempting — nothing
    // samples them) hands that next pass an undefined attachment and drops
    // everything already drawn.
    const { backend, passes } = makeBackend();
    const target = backend.createRenderTarget({ ...TARGET, samples: 4 });
    backend.beginFrame();
    backend.beginRenderPass({ label: 'first', color: { target, clear: { r: 0, g: 0, b: 0, a: 0 } } });
    backend.beginRenderPass({ label: 'second', color: { target } });
    const first = (passes[0]!.colorAttachments as Array<Record<string, unknown>>)[0]!;
    const second = (passes[1]!.colorAttachments as Array<Record<string, unknown>>)[0]!;
    expect(first.storeOp).toBe('store');
    expect(second.loadOp).toBe('load');
  });

  it('does not ask for a resolve on a single-sample target', () => {
    const { backend, passes } = makeBackend();
    const target = backend.createRenderTarget({ ...TARGET });
    backend.beginFrame();
    backend.beginRenderPass({ label: 'p', color: { target } });
    const attachment = (passes[0]!.colorAttachments as Array<Record<string, unknown>>)[0]!;
    expect(attachment.resolveTarget).toBeUndefined();
    expect(attachment.storeOp).toBe('store');
  });

  it('reports the pass sample count so draws can pick a matching pipeline', () => {
    const { backend } = makeBackend();
    const msaaTarget = backend.createRenderTarget({ ...TARGET, samples: 4 });
    const plainTarget = backend.createRenderTarget({ ...TARGET });
    backend.beginFrame();
    expect(backend.beginRenderPass({ label: 'a', color: { target: msaaTarget } }).samples).toBe(4);
    expect(backend.beginRenderPass({ label: 'b', color: { target: plainTarget } }).samples).toBe(1);
  });

  it('bakes the sample count into the pipeline', () => {
    const { backend, pipelines } = makeBackend();
    const shader = backend.createShaderModule({ wgsl: '// x' });
    const base = {
      shader, buffers: [], layout: [], topology: 'triangle-list' as const,
      blend: 'normal' as const, colorFormat: 'rgba8unorm' as const,
    };
    backend.createPipeline({ ...base, samples: 4 });
    backend.createPipeline({ ...base });
    expect((pipelines[0]!.multisample as { count: number }).count).toBe(4);
    expect(pipelines[1]!.multisample).toBeUndefined();
  });
});
