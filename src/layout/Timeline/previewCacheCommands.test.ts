/**
 * The preview-cache commands against what the ENGINE can do.
 *
 * The engine's frame cache can be emptied and filled (`play { cacheOnly }`),
 * and it has no disk tier. The thing worth pinning is that the commands do
 * exactly what the engine offers: "Cache Work Area Now" is one engine request,
 * never a page-side job, and a purge of a tier that does not exist sends nothing.
 */

const mockExecute = jest.fn();

jest.mock('@core/engine/engineInstance', () => ({
  engine: () => ({ execute: mockExecute }),
}));

// A work area with 3 of its 10 frames in the engine's cache.
jest.mock('./previewCacheStats', () => ({
  ...jest.requireActual<typeof import('./previewCacheStats')>('./previewCacheStats'),
  previewCacheStats: () => ({ cached: 3, total: 10, workArea: true, ramMb: 12, diskMb: null }),
}));

import { useUIStore } from '@stores/uiStore';
import {
  buildPreviewCacheCommands,
  canCacheWorkArea,
  hasEngineDiskCache,
  PREVIEW_CACHE_WORK_AREA_COMMAND,
  PREVIEW_PURGE_DISK_COMMAND,
  PREVIEW_PURGE_RAM_COMMAND,
  purgeDiskCache,
  purgeRamPreview,
} from './previewCacheCommands';

function command(id: string) {
  const found = buildPreviewCacheCommands().find((c) => c.id === id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
}

beforeEach(() => {
  mockExecute.mockReset();
  mockExecute.mockResolvedValue({ ok: true, value: {} });
});

describe('Cache Work Area Now', () => {
  it('is enabled while the span has frames to cache', () => {
    expect(canCacheWorkArea()).toBe(true);
    expect(command(PREVIEW_CACHE_WORK_AREA_COMMAND).enabled?.()).toBe(true);
  });

  it('asks the engine for a cache-only fill of the work area, and starts no page job', () => {
    const jobsBefore = useUIStore.getState().jobs;
    void command(PREVIEW_CACHE_WORK_AREA_COMMAND).execute({} as never);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith({
      type: 'play', rate: 1, range: 'workArea', audio: false, cacheFirst: true, cacheOnly: true,
    });
    expect(useUIStore.getState().jobs).toBe(jobsBefore);
  });
});

describe('Purge RAM Preview', () => {
  it('empties the engine frame cache', async () => {
    const cmd = command(PREVIEW_PURGE_RAM_COMMAND);
    // Always available: the size readout can be stale, the purge is harmless.
    expect(cmd.enabled?.() ?? true).toBe(true);
    purgeRamPreview();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith({ type: 'purgeCache', kind: 'ram' });
    await Promise.resolve();
  });
});

describe('Purge Disk Cache', () => {
  it('is disabled and sends nothing while the engine reports no disk tier', () => {
    expect(hasEngineDiskCache()).toBe(false);
    expect(command(PREVIEW_PURGE_DISK_COMMAND).enabled?.()).toBe(false);
    purgeDiskCache();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
