/**
 * F2 — the engine's command log, kept in Electron MAIN (docs/NATIVE_CORE_PLAN.md
 * §5 Phase F2 "the command log moving to main"; ENGINE_API.md §12).
 *
 * Until F2 each window's ProcessEngineClient recorded the requests it had sent
 * and, when the supervisor reported `engine-restarted`, replayed them into the
 * fresh (empty) engine. That only works with ONE client: a second window (a
 * pop-out as a second mirror) would replay its own requests too, and neither
 * log alone is the engine's history. Main is the one place every request goes
 * through, so the log lives here:
 *
 *   record(req, res)  every applied non-query request (a response that is not
 *                     an error), in the order the engine answered; `newProject`
 *                     clears it (nothing before it matters) — the renderer
 *                     client's rule, unchanged
 *   plan()            the requests to replay into a restarted engine: transport
 *                     play / pause / step skipped (the clock restarts stopped),
 *                     view controls replayed only as their LAST value (per
 *                     viewport for setViewport / closeViewport), each at its own
 *                     place in the log
 *
 * Bytes stay encoded: only the envelope is peeked (engineFraming.ts), so main
 * still never decodes a document. The recorded request carries MAIN's seq
 * (engineHost renumbers every window's requests).
 */

import { peekRequest, responseIsError, startJobIdFromResponse } from './engineFraming';

/** Command ids (packages/engine-api/schema: the Command union's field numbers). */
export const CMD = {
  newProject: 10,
  play: 800,
  pause: 801,
  seek: 802,
  step: 803,
  setLoop: 804,
  setPreviewQuality: 805,
  setActiveComposition: 807,
  setViewport: 808,
  closeViewport: 809,
  setViewerLut: 815,
  startJob: 850,
  applyJobResult: 852,
} as const;

/**
 * Not replayed: transport (the clock restarts stopped) and startJob — a job's
 * only effect on the document is the edit it applies, which the engine sends
 * as a log record (absorbJobEdit). Replaying startJob would run a finished job
 * again, or apply a cancelled / failed / still-held one.
 */
const REPLAY_SKIP = new Set<number>([CMD.play, CMD.pause, CMD.step, CMD.startJob]);
const LAST_ONLY = new Set<number>([CMD.seek, CMD.setActiveComposition, CMD.setPreviewQuality, CMD.setLoop, CMD.setViewerLut]);

export interface LoggedRequest {
  /** The encoded EngineMessage{request} as it was sent to the engine. */
  bytes: Uint8Array;
  /** The document revision the engine answered with. */
  revisionAfter: number;
  /** Command id (undefined for a batch). */
  commandId?: number;
  /** Supersession key for view controls ('' = none). */
  key: string;
  /** Set on startJob, from the response's JobRef, so a later log record can replace that one job. */
  jobId?: string;
}

export class EngineCommandLog {
  private entries: LoggedRequest[] = [];

  constructor(private readonly enabled = true) {}

  get length(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  /** Record one answered request (both encoded). Queries and errors are not recorded. */
  record(request: Uint8Array, response: Uint8Array, revisionAfter: number): void {
    if (!this.enabled) return;
    const req = peekRequest(request);
    if (!req || req.body === 'query') return;
    if (responseIsError(response) !== false) return;
    const id = req.commandId;
    // The engine sent the job's commands as a log record just before this
    // answer (absorbJobEdit); the applyJobResult itself has nothing to replay.
    if (id === CMD.applyJobResult) return;
    if (id === CMD.newProject) this.entries = [];
    let key = '';
    if (id === CMD.setViewport || id === CMD.closeViewport) key = `viewport:${req.firstVarint ?? 0}`;
    else if (id !== undefined && LAST_ONLY.has(id)) key = `cmd:${id}`;
    const jobId = id === CMD.startJob ? startJobIdFromResponse(response) ?? undefined : undefined;
    this.entries.push({
      bytes: Uint8Array.from(request),
      revisionAfter,
      ...(id !== undefined ? { commandId: id } : {}),
      key,
      ...(jobId ? { jobId } : {}),
    });
  }

  /**
   * A job finished and the engine sent the edit it applied. Drop that job's
   * startJob (replay must not run the job again) and append the applied
   * request where the edit landed.
   */
  absorbJobEdit(request: Uint8Array, revisionAfter: number, job?: string): void {
    if (!this.enabled) return;
    const idx = job
      ? this.entries.findIndex((e) => e.commandId === CMD.startJob && e.jobId === job)
      : this.entries.findIndex((e) => e.commandId === CMD.startJob);
    if (idx >= 0) this.entries.splice(idx, 1);
    const peek = peekRequest(request);
    if (!peek || peek.body === 'query') return;
    this.entries.push({
      bytes: Uint8Array.from(request),
      revisionAfter,
      ...(peek.commandId !== undefined ? { commandId: peek.commandId } : {}),
      key: '',
    });
  }

  /** What a restarted engine is sent, in order (see the file header). */
  plan(): LoggedRequest[] {
    const last = new Map<string, number>();
    this.entries.forEach((e, i) => {
      if (e.key) last.set(e.key, i);
    });
    return this.entries.filter((e, i) => {
      if (e.commandId !== undefined && REPLAY_SKIP.has(e.commandId)) return false;
      return !e.key || last.get(e.key) === i;
    });
  }
}
