/** Schema enum member lists the local engine validates against (00_core.eapi, 40_layers.eapi). */

import type { BlendMode, LayerKind } from '@motion/engine-api';

export const BLEND_MODES: readonly BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity',
  'add', 'linear-burn', 'linear-dodge', 'linear-light', 'vivid-light', 'pin-light',
  'hard-mix', 'subtract', 'divide', 'dissolve', 'darker-color', 'lighter-color',
  'stencil-alpha', 'stencil-luma', 'silhouette-alpha', 'silhouette-luma', 'alpha-add',
  'luminescent-premul', 'classic-color-dodge', 'classic-color-burn', 'classic-difference', 'dancing-dissolve',
];

export const LAYER_KINDS: readonly LayerKind[] = [
  'null', 'solid', 'shape', 'rectangle', 'ellipse', 'polygon', 'path', 'text',
  'image', 'video', 'audio', 'svg', 'precomp', 'camera', 'light', 'group',
  'component', 'particle', 'model3d', 'generator', 'adjustment', 'sequence',
];
