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
 *                          `atPlayhead` starts the clips at the playhead
 *                          (`setLayerTiming`) in the same entry.
 *   newCompFromFootageEdit New Comp from Footage: `createComposition{fromItems}`
 *                          sized, timed and paced to the clip (or the fresh
 *                          project's pristine comp configured instead, as
 *                          `createCompositionEdit` does) — one entry.
 *   newCompFromClipsEdit   New Composition from Clips: that comp for the first
 *                          clip, the others router-inserted into it, laid
 *                          end-to-end (`sequenceLayers`) — one entry.
 *   assembleShotsEdit      Assemble from Footage's edit: split at the cuts,
 *                          drop the runts, re-anchor, sequence — one entry.
 *
 * The tab and the selection after an insert are editor state, set here from
 * the command results. Importing a browser `File` (no path) stays with the
 * callers as a `B3-legacy` gap: the API imports by path only.
 */

import { FLICKS_PER_SECOND, type Command, type CompSettingsPatch, type LayerKind } from '@motion/engine-api';
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
import { getTime as playheadSeconds } from '@stores/playbackClockStore';
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

/** Read every SVG's markup up front (the build cannot await); an unreadable one is skipped with a notice. */
async function prepareMedia(assets: readonly ImportedAsset[]): Promise<PreparedMedia[]> {
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
  return prepared;
}

interface BuiltMedia {
  built: BuiltLayers;
  /** Per asset, in order: the scratch id of the layer the router left selected for it. */
  placed: string[];
}

/**
 * Run the media router off-document into `comp` (which must be the active
 * composition: the router fits against it). Throws when the build is not a
 * pure insert (`buildLayerFragment`). Null when nothing was built.
 */
function buildMedia(comp: string, prepared: readonly PreparedMedia[], at?: { x: number; y: number }): BuiltMedia | null {
  const unreadable: string[] = [];
  const placed: string[] = [];
  const built = buildLayerFragment(comp, () => {
    for (const { asset, svg } of prepared) {
      if (svg !== null) {
        const size = Math.max(asset.metadata?.width ?? 0, asset.metadata?.height ?? 0) || undefined;
        if (!insertSvgDocument(svg, asset.name, { sizeHint: size })) unreadable.push(asset.name);
      } else {
        // Synchronous for every non-SVG asset (see insertMediaEdit): the node exists when
        // this returns, inside the scratch run.
        void insertMedia(asset);
      }
      // Every router insert selects what it created — the per-asset id (a failed insert
      // leaves the previous selection, which the scratch map below drops).
      const sel = useSelectionStore.getState().ids[0];
      if (sel && !placed.includes(sel)) placed.push(sel);
    }
    const last = useSelectionStore.getState().ids[0];
    if (at && last) setNodeWorldPosition(last, at.x, at.y);
  });
  for (const name of unreadable) notifyUnreadable(name);
  return built ? { built, placed } : null;
}

/** The one `pasteLayers` that lands a build. */
function pasteOf(comp: string, built: BuiltLayers): Command {
  return {
    type: 'pasteLayers',
    comp,
    fragment: built.fragment,
    index: built.index,
    ...(built.parent ? { parent: built.parent } : {}),
  } as Command;
}

/** Scratch ids → the pasted layers' ids (pasteLayers returns them in fragment order). */
function mapScratch(built: BuiltLayers, ids: readonly string[], scratch: readonly string[]): string[] {
  const map = new Map(built.scratchIds.map((s, i) => [s, ids[i]]));
  return scratch.map((s) => map.get(s)).filter((x): x is string => !!x);
}

export interface MediaInsertOptions {
  /** The undo entry's name (default "Insert <name>" / "Insert N Layers"). */
  label?: string;
  /** Land the inserted layer that ends up selected here, in comp pixels (a canvas drop). */
  at?: { x: number; y: number };
  /**
   * Start every inserted clip AT THE PLAYHEAD instead of frame 0 (AE's
   * drag-to-timeline; "Add at Playhead"), in the same entry. The playhead is
   * read when the call is made — before the SVG reads and the engine round
   * trips — so the clip lands where the playhead was when the user acted,
   * even with the transport running.
   */
  atPlayhead?: boolean;
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
  // Captured before the first await (see `atPlayhead`).
  const startAt = opts.atPlayhead ? playheadSeconds() : null;
  const prepared = await prepareMedia(assets);
  if (prepared.length === 0) return [];
  const label = opts.label ?? (prepared.length === 1 ? `Insert ${prepared[0]!.asset.name}` : `Insert ${prepared.length} Layers`);
  const comp = activeCompRootId();
  let media: BuiltMedia | null;
  try {
    media = buildMedia(comp, prepared, opts.at);
  } catch (err) {
    reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!media) return [];
  const { built } = media;
  const paste = pasteOf(comp, built);

  // The commands that need the new ids: the playhead start (every top-level
  // layer the insert made — one per asset), then the caller's own.
  const follow = startAt === null && !opts.follow
    ? null
    : (selected: readonly string[], layers: readonly string[]): Command[] => {
      const out: Command[] = [];
      if (startAt !== null) {
        const tops = mapScratch(built, layers, built.tops);
        if (tops.length > 0) {
          out.push({ type: 'setLayerTiming', items: tops.map((layer) => ({ layer, startTime: compTime(startAt) })) });
        }
      }
      if (opts.follow) out.push(...opts.follow(selected, layers));
      return out;
    };

  const client = engine();
  let ids: string[] = [];
  if (!follow) {
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
      const more = follow(selectedOf(built, ids), ids);
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
  return mapScratch(built, ids, built.selected.length > 0 ? built.selected : built.tops);
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

type EngineError = Parameters<typeof reportEngineError>[1];
type Client = ReturnType<typeof engine>;

/**
 * Inside an open gesture: the composition that IS `asset` with the clip in it
 * — `createComposition{fromItems}`, or the fresh project's pristine comp
 * configured (`setCompositionSettings` + `createLayer`). `created` is false
 * for the adopted comp (it existed before).
 */
async function createFootageComp(
  client: Client,
  label: string,
  asset: ImportedAsset,
): Promise<{ comp: string; layer: string; name: string; created: boolean } | { error: EngineError }> {
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
    if (!res.ok) return { error: res.error };
    comp = adopt;
    layer = (res.value[1] as { layer?: string } | undefined)?.layer;
  } else {
    const res = await client.execute({ type: 'createComposition', settings: patch, fromItems: [asset.id] });
    if (!res.ok) return { error: res.error };
    comp = (res.value as { item: string }).item;
    layer = layerIdsOfComp(comp)[0];
  }
  if (!layer) return { error: { code: 'internal', message: 'the footage layer was not created' } };
  return { comp, layer, name: s.name, created: !adopt };
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
  const fail = async (error?: EngineError): Promise<null> => {
    if (error) reportEngineError(label, error);
    const closed = await client.endGesture(opened.value.gesture, false);
    if (!closed.ok) reportEngineError(label, closed.error);
    return null;
  };

  const made = await createFootageComp(client, label, asset);
  if ('error' in made) return fail(made.error);
  const { comp, layer } = made;

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
  useProjectStore.getState().actions.openTab(comp, [comp], made.name);
  useSelectionStore.getState().set([layer]);
  return { comp, layer };
}

// ── New Composition from Clips ────────────────────────────────────────

export interface CompFromClipsResult {
  comp: string;
  /** The clips' layers, in the order they were sequenced (the assets' order). */
  layers: string[];
  /** Whether the layers were laid end-to-end (false for a single clip). */
  sequenced: boolean;
  /** Frames of overlap applied, 0 when butted together. */
  overlapFrames: number;
}

/**
 * New Composition from Selected Clips as ONE undo entry: the comp conformed
 * to the FIRST clip (New Comp from Footage, pristine adoption included), the
 * other clips inserted into it by the media router (contain-fit, PAR, SVG
 * routing — built off-document, one `pasteLayers`), all of them laid
 * end-to-end in the assets' order (`sequenceLayers`; `overlapFrames` > 0
 * overlaps each pair by that many frames of the comp's rate and cross-dissolves
 * opacity across it), and the comp's duration set to where the last clip ends.
 *
 * The router fits against the ACTIVE composition, so the new comp's tab opens
 * before the other clips are built (it opens on success anyway; on a failure
 * the tab is closed again and the previous one re-activated). Selects the
 * clips. Resolves to the result, or null when nothing was made (toasted).
 */
export async function newCompFromClipsEdit(
  assets: readonly ImportedAsset[],
  overlapFrames = 0,
): Promise<CompFromClipsResult | null> {
  const first = assets[0];
  if (!first) return null;
  const label = 'New Composition from Clips';
  const rest = await prepareMedia(assets.slice(1));
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  const prevTab = useProjectStore.getState().activeTabId;
  let openedTab: string | null = null;
  const fail = async (error?: EngineError): Promise<null> => {
    if (error) reportEngineError(label, error);
    const closed = await client.endGesture(opened.value.gesture, false);
    if (!closed.ok) reportEngineError(label, closed.error);
    const actions = useProjectStore.getState().actions;
    if (openedTab) actions.closeTab(openedTab);
    if (prevTab) actions.setActiveTab(prevTab);
    return null;
  };

  const made = await createFootageComp(client, label, first);
  if ('error' in made) return fail(made.error);
  const { comp } = made;
  const layers = [made.layer];

  const hadTab = Object.values(useProjectStore.getState().tabs).some((t) => t.compositionId === comp);
  const tabId = useProjectStore.getState().actions.openTab(comp, [comp], made.name);
  if (!hadTab) openedTab = tabId;

  if (rest.length > 0) {
    let media: BuiltMedia | null;
    try {
      media = buildMedia(comp, rest);
    } catch (err) {
      return fail({ code: 'internal', message: err instanceof Error ? err.message : String(err) });
    }
    if (media) {
      const res = await client.execute(pasteOf(comp, media.built));
      if (!res.ok) return fail(res.error);
      const ids = (res.value as { layers?: string[] }).layers ?? [];
      for (const id of mapScratch(media.built, ids, media.placed)) if (!layers.includes(id)) layers.push(id);
    }
  }

  const fps = footageCompSettings(first).fps;
  const overlap = Math.max(0, Math.round(overlapFrames));
  const sequenced = layers.length >= 2;
  if (sequenced) {
    const res = await client.batch(label, [
      { type: 'sequenceLayers', layers, overlap: compTime(overlap / fps), crossfade: overlap > 0 },
    ]);
    if (!res.ok) return fail(res.error);
  }
  // The comp is the assembly's length — measured off the laid-out layers, not
  // re-derived from clip durations and the overlap.
  const q = await client.query({ type: 'getLayers', layers });
  if (!q.ok) return fail(q.error);
  const end = Math.max(0, ...q.value.layers.map((l) => l.timing.outPoint));
  if (end > 0) {
    const res = await client.batch(label, [{ type: 'setCompositionSettings', comp, patch: { duration: end } }]);
    if (!res.ok) return fail(res.error);
  }
  const closed = await client.endGesture(opened.value.gesture, true);
  if (!closed.ok) {
    reportEngineError(label, closed.error);
    return null;
  }
  useSelectionStore.getState().set(layers);
  return { comp, layers, sequenced, overlapFrames: overlap };
}

// ── Assemble from Footage ─────────────────────────────────────────────

export interface AssemblyPlan {
  /** The cuts, in comp seconds (any order). */
  cutsCompSec: readonly number[];
  /** The composition's frame rate (what the frame counts below are in). */
  fps: number;
  /** Frames of cross-dissolve on each cut. 0 butts the shots together. */
  dissolveFrames: number;
  /** Shots shorter than this many frames are removed. 0 keeps every shot. */
  minShotFrames: number;
}

export interface AssemblyResult {
  /** The shots' layers left in the comp, in time order. */
  shots: string[];
  /** Shots removed for being shorter than `minShotFrames`. */
  dropped: number;
  /** Whether the shots were re-laid (false when fewer than two remain). */
  sequenced: boolean;
}

/**
 * The mutating half of Assemble from Footage (`applyAssembly`'s rules) as ONE
 * undo entry: split `layer` at every cut (`splitLayers`, ascending, each cut
 * applied to whichever shot covers it — after the first split that is the
 * previous right half), drop the shots shorter than `minShotFrames`
 * (`deleteLayers`; never every shot), put the first survivor back on the
 * master's start (`moveLayersInTime`), and lay the shots end-to-end with the
 * dissolve (`sequenceLayers{crossfade}`). Selects the shots. Resolves to the
 * report, or null when the engine refused (toasted).
 */
export async function assembleShotsEdit(layer: string, plan: AssemblyPlan): Promise<AssemblyResult | null> {
  const label = 'Assemble from Footage';
  const fps = plan.fps > 0 ? plan.fps : DEFAULT_COMPOSITION.fps;
  const frames = (flicks: number): number => Math.round((flicks * fps) / FLICKS_PER_SECOND);
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  const fail = async (error: EngineError): Promise<null> => {
    reportEngineError(label, error);
    const closed = await client.endGesture(opened.value.gesture, false);
    if (!closed.ok) reportEngineError(label, closed.error);
    return null;
  };
  const timings = async (ids: readonly string[]) => {
    const q = await client.query({ type: 'getLayers', layers: [...ids] });
    return q.ok ? { ok: true as const, byId: new Map(q.value.layers.map((l) => [l.id, l.timing])) } : q;
  };

  // Where the master sits NOW: the assembly ends up starting here whatever the drop pass removes.
  const master = await timings([layer]);
  if (!master.ok) return fail(master.error);
  const anchor = master.byId.get(layer)?.inPoint ?? 0;

  // ── Split (a cut no shot straddles is left alone) ─────────────────
  const shots = [layer];
  let current = layer;
  for (const sec of [...plan.cutsCompSec].sort((a, b) => a - b)) {
    const res = await client.execute({ type: 'splitLayers', layers: [current], time: compTime(Math.round(sec * fps) / fps) });
    if (!res.ok) return fail(res.error);
    const right = (res.value as { layers?: string[] }).layers?.[0];
    if (!right) continue;
    shots.push(right);
    current = right;
  }

  // ── Drop the runts (measured before any deletion; never everything) ─
  const minKeep = Math.max(0, Math.round(plan.minShotFrames));
  let dropped = 0;
  if (minKeep > 0) {
    const t = await timings(shots);
    if (!t.ok) return fail(t.error);
    const length = (id: string): number => {
      const g = t.byId.get(id);
      return g ? frames(g.outPoint - g.inPoint) : 0;
    };
    const runts = shots.filter((id) => length(id) < minKeep);
    if (runts.length > 0 && runts.length < shots.length) {
      const res = await client.execute({ type: 'deleteLayers', layers: runts });
      if (!res.ok) return fail(res.error);
      dropped = runts.length;
      for (const id of runts) shots.splice(shots.indexOf(id), 1);
    }
  }

  // ── Re-anchor (also the one-survivor case sequencing refuses) ─────
  const head = await timings([shots[0]!]);
  if (!head.ok) return fail(head.error);
  const headIn = head.byId.get(shots[0]!)?.inPoint ?? anchor;
  if (frames(headIn) !== frames(anchor)) {
    const res = await client.execute({ type: 'moveLayersInTime', layers: [shots[0]!], delta: anchor - headIn, ripple: false });
    if (!res.ok) return fail(res.error);
  }

  // ── Sequence (with a dissolve it writes the ramps; without, it closes the gaps) ─
  const overlap = Math.max(0, Math.round(plan.dissolveFrames));
  const sequenced = shots.length >= 2;
  if (sequenced) {
    const res = await client.execute({ type: 'sequenceLayers', layers: shots, overlap: compTime(overlap / fps), crossfade: overlap > 0 });
    if (!res.ok) return fail(res.error);
  }

  const closed = await client.endGesture(opened.value.gesture, true);
  if (!closed.ok) {
    reportEngineError(label, closed.error);
    return null;
  }
  useSelectionStore.getState().set(shots);
  return { shots, dropped, sequenced };
}
