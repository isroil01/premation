/**
 * Block Tower — a short motion piece of geometric solids hopping onto each
 * other, stacking, then bursting into fragments.
 *
 * Not a product ad. The sophistication is in the timing: overlapping hops,
 * gravity bounces with squash, a held tower, then a shatter. Authored as
 * ordinary keyframes so every curve stays editable in the graph editor.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode, Transform } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { defaultAnimation, EASY_EASE_IN_BEZIER, EASY_EASE_OUT_BEZIER, type Keyframe } from '@motion/animation';
import { bounceTracks, bounceImpacts, squashTracks, type BounceOptions } from '@core/animation/bounce';
import { addEffect, updateEffectParam } from '@core/effects/effects';
import { setNodeMotionBlur } from '@core/effects/motionBlur';
import { setContinuousRaster } from '@core/scene/continuousRaster';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { confirmDiscardChanges } from '@core/project/confirmDiscard';
import { bezierCorner as corner } from '@motion/workspace';

export const BLOCK_TOWER = {
  name: 'Block Tower',
  width: 1080,
  height: 1920,
  fps: 60,
  duration: 16,
  background: '#efe8dc',
  floorY: 1540,
  cx: 540,
  burstAt: 9.72,
} as const;

export const BLOCK_TOWER_MAIN_IDS = ['bt_square', 'bt_circle', 'bt_triangle', 'bt_capsule', 'bt_star'] as const;
export type BlockTowerMainId = (typeof BLOCK_TOWER_MAIN_IDS)[number];

const ROOT = 'comp_root';
const SMOOTH: [number, number, number, number] = [0.4, 0, 0.2, 1];
const RUBBER: BounceOptions = { bounces: 4, decay: 0.58, elasticity: 0.32 };
const BALL: BounceOptions = { bounces: 5, decay: 0.62, elasticity: 0.4 };
const FIRM: BounceOptions = { bounces: 3, decay: 0.5, elasticity: 0.28 };

const tf = (x: number, y: number): Transform => ({
  position: { x, y }, rotation: 0, scale: { x: 1, y: 1 },
});

type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'star';

interface BlockSpec {
  id: BlockTowerMainId;
  name: string;
  kind: ShapeKind;
  fill: string;
  w: number;
  h: number;
  radius?: number;
  /** Horizontal rest offset from centre — the tower is not a perfect column. */
  xOff: number;
  /** Enter from the left (−1), right (+1), or drop from above (0). */
  side: -1 | 0 | 1;
  landAt: number;
  bounce: BounceOptions;
  spin: number;
}

const BLOCKS: readonly BlockSpec[] = [
  { id: 'bt_square', name: 'Square', kind: 'rect', fill: '#c45c26', w: 188, h: 188, radius: 18, xOff: 0, side: 0, landAt: 0.78, bounce: FIRM, spin: -8 },
  { id: 'bt_circle', name: 'Circle', kind: 'ellipse', fill: '#2f5d9f', w: 168, h: 168, xOff: 10, side: -1, landAt: 2.18, bounce: BALL, spin: 14 },
  { id: 'bt_triangle', name: 'Triangle', kind: 'triangle', fill: '#d9a441', w: 176, h: 158, xOff: -14, side: 1, landAt: 3.62, bounce: RUBBER, spin: -18 },
  { id: 'bt_capsule', name: 'Capsule', kind: 'rect', fill: '#2f6b4f', w: 214, h: 92, radius: 46, xOff: 6, side: -1, landAt: 5.08, bounce: FIRM, spin: 10 },
  { id: 'bt_star', name: 'Star', kind: 'star', fill: '#c43c3c', w: 150, h: 150, xOff: -6, side: 1, landAt: 6.52, bounce: BALL, spin: 26 },
];

const FRAGS_PER = 5;

function outline(kind: ShapeKind, w: number, h: number): Array<{ x: number; y: number }> | null {
  const rx = w / 2;
  const ry = h / 2;
  const top = -Math.PI / 2;
  if (kind === 'triangle') {
    return [0, 1, 2].map((i) => {
      const a = top + (i / 3) * Math.PI * 2;
      return { x: Math.cos(a) * rx, y: Math.sin(a) * ry };
    });
  }
  if (kind === 'star') {
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 10; i++) {
      const a = top + (i / 10) * Math.PI * 2;
      const r = i % 2 === 0 ? 1 : 0.42;
      pts.push({ x: Math.cos(a) * rx * r, y: Math.sin(a) * ry * r });
    }
    return pts;
  }
  return null;
}

function addLayer(
  g: SceneGraph,
  opts: {
    id: string;
    name: string;
    parent: string;
    x: number;
    y: number;
    w: number;
    h: number;
    fill: string;
    kind: ShapeKind;
    radius?: number;
    opacity?: number;
  },
): string {
  const pts = outline(opts.kind, opts.w, opts.h);
  const node = {
    id: opts.id,
    name: opts.name,
    parent: opts.parent,
    children: [],
    visible: true,
    locked: false,
    transform: tf(opts.x, opts.y),
    components: [
      {
        id: `${opts.id}_t`,
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape',
          x: opts.x,
          y: opts.y,
          rotation: 0,
          width: opts.w,
          height: opts.h,
          shapeType: opts.kind,
          ...(opts.radius ? { cornerRadius: opts.radius } : {}),
        },
      },
      { id: `${opts.id}_s`, type: 'Style', props: { opacity: opts.opacity ?? 100, fill: opts.fill } },
      ...(pts
        ? [{
            id: `${opts.id}_g`,
            type: 'Geometry',
            props: { points: pts.map((p) => corner(p.x, p.y)) },
          }]
        : []),
    ],
  } as unknown as SceneNode;
  g.addChild(opts.parent, node);
  setContinuousRaster(opts.id, true);
  return opts.id;
}

function kf(t: number, value: number, bezier?: readonly [number, number, number, number]): Keyframe {
  return bezier
    ? { t, value, easing: 'bezier', bezier: [...bezier] as [number, number, number, number] }
    : { t, value };
}

function write(id: string, prop: string, keys: readonly Keyframe[]): void {
  if (!keys.length) return;
  defaultAnimation.setKeyframes(id, prop, keys);
}

function restOf(blocks: readonly BlockSpec[]): Map<string, { x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  let stack = 0;
  for (const b of blocks) {
    const y = BLOCK_TOWER.floorY - stack - b.h / 2;
    out.set(b.id, { x: BLOCK_TOWER.cx + b.xOff, y, w: b.w, h: b.h });
    stack += b.h - 6;
  }
  return out;
}

function hopHeight(stackPx: number, h: number): number {
  return Math.max(220, stackPx + h * 0.55 + 160);
}

function bounceY(fromT: number, fromY: number, landT: number, landY: number, bounce: BounceOptions): Keyframe[] {
  const fall: Keyframe[] = [
    kf(fromT, fromY, EASY_EASE_IN_BEZIER),
    kf(landT, landY),
  ];
  return bounceTracks([{ prop: 'y', keyframes: fall }], bounce)[0]?.keyframes ?? fall;
}

function groundDips(restY: number, ownLand: number, laterLands: readonly number[]): Keyframe[] {
  const keys: Keyframe[] = [];
  for (const t of laterLands) {
    if (t <= ownLand + 0.35) continue;
    const amp = 10 * Math.max(0.35, 1 - (t - ownLand) / 8);
    keys.push(kf(t - 0.05, restY, EASY_EASE_IN_BEZIER));
    keys.push(kf(t, restY + amp, EASY_EASE_OUT_BEZIER));
    keys.push(kf(t + 0.14, restY, EASY_EASE_IN_BEZIER));
  }
  return keys;
}

function mergeKeys(a: readonly Keyframe[], b: readonly Keyframe[]): Keyframe[] {
  const byT = new Map<number, Keyframe>();
  for (const k of a) byT.set(k.t, k);
  for (const k of b) byT.set(k.t, k);
  return [...byT.values()].sort((x, y) => x.t - y.t);
}

function shadowFor(b: BlockSpec): string {
  return `${b.id}_shadow`;
}

function fragId(blockId: string, i: number): string {
  return `${blockId}_p${i}`;
}

function addDropShadow(id: string): void {
  const fxId = `sh_${id}`;
  addEffect(id, 'drop-shadow', fxId);
  updateEffectParam(id, fxId, 'distance', 14);
  updateEffectParam(id, fxId, 'angle', 90);
  updateEffectParam(id, fxId, 'softness', 20);
  updateEffectParam(id, fxId, 'opacity', 26);
  updateEffectParam(id, fxId, 'color', '#1c140e');
}

function choreographBlock(
  b: BlockSpec,
  rest: { x: number; y: number; w: number; h: number },
  stackBefore: number,
  laterLands: readonly number[],
): void {
  const enterDur = b.side === 0 ? 0.52 : 0.58;
  const t0 = b.landAt - enterDur;
  const hop = hopHeight(stackBefore, b.h);
  const apexY = rest.y - hop;
  const startY = b.side === 0 ? -180 : rest.y - hop * 0.55;
  const startX = b.side === 0 ? rest.x : rest.x + b.side * 780;
  const midX = rest.x + b.side * -40;
  const midT = t0 + enterDur * 0.48;

  const yHop: Keyframe[] = b.side === 0
    ? bounceY(t0, startY, b.landAt, rest.y, b.bounce)
    : bounceY(midT, apexY, b.landAt, rest.y, b.bounce);

  const yKeys = b.side === 0
    ? mergeKeys(yHop, groundDips(rest.y, b.landAt, laterLands))
    : mergeKeys(
        [kf(t0, startY, SMOOTH), kf(midT, apexY, EASY_EASE_OUT_BEZIER), ...yHop.filter((k) => k.t >= midT - 1e-4)],
        groundDips(rest.y, b.landAt, laterLands),
      );

  const xKeys: Keyframe[] = b.side === 0
    ? [kf(t0, rest.x), kf(BLOCK_TOWER.duration, rest.x)]
    : [
        kf(t0, startX, SMOOTH),
        kf(midT, midX, SMOOTH),
        kf(b.landAt, rest.x, EASY_EASE_IN_BEZIER),
        kf(BLOCK_TOWER.duration, rest.x),
      ];

  const rotKeys: Keyframe[] = [
    kf(0, 0),
    kf(t0, b.spin, SMOOTH),
    kf(b.landAt, -b.spin * 0.25, EASY_EASE_OUT_BEZIER),
    kf(b.landAt + 0.28, 0, SMOOTH),
  ];

  const fallPrev = { t: b.side === 0 ? t0 : midT, value: b.side === 0 ? startY : apexY };
  const land = { t: b.landAt, value: rest.y };
  const impacts = [
    ...bounceImpacts(fallPrev, land, b.bounce),
    ...laterLands.filter((t) => t > b.landAt + 0.4).map((t, i) => ({ t, strength: 0.38 * 0.7 ** i })),
  ];
  const squash = squashTracks(impacts, 'y', { scaleX: 1, scaleY: 1 }, t0, { amount: 0.2, duration: 0.15 });

  write(b.id, 'x', xKeys);
  write(b.id, 'y', yKeys);
  write(b.id, 'rotation', rotKeys);
  write(b.id, 'opacity', [
    kf(0, 0),
    kf(Math.max(0, t0 - 0.02), 0),
    kf(t0 + 0.1, 100, EASY_EASE_OUT_BEZIER),
    kf(BLOCK_TOWER.burstAt, 100),
    kf(BLOCK_TOWER.burstAt + 0.08, 0, EASY_EASE_IN_BEZIER),
  ]);

  const sx = squash.find((t) => t.prop === 'scaleX')?.keyframes ?? [kf(0, 1)];
  const sy = squash.find((t) => t.prop === 'scaleY')?.keyframes ?? [kf(0, 1)];
  const anticipateX: Keyframe[] = [
    kf(BLOCK_TOWER.burstAt - 0.38, 1, EASY_EASE_IN_BEZIER),
    kf(BLOCK_TOWER.burstAt - 0.16, 1.08, EASY_EASE_OUT_BEZIER),
    kf(BLOCK_TOWER.burstAt, 0.82, EASY_EASE_IN_BEZIER),
    kf(BLOCK_TOWER.burstAt + 0.1, 1.35, EASY_EASE_OUT_BEZIER),
  ];
  const anticipateY: Keyframe[] = [
    kf(BLOCK_TOWER.burstAt - 0.38, 1, EASY_EASE_IN_BEZIER),
    kf(BLOCK_TOWER.burstAt - 0.16, 0.86, EASY_EASE_OUT_BEZIER),
    kf(BLOCK_TOWER.burstAt, 1.18, EASY_EASE_IN_BEZIER),
    kf(BLOCK_TOWER.burstAt + 0.1, 0.4, EASY_EASE_OUT_BEZIER),
  ];
  write(b.id, 'scaleX', mergeKeys(sx, anticipateX));
  write(b.id, 'scaleY', mergeKeys(sy, anticipateY));

  const sh = shadowFor(b);
  write(sh, 'x', xKeys.map((k) => ({ ...k })));
  write(sh, 'y', [kf(0, BLOCK_TOWER.floorY + 18), kf(BLOCK_TOWER.duration, BLOCK_TOWER.floorY + 18)]);
  write(sh, 'opacity', [
    kf(0, 0),
    kf(t0 + enterDur * 0.7, 0),
    kf(b.landAt, 32, EASY_EASE_OUT_BEZIER),
    kf(BLOCK_TOWER.burstAt, 28),
    kf(BLOCK_TOWER.burstAt + 0.12, 0),
  ]);
  write(sh, 'scaleX', [
    kf(t0, 0.4),
    kf(b.landAt, 1, EASY_EASE_OUT_BEZIER),
    kf(BLOCK_TOWER.burstAt, 1),
    kf(BLOCK_TOWER.burstAt + 0.12, 1.6),
  ]);
}

function choreographFragments(
  b: BlockSpec,
  rest: { x: number; y: number; w: number; h: number },
): void {
  const burst = BLOCK_TOWER.burstAt;
  for (let i = 0; i < FRAGS_PER; i++) {
    const id = fragId(b.id, i);
    const a = (i / FRAGS_PER) * Math.PI * 2 + (b.xOff + b.w) * 0.01;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const throwUp = 210 + ((i * 47 + b.w) % 90);
    const spread = 260 + i * 36 + Math.abs(b.xOff) * 2;
    const peakY = rest.y - throwUp * (0.55 + Math.abs(dy) * 0.45);
    const landX = rest.x + dx * spread;
    const landY = BLOCK_TOWER.floorY - (b.h * 0.38) / 2 + (i % 3) * 6;
    const peakT = burst + 0.22 + (i % 3) * 0.03;
    const landT = burst + 0.62 + (i % 4) * 0.05;
    const spin = (120 + i * 55) * (i % 2 === 0 ? 1 : -1);

    write(id, 'x', [
      kf(0, rest.x),
      kf(burst, rest.x),
      kf(peakT, rest.x + dx * spread * 0.55, EASY_EASE_OUT_BEZIER),
      kf(landT, landX, EASY_EASE_IN_BEZIER),
      kf(BLOCK_TOWER.duration, landX + dx * 18),
    ]);
    write(id, 'y', mergeKeys(
      [kf(0, rest.y), kf(burst, rest.y), kf(peakT, peakY, EASY_EASE_OUT_BEZIER)],
      bounceY(peakT, peakY, landT, landY, i % 2 === 0 ? BALL : RUBBER),
    ));
    write(id, 'rotation', [
      kf(0, 0),
      kf(burst, 0),
      kf(landT, spin, SMOOTH),
      kf(landT + 0.45, spin + (i % 2 === 0 ? 18 : -14), EASY_EASE_OUT_BEZIER),
    ]);
    write(id, 'opacity', [
      kf(0, 0),
      kf(burst - 0.01, 0),
      kf(burst + 0.04, 100, EASY_EASE_OUT_BEZIER),
      kf(BLOCK_TOWER.duration - 0.6, 100),
      kf(BLOCK_TOWER.duration, 100),
    ]);
    write(id, 'scaleX', [kf(0, 0.2), kf(burst, 0.2), kf(burst + 0.1, 1, EASY_EASE_OUT_BEZIER)]);
    write(id, 'scaleY', [kf(0, 0.2), kf(burst, 0.2), kf(burst + 0.1, 1, EASY_EASE_OUT_BEZIER)]);
  }
}

function addRoot(g: SceneGraph): void {
  g.addNode({
    id: ROOT,
    name: BLOCK_TOWER.name,
    parent: null,
    children: [],
    transform: tf(0, 0),
    visible: true,
    locked: false,
    components: [{ id: `${ROOT}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

/** Build the static layers + choreography into `graph` (live singleton by default). */
export function seedBlockTower(graph: SceneGraph = defaultSceneGraph): void {
  const rests = restOf(BLOCKS);
  let stack = 0;
  const laterById = new Map<string, number[]>();
  for (let i = 0; i < BLOCKS.length; i++) {
    laterById.set(BLOCKS[i]!.id, BLOCKS.slice(i + 1).map((b) => b.landAt));
  }

  addLayer(graph, {
    id: 'bt_floor',
    name: 'Floor',
    parent: ROOT,
    x: BLOCK_TOWER.cx,
    y: BLOCK_TOWER.floorY + 86,
    w: 720,
    h: 28,
    fill: '#e0d5c4',
    kind: 'rect',
    radius: 14,
  });
  write('bt_floor', 'opacity', [kf(0, 100)]);

  for (const b of BLOCKS) {
    const rest = rests.get(b.id)!;
    addLayer(graph, {
      id: shadowFor(b),
      name: `${b.name} Shadow`,
      parent: ROOT,
      x: rest.x,
      y: BLOCK_TOWER.floorY + 18,
      w: b.w * 0.92,
      h: 22,
      fill: '#1c140e',
      kind: 'ellipse',
      opacity: 0,
    });
  }

  for (const b of BLOCKS) {
    const rest = rests.get(b.id)!;
    addLayer(graph, {
      id: b.id,
      name: b.name,
      parent: ROOT,
      x: rest.x,
      y: rest.y,
      w: b.w,
      h: b.h,
      fill: b.fill,
      kind: b.kind,
      radius: b.radius,
    });
    addDropShadow(b.id);
    setNodeMotionBlur(b.id, true);
    choreographBlock(b, rest, stack, laterById.get(b.id) ?? []);
    stack += b.h - 6;
  }

  for (const b of BLOCKS) {
    const rest = rests.get(b.id)!;
    const fw = Math.max(36, b.w * 0.38);
    const fh = Math.max(36, b.h * 0.38);
    for (let i = 0; i < FRAGS_PER; i++) {
      const id = fragId(b.id, i);
      addLayer(graph, {
        id,
        name: `${b.name} shard ${i + 1}`,
        parent: ROOT,
        x: rest.x,
        y: rest.y,
        w: fw,
        h: fh,
        fill: b.fill,
        kind: b.kind,
        radius: b.radius ? Math.max(6, b.radius * 0.38) : undefined,
        opacity: 0,
      });
      setNodeMotionBlur(id, true);
    }
    choreographFragments(b, rest);
  }
}

function wipeLiveScene(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  useSelectionStore.getState().set([]);
}

function syncComp(): void {
  useCompositionStore.getState().update({
    name: BLOCK_TOWER.name,
    width: BLOCK_TOWER.width,
    height: BLOCK_TOWER.height,
    fps: BLOCK_TOWER.fps,
    durationSeconds: BLOCK_TOWER.duration,
    background: BLOCK_TOWER.background,
    transparent: false,
  });
  const tl = getTimelineController();
  tl.setDurationSeconds(BLOCK_TOWER.duration);
  tl.syncFromScene(ROOT);
  tl.seekSeconds(0);
}

/** Replace the live composition with Block Tower. */
export function applyBlockTower(): void {
  wipeLiveScene();
  addRoot(defaultSceneGraph);
  seedBlockTower(defaultSceneGraph);
  syncComp();
  bumpScene();
}

/** Command entry: confirm if dirty, then load. Returns false if cancelled. */
export async function loadBlockTower(): Promise<boolean> {
  if (!await confirmDiscardChanges('Load Block Tower')) return false;
  applyBlockTower();
  return true;
}

export function blockTowerFragmentIds(): string[] {
  const ids: string[] = [];
  for (const b of BLOCKS) {
    for (let i = 0; i < FRAGS_PER; i++) ids.push(fragId(b.id, i));
  }
  return ids;
}
