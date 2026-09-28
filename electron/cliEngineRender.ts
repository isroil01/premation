/**
 * `premation render` through the ENGINE (docs/TS_ENGINE_REMOVAL.md: "CLI render
 * … via `premation-engine --export`").
 *
 * The same engine job the export supervisor runs (engineExport.ts): the engine
 * opens the project on disk, renders the range offline and pipes raw frames
 * into the ffmpeg command line `buildEncodeArgs` makes — so a CLI render, a
 * Render Queue item and an editor export are one encode. Nothing is drawn in a
 * window.
 *
 * The engine renders every CLI render (the flag is gone — docs/TS_ENGINE_REMOVAL.md
 * phase 4). What still needs the editor (`needsEditor`: the hidden window in
 * cliRender.ts, on the TypeScript engine until those CLI features are ported):
 *   - `--aspect` (reframe builds a new composition first), `--captions`,
 *     `--commands`, `--data` (they edit the document before rendering),
 *   - `--scale` without an explicit size (the comp size is read in the page),
 *   - formats the engine does not write (a single `png` still, HDR).
 * A frame the engine's preflight refuses, or an engine that will not start or
 * crashes, FAILS the render — there is no window fallback for it.
 *
 * Electron-free: the engine launch is injected (tested in cliEngineRender.test.ts).
 */

import type { CliRenderJob } from './cliArgs';
import {
  engineIneligible,
  startEngineExport,
  type EngineExportDeps,
  type EngineExportSpec,
  type EnginePreflight,
} from './engineExport';

export type CliEngineOutcome =
  | { kind: 'done'; frames: number; width: number; height: number; fps: number; compositionName: string }
  /** A CLI feature the engine path does not have yet: the hidden editor window renders it. */
  | { kind: 'needsEditor'; reason: string }
  | { kind: 'failed'; message: string };

/** The engine export spec for a CLI render, or why the render needs the editor. */
export function cliEngineSpec(job: CliRenderJob, enginePath: string | null): { spec: EngineExportSpec } | { reason: string } {
  if (job.aspect) return { reason: '--aspect reframes the composition in the editor first' };
  if (job.captionsPath !== undefined) return { reason: '--captions imports captions in the editor first' };
  if (job.commandsPath !== undefined) return { reason: '--commands replays a command log in the editor first' };
  if (job.dataPath !== undefined) return { reason: '--data renders one file per row in the editor' };
  if (job.scale !== undefined && job.scale !== 1 && (job.width === undefined || job.height === undefined)) {
    return { reason: '--scale reads the composition size in the editor' };
  }
  const spec: EngineExportSpec = {
    projectPath: job.projectPath,
    outPath: job.outPath,
    format: job.format,
    ...(job.comp !== undefined ? { comp: job.comp } : {}),
    ...(job.startFrame !== undefined ? { startFrame: job.startFrame } : {}),
    ...(job.endFrame !== undefined ? { endFrame: job.endFrame } : {}),
    ...(job.fps !== undefined ? { fps: job.fps } : {}),
    ...(job.width !== undefined ? { width: job.width } : {}),
    ...(job.height !== undefined ? { height: job.height } : {}),
    ...(job.quality !== undefined ? { quality: job.quality } : {}),
    ...(job.proresProfile !== undefined ? { proresProfile: job.proresProfile } : {}),
    ...(job.transparent !== undefined ? { transparent: job.transparent } : {}),
  };
  const why = engineIneligible(spec, enginePath);
  return why ? { reason: why } : { spec };
}

/**
 * Render `job` in the engine. `needsEditor` means the job uses a CLI feature
 * only the editor window has (nothing was written); `failed` is any other
 * ending that did not write the file.
 */
export async function runCliEngineRender(
  job: CliRenderJob,
  deps: EngineExportDeps,
  onProgress: (fraction: number) => void,
): Promise<CliEngineOutcome> {
  if (!deps.enginePath) return { kind: 'failed', message: 'premation-engine is not available (reinstall Premation).' };
  const planned = cliEngineSpec(job, deps.enginePath);
  if ('reason' in planned) return { kind: 'needsEditor', reason: planned.reason };
  let pre: EnginePreflight | null = null;
  const run = startEngineExport(`cli-${Date.now().toString(36)}`, planned.spec, {
    progress: onProgress,
    started: (info) => { pre = info; },
  }, deps);
  const outcome = await run.done;
  switch (outcome.kind) {
    case 'completed': {
      const p = pre as EnginePreflight | null;
      return {
        kind: 'done',
        frames: outcome.frames,
        width: p?.width ?? 0,
        height: p?.height ?? 0,
        fps: p?.fps ?? 0,
        compositionName: p?.compName ?? '',
      };
    }
    case 'fallback':
      return { kind: 'failed', message: `The engine could not render this job: ${outcome.reason}` };
    case 'failed':
      return { kind: 'failed', message: outcome.message };
    default:
      return { kind: 'failed', message: 'The render was cancelled.' };
  }
}
