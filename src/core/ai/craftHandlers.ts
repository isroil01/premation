/**
 * Handlers for the craft primitives in `@motion/ai-tools/tools/craft`.
 *
 * Same three rules as `toolHandlers.ts`: every keyframe time converts through
 * `ctx.time`, partial success is success, and every failure message is a repair
 * instruction addressed to the model.
 *
 * One extra rule specific to this file: **a handler must never leave a track the
 * renderer will not read.** `set_time_remap` therefore enables the precomp flag
 * before writing the track, because `buildSnapshot` only samples `timeRemap` on
 * a precomp — writing the keyframes alone would produce a timeline full of
 * keyframes and no visible change, which is the exact failure mode the facade
 * design exists to prevent.
 */

import type { AiTool, ToolContext, ToolResult } from '@motion/ai-tools';
import { bakeSpring, bindAlias, resolveSpring, thinSamples, type SpringParams, type SpringPresetName } from '@motion/ai-tools';
import { refreshAfterLegacy } from './toolContext';
import { makeStop, setNodeFill } from '@core/paint/fill';
import { arrangeNodes } from '@core/scene/parenting';
import { isAnimatableProp } from './toolContext';
import { mapSeq, filterSeq } from './asyncList';

const ok = (content: string, data?: unknown): ToolResult => ({ ok: true, content, data });
const fail = (content: string): ToolResult => ({ ok: false, content });

const unknownNode = async (ctx: ToolContext, id: string): Promise<string> =>
  `unknown nodeId '${id}' — did you mean: ${(await ctx.scene.nearest(id)).join(', ') || '(no layers exist yet)'}?`;

/**
 * How far a baked spring sample may deviate from the thinned reconstruction, in
 * value units. 0.15 is well under a pixel and under a tenth of a percent of a
 * typical opacity range, so thinning is imperceptible while still removing the
 * long collinear tail.
 */
const SPRING_THIN_TOLERANCE = 0.15;

// ── set_spring ────────────────────────────────────────────────────────

const setSpring: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    nodeId: string; prop: string; from: number; to: number;
    startSec?: number; preset?: SpringPresetName;
    stiffness?: number; damping?: number; mass?: number; velocity?: number;
    maxDurationSec?: number;
  };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));
  if (!isAnimatableProp(i.prop)) {
    return fail(
      `'${i.prop}' is not an animatable property, so a spring on it would write a track the ` +
      `renderer never samples. Call list_capabilities("props") for the real list.`,
    );
  }

  // Explicit physics wins over a preset; a caller that passed both meant the
  // numbers. Partial physics falls back to the preset for the rest.
  const explicit = i.stiffness !== undefined || i.damping !== undefined;
  const base = resolveSpring(i.preset ?? 'snappy');
  const spring: SpringParams = explicit
    ? {
        stiffness: i.stiffness ?? base.stiffness,
        damping: i.damping ?? base.damping,
        mass: i.mass ?? base.mass,
        ...(i.velocity !== undefined ? { velocity: i.velocity } : {}),
      }
    : { ...base, ...(i.mass !== undefined ? { mass: i.mass } : {}), ...(i.velocity !== undefined ? { velocity: i.velocity } : {}) };

  const comp = await ctx.comp.get();
  const start = i.startSec ?? 0;
  const baked = bakeSpring({
    from: i.from,
    to: i.to,
    spring,
    fps: comp.fps,
    maxDurationSec: i.maxDurationSec,
  });
  const samples = thinSamples(baked.samples, SPRING_THIN_TOLERANCE);

  // Baked keyframes are frame-aligned samples of an already-curved function, so
  // they must interpolate LINEARLY. Easing them again would ease the easing —
  // double-smoothing the launch and flattening the very overshoot the spring was
  // chosen for.
  let written = 0;
  let clipped = 0;
  for (const s of samples) {
    const t = start + s.t;
    if (t > comp.durationSeconds + 1e-6) { clipped++; continue; }
    await ctx.anim.setKeyframe(i.nodeId, i.prop, t, s.value, 'linear');
    written++;
  }
  refreshAfterLegacy(ctx);

  if (written < 2) {
    return fail(
      `The spring baked to ${written} keyframe(s) inside the composition — it starts at ` +
      `${start.toFixed(2)}s but the composition ends at ${comp.durationSeconds.toFixed(2)}s. ` +
      `Start it earlier or extend the composition.`,
    );
  }

  const notes: string[] = [];
  if (baked.overshoot > 0) notes.push(`overshoots ${(baked.overshoot * 100).toFixed(1)}%`);
  else notes.push('no overshoot (over/critically damped)');
  if (baked.truncated) {
    notes.push(
      `TRUNCATED at the ${(i.maxDurationSec ?? 4)}s cap — this spring is too under-damped to settle. ` +
      `Raise damping if you wanted it to come to rest.`,
    );
  }
  if (clipped) notes.push(`${clipped} sample(s) past the composition end were dropped`);

  return ok(
    `Baked a spring on ${i.nodeId}.${i.prop}: ${i.from} → ${i.to} over ` +
    `${baked.durationSec.toFixed(3)}s as ${written} linear keyframes (${notes.join('; ')}).`,
    { keyframes: written, durationSec: baked.durationSec, overshoot: baked.overshoot, truncated: baked.truncated },
  );
};

// ── set_motion_blur ───────────────────────────────────────────────────

const setMotionBlur: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    nodeId?: string; enabled?: boolean;
    shutterAngle?: number; shutterPhase?: number; samples?: number;
  };

  if (i.nodeId) {
    if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));
    if (i.enabled === undefined) {
      return fail('Pass `enabled` when targeting a layer — nodeId alone does nothing.');
    }
    const shutterOnLayer = i.shutterAngle !== undefined || i.samples !== undefined || i.shutterPhase !== undefined;
    // Say so rather than silently ignoring them. Shutter is a property of the
    // camera, not of one layer, and a model that thinks it set a per-layer
    // shutter will not understand why the blur did not change.
    const note = shutterOnLayer
      ? ' (shutterAngle/shutterPhase/samples are COMPOSITION settings and were ignored here — ' +
        'call set_motion_blur again without nodeId to set them)'
      : '';
    const applied = await ctx.scene.setProp(i.nodeId, 'motionBlur', i.enabled);
    if (!applied) return fail(`Could not set motion blur on '${i.nodeId}'.`);
    refreshAfterLegacy(ctx);
    const comp = await ctx.comp.motionBlur();
    const dormant = !comp.enabled
      ? ' NOTE: composition motion blur is OFF, so this layer switch has no visible effect until ' +
        'you enable it (set_motion_blur with no nodeId, enabled: true).'
      : '';
    return ok(`Motion blur ${i.enabled ? 'enabled' : 'disabled'} on '${i.nodeId}'${note}.${dormant}`);
  }

  const patch: Parameters<ToolContext['comp']['setMotionBlur']>[0] = {};
  if (i.enabled !== undefined) patch.enabled = i.enabled;
  if (i.shutterAngle !== undefined) patch.shutterAngle = i.shutterAngle;
  if (i.shutterPhase !== undefined) patch.shutterPhase = i.shutterPhase;
  if (i.samples !== undefined) patch.samples = i.samples;
  if (Object.keys(patch).length === 0) {
    const cur = await ctx.comp.motionBlur();
    return ok(
      `Composition motion blur is currently: enabled=${cur.enabled}, shutterAngle=${cur.shutterAngle}, ` +
      `shutterPhase=${cur.shutterPhase}, samples=${cur.samples}. Pass a field to change it.`,
      cur,
    );
  }
  await ctx.comp.setMotionBlur(patch);
  const now = await ctx.comp.motionBlur();
  return ok(
    `Composition motion blur: enabled=${now.enabled}, shutterAngle=${now.shutterAngle}, ` +
    `shutterPhase=${now.shutterPhase}, samples=${now.samples}. ` +
    `Individual layers still need motionBlur enabled to be blurred.`,
    now,
  );
};

// ── create_precomp ────────────────────────────────────────────────────

const createPrecomp: AiTool['handler'] = async (input, ctx) => {
  const i = input as { id?: string; nodeIds: string[]; name: string };
  const missing = await filterSeq(i.nodeIds, async (id) => !(await ctx.scene.has(id)));
  if (missing.length) {
    return fail(`Cannot precompose — unknown layer(s): ${(await mapSeq(missing, (m) => unknownNode(ctx, m))).join('; ')}`);
  }
  const id = await ctx.scene.precompose(i.nodeIds, i.name);
  if (!id) {
    return fail(
      `Precompose produced nothing. The layers must belong to the composition in view, and must ` +
      `not include the composition root — precompose ordinary content layers instead.`,
    );
  }
  bindAlias(ctx, i.id, id);
  return ok(
    `Precomposed ${i.nodeIds.length} layer(s) into a new composition "${i.name}", placed here as ` +
    `the composition layer '${id}'. The layers keep their ids but now live in that composition, ` +
    `not in this one. Transform, opacity, effects and masks on '${id}' apply to the whole unit, ` +
    `and set_time_remap on it retimes everything inside.`,
    { id },
  );
};

// ── set_time_remap ────────────────────────────────────────────────────

const setTimeRemap: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    nodeId: string;
    keys: { t: number; sourceT: number; easing?: string; bezier?: number[] }[];
  };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

  const kind = (await ctx.scene.get(i.nodeId))?.kind;
  // A composition layer (what create_precomp makes) or a group/precomp.
  if (kind !== 'group' && kind !== 'comp') {
    return fail(
      `Time remap only works on a composition or group/precomp layer, and '${i.nodeId}' is a ${kind}. ` +
      `Call create_precomp on the layers you want to retime first, then remap the result.`,
    );
  }

  // Enable precomp compositing FIRST. buildSnapshot only samples `timeRemap` on
  // a precomp, so writing the track without this leaves a full timeline track
  // that changes nothing on screen.
  await ctx.scene.setTimeRemapEnabled(i.nodeId, true);

  const sorted = [...i.keys].sort((a, b) => a.t - b.t);
  for (const k of sorted) {
    await ctx.anim.setKeyframe(i.nodeId, 'timeRemap', k.t, k.sourceT, k.easing ?? 'linear');
    if (k.easing === 'bezier' && k.bezier) await ctx.anim.setBezier(i.nodeId, 'timeRemap', k.t, k.bezier);
  }
  refreshAfterLegacy(ctx);

  // Describe what the remap actually DOES, so the model can tell whether it got
  // the speed ramp it intended without rendering.
  const segments: string[] = [];
  for (let n = 1; n < sorted.length; n++) {
    const a = sorted[n - 1]!, b = sorted[n]!;
    const dt = b.t - a.t;
    const ds = b.sourceT - a.sourceT;
    const rate = dt <= 0 ? Infinity : ds / dt;
    segments.push(
      `${a.t.toFixed(2)}→${b.t.toFixed(2)}s: ` +
      (Math.abs(ds) < 1e-6 ? 'FREEZE' : rate < 0 ? `${Math.abs(rate).toFixed(2)}× REVERSE` : `${rate.toFixed(2)}× speed`),
    );
  }
  return ok(`Time-remapped '${i.nodeId}' with ${sorted.length} keys — ${segments.join(', ')}.`, { segments });
};

// ── update_effect_param ───────────────────────────────────────────────

const updateEffectParamHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as { nodeId: string; effectId: string; key: string; value: number | string | boolean };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));
  const effects = await ctx.scene.listEffects(i.nodeId);
  const target = effects.find((e) => e.id === i.effectId);
  if (!target) {
    return fail(
      `'${i.nodeId}' has no effect '${i.effectId}'. Effects on it: ` +
      (effects.map((e) => `${e.id} (${e.type})`).join(', ') || '(none — call add_effect first)'),
    );
  }
  await ctx.scene.updateEffectParam(i.nodeId, i.effectId, i.key, i.value);
  return ok(`Set ${target.type}.${i.key} = ${String(i.value)} on '${i.nodeId}'.`);
};

// ── set_light ─────────────────────────────────────────────────────────

/** Tool field → the engine prop name `readNodeLight` actually reads. */
const LIGHT_PROP_MAP: Record<string, string> = {
  intensity: 'intensity',
  radius: 'radius',
  coneAngle: 'lightCone',
};

const setLight: AiTool['handler'] = async (input, ctx) => {
  const i = input as { nodeId: string; color?: string; intensity?: number; radius?: number; coneAngle?: number };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));
  const kind = (await ctx.scene.get(i.nodeId))?.kind;
  if (kind !== 'light') {
    return fail(
      `'${i.nodeId}' is a ${kind}, not a light. Create one with create_layer { kind: "light" } first.`,
    );
  }
  const applied: string[] = [];
  if (i.color !== undefined && await ctx.scene.setProp(i.nodeId, 'fill', i.color)) applied.push(`color=${i.color}`);
  for (const [field, prop] of Object.entries(LIGHT_PROP_MAP)) {
    const v = (i as Record<string, unknown>)[field];
    if (typeof v === 'number' && await ctx.scene.setProp(i.nodeId, prop, v)) applied.push(`${field}=${v}`);
  }
  if (!applied.length) return fail('Nothing to set — pass at least one of color, intensity, radius, coneAngle.');
  refreshAfterLegacy(ctx);
  return ok(
    `Configured light '${i.nodeId}': ${applied.join(', ')}. ` +
    `intensity and radius are keyframeable with set_keyframes for a pulse or a reveal.`,
  );
};

// ── set_shadow_stack ──────────────────────────────────────────────────

interface ShadowSpec {
  distance: number;
  angle?: number;
  softness: number;
  opacity: number;
  color?: string;
}

const setShadowStack: AiTool['handler'] = async (input, ctx) => {
  const i = input as { nodeId: string; shadows: ShadowSpec[] };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

  // Replace, don't append: calling this twice must not silently double the
  // stack. Only drop-shadows this tool owns are removed.
  for (const e of await ctx.scene.listEffects(i.nodeId)) {
    if (e.type === 'drop-shadow') await ctx.scene.removeEffect(i.nodeId, e.id);
  }

  const ids: string[] = [];
  for (const s of i.shadows) {
    const effectId = await ctx.scene.addEffect(i.nodeId, 'drop-shadow');
    if (!effectId) continue;
    await ctx.scene.updateEffectParam(i.nodeId, effectId, 'distance', s.distance);
    await ctx.scene.updateEffectParam(i.nodeId, effectId, 'angle', s.angle ?? 90);
    await ctx.scene.updateEffectParam(i.nodeId, effectId, 'softness', s.softness);
    await ctx.scene.updateEffectParam(i.nodeId, effectId, 'opacity', s.opacity);
    if (s.color) await ctx.scene.updateEffectParam(i.nodeId, effectId, 'color', s.color);
    ids.push(effectId);
  }
  if (!ids.length) return fail(`Could not add shadows to '${i.nodeId}'.`);
  refreshAfterLegacy(ctx);

  const neutral = i.shadows.filter((s) => !s.color || /^#0{3,8}$/i.test(s.color)).length;
  const warning =
    ids.length === 1
      ? ' NOTE: a ONE-layer stack is a plain drop shadow and reads as flat. Real elevation is a ' +
        'tight contact shadow + a mid shadow + a wide ambient one.'
      : neutral === i.shadows.length
        ? ' NOTE: every shadow is pure black. Tint them toward the background hue — neutral black ' +
          'shadows are one of the strongest "made by a program" tells.'
        : '';
  return ok(`Applied a ${ids.length}-layer shadow stack to '${i.nodeId}'.${warning}`, { effectIds: ids });
};

// ── add_surface_treatment ─────────────────────────────────────────────

const addSurfaceTreatment: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    id?: string; grain?: number; grainAnimated?: boolean; vignette?: number;
    chromaticAberration?: number; name?: string;
  };
  if (i.grain === undefined && i.vignette === undefined && i.chromaticAberration === undefined) {
    return fail('Nothing to add — pass at least one of grain, vignette, chromaticAberration.');
  }

  const comp = await ctx.comp.get();
  // An adjustment layer treats everything BENEATH it, which is what makes this
  // one layer instead of one effect per content layer.
  const id = await ctx.scene.create('adjustment', i.name ?? 'Surface Treatment', {
    x: comp.width / 2,
    y: comp.height / 2,
  });
  if (!id) return fail('Could not create the adjustment layer for the surface treatment.');
  bindAlias(ctx, i.id, id);
  await ctx.scene.setProp(id, 'width', comp.width);
  await ctx.scene.setProp(id, 'height', comp.height);

  const added: string[] = [];

  if (i.grain !== undefined && i.grain > 0) {
    const fx = await ctx.scene.addEffect(id, 'noise');
    if (fx) {
      await ctx.scene.updateEffectParam(id, fx, 'amount', i.grain);
      await ctx.scene.updateEffectParam(id, fx, 'monochrome', true);
      if (i.grainAnimated !== false) {
        // Static grain reads as a dirty lens, not as film. Evolving it per frame
        // is what makes it live — and it must be a KEYFRAMED track, not a
        // constant, or every frame gets the same noise field.
        await ctx.anim.setKeyframe(id, `effect.${fx}.evolution`, 0, 0, 'linear');
        await ctx.anim.setKeyframe(
          id,
          `effect.${fx}.evolution`,
          comp.durationSeconds,
          Math.round(comp.durationSeconds * comp.fps),
          'linear',
        );
      }
      added.push(`grain ${i.grain}%${i.grainAnimated !== false ? ' (animated)' : ''}`);
    }
  }

  if (i.vignette !== undefined && i.vignette > 0) {
    // A vignette is a radial darkening, built from a soft-edged inverted mask on
    // a dark fill — the engine has no dedicated vignette effect.
    const fx = await ctx.scene.addEffect(id, 'gradient-ramp');
    if (fx) {
      await ctx.scene.updateEffectParam(id, fx, 'blend', i.vignette);
      await ctx.scene.updateEffectParam(id, fx, 'colorA', '#00000000');
      await ctx.scene.updateEffectParam(id, fx, 'colorB', '#000000');
      added.push(`vignette ${i.vignette}%`);
    }
  }

  if (i.chromaticAberration !== undefined && i.chromaticAberration > 0) {
    const fx = await ctx.scene.addEffect(id, 'channel-mixer');
    if (fx) {
      await ctx.scene.updateEffectParam(id, fx, 'amount', i.chromaticAberration);
      added.push(`chromatic aberration ${i.chromaticAberration}px`);
    }
  }

  refreshAfterLegacy(ctx);
  if (!added.length) {
    await ctx.scene.remove(id);
    return fail('None of the requested surface effects could be added — the adjustment layer was removed again.');
  }
  return ok(
    `Added surface treatment '${id}' over the whole frame: ${added.join(', ')}. ` +
    `Keep this layer on top — an adjustment layer only treats what is beneath it.`,
    { id },
  );
};

// ── create_gradient ───────────────────────────────────────────────────

/**
 * Where the backdrop went, said in the reply.
 *
 * A new layer is appended to the child order, and the last child is the
 * FRONT-most — so a "backdrop" created after any other layer used to land on
 * top of all of them and cover the scene it was meant to sit behind. Bottom is
 * the default because that is what the word means; `top` stays reachable for
 * the rare overlay wash.
 */
function placeBackdrop(id: string, placement: 'bottom' | 'top' | undefined): string {
  if (placement === 'top') return 'on TOP of the layer stack (it covers everything beneath it)';
  arrangeNodes([id], 'back');
  return 'at the BOTTOM of the layer stack, behind every existing layer';
}

const createGradient: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    id?: string; stops: string[]; kind?: 'linear' | 'radial' | 'corners'; angle?: number; name?: string;
    placement?: 'bottom' | 'top'; centerX?: number; centerY?: number; radius?: number;
  };
  const comp = await ctx.comp.get();
  const id = await ctx.scene.create('solid', i.name ?? 'Gradient', { x: comp.width / 2, y: comp.height / 2 });
  if (!id) return fail('Could not create the gradient layer.');
  bindAlias(ctx, i.id, id);
  await ctx.scene.setProp(id, 'width', comp.width);
  await ctx.scene.setProp(id, 'height', comp.height);
  await ctx.scene.setProp(id, 'fill', i.stops[0]!);

  const kind = i.kind ?? 'linear';
  const where = placeBackdrop(id, i.placement);

  // 4 stops map exactly onto the four-color-gradient effect, which is a genuine
  // 2D blend rather than two stacked ramps.
  if (i.stops.length === 4 && kind === 'corners') {
    const fx = await ctx.scene.addEffect(id, 'four-color-gradient');
    if (!fx) return fail('Could not add the gradient effect.');
    const keys = ['colorTL', 'colorTR', 'colorBL', 'colorBR'];
    for (const [n, c] of i.stops.entries()) await ctx.scene.updateEffectParam(id, fx, keys[n]!, c);
    refreshAfterLegacy(ctx);
    return ok(`Created a 4-corner gradient backdrop '${id}', ${where}.`, { id, effectIds: [fx], placement: i.placement ?? 'bottom' });
  }

  // Radial is a FILL PAINT, not an effect. `gradient-ramp` has no radial mode —
  // its only geometry parameter is `angle` — so the old code, which routed
  // radial through the same ramps with angle 0, drew a left→right LINEAR
  // gradient and then reported "radial". The layer's own fill paint does have a
  // real radial type (Fill ▸ Type ▸ Radial), multi-stop, with a keyframeable
  // centre and radius, and it rasterizes through the same path the UI uses.
  if (kind === 'radial') {
    const last = i.stops.length - 1;
    setNodeFill(id, {
      type: 'radial',
      // Schema speaks percent of the frame; the paint model speaks 0..1.
      cx: (i.centerX ?? 50) / 100,
      cy: (i.centerY ?? 50) / 100,
      // A fraction of the half-DIAGONAL, so 100% is the first radius at which a
      // centred gradient's last stop lands exactly on the corners — anything
      // smaller leaves a flat band of the end colour around the frame.
      radius: (i.radius ?? 100) / 100,
      stops: i.stops.map((c, n) => makeStop(n / last, c)),
    });
    refreshAfterLegacy(ctx);
    return ok(
      `Created a ${i.stops.length}-stop radial gradient backdrop '${id}' (${i.stops.join(' → ')}, centre outward), ${where}. ` +
      `Animate it with set_keyframes on 'fillCenterX' / 'fillCenterY' / 'fillRadius' — FRACTIONS (0.5 = centre, radius 1 = reaches the corners), not the percentages this call took.`,
      { id, effectIds: [], placement: i.placement ?? 'bottom' },
    );
  }

  // 2 or 3 stops → chained ramps between CONSECUTIVE stops. Chaining rather than
  // interpolating endpoints is the whole point: an explicit midpoint colour is
  // how you avoid the desaturated dead-zone that naive sRGB blending puts in the
  // middle of a two-stop gradient. The caller supplies OKLCH-computed stops.
  const effectIds: string[] = [];
  for (let n = 0; n < i.stops.length - 1; n++) {
    const fx = await ctx.scene.addEffect(id, 'gradient-ramp');
    if (!fx) continue;
    await ctx.scene.updateEffectParam(id, fx, 'colorA', i.stops[n]!);
    await ctx.scene.updateEffectParam(id, fx, 'colorB', i.stops[n + 1]!);
    await ctx.scene.updateEffectParam(id, fx, 'angle', i.angle ?? 90);
    // Later bands blend over the earlier ones at reducing strength, so the
    // handoff between stops is smooth instead of a visible seam.
    await ctx.scene.updateEffectParam(id, fx, 'blend', n === 0 ? 100 : Math.round(100 / (n + 1)));
    effectIds.push(fx);
  }
  if (!effectIds.length) return fail('Could not add the gradient effect.');
  refreshAfterLegacy(ctx);
  return ok(
    // `corners` with anything but 4 stops has no four-colour mapping and falls
    // through to here — say "linear", because that is what was drawn.
    `Created a ${i.stops.length}-stop linear gradient backdrop '${id}' (${i.stops.join(' → ')}), ${where}.` +
    (kind === 'corners' ? ` NOTE: kind "corners" needs exactly 4 stops — with ${i.stops.length} it was drawn as a linear gradient.` : ''),
    { id, effectIds, placement: i.placement ?? 'bottom' },
  );
};

export const CRAFT_HANDLERS: Record<string, AiTool['handler']> = {
  set_spring: setSpring,
  set_motion_blur: setMotionBlur,
  create_precomp: createPrecomp,
  set_time_remap: setTimeRemap,
  update_effect_param: updateEffectParamHandler,
  set_light: setLight,
  set_shadow_stack: setShadowStack,
  add_surface_treatment: addSurfaceTreatment,
  create_gradient: createGradient,
};
