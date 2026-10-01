/**
 * EffectsPanelRows — the effects browser as a FLAT list of rows.
 *
 * The browser used to be an accordion of nested components, which meant every
 * effect in every open folder was mounted: ~90 built-ins, plus presets, shape
 * operators and whatever plugins add, each a `<button>` with a star, a tag and
 * a drag handler. Virtualising it needs one array instead of a tree — a folder
 * header is a row, a leaf is a row, and a shut folder simply contributes none.
 *
 * The flattening is pure and lives here so the panel keeps only the wiring:
 * what a search does to the folders, which rows a keyboard step may land on
 * (a header IS a stop — that is how you collapse it), and how tall each kind
 * of row is, are all answerable without standing React up.
 */

import type { IconName } from '@components/Icon';
import type { EffectDef } from '@core/inspector/effectCatalog';

/** Folder header height, and leaf height — the virtual list's row geometry. */
export const FX_FOLDER_ROW_H = 26;
export const FX_LEAF_ROW_H = 24;

/** A leaf, in the four flavours the browser lists. */
export type FxLeaf =
  | { kind: 'effect'; id: string; def: EffectDef; gpuTag: 'gpu' | 'no-webgpu' | null }
  | { kind: 'preset'; id: string; name: string; effectCount: number; userSaved: boolean }
  | { kind: 'shapeOp'; id: string; opType: string; label: string; taken: boolean }
  | { kind: 'sim'; id: 'cloner' | 'physics'; label: string; icon: IconName; on: boolean };

export interface FxGroup {
  /** Stable id — the category name, or `presets` / `Shape` / `Simulation`. */
  id: string;
  label: string;
  icon?: IconName;
  /** Open state when the user has not touched this folder. */
  defaultOpen: boolean;
  items: ReadonlyArray<FxLeaf>;
}

export type FxRow =
  | { kind: 'folder'; key: string; id: string; label: string; icon?: IconName; count: number; open: boolean }
  | ({ key: string; folder: string } & FxLeaf);

/**
 * Groups → rows. Empty groups are dropped (an "Effect Presets" folder with
 * nothing in it is a promise the panel cannot keep), and a shut folder
 * contributes its header only.
 */
export function flattenFxGroups(
  groups: ReadonlyArray<FxGroup>,
  isOpen: (group: FxGroup) => boolean,
): FxRow[] {
  const rows: FxRow[] = [];
  for (const g of groups) {
    if (g.items.length === 0) continue;
    const open = isOpen(g);
    rows.push({ kind: 'folder', key: `folder:${g.id}`, id: g.id, label: g.label, icon: g.icon, count: g.items.length, open });
    if (!open) continue;
    for (const item of g.items) rows.push({ ...item, key: `${g.id}:${item.id}`, folder: g.id });
  }
  return rows;
}

/** Row geometry for `VirtualList`'s `getItemHeight`. */
export function fxRowHeight(row: FxRow): number {
  return row.kind === 'folder' ? FX_FOLDER_ROW_H : FX_LEAF_ROW_H;
}

/**
 * Where an arrow key lands. Clamped rather than wrapping: a list that jumps
 * from the last row back to the first loses the user's place, and this one is
 * long enough that they would not see it happen.
 */
export function stepFxFocus(rowCount: number, from: number, delta: number): number {
  if (rowCount <= 0) return 0;
  return Math.min(rowCount - 1, Math.max(0, from + delta));
}

/** The row a click on a folder header toggles — `null` for a leaf. */
export function folderIdAt(rows: ReadonlyArray<FxRow>, index: number): string | null {
  const row = rows[index];
  return row && row.kind === 'folder' ? row.id : null;
}
