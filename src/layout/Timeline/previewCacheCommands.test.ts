/**
 * The preview-cache commands against what the ENGINE can do.
 *
 * The engine's frame cache can be emptied and cannot be asked to pre-render,
 * and it has no disk tier. The thing worth pinning is that the commands say
 * so: a "Cache Work Area Now" that is enabled and starts a job nothing will
 * ever finish is the failure this file exists to prevent coming back.
 */

const mockExecute = jest.fn();

jest.mock('@core/engine/engineInstance', () => ({
  engine: () => ({ execute: mockExecute }),
}));

// A work area with 3 of its 10 frames in the engine's cache: the case in which
// the old command started a caching job.
jest.mock('./previewCacheStats', () => ({
  ...jest.requireActual<typeof import('./previewCacheStats')>('./previewCacheStats'),
  previewCacheStats: () => ({ cached: 3, total: 10, workArea: true, ramMb: 12, diskMb: null }),
}));

import { useUIStore } from '@stores/uiStore';
import {
  buildPreviewCacheCommands,
  CACHE_WORK_AREA_UNAVAILABLE,
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
  it('is disabled, and says why, while the engine has no pre-render', () => {
    expect(canCacheWorkArea()).toBe(false);
    const cmd = command(PREVIEW_CACHE_WORK_AREA_COMMAND);
    expect(cmd.enabled?.()).toBe(false);
    expect(cmd.description).toContain(CACHE_WORK_AREA_UNAVAILABLE);
  });

  it('starts no job and sends the engine nothing when it is run anyway — it says why', () => {
    const jobsBefore = useUIStore.getState().jobs;
    void command(PREVIEW_CACHE_WORK_AREA_COMMAND).execute({} as never);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(useUIStore.getState().jobs).toBe(jobsBefore);
    const said = useUIStore.getState().notifications.map((n) => n.message);
    expect(said.some((m) => m.includes('3 / 10 frames cached') && m.includes(CACHE_WORK_AREA_UNAVAILABLE))).toBe(true);
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
