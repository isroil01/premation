/**
 * A stopwatch is offered EXACTLY where a keyframe can drive the render.
 *
 * Both directions matter and both have failed here:
 *
 *   offered but inert   a control that writes a track nothing samples. The user
 *                       sets two keyframes, scrubs, and nothing moves — which is
 *                       indistinguishable from a broken renderer and is how the
 *                       "styles don't animate" report reads.
 *   samplable but not   a property the engine would happily animate, with no way
 *   offered             to reach it from the UI.
 *
 * Derived from the same tables the renderer and the panels use, so the assertion
 * cannot drift from either side by editing one of them.
 */

import { EFFECT_DEFS, resolveEffectParams, effectPropPath, effectParam, type Effect } from './effects';
import {
  LAYER_STYLE_NUMBER_PARAMS,
  LAYER_STYLE_COLOR_PARAMS,
  layerStyleEffectId,
  layerStylesToEffects,
  DEFAULT_DROP_SHADOW,
} from './layerStyles';

/** Param types `resolveEffectParams` can actually sample. Anything else is
 *  static by construction, and the Effect Controls row must not offer a
 *  stopwatch for it (EffectStack routes checkbox/layer/curve to their own
 *  branches, which render no stopwatch). */
const SAMPLABLE = new Set(['number', 'color']);

describe('effect params: samplable ⇔ keyframeable', () => {
  it.each(EFFECT_DEFS.map((d) => [d.type, d] as const))(
    '%s — every param the sampler honours is a number or a colour, and vice versa',
    (_type, def) => {
      for (const p of def.params) {
        const e: Effect = { id: 'e1', type: def.type, params: {} };
        const resolved = resolveEffectParams([e], (path) =>
          path === effectPropPath('e1', p.key) ? 42 : undefined,
        )[0]!;
        const honoured = effectParam(resolved, p.key) === 42;
        // Colour params are driven by their `_r/_g/_b/_a` channels, not by the
        // bare key, so they are samplable without responding to this probe.
        if (p.type === 'color') {
          const viaChannel = resolveEffectParams([e], (path) =>
            path === effectPropPath('e1', `${p.key}_r`) ? 1 : undefined,
          )[0]!;
          expect(typeof effectParam(viaChannel, p.key)).toBe('string');
          continue;
        }
        expect(honoured).toBe(SAMPLABLE.has(p.type));
      }
    },
  );
});

describe('layer style fields: a prop path exists only where the compiler emits one', () => {
  // The panel asks these two tables for a prop path and renders a stopwatch only
  // when it gets one back (`stylePath` / `styleColorPath` return null otherwise).
  // So "every entry names a param that really is emitted" is the same statement
  // as "every stopwatch shown can work".
  it('every declared numeric binding drives the compiled effect', () => {
    const styles = { dropShadow: { ...DEFAULT_DROP_SHADOW, useGlobalLight: false } };
    for (const [field, binding] of Object.entries(LAYER_STYLE_NUMBER_PARAMS.dropShadow!)) {
      const compiled = layerStylesToEffects(styles as never, undefined, undefined, () => true);
      const resolved = resolveEffectParams(compiled, (path) =>
        path === effectPropPath(layerStyleEffectId('dropShadow'), binding.param) ? 7 : undefined,
      );
      const ds = resolved.find((e) => e.id === layerStyleEffectId('dropShadow'))!;
      expect({ field, value: effectParam(ds, binding.param) }).toEqual({ field, value: 7 });
    }
  });

  it('a field with no binding yields no prop path, so the panel shows no stopwatch', () => {
    // `useGlobalLight` and `enabled` are switches, not values — neither table
    // names them, which is what makes the panel render them without a stopwatch.
    for (const field of ['enabled', 'useGlobalLight']) {
      expect(LAYER_STYLE_NUMBER_PARAMS.dropShadow?.[field]).toBeUndefined();
      expect(LAYER_STYLE_COLOR_PARAMS.dropShadow?.[field]).toBeUndefined();
    }
  });
});
