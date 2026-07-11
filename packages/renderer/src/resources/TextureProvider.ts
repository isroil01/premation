/**
 * Resolves a renderable's `textureKey` to a GPU texture + sampler. The app
 * supplies a real provider (image decode, video frames, atlases); the default
 * provider hands back a shared 1×1 white texture so image/text passes run in
 * tests and before assets load.
 */

import type { Rect } from '../core/math/geometry';
import type { ResourceManager } from '../gpu/ResourceManager';
import type { SamplerHandle, TextureHandle } from '../gpu/types';

export interface ResolvedTexture {
  texture: TextureHandle;
  sampler: SamplerHandle;
  /** Sub-rect in uv space [0,1]; defaults to the full texture. */
  uv?: Rect;
  /** Whether the texture is ready (video frames may be pending). */
  ready: boolean;
}

export interface TextureProvider {
  get(key: string): ResolvedTexture | null;
}

const WHITE_PIXEL = new Uint8Array([255, 255, 255, 255]);

/** Fallback provider: every key resolves to a shared white texel. */
export class DefaultTextureProvider implements TextureProvider {
  constructor(private readonly resources: ResourceManager) {}

  get(_key: string): ResolvedTexture {
    const texture = this.resources.texture(
      'texture:white',
      { label: 'white', width: 1, height: 1, format: 'rgba8unorm' },
      /* pinned */ true,
    );
    // NullBackend ignores writes; real backends upload the texel.
    const sampler = this.resources.sampler(
      'sampler:linear-clamp',
      { label: 'linear-clamp', min: 'linear', mag: 'linear', addressU: 'clamp', addressV: 'clamp' },
      true,
    );
    return { texture, sampler, ready: true };
  }

  /** The raw white-texel bytes, for backends that want to seed the texture. */
  static get whitePixel(): Uint8Array {
    return WHITE_PIXEL;
  }
}
