/**
 * Render staging that outlives the process.
 *
 * A queued render stages every frame to a per-job directory and only runs
 * ffmpeg at `finish()`. That means a forty-minute render interrupted at frame
 * 900 of 1000 still has 900 real files on disk — and until this module existed
 * the app threw them away by accident, because the only thing that knew a
 * directory belonged to a job was an in-memory `Map<jobId, dir>` in main.ts.
 * After a restart `render:stageFrame` answered `unknown render job` for the old
 * id, nothing could reach the directory, and the frames sat there orphaned
 * until the OS reclaimed them.
 *
 * So each job dir now carries its own description: `resume.json`. It is the
 * only thing needed to pick a render back up in a NEW process — what was being
 * rendered (the renderer's own `RenderJobSpec`, passed through opaquely), how
 * many frames the whole render is, and when it started. The frames themselves
 * remain the authority on progress; the manifest never has to be right about
 * that, which is why nothing here fails when its `stagedFrames` is stale.
 *
 * Deliberately free of `electron` imports: the staging root is passed in. That
 * keeps this testable in plain Node (`renderResume.test.ts`) and keeps the
 * "where is temp" decision in main.ts, which is the file that knows.
 */

import path from 'node:path';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

/** The per-job manifest's filename, inside the job's own staging dir. */
export const RESUME_MANIFEST = 'resume.json';

/*
  Why there is no per-frame progress FILE.

  `render:stageFrame` runs once per frame and must stay O(1), so the obvious
  design is a small tally the stage path appends to. It was written and then
  removed, because such a tally is never allowed to be believed: a crash between
  writing a frame and recording it — or the reverse — leaves the two
  disagreeing, and the only safe reading of a disagreement is to go count the
  frames. A second record every reader has to distrust is not a record, it is a
  liability.

  The frames ARE the progress. `scanStagedFrames` reads them with one readdir —
  one syscall, twice in a render's life (once when the queue lists what survived
  a restart, once when it adopts one of them) rather than once per frame.
*/

/** Job directories are named by this prefix plus the job id. */
export const JOB_DIR_PREFIX = 'motion-render-';

/*
  ★ The two payload shapes below are DUPLICATED in src/types/motionEditor.d.ts.

  The renderer must not import main-process sources (they pull in `electron`,
  which does not resolve in a browser build), and main must not import from
  `src/` (a separate tsconfig and a separate bundle). Two copies of a type
  crossing an IPC boundary is exactly the shape that drifts silently, so
  `renderResumeContract.test.ts` compares them as text — the same treatment
  `UpdateStatus` gets in `updaterStatusContract.test.ts`.

  `spec` is `unknown` on purpose and on BOTH sides. It is the renderer's own
  `RenderJobSpec`, round-tripped through JSON on disk; main never reads a field
  of it and is in no position to promise its shape after a version change. The
  renderer validates what it gets back.
*/

/** A previous session's render that still has frames on disk. */
export interface ResumableRenderJob {
  jobId: string;
  spec: unknown;
  format: string;
  totalFrames: number;
  stagedFrames: number;
  createdAt: number;
}

/** A re-registered job: its dir is live again under the same id. */
export interface AdoptedRenderJob {
  jobId: string;
  spec: unknown;
  format: string;
  totalFrames: number;
  stagedFrames: number;
  nextFrame: number;
  frameExt: 'jpg' | 'png';
}

/**
 * What `resume.json` holds.
 *
 * `stagedFrames` is a RECORD, not an authority: 0 when the dir opens, refreshed
 * to the counted value whenever the job is inspected, so a directory examined by
 * hand says something true about itself. Nothing ever resumes off it.
 */
export interface RenderResumeManifest {
  jobId: string;
  spec: unknown;
  format: string;
  totalFrames: number;
  stagedFrames: number;
  createdAt: number;
}

/** The staging directory for one job under `root`. */
export function jobDir(root: string, jobId: string): string {
  return path.join(root, `${JOB_DIR_PREFIX}${jobId}`);
}

/** The job id a staging directory name encodes, or null if it is not one. */
export function jobIdFromDirName(name: string): string | null {
  if (!name.startsWith(JOB_DIR_PREFIX)) return null;
  const id = name.slice(JOB_DIR_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Write (or rewrite) a job's manifest.
 *
 * Written to a sibling and renamed: a manifest half-flushed when the process
 * died would be unparseable JSON, and an unparseable manifest is indexed as
 * "this dir is not resumable" — which silently loses exactly the render this
 * whole module exists to save. `rename` within one directory is atomic on every
 * platform this ships to.
 */
export async function writeManifest(dir: string, manifest: RenderResumeManifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, RESUME_MANIFEST);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest), 'utf8');
  await rename(tmp, target);
}

/** Parse a job's manifest, or null when it is missing, unreadable or malformed. */
export async function readManifest(dir: string): Promise<RenderResumeManifest | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, RESUME_MANIFEST), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m['jobId'] !== 'string' || m['jobId'].length === 0) return null;
  if (typeof m['format'] !== 'string') return null;
  if (typeof m['totalFrames'] !== 'number' || !Number.isFinite(m['totalFrames'])) return null;
  return {
    jobId: m['jobId'],
    spec: m['spec'] ?? null,
    format: m['format'],
    totalFrames: m['totalFrames'],
    stagedFrames:
      typeof m['stagedFrames'] === 'number' && Number.isFinite(m['stagedFrames'])
        ? m['stagedFrames']
        : 0,
    createdAt: typeof m['createdAt'] === 'number' ? m['createdAt'] : 0,
  };
}

/**
 * What is ACTUALLY staged, read off the frame files.
 *
 * `contiguous` is the only number a resume may act on. ffmpeg's image2 demuxer
 * stops at the first missing index and still exits 0, so restarting a render at
 * "the number of files present" rather than "the first gap" would deliver a
 * video that silently ends early — the same trap `stagedFrames` in main.ts
 * guards the encode against, met from the other direction.
 */
export async function scanStagedFrames(
  dir: string,
): Promise<{ indices: number[]; contiguous: number; ext: 'jpg' | 'png' }> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return { indices: [], contiguous: 0, ext: 'jpg' };
  }
  const index = (re: RegExp): number[] =>
    files
      .map((f) => re.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]));
  const png = index(/^frame_(\d+)\.png$/i);
  const jpg = index(/^frame_(\d+)\.jpg$/i);
  const chosen = png.length > jpg.length ? { nums: png, ext: 'png' as const } : { nums: jpg, ext: 'jpg' as const };
  const present = new Set(chosen.nums);
  let contiguous = 0;
  while (present.has(contiguous)) contiguous++;
  return { indices: [...present].sort((a, b) => a - b), contiguous, ext: chosen.ext };
}

/**
 * Every resumable job under `root`, newest first.
 *
 * Directories with no readable manifest are not resumable — nothing knows what
 * they were rendering. Those older than `pruneOlderThanMs` are removed, which
 * is the one piece of housekeeping this module does: a crash between `mkdir`
 * and the manifest write leaves a dir nothing will ever claim, and the staging
 * root is now durable storage rather than the OS temp dir that used to age
 * these out on its own.
 */
export async function listResumableJobs(
  root: string,
  pruneOlderThanMs = 7 * 24 * 60 * 60 * 1000,
): Promise<ResumableRenderJob[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: ResumableRenderJob[] = [];
  for (const name of entries) {
    const jobId = jobIdFromDirName(name);
    if (!jobId) continue;
    const dir = path.join(root, name);
    const manifest = await readManifest(dir);
    if (!manifest) {
      // Unclaimable. Age it out rather than leaking a staging dir forever.
      try {
        const info = await stat(dir);
        if (Date.now() - info.mtimeMs > pruneOlderThanMs) {
          await rm(dir, { recursive: true, force: true });
        }
      } catch {
        /* raced with something else removing it — fine */
      }
      continue;
    }
    // Counted, not read back from the manifest: the queue puts this number in
    // front of the user as "resumes at frame N", and the manifest's own copy is
    // only ever as fresh as the last time somebody looked.
    const staged = await scanStagedFrames(dir);
    out.push({
      jobId: manifest.jobId,
      spec: manifest.spec,
      format: manifest.format,
      totalFrames: manifest.totalFrames,
      stagedFrames: staged.contiguous,
      createdAt: manifest.createdAt,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Validate one job dir and report exactly what may be resumed from it.
 *
 * `nextFrame` is the first MISSING index, so a resume restages nothing that is
 * already there and leaves no gap behind it. Null when the dir has no manifest
 * — the caller must not register a directory it cannot describe.
 */
export async function inspectJob(root: string, jobId: string): Promise<AdoptedRenderJob | null> {
  const dir = jobDir(root, jobId);
  const manifest = await readManifest(dir);
  if (!manifest) return null;
  const staged = await scanStagedFrames(dir);
  // Leave the dir describing itself accurately for whoever opens it next — a
  // support question about a stuck render is answered by this one file.
  if (manifest.stagedFrames !== staged.contiguous) {
    await writeManifest(dir, { ...manifest, stagedFrames: staged.contiguous }).catch(() => undefined);
  }
  return {
    jobId,
    spec: manifest.spec,
    format: manifest.format,
    totalFrames: manifest.totalFrames,
    stagedFrames: staged.contiguous,
    nextFrame: staged.contiguous,
    frameExt: staged.ext,
  };
}
