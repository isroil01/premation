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
 * The engine renders every CLI render (docs/TS_ENGINE_REMOVAL.md phase 4).
 * `--aspect` first runs `premation-engine --prepare` (cliPrepare.ts): the
 * engine's autoReframe job makes the retargeted composition and saves a copy of
 * the project, which the export then renders. `--scale` is the engine's own
 * job option. Not in the engine yet, and refused with a clear line
 * (`needsEditor`, post-launch — docs/TS_ENGINE_REMOVAL.md): `--captions`
 * (caption layers), `--commands` (a TypeScript-engine command log) and
 * `--data` (template fill). A frame the engine's preflight refuses, or an
 * engine that will not start or crashes, FAILS the render.
 *
 * Electron-free: the engine launch is injected (tested in cliEngineRender.test.ts).
 */

import path from 'node:path';
import type { CliRenderJob } from './cliArgs';
import { ASPECT_RATIOS, runEnginePrepare, type PrepareDeps } from './cliPrepare';
import {
  engineIneligible,
  startEngineExport,
  type EngineExportDeps,
  type EngineExportSpec,
  type EnginePreflight,
} from './engineExport';

export type CliEngineOutcome =
  | { kind: 'done'; frames: number; width: number; height: number; fps: number; compositionName: string }
  /** A CLI feature the engine does not have yet (nothing was written). */
  | { kind: 'needsEditor'; reason: string }
  | { kind: 'failed'; message: string };

/**
 * The engine export spec for a CLI render (`--aspect` is applied before, by
 * `runCliEngineRender`), or why the engine cannot do it.
 */
export function cliEngineSpec(job: CliRenderJob, enginePath: string | null): { spec: EngineExportSpec } | { reason: string } {
  if (job.captionsPath !== undefined) return { reason: '--captions (caption layers) is not in the engine yet' };
  if (job.commandsPath !== undefined) return { reason: '--commands (command-log replay) is not in the engine yet' };
  if (job.dataPath !== undefined) return { reason: '--data (one file per table row) is not in the engine yet' };
  const spec: EngineExportSpec = {
    projectPath: job.projectPath,
    outPath: job.outPath,
    format: job.format,
    ...(job.comp !== undefined ? { comp: job.comp } : {}),
    ...(job.startFrame !== undefined ? { startFrame: job.startFrame } : {}),
    // A still is ONE frame: the range's first (frame 0 when none is given).
    ...(job.format === 'png'
      ? { startFrame: job.startFrame ?? 0, endFrame: job.startFrame ?? 0 }
      : job.endFrame !== undefined ? { endFrame: job.endFrame } : {}),
    ...(job.fps !== undefined ? { fps: job.fps } : {}),
    ...(job.width !== undefined ? { width: job.width } : {}),
    ...(job.height !== undefined ? { height: job.height } : {}),
    ...(job.scale !== undefined && job.scale !== 1 && job.width === undefined && job.height === undefined ? { scale: job.scale } : {}),
    ...(job.quality !== undefined ? { quality: job.quality } : {}),
    ...(job.proresProfile !== undefined ? { proresProfile: job.proresProfile } : {}),
    ...(job.transparent !== undefined ? { transparent: job.transparent } : {}),
  };
  const why = engineIneligible(spec, enginePath);
  return why ? { reason: why } : { spec };
}

/**
 * Render `job` in the engine. `needsEditor` means the job uses a CLI feature
 * the engine does not have yet (nothing was written); `failed` is any other
 * ending that did not write the file. `prepare` is injected for tests.
 */
export async function runCliEngineRender(
  job: CliRenderJob,
  deps: EngineExportDeps,
  onProgress: (fraction: number) => void,
  prepare: typeof runEnginePrepare = runEnginePrepare,
): Promise<CliEngineOutcome> {
  if (!deps.enginePath) return { kind: 'failed', message: 'premation-engine is not available (reinstall Premation).' };
  const planned = cliEngineSpec(job, deps.enginePath);
  if ('reason' in planned) return { kind: 'needsEditor', reason: planned.reason };
  const id = `cli-${Date.now().toString(36)}`;
  let spec = planned.spec;
  if (job.aspect) {
    // The engine's autoReframe job makes the retargeted composition; the
    // export renders a saved copy of the project, targeting it.
    const ratio = ASPECT_RATIOS[job.aspect];
    if (!ratio) return { kind: 'failed', message: `Unknown aspect "${job.aspect}".` };
    const workDir = deps.workDirFor(`${id}-prepare`);
    const prepDeps: PrepareDeps = { enginePath: deps.enginePath, workDir };
    const saveTo = path.join(workDir, 'project.motion');
    const prepared = await prepare({ projectPath: job.projectPath, ...(job.comp !== undefined ? { comp: job.comp } : {}), reframe: { ratio }, saveTo }, prepDeps);
    if (!prepared.ok) return { kind: 'failed', message: prepared.message };
    spec = { ...spec, projectPath: saveTo, comp: prepared.result.comp };
  }
  let pre: EnginePreflight | null = null;
  const run = startEngineExport(id, spec, {
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
