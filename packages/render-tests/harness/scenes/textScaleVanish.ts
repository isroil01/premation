/**
 * Reported: add text with the Text tool, scale it up, and it VANISHES somewhere
 * past ~2x. These scenes render one identical text layer at a ladder of layer
 * scales so the PNGs answer it directly: if the glyphs are present at 1x and
 * absent at 4x, the layer is being dropped rather than going soft.
 *
 * Deliberately uses the DEFAULT text spec the Text tool creates (fontSize 32,
 * content 'Text', no authored width/height) — a text layer's box is MEASURED,
 * and an invented width/height would test a shape the tool never produces.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const COMP = { width: 480, height: 200, background: '#0c0c12' };
const SIZE = { w: 480, h: 200 };

function scaledText(id: string, scale: number) {
  return node(id, {
    kind: 'text',
    position: { x: 240, y: 100 },
    transform: { scaleX: scale, scaleY: scale },
    components: [
      {
        id: `${id}_c`,
        type: 'Text',
        props: {
          content: 'Text',
          fontSize: 32,
          opacity: 100,
          fontFamily: 'Arial',
          align: 'center',
          fill: '#f4f4f8',
        },
      },
    ],
  });
}

const scene = (id: string, description: string, scale: number): Scene =>
  defineScene({
    id,
    description,
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [0],
    gpuParity: 'expect-pass',
    build: (graph) => {
      graph.addNode(scaledText('t', scale));
    },
  });

export const textScaleVanishScenes: Scene[] = [
  scene('text-scale-1x', 'Default text layer at 100%.', 1),
  scene('text-scale-2x', 'Same layer at 200% — the reported threshold.', 2),
  scene('text-scale-4x', 'Same layer at 400%.', 4),
  scene('text-scale-8x', 'Same layer at 800%.', 8),
];

/** Same visual size as fontSize 64 at 1x, reached via scale — so the glyphs
 *  comfortably FIT the frame and "vanished" cannot mean "off-screen". */
function smallText(id: string, fontSize: number, scale: number) {
  return node(id, {
    kind: 'text',
    position: { x: 240, y: 100 },
    transform: { scaleX: scale, scaleY: scale },
    components: [
      {
        id: `${id}_c`,
        type: 'Text',
        props: { content: 'Text', fontSize, opacity: 100, fontFamily: 'Arial', align: 'center', fill: '#f4f4f8' },
      },
    ],
  });
}

const fitScene = (id: string, description: string, fontSize: number, scale: number): Scene =>
  defineScene({
    id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], gpuParity: 'expect-pass',
    build: (graph) => { graph.addNode(smallText('t', fontSize, scale)); },
  });

export const textScaleBisectScenes: Scene[] = [
  scene('text-scale-5x', 'Bisect: 500%.', 5),
  scene('text-scale-6x', 'Bisect: 600%.', 6),
  scene('text-scale-7x', 'Bisect: 700%.', 7),
  // Constant on-screen size, rising scale: isolates SCALE from on-screen size.
  fitScene('text-fit-8x', 'font 8 at 800% — same ink as font 64 at 100%.', 8, 8),
  fitScene('text-fit-16x', 'font 4 at 1600% — same ink again.', 4, 16),
  fitScene('text-fit-1x', 'font 64 at 100% — the control for both above.', 64, 1),
];
