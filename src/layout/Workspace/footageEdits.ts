/**
 * Footage into the document through the engine API (B3, docs/B3_PATTERNS.md):
 * the viewport's file / Assets drops, the empty-comp start card and the Source
 * Monitor's verbs. One user action = one undo entry.
 *
 *   insertMediaEdit        the media insert router (`insertMedia`: contain-fit,
 *                          PAR, SVG routing, audio layers) run OFF-document
 *                          (ENGINE_API.md §15.9) and sent as ONE `pasteLayers`;
 *                          with `follow`, the commands that need the new ids
 *                          (a source range, overwrite trims) join it inside one
 *                          engine gesture.
 *   newCompFromFootageEdit New Comp from Footage: `createComposition{fromItems}`
 *                          sized, timed and paced to the clip (or the fresh
 *                          project's pristine comp configured instead, as
 *                          `createCompositionEdit` does) — one entry.
 *
 * The tab and the selection after an insert are editor state, set here from
 * the command results. Importing a browser `File` (no path) stays with the
 * callers as a `B3-legacy` gap: the API imports by path only.
 */

import type { Command, CompSettingsPatch, LayerKind } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { reportEngineError } from '@core/engine/uiEdits';
import { buildLayerFragment, type BuiltLayers } from '@core/engine/offDocument';
import { layerIdsOfComp } from '@core/engine/doc';
import { compTime } from '@core/engine/propRefs';
import { insertMedia, insertSvgDocument, setNodeWorldPosition } from '@core/scene/sceneInsert';
import { activeCompRootId } from '@core/scene/activeComp';
import { pristineCompToAdopt } from '@core/composition/compositionOps';
import { rateOf } from '@layout/Composition/compositionEdits';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import type { ImportedAsset } from '@stores/assetStore';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';

// ── Media insert ──────────────────────────────────────────────────────

/** `sceneInsert`'s SVG test: an image named `.svg` (an object URL carries no mime type). */
function isSvgAsset(asset: ImportedAsset): boolean {
  return asset.type === 'image' && /\.svg(\?|#|$)/i.test(asset.name);
}

/** An SVG asset's markup, or null when it cannot be read (the router's `readSvgText`). */
async function readSvgText(src: string): Promise<string | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes('<svg') ? text : null;
  } catch {
    return null;
  }
}

interface PreparedMedia {
  asset: ImportedAsset;
  /** The markup of an SVG asset (read BEFORE the synchronous off-document build). */
  svg: string | null;
}

function notifyUnreadable(name: string): void {
  useUIStore.getState().notify({ level: 'warning', message: `Could not read “${name}”.`, durationMs: 4000 });
}

export interface MediaInsertOptions {
  /** The undo entry's name (default "Insert <name>" / "Insert N Layers"). */
  label?: string;
  /** Land the inserted layer that ends up selected here, in comp pixels (a canvas drop). */
  at?: { x: number; y: number };
  /**
   * Commands that need the new layers' ids (a source range, overwrite trims):
   * computed after the paste and sent in the SAME entry (one engine gesture).
   * `selected` are the new ids the router selected, `layers` every new id.
   */
  follow?: (selected: readonly string[], layers: readonly string[]) => Command[];
}

/**
 * Insert media assets (existing project items) into the active composition as
 * ONE undo entry, and select what the router selected (the last asset's
 * layer). Resolves to the new layer ids (`[]` when nothing was inserted), or
 * null when the engine refused (toasted).
 *
 * The router runs off-document, which must be synchronous: an SVG's markup is
 * read first, and `insertMedia` builds every other kind before its first
 * `await` (it awaits only to read SVG markup). An SVG whose markup cannot be
 * read is skipped with a notice (the router used to fall back to a bitmap of
 * the same unreadable source).
 */
export async function insertMediaEdit(
  assets: readonly ImportedAsset[],
  opts: MediaInsertOptions = {},
): Promise<string[] | null> {
  const prepared: PreparedMedia[] = [];
  for (const asset of assets) {
    if (!isSvgAsset(asset)) {
      prepared.push({ asset, svg: null });
      continue;
    }
    const svg = await readSvgText(asset.src);
    if (svg) prepared.push({ asset, svg });
    else notifyUnreadable(asset.name);
  }
  if (prepared.length === 0) return [];
  const label = opts.label ?? (prepared.length === 1 ? `Insert ${prepared[0]!.asset.name}` : `Insert ${prepared.length} Layers`);
  const comp = activeCompRootId();
  const unreadable: string[] = [];
  const at = opts.at;
  let built: BuiltLayers | null;
  try {
    built = buildLayerFragment(comp, () => {
      for (const { asset, svg } of prepared) {
        if (svg !== null) {
          const size = Math.max(asset.metadata?.width ?? 0, asset.metadata?.height ?? 0) || undefined;
          if (!insertSvgDocument(svg, asset.name, { sizeHint: size })) unreadable.push(asset.name);
        } else {
          // Synchronous for every non-SVG asset (see the doc comment): the node exists when
          // this returns, inside the scratch run.
          void insertMedia(asset);
        }
      }
      const placed = useSelectionStore.getState().ids[0];
      if (at && placed) setNodeWorldPosition(placed, at.x, at.y);
    });
  } catch (err) {
    reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  for (const name of unreadable) notifyUnreadable(name);
  if (!built) return [];
  const paste = {
    type: 'pasteLayers',
    comp,
    fragment: built.fragment,
    index: built.index,
    ...(built.parent ? { parent: built.parent } : {}),
  } as Command;

  const client = engine();
  let ids: string[] = [];
  if (!opts.follow) {
    const res = await client.batch(label, [paste]);
    if (!res.ok) {
      reportEngineError(label, res.error);
      return null;
    }
    ids = (res.value[0] as { layers?: string[] } | undefined)?.layers ?? [];
  } else {
    const opened = await client.beginGesture(label);
    if (!opened.ok) {
      reportEngineError(label, opened.error);
      return null;
    }
    let ok = true;
    const res = await client.execute(paste);
    if (!res.ok) {
      reportEngineError(label, res.error);
      ok = false;
    } else {
      ids = (res.value as { layers?: string[] }).layers ?? [];
      const more = opts.follow(selectedOf(built, ids), ids);
      if (more.length > 0) {
        const r = await client.batch(label, more);
        if (!r.ok) {
          reportEngineError(label, r.error);
          ok = false;
        }
      }
    }
    const closed = await client.endGesture(opened.value.gesture, ok);
    if (!closed.ok) reportEngineError(label, closed.error);
    if (!ok) return null;
  }
  const sel = selectedOf(built, ids);
  if (sel.length > 0) useSelectionStore.getState().set(sel);
  return ids;
}

/** The new ids of the layers the builder left selected (else its top layers). */
function selectedOf(built: BuiltLayers, ids: readonly string[]): string[] {
  const map = new Map(built.scratchIds.map((s, i) => [s, ids[i]]));
  return (built.selected.length > 0 ? built.selected : built.tops)
    .map((s) => map.get(s))
    .filter((x): x is string => !!x);
}

// ── New Comp from Footage ─────────────────────────────────────────────

export interface FootageCompSettings {
  name: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
}

/**
 * A composition that IS the clip (`createCompositionFromFootage`'s rules):
 * size = stored pixels × pixel aspect, the clip's duration, the PROBED rate;
 * what the file does not say falls back to the APP defaults (never the active
 * comp's), and the name is the file's without its extension.
 */
export function footageCompSettings(asset: ImportedAsset): FootageCompSettings {
  const meta = asset.metadata ?? {};
  const par = asset.interpret?.par ?? 1;
  const d = DEFAULT_COMPOSITION;
  return {
    name: asset.name.replace(/\.[a-z0-9]+$/i, '') || asset.name,
    width: meta.width && meta.width > 0 ? Math.round(meta.width * par) : d.width,
    height: meta.height && meta.height > 0 ? meta.height : d.height,
    fps: meta.fps && meta.fps > 0 ? meta.fps : d.fps,
    durationSeconds: meta.duration && meta.duration > 0 ? meta.duration : d.durationSeconds,
  };
}

function layerKindOf(asset: ImportedAsset): LayerKind {
  return asset.type === 'audio' ? 'audio' : asset.type === 'video' ? 'video' : 'image';
}

export interface FootageCompOptions {
  /** The undo entry's name (default "New Comp from Footage"). */
  label?: string;
  /** Commands for the new layer / comp in the same entry (their ids exist only after the create). */
  follow?: (layer: string, comp: string) => Command[];
}

/**
 * New Comp from Footage (an existing project item) as ONE undo entry:
 * `createComposition{fromItems}` conformed to the clip — or, in a fresh
 * project, the pristine comp configured to it
 * (`setCompositionSettings` + `createLayer`; undo restores it pristine). The
 * clip lands at full frame (a native-size layer centred in a comp of its own
 * size is exactly the contain-fit). Opens the comp's tab and selects the
 * layer. Resolves to the comp and layer, or null (the engine's refusal is
 * toasted).
 */
export async function newCompFromFootageEdit(
  asset: ImportedAsset,
  opts: FootageCompOptions = {},
): Promise<{ comp: string; layer: string } | null> {
  const label = opts.label ?? 'New Comp from Footage';
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  const fail = async (error?: Parameters<typeof reportEngineError>[1]): Promise<null> => {
    if (error) reportEngineError(label, error);
    const closed = await client.endGesture(opened.value.gesture, false);
    if (!closed.ok) reportEngineError(label, closed.error);
    return null;
  };

  const s = footageCompSettings(asset);
  const patch: CompSettingsPatch = {
    name: s.name,
    width: s.width,
    height: s.height,
    frameRate: rateOf(s.fps),
    duration: compTime(s.durationSeconds),
  };
  let comp: string;
  let layer: string | undefined;
  const adopt = pristineCompToAdopt();
  if (adopt) {
    const res = await client.batch(label, [
      { type: 'setCompositionSettings', comp: adopt, patch },
      { type: 'createLayer', comp: adopt, kind: layerKindOf(asset), source: asset.id, init: [] },
    ]);
    if (!res.ok) return fail(res.error);
    comp = adopt;
    layer = (res.value[1] as { layer?: string } | undefined)?.layer;
  } else {
    const res = await client.execute({ type: 'createComposition', settings: patch, fromItems: [asset.id] });
    if (!res.ok) return fail(res.error);
    comp = (res.value as { item: string }).item;
    layer = layerIdsOfComp(comp)[0];
  }
  if (!layer) return fail({ code: 'internal', message: 'the footage layer was not created' });

  const more = opts.follow?.(layer, comp) ?? [];
  if (more.length > 0) {
    const res = await client.batch(label, more);
    if (!res.ok) return fail(res.error);
  }
  const closed = await client.endGesture(opened.value.gesture, true);
  if (!closed.ok) {
    reportEngineError(label, closed.error);
    return null;
  }
  useProjectStore.getState().actions.openTab(comp, [comp], s.name);
  useSelectionStore.getState().set([layer]);
  return { comp, layer };
}
