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
import { primeHeightField, type HeightField } from '@core/scene/heightDisplacement';
import { BUMPS_PNG_DATA_URL } from './bumpsField.data';

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

/**
 * A procedural height field for the displacement golden. Bumps: 6 × 4 sine
 * cells, 50 % grey mean, so half the surface rises and half sinks. The
 * document carries it as an 8-bit grey PNG data: URL (`BUMPS_PNG_DATA_URL`,
 * the same bytes rounded here), so the C++ engine decodes it from the
 * document; the page's cache is primed with the decoded values under that
 * key so the frame needs no asynchronous image decode.
 */
function bumpsField(): HeightField {
  const w = 64; const h = 64;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 0.5 + 0.5 * Math.sin((x / w) * Math.PI * 2 * 6) * Math.sin((y / h) * Math.PI * 2 * 4);
      // decode(): Rec.709 luma of a grey byte, opaque.
      const b = Math.round(v * 255);
      data[y * w + x] = (0.2126 * b + 0.7152 * b + 0.0722 * b) / 255;
    }
  }
  return { width: w, height: h, data };
}

export const primitiveScenes: Scene[] = [
  /*
    Height displacement (B1, 2026-09-09): a lit UV sphere pushed along its
    normals by a primed bump field after one round of subdivision. The
    relief is the point: the terminator breaks into a bumpy silhouette and
    the recomputed normals light every bump on the lit side. An undisplaced
    sphere — the field missing, the amount ignored, the normals stale — is a
    visibly different picture.
  */
  defineScene({
    id: 'primitive-displaced-sphere',
    description: 'UV sphere with a primed bump height field displacing it along its normals (one subdivision, recomputed normals).',
    size: { w: 480, h: 360 },
    comp: COMP,
    fps: 30,
    frames: [0],
    gpuParity: 'expect-pass',
    build: (graph) => {
      primeHeightField(BUMPS_PNG_DATA_URL, bumpsField());
      graph.addNode(primitive(
        'bumpy',
        { x: 240, y: 180 },
        { z: 0, rotationX: 10, rotationY: 20, heightMapSrc: BUMPS_PNG_DATA_URL, displacement: 22, displacementSubdiv: 1 },
        { type: 'sphere', radius: 96, radialSegments: 36, heightSegments: 18 },
        '#c9a05a',
      ));
      graph.addNode(node('key', {
        kind: 'light',
        position: { x: 120, y: 70 },
        transform: { z: -150, intensity: 110, radius: 460, lightType: 'point' },
        style: { fill: '#fff2d8' },
      }));
    },
  }),
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
