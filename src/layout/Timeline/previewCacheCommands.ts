/**
 * The three preview-cache actions, as first-class COMMANDS.
 *
 * Registered from this module rather than from the app's boot block, the same
 * way `timelineFitCommands` does it: the handlers, the ids and the shortcut
 * re-scan ship as one unit, so nothing else has to be edited to add or remove
 * them. Registration is idempotent (the registry replaces by id).
 *
 * ## The cache is the engine's
 *
 * The frames the viewport shows are drawn by `premation-engine`, and so is the
 * cache they come back from: a frame cache in VIDEO MEMORY, keyed by content,
 * filled by every exact frame the engine draws (playback, a scrub, a parked
 * playhead) and evicted least-recently-used at a budget the engine sizes from
 * the graphics adapter. There is no disk tier. What these commands can do is
 * what the engine API offers (`purgeCache`, `getCacheCoverage`):
 *
 *   Purge RAM Preview     `purgeCache { kind: 'ram' }` — empties that cache.
 *   Purge Disk Cache      `purgeCache { kind: 'disk' }` — nothing to empty
 *                         today; the command is enabled only when the engine
 *                         reports disk bytes, which it never does yet.
 *   Cache Work Area Now   the engine has NO command that pre-renders a span
 *                         into its cache, so this is disabled and says why. It
 *                         does not start a job that could never finish.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { engine } from '@core/engine/engineInstance';
import { useUIStore } from '@stores/uiStore';
import { engineCacheSnapshot } from './engineCacheCoverage';
import { formatCacheMb, previewCacheStats } from './previewCacheStats';

export const PREVIEW_CACHE_WORK_AREA_COMMAND = asCommandId('preview.cacheWorkArea');
export const PREVIEW_PURGE_RAM_COMMAND = asCommandId('preview.purgeRam');
export const PREVIEW_PURGE_DISK_COMMAND = asCommandId('preview.purgeDisk');

const MB = 1024 * 1024;

/**
 * Why "Cache Work Area Now" cannot run. One sentence, shown wherever the
 * action is offered (the command's description, the lane button's tooltip, the
 * menu row, the toast).
 */
export const CACHE_WORK_AREA_UNAVAILABLE =
  'The engine caches frames as it draws them and has no pre-render yet — play the work area once to fill the cache.';

/** Why "Purge Disk Cache" has nothing to do. */
export const DISK_CACHE_UNAVAILABLE = 'The engine keeps its preview cache in video memory — there is no disk cache.';

/**
 * Whether the engine can pre-render a span into its frame cache. It cannot:
 * the API has `purgeCache` and `setCacheBudget`, no fill. A function so the
 * button, the menu row and the command ask one place, and so the day the
 * engine grows the command there is one line to change.
 */
export function canCacheWorkArea(): boolean {
  return false;
}

/** Whether the engine reports a disk tier with something in it. */
export function hasEngineDiskCache(): boolean {
  return engineCacheSnapshot().diskBytes > 0;
}

/**
 * Confirm-less feedback. None of the three needs a dialog: both purges cost
 * render time rather than user data — a modal in front of them would be more
 * expensive than the mistake it prevents.
 */
function toast(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 3200 });
}

/**
 * "Cache Work Area Now". Says what is true: either the span is already in the
 * engine's cache, or it is not and the engine cannot be asked to fill it.
 * Callers that offer the action unconditionally (the Preview menu) reach this,
 * so it answers rather than failing silently.
 */
export function cacheWorkAreaNow(): void {
  const stats = previewCacheStats();
  if (stats.total === 0) {
    toast('Nothing to cache — this composition has no frames', 'warning');
    return;
  }
  if (stats.cached >= stats.total) {
    toast(stats.workArea ? 'Work area is already cached' : 'Composition is already cached', 'info');
    return;
  }
  if (!canCacheWorkArea()) {
    toast(`${stats.cached} / ${stats.total} frames cached. ${CACHE_WORK_AREA_UNAVAILABLE}`, 'warning');
  }
}

export function purgeRamPreview(): void {
  // The size is the last sample the cache bars took — it can be stale (nothing
  // polls with the timeline hidden), so the purge is sent whatever it says and
  // only the wording depends on it.
  const held = engineCacheSnapshot().ramBytes / MB;
  void engine().execute({ type: 'purgeCache', kind: 'ram' }).then((res) => {
    if (!res.ok) {
      toast(`Could not purge the preview cache: ${res.error.message}`, 'warning');
      return;
    }
    toast(held > 0 ? `Purged ${formatCacheMb(held)} from the preview cache` : 'Purged the preview cache', 'success');
  });
}

export function purgeDiskCache(): void {
  if (!hasEngineDiskCache()) {
    toast(DISK_CACHE_UNAVAILABLE, 'info');
    return;
  }
  const held = engineCacheSnapshot().diskBytes / MB;
  void engine().execute({ type: 'purgeCache', kind: 'disk' }).then((res) => {
    if (!res.ok) {
      toast(`Could not purge the disk cache: ${res.error.message}`, 'warning');
      return;
    }
    toast(`Purged ${formatCacheMb(held)} of disk cache`, 'success');
  });
}

export function buildPreviewCacheCommands(): ReadonlyArray<Command> {
  return [
    {
      id: PREVIEW_CACHE_WORK_AREA_COMMAND,
      label: 'Cache Work Area Now',
      description: canCacheWorkArea()
        ? 'Pre-render the work area (or the whole composition when none is set) into the preview cache.'
        : `Unavailable. ${CACHE_WORK_AREA_UNAVAILABLE}`,
      icon: 'refresh',
      enabled: canCacheWorkArea,
      execute: () => {
        cacheWorkAreaNow();
      },
    },
    {
      id: PREVIEW_PURGE_RAM_COMMAND,
      label: 'Purge RAM Preview',
      description: 'Empty the preview frame cache the engine holds in video memory. Frames are drawn again as the playhead reaches them.',
      icon: 'trash',
      execute: () => {
        purgeRamPreview();
      },
    },
    {
      id: PREVIEW_PURGE_DISK_COMMAND,
      label: 'Purge Disk Cache',
      description: `Empty the disk tier of the preview cache. ${DISK_CACHE_UNAVAILABLE}`,
      icon: 'trash',
      enabled: hasEngineDiskCache,
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
