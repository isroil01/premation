/**
 * Motion recipes (Phase B & C) — After Effects-level 3D animation procedures, encoded.
 *
 * Each recipe is a pure procedure that lays out and animates an element with real 3D depth,
 * 3D camera sweeps, staggered entrances, overshoot easings, glow, and 3D rotations —
 * using the design tokens (design.ts).
 */

import type { ToolContext } from '@motion/ai-tools';
import { set3DEnabled } from '@core/scene/threeD';
import { PHYSICS, type Bezier, type MotionStyle } from './design';
import { activeSceneWindow, nextSceneElementStart, beginSceneWindow } from './sceneWindow';

type KfPoint = { t: number; value: number; easing?: string; bezier?: Bezier };

/** Author keyframes in COMPOSITION time (converted per node), value + easing together. */
function kf(ctx: ToolContext, nodeId: string, prop: string, points: KfPoint[]): void {
  for (const p of points) {
    const lt = ctx.time.toLayerTime(nodeId, p.t);
    ctx.anim.setKeyframe(nodeId, prop, lt, p.value, p.easing ?? 'easeOut');
    if (p.easing === 'bezier' && p.bezier) ctx.anim.setBezier(nodeId, prop, lt, p.bezier);
  }
}

/** Auto-stagger. Inside an active scene, entrances offset from the SCENE start
 *  (so scene 3 begins at its own window, not t≈0); otherwise the legacy
 *  single-scene behaviour (offset from 0, capped 1.3s). */
function nextStartAt(ctx: ToolContext, s: MotionStyle): number {
  const scened = nextSceneElementStart(s.staggerSec);
  if (scened !== null) return scened;
  const animated = ctx.scene.all().filter((n) => n.animated.length > 0).length;
  return Math.min(animated * s.staggerSec, 1.3);
}

/** If a scene window is open, fade + drift this element OUT near the scene's
 *  end, so its content clears before the next scene — the thing that makes
 *  scenes read as separate. No-op outside a scene (single-shot holds to end). */
function applySceneExit(ctx: ToolContext, id: string, cy: number): void {
  const w = activeSceneWindow();
  if (!w) return;
  const out = Math.min(w.transitionSec, 0.5);
  const exitAt = Math.max(w.startSec + 0.2, w.endSec - out);
  kf(ctx, id, 'opacity', [
    { t: exitAt, value: 100, easing: 'easeIn' },
    { t: w.endSec, value: 0, easing: 'easeIn' },
  ]);
  kf(ctx, id, 'y', [
    { t: exitAt, value: cy, easing: 'easeIn' },
    { t: w.endSec, value: cy - 24, easing: 'easeIn' },
  ]);
}

/** The canonical 3D entrance: fade up + rise from below + slight 3D tilt with the style's curve. */
function entranceRise3D(ctx: ToolContext, id: string, start: number, s: MotionStyle, cy: number): void {
  set3DEnabled(id, true);
  kf(ctx, id, 'opacity', [
    { t: start, value: 0, easing: 'easeOut' },
    { t: start + s.entranceDur * 0.55, value: 100, easing: 'easeOut' },
  ]);
  kf(ctx, id, 'y', [
    { t: start, value: cy + s.travelPx, easing: 'bezier', bezier: s.entranceCurve },
    { t: start + s.entranceDur, value: cy, easing: 'bezier', bezier: s.entranceCurve },
  ]);
  kf(ctx, id, 'rotationX', [
    { t: start, value: 15, easing: 'bezier', bezier: s.entranceCurve },
    { t: start + s.entranceDur, value: 0, easing: 'bezier', bezier: s.entranceCurve },
  ]);
}

function addGlow(ctx: ToolContext, id: string, amount: number): void {
  const fx = ctx.scene.addEffect(id, 'glow');
  if (fx) ctx.scene.updateEffect(id, fx, amount);
}

/** Full-comp background solid positioned at deep Z depth (z=500) for real 3D parallax. */
export function recipeBackground(ctx: ToolContext, s: MotionStyle, color?: string): string {
  const comp = ctx.comp.get();
  const id = ctx.scene.create('solid', 'Background', { x: comp.width / 2, y: comp.height / 2 });
  ctx.scene.setProp(id, 'width', comp.width);
  ctx.scene.setProp(id, 'height', comp.height);
  ctx.scene.setProp(id, 'fill', color ?? s.palette.bg);
  set3DEnabled(id, true);
  kf(ctx, id, 'z', [
    { t: 0, value: 500, easing: 'linear' },
    { t: comp.durationSeconds, value: 550, easing: 'linear' },
  ]);
  kf(ctx, id, 'scale', [
    { t: 0, value: 1, easing: 'linear' },
    { t: comp.durationSeconds, value: 1.05, easing: 'linear' },
  ]);
  return id;
}

/**
 * Open a SCENE — a time window [startSec, startSec+durationSec] with its own
 * full-comp background. Sets the active scene window so every content recipe
 * called AFTER this one enters at the scene's start and exits at its end,
 * instead of all elements stacking at t≈0 over one shared background. This is
 * what turns the flat compose tools into a real multi-scene sequence.
 *
 * Scenes are built in chronological order, so each scene's opaque background
 * naturally occludes the previous scene during its window; a short opacity
 * fade-in on the background is the (cross-dissolve) transition. `cut` makes it
 * a hard cut.
 */
export function recipeScene(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { index: number; startSec: number; durationSec: number; background?: string; transition?: 'dissolve' | 'cut' },
): string {
  const comp = ctx.comp.get();
  const startSec = Math.max(0, opts.startSec);
  const endSec = Math.min(comp.durationSeconds, startSec + Math.max(0.3, opts.durationSec));
  const trans = opts.transition === 'cut' ? 0 : 0.4;
  beginSceneWindow(opts.index, startSec, endSec, trans || 0.35);

  const id = ctx.scene.create('solid', `Scene ${opts.index} BG`, { x: comp.width / 2, y: comp.height / 2 });
  ctx.scene.setProp(id, 'width', comp.width);
  ctx.scene.setProp(id, 'height', comp.height);
  ctx.scene.setProp(id, 'fill', opts.background ?? s.palette.bg);
  // Opacity window: the first scene is opaque from frame 0; later scenes fade
  // in over `trans` (dissolve) and then hold — the previous scene's background
  // sits underneath and is revealed only while this one is transparent.
  const atStart = startSec <= 0.02;
  kf(ctx, id, 'opacity', [
    { t: Math.max(0, startSec - 0.001), value: atStart ? 100 : 0, easing: 'easeInOut' },
    { t: startSec + (atStart ? 0 : trans), value: 100, easing: 'easeInOut' },
  ]);
  return id;
}

/**
 * A full-frame fade-through-black (or white flash) centred at `atSec` — hard
 * punctuation between acts. Build it AFTER the scenes so it sits on top of
 * everything and actually covers the cut.
 */
export function recipeTransition(
  ctx: ToolContext,
  opts: { atSec: number; kind?: 'fade_black' | 'flash'; durationSec?: number },
): string {
  const comp = ctx.comp.get();
  const dur = Math.max(0.2, opts.durationSec ?? 0.5);
  const half = dur / 2;
  const id = ctx.scene.create('solid', 'Transition', { x: comp.width / 2, y: comp.height / 2 });
  ctx.scene.setProp(id, 'width', comp.width);
  ctx.scene.setProp(id, 'height', comp.height);
  ctx.scene.setProp(id, 'fill', opts.kind === 'flash' ? '#ffffff' : '#000000');
  kf(ctx, id, 'opacity', [
    { t: Math.max(0, opts.atSec - half), value: 0, easing: 'easeInOut' },
    { t: opts.atSec, value: 100, easing: 'easeInOut' },
    { t: opts.atSec + half, value: 0, easing: 'easeInOut' },
  ]);
  return id;
}

/** A 3D title / subtitle / tagline, positioned in 3D space with spatial Z depth. */
export function recipeText(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { text: string; level: 'title' | 'subtitle' | 'tagline'; y?: number },
): string {
  const comp = ctx.comp.get();
  const cx = comp.width / 2;
  const cy =
    opts.y ??
    (opts.level === 'title'
      ? comp.height * 0.44
      : opts.level === 'subtitle'
        ? comp.height * 0.56
        : comp.height * 0.63);
  const px = opts.level === 'title' ? s.type.titlePx : opts.level === 'subtitle' ? s.type.subtitlePx : s.type.taglinePx;

  const id = ctx.scene.create('text', opts.text.slice(0, 24) || opts.level, { x: cx, y: cy });
  ctx.scene.setProp(id, 'content', opts.text);
  ctx.scene.setProp(id, 'fontSize', px);
  ctx.scene.setProp(id, 'fontWeight', opts.level === 'title' ? s.type.weightTitle : s.type.weightBody);
  ctx.scene.setProp(id, 'fill', opts.level === 'title' ? s.palette.fg : s.palette.muted);

  // Position at distinct Z-depth for 3D parallax
  const zDepth = opts.level === 'title' ? -80 : opts.level === 'subtitle' ? -40 : 0;
  kf(ctx, id, 'z', [{ t: 0, value: zDepth }]);

  entranceRise3D(ctx, id, nextStartAt(ctx, s), s, cy);
  if (s.glow && opts.level === 'title') addGlow(ctx, id, 18);
  applySceneExit(ctx, id, cy);
  return id;
}

/** A glowing circular 3D emblem that flips in on 3D Y-axis with overshoot, then pulses. */
export function recipeEmblem(ctx: ToolContext, s: MotionStyle, opts: { y?: number; size?: number }): string {
  const comp = ctx.comp.get();
  const d = opts.size ?? Math.round(Math.min(comp.width, comp.height) * 0.16);
  const cx = comp.width / 2;
  const cy = opts.y ?? comp.height * 0.3;

  const id = ctx.scene.create('shape', 'Emblem', { x: cx, y: cy });
  ctx.scene.setProp(id, 'shapeType', 'ellipse');
  ctx.scene.setProp(id, 'width', d);
  ctx.scene.setProp(id, 'height', d);
  ctx.scene.setProp(id, 'fill', s.palette.accent);
  set3DEnabled(id, true);
  kf(ctx, id, 'z', [{ t: 0, value: 0 }]);

  const start = nextStartAt(ctx, s);
  kf(ctx, id, 'opacity', [
    { t: start, value: 0, easing: 'easeOut' },
    { t: start + s.entranceDur * 0.5, value: 100, easing: 'easeOut' },
  ]);
  // 3D Y-axis flip entrance with spring overshoot
  kf(ctx, id, 'rotationY', [
    { t: start, value: 90, easing: 'bezier', bezier: PHYSICS.overshoot },
    { t: start + s.entranceDur, value: 0, easing: 'bezier', bezier: PHYSICS.overshoot },
  ]);
  kf(ctx, id, 'scale', [
    { t: start, value: 0.6, easing: 'bezier', bezier: PHYSICS.overshoot },
    { t: start + s.entranceDur, value: 1, easing: 'bezier', bezier: PHYSICS.overshoot },
  ]);
  const p = start + s.entranceDur + 0.35;
  kf(ctx, id, 'scale', [
    { t: p, value: 1, easing: 'easeInOut' },
    { t: p + 0.5, value: 1.045, easing: 'easeInOut' },
    { t: p + 1.0, value: 1, easing: 'easeInOut' },
  ]);
  if (s.glow) addGlow(ctx, id, 28);
  applySceneExit(ctx, id, cy);
  return id;
}

/** A centred row of evenly-spaced 3D cards that rotate and stagger in. */
export function recipeCards(ctx: ToolContext, s: MotionStyle, opts: { count?: number; y?: number }): string[] {
  const comp = ctx.comp.get();
  const n = Math.max(1, Math.min(opts.count ?? 3, 8));
  const cy = opts.y ?? comp.height * 0.5;
  const gap = comp.width * 0.03;
  const cardW = Math.min((comp.width * 0.82 - gap * (n - 1)) / n, comp.width * 0.24);
  const cardH = Math.round(cardW * 1.3);
  const totalW = cardW * n + gap * (n - 1);
  const firstX = comp.width / 2 - totalW / 2 + cardW / 2;
  const base = nextStartAt(ctx, s);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = firstX + i * (cardW + gap);
    const id = ctx.scene.create('shape', `Card ${i + 1}`, { x, y: cy });
    ctx.scene.setProp(id, 'shapeType', 'rect');
    ctx.scene.setProp(id, 'width', Math.round(cardW));
    ctx.scene.setProp(id, 'height', cardH);
    ctx.scene.setProp(id, 'fill', s.palette.card);
    set3DEnabled(id, true);
    kf(ctx, id, 'z', [{ t: 0, value: -20 }]);
    kf(ctx, id, 'rotationY', [
      { t: base + i * s.staggerSec, value: -18, easing: 'bezier', bezier: s.entranceCurve },
      { t: base + i * s.staggerSec + s.entranceDur, value: 0, easing: 'bezier', bezier: s.entranceCurve },
    ]);
    entranceRise3D(ctx, id, base + i * s.staggerSec, s, cy);
    applySceneExit(ctx, id, cy);
    ids.push(id);
  }
  return ids;
}

/** Apply a staggered 3D entrance to layers that already exist. */
export function recipeStaggerIn(ctx: ToolContext, s: MotionStyle, nodeIds: string[]): number {
  let i = 0;
  for (const id of nodeIds) {
    const v = ctx.scene.get(id);
    if (!v) continue;
    entranceRise3D(ctx, id, i * s.staggerSec, s, v.y);
    i++;
  }
  return i;
}

/**
 * Word-by-word kinetic typography: each word is its own text layer popping in
 * with an overshoot scale + rise, on a tight beat. The Higgsfield-style "words
 * land like drums" look that a model hand-authoring keyframes never gets right
 * (per-word centring + beat timing + overshoot must all agree).
 */
export function recipeKineticText(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { text: string; y?: number; fontSize?: number },
): string[] {
  const comp = ctx.comp.get();
  const words = opts.text.trim().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!words.length) return [];
  const px = opts.fontSize ?? (words.length > 4 ? s.type.subtitlePx * 1.6 : s.type.titlePx * 0.8);
  const cy = opts.y ?? comp.height * 0.5;
  // Approximate glyph advance (~0.56em average) to centre the whole row.
  const wordW = words.map((w) => Math.max(1, w.length) * px * 0.56);
  const gap = px * 0.42;
  const totalW = wordW.reduce((a, b) => a + b, 0) + gap * (words.length - 1);
  let cursor = comp.width / 2 - totalW / 2;
  const base = nextStartAt(ctx, s);
  const beat = Math.max(s.staggerSec, 0.1);
  const ids: string[] = [];
  words.forEach((word, i) => {
    const w = wordW[i] ?? px;
    const cx = cursor + w / 2;
    cursor += w + gap;
    const id = ctx.scene.create('text', word.slice(0, 24), { x: cx, y: cy });
    ctx.scene.setProp(id, 'content', word);
    ctx.scene.setProp(id, 'fontSize', Math.round(px));
    ctx.scene.setProp(id, 'fontWeight', s.type.weightTitle);
    ctx.scene.setProp(id, 'fill', s.palette.fg);
    const t0 = base + i * beat;
    kf(ctx, id, 'opacity', [
      { t: t0, value: 0, easing: 'easeOut' },
      { t: t0 + 0.18, value: 100, easing: 'easeOut' },
    ]);
    kf(ctx, id, 'scale', [
      { t: t0, value: 0.4, easing: 'bezier', bezier: PHYSICS.overshoot },
      { t: t0 + 0.42, value: 1, easing: 'bezier', bezier: PHYSICS.overshoot },
    ]);
    kf(ctx, id, 'y', [
      { t: t0, value: cy + px * 0.3, easing: 'bezier', bezier: PHYSICS.overshoot },
      { t: t0 + 0.42, value: cy, easing: 'bezier', bezier: PHYSICS.overshoot },
    ]);
    applySceneExit(ctx, id, cy);
    ids.push(id);
  });
  return ids;
}

/**
 * A soft diagonal light bar that sweeps across the frame once — the classic
 * "premium sheen" beat. Blurred, low-opacity, timed to pass after the content
 * has entered.
 */
export function recipeLightSweep(ctx: ToolContext, s: MotionStyle, opts: { at?: number } = {}): string {
  const comp = ctx.comp.get();
  const cy = comp.height / 2;
  const startX = -comp.width * 0.25;
  const endX = comp.width * 1.25;
  const id = ctx.scene.create('shape', 'Light Sweep', { x: startX, y: cy });
  ctx.scene.setProp(id, 'shapeType', 'rect');
  ctx.scene.setProp(id, 'width', Math.round(comp.width * 0.16));
  ctx.scene.setProp(id, 'height', Math.round(comp.height * 1.8));
  ctx.scene.setProp(id, 'fill', '#ffffff');
  ctx.scene.setProp(id, 'rotation', 18);
  const blurFx = ctx.scene.addEffect(id, 'blur');
  if (blurFx) ctx.scene.updateEffect(id, blurFx, 26);
  const t0 = opts.at ?? nextStartAt(ctx, s) + 0.55;
  const dur = 0.9;
  kf(ctx, id, 'x', [
    { t: t0, value: startX, easing: 'bezier', bezier: PHYSICS.smooth },
    { t: t0 + dur, value: endX, easing: 'bezier', bezier: PHYSICS.smooth },
  ]);
  kf(ctx, id, 'opacity', [
    { t: t0, value: 0, easing: 'easeOut' },
    { t: t0 + dur * 0.4, value: 26, easing: 'easeInOut' },
    { t: t0 + dur, value: 0, easing: 'easeIn' },
  ]);
  return id;
}

/**
 * A field of soft blurred accent orbs drifting slowly at background depth —
 * instant production value (ambient bokeh) with real 3D parallax under a
 * camera move. Deterministic layout (golden-ratio scatter), no randomness.
 */
export function recipeFloatingOrbs(ctx: ToolContext, s: MotionStyle, opts: { count?: number } = {}): string[] {
  const comp = ctx.comp.get();
  const n = Math.max(2, Math.min(opts.count ?? 5, 10));
  const minDim = Math.min(comp.width, comp.height);
  const ids: string[] = [];
  const frac = (v: number) => v - Math.floor(v);
  for (let i = 0; i < n; i++) {
    const x = comp.width * (0.12 + 0.76 * frac((i + 1) * 0.618));
    const y = comp.height * (0.15 + 0.7 * frac((i + 1) * 0.381));
    const d = Math.round(minDim * (0.06 + (i % 3) * 0.035));
    const id = ctx.scene.create('shape', `Orb ${i + 1}`, { x, y });
    ctx.scene.setProp(id, 'shapeType', 'ellipse');
    ctx.scene.setProp(id, 'width', d);
    ctx.scene.setProp(id, 'height', d);
    ctx.scene.setProp(id, 'fill', i % 2 === 0 ? s.palette.accent : s.palette.bgAccent);
    const blurFx = ctx.scene.addEffect(id, 'blur');
    if (blurFx) ctx.scene.updateEffect(id, blurFx, 18);
    set3DEnabled(id, true);
    kf(ctx, id, 'z', [{ t: 0, value: 180 + i * 55 }]);
    // Slow vertical drift, alternating direction so the field feels alive.
    const drift = (i % 2 === 0 ? -1 : 1) * (28 + (i % 3) * 10);
    kf(ctx, id, 'y', [
      { t: 0, value: y, easing: 'easeInOut' },
      { t: comp.durationSeconds, value: y + drift, easing: 'easeInOut' },
    ]);
    kf(ctx, id, 'opacity', [{ t: 0, value: 22 + (i % 3) * 8 }]);
    ids.push(id);
  }
  return ids;
}

/**
 * A broadcast-style lower third: accent bar + title + optional subtitle in the
 * lower-left, sliding in from the left with the bar growing first.
 */
export function recipeLowerThird(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { title: string; subtitle?: string },
): string[] {
  const comp = ctx.comp.get();
  const marginX = comp.width * 0.08;
  const baseY = comp.height * 0.82;
  const titlePx = Math.round(s.type.subtitlePx * 1.25);
  const subPx = s.type.taglinePx;
  const t0 = nextStartAt(ctx, s);
  const ids: string[] = [];

  // Accent bar grows vertically first — it "opens" the lower third.
  const barH = Math.round(titlePx * (opts.subtitle ? 2.4 : 1.5));
  const bar = ctx.scene.create('shape', 'LT Bar', { x: marginX, y: baseY });
  ctx.scene.setProp(bar, 'shapeType', 'rect');
  ctx.scene.setProp(bar, 'width', 8);
  ctx.scene.setProp(bar, 'height', barH);
  ctx.scene.setProp(bar, 'fill', s.palette.accent);
  kf(ctx, bar, 'scale', [
    { t: t0, value: 0, easing: 'bezier', bezier: s.entranceCurve },
    { t: t0 + 0.35, value: 1, easing: 'bezier', bezier: s.entranceCurve },
  ]);
  kf(ctx, bar, 'opacity', [
    { t: t0, value: 0, easing: 'easeOut' },
    { t: t0 + 0.2, value: 100, easing: 'easeOut' },
  ]);
  ids.push(bar);

  // Text slides in from behind the bar (left → resting) with a small delay.
  const place = (text: string, px: number, weight: number, fill: string, y: number, delay: number): string => {
    const approxW = Math.max(1, text.length) * px * 0.56;
    const restX = marginX + 26 + approxW / 2;
    const id = ctx.scene.create('text', text.slice(0, 24), { x: restX, y });
    ctx.scene.setProp(id, 'content', text);
    ctx.scene.setProp(id, 'fontSize', px);
    ctx.scene.setProp(id, 'fontWeight', weight);
    ctx.scene.setProp(id, 'fill', fill);
    kf(ctx, id, 'x', [
      { t: t0 + delay, value: restX - 56, easing: 'bezier', bezier: s.entranceCurve },
      { t: t0 + delay + s.entranceDur * 0.8, value: restX, easing: 'bezier', bezier: s.entranceCurve },
    ]);
    kf(ctx, id, 'opacity', [
      { t: t0 + delay, value: 0, easing: 'easeOut' },
      { t: t0 + delay + 0.3, value: 100, easing: 'easeOut' },
    ]);
    return id;
  };
  const titleY = opts.subtitle ? baseY - titlePx * 0.45 : baseY;
  ids.push(place(opts.title, titlePx, s.type.weightTitle, s.palette.fg, titleY, 0.12));
  if (opts.subtitle) {
    ids.push(place(opts.subtitle, subPx, s.type.weightBody, s.palette.muted, baseY + subPx * 0.9, 0.22));
  }
  for (const id of ids) {
    const v = ctx.scene.get(id);
    if (v) applySceneExit(ctx, id, v.y);
  }
  return ids;
}

/**
 * A slow, continuous push-in (or pull-out) that makes a hero shot feel alive.
 *
 * IMPLEMENTED AS A PER-LAYER SCALE RAMP, NOT A 3D CAMERA. A real 3D scene camera
 * dollying in this engine CULLS 3D content it pushes past its frustum — e.g. a
 * scene-3 emblem vanishing near the end of a multi-scene video. The scale ramp
 * gives the same "the shot is breathing" feel with none of that risk: it nudges
 * every content layer's scale by a few percent across its life. Layers that
 * already animate their own scale (an emblem's entrance/pulse, a card's pop) are
 * left alone so the ramp never fights an entrance.
 */
export function recipeCameraMove(
  ctx: ToolContext,
  opts: { kind?: 'push_in' | 'pull_out'; durationSec?: number },
): number {
  const comp = ctx.comp.get();
  const dur = opts.durationSec ?? comp.durationSeconds;
  const from = opts.kind === 'pull_out' ? 1.06 : 1;
  const to = opts.kind === 'pull_out' ? 1 : 1.06;

  // Content layers only — skip solids (backgrounds/transitions), cameras, lights.
  const targets = ctx.scene
    .all()
    .filter((n) => n.kind === 'shape' || n.kind === 'text' || n.kind === 'image');

  let count = 0;
  for (const n of targets) {
    // Don't fight a layer that already scales itself (entrance/pulse/overshoot).
    if (n.animated.includes('scale')) continue;
    kf(ctx, n.id, 'scale', [
      { t: 0, value: from, easing: 'bezier', bezier: PHYSICS.smooth },
      { t: dur, value: to, easing: 'bezier', bezier: PHYSICS.smooth },
    ]);
    count += 1;
  }
  return count;
}
