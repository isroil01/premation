/**
 * The Continuous Rasterization switch: where it is offered and how it persists.
 */

import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import {
  CONTINUOUS_RASTER_PROP,
  readContinuousRaster,
  supportsContinuousRaster,
} from './continuousRaster';
import type { SceneNode } from '@core/types';

function node(id: string, kind: string, props: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 960, y: 540 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: kind, x: 960, y: 540, width: 100, height: 100, scaleX: 1, scaleY: 1, opacity: 100, ...props },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as unknown as SceneNode;
}

const TRIANGLE = [
  { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
  { x: 100, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
  { x: 50, y: 100, inX: 0, inY: 0, outX: 0, outY: 0 },
];

describe('where the switch is offered', () => {
  it('text and SVG always qualify', () => {
    expect(supportsContinuousRaster(node('t', 'text'))).toBe(true);
    expect(supportsContinuousRaster(node('s', 'svg'))).toBe(true);
  });

  it('a shape with real geometry qualifies', () => {
    expect(supportsContinuousRaster(node('p', 'shape', { pathPoints: TRIANGLE }))).toBe(true);
    expect(supportsContinuousRaster(node('r', 'shape', { cornerRadius: 12 }))).toBe(true);
    expect(supportsContinuousRaster(node('e', 'shape', { shapeType: 'ellipse' }))).toBe(true);
    expect(supportsContinuousRaster(node('k', 'shape', { strokeWidth: 3 }))).toBe(true);
  });

  it('a FLAT rect does not — its edges are the quad, already crisp at any scale', () => {
    expect(supportsContinuousRaster(node('flat', 'shape'))).toBe(false);
  });

  it('bitmaps do not — no scale invents detail the file never had', () => {
    expect(supportsContinuousRaster(node('i', 'image'))).toBe(false);
    expect(supportsContinuousRaster(node('v', 'video'))).toBe(false);
  });

  it('a missing node is not a crash', () => {
    expect(supportsContinuousRaster(undefined)).toBe(false);
  });
});

describe('the prop', () => {
  it('reads false when absent — every existing project', () => {
    expect(readContinuousRaster(node('t', 'text'))).toBe(false);
  });

  it('reads true only for a literal true, not any truthy value', () => {
    expect(readContinuousRaster(node('t', 'text', { [CONTINUOUS_RASTER_PROP]: true }))).toBe(true);
    expect(readContinuousRaster(node('t', 'text', { [CONTINUOUS_RASTER_PROP]: 1 }))).toBe(false);
    expect(readContinuousRaster(node('t', 'text', { [CONTINUOUS_RASTER_PROP]: 'true' }))).toBe(false);
  });
});
