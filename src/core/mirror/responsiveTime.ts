/**
 * A composition's Responsive Time configuration from its mirror settings
 * (`CompSettings.responsiveTime`, JSON) — the twin of `readResponsiveTime`
 * (template/responsiveTimeStore.ts), validated the same way. Pure.
 */

import type { CompSettings } from '@motion/engine-api';
import type { ResponsiveTimeConfig } from '@core/template/responsiveTimeStore';

const cache = new Map<string, ResponsiveTimeConfig | null>();

function isConfig(v: unknown): v is ResponsiveTimeConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as ResponsiveTimeConfig;
  return typeof c.authoredDurationSec === 'number' && Array.isArray(c.protectedRegions);
}

/** The comp's responsive-time config, or undefined when it has none (same object per JSON string). */
export function settingsResponsiveTime(s: Pick<CompSettings, 'responsiveTime'> | undefined): ResponsiveTimeConfig | undefined {
  const raw = s?.responsiveTime;
  if (!raw) return undefined;
  let hit = cache.get(raw);
  if (hit === undefined) {
    try {
      const v = JSON.parse(raw) as unknown;
      hit = isConfig(v) ? v : null;
    } catch {
      hit = null;
    }
    if (cache.size > 64) cache.clear();
    cache.set(raw, hit);
  }
  return hit ?? undefined;
}
