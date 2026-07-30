/**
 * Glass layer style.
 *
 * The GPU is necessarily the oracle here: glass is a function of what is
 * composited BENEATH the layer, and the Canvas2D reference rasterizer has no
 * way to sample that — it draws layers in isolation. That is the same
 * constraint that forces After Effects to fake refraction with displacement
 * maps, and the reason our version can be one layer style instead of a stack of
 * a dozen effects.
 *
 * The subject in every scene is a strongly patterned backdrop, not a flat
 * colour. Glass over a flat fill is indistinguishable from a tinted rectangle —
 * the blur has nothing to smear, the refraction has nothing to bend, and the
 * chromatic aberration has no edges to split. A scene that cannot fail is not
 * a test.
 */

import { defineScene, node, type Scene } from '../sceneKit';
import type { GlassStyle } from '@core/effects/layerStyles';

const COMP = { width: 320, height: 220, background: '#0b0b12' };
const SIZE = { w: 320, h: 220 };

/** A busy backdrop: hard colour boundaries and thin stripes, so blur,
 *  displacement and per-channel offset all have something to act on. */
function backdrop(graph: Parameters<Scene['build']>[0]): void {
  graph.addNode(node('bg', {
    kind: 'shape',
    position: { x: 160, y: 110 },
    transform: { width: 320, height: 220 },
    style: { fill: '#000' },
  }));
  graph.setFill('bg', {
    type: 'linear',
    angle: 35,
    stops: [
      { id: 'a', offset: 0, color: '#ff2d55' },
      { id: 'b', offset: 0.5, color: '#ffd60a' },
      { id: 'c', offset: 1, color: '#0a84ff' },
    ],
  } as never);

  // Hard-edged bars over the ramp. The blur has to soften these and the
  // refraction has to bend them, so both are visible in a still frame.
  const bars = [
    { id: 'bar1', x: 60, fill: '#0b0b12' },
    { id: 'bar2', x: 160, fill: '#ffffff' },
    { id: 'bar3', x: 260, fill: '#0b0b12' },
  ];
  for (const b of bars) {
    graph.addNode(node(b.id, {
      kind: 'shape',
      position: { x: b.x, y: 110 },
      transform: { width: 26, height: 220 },
      style: { fill: b.fill },
    }));
  }
}

/** The glass panel itself. Layer styles live on an `fx` component, which is
 *  exactly where `readNodeLayerStyles` looks for them. */
function panel(
  graph: Parameters<Scene['build']>[0],
  glass: Partial<GlassStyle>,
): void {
  graph.addNode(node('panel', {
    kind: 'shape',
    position: { x: 160, y: 110 },
    transform: { width: 220, height: 130, cornerRadius: 28 },
    style: { fill: '#ffffff', opacity: 100 },
    components: [
      {
        id: 'panel_fx',
        type: 'fx',
        props: {
          layerStyles: {
            glass: {
              enabled: true,
              blur: 20,
              saturation: 1.8,
              tintColor: '#ffffff',
              tintOpacity: 0.08,
              refraction: 28,
              edgeWidth: 3,
              chromaticAberration: 6,
              rimColor: '#ffffff',
              rimOpacity: 0.35,
              rimWidth: 6,
              rimAngle: 315,
              useGlobalLight: false,
              specularAngle: 315,
              specularIntensity: 0.25,
              specularFalloff: 8,
              grain: 0,
              ...glass,
            } satisfies GlassStyle,
          },
        },
      },
    ],
  }));
}

function glassScene(id: string, description: string, glass: Partial<GlassStyle>): Scene {
  return defineScene({
    id,
    description,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    // Canvas2D cannot sample the backdrop, so it renders the panel as a plain
    // white card — not a meaningful comparison. GPU is the oracle and every
    // bless is eyeballed.
    oracle: 'gpu',
    gpuParity: 'known-divergent',
    divergence: {
      why:
        'Glass is a function of what is composited BENEATH the layer, and the deleted Canvas2D '
        + 'reference had no way to sample that — it drew layers in isolation, so it rendered the '
        + 'panel as a plain white card. That is the same constraint that forces After Effects to '
        + 'fake refraction with displacement maps. The scene is its own oracle (oracle: gpu) and '
        + 'its committed reference is GPU output; the parity number compares against a baseline '
        + 'that structurally cannot express the feature.',
      wouldMatchWhen:
        'Never against Canvas2D — the comparison is meaningless for a backdrop-sampling effect. '
        + 'This entry should be removed when the parity dashboard stops comparing oracle:gpu '
        + 'scenes against the Canvas2D baseline at all.',
    },
    build(graph) {
      backdrop(graph);
      panel(graph, glass);
    },
  });
}

export const glassScenes: Scene[] = [
  glassScene(
    'glass-frosted',
    'Glass panel over a patterned backdrop: blur, vibrancy, tint, rim and specular.',
    {},
  ),
  glassScene(
    'glass-clear',
    'Clear glass — blur 0, so refraction and chromatic aberration are isolated and unmistakable.',
    { blur: 0, refraction: 60, edgeWidth: 8, chromaticAberration: 14, tintOpacity: 0, saturation: 1 },
  ),
  glassScene(
    'glass-heavy-frost',
    'Heavy frost with a strong tint and wide rim — the opposite end of the parameter range.',
    { blur: 48, saturation: 2.4, tintColor: '#4aa3ff', tintOpacity: 0.3, refraction: 10, rimOpacity: 0.7, rimWidth: 14 },
  ),
  glassScene(
    'glass-grain',
    'Grain at full strength, which is what stops a blurred gradient from banding.',
    { grain: 0.25, blur: 32, refraction: 0, chromaticAberration: 0, rimOpacity: 0, specularIntensity: 0 },
  ),
];

export default glassScenes;
