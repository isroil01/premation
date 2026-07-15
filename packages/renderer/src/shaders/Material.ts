/**
 * Material system. A material binds a shader to fixed pipeline state (blend,
 * topology, bind-group layout). `MaterialSystem.pipeline()` compiles the shader
 * (cached) and builds the pipeline (deduped via ResourceManager) — so N objects
 * sharing a material share one pipeline. Custom materials register new shaders
 * and pass their own layout.
 */

import type { ResourceManager } from '../gpu/ResourceManager';
import type {
  BindGroupLayoutEntry,
  BlendMode,
  PipelineHandle,
  PrimitiveTopology,
  TextureFormat,
} from '../gpu/types';
import { makeKey } from '../utils/ids';
import { QUAD_LAYOUT } from '../resources/Geometry';
import type { ShaderCache } from './ShaderCache';
import type { ShaderRegistry } from './ShaderRegistry';

export interface MaterialDescriptor {
  /** Name of a shader in the registry. */
  shader: string;
  topology: PrimitiveTopology;
  layout: BindGroupLayoutEntry[];
}

/** Built-in material: solid-colored quad. Uniform block at binding 0. */
export const SOLID_MATERIAL: MaterialDescriptor = {
  shader: 'solid',
  topology: 'triangle-list',
  layout: [{ binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] }],
};

/** Built-in material: textured quad. Uniform + texture + sampler. */
export const TEXTURED_MATERIAL: MaterialDescriptor = {
  shader: 'textured',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

/** Built-in material: masked textured quad. Uniform + texture + sampler + mask texture. */
export const MASKED_TEXTURED_MATERIAL: MaterialDescriptor = {
  shader: 'masked-textured',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
};

/** Built-in material: blur pass. Uniform + texture + sampler. */
export const BLUR_MATERIAL: MaterialDescriptor = {
  shader: 'blur',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export const GRADIENT_RAMP_MATERIAL: MaterialDescriptor = {
  shader: 'gradient-ramp',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export const FRACTAL_NOISE_MATERIAL: MaterialDescriptor = {
  shader: 'fractal-noise',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export const DISPLACEMENT_MAP_MATERIAL: MaterialDescriptor = {
  shader: 'displacement-map',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
    { binding: 3, type: 'texture', stages: ['fragment'] },
  ],
};

export const MOTION_TILE_MATERIAL: MaterialDescriptor = {
  shader: 'motion-tile',
  topology: 'triangle-list',
  layout: [
    { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
    { binding: 1, type: 'texture', stages: ['fragment'] },
    { binding: 2, type: 'sampler', stages: ['fragment'] },
  ],
};

export class MaterialSystem {
  constructor(
    private readonly resources: ResourceManager,
    private readonly registry: ShaderRegistry,
    private readonly shaderCache: ShaderCache,
  ) {}

  /** Get (or build) the pipeline for a material + blend + target format. */
  pipeline(material: MaterialDescriptor, blend: BlendMode, colorFormat: TextureFormat): PipelineHandle {
    const source = this.registry.require(material.shader);
    const shader = this.shaderCache.get(source);
    const key = makeKey('pipeline', material.shader, this.shaderCache.keyOf(source), material.topology, blend, colorFormat);
    return this.resources.pipeline(key, {
      label: `${material.shader}/${blend}`,
      shader,
      buffers: [QUAD_LAYOUT],
      layout: material.layout,
      topology: material.topology,
      blend,
      colorFormat,
    });
  }
}
