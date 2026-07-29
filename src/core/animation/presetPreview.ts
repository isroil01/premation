/**
 * Animated preset previews.
 *
 * After Effects does not have these, and it is its single worst library UX
 * failure: the only way to find out what a preset does is to apply it, watch,
 * and undo. Third-party preset packs sell largely on having a preview gallery.
 *
 * The important design decision is that a preview is generated FROM THE PRESET,
 * not authored alongside it. The old panel keyed a CSS animation class off the
 * preset's NAME, which meant a preset without a matching hand-written class got
 * a grey dot — so the library could not grow without someone remembering to
 * write CSS for every entry. Here, a preset's own tracks and animators are
 * evaluated against a standard sample at a given time, and the result is drawn.
 * Add a preset, get a correct preview.
 *
 * Pure apart from the canvas draw: {@link samplePresetFrame} takes a preset and
 * a time and returns exactly what to paint, so the maths is testable without a
 * GPU or a DOM.
 */

import { compileExpression, sampleTrack } from '@motion/animation';
import type { AnimationPreset, PresetTrack } from './animationPresets';
import { fitRevealSweeps, resolvePresetUnits } from './animationPresets';
import type { PresetContext } from './presetUnits';
import {
  evaluateTextAnimators,
  normalizeAnimator,
  type GlyphTransform,
  type ResolvedAnimator,
  type SelectorData,
  type TextAnimatorData,
} from '@core/text/textAnimators';

/** The sample a preview animates. Small enough to read at thumbnail size, long
 *  enough that a per-character stagger is visibly a stagger. */
export const PREVIEW_TEXT = 'Motion Text';

/**
 * The comp a preview pretends to be in.
 *
 * Deliberately tiny: the whole point of relative units is that a preset scales,
 * so previewing at thumbnail size exercises that rather than hiding it. If a
 * preset looks wrong here it will look wrong in a 4K comp too.
 */
export const PREVIEW_CONTEXT: PresetContext = {
  compWidth: 220,
  compHeight: 90,
  layerWidth: 180,
  layerHeight: 40,
  fontSize: 22,
  layerDuration: 2,
};

/** What one preview frame looks like. */
export interface PresetFrame {
  /** Layer-level transform from the preset's non-animator tracks. */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  /** Per-glyph transforms, empty when the preset has no animators. */
  glyphs: GlyphTransform[];
}

/** The preview loop length: the preset's own span, floored so an instant
 *  preset still has a beat, and capped so a long one still loops watchably. */
export function previewDuration(preset: AnimationPreset): number {
  let max = 0;
  for (const t of preset.tracks) for (const k of t.keyframes) max = Math.max(max, k.t);
  // Behaviours have no keyframes at all yet never stop. Their loop length is
  // therefore arbitrary, and a short one flatters the fast ones while making
  // the slow ones look frozen — Drift wanders at 0.35 Hz, which is barely a
  // third of a cycle in 1.2s. Give them a window long enough to show their
  // character; duration-adaptive behaviours scale to it, since this is also
  // the `thisComp.duration` they are previewed against.
  if (preset.expressions && preset.expressions.length > 0 && max === 0) return 3;
  // A wiggly text selector is animated with no keyframes too, but its motion is
  // fast enough that the ordinary floor reads fine.
  return Math.min(4, Math.max(1.2, max + 0.4));
}

/** Read a preset track as a sampled value at `t`. */
function valueAt(track: PresetTrack, t: number): number | undefined {
  return sampleTrack({ keyframes: track.keyframes } as Parameters<typeof sampleTrack>[0], t);
}

/**
 * Resolve one preview frame.
 *
 * Deliberately mirrors what applying the preset would do — units resolve
 * against the preview context, animator prop-paths drive the animator stack,
 * and everything else drives the layer transform — so the preview cannot drift
 * from the thing it is previewing.
 */
export function samplePresetFrame(
  preset: AnimationPreset,
  t: number,
  ctx: PresetContext = PREVIEW_CONTEXT,
  text = PREVIEW_TEXT,
): PresetFrame {
  // Fit the reveal sweep to the sample string exactly as applying would fit it
  // to the layer's real text. Skipping this would make every preview pace
  // differently from the thing it is previewing.
  const fitted = fitRevealSweeps(preset, preset.tracks, text);
  const tracks = resolvePresetUnits(fitted, ctx, preset.timeUnit);

  const frame: PresetFrame = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, glyphs: [] };
  // prop-path → sampled value, for the animator resolution below.
  const av = new Map<string, number>();

  for (const track of tracks) {
    const v = valueAt(track, t);
    if (v === undefined) continue;
    if (track.prop.startsWith('ta.')) {
      av.set(track.prop, v);
      continue;
    }
    switch (track.prop) {
      case 'x': frame.x += v; break;
      case 'y': frame.y += v; break;
      case 'scale': frame.scale = v; break;
      case 'rotation': frame.rotation = v; break;
      case 'opacity': frame.opacity = v / 100; break;
      default: break;
    }
  }

  if (preset.animators && preset.animators.length) {
    const resolved = preset.animators.map((a, i) => resolveForPreview(a, i, av));
    frame.glyphs = evaluateTextAnimators(text, resolved, t);
  }

  applyBehaviorExpressions(preset, t, ctx, frame);
  return frame;
}

/** Property base values an expression sees as `value` when previewing. Matches
 *  what an untouched layer would carry. */
const PREVIEW_BASE: Record<string, number> = {
  x: 0, y: 0, scale: 1, rotation: 0, opacity: 100,
};

/**
 * Evaluate a behaviour preset's expressions for the preview frame.
 *
 * Without this, every behaviour would be a motionless card in a gallery whose
 * whole premise is that you can see what a preset does without applying it —
 * and behaviours are precisely the ones you cannot guess from a name.
 *
 * The comp handed to the expression has its `duration` set to the preview
 * LOOP length, so a duration-adaptive behaviour ("fade over the first and last
 * fifteen percent") fills the thumbnail exactly as it would fill a real
 * composition, rather than showing the first two seconds of a ten-second fade.
 */
function applyBehaviorExpressions(
  preset: AnimationPreset,
  t: number,
  ctx: PresetContext,
  frame: PresetFrame,
): void {
  if (!preset.expressions || preset.expressions.length === 0) return;
  const comp = {
    width: ctx.compWidth,
    height: ctx.compHeight,
    duration: previewDuration(preset),
    fps: 30,
    numLayers: 1,
  };
  // A thumbnail has no soundtrack, so an audio-reactive behaviour would sit
  // perfectly still — the one outcome a preview gallery must not produce, since
  // a motionless card says nothing at all. Feed a plausible beat so the card
  // demonstrates the RELATIONSHIP (scale follows level). The preset's own
  // description states it depends on the soundtrack, so this illustrates rather
  // than misleads.
  const audio = 0.5 + 0.5 * Math.sin(t * 7.5);

  for (const e of preset.expressions) {
    const base = PREVIEW_BASE[e.prop] ?? 0;
    let v: number | null = null;
    try {
      const res = compileExpression(e.expr).run({ time: t, value: base, comp, audio });
      const raw = res.value;
      v = typeof raw === 'number' ? raw : Array.isArray(raw) ? raw[0] ?? null : null;
    } catch {
      v = null; // a broken behaviour previews as inert, not as a crashed panel
    }
    if (v === null || !Number.isFinite(v)) continue;
    switch (e.prop) {
      case 'x': frame.x += v; break;
      case 'y': frame.y += v; break;
      case 'scale': frame.scale = v; break;
      case 'rotation': frame.rotation = v; break;
      case 'opacity': frame.opacity = v / 100; break;
      default: break;
    }
  }
}

/**
 * Resolve one animator for the preview.
 *
 * A local copy of the scene-backed resolver: that one reads from a SceneNode,
 * and a preview has no node. Kept small on purpose — it only has to understand
 * the prop-paths a preset can carry.
 */
function resolveForPreview(
  raw: TextAnimatorData,
  index: number,
  av: Map<string, number>,
): ResolvedAnimator {
  const d = normalizeAnimator(raw);
  const val = (param: string, fallback: number): number =>
    av.get(`ta.${index}.${param}`) ?? fallback;
  const selectors: SelectorData[] = (d.selectors ?? []).map((s, j) => {
    const out: Record<string, unknown> = { ...s };
    for (const key of Object.keys(out)) {
      if (typeof out[key] !== 'number') continue;
      // Selector 0's window params keep their legacy flat paths; the rest are
      // namespaced. Both are checked so either authoring style resolves.
      const flat = av.get(`ta.${index}.${key}`);
      const scoped = av.get(`ta.${index}.s${j}.${key}`);
      const v = scoped ?? (j === 0 ? flat : undefined);
      if (v !== undefined) out[key] = v;
    }
    return out as unknown as SelectorData;
  });
  return {
    enabled: d.enabled !== false,
    selectors,
    x: val('x', d.x),
    y: val('y', d.y),
    z: val('z', d.z ?? 0),
    scale: val('scale', d.scale),
    scaleY: val('scaleY', d.scaleY ?? d.scale),
    rotation: val('rotation', d.rotation),
    rotationX: val('rotationX', d.rotationX ?? 0),
    rotationY: val('rotationY', d.rotationY ?? 0),
    opacity: val('opacity', d.opacity),
    fillOpacity: val('fillOpacity', d.fillOpacity ?? 100),
    tracking: val('tracking', d.tracking),
    lineSpacing: val('lineSpacing', d.lineSpacing ?? 0),
    characterOffset: val('characterOffset', d.characterOffset ?? 0),
    blur: val('blur', d.blur ?? 0),
    skew: val('skew', d.skew ?? 0),
    strokeWidth: val('strokeWidth', d.strokeWidth ?? 0),
    color: d.color,
    strokeColor: d.strokeColor,
  };
}

/** Colours a preview draws with, so it tracks the app theme. */
export interface PreviewTheme {
  fg: string;
  dim: string;
}

/**
 * Paint one preview frame onto a 2D context sized `w × h`.
 *
 * Text presets draw the sample string glyph by glyph; everything else draws a
 * single card, which is the honest preview for a preset that moves a whole
 * layer rather than its characters.
 */
export function drawPresetFrame(
  ctx: CanvasRenderingContext2D,
  preset: AnimationPreset,
  frame: PresetFrame,
  w: number,
  h: number,
  theme: PreviewTheme,
  text = PREVIEW_TEXT,
): void {
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2 + frame.x, h / 2 + frame.y);
  if (frame.rotation) ctx.rotate((frame.rotation * Math.PI) / 180);
  if (frame.scale !== 1) ctx.scale(frame.scale, frame.scale);
  ctx.globalAlpha = Math.max(0, Math.min(1, frame.opacity));

  const isText = !!preset.animators?.length || preset.requires === 'text';
  if (!isText) {
    const cw = Math.min(w, h) * 0.9;
    const ch = cw * 0.6;
    ctx.fillStyle = theme.fg;
    ctx.globalAlpha *= 0.9;
    roundRect(ctx, -cw / 2, -ch / 2, cw, ch, 6);
    ctx.fill();
    ctx.restore();
    return;
  }

  const size = Math.max(10, Math.round(h * 0.3));
  ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const chars = [...text];
  // Measure with each glyph's own tracking so an animated tracking preset
  // spreads the sample rather than overlapping it.
  const advances = chars.map(
    (c, i) => ctx.measureText(c).width + (frame.glyphs[i]?.tracking ?? 0),
  );
  const total = advances.reduce((a, b) => a + b, 0);

  let pen = -total / 2;
  for (let i = 0; i < chars.length; i++) {
    const g = frame.glyphs[i];
    const cx = pen + advances[i]! / 2;
    pen += advances[i]!;
    const ch = g?.displayChar ?? chars[i]!;
    if (ch.trim() === '') continue;

    ctx.save();
    ctx.translate(cx + (g?.dx ?? 0), (g?.dy ?? 0));
    if (g) {
      if (g.rotation) ctx.rotate((g.rotation * Math.PI) / 180);
      if (g.skew) ctx.transform(1, 0, Math.tan((-g.skew * Math.PI) / 180), 1, 0, 0);
      if (g.scale !== 1 || g.scaleY !== 1) ctx.scale(g.scale, g.scaleY);
      ctx.globalAlpha = ctx.globalAlpha * Math.max(0, g.opacity);
      if (g.blur > 0) ctx.filter = `blur(${g.blur}px)`;
    }
    if (g && g.strokeWidth > 0) {
      ctx.lineWidth = g.strokeWidth;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = g.strokeColor ?? theme.fg;
      ctx.strokeText(ch, 0, 0);
    }
    const fillAlpha = g ? Math.max(0, g.fillOpacity) : 1;
    if (fillAlpha > 0) {
      ctx.globalAlpha = ctx.globalAlpha * fillAlpha;
      ctx.fillStyle = g?.color ?? theme.fg;
      ctx.fillText(ch, 0, 0);
    }
    ctx.restore();
  }
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
