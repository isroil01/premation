/**
 * Turning a declared plugin effect into something the renderer can draw.
 *
 * The renderer already has the two shapes this needs, and they were built with
 * this in mind — `ShaderRegistry` says so in as many words ("custom shaders
 * register the same way"). So this is a translation, not a new render path:
 *
 *   `EffectContribution`  →  `ShaderSource`      (named, WGSL + GLSL)
 *                         →  `MaterialDescriptor` (binding layout)
 *
 * The binding layout is the standard effect one already used by
 * `DISPLACEMENT_MAP_MATERIAL` and friends — uniform at 0, texture at 1, sampler
 * at 2 — which is why `composeEffectShader` generates exactly those three.
 *
 * ── The WebGL2 problem, and the answer to it ─────────────────────────────────
 *
 * `ShaderSource` requires BOTH a WGSL and a GLSL variant, because the renderer
 * falls back WebGPU → WebGL2 and picks whichever the live backend needs. A
 * plugin ships WGSL only.
 *
 * Requiring every author to also write GLSL ES 3.0 — to serve a fallback tier —
 * was judged the worse trade: it doubles the authoring cost of every effect,
 * and the second version is the one nobody tests. So the host generates a GLSL
 * **passthrough**: on WebGL2 a plugin effect draws its input unchanged.
 *
 * That is a real gap and it is deliberately not silent. It is the same answer
 * the rest of this subsystem gives to "the shader is not usable right now" —
 * passthrough, never a broken frame — and `isPassthroughOnly` exists so a
 * surface can SAY so rather than leaving a user to wonder why their effect does
 * nothing on one machine and works on another.
 */

import type { EffectContribution } from './effectSchema';
import { composeEffectShader, layerParamNames, namespacedEffect } from './effectSchema';

/**
 * Compilation bounds for a chain.
 *
 * Per pass AND in total, because they fail differently: one pathological
 * shader is caught by the per-pass bound, while four passes each taking four
 * seconds are individually fine and together freeze a boot for sixteen.
 */
export const PASS_COMPILE_TIMEOUT_MS = 5_000;
export const CHAIN_COMPILE_TIMEOUT_MS = 10_000;

/** Mirrors `packages/renderer`'s `ShaderSource`. Duplicated, not imported, so
 *  `@core/plugins` does not take a dependency on the renderer package. */
export interface PluginShaderSource {
  name: string;
  wgsl: string;
  glsl: { vertex: string; fragment: string };
}

/** Mirrors the renderer's effect `MaterialDescriptor` layout. */
export const PLUGIN_EFFECT_MATERIAL_LAYOUT = [
  { binding: 0, type: 'uniform-buffer', stages: ['vertex', 'fragment'] },
  { binding: 1, type: 'texture', stages: ['fragment'] },
  { binding: 2, type: 'sampler', stages: ['fragment'] },
] as const;

/**
 * The layout for an effect that reads a SECOND texture.
 *
 * A separate constant rather than always declaring binding 3: a layout entry
 * with nothing bound to it makes the pipeline invalid, and an invalid pipeline
 * here is a dead viewport rather than a missing feature. An effect gets the
 * wider layout only when its manifest declared a `layer` parameter — the same
 * condition under which `composeEffectShader` emits the binding, so the two
 * cannot drift.
 */
export const PLUGIN_EFFECT_MATERIAL_LAYOUT_WITH_MAP = [
  ...PLUGIN_EFFECT_MATERIAL_LAYOUT,
  { binding: 3, type: 'texture', stages: ['fragment'] },
] as const;

/**
 * The `origin` texture — the pass-0 input — at binding 4.
 *
 * Fixed at 4 whether or not binding 3 is in use, matching what
 * `composeEffectShader` emits. Sliding it down to 3 when no layer parameter is
 * declared would make the binding number depend on an unrelated part of the
 * manifest, and this file and the shader generator would each have to reach
 * that conclusion separately — two derivations of one number, which is how a
 * bind group ends up pointing a shader at the wrong texture.
 */
export const ORIGIN_BINDING = { binding: 4, type: 'texture', stages: ['fragment'] } as const;

export type PluginEffectLayout = ReadonlyArray<{
  readonly binding: number;
  readonly type: string;
  readonly stages: readonly string[];
}>;

/**
 * The GLSL a plugin effect gets on the WebGL2 tier: its input, unchanged.
 *
 * Generated rather than omitted because `ShaderSource` has no optional variant
 * and a pipeline built from a missing one fails to create — which would surface
 * as a black layer or a dead viewport rather than as "this effect does nothing
 * here". Passthrough is the honest degradation, and it matches what a failed
 * compile does on the WebGPU tier.
 *
 * The uniform block is declared but unread: the layout has to match the
 * material's binding 0 or the pipeline is invalid, even though nothing in a
 * passthrough uses a parameter.
 */
const PASSTHROUGH_GLSL = {
  vertex: /* glsl */ `#version 300 es
layout(location = 0) in vec2 pos;
layout(std140) uniform Object { mat3 mvp; vec4 uvRect; };
out vec2 vUv;
void main() {
  vec3 p = mvp * vec3(pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = uvRect.xy + pos * uvRect.zw;
}
`,
  fragment: /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D tex;
in vec2 vUv;
out vec4 fragColor;
void main() {
  // Passthrough. A plugin effect ships WGSL only, and this tier needs GLSL.
  fragColor = texture(tex, vUv);
}
`,
} as const;

/**
 * The renderer-facing shader for one declared effect.
 *
 * Named by the effect's namespaced id, so two plugins can both ship a "glow"
 * and the registry keeps them apart — and so a compile error or a device loss
 * can be traced back to a plugin from the shader name alone.
 */
export function pluginShaderSource(
  pluginId: string,
  effect: EffectContribution,
  passIndex = 0,
): PluginShaderSource {
  return {
    name: passShaderName(pluginId, effect, passIndex),
    wgsl: composeEffectShader(effect, passIndex).wgsl,
    glsl: { vertex: PASSTHROUGH_GLSL.vertex, fragment: PASSTHROUGH_GLSL.fragment },
  };
}

/**
 * The registry name for one pass.
 *
 * A single-pass effect keeps the bare `<pluginId>.<effectId>` it has always
 * had — unsuffixed, so nothing that already registered, looked up or reported
 * an effect by that name has to change, and so an effect published before
 * chains existed produces the identical registry key.
 *
 * A chain suffixes each pass with its declared name: `acme.blur#horizontal`.
 * `#` because it cannot appear in a plugin id, an effect id or a pass name, so
 * the composed key is unambiguous and a reader can see where it came from — a
 * compile error naming `acme.blur#vertical` says which half failed without
 * anyone having to count passes.
 */
export function passShaderName(
  pluginId: string,
  effect: EffectContribution,
  passIndex: number,
): string {
  const base = namespacedEffect(pluginId, effect.id);
  const pass = effect.passes?.[passIndex];
  return pass ? `${base}#${pass.name}` : base;
}

/** The material descriptor for one pass of a plugin effect. */
export function pluginEffectMaterial(
  pluginId: string,
  effect: EffectContribution,
  passIndex = 0,
): {
  shader: string;
  topology: 'triangle-list';
  layout: PluginEffectLayout;
} {
  // Same predicate the shader generator uses. Deriving both from
  // `layerParamNames` is what keeps the declared bindings and the bound
  // resources in step; two independent conditions here would be a pipeline that
  // is invalid only for the effects that use the newer feature.
  const readsSecondTexture = layerParamNames(effect.params).length > 0;
  const pass = effect.passes?.[passIndex];
  const readsOrigin = pass ? pass.reads === 'origin' || pass.reads === 'both' : false;

  const base: PluginEffectLayout = readsSecondTexture
    ? PLUGIN_EFFECT_MATERIAL_LAYOUT_WITH_MAP
    : PLUGIN_EFFECT_MATERIAL_LAYOUT;

  return {
    shader: passShaderName(pluginId, effect, passIndex),
    topology: 'triangle-list',
    layout: readsOrigin ? [...base, ORIGIN_BINDING] : base,
  };
}

/**
 * Every pass of an effect, in execution order, as the renderer needs them.
 *
 * The host owns the sequencing entirely — a plugin never sees a render target,
 * never allocates one and never says what order anything runs in. This is the
 * whole description it gets to influence, and it is data.
 */
export interface PluginEffectPassPlan {
  index: number;
  /** Registry key for this pass's shader. */
  shader: string;
  /** Linear downsample of this pass's target. */
  scale: number;
  /** Whether the pass-0 input must be bound at binding 4. */
  readsOrigin: boolean;
  layout: PluginEffectLayout;
}

export function pluginEffectPlan(
  pluginId: string,
  effect: EffectContribution,
): PluginEffectPassPlan[] {
  const count = effect.passes?.length ?? 1;
  const plan: PluginEffectPassPlan[] = [];
  for (let i = 0; i < count; i++) {
    const pass = effect.passes?.[i];
    const material = pluginEffectMaterial(pluginId, effect, i);
    plan.push({
      index: i,
      shader: material.shader,
      scale: pass?.scale ?? 1,
      readsOrigin: pass ? pass.reads === 'origin' || pass.reads === 'both' : false,
      layout: material.layout,
    });
  }
  return plan;
}

/**
 * Minimal view of the renderer's `ShaderRegistry`.
 *
 * Structural rather than an import, for the same reason `PluginShaderSource` is
 * duplicated: this module is the SEAM between two packages, and a seam that
 * imports both sides is not a seam.
 */
export interface ShaderRegistryLike {
  register(source: PluginShaderSource): void;
  has(name: string): boolean;
}

/**
 * Register a plugin's effects with the renderer's shader registry.
 *
 * Returns the names registered, so a caller can unregister or report. Safe to
 * call again: `register` is a map write keyed by name, and re-registering the
 * same effect after an update is how a new version's shader takes over.
 */
export function registerPluginShaders(
  registry: ShaderRegistryLike,
  pluginId: string,
  effects: readonly EffectContribution[],
): string[] {
  const names: string[] = [];
  for (const effect of effects) {
    // One registered shader per pass. A chain is N pipelines the host runs in
    // order, not one shader that loops — a loop would need the target as an
    // input to itself, which no backend allows.
    const passes = effect.passes?.length ?? 1;
    for (let i = 0; i < passes; i++) {
      const source = pluginShaderSource(pluginId, effect, i);
      registry.register(source);
      names.push(source.name);
    }
  }
  return names;
}

/**
 * True when this effect can only draw on the WebGPU tier.
 *
 * Every plugin effect, today — it is a function rather than a constant so the
 * surfaces that need to say "does nothing on this machine" ask a question
 * rather than hardcode an answer that stops being true the day authors can
 * ship GLSL.
 */
export function isPassthroughOnly(tier: string): boolean {
  return tier !== 'webgpu';
}
