/**
 * What a render-queue job looks like once the app has quit — and how it comes
 * back.
 *
 * Pure functions, no store: the queue (`renderQueueStore`) calls these when it
 * writes itself down and when it reads itself back, and a test can exercise the
 * round-trip without a zustand store, a shell bridge or a staging directory.
 *
 * Persisted per job:
 *
 *   • the SPEC (`RenderJobSpec`) — everything the render needs, including the
 *     composition id and the output path;
 *   • `id`, so a relaunched queue and the staging dir it left behind agree on
 *     which job is which;
 *   • `stagingJobId` — the staging directory, named the way the main process
 *     names it. The only thing that can point at frames after a restart;
 *   • `status` and `resumeFrame` — what the job was DOING when the app closed,
 *     and how far it had got.
 *
 * `status` and `resumeFrame` are a RECORD, not the authority. The frames on
 * disk are the only honest measure of how far a render got, so a restored job
 * takes its resume point from the staging dir's count, never from this file.
 * What the record is for is the case where the two disagree: a job that was
 * paused at frame 400 whose directory is no longer there must come back saying
 * so — "these frames were lost, this starts over" — rather than silently
 * appearing as a job that was never started. Without the record the queue
 * cannot tell those two apart.
 *
 * Progress and elapsed time are deliberately NOT persisted: a remembered "68%"
 * with no directory behind it is a number the user cannot check.
 */

import type { RenderJobSpec } from './renderSpec';

/**
 * The statuses a job can be written down in. `done` and `skipped` are finished
 * business and are never persisted at all.
 */
export type PersistedStatus = 'queued' | 'rendering' | 'paused' | 'stopped' | 'failed';

export interface PersistedRenderJob extends RenderJobSpec {
  id: string;
  stagingJobId?: string;
  /** Absent in blobs written before this existed; read as `queued`. */
  status?: PersistedStatus;
  /** The frame a paused/stopped job was going to come back at. */
  resumeFrame?: number;
}

/** The live fields the queue holds that persistence has an opinion about. */
export interface PersistableJob extends RenderJobSpec {
  id: string;
  status: string;
  resumeFrame?: number;
  stagingJobId?: string;
}

const PERSISTED_STATUSES: ReadonlySet<string> = new Set<PersistedStatus>([
  'queued', 'rendering', 'paused', 'stopped', 'failed',
]);

/** Statuses whose jobs are worth remembering across a quit. */
export function isPersistedStatus(status: string): status is PersistedStatus {
  return PERSISTED_STATUSES.has(status);
}

/**
 * Strip a live job down to what may be written to disk.
 *
 * Everything that is a handle (`_resume`), a promise about this process
 * (`_adopt`), or a number the disk cannot vouch for (`progress`, `elapsedMs`)
 * is dropped by construction: only the fields named here get through, so a
 * field added to the live job later is persisted only if someone decides it
 * should be.
 */
export function toPersistedJob(job: PersistableJob): PersistedRenderJob {
  const {
    id, status, resumeFrame, stagingJobId,
    // Live-only fields, listed so they are provably not in `spec`.
    progress: _progress, elapsedMs: _elapsedMs, error: _error, attention: _attention,
    _resume, _adopt,
    ...spec
  } = job as PersistableJob & Record<string, unknown>;
  void _progress; void _elapsedMs; void _error; void _attention; void _resume; void _adopt;
  return {
    ...(spec as RenderJobSpec),
    id,
    ...(stagingJobId ? { stagingJobId } : {}),
    ...(isPersistedStatus(status) ? { status } : {}),
    ...(typeof resumeFrame === 'number' && resumeFrame > 0 ? { resumeFrame } : {}),
  };
}

/**
 * Is this thing from disk actually a job?
 *
 * The settings blob is a plain JSON file on the user's machine, editable by
 * hand and written by older versions of this app. A restore that trusted it
 * would put objects with no format and no size into the queue and fail at
 * render time, long after the bad data arrived. An unknown `status` or a
 * non-numeric `resumeFrame` does not reject the job — the spec is still good —
 * they are simply read as "queued, from the start".
 */
export function isPersistedJob(v: unknown): v is PersistedRenderJob {
  if (!v || typeof v !== 'object') return false;
  const j = v as Record<string, unknown>;
  return (
    typeof j['id'] === 'string'
    && typeof j['compositionName'] === 'string'
    && typeof j['outputPath'] === 'string'
    && typeof j['format'] === 'string'
    && typeof j['width'] === 'number'
    && typeof j['height'] === 'number'
    && typeof j['fps'] === 'number'
    && typeof j['durationSec'] === 'number'
  );
}

/** The status this record was written in, tolerating blobs that have none. */
export function persistedStatusOf(p: PersistedRenderJob): PersistedStatus {
  return p.status && isPersistedStatus(p.status) ? p.status : 'queued';
}

/** The recorded resume frame, tolerating hand-edited blobs. */
export function persistedResumeFrameOf(p: PersistedRenderJob): number | undefined {
  return typeof p.resumeFrame === 'number' && Number.isFinite(p.resumeFrame) && p.resumeFrame > 0
    ? Math.floor(p.resumeFrame)
    : undefined;
}

/**
 * Was this job holding rendered frames when the app closed?
 *
 * `paused` and `stopped` certainly were — those states exist only to hold
 * frames. `rendering` MAY have been: the app was quit or crashed mid-render, and
 * whatever the loop had staged is on disk or is not. Either way a restore that
 * finds no directory for the job has something to tell the user.
 */
export function hadFramesInFlight(p: PersistedRenderJob): boolean {
  const s = persistedStatusOf(p);
  return s === 'paused' || s === 'stopped' || s === 'rendering';
}

/**
 * The parked status a restored job comes back in once its frames are found.
 *
 * A job the user paused comes back paused; one the queue stopped, or one the
 * app died under, comes back stopped. Never `rendering`: nothing renders on
 * launch, whatever the record says.
 */
export function parkedStatusFor(p: PersistedRenderJob): 'paused' | 'stopped' {
  return persistedStatusOf(p) === 'paused' ? 'paused' : 'stopped';
}

/**
 * What to tell the user about a job whose frames did not survive.
 *
 * The record says how far it got; the disk says nothing is there. The job
 * still renders — from frame 0 — but it must not look like a job that was
 * never started.
 */
export function lostFramesMessage(p: PersistedRenderJob): string {
  const frame = persistedResumeFrameOf(p);
  const had = frame !== undefined
    ? `${frame} rendered frame${frame === 1 ? '' : 's'} from your last session`
    : persistedStatusOf(p) === 'rendering'
      ? 'The frames it rendered before the app closed'
      : 'Its rendered frames from your last session';
  return `${had} could not be found on disk — this job starts again from the beginning.`;
}

/** What to tell the user about a job whose composition is not in this project. */
export function missingCompositionMessage(compositionName: string): string {
  return `“${compositionName}” is not in the open project — open the project it was queued from, or remove this job.`;
}
