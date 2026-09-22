/**
 * Emptying the Assets panel at a project boundary WITHOUT losing anything.
 *
 * WHY THIS EXISTS. The asset store is the device's footage library and the
 * open project's asset list at once, so File ▸ New Project produced an
 * "Untitled" project still listing the last project's clips. The obvious fix —
 * `removeAssets` on everything — is the dangerous one: it deletes the IndexedDB
 * rows that crash recovery and single-file projects rebind their footage from.
 * These pin the three things that make the reset safe: the library is left
 * alone, the parked assets' organisation survives the next import's wholesale
 * map rewrite, and an Open after a reset gets its footage back.
 */

const deleteAsset = jest.fn(async () => {});
const getAllAssets = jest.fn();
jest.mock('@core/services/AssetDatabase', () => ({
  AssetDatabase: {
    deleteAsset: (...a: unknown[]) => deleteAsset(...(a as [])),
    getAllAssets: () => getAllAssets(),
    saveAsset: jest.fn(async () => {}),
  },
}));

import { useAssetStore, parkedAmong, type ImportedAsset } from '@stores/assetStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';
import { referencedAssetIds, rehydrateReferencedAssets, resetSessionAssets } from './sessionAssets';

const ASSIGN_KEY = 'motion-editor.assetFolderAssignments.v1';

const asset = (id: string, extra: Partial<ImportedAsset> = {}): ImportedAsset => ({
  id, name: `${id}.png`, type: 'image', src: `blob:${id}`, size: 1, ...extra,
});

const dbRow = (id: string) => ({
  id, name: `${id}.png`, type: 'image' as const, size: 1, data: new Blob(['x']), metadata: undefined, thumb: undefined,
});

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

function addImageLayer(id: string, assetId: string): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_img`, type: 'Image', props: { assetId, src: 'blob:dead' } }],
  } as unknown as SceneNode);
}

let minted = 0;
beforeAll(() => {
  const url = URL as unknown as { revokeObjectURL: (u: string) => void; createObjectURL: (b: Blob) => string };
  url.revokeObjectURL = () => {};
  url.createObjectURL = () => `blob:fresh-${++minted}`;
});

beforeEach(() => {
  deleteAsset.mockClear();
  getAllAssets.mockReset();
  localStorage.clear();
  resetScene();
  useAssetStore.setState({ assets: [], folders: [{ id: 'f1', name: 'Footage', parentId: null }] });
});

describe('resetSessionAssets', () => {
  it('empties the list but deletes NOTHING from the device library', () => {
    useAssetStore.setState({ assets: [asset('clip'), asset('image')] });
    resetSessionAssets();
    expect(useAssetStore.getState().assets).toEqual([]);
    expect(deleteAsset).not.toHaveBeenCalled();
  });

  it('keeps a parked asset’s folder assignment through the next wholesale rewrite', () => {
    useAssetStore.setState({ assets: [asset('clip', { folderId: 'f1' }), asset('other')] });
    // Any organisation write persists the map as it stands.
    useAssetStore.getState().moveAssetToFolder('other', 'f1');
    expect(JSON.parse(localStorage.getItem(ASSIGN_KEY)!)).toEqual({ clip: 'f1', other: 'f1' });

    resetSessionAssets();

    // The new project imports one file and files it — which rewrites the map
    // from a list that no longer contains `clip`.
    useAssetStore.setState({ assets: [asset('fresh')] });
    useAssetStore.getState().moveAssetToFolder('fresh', 'f1');
    expect(JSON.parse(localStorage.getItem(ASSIGN_KEY)!)).toEqual({ clip: 'f1', other: 'f1', fresh: 'f1' });
  });

  it('a boot hydration still in flight does not refill the list after the reset', async () => {
    let release: (rows: unknown[]) => void = () => {};
    getAllAssets.mockReturnValue(new Promise((r) => { release = r; }));
    const pending = useAssetStore.getState().initialize();
    resetSessionAssets();
    release([dbRow('clip')]);
    await pending;
    expect(useAssetStore.getState().assets).toEqual([]);
    // ...but it is not forgotten: an Open that references it can still get it.
    expect(parkedAmong(['clip']).has('clip')).toBe(true);
  });
});

describe('rehydrateReferencedAssets', () => {
  it('finds both reference styles in the scene', () => {
    addImageLayer('a', 'clip');
    defaultSceneGraph.addNode({
      id: 'b', name: 'b', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: 'b_a', type: 'Audio', props: { __assetId: 'song', __src: 'blob:dead' } }],
    } as unknown as SceneNode);
    expect([...referencedAssetIds()].sort()).toEqual(['clip', 'song']);
  });

  it('brings back ONLY what the opened document references, and rebinds its layers', async () => {
    useAssetStore.setState({ assets: [asset('clip'), asset('unrelated')] });
    resetSessionAssets();
    expect([...parkedAmong(['clip', 'unrelated', 'never-seen'])].sort()).toEqual(['clip', 'unrelated']);

    // "Open": the document lands with a dead blob: src and a durable assetId.
    addImageLayer('layer', 'clip');
    getAllAssets.mockResolvedValue([dbRow('clip'), dbRow('unrelated')]);
    await rehydrateReferencedAssets();

    const assets = useAssetStore.getState().assets;
    expect(assets.map((a) => a.id)).toEqual(['clip']);
    const src = defaultSceneGraph.getNode('layer')!.components[0]!.props.src;
    expect(src).toBe(assets[0]!.src);
    // Back in the session, so no longer parked.
    expect(parkedAmong(['clip']).size).toBe(0);
  });

  it('does not touch the library at all when nothing was parked', async () => {
    addImageLayer('layer', 'clip');
    await rehydrateReferencedAssets();
    expect(getAllAssets).not.toHaveBeenCalled();
  });
});
