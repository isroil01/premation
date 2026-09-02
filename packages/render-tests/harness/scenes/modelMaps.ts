/**
 * Imported glTF materials: the maps beyond base colour.
 *
 * ── What is actually at risk ────────────────────────────────────────────────
 *
 * A normal / metallic-roughness / occlusion / emissive map has to survive five
 * hand-offs before it can move a pixel: the parser has to read the slot, the
 * mesh registry has to mint a URL for its image, `buildSnapshot` has to hang it
 * on the mesh carrier, the adapter has to turn it into a texture key, and the
 * composition pass has to bind it to the right slot of a DIFFERENT pipeline
 * from the one every other mesh uses. Every one of those hand-offs fails
 * silently: a map that never arrives is simply the white fallback, and white is
 * the identity for three of the four. The model still renders, still shades,
 * still looks like a model. Only a golden notices.
 *
 * ── Why a pair ──────────────────────────────────────────────────────────────
 *
 * `model-maps-off` is the same geometry, the same base-colour texture, the same
 * lights and the same camera, with the four slots removed from the material.
 * It is a golden in its own right — a model without maps must keep compiling
 * `mesh3d-textured`, the shader it used before this feature existed — and it is
 * the control that makes the mapped frame legible: everything that differs
 * between the two frames is the map set and nothing else.
 *
 * The subject is a flat quad rather than a solid on purpose. Normal mapping is
 * the one map whose whole job is to make a FLAT surface shade as if it were
 * not, so a flat subject is where the map's effect cannot be confused with
 * geometry the mesh already had — and the tangent frame the shader derives from
 * screen-space derivatives has nowhere to hide.
 *
 * ── The recorded WebGPU ceiling ─────────────────────────────────────────────
 *
 * `model-maps#0` carries an entry in `webgpu-baseline.json` (~5.1%). Unlike the
 * other entries there it is DIAGNOSED, so here is the diagnosis rather than a
 * shrug:
 *
 * The shader reconstructs its tangent frame from `dpdx`/`dpdy` of position and
 * UV. Those are quad-granularity finite differences, and SwiftShader's GL
 * rasterizer and Dawn evaluate them — and the normalize/pow chain downstream —
 * at different precision. The result is a low-amplitude wash across the lit
 * surface: 99.9% of the differing pixels are within 16 levels of 255 and the
 * peak is 68, against the 154 that a genuinely MISSING map set produces. Every
 * map is present and correctly placed on both backends.
 *
 * `model-maps-off` is the control that proves it: no normal map means no call
 * to `perturbNormal`, no derivatives, and no cross-backend divergence at all.
 * If that twin ever starts diverging, the cause is NOT this and the entry
 * should not be widened to cover it.
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { buildMappedModelGlb } from '../fixtures/mappedModelGlb';
import {
  MODEL_COMPONENT,
  modelKeyForBytes,
  modelPrimitiveFor,
  registerModel,
} from '@core/scene/modelMesh';

const COMP = { width: 480, height: 360, background: '#0c0c12' };
const CENTER = { x: 240, y: 180 };

/**
 * Register the fixture and add its single primitive as a model layer.
 *
 * This is what the importer produces, minus the nulls: a leaf whose Transform
 * carries the 3D props and Material Options, and whose `Model` component points
 * the snapshot at the registry entry. `src` is the base-colour object URL the
 * registry just minted — the same value `modelHydrate` writes on reload.
 *
 * Scaled up to 130 px per glTF unit so the 8×8 maps land at roughly 32 device
 * px per texel: big enough that a wrong map is unmistakable, small enough that
 * the whole quad stays clear of the frame edge.
 */
function modelLayer(graph: Parameters<Scene['build']>[0], withMaps: boolean): void {
  const glb = buildMappedModelGlb(withMaps);
  const key = modelKeyForBytes(new Uint8Array(glb));
  registerModel(key, glb);
  const entry = modelPrimitiveFor({ modelKey: key, mesh: 0, prim: 0 });
  graph.addNode(node('panel', {
    kind: 'image',
    position: CENTER,
    transform: {
      width: 260,
      height: 260,
      z: 0,
      // Yawed and pitched a little so the specular lobe sits on the surface
      // rather than straight back at the camera — a head-on quad would hide a
      // roughness map's whole effect behind a single highlight.
      rotationY: -22,
      rotationX: 14,
      scaleX: 130,
      scaleY: 130,
      scaleZ: 130,
      acceptsLights: true,
      shadingModel: 'pbr',
      // The file's own factors, exactly as the importer writes them. Both are
      // 1 in the fixture, so the MAP is the only thing that can vary metal or
      // roughness across the surface — which is the point.
      metal: 100,
      roughness: 100,
      specular: 40,
      ...(entry?.textureUrl ? { src: entry.textureUrl } : {}),
    },
    style: { opacity: 100 },
    components: [{
      id: 'panel_model',
      type: MODEL_COMPONENT,
      props: { modelKey: key, mesh: 0, prim: 0 },
    }],
  }));
}

function scene(id: string, description: string, withMaps: boolean): Scene {
  return defineScene({
    id,
    description,
    size: { w: 480, h: 360 },
    comp: COMP,
    fps: 30,
    frames: [0],
    gpuParity: 'expect-pass',
    // No Canvas2D backend ever drew a depth-tested lit mesh, so there is no
    // oracle to compare against — the GPU is the reference, exactly as for the
    // extrusion and primitive families.
    oracle: 'gpu',
    build: (graph) => {
      modelLayer(graph, withMaps);
      // Key light off to the upper left and well in front: a normal map only
      // shows up under a light that is OFF-AXIS, because a head-on light makes
      // every tilted texel equally bright.
      graph.addNode(node('key', {
        kind: 'light',
        position: { x: 90, y: 60 },
        transform: { z: -420, intensity: 90, radius: 900, lightType: 'point' },
        style: { fill: '#fff2d8' },
      }));
      // A dim ambient, so the occlusion map has something to occlude — AO
      // multiplies ambient only, and with no ambient light in the scene it
      // would be a correctly-implemented no-op.
      graph.addNode(node('amb', {
        kind: 'light',
        position: CENTER,
        transform: { intensity: 22, lightType: 'ambient' },
        style: { fill: '#8fa8c0' },
      }));
      graph.addNode(node('cam', {
        kind: 'camera',
        position: CENTER,
        transform: { z: -1000, focalLength: 1000 },
      }));
    },
  });
}

export const modelMapScenes: Scene[] = [
  scene(
    'model-maps',
    'Imported glTF material with normal, metallic-roughness, occlusion and emissive maps '
    + 'on the depth-tested lit mesh path.',
    true,
  ),
  scene(
    'model-maps-off',
    'The same model and lighting with only a base-colour texture — the control, and the '
    + 'pin that an unmapped model keeps the narrow mesh shader.',
    false,
  ),
];
