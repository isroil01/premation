/**
 * The cameras a 3D view can look through, over the document MIRROR (B4) — the
 * twins of `camera3d.lookThroughCamera` / `lookThroughCameras`. Pure: they take
 * the mirror (the app passes `documentMirror()`) and never touch the engine.
 *
 * A camera can be looked through when it is a camera layer of the composition
 * (inside its groups and legacy nested precomp groups too — the scene walk
 * `flattenComposition` descends every child) and its Video switch is on.
 */

import type { LayerInfo } from '@motion/engine-api';
import { uiKindOf } from './layerKinds';

/** What these readers need from the mirror. `DocumentMirror` is one. */
export interface MirrorCameraRead {
  readonly compIds: readonly string[];
  layer(id: string): LayerInfo | undefined;
  comp(id: string): { readonly layers: readonly string[] } | undefined;
}

/**
 * Every layer of `comp`, top of the stack first, a group's (or legacy nested
 * precomp group's) layers following it. An unknown `comp` walks every
 * composition, as the scene walk falls back to the whole scene.
 */
function viewableLayers(m: MirrorCameraRead, comp: string | undefined): LayerInfo[] {
  const out: LayerInfo[] = [];
  const seen = new Set<string>();
  const walk = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const l = m.layer(id);
      if (!l) continue;
      out.push(l);
      if (l.children.length > 0) walk(l.children);
      // A legacy nested precomp group carries its own layers as a composition.
      else if (l.kind === 'precomp' && !l.source) {
        const inner = m.comp(l.id);
        if (inner) walk(inner.layers);
      }
    }
  };
  const root = comp ? m.comp(comp) : undefined;
  if (root) walk(root.layers);
  else for (const c of m.compIds) walk(m.comp(c)?.layers ?? []);
  return out;
}

function isViewCamera(l: LayerInfo): boolean {
  return uiKindOf(l) === 'camera' && l.switches.visible !== false;
}

/** The camera layer `layerId` when a view can look through it in `comp`, else null. */
export function mirrorLookThroughCamera(m: MirrorCameraRead, layerId: string | null | undefined, comp?: string): LayerInfo | null {
  if (!layerId) return null;
  const l = viewableLayers(m, comp).find((x) => x.id === layerId);
  return l && isViewCamera(l) ? l : null;
}

/** Every camera a view could look through in `comp`, TOPMOST FIRST (the timeline's order). */
export function mirrorLookThroughCameras(m: MirrorCameraRead, comp?: string): LayerInfo[] {
  return viewableLayers(m, comp).filter(isViewCamera);
}
