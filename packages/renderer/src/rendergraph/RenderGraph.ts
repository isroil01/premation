/**
 * The Render Graph. Owns passes + transient render-target declarations, computes
 * a valid execution order from declared dependencies (topological sort), detects
 * cycles, allocates/reuses transient targets, and executes passes in order.
 *
 * Ordering rules:
 *   - pass B depends on pass A if B.reads ∩ A.writes ≠ ∅  (data dependency)
 *   - pass B depends on pass A if A.name ∈ B.after         (explicit ordering)
 * Compilation is memoized and invalidated when passes change.
 */

import type { RenderBackend } from '../gpu/RenderBackend';
import type { ResourceManager } from '../gpu/ResourceManager';
import type { RenderTargetDescriptor, RenderTargetHandle } from '../gpu/types';
import type { FrameInfo } from '../core/Frame';
import type { FrameScene } from '../scene/FrameScene';
import type { Viewport } from '../viewport/Viewport';
import { RenderPass, SURFACE, type RenderPassContext, type RenderServices } from './RenderPass';

export class RenderGraphError extends Error {
  constructor(
    message: string,
    readonly code: 'cycle' | 'duplicate-pass' | 'unknown-target',
  ) {
    super(message);
    this.name = 'RenderGraphError';
  }
}

interface TargetDecl {
  name: string;
  descriptor: (viewport: Viewport) => RenderTargetDescriptor;
}

export interface RenderGraphExecuteArgs {
  services: RenderServices;
  frame: FrameInfo;
  viewport: Viewport;
  scene: FrameScene;
}

export class RenderGraph {
  private readonly passes: RenderPass[] = [];
  private readonly targets = new Map<string, TargetDecl>();
  private compiled: RenderPass[] | null = null;

  invalidate(): void {
    this.compiled = null;
  }

  addPass(pass: RenderPass): this {
    if (this.passes.some((p) => p.name === pass.name)) {
      throw new RenderGraphError(`Duplicate pass "${pass.name}"`, 'duplicate-pass');
    }
    this.passes.push(pass);
    this.compiled = null;
    return this;
  }

  removePass(name: string): boolean {
    const i = this.passes.findIndex((p) => p.name === name);
    if (i < 0) return false;
    this.passes.splice(i, 1);
    this.compiled = null;
    return true;
  }

  getPass(name: string): RenderPass | undefined {
    return this.passes.find((p) => p.name === name);
  }

  /** Declare a transient render target the graph allocates per frame. */
  declareTarget(name: string, descriptor: (viewport: Viewport) => RenderTargetDescriptor): this {
    this.targets.set(name, { name, descriptor });
    return this;
  }

  /** Compute (and cache) execution order. Throws on a dependency cycle. */
  compile(): readonly RenderPass[] {
    if (this.compiled) return this.compiled;

    const active = this.passes.filter((p) => p.enabled);
    const byName = new Map(active.map((p) => [p.name, p]));

    // Producers of each resource name.
    const producers = new Map<string, string[]>();
    for (const p of active) {
      for (const w of p.writes) {
        const list = producers.get(w) ?? [];
        list.push(p.name);
        producers.set(w, list);
      }
    }

    // Build dependency edges: dep -> dependents (adjacency) + in-degree.
    const adj = new Map<string, Set<string>>(active.map((p) => [p.name, new Set<string>()]));
    const indeg = new Map<string, number>(active.map((p) => [p.name, 0]));
    const link = (fromName: string, toName: string) => {
      if (fromName === toName) return;
      const set = adj.get(fromName)!;
      if (!set.has(toName)) {
        set.add(toName);
        indeg.set(toName, (indeg.get(toName) ?? 0) + 1);
      }
    };

    for (const p of active) {
      for (const r of p.reads) {
        for (const prod of producers.get(r) ?? []) link(prod, p.name);
      }
      for (const a of p.after) {
        if (byName.has(a)) link(a, p.name);
      }
    }

    // Kahn's algorithm. Ties break by insertion order for determinism.
    const order = active.map((p) => p.name);
    const ready = order.filter((n) => (indeg.get(n) ?? 0) === 0);
    const result: RenderPass[] = [];
    while (ready.length > 0) {
      const name = ready.shift()!;
      result.push(byName.get(name)!);
      for (const next of adj.get(name)!) {
        const d = (indeg.get(next) ?? 0) - 1;
        indeg.set(next, d);
        if (d === 0) ready.push(next);
      }
    }

    if (result.length !== active.length) {
      const stuck = active.filter((p) => !result.includes(p)).map((p) => p.name);
      throw new RenderGraphError(`Cycle in render graph among: ${stuck.join(', ')}`, 'cycle');
    }

    this.compiled = result;
    return result;
  }

  /** Allocate declared transient targets for this frame (deduped by name+size). */
  private resolveTargets(
    backend: RenderBackend,
    resources: ResourceManager,
    viewport: Viewport,
    colorFormat: import('../gpu/types').TextureFormat,
  ): Map<string, RenderTargetHandle> {
    // Kill switch for the higher-precision intermediate targets. Float
    // compositing cannot be pixel-validated under a software rasteriser
    // (SwiftShader in CI), so keep a one-line rollback here. When false — or
    // when the backend cannot render float — every target uses the surface
    // format, exactly as before this change.
    const HDR_INTERMEDIATES = true;
    const map = new Map<string, RenderTargetHandle>();
    const { width, height } = viewport.pixelSize;
    for (const decl of this.targets.values()) {
      const desc = decl.descriptor(viewport);
      // A target opts into float precision by declaring `rgba16float`; anything
      // else (matte/mask coverage buffers) shares the surface format as before.
      const useFloat =
        desc.format === 'rgba16float' && HDR_INTERMEDIATES && backend.capabilities.float16Textures;
      desc.format = useFloat ? 'rgba16float' : colorFormat;
      const handle = resources.renderTarget(`graph-target:${decl.name}:${width}x${height}`, desc);
      map.set(decl.name, handle);
    }
    return map;
  }

  execute(args: RenderGraphExecuteArgs): void {
    const order = this.compile();
    const targetMap = this.resolveTargets(
      args.services.backend,
      args.services.resources,
      args.viewport,
      args.services.colorFormat,
    );

    const ctx: RenderPassContext = {
      services: args.services,
      frame: args.frame,
      viewport: args.viewport,
      scene: args.scene,
      target: (name) => {
        if (name === SURFACE) return null;
        const t = targetMap.get(name);
        if (!t) throw new RenderGraphError(`Unknown render target "${name}"`, 'unknown-target');
        return t;
      },
    };

    for (const pass of order) {
      args.services.commands.clear();
      pass.execute(ctx);
    }
  }

  get passNames(): string[] {
    return this.passes.map((p) => p.name);
  }
}
