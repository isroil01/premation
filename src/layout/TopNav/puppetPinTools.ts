/**
 * Shared chrome for After Effects' five Puppet tools. The active tool stays
 * `puppet-pin`; `puppetPinKind` on the UI store picks which pin a click places.
 */

import type { IconName } from '@components/Icon';
import { PIN_KIND_CATALOG, type PinKind } from '@core/rig/puppet';

export const PUPPET_PIN_ICONS: Record<PinKind, IconName> = {
  position: 'puppet-pin',
  starch: 'push-pin',
  bend: 'rotate',
  advanced: 'crosshair',
  overlap: 'layers',
};

export function puppetPinLabel(kind: PinKind): string {
  return PIN_KIND_CATALOG.find((k) => k.kind === kind)?.label ?? 'Puppet Position Pin Tool';
}

export { PIN_KIND_CATALOG };
export type { PinKind };
