/**
 * Text family: basic, multi-line, rich runs, per-glyph animator, text-on-path.
 *
 * Uses a widely-available font ('Arial'); glyph rasterisation is machine-font
 * dependent, so these references are valid under the "same machine + same
 * driver" determinism promise (the oracle re-render guards it).
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { ellipseMask } from '@core/effects/mask';

const COMP = { width: 480, height: 200, background: '#0c0c12' };
const SIZE = { w: 480, h: 200 };

function textNode(id: string, content: string, extraTextProps: Record<string, unknown> = {}) {
  return node(id, {
    kind: 'text',
    position: { x: 240, y: 100 },
    components: [
      {
        id: `${id}_c`,
        type: 'Text',
        props: { content, fontSize: 56, opacity: 100, fontFamily: 'Arial', align: 'center', fill: '#f4f4f8', ...extraTextProps },
      },
    ],
  });
}

function scene(id: string, description: string, build: Scene['build'], gpuParity: Scene['gpuParity'] = 'expect-pass'): Scene {
  return defineScene({ id, description, size: SIZE, comp: COMP, fps: 30, frames: [0], gpuParity, build });
}

export const textScenes: Scene[] = [
  scene('text-basic', 'Single-line centred text.', (graph) => {
    graph.addNode(textNode('t', 'Motion'));
  }),

  scene('text-multiline', 'Multi-line text with line height + paragraph spacing.', (graph) => {
    graph.addNode(textNode('t', 'Hello\nWorld', { fontSize: 44, lineHeight: 1.1, paragraphSpacing: 6 }));
  }),

  scene('text-rich-runs', 'Per-character styled runs (colour + weight spans).', (graph) => {
    graph.addNode(
      textNode('t', 'ABCDE', {
        __runs: [
          { start: 0, end: 2, style: { fill: '#ff5d73', fontWeight: '700' } },
          { start: 2, end: 5, style: { fill: '#5db4ff' } },
        ],
      }),
    );
  }),

  scene('text-glyph-animator', 'Per-glyph animator (triangle selector, vertical offset).', (graph) => {
    graph.addNode(
      textNode('t', 'BOUNCE', {
        fontSize: 52,
        __animators: [
          {
            id: 'a1', basedOn: 'characters', shape: 'triangle', start: 0, end: 100, offset: 0,
            x: 0, y: -34, scale: 120, rotation: 0, opacity: 100, tracking: 0, skew: 0, mode: 'range', wiggleFreq: 2,
          },
        ],
      }),
    );
  }, 'known-divergent'),

  scene('text-on-path', 'Text riding an ellipse mask path.', (graph) => {
    graph.addNode(textNode('t', 'ORBITING TEXT', { fontSize: 34 }));
    graph.setMask('t', { paths: [ellipseMask(360, 150)] });
    graph.setTextPath('t', { pathId: '', firstMargin: 0, reversed: false, perpendicular: true });
  }, 'known-divergent'),
];
