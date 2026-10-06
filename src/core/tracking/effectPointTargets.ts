/**
 * The effect points a point track can drive (AE parity 3.6: "apply to any
 * effect point"): every pair of `<base>X` / `<base>Y` px params of the
 * target's effects, as `effects/<id>/<base>` — the path the engine's
 * trackApply job takes as `targetPath`. Pure.
 */

import { effectDefFor } from '@core/inspector/effectCatalog';

export interface EffectPointTarget {
  /** `effects/<id>/<base>`. */
  path: string;
  label: string;
}

export function effectPointTargets(effects: ReadonlyArray<{ id: string; type: string }>): EffectPointTarget[] {
  const out: EffectPointTarget[] = [];
  for (const e of effects) {
    const def = effectDefFor(e.type as never);
    if (!def) continue;
    const keys = new Map(def.params.map((p) => [p.key, p]));
    for (const p of def.params) {
      if (p.type !== 'number' || !p.key.endsWith('X')) continue;
      const base = p.key.slice(0, -1);
      const y = keys.get(`${base}Y`);
      // Layer pixels only: a % point (Beam's) is not a place on the layer.
      if (!y || y.type !== 'number' || (p.unit && p.unit !== 'px') || (y.unit && y.unit !== 'px')) continue;
      const name = p.label.replace(/\s*X(\s+Offset)?$/i, '').trim() || base;
      out.push({ path: `effects/${e.id}/${base}`, label: `${def.label} › ${name}` });
    }
  }
  return out;
}
