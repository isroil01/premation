/**
 * A plugin effect, described the way built-in effects are.
 *
 * The point of this bridge is that nothing downstream has to know a plugin
 * exists — the browser, the stack, the inspector and the keyframe path all read
 * an `EffectDef`. So the assertions are about the seams where "it is a plugin"
 * could leak out and break something:
 *
 *   • `effectDefFor` must resolve a namespaced type, or a document that uses one
 *     opens with the effect in the data and absent from every surface.
 *   • Parameters must arrive as inspector controls, or the effect is unusable.
 *   • The label must disambiguate two plugins that both shipped a "Glow".
 */

import { effectDefFor, addEffect, getNodeEffects, paramsOf } from './effects';
import { pluginEffectDefs, pluginEffectDef, PLUGIN_EFFECT_CATEGORY } from './pluginEffectDefs';
import { registerEffects, unregisterEffects, resetEffectsForTests } from '@core/plugins/pluginEffects';
import type { EffectContribution } from '@core/plugins/effectSchema';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';

const PLUGIN = 'studio.acme.glow';
const ID = `${PLUGIN}.tint`;

const contribution: EffectContribution = {
  id: 'tint',
  label: 'Tint',
  shader: '@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
  params: {
    amount: { type: 'number', default: 0.5, min: 0, max: 2, label: 'Amount' },
    tint: { type: 'color', default: '#ff0000' },
    innerGlow: { type: 'boolean', default: true },
  },
};

let seq = 0;
function node(): string {
  const id = `n_fx_${++seq}`;
  defaultSceneGraph.addNode({
    id,
    name: 'Layer',
    children: [],
    parent: null,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [],
  } as SceneNode);
  return id;
}

beforeEach(() => {
  resetEffectsForTests();
  defaultSceneGraph.clear();
  registerEffects(PLUGIN, 'Acme Glow', [contribution]);
});

describe('describing a plugin effect', () => {
  it('★ is resolvable by its namespaced type', () => {
    /*
      The lookup the static map cannot do. Every reader treats `undefined` as
      "unknown effect" — no parameters, no label, silently skipped — so a
      document with a plugin effect on a layer would open with the effect
      present in the data and invisible everywhere else.
    */
    expect(effectDefFor(ID)).toBeDefined();
    expect(effectDefFor(ID)!.type).toBe(ID);
  });

  it('★ names the plugin in the label', () => {
    // Two plugins may both ship a "Glow", and a browser listing two identical
    // rows is a coin flip.
    expect(effectDefFor(ID)!.label).toBe('Acme Glow: Tint');
  });

  it('turns declared parameters into inspector controls', () => {
    const params = effectDefFor(ID)!.params;

    expect(params.map((p) => p.key).sort()).toEqual(['amount', 'innerGlow', 'tint']);
    expect(params.find((p) => p.key === 'amount')).toMatchObject({
      label: 'Amount', type: 'number', min: 0, max: 2, default: 0.5,
    });
  });

  it('maps boolean to the checkbox control this vocabulary uses', () => {
    expect(effectDefFor(ID)!.params.find((p) => p.key === 'innerGlow')?.type).toBe('checkbox');
  });

  it('humanises a parameter that declared no label', () => {
    // The same fallback layer-kind properties get. A plugin that omits one is
    // not punished with a raw identifier in the inspector.
    expect(effectDefFor(ID)!.params.find((p) => p.key === 'innerGlow')?.label)
      .toBe('Inner glow');
  });

  it('is marked GPU-only, with no CSS equivalent', () => {
    // Not a placeholder: a plugin effect is WGSL, so there is no CSS filter for
    // it and never will be. Both fields already mean exactly that for the
    // built-in GPU effects, so the existing "GPU" tag applies unchanged.
    const def = effectDefFor(ID)!;
    expect(def.gpuOnly).toBe(true);
    expect(def.css({})).toBe('');
  });
});

describe('the browser listing', () => {
  it('lists every registered effect', () => {
    expect(pluginEffectDefs().map((d) => d.type)).toEqual([ID]);
  });

  it('★ reflects a plugin being disabled', () => {
    /*
      The reason this is a function and not a constant. `EFFECT_DEFS` is built
      at module load; the plugin set changes while the app runs, and a captured
      list would keep offering an effect the user just turned off.
    */
    unregisterEffects(PLUGIN);
    expect(pluginEffectDefs()).toEqual([]);
    expect(effectDefFor(ID)).toBeUndefined();
  });

  it('has its own browser folder', () => {
    // Rather than being sorted into a built-in folder by guesswork.
    expect(PLUGIN_EFFECT_CATEGORY).toBe('Plugins');
  });

  it('answers undefined for a type no plugin registered', () => {
    expect(pluginEffectDef('studio.nobody.thing')).toBeUndefined();
  });
});

describe('★ adding one to a layer', () => {
  it('works through the ordinary path, with its declared defaults', () => {
    /*
      `addEffect` reads the def to seed parameters. Before `effectDefFor`
      consulted plugins it returned early for a namespaced type, so adding a
      plugin effect did nothing at all — no error, no effect, no clue.
    */
    const id = node();
    addEffect(id, ID as never);

    const [effect] = getNodeEffects(id);
    expect(effect?.type).toBe(ID);
    expect(paramsOf(effect!)).toMatchObject({ amount: 0.5, tint: '#ff0000', innerGlow: true });
  });

  it('keeps a value the user set over the declared default', () => {
    const id = node();
    addEffect(id, ID as never);
    const [effect] = getNodeEffects(id);

    expect(paramsOf({ ...effect!, params: { ...effect!.params, amount: 1.75 } }).amount)
      .toBe(1.75);
  });

  it('still refuses a type nothing declares', () => {
    // The guard `addEffect` already had, which must survive the widening.
    const id = node();
    addEffect(id, 'studio.nobody.thing' as never);
    expect(getNodeEffects(id)).toEqual([]);
  });
});
