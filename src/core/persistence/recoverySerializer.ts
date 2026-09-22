/**
 * Recovery snapshot serialisation — the pure-CPU half of an autosave.
 *
 * Runs in `recovery.worker.ts`, so the `JSON.stringify` + gzip of a large
 * document happens off the main thread. The same class runs inline when no
 * worker is available (Jest, a worker that failed to load) and for the one
 * write that cannot wait for a worker: the window closing.
 *
 * It imports nothing from the app at runtime (types only): pulling
 * `recovery.ts` in here would drag the whole editor into the worker bundle.
 *
 * ## Skipping an unchanged document
 *
 * The serializer remembers the last CONTENT it produced a body for (the
 * snapshot minus its wall-clock stamp) and answers `unchanged` when the next
 * job serialises to the same string — an exact comparison, not a hash, so a
 * changed document can never be mistaken for the stored one. The caller
 * decides whether that memory is still true of what is on disk (a clear, a
 * failed write or a write from the other serializer makes it stale) and sets
 * `force` when it is not.
 */

import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import type { RecoverySnapshot } from './recovery';

export interface RecoveryJob {
  seq: number;
  snap: RecoverySnapshot;
  /** Produce a body even if the content matches the last one. */
  force: boolean;
  /** Also produce today's plain-JSON folder copy (Preferences ▸ Files). */
  folder: boolean;
}

export type RecoveryJobResult =
  | { seq: number; status: 'unchanged' }
  | { seq: number; status: 'write'; body: string; folderJson?: string }
  | { seq: number; status: 'error'; error: string };

/** Body format tag: gzip of `{"v":1,"savedAt":…,"content":…}`, stored as a latin-1 string. */
const BODY_TAG = 'gz1:';

/** Everything a restore reads, without `savedAt` (which changes every tick). */
function contentJson(snap: RecoverySnapshot): string {
  return JSON.stringify(
    snap.doc
      ? { projectId: snap.projectId, project: snap.project, time: snap.time, doc: snap.doc }
      : { projectId: snap.projectId, project: snap.project, time: snap.time, scene: snap.scene, anim: snap.anim },
  );
}

export function encodeRecoveryBody(savedAt: number, content: string): string {
  const stamp = Number.isFinite(savedAt) ? savedAt : 0;
  const json = `{"v":1,"savedAt":${stamp},"content":${content}}`;
  // Level 3: most of the ratio (JSON is very repetitive) for a fraction of the
  // time level 9 costs — this also runs inline on window close.
  return BODY_TAG + strFromU8(gzipSync(strToU8(json), { level: 3 }), true);
}

function validProject(p: unknown): p is NonNullable<RecoverySnapshot['project']> {
  if (!p || typeof p !== 'object') return false;
  const { name, path } = p as { name?: unknown; path?: unknown };
  return typeof name === 'string' && (path === null || typeof path === 'string');
}

/** Decode a stored body; null for anything missing, foreign, truncated or corrupt. */
export function decodeRecoveryBody(body: string | null | undefined): RecoverySnapshot | null {
  if (typeof body !== 'string' || !body.startsWith(BODY_TAG)) return null;
  try {
    const json = strFromU8(gunzipSync(strToU8(body.slice(BODY_TAG.length), true)));
    const parsed = JSON.parse(json) as {
      v?: unknown;
      savedAt?: unknown;
      content?: Partial<RecoverySnapshot> & { doc?: RecoverySnapshot['doc'] };
    };
    const c = parsed?.content;
    if (parsed?.v !== 1 || !c || typeof c !== 'object' || typeof parsed.savedAt !== 'number') return null;
    // `scene`/`anim` are the pre-1.1 reader fields; for a document snapshot they
    // are the document's own parts, exactly as `captureRecovery` builds them.
    const scene = c.doc ? c.doc.scene : c.scene;
    const anim = c.doc ? c.doc.animation : c.anim;
    return {
      projectId: c.projectId,
      ...(validProject(c.project) ? { project: c.project } : {}),
      savedAt: parsed.savedAt,
      time: typeof c.time === 'number' ? c.time : 0,
      ...(c.doc ? { doc: c.doc } : {}),
      scene: scene as RecoverySnapshot['scene'],
      anim: anim as RecoverySnapshot['anim'],
    };
  } catch {
    return null;
  }
}

export class RecoverySerializer {
  private lastContent: string | null = null;

  run(job: RecoveryJob): RecoveryJobResult {
    try {
      const snap = job.snap;
      const content = contentJson(snap);
      if (!job.force && content === this.lastContent) return { seq: job.seq, status: 'unchanged' };
      const body = encodeRecoveryBody(snap.savedAt, content);
      this.lastContent = content;
      if (!job.folder) return { seq: job.seq, status: 'write', body };
      // The folder copy keeps the file format it has always had.
      const folderJson = JSON.stringify({
        projectId: snap.projectId,
        savedAt: snap.savedAt,
        time: snap.time,
        doc: snap.doc,
        scene: snap.scene,
        anim: snap.anim,
      });
      return { seq: job.seq, status: 'write', body, folderJson };
    } catch (err) {
      this.lastContent = null;
      return { seq: job.seq, status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
