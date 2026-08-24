/**
 * Material Options keyframe: the resolved material takes the frame's animated
 * value over the stored one, and only for the options that have a track.
 */

import { readNodeMaterial, MATERIAL_ANIMATABLE } from './material';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const node = (): SceneNode => ({
  id: 'm', name: 'm', parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [{ id: 'm_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', ambient: 100, diffuse: 50, specular: 20, shininess: 32, castsShadows: false } }],
});

it('reads the stored values with no animation map', () => {
  const m = readNodeMaterial(node());
  expect([m.ambient, m.diffuse, m.specular, m.shininess]).toEqual([100, 50, 20, 32]);
});

it('overrides exactly the options that have a track, leaving switches static', () => {
  const av = new Map<string, number>([['ambient', 30], ['specular', 90], ['castsShadows', 1]]);
  const m = readNodeMaterial(node(), av);
  expect(m.ambient).toBe(30);
  expect(m.specular).toBe(90);
  expect(m.diffuse).toBe(50);        // no track → stored
  expect(m.castsShadows).toBe(false); // switches are never driven by a number track
});

it('clamps an animated value like a stored one', () => {
  const m = readNodeMaterial(node(), new Map([['ambient', 400], ['shininess', 0.2]]));
  expect(m.ambient).toBe(100);
  expect(m.shininess).toBe(1);
});

it('the registry and the reader agree on which options animate', async () => {
  const { resolvePropertyMeta } = await import('@core/inspector/propertyMeta');
  for (const k of MATERIAL_ANIMATABLE) {
    expect(resolvePropertyMeta(k).group).toBe('material');
    expect(resolvePropertyMeta(k).keyframeable).not.toBe(false);
  }
});

describe('shading model', () => {
  it('defaults to Phong so no existing scene changes, and PBR carries roughness', () => {
    const n = node();
    expect(readNodeMaterial(n).shading).toBe('phong');
    (n.components[0]!.props as Record<string, unknown>).shadingModel = 'pbr';
    (n.components[0]!.props as Record<string, unknown>).roughness = 20;
    const m = readNodeMaterial(n);
    expect(m.shading).toBe('pbr');
    expect(m.roughness).toBe(20);
    // Roughness keyframes like the rest of the options.
    expect(readNodeMaterial(n, new Map([['roughness', 80]])).roughness).toBe(80);
  });
});
