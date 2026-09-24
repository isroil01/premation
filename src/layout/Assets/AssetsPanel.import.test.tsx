/**
 * The import workflow, as the Project tab must honour it.
 *
 * The report this pins: "I imported images in the Bin tab but they didn't
 * show in the Bin — they were added straight to the scene." Two things were
 * true at once. The panel's import handler INSERTED every file it imported
 * (AE/Premiere never do — import fills the project, placing is a separate
 * gesture), and because the inserted file was now "used", a persisted
 * Unused filter dropped it from the list the moment it arrived. Either half
 * alone reads as "the import vanished"; together they are exactly the report.
 *
 * So, the contract:
 *   • importing NEVER inserts — the composition is untouched afterwards;
 *   • a fresh import is in the DOM at once, selected, in list AND grid view,
 *     and a filter that would hide it is cleared with a note saying so;
 *   • the tabs say what they are.
 *
 * jsdom has no layout, no object URLs and no image decoder, so the seams the
 * panel and the store rely on are stubbed at the edges: sizes are constants,
 * `createObjectURL` mints a string, `Image` reports failure (metadata is
 * simply absent), IndexedDB is a resolved promise.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AssetsPanel } from './AssetsPanel';
import { TooltipProvider } from '@components/Tooltip';
import { useAssetStore } from '@stores/assetStore';
import { resetAssetsViewForTest, useAssetsViewStore } from '@stores/assetsViewStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { engineIdle } from '@core/engine/engineInstance';
import { historyLabels, setupAppEngine } from '@core/engine/__testHelpers__/appEngine';

jest.mock('@core/services/AssetDatabase', () => ({
  AssetDatabase: {
    saveAsset: jest.fn(async () => undefined),
    getAllAssets: jest.fn(async () => []),
    deleteAsset: jest.fn(async () => undefined),
  },
}));
jest.mock('@core/assets/ingest', () => ({
  maybeIngestForImport: jest.fn(async () => null),
}));
// The drawer asks the project manager where the file lives on disk; there is
// no booted project here, and "reveal" is not what these tests are about.
jest.mock('./assetReveal', () => ({
  assetDiskPath: () => null,
  canRevealAssets: () => false,
  revealAsset: jest.fn(async () => undefined),
}));

class NoopResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* no layout in jsdom */ }
  disconnect(): void { /* no layout in jsdom */ }
}

/** `Image` that fails to decode on the next tick — the store's probe then
 *  resolves with no metadata, which is a legal asset. */
class FailingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;
  set src(_v: string) {
    setTimeout(() => this.onerror?.(), 0);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const urlAny = URL as unknown as Record<string, unknown>;
let savedImage: unknown;
let savedCreate: unknown;
let savedRevoke: unknown;

beforeAll(() => {
  g['ResizeObserver'] = NoopResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 320 });
  savedImage = g['Image'];
  g['Image'] = FailingImage;
  savedCreate = urlAny['createObjectURL'];
  savedRevoke = urlAny['revokeObjectURL'];
  let n = 0;
  urlAny['createObjectURL'] = () => `blob:test-${n++}`;
  urlAny['revokeObjectURL'] = () => undefined;
});

afterAll(() => {
  g['Image'] = savedImage;
  urlAny['createObjectURL'] = savedCreate;
  urlAny['revokeObjectURL'] = savedRevoke;
});

function contentLayerCount(): number {
  let n = 0;
  defaultSceneGraph.traverse((node) => { if (readNodeKind(node) !== 'group') n++; });
  return n;
}

beforeEach(() => {
  localStorage.clear();
  resetAssetsViewForTest();
  useAssetStore.setState({ assets: [], folders: [] });
  useUIStore.setState({ notifications: [] });
});

/** The panel as the app mounts it: icon buttons want the tooltip provider. */
const renderPanel = (): ReturnType<typeof render> =>
  render(<TooltipProvider><AssetsPanel /></TooltipProvider>);

/** The list itself — the drawer under it echoes the selected name, so row
 *  queries are scoped here. */
const tree = () => within(screen.getByRole('tree', { name: 'Assets' }));

const png = (name = 'a.png'): File => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

const importViaStore = (name = 'a.png'): Promise<void> =>
  act(async () => {
    await useAssetStore.getState().addAssetsBatch([{ file: png(name) }]);
  });

/** The panel's own import: the hidden file input, as the picker fires it. */
const importViaPicker = (files: File[]): Promise<void> =>
  act(async () => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept^="image/*"]');
    if (!input) throw new Error('media file input not rendered');
    fireEvent.change(input, { target: { files } });
    // Let the async handler run to completion.
    await new Promise((r) => setTimeout(r, 20));
  });

describe('import never inserts', () => {
  it('the panel import adds to the project only — the composition is untouched', async () => {
    renderPanel();
    const before = contentLayerCount();
    await importViaPicker([png('shot.png'), png('logo.png')]);

    expect(useAssetStore.getState().assets.map((a) => a.name)).toEqual(['shot.png', 'logo.png']);
    expect(contentLayerCount()).toBe(before);
    // Both rows are on the shelf.
    expect(await tree().findByText('shot.png')).toBeInTheDocument();
    expect(tree().getByText('logo.png')).toBeInTheDocument();
  });

  it('offers ONE toast, "Imported N files", whose action places them', async () => {
    // The action inserts through the engine (`insertMediaEdit`).
    const h = await setupAppEngine();
    try {
      useAssetStore.setState({ assets: [], folders: [] });
      renderPanel();
      const before = contentLayerCount();
      await importViaPicker([png('shot.png'), png('logo.png')]);

      const toasts = useUIStore.getState().notifications;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]?.message).toBe('Imported 2 files');
      expect(toasts[0]?.action?.label).toBe('Add to composition');

      const entries = historyLabels().length;
      await act(async () => {
        toasts[0]?.action?.onSelect();
        await new Promise((r) => setTimeout(r, 20));
        await engineIdle();
      });
      expect(contentLayerCount()).toBe(before + 2);
      // Both files in ONE undo entry.
      expect(historyLabels().slice(entries)).toEqual(['Insert 2 Layers']);
    } finally {
      await h.dispose();
    }
  });

  it('an import under a persisted Unused filter still shows — and, being unused, the filter stays', async () => {
    // The persisted-filter half of the report. Under the old auto-insert the
    // fresh file was "used" before the list ever drew it, so this exact
    // setup showed nothing. Now the file is unused, the filter passes it,
    // and a filter the import passes is left alone (no note).
    useAssetsViewStore.getState().setUnusedOnly(true);
    renderPanel();
    await importViaPicker([png('shot.png')]);

    expect(await tree().findByText('shot.png')).toBeInTheDocument();
    expect(useAssetsViewStore.getState().unusedOnly).toBe(true);
    expect(screen.queryByText('Filters cleared to show the import')).toBeNull();
  });
});

describe('a fresh import is visible at once', () => {
  it('list view: the row is in the DOM and selected', async () => {
    renderPanel();
    await importViaStore('a.png');
    const row = await tree().findByText('a.png');
    expect(row.closest('[role="treeitem"]')).toHaveAttribute('aria-selected', 'true');
  });

  it('grid view: the card is in the DOM and selected', async () => {
    useAssetsViewStore.getState().setView('grid');
    renderPanel();
    await importViaStore('a.png');
    const card = await tree().findByText('a.png');
    expect(card.closest('[role="treeitem"]')).toHaveAttribute('aria-selected', 'true');
  });

  it('a type filter that would hide the import is cleared, with the note', async () => {
    useAssetsViewStore.getState().setTypeFilter('video');
    renderPanel();
    await importViaStore('a.png');
    expect(await tree().findByText('a.png')).toBeInTheDocument();
    expect(useAssetsViewStore.getState().typeFilter).toBe('all');
    expect(screen.getByText('Filters cleared to show the import')).toBeInTheDocument();
  });

  it('a filter the import passes is left alone', async () => {
    useAssetsViewStore.getState().setTypeFilter('image');
    renderPanel();
    await importViaStore('a.png');
    expect(await tree().findByText('a.png')).toBeInTheDocument();
    expect(useAssetsViewStore.getState().typeFilter).toBe('image');
    expect(screen.queryByText('Filters cleared to show the import')).toBeNull();
  });

  it('filed into a collapsed folder, the folder is opened so the row shows', async () => {
    const folder = useAssetStore.getState().createFolder('Footage', null);
    renderPanel();
    await act(async () => {
      await useAssetStore.getState().addAssetsBatch([{ file: png('deep.png'), folderId: folder.id }]);
    });
    expect(await tree().findByText('deep.png')).toBeInTheDocument();
  });
});

describe('the tabs explain themselves', () => {
  const win = window as unknown as { motionEditor?: unknown };
  beforeEach(() => {
    win.motionEditor = { shell: { listDir: async () => [], pickFolder: async () => null } };
  });
  afterEach(() => {
    delete win.motionEditor;
  });

  it('says Assets and Media Browser, not Bin and Browse', () => {
    renderPanel();
    expect(screen.getByRole('tab', { name: /Assets/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Media Browser/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Bin$/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /^Browse$/ })).toBeNull();
  });

  it('the empty Assets tab says where imports go, with Import as its action', () => {
    renderPanel();
    expect(screen.getByText(/Imports go to this list/)).toBeInTheDocument();
    // One Import affordance in the header, one in the empty state — no dock duplicates.
    expect(screen.getAllByRole('button', { name: /^Import$/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTitle('Import Media Files…')).toBeNull();
    expect(screen.queryByTitle('Import Folder (keeps folder structure)…')).toBeNull();
  });

  it('the empty Media Browser says it browses without importing', () => {
    useAssetsViewStore.getState().setTab('browse');
    renderPanel();
    expect(screen.getByText(/browse its files without importing/)).toBeInTheDocument();
  });
});

describe('OS drop on the panel', () => {
  it('imports to the project without inserting', async () => {
    renderPanel();
    const before = contentLayerCount();
    const host = screen.getByRole('tree', { name: 'Assets' });
    await act(async () => {
      fireEvent.drop(host, { dataTransfer: { files: [png('dropped.png')], getData: () => '', types: ['Files'] } });
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(useAssetStore.getState().assets.map((a) => a.name)).toEqual(['dropped.png']));
    expect(contentLayerCount()).toBe(before);
    expect(await tree().findByText('dropped.png')).toBeInTheDocument();
  });
});

describe('Folder creation and single affordance', () => {
  it('there is exactly one New Folder button in the panel', () => {
    renderPanel();
    const buttons = screen.getAllByRole('button', { name: /New Folder/i });
    expect(buttons).toHaveLength(1);
  });

  it('clicking New Folder creates and shows the folder with an inline rename input', async () => {
    renderPanel();
    const btn = screen.getByRole('button', { name: /New Folder/i });
    fireEvent.click(btn);

    const input = await screen.findByDisplayValue('New Folder');
    expect(input).toBeInTheDocument();
    expect(useAssetStore.getState().folders).toHaveLength(1);
    expect(useAssetStore.getState().folders[0]?.name).toBe('New Folder');
  });

  it('clicking New Folder while filter is active clears filters so the folder is visible', async () => {
    useAssetsViewStore.getState().setTypeFilter('video');
    renderPanel();
    const btn = screen.getByRole('button', { name: /New Folder/i });
    fireEvent.click(btn);

    expect(await screen.findByDisplayValue('New Folder')).toBeInTheDocument();
    expect(useAssetsViewStore.getState().typeFilter).toBe('all');
  });

  it('clicking New Folder when a parent folder is selected expands the parent and nests the subfolder', async () => {
    const parent = useAssetStore.getState().createFolder('ParentFolder', null);
    renderPanel();

    const parentRow = await tree().findByText('ParentFolder');
    fireEvent.click(parentRow);

    const btn = screen.getByRole('button', { name: /New Folder/i });
    fireEvent.click(btn);

    expect(await screen.findByDisplayValue('New Folder')).toBeInTheDocument();
    const sub = useAssetStore.getState().folders.find((f) => f.name === 'New Folder');
    expect(sub?.parentId).toBe(parent.id);
  });
});

describe('Grid view folder layout and empty drop target', () => {
  it('renders grid folder with Empty badge and shows empty drop target when expanded', async () => {
    useAssetsViewStore.getState().setView('grid');
    useAssetStore.getState().createFolder('B-Roll', null);
    renderPanel();

    expect(await tree().findByText('B-Roll')).toBeInTheDocument();
    expect(screen.getByText('Empty')).toBeInTheDocument();

    // Click to expand folder
    const folderRow = await tree().findByText('B-Roll');
    fireEvent.click(folderRow);

    // Shows empty drop target
    expect(await tree().findByText(/Folder is empty · Drop files here/)).toBeInTheDocument();
  });

  it('renders item count badge and cards inside folder when folder has assets', async () => {
    useAssetsViewStore.getState().setView('grid');
    const folder = useAssetStore.getState().createFolder('Footage', null);
    await useAssetStore.getState().addAssetsBatch([
      { file: png('nested.png'), folderId: folder.id },
      { file: png('root_file.png'), folderId: null },
    ]);
    renderPanel();

    expect(await tree().findByText('Footage')).toBeInTheDocument();
    expect(screen.getByText('1 item')).toBeInTheDocument();

    // Both root and folder cards are distinct and findable
    expect(await tree().findByText('root_file.png')).toBeInTheDocument();
    expect(screen.getByText(/Media \(1\)/)).toBeInTheDocument();

    // Click folder to expand
    fireEvent.click(await tree().findByText('Footage'));
    expect(await tree().findByText('nested.png')).toBeInTheDocument();
  });
});


