/**
 * The three preview-cache actions, as first-class COMMANDS.
 *
 * Registered from this module rather than from the app's boot block, the same
 * way `timelineFitCommands` does it: the handlers, the ids and the shortcut
 * re-scan ship as one unit, so nothing else has to be edited to add or remove
 * them. Registration is idempotent (the registry replaces by id).
 *
 * ## Why three and not one
 *
 * Emptying MEMORY costs a re-promotion from the disk tier — seconds, and only
 * for what is on screen. Emptying DISK throws away every rendered frame the
 * machine holds, including the parked generations an undo would have come back
 * to, and re-earning that is minutes of rendering. A single "Purge Cache"
 * makes anyone who wanted to reclaim a little memory pay the whole bill, which
 * is why the settings dialog already splits them; these are the same two
 * actions, reachable from where the cache is actually visible.
 *
 * ## Why caching is a REQUEST
 *
 * The pump that renders frames into the cache lives inside `useWorkspace`'s
 * viewport effect and cannot be called from out here — see `cacheRequestStore`.
 * "Cache Work Area" therefore asks; the pump keeps every safety decision
 * (playing, exporting, hidden tab, span already full) where it already is.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { viewportFrameCache } from '@core/rendering/frameCache';
import { activeViewportDiskCache } from '@core/rendering/frameDiskCache';
import { requestPreviewCache } from '@stores/cacheRequestStore';
import { useUIStore } from '@stores/uiStore';
import { formatCacheMb, previewCacheStats } from './previewCacheStats';

export const PREVIEW_CACHE_WORK_AREA_COMMAND = asCommandId('preview.cacheWorkArea');
export const PREVIEW_PURGE_RAM_COMMAND = asCommandId('preview.purgeRam');
export const PREVIEW_PURGE_DISK_COMMAND = asCommandId('preview.purgeDisk');

/**
 * Confirm-less feedback. None of the three needs a dialog: caching is additive,
 * and both purges cost render time rather than user data — a modal in front of
 * them would be more expensive than the mistake it prevents.
 */
function toast(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 3200 });
}

export function cacheWorkAreaNow(): void {
  const stats = previewCacheStats();
  if (stats.total === 0) {
    toast('Nothing to cache — this composition has no frames', 'warning');
    return;
  }
  if (stats.cached >= stats.total) {
    toast(
      stats.workArea ? 'Work area is already cached' : 'Composition is already cached',
      'info',
    );
    return;
  }
  requestPreviewCache();
  const missing = stats.total - stats.cached;
  toast(
    `Caching ${missing} frame${missing === 1 ? '' : 's'} of the ${stats.workArea ? 'work area' : 'composition'}…`,
    'info',
  );
}

export function purgeRamPreview(): void {
  const held = viewportFrameCache.totalBytesHeld / (1024 * 1024);
  if (held <= 0) {
    toast('RAM preview is already empty', 'info');
    return;
  }
  // Memory only. The disk tier keeps everything, so frames come straight back
  // as the playhead reaches them.
  viewportFrameCache.clear();
  toast(`Purged ${formatCacheMb(held)} from the RAM preview`, 'success');
}

export function purgeDiskCache(): void {
  const disk = activeViewportDiskCache();
  if (!disk) {
    toast('No disk cache in this environment', 'warning');
    return;
  }
  const held = disk.totalBytes / (1024 * 1024);
  void disk.purge().then(() => {
    // RAM too: leaving it behind would show a green bar over frames the disk
    // tier can no longer back, and the first eviction would silently lose them.
    viewportFrameCache.clear();
    toast(`Purged ${formatCacheMb(held)} of disk cache`, 'success');
  });
}

export function buildPreviewCacheCommands(): ReadonlyArray<Command> {
  return [
    {
      id: PREVIEW_CACHE_WORK_AREA_COMMAND,
      label: 'Cache Work Area Now',
      description:
        'Pre-render the work area (or the whole composition when none is set) into the RAM preview.',
      icon: 'refresh',
      execute: () => {
        cacheWorkAreaNow();
      },
    },
    {
      id: PREVIEW_PURGE_RAM_COMMAND,
      label: 'Purge RAM Preview',
      description: 'Empty the memory tier of the preview cache. The disk tier keeps its frames.',
      icon: 'trash',
      enabled: () => viewportFrameCache.totalBytesHeld > 0,
      execute: () => {
        purgeRamPreview();
      },
    },
    {
      id: PREVIEW_PURGE_DISK_COMMAND,
      label: 'Purge Disk Cache',
      description: 'Empty the disk tier — every rendered frame the machine holds, parked states included.',
      icon: 'trash',
      enabled: () => activeViewportDiskCache() !== null,
      execute: () => {
        purgeDiskCache();
      },
    },
  ];
}

let installed = false;

/** Register all three. Safe to call repeatedly; the first call does the work. */
export function installPreviewCacheCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildPreviewCacheCommands()) registry.register(command);
  // Bindings are a snapshot of the registry taken at boot, so a command
  // registered later is inert until the manager re-reads it. None of these
  // carry a chord today; the re-scan keeps that free to change.
  getShortcutManager().rehydrateFromRegistry();
}

/** Test seam — forget that the commands were installed. */
export function resetPreviewCacheCommandsForTest(): void {
  installed = false;
}
