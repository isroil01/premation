/**
 * Parametric primitives: generated meshes, lit per fragment.
 *
 * The 3D family above this covers PLANES in space and the extrusion family
 * covers solids swept from a 2D outline. Neither can produce the surfaces this
 * one is about — a sphere swept from a circle is a capsule, and a torus has a
 * hole through an axis the sweep does not have — so a regression in
 * `core/geometry/primitiveMesh.ts` or in the `Primitive` component's route
 * through buildSnapshot would not move a single existing golden pixel.
 *
 * ONE scene, deliberately, and it carries both shapes: what is worth pinning
 * here is that generated geometry reaches the mesh carrier at all and shades
 * as a curve (a smooth terminator across the sphere, a self-occluding ring on
 * the torus), not the per-parameter arithmetic — that is `primitiveMesh.test.ts`,
 * which checks it exactly instead of at 0.5% of pixels.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 480, height: 360, background: '#0c0c12' };

/** A mesh primitive layer: the Transform's 3D props plus its parameters. */
function primitive(
  id: string,
  position: { x: number; y: number },
  transform: Record<string, unknown>,
  spec: Record<string, unknown>,
  fill: string,
) {
  return node(id, {
    kind: 'shape',
    position,
    transform: { width: 160, height: 160, acceptsLights: true, ...transform },
    style: { fill },
    components: [{ id: `${id}_prim`, type: 'Primitive', props: spec }],
  });
}

export const primitiveScenes: Scene[] = [
  defineScene({
    id: 'primitive-sphere-torus',
    description:
      'Generated meshes: a lit UV sphere beside a torus tilted into perspective. '
      + 'Pins that a `Primitive` component reaches the mesh carrier and shades per '
      + 'fragment off its own smooth normals.',
    size: { w: 480, h: 360 },
    comp: COMP,
    fps: 30,
    frames: [0],
    gpuParity: 'expect-pass',
    build: (graph) => {
      // Sphere: the shape the old "3D Sphere" could not be. Its terminator is
      // the whole point — a faceted ball or a flat quad both fail here.
      graph.addNode(primitive(
        'sphere',
        { x: 150, y: 190 },
        { z: 0, rotationX: 0, rotationY: 0 },
        { type: 'sphere', radius: 72, radialSegments: 40, heightSegments: 20 },
        '#cf6a4a',
      ));
      // Torus, tilted so the ring passes in front of itself — which only reads
      // correctly if the mesh is depth-tested against itself.
      graph.addNode(primitive(
        'torus',
        { x: 335, y: 185 },
        { z: 0, rotationX: 58, rotationY: 14 },
        { type: 'torus', radius: 76, tube: 26, radialSegments: 56, heightSegments: 20 },
        '#4a86cf',
      ));
      // Key light off to the upper left, in front of both objects.
      graph.addNode(node('key', {
        kind: 'light',
        position: { x: 120, y: 70 },
        transform: { z: -150, intensity: 110, radius: 460, lightType: 'point' },
        style: { fill: '#fff2d8' },
      }));
      graph.addNode(node('cam', {
        kind: 'camera',
        position: { x: 240, y: 180 },
        transform: { z: -1000, focalLength: 1000 },
      }));
    },
  }),
];

export default primitiveScenes;
