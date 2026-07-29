import { compToKeyframeTime } from '@core/timeline/TimelineController';
/**
 * Complex showcase — a deliberately over-the-top motion-graphics build that
 * exercises most of the engine at once: keyframed transforms with easing,
 * bezier motion paths, text with a typewriter rig, trim-path draw-ons,
 * repeaters, path operators, precomps with time-remap, 3D layers with a camera
 * and light, blend modes, and a stack of animated effects (glow / blur /
 * drop-shadow / hue-rotate / fractal-noise / gradient-ramp).
 *
 * It builds into the default scene graph + animation engine using their real
 * public APIs — the same ones the UI drives — so it doubles as a stress test:
 * `buildComplexShowcase` then rendering `buildSnapshot` across the timeline
 * proves the pipeline handles a dense, fully-animated composition.
 */

import type { SceneNode, Transform, Component } from '../types';
import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { defaultAnimation } from '@motion/animation';
import { bezierCorner as corner } from '@motion/workspace';
import { addEffect, getNodeEffects, effectPropPath, type EffectType } from '@core/effects/effects';
import { setRepeater, repeaterPropPath } from './repeater';
import { setTrim, trimPropPath } from './trimPath';
import { setPathOp, pathOpPropPath } from './pathOps';
import { setPrecomp } from './precomp';
import { set3DEnabled } from './threeD';
import { setNodeBlend } from '@core/effects/blendMode';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';

const CW = 1920;
const CH = 1080;
const CX = CW / 2;
const CY = CH / 2;
const DUR = 12; // seconds

type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
type Pt = { x: number; y: number };

// ── low-level builders ────────────────────────────────────────────────

function tf(x: number, y: number, rotation = 0): Transform {
  return { position: { x, y }, rotation, scale: { x: 1, y: 1 } };
}

function node(id: string, name: string, kind: string, x: number, y: number, extra: Component[] = [], rotation = 0): SceneNode {
  return {
    id, name, parent: 'comp_root', children: [], visible: true, locked: false,
    transform: tf(x, y, rotation),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x, y, rotation } },
      ...extra,
    ],
  } as unknown as SceneNode;
}

function styleFill(id: string, fill: string, opacity = 100): Component {
  return { id: `${id}_s`, type: 'Style', props: { opacity, fill } };
}

function styleStroke(id: string, color: string, width: number): Component {
  return {
    id: `${id}_s`, type: 'Style',
    props: { opacity: 100, fill: 'rgba(0,0,0,0)', stroke: { color, width, opacity: 1, cap: 'round', join: 'round', align: 'center', dash: [] } },
  };
}

function geom(id: string, pts: Pt[]): Component {
  return { id: `${id}_g`, type: 'Geometry', props: { points: pts.map((p) => corner(p.x, p.y)) } };
}

function textComp(id: string, content: string, fontSize: number, weight = 700): Component {
  return { id: `${id}_c`, type: 'Text', props: { content, fontSize, fontWeight: weight, opacity: 100, fill: '#ffffff', align: 'center' } };
}

// polygon / star outlines, local-centred
function polyPts(sides: number, r: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (i / sides) * Math.PI * 2;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}
function starPts(points: number, rOuter: number, rInner: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? rOuter : rInner;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}

// ── keyframe helpers ──────────────────────────────────────────────────

function kf(id: string, prop: string, frames: Array<[number, number, Ease?]>): void {
  for (const [t, v, e] of frames) defaultAnimation.setKeyframe(id, prop, compToKeyframeTime(id, t), v, e ?? 'easeInOut');
}

/** Animate the amount of the most-recently-added effect on a layer. */
function animLastEffect(id: string, frames: Array<[number, number, Ease?]>): void {
  const fx = getNodeEffects(id).at(-1);
  if (!fx) return;
  const path = effectPropPath(fx.id);
  for (const [t, v, e] of frames) defaultAnimation.setKeyframe(id, path, compToKeyframeTime(id, t), v, e ?? 'easeInOut');
}

// ── the build ─────────────────────────────────────────────────────────

/**
 * Wipe the scene and author the complex showcase. Returns the ids created so a
 * test (or the UI) can introspect. Builds into the default graph + animation.
 */
export function buildComplexShowcase(): { root: string; layerCount: number; ids: string[] } {
  defaultSceneGraph.clear();

  const root: SceneNode = {
    id: 'comp_root', name: 'Showcase', parent: null, children: [],
    transform: tf(0, 0), visible: true, locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode;
  defaultSceneGraph.addNode(root);

  const ids: string[] = [];
  const add = (n: SceneNode): string => { defaultSceneGraph.addChild('comp_root', n); ids.push(n.id); return n.id; };

  // 1 ── Animated gradient background (full-comp solid) + hue drift.
  const bg = add(node('bg_grad', 'BG Gradient', 'shape', CX, CY, [styleFill('bg_grad', '#0b1030')]));
  defaultSceneGraph.setSolid(bg, true);
  addEffect(bg, 'gradient-ramp' as EffectType);
  addEffect(bg, 'hue-rotate' as EffectType);
  animLastEffect(bg, [[0, 0], [DUR, 90, 'linear']]);

  // 2 ── Drifting fractal-noise haze, screen blend.
  const noise = add(node('bg_noise', 'Noise Haze', 'shape', CX, CY, [styleFill('bg_noise', '#20408a', 22)]));
  defaultSceneGraph.setSolid(noise, true);
  setNodeBlend(noise, 'screen');
  addEffect(noise, 'fractal-noise' as EffectType);
  animLastEffect(noise, [[0, 30], [DUR, 120, 'linear']]);
  kf(noise, 'opacity', [[0, 0], [1.5, 22], [DUR, 12]]);

  // 3 ── Orbiting repeater ring (precomp w/ time-remap) — spins the whole ring.
  const ringGrp: SceneNode = {
    id: 'ring_grp', name: 'Ring (precomp)', parent: 'comp_root', children: [],
    transform: tf(CX, CY), visible: true, locked: false,
    components: [{ id: 'ring_grp_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode;
  defaultSceneGraph.addChild('comp_root', ringGrp);
  ids.push('ring_grp');
  const dot = node('ring_dot', 'Ring Dot', 'shape', 0, -300, [geom('ring_dot', polyPts(4, 26)), styleFill('ring_dot', '#00f5d4')]);
  dot.parent = 'ring_grp';
  defaultSceneGraph.addChild('ring_grp', dot);
  ids.push('ring_dot');
  setRepeater('ring_dot', { copies: 18, offsetX: 0, offsetY: 0, offsetRotation: 20, offsetScale: 1, offsetOpacity: 1 });
  kf('ring_dot', repeaterPropPath('offsetRotation'), [[0, 20], [DUR, 40, 'linear']]);
  addEffect('ring_dot', 'glow' as EffectType);
  kf('ring_grp', 'rotation', [[0, 0], [DUR, 360, 'linear']]);
  setPrecomp('ring_grp', true);
  // Time-remap the ring: ease-hold-ease so the inner spin ramps then settles.
  kf('ring_grp', 'precompTime', [[0, 0, 'easeIn'], [6, 4], [DUR, DUR, 'easeOut']]);

  // 4 ── Hero star: pop-in, pulse, spin, glow + drop-shadow.
  const hero = add(node('hero_star', 'Hero Star', 'shape', CX, CY, [geom('hero_star', starPts(5, 190, 82)), styleFill('hero_star', '#ffd166')]));
  kf(hero, 'scaleX', [[0, 0, 'easeOut'], [0.6, 1.12], [0.85, 0.96], [1, 1], [3, 1], [4, 1.14], [6, 1]]);
  kf(hero, 'scaleY', [[0, 0, 'easeOut'], [0.6, 1.12], [0.85, 0.96], [1, 1], [3, 1], [4, 1.14], [6, 1]]);
  kf(hero, 'rotation', [[0, -40, 'easeOut'], [DUR, 320, 'linear']]);
  addEffect(hero, 'glow' as EffectType);
  animLastEffect(hero, [[0, 10], [1, 40], [4, 18], [6, 44], [DUR, 20]]);
  addEffect(hero, 'drop-shadow' as EffectType);

  // 5 ── Draw-on swoosh (stroked bezier path revealed by an animated trim).
  const swooshPts: Pt[] = [
    { x: -520, y: 120 }, { x: -180, y: 40 }, { x: 160, y: 150 }, { x: 520, y: 30 },
  ];
  const swoosh = add(node('swoosh', 'Swoosh', 'shape', CX, CY + 300, [geom('swoosh', swooshPts), styleStroke('swoosh', '#ff2b7e', 12)]));
  setTrim(swoosh, { start: 0, end: 0, offset: 0 });
  kf(swoosh, trimPropPath('end'), [[0, 0], [1, 0], [2.6, 100, 'easeInOut']]);
  kf(swoosh, trimPropPath('offset'), [[3, 0], [DUR, 40, 'linear']]);

  // 6 ── Title: typewriter-style reveal via letter-spacing + slide/fade in.
  const title = add(node('title', 'Title', 'text', CX, CY - 260, [textComp('title', 'MOTION ENGINE', 150)]));
  kf(title, 'y', [[0, CY - 200, 'easeOut'], [0.9, CY - 300]]);
  kf(title, 'opacity', [[0, 0, 'easeOut'], [0.9, 100]]);
  kf(title, 'letterSpacing', [[0, 60, 'easeOut'], [1.4, 4]]);
  addEffect(title, 'drop-shadow' as EffectType);

  // 7 ── Subtitle: slide in from the left, staggered after the title.
  const sub = add(node('subtitle', 'Subtitle', 'text', CX, CY + 470, [textComp('subtitle', 'complexity stress test', 56, 500)]));
  kf(sub, 'x', [[0, CX - 700, 'easeOut'], [1.2, CX - 700], [2, CX, 'easeOut']]);
  kf(sub, 'opacity', [[0, 0], [1.2, 0], [2, 100, 'easeOut']]);

  // 8 ── Burst of polygons/stars, staggered scale-in, screen blend + glow.
  const burstColors = ['#9b5de5', '#00bbf9', '#f15bb5', '#fee440', '#00f5d4', '#ff9f1c'];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const bx = CX + Math.cos(a) * 620;
    const by = CY + Math.sin(a) * 320;
    const bid = `burst_${i}`;
    const pts = i % 2 === 0 ? polyPts(6, 46) : starPts(5, 52, 22);
    const b = add(node(bid, `Burst ${i + 1}`, 'shape', bx, by, [geom(bid, pts), styleFill(bid, burstColors[i]!)]));
    setNodeBlend(b, 'screen');
    const t0 = 2.2 + i * 0.14; // sequenced stagger
    kf(b, 'scaleX', [[0, 0], [t0, 0], [t0 + 0.5, 1.2, 'easeOut'], [t0 + 0.8, 1]]);
    kf(b, 'scaleY', [[0, 0], [t0, 0], [t0 + 0.5, 1.2, 'easeOut'], [t0 + 0.8, 1]]);
    kf(b, 'rotation', [[t0, 0], [DUR, i % 2 === 0 ? 240 : -240, 'linear']]);
    addEffect(b, 'glow' as EffectType);
  }

  // 9 ── Wobble hex with an animated Zig-Zag path operator.
  const wob = add(node('wobble', 'Wobble Hex', 'shape', CX - 640, CY, [geom('wobble', polyPts(6, 90)), styleFill('wobble', '#06d6a0')]));
  setPathOp(wob, { type: 'zigzag', amount: 0, detail: 5 });
  kf(wob, pathOpPropPath('amount'), [[0, 0], [1, 0], [3, 34], [6, 6], [9, 34], [DUR, 0]]);
  kf(wob, 'rotation', [[0, 0], [DUR, 180, 'linear']]);

  // 10 ── 3D card that tumbles in Y, with a camera + light lighting the scene.
  const card = add(node('card3d', '3D Card', 'shape', CX + 640, CY, [geom('card3d', polyPts(4, 130)), styleFill('card3d', '#118ab2')]));
  set3DEnabled(card, true);
  kf(card, 'rotationY', [[0, 0], [DUR, 360, 'linear']]);
  kf(card, 'rotationX', [[0, -12], [6, 12], [DUR, -12]]);
  addEffect(card, 'blur' as EffectType);
  animLastEffect(card, [[0, 8], [1.5, 0], [DUR, 0]]);

  const cam: SceneNode = {
    id: 'cam_1', name: 'Camera 1', parent: 'comp_root', children: [],
    transform: tf(CX, CY), visible: true, locked: false,
    components: [{ id: 'cam_1_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'camera', x: CX, y: CY, z: -2666, focalLength: 2666, rotation: 0 } }],
  } as unknown as SceneNode;
  defaultSceneGraph.addChild('comp_root', cam);
  ids.push('cam_1');
  kf('cam_1', 'x', [[0, CX - 60, 'easeInOut'], [6, CX + 60], [DUR, CX - 60]]);

  const light: SceneNode = {
    id: 'light_1', name: 'Light 1', parent: 'comp_root', children: [],
    transform: tf(CX, CY - 200), visible: true, locked: false,
    components: [
      { id: 'light_1_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'light', x: CX, y: CY - 200, intensity: 120, radius: 700, rotation: 0 } },
      { id: 'light_1_s', type: 'Style', props: { fill: '#fff3c0' } },
    ],
  } as unknown as SceneNode;
  defaultSceneGraph.addChild('comp_root', light);
  ids.push('light_1');
  kf('light_1', 'x', [[0, CX - 400, 'easeInOut'], [6, CX + 400], [DUR, CX - 400]]);

  // Size the composition to fit the 12s piece (no-op if no comp is loaded,
  // e.g. under test — the default 1920×1080 already matches).
  useCompositionStore.getState().update({ width: CW, height: CH, fps: 30, durationSeconds: DUR });

  useSelectionStore.getState().set(['hero_star']);
  bumpScene();

  return { root: 'comp_root', layerCount: ids.length, ids };
}

export default buildComplexShowcase;
