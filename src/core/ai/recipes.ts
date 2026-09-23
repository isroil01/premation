/**
 * Motion recipes (Phase B & C) — After Effects-level 3D animation procedures, encoded.
 *
 * Each recipe is a pure procedure that lays out and animates an element with real 3D depth,
 * 3D camera sweeps, staggered entrances, overshoot easings, glow, and 3D rotations —
 * using the design tokens (design.ts).
 *
 * Rule 0 from `toolHandlers.ts` applies here too and for the same reason: a
 * write goes through a `SceneGraph` setter, never into `getNode(id).components`,
 * which is a copy rebuilt for that read. The radial burst and the path morph
 * were both written the wrong way and both produced nothing.
 */

import type { ToolContext } from '@motion/ai-tools';
import { set3DEnabled } from '@core/scene/threeD';
import { PHYSICS, type Bezier, type MotionStyle } from './design';
import { addPathOp, defaultPathOp, newPathOpId, pathOpPropPath, updateRepeaterOp } from '@core/scene/pathOps';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultPolystar, setNodePolystar } from '@core/scene/polystar';
import { measureTextNodeBoxes } from '@core/text/measureText';
import { getTimelineController } from '@core/timeline/TimelineController';
import { activeSceneWindow, nextSceneElementStart, beginSceneWindow } from './sceneWindow';
import { applyEntrance, nonUniformStagger, type EntranceArchetype } from './archetypes';

type KfPoint = { t: number; value: number; easing?: string; bezier?: Bezier };

/** Author keyframes in COMPOSITION time (the engine converts per node), value + easing together. */
async function kf(ctx: ToolContext, nodeId: string, prop: string, points: KfPoint[]): Promise<void> {
  for (const p of points) {
    // Composition seconds; the engine converts value AND easing to the layer's axis.
    await ctx.anim.setKeyframe(nodeId, prop, p.t, p.value, p.easing ?? 'easeOut');
    if (p.easing === 'bezier' && p.bezier) await ctx.anim.setBezier(nodeId, prop, p.t, p.bezier);
  }
}

/** Auto-stagger. Inside an active scene, entrances offset from the SCENE start
 *  (so scene 3 begins at its own window, not t≈0); otherwise the legacy
 *  single-scene behaviour (offset from 0, capped 1.3s). */
async function nextStartAt(ctx: ToolContext, s: MotionStyle): Promise<number> {
  const scened = nextSceneElementStart(s.staggerSec);
  if (scened !== null) return scened;
  const animated = (await ctx.scene.all()).filter((n) => n.animated.length > 0).length;
  return Math.min(animated * s.staggerSec, 1.3);
}

/**
 * Start a layer's timeline bar at `startSec` — the layer does not EXIST before
 * it, which is a stronger statement than "its opacity is 0 before it".
 *
 * Scene membership used to be opacity alone, and for a `cut` that failed
 * outright: the two keys that make an instant 0→100 sat 1 ms apart, keyframe
 * times snap to the frame grid, so they merged into a single 100 and Scene 2's
 * background was opaque from t=0 — covering every earlier scene for its whole
 * length. A trimmed in-point cannot collapse that way, and it is also what an
 * editor would do by hand (and what the timeline then shows: bars that tile).
 *
 * TRIM, not move: `Clip.trimStart` shifts `sourceIn` with `start`, so the
 * layer's keyframe axis stays equal to composition time and every `await kf()` in
 * this file keeps meaning what it says. Moving the bar would slide the axis.
 *
 * The bar is mirrored from the scene lazily (`syncFromScene`), so it is synced
 * here first — a layer created one line ago has none yet. Returns false when
 * there is no timeline to trim (headless runs, unit tests); callers keep their
 * opacity keys as the fallback, which is why those are still written.
 */
function setLayerInPoint(nodeId: string, startSec: number): boolean {
  if (!(startSec > 0)) return false;
  const tl = getTimelineController();
  tl.syncFromScene(tl.compIdForNode(nodeId));
  const bars = tl.getLayersForNode(nodeId);
  const first = bars[0];
  if (!first) return false;
  tl.trimClipTo(first.id, 'start', startSec);
  return true;
}

/** If a scene window is open, fade + drift this element OUT near the scene's
 *  end, so its content clears before the next scene — the thing that makes
 *  scenes read as separate. No-op outside a scene (single-shot holds to end).
 *  Also pins the element's in-point to the scene start, so nothing of scene N
 *  is live during scene N-1 whatever its entrance keys evaluate to there. */
async function applySceneExit(ctx: ToolContext, id: string, cy: number): Promise<void> {
  const w = activeSceneWindow();
  if (!w) return;
  setLayerInPoint(id, w.startSec);
  const out = Math.min(w.transitionSec, 0.5);
  const exitAt = Math.max(w.startSec + 0.2, w.endSec - out);
  await kf(ctx, id, 'opacity', [
    { t: exitAt, value: 100, easing: 'easeIn' },
    { t: w.endSec, value: 0, easing: 'easeIn' },
  ]);
  await kf(ctx, id, 'y', [
    { t: exitAt, value: cy, easing: 'easeIn' },
    { t: w.endSec, value: cy - 24, easing: 'easeIn' },
  ]);
}

// The old canonical entrance (fade + rise + 3D tilt) is now ONE archetype of
// six — see archetypes.ts. Recipes call applyEntrance, which varies the
// archetype by role, style personality and the per-run seed (or honours an
// explicit `entrance` request from the tool call).

async function addGlow(ctx: ToolContext, id: string, amount: number): Promise<void> {
  const fx = await ctx.scene.addEffect(id, 'glow');
  if (fx) await ctx.scene.updateEffect(id, fx, amount);
}

/** Full-comp background solid positioned at deep Z depth (z=500) for real 3D parallax. */
export async function recipeBackground(ctx: ToolContext, s: MotionStyle, color?: string): Promise<string> {
  const comp = await ctx.comp.get();
  const id = await ctx.scene.create('solid', 'Background', { x: comp.width / 2, y: comp.height / 2 });
  await ctx.scene.setProp(id, 'width', comp.width);
  await ctx.scene.setProp(id, 'height', comp.height);
  await ctx.scene.setProp(id, 'fill', color ?? s.palette.bg);
  set3DEnabled(id, true);
  await kf(ctx, id, 'z', [
    { t: 0, value: 500, easing: 'linear' },
    { t: comp.durationSeconds, value: 550, easing: 'linear' },
  ]);
  await kf(ctx, id, 'scale', [
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
export async function recipeScene(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { index: number; startSec: number; durationSec: number; background?: string; transition?: 'dissolve' | 'cut' },
): Promise<string> {
  const comp = await ctx.comp.get();
  const startSec = Math.max(0, opts.startSec);
  const endSec = Math.min(comp.durationSeconds, startSec + Math.max(0.3, opts.durationSec));
  const trans = opts.transition === 'cut' ? 0 : 0.4;
  beginSceneWindow(opts.index, startSec, endSec, trans || 0.35);

  const id = await ctx.scene.create('solid', `Scene ${opts.index} BG`, { x: comp.width / 2, y: comp.height / 2 });
  await ctx.scene.setProp(id, 'width', comp.width);
  await ctx.scene.setProp(id, 'height', comp.height);
  await ctx.scene.setProp(id, 'fill', opts.background ?? s.palette.bg);
  // The scene's layers are not live before the scene: the in-point is the
  // authority, for EVERY transition type (see setLayerInPoint).
  const atStart = startSec <= 0.02;
  if (!atStart) setLayerInPoint(id, startSec);
  // Opacity window: the first scene is opaque from frame 0; later scenes fade
  // in over `trans` (dissolve) and then hold — the previous scene's background
  // sits underneath and is revealed only while this one is transparent.
  if (atStart) {
    await kf(ctx, id, 'opacity', [{ t: 0, value: 100, easing: 'linear' }]);
  } else if (trans > 0) {
    await kf(ctx, id, 'opacity', [
      { t: startSec, value: 0, easing: 'easeInOut' },
      { t: startSec + trans, value: 100, easing: 'easeInOut' },
    ]);
  } else {
    // A cut. The old pair was (start − 1 ms → 0, start → 100): closer than one
    // frame, so the snap merged them into a lone 100 and the background was
    // opaque for the whole composition. One WHOLE frame apart with a hold is
    // the same instant jump and survives the snap — kept as the fallback for
    // when there is no timeline bar to trim.
    const frame = 1 / (comp.fps || 30);
    await kf(ctx, id, 'opacity', [
      { t: Math.max(0, startSec - frame), value: 0, easing: 'hold' },
      { t: startSec, value: 100, easing: 'linear' },
    ]);
  }
  return id;
}

/**
 * A full-frame fade-through-black (or white flash) centred at `atSec` — hard
 * punctuation between acts. Build it AFTER the scenes so it sits on top of
 * everything and actually covers the cut.
 */
export async function recipeTransition(
  ctx: ToolContext,
  opts: { atSec: number; kind?: 'fade_black' | 'flash'; durationSec?: number },
): Promise<string> {
  const comp = await ctx.comp.get();
  const dur = Math.max(0.2, opts.durationSec ?? 0.5);
  const half = dur / 2;
  const id = await ctx.scene.create('solid', 'Transition', { x: comp.width / 2, y: comp.height / 2 });
  await ctx.scene.setProp(id, 'width', comp.width);
  await ctx.scene.setProp(id, 'height', comp.height);
  await ctx.scene.setProp(id, 'fill', opts.kind === 'flash' ? '#ffffff' : '#000000');
  await kf(ctx, id, 'opacity', [
    { t: Math.max(0, opts.atSec - half), value: 0, easing: 'easeInOut' },
    { t: opts.atSec, value: 100, easing: 'easeInOut' },
    { t: opts.atSec + half, value: 0, easing: 'easeInOut' },
  ]);
  return id;
}

/** Compute dynamic vertical position based on existing text layers to avoid visual overlap. */
async function computeDynamicY(ctx: ToolContext, level: 'title' | 'subtitle' | 'tagline', requestedY?: number): Promise<number> {
  if (requestedY !== undefined) return requestedY;
  const comp = await ctx.comp.get();
  const existingTexts = (await ctx.scene.all()).filter((n) => n.kind === 'text');
  if (!existingTexts.length) {
    return level === 'title' ? comp.height * 0.42 : level === 'subtitle' ? comp.height * 0.56 : comp.height * 0.65;
  }

  let lastY = comp.height * 0.40;
  let lastFontSize = 64;
  for (const n of existingTexts) {
    if (n.y >= lastY) {
      lastY = n.y;
      lastFontSize = n.fontSize ?? 48;
    }
  }

  const gap = Math.max(28, Math.round(lastFontSize * 0.75));
  return Math.min(comp.height * 0.85, lastY + gap);
}

/** A 3D title / subtitle / tagline, positioned in 3D space with spatial Z depth. */
export async function recipeText(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { text: string; level: 'title' | 'subtitle' | 'tagline'; y?: number; entrance?: EntranceArchetype },
): Promise<string> {
  const comp = await ctx.comp.get();
  const cx = comp.width / 2;
  const cy = await computeDynamicY(ctx, opts.level, opts.y);
  const px = opts.level === 'title' ? s.type.titlePx : opts.level === 'subtitle' ? s.type.subtitlePx : s.type.taglinePx;

  const id = await ctx.scene.create('text', opts.text.slice(0, 24) || opts.level, { x: cx, y: cy });
  await ctx.scene.setProp(id, 'content', opts.text);
  await ctx.scene.setProp(id, 'fontSize', px);
  await ctx.scene.setProp(id, 'fontWeight', opts.level === 'title' ? s.type.weightTitle : s.type.weightBody);
  await ctx.scene.setProp(id, 'fill', opts.level === 'title' ? s.palette.fg : s.palette.muted);

  // Position at distinct Z-depth for 3D parallax (3D switch needed for the z track)
  set3DEnabled(id, true);
  const zDepth = opts.level === 'title' ? -80 : opts.level === 'subtitle' ? -40 : 0;
  await kf(ctx, id, 'z', [{ t: 0, value: zDepth }]);

  await applyEntrance(ctx, id, (await nextStartAt(ctx, s)), s, cy, { archetype: opts.entrance, role: opts.level });
  if (s.glow && opts.level === 'title') await addGlow(ctx, id, 18);
  await applySceneExit(ctx, id, cy);
  return id;
}

/** A glowing circular 3D emblem that flips in on 3D Y-axis with overshoot, then pulses. */
export async function recipeEmblem(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { y?: number; size?: number; entrance?: EntranceArchetype },
): Promise<string> {
  const comp = await ctx.comp.get();
  const d = opts.size ?? Math.round(Math.min(comp.width, comp.height) * 0.16);
  const cx = comp.width / 2;
  const cy = opts.y ?? comp.height * 0.3;

  const id = await ctx.scene.create('shape', 'Emblem', { x: cx, y: cy });
  await ctx.scene.setProp(id, 'shapeType', 'ellipse');
  await ctx.scene.setProp(id, 'width', d);
  await ctx.scene.setProp(id, 'height', d);
  await ctx.scene.setProp(id, 'fill', s.palette.accent);
  set3DEnabled(id, true);
  await kf(ctx, id, 'z', [{ t: 0, value: 0 }]);

  const start = (await nextStartAt(ctx, s));
  if (opts.entrance) {
    // Explicit archetype requested — use it instead of the signature flip.
    await applyEntrance(ctx, id, start, s, cy, { archetype: opts.entrance, role: 'emblem' });
  } else {
    await kf(ctx, id, 'opacity', [
      { t: start, value: 0, easing: 'easeOut' },
      { t: start + s.entranceDur * 0.5, value: 100, easing: 'easeOut' },
    ]);
    // 3D Y-axis flip entrance with spring overshoot
    await kf(ctx, id, 'rotationY', [
      { t: start, value: 90, easing: 'bezier', bezier: PHYSICS.overshoot },
      { t: start + s.entranceDur, value: 0, easing: 'bezier', bezier: PHYSICS.overshoot },
    ]);
    await kf(ctx, id, 'scale', [
      { t: start, value: 0.6, easing: 'bezier', bezier: PHYSICS.overshoot },
      { t: start + s.entranceDur, value: 1, easing: 'bezier', bezier: PHYSICS.overshoot },
    ]);
  }
  const p = start + s.entranceDur + 0.35;
  await kf(ctx, id, 'scale', [
    { t: p, value: 1, easing: 'easeInOut' },
    { t: p + 0.5, value: 1.045, easing: 'easeInOut' },
    { t: p + 1.0, value: 1, easing: 'easeInOut' },
  ]);
  if (s.glow) await addGlow(ctx, id, 28);
  await applySceneExit(ctx, id, cy);
  return id;
}

/** A centred row of evenly-spaced 3D cards that rotate and stagger in. */
export async function recipeCards(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { count?: number; y?: number; entrance?: EntranceArchetype },
): Promise<string[]> {
  const comp = await ctx.comp.get();
  const n = Math.max(1, Math.min(opts.count ?? 3, 8));
  const cy = opts.y ?? comp.height * 0.5;
  const gap = comp.width * 0.03;
  const cardW = Math.min((comp.width * 0.82 - gap * (n - 1)) / n, comp.width * 0.24);
  const cardH = Math.round(cardW * 1.3);
  const totalW = cardW * n + gap * (n - 1);
  const firstX = comp.width / 2 - totalW / 2 + cardW / 2;
  const base = (await nextStartAt(ctx, s));
  // Deliberate asymmetry: a breathing (non-uniform) stagger, and ONE accent
  // card — the centre — that travels further than its siblings.
  const offsets = nonUniformStagger(n, s.staggerSec);
  const accent = Math.floor((n - 1) / 2);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = firstX + i * (cardW + gap);
    const id = await ctx.scene.create('shape', `Card ${i + 1}`, { x, y: cy });
    await ctx.scene.setProp(id, 'shapeType', 'rect');
    await ctx.scene.setProp(id, 'width', Math.round(cardW));
    await ctx.scene.setProp(id, 'height', cardH);
    await ctx.scene.setProp(id, 'fill', s.palette.card);
    set3DEnabled(id, true);

    // 3D fan perspective & depth stagger
    const centerOffset = i - (n - 1) / 2;
    const cardZ = -35 * (1 - Math.abs(centerOffset) * 0.4);
    const startRotY = centerOffset * -16;
    const start = base + (offsets[i] ?? i * s.staggerSec);

    await kf(ctx, id, 'z', [{ t: 0, value: cardZ }]);
    await kf(ctx, id, 'rotationY', [
      { t: start, value: startRotY, easing: 'bezier', bezier: s.entranceCurve },
      { t: start + s.entranceDur, value: startRotY * 0.25, easing: 'bezier', bezier: s.entranceCurve },
    ]);
    await applyEntrance(ctx, id, start, s, cy, {
      archetype: opts.entrance,
      role: 'card',
      // All cards in a row share ONE archetype (index 0) — a row where every
      // card enters differently reads as noise, not design. The accent card
      // stands out by travel, not by archetype.
      index: 0,
      travelScale: i === accent ? 1.6 : 1,
    });
    await applySceneExit(ctx, id, cy);
    ids.push(id);
  }
  return ids;
}

/** Apply a staggered entrance to layers that already exist. */
export async function recipeStaggerIn(
  ctx: ToolContext,
  s: MotionStyle,
  nodeIds: string[],
  entrance?: EntranceArchetype,
): Promise<number> {
  const offsets = nonUniformStagger(nodeIds.length, s.staggerSec);
  let i = 0;
  for (const id of nodeIds) {
    const v = await ctx.scene.get(id);
    if (!v) continue;
    // One shared archetype per group (index 0); the FIRST element leads with
    // extra travel so the group has a visible protagonist.
    await applyEntrance(ctx, id, offsets[i] ?? i * s.staggerSec, s, v.y, {
      archetype: entrance,
      role: 'generic',
      index: 0,
      travelScale: i === 0 ? 1.5 : 1,
    });
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
export async function recipeKineticText(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { text: string; y?: number; fontSize?: number },
): Promise<string[]> {
  const comp = await ctx.comp.get();
  const words = opts.text.trim().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!words.length) return [];
  const px = opts.fontSize ?? (words.length > 4 ? s.type.subtitlePx * 1.6 : s.type.titlePx * 0.8);
  const cy = opts.y ?? comp.height * 0.5;
  const base = (await nextStartAt(ctx, s));
  const beat = Math.max(s.staggerSec, 0.1);
  // Words land on a breathing beat, not a metronome.
  const beatOffsets = nonUniformStagger(words.length, beat);

  // Pass 1 — make every word REAL before laying any of them out, because the
  // only honest width of a word is the one the renderer's own measurer reports
  // for that node (its font, weight, size, tracking).
  const ids: string[] = [];
  for (const word of words) {
    const id = await ctx.scene.create('text', word.slice(0, 24), { x: comp.width / 2, y: cy });
    await ctx.scene.setProp(id, 'content', word);
    await ctx.scene.setProp(id, 'fontSize', Math.round(px));
    await ctx.scene.setProp(id, 'fontWeight', s.type.weightTitle);
    await ctx.scene.setProp(id, 'fill', s.palette.fg);
    ids.push(id);
  }

  /**
   * Pass 2 — measure, then set the line like a typesetter.
   *
   * This estimated every word at `chars × 0.56em` and put a fixed 0.42em
   * between them. Both are wrong per word: "frame" and "tells" are five letters
   * each and nowhere near the same width, so each estimated slot was wider or
   * narrower than its word by a different amount, and since a word is centred in
   * its slot the error showed up as the GAPS — "Every frame  tells  a story".
   * The real advance removes the per-word error, and the gap is the font's own
   * space: the advance of "x x" minus "xx", which is what a space adds between
   * two glyphs in this exact style (a lone " " is not safe to measure — a
   * measurer is free to trim it).
   */
  const advanceOf = (id: string, content?: string): number | null => {
    const node = defaultSceneGraph.getNode(id);
    const m = node ? measureTextNodeBoxes(node, content !== undefined ? { content } : undefined) : null;
    return m && m.advance > 0 ? m.advance : null;
  };
  const wordW = words.map((w, i) => advanceOf(ids[i]!) ?? Math.max(1, w.length) * px * 0.56);
  const spaced = advanceOf(ids[0]!, 'x x');
  const tight = advanceOf(ids[0]!, 'xx');
  // No canvas to measure with (headless): a typical grotesque's space, ~0.28em.
  const gap = spaced !== null && tight !== null && spaced > tight ? spaced - tight : px * 0.28;
  const totalW = wordW.reduce((a, b) => a + b, 0) + gap * (words.length - 1);
  let cursor = comp.width / 2 - totalW / 2;

  for (let i = 0; i < words.length; i++) {
    const w = wordW[i] ?? px;
    const cx = cursor + w / 2;
    cursor += w + gap;
    const id = ids[i]!;
    await ctx.scene.setProp(id, 'x', cx);
    const t0 = base + (beatOffsets[i] ?? i * beat);
    await kf(ctx, id, 'opacity', [
      { t: t0, value: 0, easing: 'easeOut' },
      { t: t0 + 0.18, value: 100, easing: 'easeOut' },
    ]);
    await kf(ctx, id, 'scale', [
      { t: t0, value: 0.4, easing: 'bezier', bezier: PHYSICS.overshoot },
      { t: t0 + 0.42, value: 1, easing: 'bezier', bezier: PHYSICS.overshoot },
    ]);
    await kf(ctx, id, 'y', [
      { t: t0, value: cy + px * 0.3, easing: 'bezier', bezier: PHYSICS.overshoot },
      { t: t0 + 0.42, value: cy, easing: 'bezier', bezier: PHYSICS.overshoot },
    ]);
    await applySceneExit(ctx, id, cy);
  }
  return ids;
}

/**
 * A soft diagonal light bar that sweeps across the frame once — the classic
 * "premium sheen" beat. Blurred, low-opacity, timed to pass after the content
 * has entered.
 */
export async function recipeLightSweep(ctx: ToolContext, s: MotionStyle, opts: { at?: number } = {}): Promise<string> {
  const comp = await ctx.comp.get();
  const cy = comp.height / 2;
  const startX = -comp.width * 0.25;
  const endX = comp.width * 1.25;
  const id = await ctx.scene.create('shape', 'Light Sweep', { x: startX, y: cy });
  await ctx.scene.setProp(id, 'shapeType', 'rect');
  await ctx.scene.setProp(id, 'width', Math.round(comp.width * 0.16));
  await ctx.scene.setProp(id, 'height', Math.round(comp.height * 1.8));
  await ctx.scene.setProp(id, 'fill', '#ffffff');
  await ctx.scene.setProp(id, 'rotation', 18);
  const blurFx = await ctx.scene.addEffect(id, 'blur');
  if (blurFx) await ctx.scene.updateEffect(id, blurFx, 26);
  const t0 = opts.at ?? (await nextStartAt(ctx, s)) + 0.55;
  const dur = 0.9;
  await kf(ctx, id, 'x', [
    { t: t0, value: startX, easing: 'bezier', bezier: PHYSICS.smooth },
    { t: t0 + dur, value: endX, easing: 'bezier', bezier: PHYSICS.smooth },
  ]);
  await kf(ctx, id, 'opacity', [
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
export async function recipeFloatingOrbs(ctx: ToolContext, s: MotionStyle, opts: { count?: number } = {}): Promise<string[]> {
  const comp = await ctx.comp.get();
  const n = Math.max(2, Math.min(opts.count ?? 5, 10));
  const minDim = Math.min(comp.width, comp.height);
  const ids: string[] = [];
  const frac = (v: number) => v - Math.floor(v);
  for (let i = 0; i < n; i++) {
    const x = comp.width * (0.12 + 0.76 * frac((i + 1) * 0.618));
    const y = comp.height * (0.15 + 0.7 * frac((i + 1) * 0.381));
    const d = Math.round(minDim * (0.06 + (i % 3) * 0.035));
    const id = await ctx.scene.create('shape', `Orb ${i + 1}`, { x, y });
    await ctx.scene.setProp(id, 'shapeType', 'ellipse');
    await ctx.scene.setProp(id, 'width', d);
    await ctx.scene.setProp(id, 'height', d);
    await ctx.scene.setProp(id, 'fill', i % 2 === 0 ? s.palette.accent : s.palette.bgAccent);
    const blurFx = await ctx.scene.addEffect(id, 'blur');
    if (blurFx) await ctx.scene.updateEffect(id, blurFx, 18);
    set3DEnabled(id, true);
    await kf(ctx, id, 'z', [{ t: 0, value: 180 + i * 55 }]);
    // Slow vertical drift, alternating direction so the field feels alive.
    const drift = (i % 2 === 0 ? -1 : 1) * (28 + (i % 3) * 10);
    await kf(ctx, id, 'y', [
      { t: 0, value: y, easing: 'easeInOut' },
      { t: comp.durationSeconds, value: y + drift, easing: 'easeInOut' },
    ]);
    await kf(ctx, id, 'opacity', [{ t: 0, value: 22 + (i % 3) * 8 }]);
    ids.push(id);
  }
  return ids;
}

/**
 * A broadcast-style lower third: accent bar + title + optional subtitle in the
 * lower-left, sliding in from the left with the bar growing first.
 */
export async function recipeLowerThird(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { title: string; subtitle?: string },
): Promise<string[]> {
  const comp = await ctx.comp.get();
  const marginX = comp.width * 0.08;
  const baseY = comp.height * 0.82;
  const titlePx = Math.round(s.type.subtitlePx * 1.25);
  const subPx = s.type.taglinePx;
  const t0 = (await nextStartAt(ctx, s));
  const ids: string[] = [];

  // Accent bar grows vertically first — it "opens" the lower third.
  const barH = Math.round(titlePx * (opts.subtitle ? 2.4 : 1.5));
  const bar = await ctx.scene.create('shape', 'LT Bar', { x: marginX, y: baseY });
  await ctx.scene.setProp(bar, 'shapeType', 'rect');
  await ctx.scene.setProp(bar, 'width', 8);
  await ctx.scene.setProp(bar, 'height', barH);
  await ctx.scene.setProp(bar, 'fill', s.palette.accent);
  await kf(ctx, bar, 'scale', [
    { t: t0, value: 0, easing: 'bezier', bezier: s.entranceCurve },
    { t: t0 + 0.35, value: 1, easing: 'bezier', bezier: s.entranceCurve },
  ]);
  await kf(ctx, bar, 'opacity', [
    { t: t0, value: 0, easing: 'easeOut' },
    { t: t0 + 0.2, value: 100, easing: 'easeOut' },
  ]);
  ids.push(bar);

  // Text slides in from behind the bar (left → resting) with a small delay.
  const place = async (text: string, px: number, weight: number, fill: string, y: number, delay: number): Promise<string> => {
    const approxW = Math.max(1, text.length) * px * 0.56;
    const restX = marginX + 26 + approxW / 2;
    const id = await ctx.scene.create('text', text.slice(0, 24), { x: restX, y });
    await ctx.scene.setProp(id, 'content', text);
    await ctx.scene.setProp(id, 'fontSize', px);
    await ctx.scene.setProp(id, 'fontWeight', weight);
    await ctx.scene.setProp(id, 'fill', fill);
    await kf(ctx, id, 'x', [
      { t: t0 + delay, value: restX - 56, easing: 'bezier', bezier: s.entranceCurve },
      { t: t0 + delay + s.entranceDur * 0.8, value: restX, easing: 'bezier', bezier: s.entranceCurve },
    ]);
    await kf(ctx, id, 'opacity', [
      { t: t0 + delay, value: 0, easing: 'easeOut' },
      { t: t0 + delay + 0.3, value: 100, easing: 'easeOut' },
    ]);
    return id;
  };
  const titleY = opts.subtitle ? baseY - titlePx * 0.45 : baseY;
  ids.push(await place(opts.title, titlePx, s.type.weightTitle, s.palette.fg, titleY, 0.12));
  if (opts.subtitle) {
    ids.push(await place(opts.subtitle, subPx, s.type.weightBody, s.palette.muted, baseY + subPx * 0.9, 0.22));
  }
  for (const id of ids) {
    const v = await ctx.scene.get(id);
    if (v) await applySceneExit(ctx, id, v.y);
  }
  return ids;
}

/**
 * A slow, continuous push-in (or pull-out) that makes a hero shot feel alive.
 *
 * A REAL 3D CAMERA MOVE. Every shape/text/image layer gets its 3D switch on (a
 * camera moves nothing until content is 3D), the comp's first camera is reused
 * — or a "3D Camera" layer is created — and that camera is keyframed across the
 * move: a dolly in `z` (−2200 → −1350 for a push, −1200 → −2200 for a pull)
 * plus a small `orbitYaw` arc (−8° → 8°, or 6° → −6°), so layers at different
 * depths parallax against each other instead of reading as a flat zoom. Layer
 * scale is not touched, so a layer's own scale entrance or pulse never fights
 * the move.
 *
 * Note — why the dolly stays well short of the comp plane: an earlier version
 * of this recipe avoided the camera entirely (a per-layer scale ramp) because a
 * camera pushed THROUGH 3D content culls whatever falls past its frustum — a
 * scene-3 emblem vanishing near the end of a multi-scene video. The camera
 * never comes closer than 1200px to z = 0, which keeps content sitting on or
 * near the plane in view; a layer already placed that far toward the camera in
 * z can still end up behind it.
 *
 * Returns the number of CONTENT layers moved, separately from the camera, so a
 * caller's count never includes the camera itself.
 */
export async function recipeCameraMove(
  ctx: ToolContext,
  opts: { kind?: 'push_in' | 'pull_out'; durationSec?: number },
): Promise<{ layers: number; cameraId: string; createdCamera: boolean }> {
  const comp = await ctx.comp.get();
  const dur = opts.durationSec ?? comp.durationSeconds;
  const isPull = opts.kind === 'pull_out';

  // 1. Enable 3D on all content nodes for real spatial parallax
  const targets = (await ctx.scene.all())
    .filter((n) => n.kind === 'shape' || n.kind === 'text' || n.kind === 'image');

  for (const n of targets) {
    set3DEnabled(n.id, true);
  }

  // 2. Find or create a dedicated 3D Camera layer
  let camId = (await ctx.scene.all()).find((n) => n.kind === 'camera')?.id;
  const createdCamera = !camId;
  if (!camId) {
    camId = await ctx.scene.create('camera', '3D Camera');
  }

  const startZ = isPull ? -1200 : -2200;
  const endZ = isPull ? -2200 : -1350;

  // 3. Animate 3D dolly (Z position) and 3D parallax orbit sweep (orbitYaw)
  await kf(ctx, camId, 'z', [
    { t: 0, value: startZ, easing: 'bezier', bezier: PHYSICS.smooth },
    { t: dur, value: endZ, easing: 'bezier', bezier: PHYSICS.smooth },
  ]);

  await kf(ctx, camId, 'orbitYaw', [
    { t: 0, value: isPull ? 6 : -8, easing: 'bezier', bezier: PHYSICS.smooth },
    { t: dur, value: isPull ? -6 : 8, easing: 'bezier', bezier: PHYSICS.smooth },
  ]);

  return { layers: targets.length, cameraId: camId, createdCamera };
}

/**
 * A After Effects-style stroke trim-path logo reveal: shape outline draws in,
 * followed by glowing emblem pop and title entrance.
 */
export async function recipeLogoReveal(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { text: string; shape?: 'ellipse' | 'star' | 'rect' },
): Promise<string[]> {
  const comp = await ctx.comp.get();
  const cx = comp.width / 2;
  const cy = comp.height * 0.4;
  const d = Math.round(Math.min(comp.width, comp.height) * 0.2);
  const start = (await nextStartAt(ctx, s));
  const ids: string[] = [];

  // 1. Outline Trim-Path Shape
  const outline = await ctx.scene.create('shape', 'Trim Outline', { x: cx, y: cy });
  await ctx.scene.setProp(outline, 'shapeType', opts.shape ?? 'ellipse');
  await ctx.scene.setProp(outline, 'width', d);
  await ctx.scene.setProp(outline, 'height', d);
  await ctx.scene.setProp(outline, 'fill', 'transparent');
  await ctx.scene.setProp(outline, 'stroke', s.palette.accent);
  await ctx.scene.setProp(outline, 'strokeWidth', 4);
  set3DEnabled(outline, true);
  
  // Trim path draw-in keyframes
  await kf(ctx, outline, 'trimStart', [
    { t: start, value: 0, easing: 'bezier', bezier: PHYSICS.softOut },
    { t: start + 0.75, value: 100, easing: 'bezier', bezier: PHYSICS.softOut },
  ]);
  await kf(ctx, outline, 'opacity', [
    { t: start, value: 0, easing: 'easeOut' },
    { t: start + 0.2, value: 100, easing: 'easeOut' },
  ]);
  ids.push(outline);

  // 2. Inner Emblem Pop
  const emblem = await ctx.scene.create('shape', 'Logo Emblem', { x: cx, y: cy });
  await ctx.scene.setProp(emblem, 'shapeType', opts.shape ?? 'ellipse');
  await ctx.scene.setProp(emblem, 'width', Math.round(d * 0.65));
  await ctx.scene.setProp(emblem, 'height', Math.round(d * 0.65));
  await ctx.scene.setProp(emblem, 'fill', s.palette.accent);
  set3DEnabled(emblem, true);

  const tEmblem = start + 0.45;
  await kf(ctx, emblem, 'scale', [
    { t: tEmblem, value: 0.3, easing: 'bezier', bezier: PHYSICS.overshoot },
    { t: tEmblem + 0.5, value: 1, easing: 'bezier', bezier: PHYSICS.overshoot },
  ]);
  await kf(ctx, emblem, 'opacity', [
    { t: tEmblem, value: 0, easing: 'easeOut' },
    { t: tEmblem + 0.25, value: 100, easing: 'easeOut' },
  ]);
  if (s.glow) await addGlow(ctx, emblem, 32);
  ids.push(emblem);

  // 3. Title entrance
  const titleY = comp.height * 0.64;
  const title = await ctx.scene.create('text', opts.text.slice(0, 24) || 'Title', { x: cx, y: titleY });
  await ctx.scene.setProp(title, 'content', opts.text);
  await ctx.scene.setProp(title, 'fontSize', s.type.titlePx);
  await ctx.scene.setProp(title, 'fontWeight', s.type.weightTitle);
  await ctx.scene.setProp(title, 'fill', s.palette.fg);
  set3DEnabled(title, true);

  const tTitle = start + 0.6;
  await applyEntrance(ctx, title, tTitle, s, titleY, { role: 'title' });
  ids.push(title);

  for (const id of ids) {
    await applySceneExit(ctx, id, cy);
  }

  return ids;
}

/**
 * A radial shape repeater burst — explosive motion graphics accent (HUD / particle ring).
 */
export async function recipeRadialBurst(
  ctx: ToolContext,
  s: MotionStyle,
  opts: { count?: number; x?: number; y?: number; atSec?: number },
): Promise<string> {
  const comp = await ctx.comp.get();
  const cx = opts.x ?? comp.width / 2;
  const cy = opts.y ?? comp.height / 2;
  const copies = Math.max(4, Math.min(opts.count ?? 8, 16));
  const t0 = opts.atSec ?? (await nextStartAt(ctx, s));

  const id = await ctx.scene.create('shape', 'Radial Burst', { x: cx, y: cy });
  await ctx.scene.setProp(id, 'shapeType', 'ellipse');
  await ctx.scene.setProp(id, 'width', 16);
  await ctx.scene.setProp(id, 'height', 16);
  await ctx.scene.setProp(id, 'fill', s.palette.accent);
  set3DEnabled(id, true);

  // A ring, not a stack. Three things have to be true at once and only one of
  // them used to be: the write has to reach the engine (`updateRepeaterOp`, not
  // a `.props` assignment into a copy `getNode` rebuilt for this read), the
  // field names have to be the ones the repeater OPERATOR reads
  // (`offsetRotation`, not `rotation`), and the per-copy rotation has to pivot
  // about a RADIUS — at anchorX 0 every copy spins about its own origin and all
  // N land on the same 16px dot.
  const radius = 42;
  updateRepeaterOp(id, {
    copies,
    offsetX: 0,
    offsetY: 0,
    offsetRotation: 360 / copies,
    offsetScale: 1,
    offsetOpacity: 1,
    anchorX: radius,
    anchorY: 0,
  });

  await kf(ctx, id, 'scale', [
    { t: t0, value: 0.2, easing: 'bezier', bezier: PHYSICS.overshoot },
    { t: t0 + 0.55, value: 1.8, easing: 'bezier', bezier: PHYSICS.softOut },
  ]);
  await kf(ctx, id, 'opacity', [
    { t: t0, value: 100, easing: 'easeOut' },
    { t: t0 + 0.55, value: 0, easing: 'easeIn' },
  ]);

  return id;
}

export interface PathMorphResult {
  id: string;
  opId: string;
  /** The keyframed track, `pathop.<opId>.amount`. */
  prop: string;
  /** True when the recipe built its own layer (no `nodeId` was given). */
  created: boolean;
  startSec: number;
  endSec: number;
}

/**
 * Organic shape morphing distortion (pucker/bloat / zigzag) — the outline MOVES
 * between two amounts of the operator.
 *
 * Two things this used to get wrong. It always built its own layer — a dark
 * `palette.card` star parked at comp centre, on top of the stack — so asked to
 * morph a shape the caller already had, it left that shape untouched and
 * covered it. And the "morph" did not morph: the operator's `amount` was a
 * constant and the only thing keyframed was the layer's rotation. Now the
 * target is `opts.nodeId` when given (its own fill, position and stacking are
 * left alone — only an operator and its `amount` track are added), and the
 * amount is keyframed `fromAmount → amount`, optionally back.
 */
export async function recipePathMorph(
  ctx: ToolContext,
  s: MotionStyle,
  opts: {
    nodeId?: string;
    op?: 'puckerBloat' | 'zigzag';
    amount?: number;
    fromAmount?: number;
    startSec?: number;
    durationSec?: number;
    pingPong?: boolean;
    fill?: string;
    x?: number;
    y?: number;
  },
): Promise<PathMorphResult> {
  const comp = await ctx.comp.get();
  const dur = Math.max(0.1, opts.durationSec ?? 1.2);
  const opType = opts.op ?? 'puckerBloat';
  const amount = opts.amount ?? 35;
  const from = opts.fromAmount ?? 0;
  const created = !opts.nodeId;
  // An existing layer morphs when the caller says (default: from the playhead
  // of the build, t=0); a layer made here joins the scene's entrance stagger.
  const t0 = opts.startSec ?? (created ? (await nextStartAt(ctx, s)) : 0);

  let id = opts.nodeId ?? '';
  if (created) {
    const cx = opts.x ?? comp.width / 2;
    const cy = opts.y ?? comp.height / 2;
    id = await ctx.scene.create('shape', 'Morph Shape', { x: cx, y: cy });
    // A PARAMETRIC star (see polystar.ts). `shapeType: 'star'` alone names a
    // primitive with no SDF and no Geometry, which renders as a square.
    await ctx.scene.setProp(id, 'shapeType', 'polystar');
    await ctx.scene.setProp(id, 'width', 160);
    await ctx.scene.setProp(id, 'height', 160);
    setNodePolystar(id, defaultPolystar('star', 80, 5));
    // The accent, not `palette.card`: the card colour is a near-background
    // panel tone, so the hero of this recipe was close to invisible on the
    // backgrounds the same style paints.
    await ctx.scene.setProp(id, 'fill', opts.fill ?? s.palette.accent);
    set3DEnabled(id, true);
  }

  // `fx.pathOps` is the operator CHAIN that replaced the single `fx.pathOp` slot
  // in document version 1.3.0, and the reader deliberately does not accept the
  // old shape. 'puckerBloat' is this recipe's public name for it; the engine
  // operator is 'pucker', and passing the alias straight through failed
  // `isPathOpType` and coerced the whole operator to 'none'.
  const opId = newPathOpId();
  addPathOp(id, {
    ...defaultPathOp(),
    id: opId,
    type: opType === 'puckerBloat' ? 'pucker' : 'zigzag',
    // The static value is the morph's END state, so a frame sampled outside
    // the keyframed span — or with the track deleted — still shows the shape.
    amount,
  });

  const prop = pathOpPropPath(opId, 'amount');
  const endSec = t0 + dur * (opts.pingPong ? 2 : 1);
  await kf(ctx, id, prop, [
    { t: t0, value: from, easing: 'bezier', bezier: PHYSICS.smooth },
    { t: t0 + dur, value: amount, easing: 'bezier', bezier: PHYSICS.smooth },
    ...(opts.pingPong ? [{ t: endSec, value: from, easing: 'bezier', bezier: PHYSICS.smooth }] : []),
  ]);

  if (created) {
    const cy = opts.y ?? comp.height / 2;
    await kf(ctx, id, 'rotation', [
      { t: t0, value: 0, easing: 'bezier', bezier: PHYSICS.smooth },
      { t: t0 + dur, value: 180, easing: 'bezier', bezier: PHYSICS.smooth },
    ]);
    await applyEntrance(ctx, id, t0, s, cy, { role: 'generic' });
    await applySceneExit(ctx, id, cy);
  }
  return { id, opId, prop, created, startSec: t0, endSec };
}
