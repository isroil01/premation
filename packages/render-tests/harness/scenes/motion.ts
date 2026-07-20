/**
 * Motion family: motion blur and echo — both need an animated subject, sampled
 * mid-motion (t=1) so the blur/ghosts are present in the still.
 */

import { defineScene, node, type Scene } from '../sceneKit';
import type { AnimationEngine } from '@motion/animation';

const COMP = { width: 360, height: 240, background: '#0c0c12' };
const SIZE = { w: 360, h: 240 };

/** A shape that sweeps left→right over 2s; sampled at t=1 (mid-sweep). */
function mover(graph: Parameters<Scene['build']>[0], anim: AnimationEngine): void {
  graph.addNode(node('mover', {
    kind: 'shape',
    position: { x: 60, y: 120 },
    transform: { width: 90, height: 90, shapeType: 'ellipse' },
    style: { fill: '#ffca3a' },
  }));
  anim.setKeyframe('mover', 'x', 0, 60);
  anim.setKeyframe('mover', 'x', 2, 300);
}

export const motionScenes: Scene[] = [
  defineScene({
    id: 'motion-blur',
    // NB: Canvas2D disables motion blur by product requirement (capabilities.ts),
    // so the oracle reference is a SHARP sweep — the GPU-parity diff is the point.
    description: 'Motion-blur sweep (shutter 180°, 8 samples) — Canvas2D renders it sharp.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [30],

    motionBlur: { enabled: true, fps: 30, shutterAngle: 180, shutterPhase: -90, samples: 8, adaptiveSampleLimit: 128 },
    build(graph, anim) {
      mover(graph, anim);
      graph.setMotionBlur('mover', true);
    },
  }),

  defineScene({
    id: 'effect-echo',
    description: 'Echo effect (decaying ghosts) on a moving subject, sampled at t=1.',
    size: SIZE,
    comp: COMP,
    fps: 30,
    frames: [30],

    build(graph, anim) {
      mover(graph, anim);
      graph.setEffects('mover', [
        { id: 'e1', type: 'echo', params: { echoTime: -0.06, numEchoes: 6, startIntensity: 85, decay: 65 } },
      ]);
    },
  }),
];
