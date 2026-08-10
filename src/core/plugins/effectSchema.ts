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

/** Types that can be a shader uniform — a VALUE in the parameter block. */
export const EFFECT_UNIFORM_TYPES = ['number', 'color', 'boolean'] as const;
export type EffectParamType = (typeof EFFECT_UNIFORM_TYPES)[number];

/**
 * Types that become a BINDING rather than a uniform member.
 *
 * `layer` names another layer in the composition, and the renderer binds that
 * layer's texture beside `src`. Deliberately NOT in `EFFECT_UNIFORM_TYPES`: it
 * has no size, no alignment and no representation in a uniform block, and
 * admitting it there would shift every offset after it — silently, which is the
 * same class of failure as the missing 64-byte header.
 */
export const EFFECT_BINDING_TYPES = ['layer'] as const;

/** Everything an effect parameter is allowed to be. */
export const EFFECT_PARAM_TYPES = [...EFFECT_UNIFORM_TYPES, ...EFFECT_BINDING_TYPES] as const;

/**
 * At most ONE layer parameter per effect.
 *
 * The generated bind group has a single slot for it. More would each need their
 * own binding number, their own resolution in the render graph and their own
 * behaviour when the referenced layer is gone — none of it free, none of it
 * asked for.
 */
export const MAX_LAYER_PARAMS_PER_EFFECT = 1;

/** The names of an effect's layer-reference parameters, in declaration order. */
export function layerParamNames(params: Record<string, LayerPropSchema>): string[] {
  return Object.entries(params)
    .filter(([, s]) => (EFFECT_BINDING_TYPES as readonly string[]).includes(s.type))
    .map(([name]) => name);
}

/**
 * What a later pass is allowed to read.
 *
 * `previous` is the chain — pass N sees pass N−1's output, and pass 0 sees the
 * layer render. `origin` and `both` also expose the pass-0 input, which is what
 * every composite effect needs: a bloom adds a blurred copy back over the
 * *original*, and without `origin` the original is gone by the time there is
 * something to add it to.
 */
export const PASS_READS = ['previous', 'origin', 'both'] as const;
export type PassReads = (typeof PASS_READS)[number];

/**
 * Downsample factors a pass may render at.
 *
 * A fixed set, not an arbitrary number. Half and quarter resolution are what a
 * blur actually wants — the whole point of a separable blur is that the
 * expensive pass runs on fewer pixels — and an open range would let an author
 * write `scale: 0.9`, producing a target whose dimensions round inconsistently
 * against the source and a shimmer nobody can trace.
 */
export const PASS_SCALES = [1, 0.5, 0.25] as const;
export type PassScale = (typeof PASS_SCALES)[number];

export interface EffectPass {
  name: string;
  /** Same one-`fs`-function contract, same validator, as a single-pass effect. */
  wgsl: string;
  /** Render-target downsample. Default 1. */
  scale?: PassScale;
  /** Default `'previous'`. */
  reads?: PassReads;
}

export interface EffectContribution {
  /** Plugin-local. The host namespaces it as `<pluginId>.<id>`. */
  id: string;
  label: string;
  /**
   * The author's WGSL, for a single-pass effect. Host bindings are prepended at
   * compile time.
   *
   * Mutually exclusive with `passes`, and the reason it was not folded into
   * `passes: [{...}]` is that every effect published before multi-pass existed
   * has this field and no other. Rewriting them at parse time into a
   * one-element chain would work, and would also mean the single-pass path —
   * the one every existing effect takes — stopped being the path with a test on
   * it. `passes` absent is today's behaviour, byte for byte.
   */
  shader: string;
  params: Record<string, LayerPropSchema>;
  /** A declared, host-orchestrated chain. Absent for a single-pass effect. */
  passes?: EffectPass[];
}

/**
 * Caps on a pass chain.
 *
 * ── Why a COST budget and not just a pass count ──────────────────────────────
 *
 * Four passes is not one cost. Four full-scale passes is four times the layer's
 * pixels every frame; four quarter-scale passes is a quarter of one. A count
 * alone would refuse the cheap chain and wave through the expensive one, so the
 * budget is denominated in the thing that actually costs: pixels.
 *
 * ── ★ Two deliberate divergences from the brief, both arithmetic ─────────────
 *
 * The brief specifies `sum(1/scale²) ≤ 6` AND, in its acceptance criteria, that
 * the budget must refuse a four-pass full-scale chain. Those cannot both hold,
 * and the first is inverted:
 *
 *   1. **The exponent.** A pass at `scale` renders `scale²` of the pixels, so
 *      cost must RISE with scale. `1/scale²` gives full = 1, half = 4,
 *      quarter = 16 — making the cheapest pass the platform allows (quarter
 *      scale, 1/16 of the fill) score sixteen times a full one, and a single
 *      one of them exceed the whole budget. Every downsampled blur, which is
 *      the entire reason `scale` exists, would be refused. Implemented as
 *      `scale²`.
 *
 *   2. **The number.** Under either exponent, four full-scale passes cost 4,
 *      which is ≤ 6 — so a budget of 6 does not refuse the chain the brief says
 *      it must. The acceptance criterion is the concrete, testable half of the
 *      pair, so it wins: the budget is **3**.
 *
 * What 3 admits, which is the check that matters more than the number:
 *
 *   separable blur, two full-scale passes          1 + 1                 = 2    ✓
 *   bloom: bright-pass, blur ×2 at ¼, composite    1 + 0.0625×2 + 1      ≈ 2.13 ✓
 *   four quarter-scale passes                      0.0625 × 4            = 0.25 ✓
 *   four full-scale passes                         1 × 4                 = 4    ✗
 *
 * A user who wanted the last one still gets three full-scale passes, and the
 * shapes a fourth is usually reached for — the cheap tail of a bloom — are the
 * ones that fit easily.
 */
export const MAX_PASSES_PER_EFFECT = 4;
export const MAX_PASS_COST = 3;

/**
 * A pass's cost, in units of one full-scale pass: its share of the pixels.
 *
 * `scale` is a linear downsample, so it applies twice — half scale is half the
 * width AND half the height, a quarter of the fill.
 */
export function passCost(scale: PassScale): number {
  return scale * scale;
}

/** The chain's total cost, in full-scale passes. */
export function chainCost(passes: readonly EffectPass[]): number {
  return passes.reduce((sum, p) => sum + passCost(p.scale ?? 1), 0);
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

    /*
      One source of shader source, never two.

      An effect declaring both `shader` and `passes` has said two different
      things about what it draws, and there is no reading of it that is
      obviously right — running the chain silently ignores source the author
      wrote, running `shader` silently ignores the chain. Both are the kind of
      "worked, but not the way you wrote it" that costs an afternoon.
    */
    const hasPasses = entry.passes !== undefined;
    const hasShader = typeof entry.shader === 'string' && entry.shader.trim() !== '';
    if (hasPasses && hasShader) {
      errors.push(
        `"${at}" declares both "shader" and "passes". Use "shader" for a single-pass effect `
        + `or "passes" for a chain — an effect that declares both does not say which one draws.`,
      );
      return;
    }

    const passes = hasPasses ? parsePasses(entry.passes, at, errors) : undefined;
    if (hasPasses && !passes) return;

    /*
      A chain's `shader` is its FIRST pass.

      Everything downstream of parsing — the material, the registry, the
      renderer's single-pass path — already reads `shader`, and giving the
      chain's head that name means a two-pass effect degrades to its first pass
      rather than to nothing if a caller has not been taught about chains yet.
      For a single-pass effect this is just the author's source.
    */
    const shader = passes ? passes[0]!.wgsl : (typeof entry.shader === 'string' ? entry.shader : '');

    // A chain's passes were each validated inside `parsePasses`; re-running the
    // validator on the head here would report every problem in pass 0 twice.
    if (!passes) {
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

    const layers = layerParamNames(params);
    if (layers.length > MAX_LAYER_PARAMS_PER_EFFECT) {
      errors.push(
        `"${at}.params" declares ${layers.length} layer parameters (${layers.join(', ')}); `
        + `the limit is ${MAX_LAYER_PARAMS_PER_EFFECT}. The generated bind group has one slot for a second texture.`,
      );
      return;
    }

    out.push(passes ? { id, label, shader, params, passes } : { id, label, shader, params });
  });

  return out;
}

const PASS_NAME_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;

/**
 * Validate `effects[i].passes`. Returns `undefined` if the chain is unusable.
 *
 * The whole chain is refused on any single bad pass, matching how a bad effect
 * is dropped whole. A partially-accepted chain is worse than none: it compiles,
 * it draws, and it draws something the author never wrote.
 */
function parsePasses(raw: unknown, at: string, errors: string[]): EffectPass[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push(`"${at}.passes" must be an array.`);
    return undefined;
  }
  if (raw.length === 0) {
    // Not the same as absent. `passes: []` is an author who meant to write a
    // chain, and rendering nothing while reporting success is how they would
    // find out.
    errors.push(`"${at}.passes" is empty. Omit it for a single-pass effect.`);
    return undefined;
  }
  if (raw.length > MAX_PASSES_PER_EFFECT) {
    errors.push(
      `"${at}.passes" declares ${raw.length} passes; the limit is ${MAX_PASSES_PER_EFFECT}.`,
    );
    return undefined;
  }

  const passes: EffectPass[] = [];
  const names = new Set<string>();
  let bad = false;

  raw.forEach((entry, i) => {
    const where = `${at}.passes[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`"${where}" must be an object.`);
      bad = true;
      return;
    }

    const name = typeof entry.name === 'string' ? entry.name : '';
    if (!PASS_NAME_RE.test(name)) {
      errors.push(
        `"${where}.name" must be camelCase letters and digits, starting with a lowercase letter (1–32 characters).`,
      );
      bad = true;
      return;
    }
    if (names.has(name)) {
      // Names are not decoration: each pass compiles to its own registered
      // shader, keyed by name. A duplicate would silently overwrite.
      errors.push(`"${where}.name" duplicates an earlier pass "${name}".`);
      bad = true;
      return;
    }
    names.add(name);

    const wgsl = typeof entry.wgsl === 'string' ? entry.wgsl : '';
    const check = validateWgsl(wgsl);
    if (!check.ok) {
      for (const p of check.problems) {
        errors.push(`"${where}.wgsl"${p.line ? ` line ${p.line}` : ''}: ${p.detail}`);
      }
      bad = true;
      return;
    }

    let scale: PassScale = 1;
    if (entry.scale !== undefined) {
      if (!(PASS_SCALES as readonly unknown[]).includes(entry.scale)) {
        errors.push(
          `"${where}.scale" must be one of ${PASS_SCALES.join(', ')}. `
          + `An arbitrary factor gives a target whose dimensions round inconsistently against its source.`,
        );
        bad = true;
        return;
      }
      scale = entry.scale as PassScale;
    }

    let reads: PassReads = 'previous';
    if (entry.reads !== undefined) {
      if (!(PASS_READS as readonly unknown[]).includes(entry.reads)) {
        errors.push(`"${where}.reads" must be one of ${PASS_READS.join(', ')}.`);
        bad = true;
        return;
      }
      reads = entry.reads as PassReads;

      /*
        Pass 0 first, because it is the more precise diagnosis and the one that
        stays true forever.

        Pass 0 has no `origin` distinct from its `src` — they are the same
        texture — so naming one is a statement that cannot be satisfied by any
        renderer, now or later. Reporting the generic "not yet supported"
        message here instead would tell an author to wait for a version that
        will never make their manifest valid.
      */
      if (i === 0 && reads !== 'previous') {
        errors.push(
          `"${where}.reads" is "${reads}", but pass 0 reads the layer itself — `
          + `its "src" and its "origin" are the same texture. Omit "reads" on the first pass.`,
        );
        bad = true;
        return;
      }

      /*
        Then the temporary one. Same reasoning as `scale`, different mechanism.

        The chain ping-pongs between a small pool of targets, so the pass-0
        input is overwritten by the time a later pass could sample it — keeping
        it alive needs a target reserved for the whole chain, which contends
        with the one glow borrows for its wide lobe. Binding a stale or reused
        texture as `origin` would composite against whatever was last drawn
        there, which is not a wrong picture so much as a random one.
      */
      if (reads !== 'previous') {
        errors.push(
          `"${where}.reads" is "${reads}", which this version cannot render. `
          + `Keeping the pass-0 input alive needs a render target reserved across the whole `
          + `chain, and the effect pool has none to spare. Use "previous" for now.`,
        );
        bad = true;
        return;
      }
    }

    passes.push({ name, wgsl, scale, reads });
  });

  if (bad) return undefined;

  const cost = chainCost(passes);
  if (cost > MAX_PASS_COST) {
    errors.push(
      `"${at}.passes" costs ${cost.toFixed(2)} full-scale passes; the budget is ${MAX_PASS_COST}. `
      + `A pass at scale s costs s² — render the expensive passes at 0.5 or 0.25 to fit.`,
    );
    return undefined;
  }

  return passes;
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
 * Bytes the renderer's own vertex header occupies before any plugin parameter.
 *
 * ★ This is not padding — it is the block every effect material in this
 * renderer already has, and a plugin effect is just another material.
 *
 *   `mvp    : mat3x3<f32>`  48 bytes (std140 pads each column to a vec4)
 *   `uvRect : vec4<f32>`    16 bytes
 *
 * Discovered by reading `packSharpen` and the `sharpen` shader rather than by
 * reasoning: the first version of this file generated a struct containing ONLY
 * the plugin's parameters, which would have compiled, bound, and drawn a quad
 * with a garbage transform — the vertex shader reads `mvp` from exactly these
 * bytes. Nothing would have errored.
 */
export const UNIFORM_RENDERER_HEADER_BYTES = 64;
const MAT3_STD140_FLOATS = 12;

/**
 * The host's own block, between the renderer's header and the author's params.
 *
 * ── Why a pass needs this ────────────────────────────────────────────────────
 *
 * A separable blur samples its neighbours: `uv ± texelSize * i`. Texel size
 * depends on the target's dimensions, and a pass at `scale: 0.25` renders into
 * a target a quarter the size — so the value differs per pass, and an author
 * cannot compute it. Without it the only way to write a blur is to hardcode a
 * resolution, which is wrong on every composition but the author's.
 *
 *   offset 64   texelSize : vec2<f32>   1 / target dimensions
 *   offset 72   passScale : f32         this pass's scale
 *   offset 76   passIndex : f32         0-based; a chain can branch on it
 *   offset 80   _reserved : vec4<f32>   zeroed
 *
 * `_reserved` is 16 bytes and is not slack for its own sake. It rounds the
 * block to 32 so the parameter base lands on 96 — a multiple of 16, which is
 * what a `vec4` parameter needs — and it means the next thing this block has to
 * carry (frame time is the obvious candidate) does not move every parameter
 * offset again. Moving them once, as this change does, already invalidates a
 * live probe figure; moving them twice would invalidate a shipped plugin.
 *
 * Emitted for EVERY effect, single-pass included. A single-pass effect is a
 * one-pass chain as far as the uniform block is concerned, and two layouts —
 * one with the block, one without — would mean the offsets depend on a
 * condition, which is the exact shape of the bug that made the 64-byte header
 * necessary in the first place.
 */
export const UNIFORM_PASS_BLOCK_BYTES = 32;

/** Where an effect's own parameters begin. Renderer header + host pass block. */
export const UNIFORM_HEADER_BYTES =
  UNIFORM_RENDERER_HEADER_BYTES + UNIFORM_PASS_BLOCK_BYTES;

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
    /*
      Binding-typed parameters are not members of this block at all.

      A `layer` has no size and no alignment, so including it would push every
      following offset by whatever `WGSL_SIZE` happened to return for it —
      `undefined`, here, which yields NaN offsets and a struct that no longer
      describes the bytes the CPU packs. Filtered at the top so the sort, the
      offsets and the emitted members all see one consistent set.
    */
    .filter(([, schema]) => !(EFFECT_BINDING_TYPES as readonly string[]).includes(schema.type))
    .map(([name, schema]) => ({ name, type: schema.type as EffectParamType }))
    // Descending alignment, then name, so the ordering is stable across runs —
    // an unstable order would make the shader cache key change for an unchanged
    // effect, recompiling on every load.
    .sort((a, b) => WGSL_SIZE[b.type].align - WGSL_SIZE[a.type].align || a.name.localeCompare(b.name));

  const layout: Array<{ name: string; type: EffectParamType; offset: number }> = [];
  /*
    Offsets start AFTER the renderer's vertex header, not at zero. `mvp` and
    `uvRect` occupy the first 64 bytes of every effect material's uniform block
    in this renderer, and the generated vertex shader below reads them from
    exactly there. Starting at zero would overlay the plugin's first parameter
    on the transform — which compiles, binds, and draws a quad in the wrong
    place with no error anywhere.
  */
  let offset = UNIFORM_HEADER_BYTES;
  const members: string[] = [
    '  mvp : mat3x3<f32>,',
    '  uvRect : vec4<f32>,',
    // The host pass block. Declared for every effect, single-pass included —
    // see UNIFORM_PASS_BLOCK_BYTES for why there is not a narrower variant.
    '  texelSize : vec2<f32>,',
    '  passScale : f32,',
    '  passIndex : f32,',
    '  _reserved : vec4<f32>,',
  ];

  for (const e of entries) {
    const { size, align } = WGSL_SIZE[e.type];
    offset = Math.ceil(offset / align) * align;
    layout.push({ name: e.name, type: e.type, offset });
    members.push(`  ${e.name} : ${WGSL_TYPE[e.type]},`);
    offset += size;
  }

  // A uniform buffer's size must be a multiple of 16. The header alone already
  // makes the struct legal, so an effect with no parameters — a fixed colour
  // grade, say — needs no padding member of its own.
  const size = Math.max(UNIFORM_HEADER_BYTES, Math.ceil(offset / 16) * 16);

  return {
    wgsl: `struct Object {\n${members.join('\n')}\n};`,
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
  /**
   * Which pass of the effect's chain to compose. Ignored — and necessarily so —
   * for a single-pass effect, whose source is `effect.shader`.
   */
  passIndex = 0,
): { wgsl: string; layout: ReturnType<typeof parameterBlock> } {
  const layout = parameterBlock(effect.params);
  const layers = layerParamNames(effect.params);
  const pass = effect.passes?.[passIndex];
  const source = pass ? pass.wgsl : effect.shader;
  const readsOrigin = pass ? pass.reads === 'origin' || pass.reads === 'both' : false;
  const wgsl = [
    layout.wgsl,
    '@group(0) @binding(0) var<uniform> params : Object;',
    '@group(0) @binding(1) var src : texture_2d<f32>;',
    '@group(0) @binding(2) var samp : sampler;',
    /*
      The second texture, named for the parameter that selects it.

      Emitted only when the effect declares a `layer` parameter, because a bind
      group entry with nothing bound to it is an invalid pipeline — an effect
      that does not ask for a second texture must not be handed a slot for one.

      Named after the author's parameter rather than a fixed `map`, so the
      source reads the way the manifest does: declare `params: { depth: {type:
      "layer"} }` and sample `depth`. There is no `params.depth` — a layer is a
      binding, not a value, and the two namespaces do not collide because the
      uniform block never contains it.
    */
    ...(layers.length > 0
      ? [`@group(0) @binding(3) var ${layers[0]} : texture_2d<f32>;`]
      : []),
    /*
      The pass-0 input, for a pass that composites against it.

      Binding 4 and not 3, even when the effect declares no layer parameter, so
      `origin` sits at one number for every effect that has one. Reusing 3 when
      it happens to be free would make the binding table depend on an unrelated
      part of the manifest, and the resource-binding side would have to
      reproduce that same condition to agree — two places that must reach the
      same conclusion, which is how a bind group ends up pointing a shader at
      the wrong texture.

      A gap at 3 is legal: WebGPU numbers bindings, it does not require them to
      be contiguous.
    */
    ...(readsOrigin
      ? ['@group(0) @binding(4) var origin : texture_2d<f32>;']
      : []),
    '',
    /*
      The VERTEX shader is generated too, not just the bindings.

      Every effect material in this renderer needs one, and it is the same
      full-screen quad transform in all of them — so asking each plugin author
      to write it would be asking them to hand-copy a matrix multiply whose only
      possible contribution is a bug. It also means the author never has to know
      that `mvp` and `uvRect` exist, which is what lets the parameter block stay
      the whole interface they see.
    */
    'struct VOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };',
    '@vertex fn vs(@location(0) pos : vec2<f32>) -> VOut {',
    '  var o : VOut;',
    '  let p = params.mvp * vec3<f32>(pos, 1.0);',
    '  o.pos = vec4<f32>(p.xy, 0.0, p.z);',
    '  o.uv = params.uvRect.xy + pos * params.uvRect.zw;',
    '  return o;',
    '}',
    '',
    source,
  ].join('\n');

  return { wgsl, layout };
}

/** How many shaders an effect compiles to. One per pass, or one. */
export function effectPassCount(effect: EffectContribution): number {
  return effect.passes?.length ?? 1;
}

/**
 * Pack the renderer's vertex header into a block from `parameterBlock`.
 *
 * `mvp` is a column-major 3x3 as nine floats; std140 pads each column out to a
 * `vec4`, which is the whole reason the header is 64 bytes rather than 52.
 * Taken as plain arrays so this module does not import the renderer's `Mat3` —
 * it is the seam between two packages, and a seam that imports both sides is
 * not a seam.
 */
export function packUniformHeader(
  buffer: ArrayBuffer,
  mvp: readonly number[],
  uvRect: { x: number; y: number; width: number; height: number },
): void {
  const view = new DataView(buffer);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      view.setFloat32((col * 4 + row) * 4, mvp[col * 3 + row] ?? 0, true);
    }
    // The pad float each column carries. Written explicitly rather than left as
    // whatever the buffer held, so a reused buffer cannot leak into it.
    view.setFloat32((col * 4 + 3) * 4, 0, true);
  }
  const at = MAT3_STD140_FLOATS * 4;
  view.setFloat32(at + 0, uvRect.x, true);
  view.setFloat32(at + 4, uvRect.y, true);
  view.setFloat32(at + 8, uvRect.width, true);
  view.setFloat32(at + 12, uvRect.height, true);
}

/**
 * Pack the host's pass block — the 32 bytes at offset 64.
 *
 * Written on every draw, for every effect, whether or not it declares a chain.
 * Leaving it as whatever the buffer last held would give a single-pass effect a
 * `texelSize` from some other layer's target, and an author who reached for it
 * would get a blur that changes width depending on what was rendered before.
 *
 * `_reserved` is zeroed explicitly for the same reason: it is the one part of
 * the block a future version will start using, and a plugin that read stale
 * bytes from it today would break on the day it becomes meaningful.
 */
export function packPassBlock(
  buffer: ArrayBuffer,
  target: { width: number; height: number },
  passScale: number,
  passIndex: number,
): void {
  const view = new DataView(buffer);
  const at = UNIFORM_RENDERER_HEADER_BYTES;
  // Guarded, because a zero-sized target is a real state during teardown and a
  // division by it puts Infinity in a uniform — which does not throw, and
  // renders a layer that is entirely one colour.
  view.setFloat32(at + 0, target.width > 0 ? 1 / target.width : 0, true);
  view.setFloat32(at + 4, target.height > 0 ? 1 / target.height : 0, true);
  view.setFloat32(at + 8, passScale, true);
  view.setFloat32(at + 12, passIndex, true);
  for (let i = 0; i < 4; i++) view.setFloat32(at + 16 + i * 4, 0, true);
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
