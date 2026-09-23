/**
 * Off-document builders (B3z) — compute a DocumentFragment with the legacy
 * layer builders, then send it as ONE `pasteLayers` command.
 *
 * Premation's inserts (a styled text preset, a Lottie import, a motion-graphics
 * rig, a camera with its settings, a caption track, a plugin layer…) are
 * client-side node-tree builders that predate the engine API. Their RESULT is a
 * set of new layers — exactly what a `copyLayers` fragment carries — so the
 * engine does not need a command per builder: the builder runs against a
 * scratch state of the document, the new layers are encoded as a fragment, the
 * document is restored EXACTLY (the parts machinery, state.ts), and the UI
 * sends `pasteLayers` — replayable in both engines, one undo entry, ids minted
 * by the engine.
 *
 * The scratch run is synchronous (no frame, no await between the build and the
 * restore) and guarded: it fails if the builder changed anything other than
 * adding layers to the target composition (a changed existing layer, a new
 * item, composition settings…) — such a builder is not an insert and its other
 * changes must be sent as their own commands.
 *
 * The ratchet (scripts/lint/engineWritesRule.mjs) treats the writer calls
 * lexically inside the callback of `buildLayerFragment` / `offDocument` as
 * scratch writes (like a helper called with a `scratch` AnimationEngine).
 */

import type { Command, DocumentFragment } from '@motion/engine-api';
import { edit, reportEngineError, type EditOptions } from './uiEdits';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { useHistoryStore } from '@stores/historyStore';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { jsonEqual } from '@core/commands/snapshotSharing';
import { applyParts, captureScope, changedKeys, documentScope, type Parts } from './state';
import { localEngine } from './engineInstance';
import { compOfLayer, graph, layerIdsOfComp } from './doc';
import { encodeFragment } from './handlers/layers';

export interface OffDocumentRun<T> {
  value: T;
  /** Part keys the build changed (already reverted). */
  changed: string[];
  before: Parts;
  after: Parts;
}

/**
 * Run `build` against a scratch state of the live document and put the
 * document back exactly. `inspect` runs while the scratch state is still live
 * (to encode what the build produced). No history entry, no engine resync, no
 * recorder capture; the selection is restored too.
 */
export function offDocument<T, R>(
  build: () => T,
  inspect: (run: OffDocumentRun<T>) => R,
): R {
  const eng = localEngine();
  const hold = <X>(fn: () => X): X => (eng ? eng.holdDetection(fn) : fn());
  const store = useHistoryStore.getState();
  // A pending debounced legacy edit gets its own entry first (as runEdits does).
  store.flush();
  let history: ReturnType<ReturnType<typeof getCommandSystem>['getHistory']> | null = null;
  try {
    history = getCommandSystem().getHistory();
  } catch {
    history = null;
  }
  const selection = [...useSelectionStore.getState().ids];
  return hold(() => {
    history?.suspend();
    const prevRestoring = useHistoryStore.getState().restoring;
    useHistoryStore.setState({ restoring: true });
    const before = captureScope(documentScope());
    let restoreParts: Parts | null = null;
    try {
      const value = build();
      if (value && typeof (value as { then?: unknown }).then === 'function') {
        throw new Error('offDocument: the builder must be synchronous (the scratch state may not outlive one task)');
      }
      const after = captureScope(documentScope());
      const changed = changedKeys(before, after);
      restoreParts = new Map(changed.map((k) => [k, before.get(k)]));
      return inspect({ value, changed, before, after });
    } catch (err) {
      // Restore whatever the build managed before it threw.
      if (!restoreParts) {
        const after = captureScope(documentScope());
        const changed = changedKeys(before, after);
        restoreParts = new Map(changed.map((k) => [k, before.get(k)]));
      }
      throw err;
    } finally {
      if (restoreParts && restoreParts.size > 0) applyParts(restoreParts);
      useHistoryStore.setState({ restoring: prevRestoring });
      history?.resume();
      useSelectionStore.getState().set(selection);
      bumpScene();
    }
  });
}

export interface BuiltLayers {
  fragment: DocumentFragment;
  /** Where the top-level layers go (pasteLayers `index`: among the comp's other layers, 0 = top). */
  index: number;
  /** Scratch ids of every built layer in FRAGMENT order (pasteLayers returns the new ids in this order). */
  scratchIds: string[];
  /** The top-level built layers (scratch ids), front-most first. */
  tops: string[];
  /** Scratch ids the builder left selected (map them through the paste result). */
  selected: string[];
  /** The existing layer the top-level layers were built into (pasteLayers `parent`); absent = the composition. */
  parent?: string;
}

export class OffDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffDocumentError';
  }
}

/**
 * Run a layer builder off-document and return the fragment of the layers it
 * added to `comp`, or null when it added none. Throws `OffDocumentError` when
 * the builder changed anything but new layers of `comp`.
 */
export function buildLayerFragment(comp: string, build: () => unknown): BuiltLayers | null {
  return offDocument(build, ({ changed, before, after }) => {
    const created = new Set<string>();
    for (const k of changed) {
      if (k.startsWith('node:') && before.get(k) === undefined && after.get(k) !== undefined) created.add(k.slice(5));
    }
    const problems: string[] = [];
    for (const k of changed) {
      const id = k.slice(k.indexOf(':') + 1);
      if (k.startsWith('node:')) {
        if (created.has(id)) continue;
        if (after.get(k) === undefined) { problems.push(`removed ${id}`); continue; }
        if (!onlyChildrenGained(before.get(k), after.get(k), created)) problems.push(`changed layer ${id}`);
        continue;
      }
      if (k.startsWith('anim:')) {
        if (created.has(id)) continue;
        problems.push(`changed the animation of ${id}`);
        continue;
      }
      if (k === 'order') continue;
      if (k === `clips:${comp}`) {
        if (!sameWithout(before.get(k), after.get(k), created, 'clips')) problems.push('changed existing bars');
        continue;
      }
      if (k === `tl:${comp}`) {
        if (!sameWithout(before.get(k), after.get(k), created, 'tl')) problems.push('changed the timeline (markers, ranges, rate)');
        continue;
      }
      problems.push(`changed ${k}`);
    }
    for (const id of created) {
      if (compOfLayer(id) !== comp) problems.push(`added ${id} outside the composition`);
    }
    if (problems.length > 0) throw new OffDocumentError(`not an insert: ${problems.join('; ')}`);
    if (created.size === 0) return null;
    const stack = layerIdsOfComp(comp);
    const tops = stack.filter((id) => created.has(id) && !created.has(graph.getNode(id)?.parent ?? ''));
    const parents = new Set(tops.map((id) => graph.getNode(id)?.parent));
    // One common parent: the composition, or an existing layer of it (a group
    // the builder inserted into — pasteLayers `parent`).
    const parent = parents.size === 1 ? [...parents][0] : undefined;
    if (!parent || (parent !== comp && compOfLayer(parent) !== comp)) {
      throw new OffDocumentError('the built layers must share one parent: the composition or one of its existing layers');
    }
    const first = stack.indexOf(tops[0]!);
    const index = stack.slice(0, first).filter((id) => !created.has(id)).length;
    const fragment = encodeFragment(tops);
    const scratchIds = fragmentOrder(tops, created);
    const selected = useSelectionStore.getState().ids.filter((id) => created.has(id));
    return { fragment, index, scratchIds, tops, selected, ...(parent !== comp ? { parent } : {}) };
  });
}

export interface InsertBuiltOptions extends EditOptions {
  /** Select the pasted layers the builder selected (default true). */
  select?: boolean;
  /** Extra commands sent in the same batch AFTER the paste (they cannot reference the new ids). */
  after?: readonly Command[];
}

/**
 * Build layers off-document and insert them with ONE `pasteLayers` (one undo
 * entry named `label`). Resolves to the new layer ids in fragment order (top
 * layers first, then their children), `[]` when the builder added nothing, or
 * null when it failed (toasted unless `quiet`).
 */
export async function insertBuiltLayers(
  label: string,
  comp: string,
  build: () => unknown,
  opts: InsertBuiltOptions = {},
): Promise<string[] | null> {
  let built: BuiltLayers | null;
  try {
    built = buildLayerFragment(comp, build);
  } catch (err) {
    if (!opts.quiet) reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!built) return [];
  const res = await edit(label, [
    { type: 'pasteLayers', comp, fragment: built.fragment, index: built.index, ...(built.parent ? { parent: built.parent } : {}) } as Command,
    ...(opts.after ?? []),
  ], opts);
  if (!res.ok) return null;
  const ids = (res.value[0] as { layers?: string[] } | undefined)?.layers ?? [];
  if (opts.select !== false) {
    const map = new Map(built.scratchIds.map((s, i) => [s, ids[i]!]));
    const sel = (built.selected.length > 0 ? built.selected : built.tops).map((s) => map.get(s)).filter((x): x is string => !!x);
    if (sel.length > 0) useSelectionStore.getState().set(sel);
  }
  return ids;
}

/** The order encodeFragment visits (top, then its children front-first, recursively). */
function fragmentOrder(tops: string[], created: Set<string>): string[] {
  const out: string[] = [];
  const visit = (id: string): void => {
    out.push(id);
    for (const c of [...graph.getChildOrder(id)].reverse()) if (!tops.includes(c) && created.has(c)) visit(c);
  };
  for (const id of tops) visit(id);
  return out;
}

function onlyChildrenGained(b: unknown, a: unknown, created: Set<string>): boolean {
  if (!b || !a || typeof b !== 'object' || typeof a !== 'object') return false;
  const rb = b as { children?: string[] };
  const ra = a as { children?: string[] };
  const kept = (ra.children ?? []).filter((c) => !created.has(c));
  return jsonEqual({ ...rb, children: rb.children ?? [] }, { ...ra, children: kept });
}

function sameWithout(b: unknown, a: unknown, created: Set<string>, kind: 'clips' | 'tl'): boolean {
  if (kind === 'clips') {
    const strip = (v: unknown): Record<string, unknown> => {
      const o = { ...((v as Record<string, unknown>) ?? {}) };
      for (const id of created) delete o[id];
      return o;
    };
    return jsonEqual(strip(b), strip(a));
  }
  const strip = (v: unknown): unknown => {
    if (!v) return v;
    const t = v as { barOrder: string[]; layerMarkers: Record<string, unknown> };
    const lm = { ...t.layerMarkers };
    for (const id of created) { delete lm[id]; delete lm[`clip:${id}`]; }
    return { ...t, barOrder: t.barOrder.filter((id) => !created.has(id.startsWith('clip:') ? id.slice(5) : id)), layerMarkers: lm };
  };
  return jsonEqual(strip(b), strip(a));
}
