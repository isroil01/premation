/**
 * The dashboard's Assets tab writes the SAME item list the open document saves
 * (captureProjectItems), so its folder edits go through the engine (B3): New
 * folder and Import folder's tree are ONE undo entry each, undo restores the
 * document exactly, and imported files land in the folders their relative
 * paths name.
 */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { useAssetStore } from '@stores/assetStore';
import { DashboardPage } from './DashboardPage';

jest.mock('@core/api/client', () => {
  const page = async () => ({ items: [], total: 0 });
  return {
    api: {
      me: jest.fn(async () => null),
      listProjects: jest.fn(page),
      listRenders: jest.fn(page),
      listTrash: jest.fn(page),
      listAssets: jest.fn(page),
      deleteAsset: jest.fn(async () => undefined),
      cancelRender: jest.fn(),
      destroyProject: jest.fn(),
      restoreProject: jest.fn(),
    },
  };
});

let h: Harness & { engine: LocalEngine };

beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  await h.dispose();
});

function renderAssetsTab(): void {
  render(
    <MemoryRouter initialEntries={['/dashboard?tab=assets']}>
      <DashboardPage />
    </MemoryRouter>,
  );
}

const folderNamed = (name: string) => useAssetStore.getState().folders.find((f) => f.name === name);

it('New folder is one engine entry; undo restores the document', async () => {
  renderAssetsTab();
  const before = h.doc();
  const n = historyLabels().length;
  await act(async () => {
    fireEvent.click(await screen.findByText('New folder'));
    await engineIdle();
  });
  await waitFor(() => expect(folderNamed('New Folder')).toBeDefined());
  expect(historyLabels().length).toBe(n + 1);
  expect(historyLabels().at(-1)).toBe('New Folder');
  await act(async () => { await h.run({ type: 'undo' }); });
  expect(h.doc()).toBe(before);
  expect(folderNamed('New Folder')).toBeUndefined();
});

it('renaming the new folder is one engine entry (Enter and the blur that follows)', async () => {
  renderAssetsTab();
  await act(async () => {
    fireEvent.click(await screen.findByText('New folder'));
    await engineIdle();
  });
  const field = await screen.findByDisplayValue('New Folder');
  const n = historyLabels().length;
  const before = h.doc();
  await act(async () => {
    fireEvent.change(field, { target: { value: 'Logos' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);
    await engineIdle();
  });
  await waitFor(() => expect(folderNamed('Logos')).toBeDefined());
  expect(historyLabels().length).toBe(n + 1);
  expect(historyLabels().at(-1)).toBe('Rename');
  await act(async () => { await h.run({ type: 'undo' }); });
  expect(h.doc()).toBe(before);
});

it('Import folder makes the tree as one entry and files each file into its folder', async () => {
  const batch = jest.fn(async () => []);
  useAssetStore.setState({ addAssetsBatch: batch as never });
  renderAssetsTab();
  const file = (rel: string): File => {
    const f = new File(['x'], rel.replace(/^.*\//, ''), { type: 'image/png' });
    Object.defineProperty(f, 'webkitRelativePath', { value: rel });
    return f;
  };
  const files = [file('Pack/logos/a.png'), file('Pack/b.png'), file('Pack/logos/c.png')];
  const input = (await screen.findByText('Import folder')).parentElement!.querySelector('input')!;
  const before = h.doc();
  const n = historyLabels().length;
  await act(async () => {
    fireEvent.change(input, { target: { files } });
    await engineIdle();
  });
  await waitFor(() => expect(batch).toHaveBeenCalledTimes(1));
  expect(historyLabels().length).toBe(n + 1);
  expect(historyLabels().at(-1)).toBe('New Folders');
  const pack = folderNamed('Pack')!;
  const logos = folderNamed('logos')!;
  expect(pack.parentId).toBeNull();
  expect(logos.parentId).toBe(pack.id);
  const items = (batch.mock.calls[0] as unknown as [Array<{ file: File; folderId: string | null }>])[0];
  expect(items.map((i) => [i.file.name, i.folderId])).toEqual([
    ['a.png', logos.id],
    ['b.png', pack.id],
    ['c.png', logos.id],
  ]);
  await act(async () => { await h.run({ type: 'undo' }); });
  expect(h.doc()).toBe(before);
});
