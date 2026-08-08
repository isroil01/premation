/**
 * Plugin effects, described the way built-in effects are.
 *
 * The effect stack, the browser, the inspector and the keyframe path all read
 * an `EffectDef`. Teaching each of them what a plugin is would mean four places
 * that can disagree about the same effect — so a plugin effect becomes an
 * `EffectDef` here, once, and everything downstream treats it as ordinary.
 *
 * ── Why this is a function and not a constant ────────────────────────────────
 *
 * `EFFECT_DEFS` is an array built at module load, and `DEF` is a Map built from
 * it. That is correct for built-ins, whose set is fixed at build time. The set
 * of PLUGIN effects is whatever the user has installed and enabled, and it
 * changes while the app is running — so it has to be asked for, not captured.
 *
 * A `useSyncExternalStore` on `subscribeToEffects` is what makes a surface
 * re-render when it changes; this module just answers the question.
 */

import { registeredEffects, effectById } from '@core/plugins/pluginEffects';
import type { EffectDef, EffectParamDef, EffectParamValue, EffectType } from './effects';

/**
 * The folder plugin effects appear under.
 *
 * Their own, rather than sorted into `Stylize` or `Generate` by guesswork. A
 * user looking for something a plugin added knows it came from a plugin, and
 * scattering them through folders built around what an effect DOES would make
 * them findable only by remembering the name.
 */
export const PLUGIN_EFFECT_CATEGORY = 'Plugins';

/** `boolean` is a checkbox in this vocabulary; the other two carry over. */
const PARAM_TYPE: Record<string, EffectParamDef['type']> = {
  number: 'number',
  color: 'color',
  boolean: 'checkbox',
};

/**
 * Turn a registered plugin effect into an `EffectDef`.
 *
 * `css` returns empty and `gpuOnly` is true, which is not a placeholder: a
 * plugin effect is WGSL, so there is no CSS-filter equivalent and never will
 * be. Both fields already mean exactly that for the built-in GPU effects, so
 * the UI's existing "GPU" tag applies with no new concept.
 */
function toEffectDef(registered: ReturnType<typeof registeredEffects>[number]): EffectDef {
  const params: EffectParamDef[] = Object.entries(registered.contribution.params).map(
    ([key, schema]) => ({
      key,
      // The author's label, or the property name humanised — the same fallback
      // layer-kind properties get, so a plugin that omits one is not punished
      // with a raw identifier in the inspector.
      label: schema.label ?? humanise(key),
      type: PARAM_TYPE[schema.type] ?? 'number',
      ...(schema.min !== undefined ? { min: schema.min } : {}),
      ...(schema.max !== undefined ? { max: schema.max } : {}),
      default: schema.default as EffectParamValue,
    }),
  );

  return {
    // The namespaced id IS the effect type. That is what a document stores, and
    // it is why a document can name the plugin that provides its effect.
    type: registered.id as EffectType,
    // Prefixed with the plugin's name, because two plugins may both ship a
    // "Glow" and a browser listing two identical rows is a coin flip.
    label: `${registered.pluginName}: ${registered.contribution.label}`,
    params,
    css: () => '',
    gpuOnly: true,
  };
}

/** Every plugin effect currently installed and enabled, as `EffectDef`s. */
export function pluginEffectDefs(): EffectDef[] {
  return registeredEffects().map(toEffectDef);
}

/**
 * One plugin effect's def, or undefined.
 *
 * The lookup `DEF.get()` cannot do, and the reason `effectDefFor` in
 * `effects.ts` consults both: a document opened with a plugin effect on a layer
 * has a type no static map has heard of.
 */
export function pluginEffectDef(type: string): EffectDef | undefined {
  const registered = effectById(type);
  return registered ? toEffectDef(registered) : undefined;
}

/** `innerRadius` → `Inner radius`. */
function humanise(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
