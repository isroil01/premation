/**
 * Rig Logo for Animation — turn a whole multi-part logo (a group / precomp /
 * multi-selection of shapes) into ONE riggable piece with a starter puppet rig.
 *
 * WHY this exists: puppet/bone rigging only works on a SINGLE leaf image or
 * shape layer, whose warp mesh comes from its bitmap alpha or path silhouette.
 * A group/precomp has no composited texture to warp, so it can't be rigged
 * directly. The AE-style fix is to rasterize the logo to one image layer, then
 * rig THAT — the image-alpha mesh path works end to end.
 *
 * The work is the ENGINE's `rigLogo` job (native/engine/src/jobs/kind_rig_logo.cpp):
 *   - exactly one image or shape layer holding nothing → rigged in place;
 *   - anything else → the selection drawn alone on a transparent comp, cropped
 *     to its pixels, imported as a PNG and placed as an image layer where it
 *     drew, then rigged.
 * The rig is two pins, "Anchor" at the bottom centre and "Wave" at the top
 * centre. The job's result is one history entry; this module only starts it,
 * then selects the rigged layer and picks the Puppet Pin tool.
 */

import type { SceneKind } from '@core/scene/sceneKind';
import { requireEngineJob, startEngineJob } from '@core/engine/engineJobs';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore, type Tool } from '@stores/uiStore';
import { secondsToFlicks } from '@motion/engine-api';

/**
 * Layer kinds that can carry a puppet / bone rig directly: a rig's warp mesh
 * needs a bitmap alpha or a path silhouette, which only these kinds provide.
 * Groups / precomps / nulls / cameras / lights have no such surface.
 *
 * TEXT IS DELIBERATELY EXCLUDED: it has neither a path silhouette nor an alpha
 * coverage mask, so its mesh would fall back to the bounding box and deform
 * the empty space between glyphs. Text routes through Rig Logo, which
 * rasterizes it to an image whose alpha culls correctly. The engine's job
 * makes the same decision (kind_rig_logo.cpp).
 */
export const RIGGABLE_KINDS: ReadonlySet<SceneKind> = new Set(['shape', 'image']);

/** Whether a scene kind can be rigged directly (see RIGGABLE_KINDS). */
export function isRiggableKind(kind: SceneKind): boolean {
  return RIGGABLE_KINDS.has(kind);
}

/** What the engine's `rigLogo` job reports. */
export interface RigLogoResult {
  mode: 'self' | 'rasterize';
  /** The rigged layer (the new image layer when rasterized). */
  layer?: string;
}

export interface RigLogoDeps {
  getSelection?: () => readonly string[];
  setSelection?: (ids: readonly string[]) => void;
  setActiveTool?: (tool: Tool) => void;
  notify?: (n: { level: 'info' | 'success' | 'warning' | 'error'; message: string; durationMs: number }) => void;
  /** Composition seconds the logo is rendered at (absent: the engine's playhead). */
  seconds?: () => number;
  /** The engine job (injected in tests). */
  run?: (layers: readonly string[], seconds: number | undefined) => Promise<{ ok: true; result: RigLogoResult } | { ok: false; message: string } | null>;
}

async function runRigLogoJob(
  layers: readonly string[],
  seconds: number | undefined,
): Promise<{ ok: true; result: RigLogoResult } | { ok: false; message: string } | null> {
  const handle = requireEngineJob(
    await startEngineJob<RigLogoResult>({ kind: 'rigLogo', value: { layers: [...layers], ...(seconds !== undefined ? { time: secondsToFlicks(seconds) } : {}) } }, { apply: true }),
    'Rig Logo for Animation',
  );
  const out = await handle.done;
  if (out.status === 'cancelled') return null;
  if (out.status !== 'done' || !out.result) return { ok: false, message: out.error?.message ?? 'The logo could not be rigged.' };
  return { ok: true, result: out.result };
}

/**
 * Turnkey "Rig Logo for Animation". Never throws — a refusal (nothing
 * selected, the selection draws nothing at this time) notifies and bails.
 */
export async function rigLogoForAnimation(deps: RigLogoDeps = {}): Promise<void> {
  const getSelection = deps.getSelection ?? (() => useSelectionStore.getState().ids);
  const setSelection = deps.setSelection ?? ((ids) => useSelectionStore.getState().set(ids));
  const setActiveTool = deps.setActiveTool ?? ((t: Tool) => useUIStore.getState().setActiveTool(t));
  const notify = deps.notify ?? ((n) => useUIStore.getState().notify(n));
  const run = deps.run ?? runRigLogoJob;

  const selection = Array.from(getSelection());
  if (selection.length === 0) {
    notify({ level: 'warning', message: 'Select a layer, group, or logo to rig first.', durationMs: 3000 });
    return;
  }
  let out: Awaited<ReturnType<typeof runRigLogoJob>>;
  try {
    out = await run(selection, deps.seconds?.());
  } catch (e) {
    out = { ok: false, message: (e as Error).message };
  }
  if (out === null) return;
  if (!out.ok) {
    notify({ level: 'error', message: out.message, durationMs: 4000 });
    return;
  }
  if (out.result.layer) setSelection([out.result.layer]);
  setActiveTool('puppet-pin');
  notify({ level: 'success', message: 'Logo ready to rig — drag pins to animate.', durationMs: 3200 });
}
