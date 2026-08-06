/**
 * `contributes.effects` — a plugin that draws pixels.
 *
 * ── Shaders as data. Never JS in the frame loop. ─────────────────────────────
 *
 * This is the constraint everything else follows from, and it is not
 * negotiable. A plugin's JS registers an effect and drives its parameters; it
 * never runs per frame. The reason is structural rather than a performance
 * preference: plugin code lives in a Worker, so reaching it means `postMessage`,
 * which means awaiting a reply inside what has to be a synchronous render. A
 * single async hop per effect per frame is playback that stutters and an export
 * that takes minutes, and no amount of batching fixes an architecture that has
 * to ask another thread what colour a pixel is.
 *
 * So an effect is: some WGSL, and a typed list of parameters. The host compiles
 * it, binds the parameters, and runs it. The plugin is not in the loop at all —
 * which is also why an effect keeps working in a document opened by someone who
 * does not have the plugin's worker running.
 *
 * ── Parameters reuse the layer-kind prop schema, on purpose ──────────────────
 *
 * `parseProp` from `layerKindSchema.ts`, not a second implementation. An
 * animatable effect parameter then becomes an ordinary keyframe track keyed the
 * same way every other property is, with no new machinery in the animation
 * engine and nothing special in the timeline or graph editor.
 *
 * Only the types that can BE a uniform are allowed. `string` and `asset` have no
 * representation in a shader parameter block, and `enum` would need an
 * index mapping the author has to keep in their head — so the schema refuses
 * them here rather than letting an author discover it from a black frame.
 *
 * ── The host writes the bindings ─────────────────────────────────────────────
 *
 * An author writes their `@fragment` entry point and reads `params.<name>`,
 * `src` and `samp`. They do NOT declare `@group`/`@binding` — `wgslValidation`
 * refuses that — because hand-written uniform layout is a padding bug that
 * surfaces as wrong colours rather than an error, and because the host needs to
 * own the binding numbers to bind anything to them.
 */

import { parseProp, type LayerPropSchema } from './layerKindSchema';
import { validateWgsl } from './wgslValidation';

/** Types that can be a shader uniform. */
export const EFFECT_PARAM_TYPES = ['number', 'color', 'boolean'] as const;
export type EffectParamType = (typeof EFFECT_PARAM_TYPES)[number];

export interface EffectContribution {
  /** Plugin-local. The host namespaces it as `<pluginId>.<id>`. */
  id: string;
  label: string;
  /** The author's WGSL. Host bindings are prepended at compile time. */
  shader: string;
  params: Record<string, LayerPropSchema>;
}

/*
 * Caps.
 *
 * Each parameter is an inspector row, a possible keyframe track, and a slot in
 * a uniform block that has a real size limit on real hardware. Sixteen is
 * generous for an effect and small enough that the generated block stays well
 * inside the minimum guaranteed uniform buffer size.
 */
export const MAX_EFFECTS_PER_PLUGIN = 16;
export const MAX_PARAMS_PER_EFFECT = 16;

const EFFECT_ID_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate `contributes.effects`.
 *
 * A single bad effect is dropped WHOLE rather than partially — the same rule
 * layer kinds follow. Half a parameter list renders half an inspector and the
 * author debugs a missing row instead of reading an error.
 */
export function parseEffects(raw: unknown, errors: string[]): EffectContribution[] {
  const out: EffectContribution[] = [];
  if (raw === undefined) return out;

  if (!Array.isArray(raw)) {
    errors.push('"contributes.effects" must be an array.');
    return out;
  }
  if (raw.length > MAX_EFFECTS_PER_PLUGIN) {
    errors.push(
      `"contributes.effects" declares ${raw.length} effects; the limit is ${MAX_EFFECTS_PER_PLUGIN}.`,
    );
    return out;
  }

  const seen = new Set<string>();

  raw.forEach((entry, i) => {
    const at = `contributes.effects[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`"${at}" must be an object.`);
      return;
    }

    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!EFFECT_ID_RE.test(id)) {
      errors.push(
        `"${at}.id" must be camelCase letters and digits, starting with a lowercase letter (1–32 characters).`,
      );
      return;
    }
    if (seen.has(id)) {
      errors.push(`"${at}.id" duplicates an earlier effect "${id}".`);
      return;
    }
    seen.add(id);

    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (!label || label.length > 48) {
      errors.push(`"${at}.label" is required (1–48 characters).`);
      return;
    }

    const shader = typeof entry.shader === 'string' ? entry.shader : '';
    const check = validateWgsl(shader);
    if (!check.ok) {
      /*
        Every problem is reported, not just the first.

        A compiler that stops at the first error makes fixing a shader a
        sequence of round trips — and here a "round trip" is repackaging,
        re-signing and reinstalling. Authors get the whole list.
      */
      for (const p of check.problems) {
        errors.push(`"${at}.shader"${p.line ? ` line ${p.line}` : ''}: ${p.detail}`);
      }
      return;
    }

    const rawParams = entry.params;
    if (rawParams !== undefined && !isPlainObject(rawParams)) {
      errors.push(`"${at}.params" must be an object.`);
      return;
    }
    const names = Object.keys(rawParams ?? {});
    if (names.length > MAX_PARAMS_PER_EFFECT) {
      errors.push(
        `"${at}.params" declares ${names.length} parameters; the limit is ${MAX_PARAMS_PER_EFFECT}.`,
      );
      return;
    }

    const params: Record<string, LayerPropSchema> = {};
    let bad = false;

    for (const name of names) {
      const parsed = parseProp(`${at}.params.${name}`, name, rawParams![name], errors);
      if (!parsed) { bad = true; continue; }

      if (!(EFFECT_PARAM_TYPES as readonly string[]).includes(parsed.type)) {
        errors.push(
          `"${at}.params.${name}.type": an effect parameter must be one of ${EFFECT_PARAM_TYPES.join(', ')} — `
          + `"${parsed.type}" has no representation in a shader parameter block.`,
        );
        bad = true;
        continue;
      }

      params[name] = parsed;
    }

    if (bad) return;
    out.push({ id, label, shader, params });
  });

  return out;
}

/**
 * WGSL types for each parameter type.
 *
 * `boolean` becomes `f32` rather than WGSL's `bool`: booleans are not host-
 * shareable in WGSL, so a `bool` in a uniform block is a compile error the
 * author never wrote. 0.0/1.0 is what every shading language does here.
 */
const WGSL_TYPE: Record<EffectParamType, string> = {
  number: 'f32',
  color: 'vec4<f32>',
  boolean: 'f32',
};

/** Bytes each occupies, and the alignment it demands, under WGSL's rules. */
const WGSL_SIZE: Record<EffectParamType, { size: number; align: number }> = {
  number: { size: 4, align: 4 },
  color: { size: 16, align: 16 },
  boolean: { size: 4, align: 4 },
};

/**
 * The parameter block, ordered so it is valid without hand-written padding.
 *
 * ★ Order is by ALIGNMENT, descending — every `vec4` first, then the scalars.
 *
 * WGSL requires a `vec4<f32>` to sit at a 16-byte boundary. Emitting members in
 * declaration order would mean a scalar before a vec4 leaves a 12-byte hole
 * that the author's struct does not describe, and the values the shader reads
 * are then shifted by the size of that hole. That does not fail to compile and
 * does not throw: it renders the wrong colours, which is the single worst way
 * for this to break, because it looks like the author's maths is wrong.
 *
 * Sorting by alignment removes the possibility rather than documenting it. The
 * returned `layout` is what the uniform writer walks, so the CPU-side packing
 * and the GPU-side struct come from ONE ordering by construction.
 */
export function parameterBlock(params: Record<string, LayerPropSchema>): {
  wgsl: string;
  layout: Array<{ name: string; type: EffectParamType; offset: number }>;
  /** Total size, rounded up to 16 as a uniform buffer requires. */
  size: number;
} {
  const entries = Object.entries(params)
    .map(([name, schema]) => ({ name, type: schema.type as EffectParamType }))
    // Descending alignment, then name, so the ordering is stable across runs —
    // an unstable order would make the shader cache key change for an unchanged
    // effect, recompiling on every load.
    .sort((a, b) => WGSL_SIZE[b.type].align - WGSL_SIZE[a.type].align || a.name.localeCompare(b.name));

  const layout: Array<{ name: string; type: EffectParamType; offset: number }> = [];
  let offset = 0;
  const members: string[] = [];

  for (const e of entries) {
    const { size, align } = WGSL_SIZE[e.type];
    offset = Math.ceil(offset / align) * align;
    layout.push({ name: e.name, type: e.type, offset });
    members.push(`  ${e.name} : ${WGSL_TYPE[e.type]},`);
    offset += size;
  }

  /*
    A uniform buffer's size must be a multiple of 16, and an EMPTY struct is not
    legal WGSL. An effect with no parameters is a perfectly reasonable thing —
    a fixed colour grade — so it gets a padding member rather than a compile
    error the author cannot explain.
  */
  if (members.length === 0) {
    members.push('  _unused : vec4<f32>,');
    offset = 16;
  }

  const size = Math.max(16, Math.ceil(offset / 16) * 16);

  return {
    wgsl: `struct PluginParams {\n${members.join('\n')}\n};`,
    layout,
    size,
  };
}

/**
 * The complete shader: host bindings, then the author's source.
 *
 * Prepended rather than templated into a fixed skeleton, so the author writes
 * ordinary WGSL and their line numbers stay their own — an author reading a
 * compile error should not have to subtract a preamble length to find the line.
 */
export function composeEffectShader(
  effect: EffectContribution,
): { wgsl: string; layout: ReturnType<typeof parameterBlock> } {
  const layout = parameterBlock(effect.params);
  const wgsl = [
    layout.wgsl,
    '@group(0) @binding(0) var<uniform> params : PluginParams;',
    '@group(0) @binding(1) var src : texture_2d<f32>;',
    '@group(0) @binding(2) var samp : sampler;',
    '',
    effect.shader,
  ].join('\n');

  return { wgsl, layout };
}

/** `<pluginId>.<effectId>` — the same namespacing layer kinds use. */
export function namespacedEffect(pluginId: string, effectId: string): string {
  return `${pluginId}.${effectId}`;
}

/**
 * Pack parameter values into the uniform block.
 *
 * Walks `layout`, which came from `parameterBlock` — so this cannot disagree
 * with the generated struct about where anything sits. That is the whole reason
 * the layout is returned rather than recomputed.
 */
export function packParameters(
  layout: Array<{ name: string; type: EffectParamType; offset: number }>,
  size: number,
  values: Record<string, unknown>,
): ArrayBuffer {
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);

  for (const { name, type, offset } of layout) {
    const value = values[name];
    if (type === 'color') {
      const rgba = colorToRgba(value);
      for (let i = 0; i < 4; i++) view.setFloat32(offset + i * 4, rgba[i]!, true);
    } else if (type === 'boolean') {
      view.setFloat32(offset, value === true ? 1 : 0, true);
    } else {
      view.setFloat32(offset, typeof value === 'number' && Number.isFinite(value) ? value : 0, true);
    }
  }

  return buffer;
}

/**
 * A colour value as 0..1 RGBA.
 *
 * ★ 0..1, not 0..255. The renderer's colour tracks are already 0..1 and getting
 * this wrong produces an effect that is either invisible or fully saturated —
 * a mistake this codebase has made before, in the opposite direction, when
 * colour readers assumed 0..255.
 */
function colorToRgba(value: unknown): [number, number, number, number] {
  if (Array.isArray(value) && value.length >= 3) {
    const [r, g, b, a] = value as number[];
    return [num01(r), num01(g), num01(b), a === undefined ? 1 : num01(a)];
  }
  if (typeof value === 'string') {
    const hex = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
    if (hex) {
      const rgb = parseInt(hex[1]!, 16);
      return [
        ((rgb >> 16) & 255) / 255,
        ((rgb >> 8) & 255) / 255,
        (rgb & 255) / 255,
        hex[2] ? parseInt(hex[2], 16) / 255 : 1,
      ];
    }
  }
  return [0, 0, 0, 1];
}

const num01 = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
