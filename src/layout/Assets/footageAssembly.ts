/**
 * The two footage-assembly gestures, as one flow each.
 *
 * Both are reachable from four places — the Assets panel's context menu, the
 * Composition menu, the command palette, and (for Assemble) a selected video
 * layer — so the dialog, the progress reporting, the notification wording and
 * above all the history boundary live HERE rather than being written once per
 * entry point. Four copies of "wrap this in one undo entry" is four chances to
 * get the boundary wrong, and a half-wrapped assembly is unrecoverable by the
 * user.
 *
 * Layout rather than core because both flows are conversations: they open
 * modals, report progress and notify. The parts that edit the document are
 * engine edits in `@layout/Workspace/footageEdits` (`newCompFromClipsEdit`,
 * `assembleShotsEdit`), each ONE undo entry, callable without any of this.
 */

import { useUIStore } from '@stores/uiStore';
import { customPrompt } from '@components/Modal';
import type { ImportedAsset } from '@stores/assetStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { settingsFps } from '@core/mirror/compFacts';
import { DEFAULT_COMPOSITION } from '@stores/compositionStore';
import type { AssembleOptions } from '@core/composition/assembleFromFootage';
import { requireEngineJob, startEngineJob } from '@core/engine/engineJobs';
import { assembleShotsEdit, newCompFromClipsEdit, newCompFromFootageEdit } from '@layout/Workspace/footageEdits';
import { openAssembleDialog } from './AssembleDialog';

type Level = 'info' | 'success' | 'warning' | 'error';

function notify(message: string, level: Level = 'info', durationMs = 3600): void {
  useUIStore.getState().notify({ level, message, durationMs });
}

// ── New Composition from Selected Clips ────────────────────────────

/**
 * Ask for the overlap, then build the comp.
 *
 * FRAMES, not the seconds Sequence Layers asks for: this dialog appears before
 * the comp exists, so "0.5s" would be quoted against a frame rate the user
 * cannot see yet and which the first clip is about to decide. A frame is a
 * frame whatever the rate turns out to be.
 */
export async function runNewCompFromClips(assets: ReadonlyArray<ImportedAsset>): Promise<void> {
  if (assets.length === 0) {
    notify('Select footage in the Assets panel first', 'warning');
    return;
  }

  let overlapFrames = 0;
  if (assets.length > 1) {
    const raw = await customPrompt(
      'New Composition from Selected Clips',
      `Build a composition sized and timed to “${assets[0]!.name}”, and lay all ${assets.length} clips end-to-end in panel order.\n\nOverlap in FRAMES — 0 butts them together; above 0 overlaps each pair by that much and cross-dissolves opacity across the overlap.`,
      '0',
      { placeholder: 'e.g. 12', confirmLabel: 'Create' },
    );
    if (raw === null) return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      notify('Overlap must be a number of frames, 0 or more', 'warning');
      return;
    }
    overlapFrames = Math.round(parsed);
  }

  try {
    // Not `assembleComposition`: it has neither the router's fitting nor the dissolves, nor
    // the pristine-comp adoption. The engine refusing is toasted by the edit.
    const result = await newCompFromClipsEdit(assets, overlapFrames);
    if (!result) return;
    const n = result.layers.length;
    notify(
      result.sequenced && result.overlapFrames > 0
        ? `Composition built from ${n} clips with a ${result.overlapFrames}-frame cross-dissolve`
        : result.sequenced
          ? `Composition built from ${n} clips, end-to-end`
          : `Composition built from ${n === 1 ? 'the clip' : `${n} clips`}`,
      'success',
    );
  } catch (err) {
    notify(
      `New Composition from Clips failed: ${err instanceof Error ? err.message : String(err)}`,
      'error',
      6000,
    );
  }
}

// ── Assemble from Footage ──────────────────────────────────────────

/** What an assembly can start from. */
export type AssembleTarget =
  | { kind: 'layer'; nodeId: string }
  | { kind: 'asset'; asset: ImportedAsset };

/** The first selected layer whose source is a video item, or null (B4: the document mirror). */
export function selectedVideoLayerId(): string | null {
  const m = documentMirror();
  for (const id of useSelectionStore.getState().ids) {
    const source = m.layer(id)?.source;
    const item = source ? m.item(source) : undefined;
    if (item?.kind === 'footage' && item.mediaType === 'video') return id;
  }
  return null;
}

/**
 * Detect the cuts in the target and assemble it.
 *
 * ## The two history entries an ASSET target produces, on purpose
 *
 * Starting from an asset needs a comp to assemble in, and building that comp is
 * `newCompFromFootageEdit` — the same act as the panel's own "New Comp
 * from Footage", which has always been its own undo step. Folding it into the
 * assembly would mean one Ctrl+Z threw away the composition as well as the cut,
 * which is not what "undo the assembly" means to anyone.
 *
 * So: the comp is created as its own step (only after the dialog is confirmed,
 * so cancelling leaves the project untouched), and the ASSEMBLY — every split,
 * every drop, the sequencing and its crossfades — is exactly one entry, which
 * is the thing this feature promises.
 */
export async function runAssembleFromFootage(target: AssembleTarget): Promise<void> {
  const m = documentMirror();

  // The dialog opens FIRST, before anything is created or read, so Cancel is
  // free. Its frame rate is the one the result will be quoted in: the layer's
  // comp, or the rate the file itself reports for footage with no comp yet.
  const fps =
    target.kind === 'layer'
      ? settingsFps(m.comp(m.layer(target.nodeId)?.comp ?? '')?.settings, 0) || DEFAULT_COMPOSITION.fps
      : target.asset.metadata?.fps && target.asset.metadata.fps > 0
        ? target.asset.metadata.fps
        : DEFAULT_COMPOSITION.fps;
  const name =
    target.kind === 'layer'
      ? (m.layer(target.nodeId)?.name ?? 'the clip')
      : target.asset.name;

  const opts = await openAssembleDialog(name, fps);
  if (!opts) return;

  try {
    let nodeId: string;
    if (target.kind === 'layer') {
      nodeId = target.nodeId;
    } else {
      const made = await newCompFromFootageEdit(target.asset);
      if (!made) {
        notify('Assemble from Footage: the clip could not be placed in a composition.', 'error', 6000);
        return;
      }
      nodeId = made.layer;
    }

    // The engine walks the clip (the sceneDetect job, analysis only — nothing is written).
    const { cutsCompSec, status } = await detectCuts(nodeId, opts);
    if (status === 'cancelled') {
      notify('Assemble from Footage: cancelled.', 'info');
      return;
    }
    if (cutsCompSec.length === 0) {
      notify('Assemble from Footage: no cuts found in this clip.', 'info');
      return;
    }

    const report = await assembleShotsEdit(nodeId, { cutsCompSec, fps, dissolveFrames: opts.dissolveFrames, minShotFrames: opts.minShotFrames });
    if (!report) return;

    const parts = [`${cutsCompSec.length} cut${cutsCompSec.length === 1 ? '' : 's'}`];
    parts.push(`${report.shots.length} shot${report.shots.length === 1 ? '' : 's'}`);
    if (report.dropped > 0) parts.push(`${report.dropped} dropped`);
    if (opts.dissolveFrames > 0) parts.push(`${opts.dissolveFrames}-frame dissolves`);
    notify(`Assembled: ${parts.join(', ')}.`, 'success', 5000);
  } catch (err) {
    notify(
      `Assemble from Footage failed: ${err instanceof Error ? err.message : String(err)}`,
      'error',
      6000,
    );
  }
}

/**
 * The cuts in `nodeId`'s clip — the engine's `sceneDetect` job run for its
 * summary (no markers, no splits), progress in one notification updated in
 * place (the walk is decode-bound: a minute on an hour of 4K).
 */
async function detectCuts(nodeId: string, opts: AssembleOptions): Promise<{ cutsCompSec: number[]; status: 'completed' | 'cancelled' }> {
  let liveId = useUIStore.getState().notify({ level: 'info', message: 'Assemble from Footage: reading frames… 0%', durationMs: 0 });
  let last = -1;
  try {
    const handle = requireEngineJob(await startEngineJob<{ cutsCompSec: number[] }>(
      { kind: 'sceneDetect', value: { layer: nodeId, createMarkers: false, splitLayers: false, ...(opts.sensitivity !== undefined ? { sensitivity: opts.sensitivity } : {}) } },
      {
        apply: false,
        onProgress: (f) => {
          const pct = Math.round(f * 100);
          if (pct !== last && pct % 5 === 0) {
            last = pct;
            useUIStore.getState().dismissNotification(liveId);
            liveId = useUIStore.getState().notify({ level: 'info', message: `Assemble from Footage: reading frames… ${pct}%`, durationMs: 0 });
          }
        },
      },
    ), 'Assemble from Footage');
    const out = await handle.done;
    if (out.status === 'cancelled') return { cutsCompSec: [], status: 'cancelled' };
    if (out.status === 'failed') throw new Error(out.error?.message ?? 'the clip could not be read');
    return { cutsCompSec: out.result?.cutsCompSec ?? [], status: 'completed' };
  } finally {
    useUIStore.getState().dismissNotification(liveId);
  }
}
