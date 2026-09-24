/**
 * The Project/Assets panel's document edits through the engine API (B3,
 * docs/B3_PATTERNS.md): import by path, folders, rename, move, delete, tags
 * and Interpret Footage. Every function is ONE user action = ONE undo entry,
 * labelled as Edit ▸ Undo shows it.
 *
 * Items are document state (ENGINE_API.md §2.5 #12): the engine edits the
 * asset store's records and folders and records the inverse, so a delete, a
 * move or a rename is undoable — the legacy store actions were not. Removing
 * an item never deletes the file or the library copy (undo can bring it
 * back).
 *
 * What stays legacy (each call site says so with `B3-legacy`):
 *   • importing a browser `File` (the picker's <input>, an OS drop): the API
 *     imports by PATH, and Electron 44 exposes none for a `File`;
 *
 * Display reads stay direct until B4's mirror.
 */

import type { Command, InterpretationPatch } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { layersUsingItem } from '@core/engine/doc';
import { rateOf } from '@layout/Composition/compositionEdits';
import type { FootageInterpretation } from '@core/source/sourceInfo';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { LABEL_COLORS } from '@core/scene/labelColor';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function assetById(id: string): ImportedAsset | undefined {
  return useAssetStore.getState().assets.find((a) => a.id === id);
}

// ── Import (by path) ──────────────────────────────────────────────────

export interface ImportPathsResult {
  imported: ImportedAsset[];
  /** Paths that could not be read or decoded. */
  failed: string[];
}

/**
 * Import files by path into `folder` (null = project root). One entry,
 * "Import File(s)". The API's import is all-or-nothing; when a file in the set
 * fails, the rest are imported one by one inside one gesture so a single bad
 * file neither blocks the others nor splits the undo entry.
 */
export async function importPathsEdit(paths: readonly string[], folder: string | null = null): Promise<ImportPathsResult> {
  if (paths.length === 0) return { imported: [], failed: [] };
  const label = paths.length === 1 ? 'Import File' : `Import ${plural(paths.length, 'File')}`;
  const file = (path: string) => ({ path, asSequence: false, createComposition: false, ...(folder ? { folder } : {}) });
  const all = await edit(label, { type: 'importFiles', files: paths.map(file) }, { quiet: true });
  if (all.ok) {
    const ids = (all.value[0] as { items?: string[] } | undefined)?.items ?? [];
    return { imported: ids.map(assetById).filter((a): a is ImportedAsset => !!a), failed: [] };
  }
  if (paths.length === 1) return { imported: [], failed: [...paths] };

  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return { imported: [], failed: [...paths] };
  }
  const imported: ImportedAsset[] = [];
  const failed: string[] = [];
  for (const path of paths) {
    const res = await client.execute({ type: 'importFiles', files: [file(path)] });
    const id = res.ok ? (res.value as { items?: string[] }).items?.[0] : undefined;
    const asset = id ? assetById(id) : undefined;
    if (asset) imported.push(asset);
    else failed.push(path);
  }
  const closed = await client.endGesture(opened.value.gesture, imported.length > 0);
  if (!closed.ok) reportEngineError(label, closed.error);
  return { imported, failed };
}

// ── Folders ───────────────────────────────────────────────────────────

/** New Folder / New Subfolder. Returns the folder id, or null when refused. */
export async function createFolderEdit(name: string, parent: string | null = null): Promise<string | null> {
  const res = await edit('New Folder', { type: 'createFolder', name, ...(parent ? { parent } : {}) });
  return res.ok ? (res.value[0] as { item: string }).item : null;
}

/**
 * A folder TREE (Import Folder's structure) as one entry: each folder needs
 * its parent's id, which only the previous command's result carries, so the
 * commands run in order inside one engine gesture. `paths` are "A", "A/B"…,
 * parents before children; returns path → folder id.
 */
export async function createFolderTreeEdit(
  paths: readonly string[],
  root: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const label = paths.length === 1 ? 'New Folder' : 'New Folders';
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return out;
  }
  let ok = true;
  for (const path of paths) {
    const cut = path.lastIndexOf('/');
    const parent = cut < 0 ? root : out.get(path.slice(0, cut)) ?? root;
    const name = cut < 0 ? path : path.slice(cut + 1);
    const res = await client.execute({ type: 'createFolder', name, ...(parent ? { parent } : {}) });
    if (!res.ok) {
      reportEngineError(label, res.error);
      ok = false;
      break;
    }
    out.set(path, (res.value as { item: string }).item);
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  return ok ? out : new Map();
}

// ── Rename / move ─────────────────────────────────────────────────────

/** In-flight renames: Enter commits and the unmount's blur fires again. */
const pendingRename = new Map<string, string>();

function currentName(id: string): string | undefined {
  const s = useAssetStore.getState();
  return s.folders.find((f) => f.id === id)?.name ?? s.assets.find((a) => a.id === id)?.name;
}

/** Rename a folder or footage item. Blank or unchanged names are no-ops. */
export async function renameItemEdit(id: string, name: string): Promise<void> {
  const next = name.trim();
  if (!next || next === currentName(id) || pendingRename.get(id) === next) return;
  pendingRename.set(id, next);
  try {
    await edit('Rename', { type: 'renameItem', item: id, name: next });
  } finally {
    if (pendingRename.get(id) === next) pendingRename.delete(id);
  }
}

/** Move items into `folder` (null = project root). Items already there are skipped. */
export async function moveItemsEdit(ids: readonly string[], folder: string | null): Promise<void> {
  const s = useAssetStore.getState();
  const moving = ids.filter((id) => {
    if (id === folder) return false;
    const a = s.assets.find((x) => x.id === id);
    if (a) return (a.folderId ?? null) !== folder;
    const f = s.folders.find((x) => x.id === id);
    return !!f && (f.parentId ?? null) !== folder;
  });
  if (moving.length === 0) return;
  await edit(moving.length === 1 ? 'Move to Folder' : `Move ${plural(moving.length, 'Item')} to Folder`, {
    type: 'moveItems',
    items: moving,
    ...(folder ? { folder } : {}),
  });
}

// ── Delete ────────────────────────────────────────────────────────────

/** How many layers show any of `ids` — what a delete takes with it. */
export function layersUsingItems(ids: readonly string[]): number {
  const seen = new Set<string>();
  for (const id of ids) for (const l of layersUsingItem(id)) seen.add(l);
  return seen.size;
}

/**
 * Remove items from the project (AE: Delete in the Project panel). Layers that
 * use them go too — the caller's confirm names how many — and undo brings the
 * items and the layers back with the same ids. A removed folder takes its
 * contents with it.
 */
export async function removeItemsEdit(ids: readonly string[], label: string): Promise<boolean> {
  if (ids.length === 0) return false;
  const res = await edit(label, { type: 'removeItems', items: [...ids], removeUsingLayers: true });
  return res.ok;
}

// ── Tags ──────────────────────────────────────────────────────────────

/** Tags for several items as ONE entry; unchanged items are skipped. */
export async function setItemTagsEdit(changes: ReadonlyArray<{ id: string; tags: readonly string[] }>): Promise<void> {
  const cmds: Command[] = [];
  for (const c of changes) {
    const cur = assetById(c.id)?.tags ?? [];
    if (cur.length === c.tags.length && cur.every((t, i) => t === c.tags[i])) continue;
    cmds.push({ type: 'setItemTags', item: c.id, tags: [...c.tags] });
  }
  await edit('Edit Tags', cmds);
}

// ── Label ─────────────────────────────────────────────────────────────

/**
 * The Project panel's label menu: a LABEL_COLORS id (null = none) on several
 * items, ONE entry. The engine stores the id — the panel's own form (B3z).
 */
export async function setItemLabelEdit(ids: readonly string[], labelId: string | null): Promise<void> {
  const label = labelId === null ? 0 : LABEL_COLORS.findIndex((c) => c.id === labelId) + 1;
  if (ids.length === 0 || label < 0) return;
  await edit('Item Label', { type: 'setItemLabel', items: [...ids], label });
}

// ── Interpret Footage ─────────────────────────────────────────────────

/**
 * The API patch for the dialog's values against the item's current
 * interpretation — only the fields that change, so undo restores exactly
 * those. Null when nothing changes.
 */
export function interpretationPatchFor(asset: ImportedAsset, next: FootageInterpretation): InterpretationPatch | null {
  const cur = asset.interpret ?? {};
  const p: InterpretationPatch = {};
  if (next.conformFps !== cur.conformFps) {
    if (next.conformFps === undefined) p.clearConform = true;
    else p.conformFrameRate = rateOf(next.conformFps);
  }
  if (next.par !== undefined && next.par !== (cur.par ?? 1)) p.pixelAspect = next.par;
  if (next.alpha !== undefined && next.alpha !== (cur.alpha ?? 'straight')) p.alpha = next.alpha;
  if (next.loopCount !== undefined && next.loopCount !== (cur.loopCount ?? 1)) p.loops = next.loopCount;
  if ((next.fields ?? 'off') !== (cur.fields ?? 'off')) {
    p.fieldOrder = next.fields === 'upper' ? 'upperFirst' : next.fields === 'lower' ? 'lowerFirst' : 'progressive';
  }
  // Remove Pulldown (B3z): arm at a phase, or switch off.
  if ((next.pulldownPhase ?? undefined) !== (cur.pulldownPhase ?? undefined)) {
    if (next.pulldownPhase === undefined) p.clearRemovePulldown = true;
    else p.removePulldown = next.pulldownPhase;
  }
  return Object.keys(p).length > 0 ? p : null;
}

/** Interpret Footage ▸ OK. One entry; no entry when nothing changed. */
export async function interpretFootageEdit(asset: ImportedAsset, next: FootageInterpretation): Promise<boolean> {
  const patch = interpretationPatchFor(asset, next);
  if (!patch) return true;
  const res = await edit('Interpret Footage', { type: 'setInterpretation', items: [asset.id], patch });
  return res.ok;
}
