import { RenderGraph, RenderGraphError } from '../rendergraph/RenderGraph';
import { RenderPass, SURFACE, type RenderPassContext } from '../rendergraph/RenderPass';

class NamedPass extends RenderPass {
  constructor(
    readonly name: string,
    override readonly reads: string[] = [],
    override readonly writes: string[] = [SURFACE],
    override readonly after: string[] = [],
    private readonly onRun?: (name: string) => void,
  ) {
    super();
  }
  execute(_ctx: RenderPassContext): void {
    this.onRun?.(this.name);
  }
}

describe('RenderGraph', () => {
  it('orders passes by explicit `after` dependencies', () => {
    const g = new RenderGraph();
    g.addPass(new NamedPass('c', [], [SURFACE], ['b']));
    g.addPass(new NamedPass('a', [], [SURFACE], []));
    g.addPass(new NamedPass('b', [], [SURFACE], ['a']));
    expect(g.compile().map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  it('orders by resource data dependencies (writer before reader)', () => {
    const g = new RenderGraph();
    g.addPass(new NamedPass('consumer', ['gbuffer'], [SURFACE]));
    g.addPass(new NamedPass('producer', [], ['gbuffer']));
    expect(g.compile().map((p) => p.name)).toEqual(['producer', 'consumer']);
  });

  it('detects cycles', () => {
    const g = new RenderGraph();
    g.addPass(new NamedPass('x', ['rb'], ['ra']));
    g.addPass(new NamedPass('y', ['ra'], ['rb']));
    expect(() => g.compile()).toThrow(RenderGraphError);
    try {
      g.compile();
    } catch (e) {
      expect((e as RenderGraphError).code).toBe('cycle');
    }
  });

  it('rejects duplicate pass names', () => {
    const g = new RenderGraph();
    g.addPass(new NamedPass('dup'));
    expect(() => g.addPass(new NamedPass('dup'))).toThrow(RenderGraphError);
  });

  it('excludes disabled passes from the order', () => {
    const g = new RenderGraph();
    const disabled = new NamedPass('off');
    disabled.enabled = false;
    g.addPass(new NamedPass('on'));
    g.addPass(disabled);
    expect(g.compile().map((p) => p.name)).toEqual(['on']);
  });

  it('recompiles after passes change', () => {
    const g = new RenderGraph();
    g.addPass(new NamedPass('a'));
    expect(g.compile().length).toBe(1);
    g.addPass(new NamedPass('b', [], [SURFACE], ['a']));
    expect(g.compile().map((p) => p.name)).toEqual(['a', 'b']);
    g.removePass('a');
    expect(g.compile().map((p) => p.name)).toEqual(['b']);
  });

  it('resolves float targets to rgba32float only when backend supports float32Textures and bitDepth is 32', () => {
    const { setActiveColorPipeline, DEFAULT_COLOR_PIPELINE } = require('../shaders/colorPipeline');
    const { ResourceManager } = require('../gpu/ResourceManager');
    const { NullBackend } = require('../gpu/backends/NullBackend');

    // Fresh ResourceManager per case — RT pool keys omit format, so reusing
    // one manager would keep the first format forever.
    const run = (bitDepth: 16 | 32, float32Textures: boolean): { format: string; samples?: number } => {
      const backend = new NullBackend();
      backend.capabilities.float32Textures = float32Textures;
      let captured: { format: string; samples?: number } | null = null;
      const orig = backend.createRenderTarget.bind(backend);
      backend.createRenderTarget = (desc: { format: string; samples?: number }) => {
        captured = { format: desc.format, samples: desc.samples };
        return orig(desc);
      };
      const resources = new ResourceManager(backend);
      const g = new RenderGraph();
      g.declareTarget('test-float', () => ({
        label: 'test-float',
        width: 100,
        height: 100,
        format: 'rgba16float' as const,
        samples: 4,
      }));
      g.addPass(new NamedPass('pass1', ['test-float'], [SURFACE]));
      setActiveColorPipeline({ workingSpace: 'srgb-linear', displayTransform: 'srgb', bitDepth });
      const targets = g.resolveTargets(
        backend,
        resources,
        { pixelSize: { width: 100, height: 100 } } as any,
        'rgba8unorm',
      );
      expect(targets.get('test-float')).toBeDefined();
      expect(captured).not.toBeNull();
      return captured!;
    };

    try {
      expect(run(16, true)).toEqual({ format: 'rgba16float', samples: 4 });
      expect(run(32, true)).toEqual({ format: 'rgba32float', samples: 1 });
      expect(run(32, false).format).toBe('rgba16float');
    } finally {
      setActiveColorPipeline(DEFAULT_COLOR_PIPELINE);
    }
  });
});
