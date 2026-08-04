import { compToKeyframeTime } from '@core/timeline/TimelineController';
/**
 * seedSaaSAd — a ~24s premium SaaS product ad authored entirely through the
 * engine's public APIs, as a capability benchmark. It is a *generative* build
 * (no template): six story scenes, reusable component builders, precomp-based
 * scene cross-dissolves, parent-child rigs, and a dense choreography of
 * keyframed transforms with real easing.
 *
 * Structure: each scene is a PRECOMP group (nested composition) whose opacity /
 * position / scale are keyframed for transitions, while its children run their
 * own internal animations. A persistent animated background sits behind all.
 *
 * Rendered by the same buildSnapshot pipeline the editor uses — see
 * seedSaaSAd.test.ts for the stress/verification pass.
 */

import type { SceneNode, Transform, Component } from '../types';
import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { defaultAnimation } from '@motion/animation';
import { bezierCorner as corner } from '@motion/workspace';
import { addEffect, getNodeEffects, effectPropPath, type EffectType } from '@core/effects/effects';
import { addTrimOp, pathOpPropPath } from './pathOps';
import { setPrecomp } from './precomp';
import { setNodeBlend } from '@core/effects/blendMode';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';

const CW = 1920, CH = 1080, CX = CW / 2, CY = CH / 2, DUR = 24;

// ── Palette (Linear/Stripe-leaning) ──────────────────────────────────
const C = {
  ink: '#ffffff',
  sub: '#9aa3c0',
  bg0: '#08080f',
  bg1: '#0e0e1c',
  primary: '#635bff',
  primary2: '#8b5cf6',
  cyan: '#22d3ee',
  green: '#34d399',
  pink: '#f472b6',
  amber: '#fbbf24',
  panel: '#14141f',
  panelHi: '#1c1c2b',
  line: 'rgba(255,255,255,0.10)',
};

type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
type Pt = { x: number; y: number };
type Frame = [number, number, Ease?];

// ── low-level builders ───────────────────────────────────────────────
let uid = 0;
const nid = (p: string) => `${p}_${(uid += 1)}`;

function tf(x: number, y: number, rotation = 0): Transform {
  return { position: { x, y }, rotation, scale: { x: 1, y: 1 } };
}

interface NodeOpts {
  w?: number; h?: number; fill?: string; rotation?: number;
  opacity?: number; anchorY?: number; extra?: Component[];
}
function mk(parent: string, id: string, kind: string, x: number, y: number, o: NodeOpts = {}): string {
  const t: Component = {
    id: `${id}_t`, type: 'Transform',
    props: { [SCENE_KIND_PROP]: kind, x, y, rotation: o.rotation ?? 0,
      ...(o.w != null ? { width: o.w } : {}), ...(o.h != null ? { height: o.h } : {}),
      ...(o.anchorY != null ? { anchorY: o.anchorY } : {}) },
  };
  const comps: Component[] = [t];
  if (kind === 'shape') comps.push({ id: `${id}_s`, type: 'Style', props: { opacity: o.opacity ?? 100, fill: o.fill ?? C.primary } });
  if (o.extra) comps.push(...o.extra);
  const node: SceneNode = { id, name: id, parent, children: [], visible: true, locked: false, transform: tf(x, y, o.rotation ?? 0), components: comps } as unknown as SceneNode;
  defaultSceneGraph.addChild(parent, node);
  return id;
}

function txt(parent: string, id: string, content: string, x: number, y: number, size: number, weight = 700, fill = C.ink, align = 'center'): string {
  const node: SceneNode = {
    id, name: id, parent, children: [], visible: true, locked: false, transform: tf(x, y),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x, y, rotation: 0 } },
      { id: `${id}_c`, type: 'Text', props: { content, fontSize: size, fontWeight: weight, opacity: 100, fill, align } },
    ],
  } as unknown as SceneNode;
  defaultSceneGraph.addChild(parent, node);
  return id;
}

function geomPath(parent: string, id: string, pts: Pt[], stroke: string, width: number): string {
  const node: SceneNode = {
    id, name: id, parent, children: [], visible: true, locked: false, transform: tf(CX, CY),
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: CX, y: CY, rotation: 0 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: 'rgba(0,0,0,0)', stroke: { color: stroke, width, opacity: 1, cap: 'round', join: 'round', align: 'center', dash: [] } } },
      { id: `${id}_g`, type: 'Geometry', props: { points: pts.map((p) => corner(p.x - CX, p.y - CY)) } },
    ],
  } as unknown as SceneNode;
  defaultSceneGraph.addChild(parent, node);
  return id;
}

const kf = (id: string, prop: string, frames: Frame[]) => { for (const [t, v, e] of frames) defaultAnimation.setKeyframe(id, prop, compToKeyframeTime(id, t), v, e ?? 'easeInOut'); };
function animLastFx(id: string, frames: Frame[]) { const fx = getNodeEffects(id).at(-1); if (!fx) return; kf(id, effectPropPath(fx.id), frames); }
const fx = (id: string, type: EffectType) => addEffect(id, type);

/** A scene = a precomp group. Content parents to it; the group's opacity/pos/
 *  scale is keyframed for the transition. `in0..out1` define the visible window. */
function scene(id: string, appear: number, hold: number, out: number, motion?: { fromY?: number; fromScale?: number }): string {
  const g: SceneNode = { id, name: id, parent: 'comp_root', children: [], visible: true, locked: false, transform: tf(0, 0),
    components: [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }] } as unknown as SceneNode;
  defaultSceneGraph.addChild('comp_root', g);
  // Cross-dissolve + subtle push. Groups composite as one unit once precomped.
  kf(id, 'opacity', [[Math.max(0, appear - 0.4), 0], [appear, 100, 'easeOut'], [out, 100], [out + 0.5, 0, 'easeIn']]);
  if (motion?.fromScale != null) kf(id, 'scaleX', [[appear - 0.4, motion.fromScale, 'easeOut'], [appear + 0.6, 1]]);
  if (motion?.fromScale != null) kf(id, 'scaleY', [[appear - 0.4, motion.fromScale, 'easeOut'], [appear + 0.6, 1]]);
  if (motion?.fromY != null) kf(id, 'y', [[appear - 0.4, motion.fromY, 'easeOut'], [appear + 0.6, 0]]);
  // Exit zoom for a couple scenes (set by caller via extra keyframes if wanted).
  setPrecomp(id, true);
  void hold;
  return id;
}

// ── Reusable component builders (each owns its internal animation) ────

/** Pill/rounded button with a hover-shine sweep + idle pulse. */
function makeButton(parent: string, label: string, x: number, y: number, t0: number, primary = true): string {
  const g = nid('btn');
  mk(parent, g, 'group', x, y); // container for parent-child
  const bg = mk(g, nid('btnbg'), 'shape', 0, 0, { w: 300, h: 84, fill: primary ? C.primary : C.panelHi });
  fx(bg, 'glow' as EffectType); animLastFx(bg, [[t0, 8], [t0 + 0.6, 26], [t0 + 2, 12], [DUR, 20]]);
  const lbl = txt(g, nid('btntx'), label, 0, 0, 34, 700, C.ink);
  // pop-in with overshoot + idle press-pulse
  kf(g, 'scaleX', [[t0, 0, 'easeOut'], [t0 + 0.4, 1.08], [t0 + 0.6, 1], [t0 + 3, 1], [t0 + 3.3, 1.05], [t0 + 3.6, 1]]);
  kf(g, 'scaleY', [[t0, 0, 'easeOut'], [t0 + 0.4, 1.08], [t0 + 0.6, 1], [t0 + 3, 1], [t0 + 3.3, 1.05], [t0 + 3.6, 1]]);
  void bg; void lbl;
  return g;
}

/** Feature/info card with an icon chip, title, body — floats idly. */
function makeCard(parent: string, x: number, y: number, t0: number, accent: string, title: string, body: string): string {
  const g = nid('card');
  mk(parent, g, 'group', x, y);
  const panel = mk(g, nid('cardbg'), 'shape', 0, 0, { w: 380, h: 300, fill: C.panel });
  fx(panel, 'drop-shadow' as EffectType);
  const chip = mk(g, nid('chip'), 'shape', -120, -90, { w: 84, h: 84, fill: accent });
  fx(chip, 'glow' as EffectType); animLastFx(chip, [[t0, 10], [t0 + 1, 28], [t0 + 2.5, 12], [DUR, 24]]);
  const ttl = txt(g, nid('ct'), title, 0, 0, 34, 700, C.ink);
  const bd = txt(g, nid('cb'), body, 0, 70, 22, 400, C.sub);
  // staggered rise + fade, then continuous idle float
  kf(g, 'y', [[t0, y + 80, 'easeOut'], [t0 + 0.7, y], [t0 + 3, y - 10], [t0 + 6, y]]);
  kf(g, 'opacity', [[t0, 0, 'easeOut'], [t0 + 0.7, 100]]);
  kf(g, 'scaleX', [[t0, 0.9, 'easeOut'], [t0 + 0.7, 1]]);
  kf(g, 'scaleY', [[t0, 0.9, 'easeOut'], [t0 + 0.7, 1]]);
  void panel; void chip; void ttl; void bd;
  return g;
}

/** Browser window frame with traffic lights + URL pill; slides/scales in. */
function makeBrowser(parent: string, x: number, y: number, t0: number): string {
  const g = nid('browser');
  mk(parent, g, 'group', x, y);
  const frame = mk(g, nid('bframe'), 'shape', 0, 0, { w: 900, h: 560, fill: C.panel });
  fx(frame, 'drop-shadow' as EffectType);
  const bar = mk(g, nid('bbar'), 'shape', 0, -246, { w: 900, h: 64, fill: C.panelHi });
  mk(g, nid('bd1'), 'shape', -410, -246, { w: 18, h: 18, fill: C.pink });
  mk(g, nid('bd2'), 'shape', -378, -246, { w: 18, h: 18, fill: C.amber });
  mk(g, nid('bd3'), 'shape', -346, -246, { w: 18, h: 18, fill: C.green });
  mk(g, nid('burl'), 'shape', 60, -246, { w: 520, h: 30, fill: 'rgba(255,255,255,0.06)' });
  txt(g, nid('burlt'), 'nova.ai/app', 60, -246, 20, 500, C.sub);
  // enter: scale + slide up with overshoot
  kf(g, 'scaleX', [[t0, 0.82, 'easeOut'], [t0 + 0.6, 1.02], [t0 + 0.8, 1]]);
  kf(g, 'scaleY', [[t0, 0.82, 'easeOut'], [t0 + 0.6, 1.02], [t0 + 0.8, 1]]);
  kf(g, 'y', [[t0, y + 70, 'easeOut'], [t0 + 0.7, y]]);
  kf(g, 'opacity', [[t0, 0, 'easeOut'], [t0 + 0.5, 100]]);
  void frame; void bar;
  return g;
}

/** A chat bubble that pops in; `side` -1 left / +1 right. */
function makeBubble(parent: string, text: string, y: number, side: number, t0: number, accent: string): string {
  const g = nid('bub');
  const x = side * 150;
  mk(parent, g, 'group', x, y);
  mk(g, nid('bubbg'), 'shape', 0, 0, { w: 360, h: 90, fill: side < 0 ? C.panelHi : accent });
  txt(g, nid('bubtx'), text, 0, 0, 22, 500, C.ink);
  kf(g, 'scaleX', [[t0, 0.6, 'easeOut'], [t0 + 0.3, 1.05], [t0 + 0.45, 1]]);
  kf(g, 'scaleY', [[t0, 0.6, 'easeOut'], [t0 + 0.3, 1.05], [t0 + 0.45, 1]]);
  kf(g, 'y', [[t0, y + 30, 'easeOut'], [t0 + 0.35, y]]);
  kf(g, 'opacity', [[t0, 0], [t0 + 0.25, 100, 'easeOut']]);
  return g;
}

/** Animated bar-graph: bars grow from the bottom with staggered overshoot. */
function makeBars(parent: string, x: number, y: number, t0: number, values: number[]): string {
  const g = nid('bars');
  mk(parent, g, 'group', x, y);
  const bw = 60, gap = 90, baseH = 240;
  values.forEach((v, i) => {
    const h = Math.max(20, v * baseH);
    const bx = (i - (values.length - 1) / 2) * gap;
    // anchor at the bottom so scaleY grows upward
    const id = mk(g, nid('bar'), 'shape', bx, -h / 2, { w: bw, h, fill: i === values.length - 1 ? C.cyan : C.primary, anchorY: h / 2 });
    const s = t0 + i * 0.12;
    kf(id, 'scaleY', [[s, 0, 'easeOut'], [s + 0.5, 1.12], [s + 0.75, 1]]);
    kf(id, 'opacity', [[s, 0], [s + 0.2, 100]]);
  });
  return g;
}

/** A moving cursor arrow that travels to a target and clicks (ripple). */
function makeCursor(parent: string, path: Frame[], pathY: Frame[], t0: number): string {
  const id = mk(parent, nid('cursor'), 'shape', 0, 0, { w: 26, h: 26, fill: C.ink,
    extra: [{ id: nid('cg'), type: 'Geometry', props: { points: [corner(-13, -13), corner(13, 2), corner(0, 4), corner(6, 15), corner(-2, 15), corner(-9, 6)] } }] });
  kf(id, 'x', path);
  kf(id, 'y', pathY);
  kf(id, 'opacity', [[t0, 0], [t0 + 0.2, 100]]);
  return id;
}

// ── Scenes ───────────────────────────────────────────────────────────

function buildBackground(): void {
  // persistent animated gradient + noise haze + drifting orbs
  const bg = mk('comp_root', 'ad_bg', 'shape', CX, CY, { w: CW, h: CH, fill: C.bg1 });
  fx(bg, 'gradient-ramp' as EffectType);
  fx(bg, 'hue-rotate' as EffectType); animLastFx(bg, [[0, -12], [DUR, 40, 'linear']]);
  const haze = mk('comp_root', 'ad_haze', 'shape', CX, CY, { w: CW, h: CH, fill: '#2a2a55', opacity: 16 });
  setNodeBlend(haze, 'screen'); fx(haze, 'fractal-noise' as EffectType); animLastFx(haze, [[0, 30], [DUR, 120, 'linear']]);
  // two soft orbs drifting for depth
  const o1 = mk('comp_root', 'ad_orb1', 'shape', 380, 300, { w: 520, h: 520, fill: C.primary, opacity: 22 });
  setNodeBlend(o1, 'screen'); fx(o1, 'blur' as EffectType); animLastFx(o1, [[0, 60], [DUR, 60]]);
  kf(o1, 'x', [[0, 340, 'easeInOut'], [12, 620], [DUR, 340]]); kf(o1, 'y', [[0, 300], [12, 520], [DUR, 300]]);
  const o2 = mk('comp_root', 'ad_orb2', 'shape', 1520, 760, { w: 480, h: 480, fill: C.cyan, opacity: 18 });
  setNodeBlend(o2, 'screen'); fx(o2, 'blur' as EffectType); animLastFx(o2, [[0, 60], [DUR, 60]]);
  kf(o2, 'x', [[0, 1560, 'easeInOut'], [12, 1300], [DUR, 1560]]); kf(o2, 'y', [[0, 760], [12, 560], [DUR, 760]]);
}

/** Scene 1 — opening statement: staggered word reveal. */
function sceneOpening(): void {
  const s = scene('ad_s1', 0.3, 3, 4.4, { fromScale: 1.06 });
  // exit: whole scene pushes into a zoom transition
  kf(s, 'scaleX', [[0, 1.06, 'easeOut'], [0.9, 1], [4.0, 1], [4.6, 1.25, 'easeIn']]);
  kf(s, 'scaleY', [[0, 1.06, 'easeOut'], [0.9, 1], [4.0, 1], [4.6, 1.25, 'easeIn']]);
  const words = ['Ship', 'faster', 'with', 'AI.'];
  const gap = 300, startX = CX - ((words.length - 1) * gap) / 2;
  words.forEach((w, i) => {
    const id = txt(s, nid('w'), w, startX + i * gap, CY, 120, 800, i === 3 ? C.primary : C.ink);
    const t0 = 0.4 + i * 0.16;
    kf(id, 'y', [[t0, CY + 70, 'easeOut'], [t0 + 0.5, CY]]);
    kf(id, 'opacity', [[t0, 0, 'easeOut'], [t0 + 0.4, 100]]);
    kf(id, 'letterSpacing', [[t0, 28, 'easeOut'], [t0 + 0.6, 0]]);
    fx(id, 'blur' as EffectType); animLastFx(id, [[t0, 14], [t0 + 0.45, 0]]);
  });
  txt(s, nid('sub'), 'The AI copilot for modern product teams', CX, CY + 120, 34, 400, C.sub);
}

/** Scene 2 — product intro: wordmark builds, icon draws on. */
function sceneProduct(): void {
  const s = scene('ad_s2', 4.2, 3, 7.6, { fromScale: 0.9 });
  // draw-on ring icon (trim path) that becomes the brand mark
  const ringPts: Pt[] = [];
  for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 2; ringPts.push({ x: CX - 250 + Math.cos(a) * 70, y: CY - 10 + Math.sin(a) * 70 }); }
  const ring = geomPath(s, nid('ring'), ringPts, C.primary, 14);
  const ringTrim = addTrimOp(ring, { start: 0, end: 0, offset: 0 });
  kf(ring, pathOpPropPath(ringTrim, 'end'), [[4.4, 0], [5.6, 100, 'easeInOut']]);
  const dot = mk(s, nid('dot'), 'shape', CX - 250, CY - 10, { w: 44, h: 44, fill: C.cyan });
  kf(dot, 'scaleX', [[5.4, 0, 'easeOut'], [5.7, 1.2], [5.9, 1]]); kf(dot, 'scaleY', [[5.4, 0, 'easeOut'], [5.7, 1.2], [5.9, 1]]);
  const mark = txt(s, nid('mark'), 'Nova', CX + 20, CY - 10, 130, 800, C.ink, 'left');
  kf(mark, 'x', [[5.2, CX - 60, 'easeOut'], [5.9, CX + 20]]);
  kf(mark, 'opacity', [[5.2, 0, 'easeOut'], [5.9, 100]]);
  txt(s, nid('tag'), 'Meet your AI teammate', CX, CY + 110, 40, 500, C.sub);
}

/** Scene 3 — UI demo: browser + chat conversation + typing + notification + cursor. */
function sceneUiDemo(): void {
  const s = scene('ad_s3', 7.5, 5, 13.3, { fromY: 60 });
  const browser = makeBrowser(s, CX - 120, CY + 20, 7.7);
  // chat conversation inside the browser (parented so it moves with it)
  makeBubble(browser, 'Summarize Q3 revenue', -60, -1, 8.4, C.primary);
  // typing indicator (three pulsing dots) then AI reply
  const typing = mk(browser, nid('typing'), 'group', 150, 60, {});
  [-24, 0, 24].forEach((dx, i) => { const d = mk(typing, nid('td'), 'shape', dx, 0, { w: 14, h: 14, fill: C.sub }); kf(d, 'opacity', [[9.0 + i * 0.15, 30], [9.3 + i * 0.15, 100, 'easeOut'], [9.6 + i * 0.15, 30]]); kf(d, 'scaleX', [[9.0 + i * 0.15, 0.7], [9.3 + i * 0.15, 1.2], [9.6 + i * 0.15, 0.7]]); kf(d, 'scaleY', [[9.0 + i * 0.15, 0.7], [9.3 + i * 0.15, 1.2], [9.6 + i * 0.15, 0.7]]); });
  kf(typing, 'opacity', [[8.9, 0], [9.0, 100], [9.9, 100], [10.0, 0]]);
  makeBubble(browser, '+18% vs Q2 — details ready', 60, 1, 10.1, C.primary);
  // notification card slides in from top-right of the browser
  const notif = mk(browser, nid('notif'), 'group', 300, -190, {});
  mk(notif, nid('nbg'), 'shape', 0, 0, { w: 320, h: 78, fill: C.panelHi });
  mk(notif, nid('nic'), 'shape', -120, 0, { w: 44, h: 44, fill: C.green });
  txt(notif, nid('ntx'), 'Report exported', 20, 0, 20, 600, C.ink);
  kf(notif, 'x', [[10.8, 520, 'easeOut'], [11.3, 300]]); kf(notif, 'opacity', [[10.8, 0], [11.1, 100]]);
  kf(notif, 'x', [[12.4, 300], [12.9, 520, 'easeIn']]); // slide back out
  // cursor moves to a button and clicks (ripple)
  makeCursor(s, [[8.0, CX + 260, 'easeInOut'], [8.9, CX + 40], [11.6, CX + 40], [12.2, CX + 220, 'easeInOut']],
    [[8.0, CY + 220, 'easeInOut'], [8.9, CY + 150], [11.6, CY + 150], [12.2, CY - 40, 'easeInOut']], 8.0);
  void browser;
}

/** Scene 4 — feature highlights: three floating cards, staggered. */
function sceneFeatures(): void {
  const s = scene('ad_s4', 13.3, 4, 17.4, { fromY: 50 });
  txt(s, nid('fh'), 'Everything your team needs', CX, 240, 56, 800, C.ink);
  makeCard(s, CX - 440, CY + 40, 13.8, C.primary, 'Instant answers', 'Ask anything about your data');
  makeCard(s, CX, CY + 40, 13.95, C.cyan, 'Auto-reports', 'Dashboards that build themselves');
  makeCard(s, CX + 440, CY + 40, 14.1, C.pink, 'Smart alerts', 'Know before it matters');
}

/** Scene 5 — benefits: dashboard with growing bars + line-chart draw-on + counter. */
function sceneBenefits(): void {
  const s = scene('ad_s5', 17.3, 3, 20.2, { fromScale: 0.94 });
  const panel = mk(s, nid('dash'), 'shape', CX, CY + 30, { w: 1100, h: 560, fill: C.panel });
  fx(panel, 'drop-shadow' as EffectType);
  txt(s, nid('dt'), '10× faster insights', CX - 300, CY - 180, 44, 800, C.ink, 'left');
  makeBars(s, CX - 300, CY + 200, 17.8, [0.4, 0.62, 0.55, 0.8, 1.0]);
  // line chart draw-on (trim) over the bars area
  const lp: Pt[] = [{ x: CX + 120, y: CY + 120 }, { x: CX + 300, y: CY + 40 }, { x: CX + 460, y: CY + 90 }, { x: CX + 640, y: CY - 60 }];
  const line = geomPath(s, nid('line'), lp, C.cyan, 8);
  const lineTrim = addTrimOp(line, { start: 0, end: 0, offset: 0 });
  kf(line, pathOpPropPath(lineTrim, 'end'), [[18.4, 0], [19.6, 100, 'easeInOut']]);
  fx(line, 'glow' as EffectType);
  txt(s, nid('big'), '99.9%', CX + 380, CY - 150, 84, 800, C.cyan, 'center');
  void panel;
}

/** Scene 6 — CTA: headline converges, glowing button pulses, arrow nudges. */
function sceneCta(): void {
  const s = scene('ad_s6', 20.2, 3, 24, { fromScale: 1.04 });
  const head = txt(s, nid('cta'), 'Start building with Nova', CX, CY - 90, 92, 800, C.ink);
  kf(head, 'opacity', [[20.4, 0, 'easeOut'], [21.0, 100]]);
  kf(head, 'y', [[20.4, CY - 40, 'easeOut'], [21.0, CY - 90]]);
  kf(head, 'letterSpacing', [[20.4, 18, 'easeOut'], [21.2, 0]]);
  const btn = makeButton(s, 'Get started free', CX, CY + 70, 21.0, true);
  // arrow nudge inside/after the button
  const arrow = txt(btn, nid('arr'), '→', 120, 0, 40, 800, C.ink, 'center');
  kf(arrow, 'x', [[21.6, 116], [22.0, 132, 'easeInOut'], [22.4, 116], [22.8, 132], [23.2, 116]]);
  txt(s, nid('ctasub'), 'No credit card required', CX, CY + 170, 26, 400, C.sub);
}

// ── Build entry ──────────────────────────────────────────────────────

export function buildSaaSAd(): { root: string; scenes: number; nodes: number } {
  uid = 0;
  defaultSceneGraph.clear();
  const root: SceneNode = { id: 'comp_root', name: 'Nova — AI Ad', parent: null, children: [], transform: tf(0, 0), visible: true, locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }] } as unknown as SceneNode;
  defaultSceneGraph.addNode(root);

  buildBackground();
  sceneOpening();
  sceneProduct();
  sceneUiDemo();
  sceneFeatures();
  sceneBenefits();
  sceneCta();

  useCompositionStore.getState().update({ width: CW, height: CH, fps: 60, durationSeconds: DUR, background: C.bg0 });
  useSelectionStore.getState().set(['ad_s1']);
  bumpScene();
  return { root: 'comp_root', scenes: 6, nodes: defaultSceneGraph.size };
}

export default buildSaaSAd;
