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
): PluginShaderSource {
  return {
    name: namespacedEffect(pluginId, effect.id),
    wgsl: composeEffectShader(effect).wgsl,
    glsl: { vertex: PASSTHROUGH_GLSL.vertex, fragment: PASSTHROUGH_GLSL.fragment },
  };
}

/** The material descriptor for any plugin effect. One layout, for all of them. */
export function pluginEffectMaterial(pluginId: string, effect: EffectContribution): {
  shader: string;
  topology: 'triangle-list';
  layout: typeof PLUGIN_EFFECT_MATERIAL_LAYOUT | typeof PLUGIN_EFFECT_MATERIAL_LAYOUT_WITH_MAP;
} {
  // Same predicate the shader generator uses. Deriving both from
  // `layerParamNames` is what keeps the declared bindings and the bound
  // resources in step; two independent conditions here would be a pipeline that
  // is invalid only for the effects that use the newer feature.
  const readsSecondTexture = layerParamNames(effect.params).length > 0;
  return {
    shader: namespacedEffect(pluginId, effect.id),
    topology: 'triangle-list',
    layout: readsSecondTexture
      ? PLUGIN_EFFECT_MATERIAL_LAYOUT_WITH_MAP
      : PLUGIN_EFFECT_MATERIAL_LAYOUT,
  };
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
    const source = pluginShaderSource(pluginId, effect);
    registry.register(source);
    names.push(source.name);
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
