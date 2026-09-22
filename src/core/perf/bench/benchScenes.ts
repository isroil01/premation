/**
 * Synthetic scenes shared by the `*.bench.test.ts` suites.
 *
 * Lifted out of buildSnapshot.bench.test.ts so the raster-key bench can time
 * the same text-heavy and path-heavy layers the scene-walk bench walks. Not a
 * test file — the bench config only matches `*.bench.test.ts`.
 */

import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { COMP_REF_PROP } from '@core/scene/compInstance';

export const W = 1920;
export const H = 1080;
export const FPS = 30;

export type Kind = 'shape' | 'text' | 'group';

export function node(id: string, kind: Kind, parent: string | null, props: Record<string, unknown>, extra: SceneNode['components'] = []): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, rotation: 0, ...props } },
      ...(kind === 'group' ? [] : [{ id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } }]),
      ...extra,
    ],
  } as unknown as SceneNode;
}

export interface Scene {
  graph: SceneGraph;
  anim: AnimationEngine;
  layers: number;
  /** Extra comp fields (e.g. `compSizeOf` for sealed instances). */
  comp?: Record<string, unknown>;
}

export function animateX(anim: AnimationEngine, id: string, from: number, to: number): void {
  anim.setKeyframes(id, 'x', [
    { t: 0, value: from, easing: 'linear' },
    { t: 4, value: to, easing: 'linear' },
  ] as never);
}

export function flatShapes(n: number): Scene {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  graph.addNode(node('root', 'group', null, {}));
  for (let i = 0; i < n; i++) {
    const id = `s${i}`;
    const x = (i * 37) % W;
    graph.addChild('root', node(id, 'shape', 'root', { x, y: (i * 53) % H, width: 40, height: 40 }));
    animateX(anim, id, x, x + 200);
  }
  return { graph, anim, layers: n };
}

export function texts(n: number): Scene {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  graph.addNode(node('root', 'group', null, {}));
  for (let i = 0; i < n; i++) {
    const id = `t${i}`;
    graph.addChild('root', node(id, 'text', 'root', { x: (i * 91) % W, y: (i * 29) % H, width: 320, height: 60 }, [
      { id: `${id}_x`, type: 'Text', props: { content: `Title ${i} — the quick brown fox`, fontSize: 32, fontFamily: 'Inter' } },
    ] as never));
  }
  return { graph, anim, layers: n };
}

/** A closed four-segment bezier blob, centred on the local origin. */
export function blob(r: number): Array<{ x: number; y: number; inX: number; inY: number; outX: number; outY: number }> {
  const k = r * 0.5523;
  return [
    { x: 0, y: -r, inX: -k, inY: -r, outX: k, outY: -r },
    { x: r, y: 0, inX: r, inY: -k, outX: r, outY: k },
    { x: 0, y: r, inX: k, inY: r, outX: -k, outY: r },
    { x: -r, y: 0, inX: -r, inY: k, outX: -r, outY: -k },
  ];
}

export function animatedPaths(n: number): Scene {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  graph.addNode(node('root', 'group', null, {}));
  for (let i = 0; i < n; i++) {
    const id = `p${i}`;
    const x = (i * 61) % W;
    graph.addChild('root', node(id, 'shape', 'root', { x, y: (i * 17) % H, width: 120, height: 120 }, [
      { id: `${id}_g`, type: 'Geometry', props: { points: blob(60), open: false } },
    ] as never));
    animateX(anim, id, x, x + 300);
    anim.setKeyframes(id, 'rotation', [
      { t: 0, value: 0, easing: 'linear' },
      { t: 4, value: 360, easing: 'linear' },
    ] as never);
  }
  return { graph, anim, layers: n };
}

export function chains(total: number, depth: number): Scene {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  graph.addNode(node('root', 'group', null, {}));
  const chainCount = Math.ceil(total / depth);
  let made = 0;
  for (let c = 0; c < chainCount && made < total; c++) {
    let parent = 'root';
    for (let d = 0; d < depth && made < total; d++, made++) {
      const id = `c${c}_${d}`;
      graph.addChild(parent, node(id, 'shape', parent, { x: 4, y: 3, width: 20, height: 20 }));
      if (d === 0) animateX(anim, id, (c * 43) % W, ((c * 43) % W) + 100);
      parent = id;
    }
  }
  return { graph, anim, layers: made };
}

/**
 * 50 sealed placements of 50 different static comps, 20 layers each — the
 * "big comp of title cards" case the static sealed-precomp cache targets.
 * Every instance renders its referenced comp through its own nested pass.
 */
export function staticPrecomps(comps: number, perComp: number): Scene & { comp: Record<string, unknown> } {
  const graph = new SceneGraph();
  const anim = new AnimationEngine();
  for (let c = 0; c < comps; c++) {
    const ref = `pc${c}`;
    graph.addNode(node(ref, 'group', null, {}));
    for (let i = 0; i < perComp; i++) {
      const id = `${ref}_l${i}`;
      const isText = i % 4 === 3;
      graph.addChild(ref, node(id, isText ? 'text' : 'shape', ref, { x: 10 + (i % 5) * 36, y: 10 + Math.floor(i / 5) * 24, width: 30, height: 18 },
        isText ? [{ id: `${id}_x`, type: 'Text', props: { content: `Card ${c}.${i}`, fontSize: 14 } }] as never : []));
    }
  }
  graph.addNode(node('root', 'group', null, {}));
  for (let c = 0; c < comps; c++) {
    const id = `inst${c}`;
    graph.addChild('root', node(id, 'comp' as Kind, 'root', { x: 100 + (c % 10) * 180, y: 80 + Math.floor(c / 10) * 200 }, [
      { id: `${id}_fx`, type: 'fx', props: { precomp: true, [COMP_REF_PROP]: `pc${c}` } },
    ] as never));
    // The placements move; their contents do not.
    animateX(anim, id, 100 + (c % 10) * 180, 140 + (c % 10) * 180);
  }
  return {
    graph, anim, layers: comps * perComp,
    comp: { compSizeOf: (ref: string) => (ref.startsWith('pc') ? { width: 200, height: 120 } : undefined) },
  };
}

/**
 * `min` is what the ratchet gates. On a shared machine (other sessions'
 * jest/tsc runs, a CI runner's neighbours) even the median of 60 samples moved
 * 30–90 % between two back-to-back runs of unchanged code (measured
 * 2026-09-22); the fastest sample is the one that got the CPU to itself, and
 * a code regression raises the floor while contention does not lower it.
 */
export interface Stat { mean: number; p50: number; p95: number; min: number }

export function stats(samples: number[]): Stat {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  return { mean: samples.reduce((a, b) => a + b, 0) / samples.length, p50: at(0.5), p95: at(0.95), min: sorted[0] ?? 0 };
}
