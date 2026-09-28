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
 * The document edits run first in `premation-engine --prepare` (cliPrepare.ts)
 * on a saved copy of the project, in this order: `--commands` (a recorded
 * command log replayed, commandLog.ts), a `--data` row filled into the
 * template fields (`runCliEngineBatch`, one render per row), `--captions`
 * (setCaptions), then `--aspect` (the autoReframe job's new composition). The
 * export renders that copy. `--scale` is the export job's own option. A frame
 * the engine's preflight refuses, or an engine that will not start or crashes,
 * FAILS the render.
 *
 * Electron-free: the engine launch is injected (tested in cliEngineRender.test.ts).
 */

import path from 'node:path';
import type { CliRenderJob } from './cliArgs';
import { ASPECT_RATIOS, runEnginePrepare, type PrepareDeps, type PrepareRequest } from './cliPrepare';
import { captionCuesFromFile } from './captionText';
import { parseDataTable, resolveOutputName } from './dataTable';
import { commandLogRequests } from './commandLog';
import {
  engineIneligible,
  startEngineExport,
  type EngineExportDeps,
  type EngineExportSpec,
  type EnginePreflight,
} from './engineExport';

export type CliEngineOutcome =
  | { kind: 'done'; frames: number; width: number; height: number; fps: number; compositionName: string; warnings: string[] }
  /** A CLI feature the engine does not have yet (nothing was written). */
  | { kind: 'needsEditor'; reason: string }
  | { kind: 'failed'; message: string };

/**
 * The engine export spec for a CLI render (`--aspect` is applied before, by
 * `runCliEngineRender`), or why the engine cannot do it.
 */
export function cliEngineSpec(job: CliRenderJob, enginePath: string | null): { spec: EngineExportSpec } | { reason: string } {
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
/** A CLI job with the files main already read (cliRender.ts prepareTask). */
export type CliJobWithFiles = CliRenderJob & {
  captions?: { text: string; filename: string };
  data?: { text: string; filename: string };
  commands?: { text: string; filename: string };
};

export async function runCliEngineRender(
  job: CliJobWithFiles,
  deps: EngineExportDeps,
  onProgress: (fraction: number) => void,
  prepare: typeof runEnginePrepare = runEnginePrepare,
  fill?: Readonly<Record<string, string>>,
): Promise<CliEngineOutcome> {
  if (!deps.enginePath) return { kind: 'failed', message: 'premation-engine is not available (reinstall Premation).' };
  const planned = cliEngineSpec(job, deps.enginePath);
  if ('reason' in planned) return { kind: 'needsEditor', reason: planned.reason };
  const id = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let spec = planned.spec;
  const warnings: string[] = [];
  if (job.aspect || job.captions || job.commands || fill) {
    // The document edits run in the engine (--prepare): the captions first
    // (setCaptions), then the retarget (the autoReframe job, a new composition
    // holding the captioned one); the export renders the saved copy.
    const workDir = deps.workDirFor(`${id}-prepare`);
    const saveTo = path.join(workDir, 'project.motion');
    const req: PrepareRequest = { projectPath: job.projectPath, ...(job.comp !== undefined ? { comp: job.comp } : {}), saveTo, ...(fill ? { fill } : {}) };
    if (job.commands) {
      try {
        req.requests = commandLogRequests(job.commands.text).requests;
      } catch (e) {
        return { kind: 'failed', message: `"${job.commands.filename}" is not a command log: ${(e as Error).message}` };
      }
    }
    if (job.captions) {
      let parsed: ReturnType<typeof captionCuesFromFile>;
      try {
        parsed = captionCuesFromFile(job.captions.text);
      } catch (e) {
        return { kind: 'failed', message: `"${job.captions.filename}": ${(e as Error).message}` };
      }
      req.captions = { cues: parsed.cues };
      if (parsed.skipped > 0) warnings.push(`${parsed.skipped} overlapping caption cue(s) were dropped.`);
    }
    if (job.aspect) {
      const ratio = ASPECT_RATIOS[job.aspect];
      if (!ratio) return { kind: 'failed', message: `Unknown aspect "${job.aspect}".` };
      req.reframe = { ratio };
    }
    const prepDeps: PrepareDeps = { enginePath: deps.enginePath, workDir };
    const prepared = await prepare(req, prepDeps);
    if (!prepared.ok) return { kind: 'failed', message: prepared.message };
    const rp = prepared.result.replayed;
    if (rp && rp.refused > 0) warnings.push(`${rp.refused} of ${rp.applied} recorded request(s) in "${job.commands?.filename ?? 'the log'}" were refused (first: ${rp.firstError ?? ''}).`);
    const f = prepared.result.fill;
    if (f && f.failed.length > 0) warnings.push(`${f.failed.length} field(s) could not be filled: ${f.failed.join(', ')}.`);
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
        warnings,
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

export interface CliBatchOutcome {
  kind: 'batch';
  rendered: number;
  failed: number;
  rows: Array<{ outputPath: string; error?: string }>;
  warnings: string[];
}

/**
 * `--data`: one render per table row (from `startRow`), each row filled into
 * the template by the engine (--prepare `fill`) and rendered to the `--out`
 * pattern resolved for that row. A failed row is reported and the batch goes
 * on; a table or a pattern that cannot work fails before anything renders.
 */
export async function runCliEngineBatch(
  job: CliJobWithFiles & { data: { text: string; filename: string } },
  deps: EngineExportDeps,
  onProgress: (fraction: number) => void,
  prepare: typeof runEnginePrepare = runEnginePrepare,
): Promise<CliBatchOutcome | { kind: 'failed'; message: string }> {
  let table: ReturnType<typeof parseDataTable>;
  try {
    table = parseDataTable(job.data.text, job.data.filename);
  } catch (e) {
    return { kind: 'failed', message: `"${job.data.filename}": ${(e as Error).message}` };
  }
  const total = table.rows.length;
  const first = Math.max(0, job.startRow ?? 0);
  if (first >= total) return { kind: 'failed', message: `"${job.data.filename}" has ${total} row(s); nothing from row ${first + 1}.` };
  const names: string[] = [];
  try {
    for (let i = 0; i < total; i++) names.push(resolveOutputName(job.outPath, table.rows[i]!, i, total));
  } catch (e) {
    return { kind: 'failed', message: (e as Error).message };
  }
  const out: CliBatchOutcome = { kind: 'batch', rendered: 0, failed: 0, rows: [], warnings: [] };
  const todo = total - first;
  for (let i = first; i < total; i++) {
    const done = i - first;
    const row = table.rows[i]!;
    const res = await runCliEngineRender({ ...job, outPath: names[i]! }, deps, (f) => onProgress((done + f) / todo), prepare, row);
    if (res.kind === 'done') {
      out.rendered++;
      out.rows.push({ outputPath: names[i]! });
      for (const w of res.warnings) out.warnings.push(`row ${i + 1}: ${w}`);
    } else {
      out.failed++;
      out.rows.push({ outputPath: names[i]!, error: res.kind === 'failed' ? res.message : res.reason });
    }
  }
  return out;
}
