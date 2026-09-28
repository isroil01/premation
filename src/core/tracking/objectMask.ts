/**
 * Object mask — one gesture on the footage becomes a mask path.
 *
 * The viewport hands this a CLICK (a point prompt) or a drawn BOX (a box
 * prompt) in source display px; the engine segments the frame under the
 * playhead with SAM (the objectMatte job, the model in a child engine
 * process), traces the matte to a contour and adds it as a mask path on the
 * layer. The page segmenter that used to run when the engine answered
 * `unsupported` is gone with the TypeScript engine (docs/TS_ENGINE_REMOVAL.md).
 *
 * Why a `none`-mode path: the produced mask exists to be GEOMETRY — the spine
 * for Track mask and for path-following effects (Write-on / Vegas via their
 * `pathMaskId` param) — not to cut the layer. `none` is precisely "a path in
 * the stack that clips nothing" (see mask.ts), so drawing a box around a
 * wheel does not also punch the rest of the frame out. Flipping it to `add`
 * afterwards is one click in the mask list for anyone who DOES want the cut.
 */

import { useProjectStore } from '@stores/projectStore';
import { useTrackerStore } from '@stores/trackerStore';
import { documentMirror } from '@stores/documentMirror';
import { settingsFps } from '@core/mirror/compFacts';
import { engine } from '@core/engine/engineInstance';
import { requireEngineJob, runEngineJob } from '@core/engine/engineJobs';
import { secondsToFlicks } from '@motion/engine-api';

/**
 * The pick-gesture entry: segment at the playhead and narrate the outcome
 * through the tracker store, exactly the shape `runAutoTrack` has. Never
 * throws — a click on a canvas has nobody upstream to catch.
 *
 * Deliberately does NOT `beginTracking()`: that clears the last track result,
 * and making a mask is an addition beside a track, not a replacement for it.
 * The phase alone drives the busy UI; the previous result is threaded back
 * through `finishTracking` untouched.
 */
export async function runObjectMaskPick(opts: {
  nodeId: string;
  point?: { x: number; y: number };
  box?: { x0: number; y0: number; x1: number; y1: number };
}): Promise<void> {
  const store = useTrackerStore;
  if (store.getState().tracking || store.getState().autoPhase === 'analyzing') return;
  const own = documentMirror().layer(opts.nodeId);
  const fps = settingsFps(own ? documentMirror().comp(own.comp)?.settings : undefined);
  const activeTab = useProjectStore.getState().activeTabId;
  const time = activeTab ? useProjectStore.getState().tabs[activeTab]?.time ?? 0 : 0;
  const prevResult = store.getState().result;

  store.getState().setAutoPhase('analyzing');
  try {
    const out = requireEngineJob(await runEngineJob<{ contourPoints: number; engine?: string }>({
      kind: 'objectMatte',
      value: {
        layer: opts.nodeId,
        range: { start: secondsToFlicks(time), duration: secondsToFlicks(1 / fps) },
        prompts: opts.point ? [opts.point] : [],
        backgroundPrompts: [],
        encoderModel: '',
        decoderModel: '',
        replaceMasks: [],
        ...(opts.box
          ? { box: { x: Math.min(opts.box.x0, opts.box.x1), y: Math.min(opts.box.y0, opts.box.y1), width: Math.abs(opts.box.x1 - opts.box.x0), height: Math.abs(opts.box.y1 - opts.box.y0) } }
          : {}),
      },
    }), 'Object mask');
    if (out.status !== 'done') throw new Error(out.error?.message ?? 'Object mask was cancelled.');
    // Land in mask mode: the produced path's next steps — Track mask, or a
    // path-following effect — both live there.
    const size = await engine().query({ type: 'getSourceSize', layers: [opts.nodeId] });
    const display = size.ok ? size.value.sizes[0] : undefined;
    if (display && display.width > 0) store.getState().setMode('mask', display.width, display.height);
    store.getState().finishTracking(
      prevResult,
      `Object mask: ${out.result?.contourPoints ?? 0} points (neural). ` +
        'Track mask makes it follow; Write-on/Vegas can draw along it via their Path option.',
    );
  } catch (e) {
    store.getState().finishTracking(prevResult, e instanceof Error ? e.message : String(e));
  }
}
