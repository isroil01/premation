/**
 * Can a project snapshot be opened by a window that is not the editor?
 *
 * The export supervisor renders each job in a hidden window of its own, from a
 * project written by `ProjectManager.snapshotTo`. That window shares nothing
 * with the editor but the disk — in particular it cannot read the editor's
 * `blob:` object URLs, which are only valid in the document that minted them
 * (see missingAssets.ts). So whether a snapshot is renderable elsewhere comes
 * down to where its footage lives:
 *
 *  - Off local-first, `snapshotTo` writes a single JSON document and
 *    `collectBundleAssetsForSave` is a no-op, so every imported clip is still a
 *    `blob:` URL in the file. The hidden window would render those layers
 *    black (or not at all). Off local-first the answer is simply no.
 *  - On local-first the snapshot is a `.motion` bundle and the save collects
 *    every LIBRARY asset whose src is a `blob:` into it, then repoints the
 *    layers that name that asset by `assetId`. A layer whose `blob:` src has no
 *    such library entry behind it — no `assetId`, or one the library does not
 *    hold as a `blob:` — is never collected and reaches the window as a dead URL.
 *  - Footage ALREADY collected (`motion-blob:<hash>`) does not travel either.
 *    Those bytes live in the SOURCE project's bundle; `collectAssetsIntoBundle`
 *    skips them as already local, and the hidden window resolves a
 *    `motion-blob:` against the project it opened — the snapshot directory,
 *    which does not hold them (registerCoreServices' blob resolver is scoped to
 *    the current project root). Until the snapshot copies referenced blobs, a
 *    project with collected footage renders in-window.
 *
 * The predicate is the cheap, conservative reading of that: it does not read a
 * single byte. A library `blob:` whose object URL has died since import still
 * counts as carriable (collection would find it unreadable and the layer render
 * offline) — telling the two apart needs a fetch per asset, which is the save's
 * job, not a click handler's.
 *
 * Pure half first (refs + library in, answer out) so it is testable without a
 * scene graph; `sceneMediaRefs` is the live walk that feeds it.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { isLocalFirst } from '@core/config/flags';
import { LOCAL_BLOB_SCHEME } from '@core/rendering/localBlobSource';

/** One media reference a layer carries: the durable id and the stored src. */
export interface MediaRef {
  assetId?: string;
  src: string;
}

/** A library entry, in the only shape this needs. */
export interface LibraryAsset {
  id: string;
  src: string;
}

/** Every `assetId`/`src` pair a media component can carry — the pairs the bundle collector rewrites. */
const SRC_PAIRS: ReadonlyArray<readonly [idKey: string, srcKey: string]> = [
  ['assetId', 'src'],
  ['__assetId', '__src'],
];

/** A src only the editor window can read. */
function isSessionLocal(src: string): boolean {
  return src.trim().startsWith('blob:');
}

/** A src whose bytes live in the source project's bundle, not the snapshot's. */
function isSourceBundleLocal(src: string): boolean {
  return src.trim().startsWith(LOCAL_BLOB_SCHEME);
}

/**
 * The refs a snapshot could NOT carry to another window, given the library the
 * save will collect from. Empty means every piece of footage makes it.
 */
export function uncarriableMedia(refs: Iterable<MediaRef>, library: ReadonlyArray<LibraryAsset>): MediaRef[] {
  // Only a library entry that is itself still a `blob:` gets collected into the
  // snapshot bundle (and its layers repointed at the copy).
  const collectable = new Set(library.filter((a) => isSessionLocal(a.src)).map((a) => a.id));
  const out: MediaRef[] = [];
  for (const ref of refs) {
    if (isSourceBundleLocal(ref.src)) {
      out.push(ref);
      continue;
    }
    if (!isSessionLocal(ref.src)) continue;
    if (ref.assetId && collectable.has(ref.assetId)) continue;
    out.push(ref);
  }
  return out;
}

/**
 * Whether a snapshot of this project can be rendered by the export supervisor's
 * hidden window. False off local-first (single-file snapshot, footage stays as
 * editor-only `blob:` URLs); false when any layer holds a `blob:` the bundle
 * save has no library entry to collect from, or a `motion-blob:` whose bytes
 * stay behind in the source bundle.
 */
export function snapshotIsPortable(input: {
  localFirst: boolean;
  refs: Iterable<MediaRef>;
  library: ReadonlyArray<LibraryAsset>;
}): boolean {
  if (!input.localFirst) return false;
  return uncarriableMedia(input.refs, input.library).length === 0;
}

/** Every media ref in the live scene, every root's subtree. */
export function* sceneMediaRefs(): Generator<MediaRef> {
  const stack = defaultSceneGraph.getRoots().map((r) => r.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = defaultSceneGraph.getNode(id);
    if (!node) continue;
    for (const c of node.components) {
      const props = c.props as Record<string, unknown>;
      for (const [idKey, srcKey] of SRC_PAIRS) {
        const src = props[srcKey];
        if (typeof src !== 'string') continue;
        const assetId = props[idKey];
        yield typeof assetId === 'string' && assetId ? { assetId, src } : { src };
      }
    }
    for (const child of defaultSceneGraph.getChildren(id)) stack.push(child.id);
  }
}

/**
 * The live answer: the open project, the given library, the build's flag.
 * The library is an argument (not a store read) for the same reason
 * `rebindAssetSrcs` takes one — core does not reach into the editor's stores.
 */
export function currentProjectSnapshotIsPortable(library: ReadonlyArray<LibraryAsset>): boolean {
  // The flag first: off local-first the scene walk cannot change the answer.
  if (!isLocalFirst()) return false;
  return snapshotIsPortable({ localFirst: true, refs: sceneMediaRefs(), library });
}
