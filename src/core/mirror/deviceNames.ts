/**
 * The next free device name in a composition ("Camera 3", "Light 2") over the
 * document mirror (B4) — the twin of `sceneInsert.nextDeviceName`, which the
 * New Camera / New Light dialogs prefill. Pure.
 */

import { compLayersDeep, type MirrorFieldRead } from './layerFields';
import { uiKindOf } from './layerKinds';

/** "<Camera|Light> N" with the lowest N no layer of that kind in `comp` is named. */
export function nextDeviceNameIn(m: Pick<MirrorFieldRead, 'comp' | 'layer'>, comp: string | undefined, kind: 'camera' | 'light'): string {
  const base = kind === 'camera' ? 'Camera' : 'Light';
  const used = new Set<string>();
  for (const l of compLayersDeep(m, comp)) {
    if (uiKindOf(l) === kind && l.name) used.add(l.name.trim());
  }
  let i = 1;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

/** Whether composition `comp` holds a layer of editor kind `kind` (a camera, a light). */
export function compHasKind(m: Pick<MirrorFieldRead, 'comp' | 'layer'>, comp: string | undefined, kind: 'camera' | 'light'): boolean {
  return compLayersDeep(m, comp).some((l) => uiKindOf(l) === kind);
}
