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
import {
  validateWgsl,
  EXTENDED_SHADER_LIMITS,
  STANDARD_SHADER_LIMITS,
  type ShaderLimits,
} from './wgslValidation';
import { validateGlsl } from './glslValidation';

/** Types that can be a shader uniform — a VALUE in the parameter block. */
export const EFFECT_UNIFORM_TYPES = ['number', 'color', 'boolean', 'point'] as const;
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
 * At most FOUR layer parameters per effect.
 *
 * ── Why it was one, and why it is four ───────────────────────────────────────
 *
 * One was the number of slots the generated bind group had. That was honest at
 * the time and is the wrong ceiling for the effects people actually write: a
 * compositing effect blends two inputs against a matte, a lighting one wants
 * colour plus depth plus a normal map. Each extra input costs a binding number,
 * a resolution in the render graph and a decision about what happens when the
 * referenced layer is gone — all of which the first one already paid for, so
 * the marginal cost of the second is small and the marginal VALUE is large.
 *
 * Four rather than an open list because each is a real texture bound on every
 * draw, and because the binding numbers have to be fixed constants that the
 * shader generator, the material layout and the bind-group writer all agree on
 * without negotiating (see {@link LAYER_BINDINGS}).
 */
export const MAX_LAYER_PARAMS_PER_EFFECT = 4;

/**
 * The binding number each layer parameter lands on, in declaration order.
 *
 * ★ 3, then 5, 6, 7 — 4 is skipped, permanently.
 *
 * Binding 4 is `origin`, the pass-0 input, and it is fixed there whether or not
 * any layer parameter exists. Packing the second layer into 4 when no origin is
 * declared would make a binding number depend on an unrelated part of the
 * manifest, and three separate places would each have to reproduce that
 * condition and agree — which is how a bind group ends up pointing a shader at
 * the wrong texture. A gap is legal: WebGPU numbers bindings, it does not
 * require them contiguous.
 */
export const LAYER_BINDINGS = [3, 5, 6, 7] as const;

/** The `origin` texture's binding, quoted here so the gap above is explicit. */
export const ORIGIN_BINDING_INDEX = 4;

/**
 * The GLSL sampler name each layer parameter is declared under.
 *
 * Fixed names, not the author's, because WebGL2 matches samplers to texture
 * units by NAME in the order the material declares them — and the material is
 * built in the renderer, which has never heard of the author's vocabulary. The
 * generated preamble adds a `#define` so the author still writes their own name;
 * see `composeEffectGlsl`.
 */
export const GLSL_LAYER_SAMPLERS = [
  'pluginLayer0', 'pluginLayer1', 'pluginLayer2', 'pluginLayer3',
] as const;

/** The GLSL sampler names, in BIND-GROUP ENTRY order, for a given effect shape.
 *
 *  Entry order is what WebGL2 counts texture units in — input, then binding 3,
 *  then binding 4, then 5/6/7 — so this is not the same order as the bindings
 *  are numbered, and it is the order that matters to the backend. */
export function glslSamplerNames(layerCount: number, readsOrigin: boolean): string[] {
  const names = ['src'];
  if (layerCount > 0) names.push(GLSL_LAYER_SAMPLERS[0]!);
  if (readsOrigin) names.push('pluginOrigin');
  for (let i = 1; i < Math.min(layerCount, MAX_LAYER_PARAMS_PER_EFFECT); i++) {
    names.push(GLSL_LAYER_SAMPLERS[i]!);
  }
  return names;
}

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
  /**
   * Same one-`fs`-function contract, same validator, as a single-pass effect.
   *
   * Optional since GLSL kernels landed: a pass may ship WGSL, GLSL, or both,
   * and a chain that ships one language everywhere runs on that backend.
   */
  wgsl?: string;
  /** The GLSL ES 3.0 twin of `wgsl`, for the WebGL2 tier. */
  glsl?: string;
  /** Render-target downsample. Default 1. */
  scale?: PassScale;
  /** Default `'previous'`. */
  reads?: PassReads;
}

/**
 * A CPU kernel: the effect, as code, for machines and paths with no GPU pass.
 *
 * ── What this is for, and what it is not ─────────────────────────────────────
 *
 * It is NOT "plugin JS in the frame loop" — that remains refused, and for the
 * unchanged reason: a per-frame `postMessage` to a plugin's worker is a
 * stuttering playback and a multi-minute export. A kernel is a pure function
 * over a pixel buffer, shipped as WASM or as a module with no host access, run
 * in a POOL of workers the host owns (`src/core/plugins/kernel`). The plugin's
 * own worker is not involved and is not woken.
 *
 * It exists for two jobs that the GPU path cannot do:
 *
 *   1. **The backend has no kernel.** A WGSL-only effect on the WebGL2 tier
 *      used to render its input unchanged. With a CPU kernel it renders.
 *   2. **Preview and export must AGREE.** The CPU raster path bakes a layer
 *      when something forces it off the GPU (a mask-scoped effect, fill
 *      opacity, a path-following style). Without a CPU twin the plugin effect
 *      silently vanished from exactly those layers — the same class of bug the
 *      built-in effects keep a CPU twin to avoid (see `deepGlow.ts`).
 */
export interface EffectCpuKernel {
  /**
   * Path inside the plugin package to the kernel module.
   *
   * Read through the package reader rather than fetched, so a kernel is subject
   * to the same integrity check as the rest of the package and cannot be
   * swapped after install.
   */
  module: string;
  /** Inferred from the extension when absent — `.wasm` is wasm, anything else JS. */
  format?: 'wasm' | 'js';
  /** The exported function. Default `render`. */
  entry?: string;
}

/**
 * How an effect's kernels may be scheduled — OFX's and After Effects' question.
 *
 *   • `unsafe`   — one call at a time across the whole plugin. Chosen by an
 *                  author whose kernel keeps module-level state; the pool
 *                  serialises every effect of that plugin onto one lane.
 *   • `instance` — concurrent across effect INSTANCES, serial within one. The
 *                  default, and the one an ordinary kernel wants: two layers
 *                  carrying the same effect bake on two workers, while one
 *                  layer's successive frames stay in order.
 *   • `full`     — no constraint. Frames of the same instance may overlap.
 *
 * Default `instance` rather than `full` because the failure modes are not
 * symmetric: a `full` declaration on a kernel that is not is a race that shows
 * up as one corrupt frame in a hundred, which is unreportable. An over-strict
 * default costs throughput and nothing else.
 */
export const THREAD_SAFETY = ['unsafe', 'instance', 'full'] as const;
export type ThreadSafety = (typeof THREAD_SAFETY)[number];

/**
 * How far outside its layer box an effect writes, per SIDE.
 *
 * After Effects calls this the max result rect, and its pre-render phase asks
 * for it before allocating anything. `spread` (above) answers the same question
 * with one number for all four sides, which is right for a glow and wrong for
 * everything directional: a drop shadow offset down-right reaches on two sides
 * and must not enlarge the buffer on the other two.
 *
 * Each side is a formula over the effect's parameters for the reason `spread`
 * is — reach is animatable, and a constant would have to be the worst case on
 * every frame.
 */
export interface EffectExpand {
  left?: EffectSpread | number;
  top?: EffectSpread | number;
  right?: EffectSpread | number;
  bottom?: EffectSpread | number;
}

/**
 * When this effect is the identity, and the pass can be skipped entirely.
 *
 * AE's `PF_Cmd_SMART_PRE_RENDER` lets an effect answer "I would not change
 * anything", and the host then routes the input straight through. It matters
 * more than it sounds: an effect stack is full of effects sitting at zero,
 * each costing a full-screen pass, a target and a pipeline bind per frame.
 *
 * ── Why it is DATA and not a function the plugin runs ────────────────────────
 *
 * The same constraint that makes effects shaders-as-data: asking the plugin's
 * worker whether it is the identity is an async hop inside a synchronous
 * render. So the author declares the conditions and the host evaluates them,
 * per frame, from the live parameter values. Every condition must hold — an
 * effect is the identity when ALL of its reasons to do nothing are true.
 */
export interface EffectIdentityRule {
  /** A number or boolean parameter of this effect. */
  param: string;
  /** The value at which this parameter contributes nothing. */
  equals: number | boolean;
}

/**
 * How far outside its layer an effect reaches, as a function of a parameter.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * A 3D layer's effect chain renders into a layer-space buffer with a margin
 * reserved around it, and the margin is computed per frame from the effects on
 * the layer: a blur asks for `radius × tail`, a drop shadow for its offset plus
 * the tail, and so on. A plugin effect had no way to answer that question, so
 * it was budgeted zero — and a plugin glow on a 3D layer was clipped flat at
 * the layer's edge while a built-in one bled correctly.
 *
 * ── Why it is a formula and not a number ─────────────────────────────────────
 *
 * The reach of a real effect depends on its parameters, and parameters are
 * animatable. A fixed `spreadPx: 40` would have to be the worst case for every
 * frame — so a blur animating 0 → 40 would reserve a 40px margin on the frame
 * where the radius is 0, on every layer, forever. Naming the parameter lets the
 * host compute the real number each frame, which is what After Effects' own
 * pre-render phase does.
 *
 * `factor` exists because reach is rarely the parameter itself: a Gaussian's
 * visible tail runs to about 2.5σ, so a blur declaring `radius` needs a factor
 * near that or the margin clips the very tail it was reserved for.
 */
export interface EffectSpread {
  /** A `number` parameter of this effect. */
  param: string;
  /** Multiplier on the parameter's value. Default 1. */
  factor?: number;
  /** Added after the multiply — a fixed component, e.g. a stroke width. */
  plus?: number;
}

export interface EffectContribution {
  /** Plugin-local. The host namespaces it as `<pluginId>.<id>`. */
  id: string;
  label: string;
  /**
   * How far this effect draws outside the layer. Absent means "not at all".
   *
   * Absent is the right default and not merely the safe one: the overwhelming
   * majority of effects — colour grades, distortions, anything that maps a
   * pixel to a pixel — genuinely do not leave the rectangle, and reserving
   * margin for them would enlarge every 3D layer's effect buffer for nothing.
   */
  spread?: EffectSpread;
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
  /**
   * The GLSL ES 3.0 twin of `shader`, for the WebGL2 tier.
   *
   * Optional, and an effect that ships only WGSL behaves exactly as it always
   * has. What changed is that the gap is now the author's to close rather than
   * the platform's to apologise for.
   */
  glsl?: string;
  /** A CPU kernel, for backends with no GPU kernel and for the raster/export path. */
  cpu?: EffectCpuKernel;
  params: Record<string, LayerPropSchema>;
  /** A declared, host-orchestrated chain. Absent for a single-pass effect. */
  passes?: EffectPass[];
  /** Per-side reach, when one number for all four sides is the wrong shape. */
  expand?: EffectExpand;
  /** Conditions under which this effect does nothing and its passes are skipped. */
  identity?: EffectIdentityRule[];
  /** How the CPU kernel may be scheduled. Default `instance`. */
  threadSafety?: ThreadSafety;
  /**
   * Frames of THIS layer's own source the kernel may read, as `[before, after]`.
   *
   * OFX's `getFramesNeeded` and AE's temporal checkout. Absent means "this
   * frame only", which is every effect that is not a temporal one. See
   * `MAX_TEMPORAL_WINDOW` for the ceiling and `docs/PLUGINS.md` for what the
   * provider can actually supply — the honest answer is narrower than the
   * declaration, and an author needs to read it before designing around this.
   */
  frames?: [number, number];
  /**
   * Which of this effect's params invalidate the state it remembers between
   * frames — AE's sequence data, see `native/nativeSequenceData.ts`.
   *
   * Only meaningful for a NATIVE effect, which is the only tier that gets a
   * state round trip; a WGSL pass has nothing to remember between frames by
   * construction.
   *
   * Absent means "nothing invalidates it", and that is the right default
   * rather than the lazy one. The expensive caches this exists for — a decoded
   * LUT, a BVH over a mesh, an optical-flow field over the plate — depend on
   * the SOURCE, not on the controls, and rebuilding them whenever a slider
   * moves is exactly the cost the feature removes. An effect whose cache does
   * depend on a control names it here; nobody else can know which.
   *
   * Names are param names. Unknown ones are refused at parse rather than
   * ignored: a typo here is a cache that silently never invalidates, which
   * shows up as a wrong frame long after the manifest was written.
   */
  invalidateOn?: string[];
  /**
   * Which of this effect's params the plugin wants to be TOLD about — AE's
   * `PF_Cmd_USER_CHANGED_PARAM`.
   *
   * When one of these is committed, the host calls the plugin with the whole
   * parameter block and applies whatever it hands back. That is what makes a
   * preset dropdown possible: pick "Filmic" and the plugin writes the eight
   * sliders under it, rather than the eight being the only interface there is.
   *
   * Absent means never, and that is the default because supervision is a round
   * trip per commit. An effect that names nothing here costs exactly what it
   * always did.
   *
   * Names are checked against this effect's own params, for the same reason
   * `invalidateOn`'s are: a name matching nothing is a callback that never
   * fires, and nothing on screen says so.
   */
  supervises?: string[];
  /**
   * Which ceiling tier this effect's kernels are checked against.
   *
   * `extended` is available only to a plugin the user installed themselves —
   * a local folder or developer mode. See `EFFECT_LIMIT_TIERS`.
   */
  limits?: EffectLimitTier;
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
 *      which is ≤ 6 — so a budget of 6 does not refuse the chain the original
 *      brief said it must.
 *
 * ── ★ The acceptance criterion was RETIRED, deliberately ─────────────────────
 *
 * The budget was 3 (and the count 4) because that pair is the only one that
 * satisfies "must refuse a four-pass full-scale chain". That criterion has been
 * dropped: the product goal is now plugins that can express genuinely complex
 * effects, and a rule whose entire purpose was to refuse the four-pass chain is
 * the rule standing in the way of it. Recorded here rather than quietly edited,
 * because the old numbers were REASONED to, not guessed — a reader who finds 6
 * where the argument above concludes 3 deserves to know which premise moved.
 *
 * What did NOT move is why the budget is denominated in pixels rather than in
 * passes. That half was never about the ceiling; it is about counting the right
 * thing, and it is still counting it.
 *
 * ── Why this ceiling cannot adapt to the machine ─────────────────────────────
 *
 * The obvious "let a strong GPU allow more" is wrong AT THIS LAYER, and the
 * reason is worth stating so it stops being re-proposed. This runs inside
 * `parseEffects` — MANIFEST VALIDATION — which the registry runs too, on a
 * server with no GPU. A machine-dependent budget would mean a plugin that
 * validates on publish and is refused at install, with nothing telling the
 * author which machine drew the line. A limit checked where a manifest is
 * checked has to be a constant. Adapting to the hardware is a RENDER-time
 * decision (drop `scale`, skip a pass) and belongs beside Adaptive Resolution,
 * not here.
 *
 * What 6 admits:
 *
 *   separable blur, two full-scale passes          1 + 1                 = 2    ✓
 *   bloom: bright-pass, blur ×2 at ¼, composite    1 + 0.0625×2 + 1      ≈ 2.13 ✓
 *   four full-scale passes                         1 × 4                 = 4    ✓  ← was refused
 *   six full-scale passes                          1 × 6                 = 6    ✓
 *   eight quarter-scale passes                     0.0625 × 8            = 0.5  ✓
 *   eight full-scale passes                        1 × 8                 = 8    ✗
 *
 * The count rises with it (4 → 8) because a budget of 6 with a cap of 4 would
 * make the cap the real limit for every cheap chain — eight quarter-scale
 * passes cost half of one full pass and were refused on a count that no longer
 * had a cost argument behind it.
 */
export const MAX_PASSES_PER_EFFECT = 8;
export const MAX_PASS_COST = 6;

/**
 * The two ceiling tiers, and the ONE thing that separates them.
 *
 * Every RULE is identical in both: no unbounded loop, no author bindings, no
 * compute entry point, a `fs` entry. Only the NUMBERS move — source size, the
 * literal loop bound, how many passes, how much fill.
 *
 * ── Why a tier exists at all ─────────────────────────────────────────────────
 *
 * The standard numbers are sized for code arriving from a registry: the user
 * did not write it, cannot read it, and the only thing between a hostile loop
 * and a GPU reset is a lexical scan. A plugin the user dropped into their own
 * Plugins folder is a different relationship — the same one they have with a
 * script they wrote. Refusing that author a 512-tap kernel protects nobody.
 *
 * ── Why the host, not the manifest, decides ──────────────────────────────────
 *
 * `limits: "extended"` is a REQUEST. It is granted only when the installer says
 * the package is trusted (local folder, developer mode, or a signed package
 * from a publisher the user has trusted), and refused with a message naming the
 * reason otherwise. A manifest field that raised its own ceiling would be a
 * ceiling that does not exist — every registry plugin would simply declare it.
 */
export const EFFECT_LIMIT_TIERS = ['standard', 'extended'] as const;
export type EffectLimitTier = (typeof EFFECT_LIMIT_TIERS)[number];

/** Pass ceilings per tier. The shader ones live in `wgslValidation`. */
export const EXTENDED_MAX_PASSES_PER_EFFECT = 16;
export const EXTENDED_MAX_PASS_COST = 12;

export interface EffectTierLimits {
  shader: ShaderLimits;
  passes: number;
  passCost: number;
}

export function effectTierLimits(tier: EffectLimitTier): EffectTierLimits {
  return tier === 'extended'
    ? {
      shader: EXTENDED_SHADER_LIMITS,
      passes: EXTENDED_MAX_PASSES_PER_EFFECT,
      passCost: EXTENDED_MAX_PASS_COST,
    }
    : { shader: STANDARD_SHADER_LIMITS, passes: MAX_PASSES_PER_EFFECT, passCost: MAX_PASS_COST };
}

/**
 * How far either side of the current frame a temporal effect may reach.
 *
 * Two, which is what a frame-difference, a trail or a simple retimer needs, and
 * small enough that the provider can hold the window without a second decode
 * pipeline. An open range would mean an effect could ask for a frame the
 * provider must seek to — and a seek per pixel-pass is an export that never
 * finishes.
 */
export const MAX_TEMPORAL_WINDOW = 2;

/**
 * The grammar version each effect field arrived in.
 *
 * A table rather than an `if` per field, for the reason `RENDER_STRATEGY_SINCE`
 * is one: the gate and the message that explains it have to agree, and a second
 * `if` written next year is how they stop agreeing.
 *
 * ── Why all of these are gated, when `effects` itself is only API 4 ──────────
 *
 * The documented rule (docs/PLUGINS.md) is that a newer manifest FIELD costs an
 * `apiVersion` bump, while `requires`/`optional` says what the host must be able
 * to DO. These are fields, and the parser does not refuse unknown keys — so on a
 * host that predates them they are SILENTLY IGNORED, which is the one outcome
 * this codebase does not accept. `expand` ignored is an effect clipped at the
 * layer edge with nothing to read; `cpu` ignored is an effect that renders on
 * the GPU tier and vanishes from every rasterised layer and from export.
 *
 * ── The cost, stated plainly ─────────────────────────────────────────────────
 *
 * An author who wants to install on an older host must ship without these
 * fields, because declaring `"apiVersion": 7` makes that host refuse the whole
 * package. That is the intended trade: a refusal at install, naming the version,
 * beats a plugin that installs and half works.
 */
export const EFFECT_FIELD_SINCE: Readonly<Record<string, number>> = {
  glsl: 7,
  cpu: 7,
  expand: 7,
  identity: 7,
  threadSafety: 7,
  frames: 7,
  limits: 7,
  // Sequence data's invalidation list. Grammar 7 like the rest of this round —
  // it is a new manifest key, and the ability to USE the state round trip is a
  // property of the native tier rather than of the grammar.
  invalidateOn: 7,
  supervises: 7,
};

/**
 * Layer parameters past the FIRST arrived with the four-binding layout.
 *
 * Gated on the count rather than on a field name, because the field is `params`
 * and that one is as old as effects are. An older host has one binding to give,
 * so a second layer parameter there is a texture that is declared, shown in the
 * inspector, and bound to nothing.
 */
export const EXTRA_LAYER_PARAMS_SINCE = 7;

/** Options that come from the INSTALLER, not from the manifest. */
export interface EffectParseOptions {
  /**
   * The package is the user's own — a local folder, developer mode, or a
   * publisher they have trusted. Only then may `limits: "extended"` be granted.
   *
   * Defaults to false, which is what the registry's own validation must use:
   * it runs on a server, for a package nobody has chosen to trust yet.
   */
  trusted?: boolean;
  /**
   * The manifest's declared grammar version, for the gates above.
   *
   * Absent means UNGATED, matching `parseLayerKinds`: a caller that parses an
   * effect list on its own — a test, a tool — is not making a version claim, and
   * inventing one for it would refuse fields on a manifest that has no
   * `apiVersion` to raise. `parseManifest` always passes it.
   */
  apiVersion?: number;
}

/** Push the version message for `field`, and say whether it is out of reach. */
function gateField(
  field: string,
  at: string,
  apiVersion: number | undefined,
  errors: string[],
): boolean {
  const since = EFFECT_FIELD_SINCE[field]!;
  if (apiVersion === undefined || apiVersion >= since) return false;
  errors.push(`"${at}.${field}" requires "apiVersion": ${since}.`);
  return true;
}

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
export function parseEffects(
  raw: unknown,
  errors: string[],
  options: EffectParseOptions = {},
): EffectContribution[] {
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
      The ceiling tier, read BEFORE any kernel, because every kernel below is
      checked against it. A request for `extended` from a package the installer
      did not vouch for is refused rather than quietly downgraded: an author who
      wrote a 512-tap kernel needs to know it will not run, not to discover it
      from a refusal deeper in the list.
    */
    let tier: EffectLimitTier = 'standard';
    if (entry.limits !== undefined) {
      if (gateField('limits', at, options.apiVersion, errors)) return;
      if (!(EFFECT_LIMIT_TIERS as readonly unknown[]).includes(entry.limits)) {
        errors.push(`"${at}.limits" must be one of ${EFFECT_LIMIT_TIERS.join(', ')}.`);
        return;
      }
      tier = entry.limits as EffectLimitTier;
      if (tier === 'extended' && !options.trusted) {
        errors.push(
          `"${at}.limits" is "extended", which is only granted to a plugin you installed yourself — `
          + `a local folder or developer mode. A published plugin is held to the standard ceilings, `
          + `because the person running it did not write it and cannot read it.`,
        );
        return;
      }
    }
    const limits = effectTierLimits(tier);

    /*
      One source of shader source, never two.

      An effect declaring both `shader` and `passes` has said two different
      things about what it draws, and there is no reading of it that is
      obviously right — running the chain silently ignores source the author
      wrote, running `shader` silently ignores the chain. Both are the kind of
      "worked, but not the way you wrote it" that costs an afternoon.
    */
    if (entry.glsl !== undefined && gateField('glsl', at, options.apiVersion, errors)) return;

    const hasPasses = entry.passes !== undefined;
    const hasShader = typeof entry.shader === 'string' && entry.shader.trim() !== '';
    const hasGlsl = typeof entry.glsl === 'string' && entry.glsl.trim() !== '';
    if (hasPasses && (hasShader || hasGlsl)) {
      errors.push(
        `"${at}" declares both "shader"/"glsl" and "passes". Use "shader"/"glsl" for a single-pass effect `
        + `or "passes" for a chain — an effect that declares both does not say which one draws.`,
      );
      return;
    }

    const passes = hasPasses
      ? parsePasses(entry.passes, at, errors, limits, options.apiVersion)
      : undefined;
    if (hasPasses && !passes) return;

    /*
      A CPU kernel, parsed before the shaders so "this effect has SOME kernel"
      is answerable below.
    */
    if (entry.cpu !== undefined && gateField('cpu', at, options.apiVersion, errors)) return;
    const cpu = entry.cpu !== undefined ? parseCpuKernel(entry.cpu, at, errors) : undefined;
    if (entry.cpu !== undefined && !cpu) return;

    /*
      A chain's `shader` is its FIRST pass.

      Everything downstream of parsing — the material, the registry, the
      renderer's single-pass path — already reads `shader`, and giving the
      chain's head that name means a two-pass effect degrades to its first pass
      rather than to nothing if a caller has not been taught about chains yet.
      For a single-pass effect this is just the author's source.
    */
    const shader = passes
      ? (passes[0]!.wgsl ?? '')
      : (typeof entry.shader === 'string' ? entry.shader : '');
    const glsl = passes
      ? passes[0]!.glsl
      : (hasGlsl ? (entry.glsl as string) : undefined);

    // A chain's passes were each validated inside `parsePasses`; re-running the
    // validator on the head here would report every problem in pass 0 twice.
    if (!passes) {
      /*
        At least one kernel, or the effect is a row in the browser that changes
        no pixels anywhere.

        This used to be implicit — `shader` was required — and stating it is
        what makes the other two kernels optional without making ALL of them
        optional. The message names all three so an author who meant to ship a
        CPU kernel and misspelled the key sees the third option exists.
      */
      if (!hasShader && !hasGlsl && !cpu) {
        errors.push(
          `"${at}" declares no kernel. An effect needs at least one of "shader" (WGSL), `
          + `"glsl" (GLSL ES 3.0) or "cpu" — without one it appears in the browser, `
          + `shows its parameters, and changes no pixels on any machine.`,
        );
        return;
      }
      if (hasShader) {
        const check = validateWgsl(shader, limits.shader);
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
      if (hasGlsl) {
        const check = validateGlsl(glsl!, limits.shader);
        if (!check.ok) {
          for (const p of check.problems) {
            errors.push(`"${at}.glsl"${p.line ? ` line ${p.line}` : ''}: ${p.detail}`);
          }
          return;
        }
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
      /*
        A parameter may not take a name the host already uses.

        The generated struct contains the host's own members — `time`,
        `compSize`, `texelSize` and the rest — and a parameter of the same name
        emits a DUPLICATE member. WGSL and GLSL both refuse that, with an error
        naming a line in generated code the author never saw. Refusing it here
        costs one line in the manifest and names the collision.
      */
      if (RESERVED_PARAM_NAMES.has(name)) {
        errors.push(
          `"${at}.params.${name}" uses a name the host fills in. `
          + `${[...RESERVED_PARAM_NAMES].join(', ')} are already members of every effect's parameter block — `
          + `read them, do not declare them.`,
        );
        bad = true;
        continue;
      }

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
    /*
      More than one layer parameter is a GRAMMAR change, not a capability one:
      the extra bindings only exist in the layout this version generates. An
      older host has one slot, so the second parameter would draw a row in the
      inspector, resolve a layer, and bind it nowhere.
    */
    if (
      layers.length > 1
      && options.apiVersion !== undefined
      && options.apiVersion < EXTRA_LAYER_PARAMS_SINCE
    ) {
      errors.push(
        `"${at}.params" declares ${layers.length} layer parameters (${layers.join(', ')}); `
        + `more than one requires "apiVersion": ${EXTRA_LAYER_PARAMS_SINCE}.`,
      );
      return;
    }
    if (layers.length > MAX_LAYER_PARAMS_PER_EFFECT) {
      errors.push(
        `"${at}.params" declares ${layers.length} layer parameters (${layers.join(', ')}); `
        + `the limit is ${MAX_LAYER_PARAMS_PER_EFFECT}. Each one is a texture bound on every draw, `
        + `at a binding number the shader, the material and the bind group all have to agree on without negotiating.`,
      );
      return;
    }

    /*
      `spread` is parsed AFTER params, because it names one.

      A spread pointing at a parameter that does not exist, or at one that is
      not a number, would silently contribute nothing to the margin — and the
      symptom is a clipped glow on 3D layers only, which is about as hard to
      trace back to a manifest typo as anything gets.
    */
    let spread: EffectSpread | undefined;
    if (entry.spread !== undefined) {
      const parsed = parseSpread(entry.spread, `${at}.spread`, params, errors);
      if (!parsed) return;
      spread = parsed;
    }

    /*
      `expand`, parsed the same way and for the same reasons, per side.

      Deliberately allowed BESIDE `spread` rather than instead of it. `spread`
      is the whole-effect number a glow wants and the one every published
      effect already uses; `expand` names the sides a directional effect
      reaches on. An effect declaring both gets the larger of the two per side
      (see `effectExpandFor`), which is the only reading that cannot clip.
    */
    let expand: EffectExpand | undefined;
    if (entry.expand !== undefined) {
      if (gateField('expand', at, options.apiVersion, errors)) return;
      const e = entry.expand;
      if (!isPlainObject(e)) {
        errors.push(`"${at}.expand" must be an object with left/top/right/bottom.`);
        return;
      }
      const sides: EffectExpand = {};
      let badSide = false;
      for (const side of ['left', 'top', 'right', 'bottom'] as const) {
        const v = e[side];
        if (v === undefined) continue;
        if (typeof v === 'number') {
          if (!Number.isFinite(v) || v < 0) {
            errors.push(`"${at}.expand.${side}" must be a non-negative number of pixels.`);
            badSide = true;
            continue;
          }
          sides[side] = v;
          continue;
        }
        const parsed = parseSpread(v, `${at}.expand.${side}`, params, errors);
        if (!parsed) { badSide = true; continue; }
        sides[side] = parsed;
      }
      if (badSide) return;
      if (Object.keys(sides).length > 0) expand = sides;
    }

    /*
      `identity`, parsed after params because every rule names one.

      A rule pointing at a parameter that does not exist would make the effect
      NEVER the identity — which is invisible, costs a pass per frame forever,
      and is exactly the sort of manifest typo that nothing ever reports.
    */
    let identity: EffectIdentityRule[] | undefined;
    if (entry.identity !== undefined) {
      if (gateField('identity', at, options.apiVersion, errors)) return;
      if (!Array.isArray(entry.identity) || entry.identity.length === 0) {
        errors.push(
          `"${at}.identity" must be a non-empty array of { param, equals } rules. `
          + `An empty list would say the effect is the identity for no reason, which is not a claim.`,
        );
        return;
      }
      const rules: EffectIdentityRule[] = [];
      let badRule = false;
      entry.identity.forEach((r, ri) => {
        const where = `${at}.identity[${ri}]`;
        if (!isPlainObject(r)) {
          errors.push(`"${where}" must be an object.`);
          badRule = true;
          return;
        }
        const param = typeof r.param === 'string' ? r.param : '';
        const type = params[param]?.type;
        if (type !== 'number' && type !== 'boolean') {
          errors.push(
            `"${where}.param" is "${param}", which is not a number or boolean parameter of this effect. `
            + `Only a value the host can compare decides whether a pass can be skipped.`,
          );
          badRule = true;
          return;
        }
        const equals = r.equals;
        if (type === 'number' ? typeof equals !== 'number' || !Number.isFinite(equals) : typeof equals !== 'boolean') {
          errors.push(`"${where}.equals" must be a ${type === 'number' ? 'finite number' : 'boolean'}.`);
          badRule = true;
          return;
        }
        rules.push({ param, equals: equals as number | boolean });
      });
      if (badRule) return;
      identity = rules;
    }

    let threadSafety: ThreadSafety | undefined;
    if (entry.threadSafety !== undefined) {
      if (gateField('threadSafety', at, options.apiVersion, errors)) return;
      if (!(THREAD_SAFETY as readonly unknown[]).includes(entry.threadSafety)) {
        errors.push(`"${at}.threadSafety" must be one of ${THREAD_SAFETY.join(', ')}.`);
        return;
      }
      threadSafety = entry.threadSafety as ThreadSafety;
    }

    /*
      The temporal window. Refused when it is not a pair of integers inside the
      ceiling, and refused for a GPU-only effect on a point of honesty: the
      other frames arrive as texture inputs the render graph has to hold, and
      today only the CPU kernel path is handed them. Accepting the declaration
      and ignoring it would be a feature that exists in the manifest and nowhere
      else — which is precisely the shape of gap this round exists to close.
    */
    let frames: [number, number] | undefined;
    if (entry.frames !== undefined) {
      if (gateField('frames', at, options.apiVersion, errors)) return;
      const f = entry.frames;
      const ok = Array.isArray(f) && f.length === 2
        && f.every((n) => typeof n === 'number' && Number.isInteger(n))
        && (f[0] as number) <= 0 && (f[1] as number) >= 0
        && Math.max(Math.abs(f[0] as number), Math.abs(f[1] as number)) <= MAX_TEMPORAL_WINDOW;
      if (!ok) {
        errors.push(
          `"${at}.frames" must be [before, after] whole frames with before ≤ 0 ≤ after and `
          + `neither further than ${MAX_TEMPORAL_WINDOW} from this frame.`,
        );
        return;
      }
      if (!cpu) {
        errors.push(
          `"${at}.frames" needs a "cpu" kernel. Neighbouring frames are handed to a kernel as extra `
          + `input buffers, and the GPU path has no binding for them — declaring the window without `
          + `a kernel to receive it is a request nothing can satisfy.`,
        );
        return;
      }
      frames = [f[0] as number, f[1] as number];
    }

    /*
      Which params bust the cache this effect keeps between frames.

      Checked against the effect's OWN params rather than accepted as free
      text, because the failure mode of a typo is silent and late: the state is
      never invalidated, the plugin keeps returning frames derived from a stale
      analysis, and the author finds out from a user's render.
    */
    let invalidateOn: string[] | undefined;
    if (entry.invalidateOn !== undefined) {
      if (gateField('invalidateOn', at, options.apiVersion, errors)) return;
      const raw = entry.invalidateOn;
      if (!Array.isArray(raw) || raw.some((n) => typeof n !== 'string')) {
        errors.push(`"${at}.invalidateOn" must be an array of parameter names.`);
        return;
      }
      const unknown = (raw as string[]).filter((n) => !(n in params));
      if (unknown.length > 0) {
        errors.push(
          `"${at}.invalidateOn" names ${unknown.map((n) => `"${n}"`).join(', ')}, which `
          + `${unknown.length === 1 ? 'is not a parameter' : 'are not parameters'} of this effect. `
          + `A name that matches nothing is a cache that never invalidates.`,
        );
        return;
      }
      if (raw.length > 0) invalidateOn = [...new Set(raw as string[])];
    }

    /*
      Which params the plugin wants to hear about. Same validation as
      `invalidateOn` and for the same reason: a name that matches nothing is a
      callback that never fires, which is indistinguishable from a plugin that
      simply does not work.
    */
    let supervises: string[] | undefined;
    if (entry.supervises !== undefined) {
      if (gateField('supervises', at, options.apiVersion, errors)) return;
      const raw = entry.supervises;
      if (!Array.isArray(raw) || raw.some((n) => typeof n !== 'string')) {
        errors.push(`"${at}.supervises" must be an array of parameter names.`);
        return;
      }
      const unknown = (raw as string[]).filter((n) => !(n in params));
      if (unknown.length > 0) {
        errors.push(
          `"${at}.supervises" names ${unknown.map((n) => `"${n}"`).join(', ')}, which `
          + `${unknown.length === 1 ? 'is not a parameter' : 'are not parameters'} of this effect. `
          + `A name that matches nothing is a callback that never fires.`,
        );
        return;
      }
      if (raw.length > 0) supervises = [...new Set(raw as string[])];
    }

    out.push({
      id, label, shader, params,
      ...(glsl ? { glsl } : {}),
      ...(cpu ? { cpu } : {}),
      ...(passes ? { passes } : {}),
      ...(spread ? { spread } : {}),
      ...(expand ? { expand } : {}),
      ...(identity ? { identity } : {}),
      ...(threadSafety ? { threadSafety } : {}),
      ...(frames ? { frames } : {}),
      ...(invalidateOn ? { invalidateOn } : {}),
      ...(supervises ? { supervises } : {}),
      ...(tier !== 'standard' ? { limits: tier } : {}),
    });
  });

  return out;
}

/** One `{ param, factor, plus }` reach formula, shared by `spread` and `expand`. */
function parseSpread(
  raw: unknown,
  at: string,
  params: Record<string, LayerPropSchema>,
  errors: string[],
): EffectSpread | undefined {
  if (!isPlainObject(raw)) {
    errors.push(`"${at}" must be an object.`);
    return undefined;
  }
  const param = typeof raw.param === 'string' ? raw.param : '';
  if (!param) {
    errors.push(`"${at}.param" is required — name the parameter this effect's reach scales with.`);
    return undefined;
  }
  if (params[param]?.type !== 'number') {
    errors.push(
      `"${at}.param" is "${param}", which is not a number parameter of this effect. `
      + `Reach has to scale with something the host can read as a distance.`,
    );
    return undefined;
  }
  const num = (v: unknown, name: string): number | null => {
    if (v === undefined) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      errors.push(`"${at}.${name}" must be a non-negative number.`);
      return NaN;
    }
    return v;
  };
  const factor = num(raw.factor, 'factor');
  const plus = num(raw.plus, 'plus');
  if (Number.isNaN(factor) || Number.isNaN(plus)) return undefined;
  return {
    param,
    ...(factor !== null ? { factor } : {}),
    ...(plus !== null ? { plus } : {}),
  };
}

/** Paths a kernel module may live at, and what each one means. */
const KERNEL_PATH_RE = /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/;

function parseCpuKernel(raw: unknown, at: string, errors: string[]): EffectCpuKernel | undefined {
  if (!isPlainObject(raw)) {
    errors.push(`"${at}.cpu" must be an object with a "module" path inside the package.`);
    return undefined;
  }
  const module = typeof raw.module === 'string' ? raw.module.trim() : '';
  /*
    A package-relative path and nothing else.

    No leading slash, no `..`, no URL. The kernel is read through the package
    reader so it carries the package's integrity check — a path that escaped the
    package would be reading a file nobody signed, which is the whole point of
    shipping kernels inside the package rather than fetching them.
  */
  if (!module || !KERNEL_PATH_RE.test(module) || module.split('/').includes('..')) {
    errors.push(
      `"${at}.cpu.module" must be a path inside the package, like "kernels/bloom.wasm". `
      + `A kernel is read through the package so it carries the same integrity check as the rest of it.`,
    );
    return undefined;
  }
  let format: 'wasm' | 'js';
  if (raw.format !== undefined) {
    if (raw.format !== 'wasm' && raw.format !== 'js') {
      errors.push(`"${at}.cpu.format" must be "wasm" or "js".`);
      return undefined;
    }
    format = raw.format;
  } else {
    format = module.endsWith('.wasm') ? 'wasm' : 'js';
  }
  const entry = raw.entry === undefined ? 'render' : raw.entry;
  if (typeof entry !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(entry)) {
    errors.push(`"${at}.cpu.entry" must be an exported function name.`);
    return undefined;
  }
  return { module, format, entry };
}

/**
 * Names the host owns inside the generated parameter block.
 *
 * Kept as one set rather than as a list per language, because the two generated
 * blocks declare the same members — the WGSL struct and the GLSL std140 block
 * are one layout expressed twice, and a name that collides collides in both.
 */
export const RESERVED_PARAM_NAMES = new Set([
  'mvp', 'uvRect', 'texelSize', 'passScale', 'passIndex',
  'compSize', 'layerSize', 'time', 'compTime', 'frame', 'fps',
  'pixelScale', 'downsample', 'seed', 'layerRect',
  // Not members, but the names the generated bindings take. A parameter called
  // `src` would shadow the input texture in GLSL and collide outright in WGSL.
  'src', 'samp', 'origin',
]);

/**
 * How far this effect reaches outside its layer, for the CURRENT parameters.
 *
 * Evaluated per frame by the side that holds the parameter values, which is
 * the whole point: an animated radius reserves the margin it needs on the
 * frame it needs it, rather than the worst case on every frame.
 *
 * Returns 0 for an effect that declared nothing, which is most of them.
 */
export function effectSpreadFor(
  effect: EffectContribution,
  params: Record<string, unknown>,
): number {
  const s = effect.spread;
  if (!s) return 0;
  // `evaluateSpread` falls back to the DECLARED DEFAULT, not to zero. An effect
  // whose radius has never been touched still has one, and budgeting zero for
  // it would clip the very first frame the user sees.
  return evaluateSpread(effect, s, params);
}

const PASS_NAME_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;

/**
 * Per-side reach, in composition pixels, for the CURRENT parameters.
 *
 * ── Why `spread` and `expand` combine rather than one replacing the other ────
 *
 * `spread` is the whole-effect number every published effect already declares;
 * `expand` names the sides a directional effect reaches on. Taking the MAX per
 * side is the only reading that cannot clip: an effect declaring a 40px spread
 * and a 60px right expand reaches 60 right and 40 everywhere else, which is
 * what both declarations, read literally, say.
 */
export function effectExpandFor(
  effect: EffectContribution,
  params: Record<string, unknown>,
): { left: number; top: number; right: number; bottom: number } {
  const base = effectSpreadFor(effect, params);
  const side = (v: EffectSpread | number | undefined): number => {
    if (v === undefined) return base;
    if (typeof v === 'number') return Math.max(base, v);
    return Math.max(base, evaluateSpread(effect, v, params));
  };
  const e = effect.expand;
  return {
    left: side(e?.left),
    top: side(e?.top),
    right: side(e?.right),
    bottom: side(e?.bottom),
  };
}

/**
 * Would this effect change anything, at these parameter values?
 *
 * False for every effect that declared no rules, which is most of them — an
 * effect that never says when it does nothing is assumed to always do
 * something, because the opposite default silently removes effects.
 *
 * A missing value reads the DECLARED DEFAULT, exactly as reach does: an effect
 * whose amount has never been touched is at its default, and treating an absent
 * value as 0 would skip the pass of every effect whose default is not zero on
 * the very first frame the user sees.
 */
export function effectIsIdentity(
  effect: EffectContribution,
  params: Record<string, unknown>,
): boolean {
  const rules = effect.identity;
  if (!rules || rules.length === 0) return false;
  return rules.every((rule) => {
    const raw = params[rule.param];
    const declared = effect.params[rule.param]?.default;
    const value = raw === undefined || raw === null ? declared : raw;
    if (typeof rule.equals === 'boolean') return value === rule.equals;
    return typeof value === 'number' && Number.isFinite(value) && value === rule.equals;
  });
}

/** One reach formula against live parameters — the body `effectSpreadFor` uses. */
function evaluateSpread(
  effect: EffectContribution,
  s: EffectSpread,
  params: Record<string, unknown>,
): number {
  const raw = params[s.param];
  const value = typeof raw === 'number' && Number.isFinite(raw)
    ? raw
    : (typeof effect.params[s.param]?.default === 'number'
      ? (effect.params[s.param]!.default as number)
      : 0);
  return Math.max(0, value * (s.factor ?? 1) + (s.plus ?? 0));
}

/**
 * Validate `effects[i].passes`. Returns `undefined` if the chain is unusable.
 *
 * The whole chain is refused on any single bad pass, matching how a bad effect
 * is dropped whole. A partially-accepted chain is worse than none: it compiles,
 * it draws, and it draws something the author never wrote.
 */
function parsePasses(
  raw: unknown,
  at: string,
  errors: string[],
  limits: EffectTierLimits,
  apiVersion: number | undefined,
): EffectPass[] | undefined {
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
  if (raw.length > limits.passes) {
    errors.push(
      `"${at}.passes" declares ${raw.length} passes; the limit is ${limits.passes}.`,
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

    // Same gate as the single-pass `glsl`, and for the same reason: an older
    // host reads `wgsl` and nothing else, so a GLSL-only chain declared under
    // an older grammar renders its input unchanged on every WebGL2 machine.
    if (entry.glsl !== undefined && gateField('glsl', where, apiVersion, errors)) {
      bad = true;
      return;
    }

    const wgsl = typeof entry.wgsl === 'string' && entry.wgsl.trim() !== '' ? entry.wgsl : undefined;
    const glsl = typeof entry.glsl === 'string' && entry.glsl.trim() !== '' ? entry.glsl : undefined;
    if (!wgsl && !glsl) {
      errors.push(
        `"${where}" declares no kernel. Every pass needs "wgsl", "glsl", or both — `
        + `a pass with neither is a step in the chain that cannot draw.`,
      );
      bad = true;
      return;
    }
    if (wgsl) {
      const check = validateWgsl(wgsl, limits.shader);
      if (!check.ok) {
        for (const p of check.problems) {
          errors.push(`"${where}.wgsl"${p.line ? ` line ${p.line}` : ''}: ${p.detail}`);
        }
        bad = true;
        return;
      }
    }
    if (glsl) {
      const check = validateGlsl(glsl, limits.shader);
      if (!check.ok) {
        for (const p of check.problems) {
          errors.push(`"${where}.glsl"${p.line ? ` line ${p.line}` : ''}: ${p.detail}`);
        }
        bad = true;
        return;
      }
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

    }

    passes.push({
      name,
      ...(wgsl ? { wgsl } : {}),
      ...(glsl ? { glsl } : {}),
      scale,
      reads,
    });
  });

  if (bad) return undefined;

  /*
    A language a chain declares SOMEWHERE, it must declare EVERYWHERE.

    A four-pass bloom whose third pass forgot its GLSL would run three passes
    on WebGL2 and stop — and "stop" means the ping-pong target it left holding
    the wrong step becomes the layer. Partial coverage is the one failure mode
    a chain cannot degrade through, so it is refused at the manifest, naming
    the passes that are missing rather than the ones that are not.
  */
  for (const [lang, key] of [['WGSL', 'wgsl'], ['GLSL', 'glsl']] as const) {
    const have = passes.filter((p) => p[key]);
    if (have.length > 0 && have.length < passes.length) {
      const missing = passes.filter((p) => !p[key]).map((p) => p.name);
      errors.push(
        `"${at}.passes" declares ${lang} on ${have.length} of ${passes.length} passes — `
        + `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} none. A chain runs on a backend `
        + `only if every pass does; a chain that stops halfway leaves the layer holding an intermediate step.`,
      );
      return undefined;
    }
  }

  const cost = chainCost(passes);
  if (cost > limits.passCost) {
    errors.push(
      `"${at}.passes" costs ${cost.toFixed(2)} full-scale passes; the budget is ${limits.passCost}. `
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
  point: 'vec2<f32>',
};

/**
 * The same types in GLSL ES 3.0.
 *
 * `boolean` is a `float` here for a DIFFERENT reason than in WGSL — std140 does
 * have a `bool`, four bytes, but it reads a non-zero int rather than a float
 * bit pattern, so the 1.0 the packer writes would arrive as a large integer
 * that happens to be true. Keeping both languages on `float` means one packer.
 */
const GLSL_TYPE: Record<EffectParamType, string> = {
  number: 'float',
  color: 'vec4',
  boolean: 'float',
  point: 'vec2',
};

/** Bytes each occupies, and the alignment it demands, under WGSL's rules. */
const WGSL_SIZE: Record<EffectParamType, { size: number; align: number }> = {
  number: { size: 4, align: 4 },
  color: { size: 16, align: 16 },
  boolean: { size: 4, align: 4 },
  /*
    A `vec2<f32>` is 8 bytes and aligns to 8, NOT to 4.

    Worth stating because it is the one entry here where size and alignment
    differ from each other in a way that matters: the block is sorted by
    alignment descending, so a point lands between the vec4s and the scalars,
    and a scalar declared before it leaves 4 bytes of padding the struct does
    describe. Getting the alignment wrong instead — writing 4 — would put a
    point on a 4-byte boundary, which WGSL does not permit and the driver
    reports as a struct mismatch naming nothing the author wrote.
  */
  point: { size: 8, align: 8 },
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
 *   offset 64   texelSize  : vec2<f32>   1 / target dimensions
 *   offset 72   passScale  : f32         this pass's scale
 *   offset 76   passIndex  : f32         0-based; a chain can branch on it
 *   offset 80   compSize   : vec2<f32>   composition size in px
 *   offset 88   layerSize  : vec2<f32>   this layer's size in px
 *   offset 96   time       : f32         THIS LAYER's time, seconds
 *   offset 100  compTime   : f32         the playhead, seconds
 *   offset 104  frame      : f32         frame index at the comp's rate
 *   offset 108  fps         : f32
 *   offset 112  pixelScale : f32         device/raster px per comp px
 *   offset 116  downsample : f32         1 at full quality, 2 at half, …
 *   offset 120  seed       : f32         stable per effect instance
 *   offset 124  _reserved  : f32         zeroed
 *   offset 128  layerRect  : vec4<f32>   the layer's box, in `uv` units
 *
 * ── `layerRect`, and why `uv` is NOT the layer's box ────────────────────────
 *
 * `uv` is the generated vertex stage's output for a FULL-TARGET quad:
 * `uvRect.xy + pos * uvRect.zw` with `pos` in [0,1]. It spans the pass's target
 * — the whole viewport on the 2D route, the layer plus its effect margin on the
 * 3D route — and it runs bottom-up on a backend whose render targets are
 * flipped (WebGL2). It is never < 0 and never > 1.
 *
 * So until this member existed a GPU kernel had no way to find its own layer:
 * an `expand` border ("draw N px outside the box") could not be written at all,
 * and a `render: "shader"` kind painting a procedural image painted it across
 * the whole target, mirrored vertically between WebGPU and WebGL2. The golden
 * scenes `plugin-kernel-expand` and `generator-shader-kind` rendered exactly
 * that.
 *
 * `layerRect.xy` is the `uv` of the box's top-left corner and `layerRect.zw` its
 * extent in `uv` units — NEGATIVE on an axis the backend flips. The division
 *
 *     let local = (uv - params.layerRect.xy) / params.layerRect.zw;
 *
 * is therefore 0..1 top-down over the layer on BOTH backends, below 0 / above 1
 * in the margin, and `layerRect.xy + local * layerRect.zw` is back in `uv`, the
 * space every texture is sampled in. It is the renderer's own `fxBox` (what the
 * built-in box-relative effects already read) pushed through `uvRect`.
 *
 * ── ★ This block GREW, and what that cost ───────────────────────────────────
 *
 * It was 32 bytes, ending in a `_reserved : vec4<f32>` whose stated purpose was
 * that "the next thing this block has to carry (frame time is the obvious
 * candidate) does not move every parameter offset again". Frame time turned out
 * to need eleven companions — a parallax effect wants the comp's aspect, a
 * noise field wants a stable seed, a kernel that adapts to Adaptive Resolution
 * wants the downsample factor — and eleven do not fit in sixteen bytes. So the
 * offsets moved after all, once, and the reservation bought what it could: the
 * decision to move them is visible here rather than discovered from a wrong
 * colour.
 *
 * Nothing in a document or a package is invalidated by that, and the reason is
 * worth stating because it is the whole safety argument: BOTH sides of this
 * layout are generated from this file. The struct the shader compiles against
 * comes from `parameterBlock`, the bytes come from `packParameters` walking the
 * same `layout`, and the host block is written by `packPassBlock` (CPU) and
 * `packPluginEffect` (renderer) against these same constants. A plugin ships
 * SOURCE, not compiled offsets, so it is recompiled against the new struct on
 * the next load. The one thing that would break is a hand-written `@binding`,
 * which `wgslValidation` has always refused.
 *
 * `_reserved` is a single float now, not a vec4: it exists to round 124 → 128
 * and to be the one member a reader can see is spare. Sixteen bytes of slack
 * did not survive contact with the first real request, so pretending the next
 * four will is not worth the padding.
 *
 * It grew again, 64 → 80, for `layerRect` — four floats that could not fit in
 * `_reserved`. The parameters moved 128 → 144, under the same safety argument.
 *
 * Emitted for EVERY effect, single-pass included. A single-pass effect is a
 * one-pass chain as far as the uniform block is concerned, and two layouts —
 * one with the block, one without — would mean the offsets depend on a
 * condition, which is the exact shape of the bug that made the 64-byte header
 * necessary in the first place.
 */
export const UNIFORM_PASS_BLOCK_BYTES = 80;

/**
 * The host-filled values, as the app computes them once per layer per frame.
 *
 * Named fields rather than a packed array, because the two writers (the CPU
 * `packPassBlock` and the renderer's `packPluginEffect`) are in different
 * packages and a positional contract between them would be a silent
 * transposition away from a kernel reading the frame rate as a seed.
 *
 * `texelSize`, `passScale` and `passIndex` are NOT here: they are per-PASS and
 * per-TARGET, and only the renderer knows them.
 */
export interface EffectHostInputs {
  /** Composition size in px. */
  compWidth: number;
  compHeight: number;
  /**
   * The layer's own size in px.
   *
   * NOT what `uv` spans — `uv` spans the pass's target, which is the whole
   * viewport on the 2D route. Where the layer sits in `uv` is `layerRect`,
   * written per draw by the renderer (see `UNIFORM_PASS_BLOCK_BYTES`).
   */
  layerWidth: number;
  layerHeight: number;
  /**
   * The layer's own time in seconds, which is NOT the playhead.
   *
   * A layer with a time remap, a speed ramp or a start offset runs its own
   * clock, and an effect that animates with its layer has to follow that one —
   * otherwise a retimed layer's effect drifts against the picture it is on.
   */
  time: number;
  /** The playhead, in composition seconds. */
  compTime: number;
  /** Frame index at the composition's rate. */
  frame: number;
  fps: number;
  /** Raster px per composition px — device pixel ratio times the view's zoom. */
  pixelScale: number;
  /** 1 at full quality, 2 at half, 4 at quarter. */
  downsample: number;
  /**
   * A per-instance random seed, stable across frames.
   *
   * Stable is the whole requirement: a noise field reseeded every frame boils,
   * and one seeded from the clock is a different picture in preview and in
   * export. Derived from the effect instance's id, so two copies of the same
   * effect on two layers differ and each stays put.
   */
  seed: number;
}

/** Where an effect's own parameters begin. Renderer header + host pass block. */
export const UNIFORM_HEADER_BYTES =
  UNIFORM_RENDERER_HEADER_BYTES + UNIFORM_PASS_BLOCK_BYTES;

/**
 * The host block's members, in offset order, expressed ONCE.
 *
 * The WGSL struct, the GLSL std140 block and the two packers all read this
 * list, so "what is at byte 96" has a single answer in this codebase. The
 * previous version spelled the members out in three places and kept them in
 * step by hand, which held for four members and would not have held for
 * thirteen — the failure being a shader that reads `fps` out of the `frame`
 * slot and looks merely wrong.
 */
export const HOST_BLOCK_MEMBERS: ReadonlyArray<{ name: string; wgsl: string; glsl: string; floats: number }> = [
  { name: 'texelSize', wgsl: 'vec2<f32>', glsl: 'vec2', floats: 2 },
  { name: 'passScale', wgsl: 'f32', glsl: 'float', floats: 1 },
  { name: 'passIndex', wgsl: 'f32', glsl: 'float', floats: 1 },
  { name: 'compSize', wgsl: 'vec2<f32>', glsl: 'vec2', floats: 2 },
  { name: 'layerSize', wgsl: 'vec2<f32>', glsl: 'vec2', floats: 2 },
  { name: 'time', wgsl: 'f32', glsl: 'float', floats: 1 },
  { name: 'compTime', wgsl: 'f32', glsl: 'float', floats: 1 },
  { name: 'frame', wgsl: 'f32', glsl: 'float', floats: 1 },
  { name: 'fps', wgsl: 'f32', glsl: 'float', floats: 1 },
  { name: 'pixelScale', wgsl: 'f32', glsl: 'float', floats: 1 },
  { name: 'downsample', wgsl: 'f32', glsl: 'float', floats: 1 },
  { name: 'seed', wgsl: 'f32', glsl: 'float', floats: 1 },
  { name: '_reserved', wgsl: 'f32', glsl: 'float', floats: 1 },
  // At float 16 = byte 128 of the struct: a multiple of 16, which is what a
  // vec4 needs in both WGSL and std140, so no padding precedes it.
  { name: 'layerRect', wgsl: 'vec4<f32>', glsl: 'vec4', floats: 4 },
];

/** Float offsets of the host block's members, from the start of the block. */
export const HOST_BLOCK_FLOAT_OFFSET: Readonly<Record<string, number>> = (() => {
  const out: Record<string, number> = {};
  let at = 0;
  for (const m of HOST_BLOCK_MEMBERS) {
    // Every member here is a float, a vec2 (aligns to 8 bytes = 2 floats) or a
    // vec4 (16 bytes = 4 floats). The list is ordered so that already holds; asserted in
    // `effectSchema.test.ts` rather than fixed up silently here, because a
    // list that needed fixing up is a list somebody got wrong.
    out[m.name] = at;
    at += m.floats;
  }
  return out;
})();

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
  /** The same block as a GLSL ES 3.0 std140 uniform block. */
  glsl: string;
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
    ...HOST_BLOCK_MEMBERS.map((m) => `  ${m.name} : ${m.wgsl},`),
  ];
  /*
    The same block, in GLSL, member for member.

    Generated from ONE walk rather than by a second function, because std140 and
    WGSL's uniform rules agree on every type this block contains (vec4 at 16,
    vec2 at 8, float at 4, a mat3 as three padded columns) — and the moment the
    two blocks come from two walks they can disagree about padding, which is a
    plugin whose GLSL variant reads its parameters shifted by four bytes and
    renders plausible nonsense.
  */
  const glslMembers: string[] = [
    '  mat3 mvp;',
    '  vec4 uvRect;',
    ...HOST_BLOCK_MEMBERS.map((m) => `  ${m.glsl} ${m.name};`),
  ];

  for (const e of entries) {
    const { size, align } = WGSL_SIZE[e.type];
    offset = Math.ceil(offset / align) * align;
    layout.push({ name: e.name, type: e.type, offset });
    members.push(`  ${e.name} : ${WGSL_TYPE[e.type]},`);
    glslMembers.push(`  ${GLSL_TYPE[e.type]} ${e.name};`);
    offset += size;
  }

  // A uniform buffer's size must be a multiple of 16. The header alone already
  // makes the struct legal, so an effect with no parameters — a fixed colour
  // grade, say — needs no padding member of its own.
  const size = Math.max(UNIFORM_HEADER_BYTES, Math.ceil(offset / 16) * 16);

  return {
    wgsl: `struct Object {\n${members.join('\n')}\n};`,
    glsl: `layout(std140) uniform Object {\n${glslMembers.join('\n')}\n};`,
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
    ...layers
      .slice(0, MAX_LAYER_PARAMS_PER_EFFECT)
      .map((name, i) => `@group(0) @binding(${LAYER_BINDINGS[i]}) var ${name} : texture_2d<f32>;`),
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

/**
 * The complete GLSL ES 3.0 program for one pass: host preamble, then `fs`.
 *
 * ── Why the author's names survive into a language that cannot bind them ─────
 *
 * In WGSL each layer parameter becomes a binding VARIABLE and can simply take
 * the author's name. WebGL2 has no binding numbers for samplers: the backend
 * points a uniform at a texture unit BY NAME, in the order the material
 * declares them, and the material is built inside the renderer — which has
 * never heard of a plugin's vocabulary and must not start.
 *
 * So the samplers are declared under fixed names and the preamble adds a
 * `#define` per layer parameter. The author writes `texture(depth, uv)` in both
 * languages; only the host knows that one of them spelled it `pluginLayer0`.
 *
 * ── `main` is generated, and the author writes `fs` ──────────────────────────
 *
 * Symmetric with the WGSL contract, and for the same reason: the varyings and
 * the output declaration are the host's, and a hand-written `main` would have
 * to agree with declarations the author cannot see. It also means the preamble
 * length is a constant this file knows, which is what lets a driver's error log
 * be re-pointed at the author's own line numbers (`remapCompileLog`).
 */
export function composeEffectGlsl(
  effect: EffectContribution,
  passIndex = 0,
): { vertex: string; fragment: string; preambleLines: number; layout: ReturnType<typeof parameterBlock> } {
  const layout = parameterBlock(effect.params);
  const layers = layerParamNames(effect.params).slice(0, MAX_LAYER_PARAMS_PER_EFFECT);
  const pass = effect.passes?.[passIndex];
  const source = pass ? (pass.glsl ?? '') : (effect.glsl ?? '');
  const readsOrigin = pass ? pass.reads === 'origin' || pass.reads === 'both' : false;

  /*
    The vertex stage, generated like WGSL's — the same full-screen quad
    transform for every effect, reading `mvp` and `uvRect` out of the same
    block. An author never writes one and never sees these two members.
  */
  const vertex = [
    '#version 300 es',
    layout.glsl,
    'layout(location = 0) in vec2 pos;',
    'out vec2 vUv;',
    'void main() {',
    '  vec3 p = mvp * vec3(pos, 1.0);',
    '  gl_Position = vec4(p.xy, 0.0, p.z);',
    '  vUv = uvRect.xy + pos * uvRect.zw;',
    '}',
  ].join('\n');

  const preamble = [
    '#version 300 es',
    'precision highp float;',
    layout.glsl,
    'uniform sampler2D src;',
    ...layers.map((_, i) => `uniform sampler2D ${GLSL_LAYER_SAMPLERS[i]};`),
    ...(readsOrigin ? ['uniform sampler2D pluginOrigin;'] : []),
    ...layers.map((name, i) => `#define ${name} ${GLSL_LAYER_SAMPLERS[i]}`),
    ...(readsOrigin ? ['#define origin pluginOrigin'] : []),
    'in vec2 vUv;',
    'out vec4 fragColor;',
  ];

  const preambleText = `${preamble.join('\n')}\n`;
  const fragment = [
    preambleText,
    source,
    '',
    'void main() { fragColor = fs(vUv); }',
  ].join('\n');

  /*
    Counted from the TEXT, not from the array.

    `layout.glsl` is one array element and a dozen lines, so counting elements
    would under-report the preamble by eleven — and a log re-pointed with the
    wrong length is worse than one that was never re-pointed, because it names
    a line that exists and is not the one that failed.
  */
  const preambleLines = preambleText.split('\n').length;
  return { vertex, fragment, preambleLines, layout };
}

/**
 * Which backends can actually draw this effect, and which cannot.
 *
 * ── Why this is a function and not a boolean on the effect ───────────────────
 *
 * "Can it render?" used to be one question with one answer — WebGPU or
 * nothing — and `pluginEffectsCanRender()` answered it. With three kinds of
 * kernel the answer depends on the backend that is live, and an effect can be
 * fine on one machine and inert on another for a reason its author can fix.
 * Returning the REASON, in the author's terms, is what makes the difference
 * between "this plugin is broken" and "this effect ships no GLSL".
 */
export type EffectBackend = 'webgpu' | 'webgl2' | 'cpu';

/**
 * Does this effect have a kernel in the BACKEND'S OWN LANGUAGE?
 *
 * The narrower question `effectKernelFor` deliberately does not answer, and the
 * two must not be conflated. `effectKernelFor` asks "can this machine draw the
 * effect at all", where a CPU kernel stands in for anything missing; this asks
 * "does the GPU pass have a shader to compile", where it does not.
 *
 * Both callers of this would be bugs if they asked the other question: the
 * compiler would hand a driver an empty source, and the scene walk would emit a
 * pass naming a shader that was never registered — which draws into a cleared
 * target and reads as the effect having erased the layer.
 */
export function effectHasGpuKernel(
  effect: EffectContribution,
  backend: EffectBackend,
): boolean {
  if (backend === 'cpu') return false;
  const passes = effect.passes;
  return backend === 'webgpu'
    ? (passes ? passes.every((p) => !!p.wgsl) : !!effect.shader.trim())
    : (passes ? passes.every((p) => !!p.glsl) : !!effect.glsl?.trim());
}

export function effectKernelFor(
  effect: EffectContribution,
  backend: EffectBackend,
): { ok: true } | { ok: false; reason: string } {
  const passes = effect.passes;
  const hasWgsl = passes ? passes.every((p) => !!p.wgsl) : !!effect.shader.trim();
  const hasGlsl = passes ? passes.every((p) => !!p.glsl) : !!effect.glsl?.trim();
  const hasCpu = !!effect.cpu;

  if (backend === 'webgpu' && hasWgsl) return { ok: true };
  if (backend === 'webgl2' && hasGlsl) return { ok: true };
  if (backend === 'cpu' && hasCpu) return { ok: true };
  // A CPU kernel stands in for a missing GPU one. Slower, and the honest
  // degradation — it draws the effect the author wrote, which passthrough
  // never did.
  if (backend !== 'cpu' && hasCpu) return { ok: true };

  const have = [hasWgsl && 'WGSL', hasGlsl && 'GLSL', hasCpu && 'a CPU kernel'].filter(Boolean);
  const wanted = backend === 'webgpu' ? 'WGSL' : backend === 'webgl2' ? 'GLSL ES 3.0' : 'a CPU kernel';
  return {
    ok: false,
    reason: have.length === 0
      ? `“${effect.label}” ships no kernel at all.`
      : `“${effect.label}” ships ${have.join(' and ')}, and this frame needs ${wanted}. `
        + `Add a "${backend === 'webgl2' ? 'glsl' : backend === 'webgpu' ? 'shader' : 'cpu'}" kernel to the effect, `
        + `or a "cpu" kernel, which stands in for any missing backend.`,
  };
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
 * Pack the host's pass block — the 80 bytes at offset 64.
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
  /**
   * What the host fills in. Optional so a caller that has no frame context —
   * a unit test packing a block to inspect its offsets — gets zeros rather
   * than having to invent a composition.
   */
  host?: EffectHostInputs,
  /**
   * The layer's box in `uv` units (see `UNIFORM_PASS_BLOCK_BYTES`). Defaults
   * to the whole target, `(0, 0, 1, 1)` — the right answer when the layer IS
   * the target, and never a zero extent a kernel would divide by.
   */
  layerRect: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 1, height: 1 },
): void {
  const view = new DataView(buffer);
  const base = UNIFORM_RENDERER_HEADER_BYTES;
  const put = (name: string, value: number): void => {
    view.setFloat32(base + HOST_BLOCK_FLOAT_OFFSET[name]! * 4, value, true);
  };
  // Guarded, because a zero-sized target is a real state during teardown and a
  // division by it puts Infinity in a uniform — which does not throw, and
  // renders a layer that is entirely one colour.
  put('texelSize', target.width > 0 ? 1 / target.width : 0);
  view.setFloat32(base + (HOST_BLOCK_FLOAT_OFFSET.texelSize! + 1) * 4, target.height > 0 ? 1 / target.height : 0, true);
  put('passScale', passScale);
  put('passIndex', passIndex);
  put('compSize', host?.compWidth ?? 0);
  view.setFloat32(base + (HOST_BLOCK_FLOAT_OFFSET.compSize! + 1) * 4, host?.compHeight ?? 0, true);
  put('layerSize', host?.layerWidth ?? 0);
  view.setFloat32(base + (HOST_BLOCK_FLOAT_OFFSET.layerSize! + 1) * 4, host?.layerHeight ?? 0, true);
  put('time', host?.time ?? 0);
  put('compTime', host?.compTime ?? 0);
  put('frame', host?.frame ?? 0);
  put('fps', host?.fps ?? 0);
  put('pixelScale', host?.pixelScale ?? 1);
  put('downsample', host?.downsample ?? 1);
  put('seed', host?.seed ?? 0);
  // `_reserved`, zeroed explicitly for the reason the old vec4 was: it is the
  // part a later version will start using, and a plugin reading stale bytes
  // from it today would break on the day it becomes meaningful.
  put('_reserved', 0);
  const rect = HOST_BLOCK_FLOAT_OFFSET.layerRect!;
  view.setFloat32(base + rect * 4, layerRect.x, true);
  view.setFloat32(base + (rect + 1) * 4, layerRect.y, true);
  view.setFloat32(base + (rect + 2) * 4, layerRect.width, true);
  view.setFloat32(base + (rect + 3) * 4, layerRect.height, true);
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
    } else if (type === 'point') {
      /*
        Composition pixels, straight through — not normalised to UV.

        The shader already has `params.texelSize`, so an author who wants UV
        writes `p * params.texelSize` and one who wants pixels has them. The
        reverse — normalising here — would be lossy in the case that matters:
        a point outside the layer, which is ordinary for a light or a
        displacement centre, and which no UV range describes without the
        author knowing what the target size was.
      */
      const p = value as { x?: unknown; y?: unknown } | null | undefined;
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      view.setFloat32(offset, n(p?.x), true);
      view.setFloat32(offset + 4, n(p?.y), true);
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
