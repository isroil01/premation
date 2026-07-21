/**
 * 3D family: perspective layers, camera, light types, depth of field.
 * A layer becomes 3D when it carries z / rotationX / rotationY on its Transform.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 480, height: 360, background: '#0c0c12' };
const SIZE = { w: 480, h: 360 };
const CENTER = { x: 240, y: 180 };

function scene(id: string, description: string, build: Scene['build'], gpuParity: Scene['gpuParity'] = 'expect-pass'): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], gpuParity, build });
}

/** A large flat panel used as a 3D surface. */
function panel(graph: Parameters<Scene['build']>[0], id: string, extraTransform: Record<string, unknown>, fill = '#4a7fd0') {
  graph.addNode(node(id, { kind: 'shape', position: CENTER, transform: { width: 240, height: 180, shapeType: 'rect', ...extraTransform }, style: { fill } }));
}

function light(graph: Parameters<Scene['build']>[0], id: string, props: Record<string, unknown>, color: string) {
  graph.addNode(node(id, { kind: 'light', position: CENTER, transform: props, style: { fill: color } }));
}

export const threeDScenes: Scene[] = [
  scene('three-d-rotated', 'Layer rotated in 3D (rotationY) — perspective foreshortening.', (graph) => {
    panel(graph, 'p', { z: 0, rotationY: 45 });
  }),

  scene('three-d-camera', 'Camera with focal length viewing a rotated 3D layer.', (graph) => {
    panel(graph, 'p', { z: 120, rotationY: 35, rotationX: 15 });
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { z: -1000, focalLength: 1000 } }));
  }),

  scene('three-d-dof', 'Depth of field: near panel sharp, far panel blurred.', (graph) => {
    panel(graph, 'far', { z: 600 }, '#d05a7f');
    panel(graph, 'near', { z: 0 }, '#4ad0a0');
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { z: -1000, focalLength: 1000, dofStrength: 24, focusDistance: 1000, dofAperture: 40 } }));
  }),

  // The original three-d-dof's far panel is fully occluded by the near one
  // (perspective shrinks it behind the sharp panel), so its blur never reaches
  // a visible pixel. Here the far panel is offset so its blurred edges show.
  // No committed reference yet — bless with `--update three-d-dof-visible`
  // after a human confirms the far panel is actually blurred.
  scene('three-d-dof-visible', 'Depth of field with the far (blurred) panel visibly offset.', (graph) => {
    graph.addNode(node('far', { kind: 'shape', position: { x: 120, y: 100 }, transform: { width: 240, height: 180, shapeType: 'rect', z: 600 }, style: { fill: '#d05a7f' } }));
    graph.addNode(node('near', { kind: 'shape', position: { x: 330, y: 250 }, transform: { width: 180, height: 130, shapeType: 'rect', z: 0 }, style: { fill: '#4ad0a0' } }));
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { z: -1000, focalLength: 1000, dofStrength: 24, focusDistance: 1000, dofAperture: 40 } }));
  }, 'known-divergent'),

  scene('light-point', 'Point light on a 3D panel.', (graph) => {
    panel(graph, 'p', { z: 0, rotationX: 10 }, '#c9c9d6');
    light(graph, 'L', { z: -200, intensity: 90, radius: 320, lightType: 'point' }, '#ffcc55');
  }),

  scene('light-spot', 'Spot light on a 3D panel.', (graph) => {
    panel(graph, 'p', { z: 0 }, '#c9c9d6');
    light(graph, 'L', { z: -300, intensity: 100, radius: 400, lightType: 'spot', lightAngle: 90, lightCone: 32 }, '#88d0ff');
  }, 'known-divergent'),

  scene('light-ambient', 'Ambient light tint on a 3D panel.', (graph) => {
    panel(graph, 'p', { z: 0, rotationX: 5 }, '#9098b0');
    light(graph, 'L', { intensity: 70, lightType: 'ambient' }, '#ff88aa');
  }, 'known-divergent'),

  // 2.5D light-cast shadow: a shadow-casting point light above-left of a small
  // panel throws a soft drop-shadow down-right (away from the light). No
  // committed reference yet — bless with `--update light-cast-shadow` after a
  // human eyeballs the shadow. Exercises buildSnapshot's cast-shadow → GPU
  // drop-shadow effect path (previously CSS-filter-only, i.e. rendered nothing).
  scene('light-cast-shadow', 'Point light with castShadows throws a drop-shadow off a panel.', (graph) => {
    // Bright backdrop (castsShadows: false) so the 45%-black shadow is plainly
    // visible — over the default near-black comp bg it vanished under the glow.
    graph.addNode(node('bg', { kind: 'shape', position: CENTER, transform: { width: 480, height: 360, shapeType: 'rect', castsShadows: false }, style: { fill: '#c8ccd8' } }));
    graph.addNode(node('p', { kind: 'shape', position: { x: 260, y: 200 }, transform: { width: 140, height: 100, shapeType: 'rect' }, style: { fill: '#4ad0a0' } }));
    light(graph, 'L', { z: -200, intensity: 100, radius: 320, lightType: 'point', castShadows: true }, '#ffcc55');
  }, 'known-divergent'),
];
