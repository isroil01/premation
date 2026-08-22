/**
 * Re-bind layer media sources to their LIVE asset urls after a document load.
 *
 * A media layer stores two facts: `assetId` (durable — names the library
 * entry) and `src` (an object URL — dies with the tab that minted it, see
 * missingAssets.ts). Documents therefore always come back with dead `blob:`
 * srcs, while the asset itself survives (IndexedDB / project bundle) and gets
 * a FRESH object URL on hydration. Nothing reconnected the two, so every
 * reload of a project with imported footage — including the dev server's own
 * full reloads — showed black media over a healthy library. This walk is the
 * reconnection: any component whose `assetId`/`__assetId` resolves to a live
 * asset gets that asset's current src, but only when the stored one is a
 * `blob:` (or empty) — http(s), `data:`, `/files/` and packaged `assets/`
 * paths are durable and stay exactly as the document said.
 *
 * Takes the asset list as an argument rather than reading the store so the
 * asset store itself can call it (post-hydration) without an import cycle.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';

export interface RebindableAsset {
  id: string;
  src: string;
}

/** True for a stored src that cannot outlive the session that wrote it. */
function isDeadOnArrival(src: unknown): boolean {
  if (typeof src !== 'string') return false;
  const s = src.trim();
  return s === '' || s.startsWith('blob:');
}

/**
 * Walk every root's subtree and repoint dead media srcs at the live asset.
 * Returns how many components were fixed; bumps the scene once when any were.
 */
export function rebindAssetSrcs(assets: readonly RebindableAsset[]): number {
  if (assets.length === 0) return 0;
  const srcById = new Map(assets.map((a) => [a.id, a.src]));
  let fixed = 0;

  // `node.components` is a throwaway VIEW (see SceneGraph): reads are fine,
  // but a write must go through `writeProp` — the same idiom
  // `retargetLayerSource` uses for exactly this pair of props.
  const rebindPair = (
    nodeId: string,
    componentId: string,
    props: Record<string, unknown>,
    idKey: string,
    srcKey: string,
  ): void => {
    const assetId = props[idKey];
    if (typeof assetId !== 'string' || !assetId) return;
    const live = srcById.get(assetId);
    if (!live || props[srcKey] === live) return;
    if (!isDeadOnArrival(props[srcKey])) return;
    defaultSceneGraph.writeProp(nodeId, componentId, srcKey, live);
    fixed += 1;
  };

  const visit = (id: string): void => {
    const node = defaultSceneGraph.getNode(id);
    if (!node) return;
    for (const c of node.components) {
      const props = c.props as Record<string, unknown>;
      // Picture layers store src/assetId; audio layers the `__`-prefixed pair
      // (hidden from the generic inspector — see insertAudio).
      rebindPair(node.id, c.id, props, 'assetId', 'src');
      rebindPair(node.id, c.id, props, '__assetId', '__src');
    }
    for (const child of defaultSceneGraph.getChildren(id)) visit(child.id);
  };
  for (const root of defaultSceneGraph.getRoots()) visit(root.id);

  if (fixed > 0) bumpScene();
  return fixed;
}
