/**
 * Inserts as ENGINE CLIENTS: a builder lays its new layers into a
 * {@link FragmentBuilder} (no scene graph, no animation engine — the page
 * replica is not involved) and the result lands as ONE `pasteLayers`: one undo
 * entry named for the insert, ids minted by the engine, the new layers
 * selected. The replacement of offDocument.ts `insertBuiltLayers`.
 *
 * `InsertFrame` is what a builder may know about the document: the target
 * composition's size / length / rate (the mirror) and where the pointer is
 * over it (the Info readout) — read once, at call time, and passed in, so the
 * builders themselves stay pure.
 */

import type { Command } from '@motion/engine-api';
import { edit, reportEngineError, type EditOptions } from '@core/engine/uiEdits';
import { documentMirror } from '@stores/documentMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { useInfoStore } from '@stores/infoStore';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { activeCompIdNow } from '@hooks/useMirror';
import { settingsDurationSeconds, settingsFps, settingsWorld } from '@core/mirror/compFacts';
import { FragmentBuilder, type BuiltFragment } from './fragmentBuilder';

export interface InsertFrame {
  /** The target composition (the builders' top-level parent). */
  comp: string;
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
  /** The pointer over the viewport, comp px — null when it is off the canvas. */
  cursor: { x: number; y: number } | null;
  /** The composition's World ▸ default sky (a new environment light's preset). */
  defaultEnvPreset?: string;
}

/** The insert frame of `comp` (default: the active composition), read now. */
export function insertFrame(comp?: string): InsertFrame {
  const id = comp ?? activeCompIdNow() ?? 'comp_root';
  const s = documentMirror().comp(id)?.settings;
  const info = useInfoStore.getState();
  const world = settingsWorld(s);
  return {
    comp: id,
    width: s?.width ?? DEFAULT_COMPOSITION.width,
    height: s?.height ?? DEFAULT_COMPOSITION.height,
    durationSeconds: s ? settingsDurationSeconds(s) : DEFAULT_COMPOSITION.durationSeconds,
    fps: s ? settingsFps(s) : DEFAULT_COMPOSITION.fps,
    cursor: info.present ? { x: info.x, y: info.y } : null,
    ...(typeof world.defaultEnvPreset === 'string' ? { defaultEnvPreset: world.defaultEnvPreset } : {}),
  };
}

export interface PasteBuiltOptions extends EditOptions {
  /** Scratch ids to select after the paste (default: the top-level layers); `false` leaves the selection alone. */
  select?: readonly string[] | false;
  /** pasteLayers `index` (among the comp's layers, 0 = top; default top). */
  index?: number;
  /** An existing layer to paste under (pasteLayers `parent`). */
  parent?: string;
  /** Commands sent in the same batch AFTER the paste (they cannot name the new ids). */
  after?: readonly Command[];
}

/**
 * Paste a built fragment into `comp` as ONE entry `label`. Resolves to the new
 * ids in fragment order (`built.scratchIds` order), [] when nothing was built,
 * null when the engine refused (toasted unless `quiet`).
 */
export async function pasteBuilt(
  label: string,
  comp: string,
  built: BuiltFragment | null,
  opts: PasteBuiltOptions = {},
): Promise<string[] | null> {
  if (!built) return [];
  const res = await edit(label, [
    {
      type: 'pasteLayers',
      comp,
      fragment: built.fragment,
      ...(opts.index !== undefined ? { index: opts.index } : {}),
      ...(opts.parent ? { parent: opts.parent } : {}),
    } as Command,
    ...(opts.after ?? []),
  ], opts);
  if (!res.ok) return null;
  const ids = (res.value[0] as { layers?: string[] } | undefined)?.layers ?? [];
  if (opts.select !== false) {
    const map = new Map(built.scratchIds.map((s, i) => [s, ids[i]!]));
    const want = opts.select && opts.select.length > 0 ? opts.select : built.tops;
    const sel = want.map((s) => map.get(s)).filter((x): x is string => !!x);
    if (sel.length > 0) useSelectionStore.getState().set(sel);
  }
  return ids;
}

/** Map scratch ids through a paste's result (`ids` in `built.scratchIds` order). */
export function pastedIds(built: BuiltFragment, ids: readonly string[], scratch: readonly string[]): string[] {
  const map = new Map(built.scratchIds.map((s, i) => [s, ids[i]!]));
  return scratch.map((s) => map.get(s)).filter((x): x is string => !!x);
}

export interface InsertOptions extends Omit<PasteBuiltOptions, 'select'> {
  /** The target composition (default: the active one). */
  comp?: string;
  /** Leave the selection alone. */
  noSelect?: boolean;
  /** Scratch-id namespace. */
  idPrefix?: string;
}

/**
 * Build with `build` into a fresh {@link FragmentBuilder} and paste the result
 * as ONE entry `label`. `build` returns the scratch id(s) to select (nothing =
 * the top-level layers). Resolves like {@link pasteBuilt}; a builder that
 * throws is reported as the insert failing (null).
 */
export async function insertFragment(
  label: string,
  build: (b: FragmentBuilder, frame: InsertFrame) => string | readonly string[] | null | void,
  opts: InsertOptions = {},
): Promise<string[] | null> {
  const frame = insertFrame(opts.comp);
  const b = new FragmentBuilder({ idPrefix: opts.idPrefix ?? 'ins' });
  let picked: string | readonly string[] | null | void;
  try {
    picked = build(b, frame);
  } catch (err) {
    if (!opts.quiet) reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const select = opts.noSelect ? false : typeof picked === 'string' ? [picked] : picked ? [...picked] : undefined;
  return pasteBuilt(label, frame.comp, b.build(), { ...opts, select });
}
