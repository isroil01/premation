/**
 * footageDedupe — one project item per file.
 *
 * Premiere's Media Browser and AE's Consolidate All Footage: a file the
 * project already holds is not imported a second time. Dragging the same clip
 * from the Media Browser three times places it three times from ONE item; it
 * does not leave three identical rows in the Project list. These are the pure
 * rules — which items are the same file, which one survives a merge — and the
 * edits in `assetEdits.ts` apply them.
 *
 * A file is known by its PATH. A file that arrived as bytes with no path (a
 * drop from a browser or an app that hands over no file) is known by its name
 * and exact byte size instead — the same name at the same size is the same
 * file far more often than not, and a merge is one undo away.
 */

import type { ItemInfo } from '@motion/engine-api';

/**
 * A path as a comparison key: one separator, no trailing slash, and folded to
 * lower case where the file system is case-insensitive (a Windows drive letter
 * or UNC share), so `C:\Footage\a.png` and `c:/footage/A.png` are one file.
 */
export function pathKey(p: string): string {
  const slashed = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const windows = /^[a-zA-Z]:\//.test(slashed) || slashed.startsWith('//');
  return windows ? slashed.toLowerCase() : slashed;
}

/** The key of a path-less file: its name and exact size. Null for an empty file (nothing to compare). */
export function bytesKey(name: string, size: number): string | null {
  return size > 0 ? `bytes:${name.trim().toLowerCase()}:${size}` : null;
}

type FootageFacts = Pick<ItemInfo, 'id' | 'kind' | 'name' | 'path' | 'missing' | 'mediaType' | 'fileBytes'>;

/**
 * What makes two items the same file, or null for an item never merged:
 * missing files (each may be relinked somewhere else), and anything but
 * picture and sound — a 3D model or a data file (LUT, JSON) is referenced from
 * properties as well as layers.
 */
export function identityKey(item: FootageFacts): string | null {
  if (item.kind !== 'footage' || item.missing) return null;
  if (item.mediaType !== 'image' && item.mediaType !== 'video' && item.mediaType !== 'audio') return null;
  return item.path ? pathKey(item.path) : bytesKey(item.name, item.fileBytes);
}

/** identity key → the id of the first item imported from that file (project order). */
export function footageByIdentity(items: Iterable<FootageFacts>): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    const key = identityKey(item);
    if (key && !out.has(key)) out.set(key, item.id);
  }
  return out;
}

/** One file imported more than once: the item that stays and the copies that go. */
export interface DuplicateGroup {
  key: string;
  keep: string;
  remove: string[];
}

/**
 * The items that are one file. The FIRST imported item is kept — it is the one
 * the oldest layers already name — and every later copy merges into it.
 */
export function duplicateFootage(items: Iterable<FootageFacts>): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const item of items) {
    const key = identityKey(item);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.remove.push(item.id);
    else groups.set(key, { key, keep: item.id, remove: [] });
  }
  return [...groups.values()].filter((g) => g.remove.length > 0);
}
