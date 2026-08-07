/**
 * The seam between a declared effect and the renderer.
 *
 * Two properties matter here and neither is obvious from reading the module:
 *
 *  1. **The generated binding layout and the generated WGSL agree.** They are
 *     produced by two different functions in two different files, and a
 *     disagreement is a pipeline that fails to create — or, worse, one that
 *     creates and binds the wrong resource to the wrong slot.
 *  2. **A plugin effect degrades to passthrough on WebGL2 rather than failing
 *     to build.** A missing GLSL variant is not "no effect", it is an invalid
 *     pipeline, which surfaces as a black layer or a dead viewport.
 */

import {
  pluginShaderSource,
  pluginEffectMaterial,
  registerPluginShaders,
  isPassthroughOnly,
  PLUGIN_EFFECT_MATERIAL_LAYOUT,
  type PluginShaderSource,
  type ShaderRegistryLike,
} from './pluginEffectMaterial';
import type { EffectContribution } from './effectSchema';

const PLUGIN = 'studio.acme.glow';

const effect = (id = 'glow'): EffectContribution => ({
  id,
  label: 'Glow',
  shader: `
@fragment
fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(src, samp, uv) * params.amount;
}`,
  params: {
    amount: { type: 'number', default: 1 },
    tint: { type: 'color', default: '#ffffff' },
  },
});

/** The registry's map, as much of it as this seam uses. */
function fakeRegistry() {
  const sources = new Map<string, PluginShaderSource>();
  const registry: ShaderRegistryLike = {
    register: (s) => { sources.set(s.name, s); },
    has: (n) => sources.has(n),
  };
  return { registry, sources };
}

describe('the generated shader source', () => {
  it('is named by the namespaced effect id', () => {
    // So two plugins can both ship a "glow", and so a compile error or a device
    // loss traces back to a plugin from the shader name alone.
    expect(pluginShaderSource(PLUGIN, effect()).name).toBe(`${PLUGIN}.glow`);
  });

  it('★ declares exactly the bindings the material layout expects', () => {
    /*
      These come from two different functions in two different files. A
      disagreement is a pipeline that fails to create — or one that creates and
      binds the wrong resource to the wrong slot, which draws garbage rather
      than erroring.
    */
    const { wgsl } = pluginShaderSource(PLUGIN, effect());

    for (const entry of PLUGIN_EFFECT_MATERIAL_LAYOUT) {
      expect(wgsl).toContain(`@binding(${entry.binding})`);
    }
    // And nothing beyond them: an extra binding in the shader has nothing bound
    // to it, which is an incomplete bind group at draw time.
    const declared = [...wgsl.matchAll(/@binding\((\d+)\)/g)].map((m) => Number(m[1]));
    expect([...new Set(declared)].sort()).toEqual([0, 1, 2]);
  });

  it('carries the author s entry point through unchanged', () => {
    const { wgsl } = pluginShaderSource(PLUGIN, effect());
    expect(wgsl).toContain('fn fs');
    expect(wgsl).toContain('params.amount');
  });
});

describe('★ the WebGL2 tier', () => {
  it('gets a passthrough rather than nothing', () => {
    /*
      `ShaderSource` has no optional variant. A missing GLSL pair is not "the
      effect does nothing" — it is a pipeline that cannot be created, which
      surfaces as a black layer or a dead viewport. Passthrough is the honest
      degradation and matches what a failed compile does on WebGPU.
    */
    const { glsl } = pluginShaderSource(PLUGIN, effect());

    expect(glsl.vertex).toContain('#version 300 es');
    expect(glsl.fragment).toContain('#version 300 es');
    expect(glsl.fragment).toContain('texture(tex, vUv)');
  });

  it('declares the uniform block even though it reads nothing from it', () => {
    // The layout has to match binding 0 or the pipeline is invalid, whether or
    // not a passthrough has any use for a parameter.
    expect(pluginShaderSource(PLUGIN, effect()).glsl.vertex).toContain('uniform Object');
  });

  it('says which tiers are passthrough-only', () => {
    // Asked as a question rather than hardcoded, so surfaces that warn about it
    // stop warning the day authors can ship GLSL.
    expect(isPassthroughOnly('webgl2')).toBe(true);
    expect(isPassthroughOnly('software')).toBe(true);
    expect(isPassthroughOnly('webgpu')).toBe(false);
  });
});

describe('the material descriptor', () => {
  it('names the same shader the source registered', () => {
    const source = pluginShaderSource(PLUGIN, effect());
    expect(pluginEffectMaterial(PLUGIN, effect()).shader).toBe(source.name);
  });

  it('uses the established effect binding layout', () => {
    // The same shape DISPLACEMENT_MAP_MATERIAL and friends use. A plugin effect
    // is not a new kind of pass; it is another material.
    expect(pluginEffectMaterial(PLUGIN, effect()).layout).toBe(PLUGIN_EFFECT_MATERIAL_LAYOUT);
  });
});

describe('registering', () => {
  it('registers one source per declared effect', () => {
    const { registry, sources } = fakeRegistry();

    const names = registerPluginShaders(registry, PLUGIN, [effect('glow'), effect('bloom')]);

    expect(names).toEqual([`${PLUGIN}.glow`, `${PLUGIN}.bloom`]);
    expect(sources.size).toBe(2);
  });

  it('★ lets a new version replace the previous shader', () => {
    /*
      Registration is keyed by name, so re-registering after an update is how a
      new version's shader takes over. If it appended or refused instead, an
      updated plugin would keep drawing its old effect with no sign of it.
    */
    const { registry, sources } = fakeRegistry();
    registerPluginShaders(registry, PLUGIN, [effect()]);

    const updated: EffectContribution = { ...effect(), shader: '@fragment fn fs() {} // v2' };
    registerPluginShaders(registry, PLUGIN, [updated]);

    expect(sources.size).toBe(1);
    expect(sources.get(`${PLUGIN}.glow`)!.wgsl).toContain('v2');
  });

  it('keeps two plugins apart', () => {
    const { registry, sources } = fakeRegistry();

    registerPluginShaders(registry, PLUGIN, [effect()]);
    registerPluginShaders(registry, 'studio.other.fx', [effect()]);

    expect([...sources.keys()].sort())
      .toEqual([`${PLUGIN}.glow`, 'studio.other.fx.glow']);
  });
});
