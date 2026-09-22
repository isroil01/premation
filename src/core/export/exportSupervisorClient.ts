/**
 * The editor's typed client for the main-owned export queue.
 *
 * Main renders each job in a hidden window of its own (electron/exportProcess.ts);
 * the editor's part is small and this module is all of it: build a spec from
 * the form's choices, write a snapshot of the project where main said to,
 * enqueue, and watch. Nothing here holds a frame, a sink or a window, which is
 * the point — close this window and the job carries on.
 *
 * Plain functions over the bridge, no React and no store (see CLAUDE.md's
 * layering): `exportQueueStore` mirrors the queue for the UI on top of this,
 * and `exportSupervisorClient.test.ts` drives it with a fake bridge.
 */

import type {
  ExportJobRecord,
  ExportJobSpec,
  ExportJobStatus,
  ExportQueueEvent,
} from '@app-types/motionEditor';
import type { RenderJobSpec } from '@core/export/renderJob';
import { frameRangeToSeconds } from '@core/cli/headlessRender';

export type { ExportJobRecord, ExportJobSpec, ExportJobStatus, ExportQueueEvent };

type Bridge = NonNullable<NonNullable<Window['motionEditor']>['exportSupervisor']>;

/** The bridge, when this build has one with every verb the client needs. */
function bridge(): Required<Bridge> | null {
  const b = typeof window !== 'undefined' ? window.motionEditor?.exportSupervisor : undefined;
  if (
    !b?.reserve || !b.enqueue || !b.cancel || !b.retry || !b.setPriority || !b.remove
    || !b.list || !b.subscribe || !b.chooseOutputPath || !b.onEvent
  ) return null;
  return b as Required<Bridge>;
}

/** Whether the out-of-process export exists in this build (desktop with the bridge). */
export function exportSupervisorAvailable(): boolean {
  return bridge() !== null;
}

const STATUSES: ReadonlySet<string> = new Set<ExportJobStatus>([
  'queued', 'preparing', 'rendering', 'encoding', 'completed', 'failed', 'cancelled',
]);

/**
 * Is this thing from IPC actually a job record?
 *
 * Main is our own process, but it is a different build target with its own
 * copy of the type, and a record shape that drifted would otherwise reach a
 * component as `undefined.frame`. Checked once here, at the boundary.
 */
export function isExportJobRecord(v: unknown): v is ExportJobRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const spec = r['spec'] as Record<string, unknown> | undefined;
  const p = r['progress'] as Record<string, unknown> | undefined;
  return (
    typeof r['id'] === 'string'
    && typeof r['status'] === 'string' && STATUSES.has(r['status'])
    && typeof r['priority'] === 'number'
    && typeof r['createdAt'] === 'number'
    && !!spec && typeof spec['outPath'] === 'string' && typeof spec['label'] === 'string'
    && !!p && typeof p['fraction'] === 'number' && typeof p['frame'] === 'number' && typeof p['totalFrames'] === 'number'
  );
}

/** A terminal job: nothing more will happen to it. */
export function isFinishedStatus(status: ExportJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** A job that is holding a render window, or waiting for one. */
export function isLiveStatus(status: ExportJobStatus): boolean {
  return !isFinishedStatus(status);
}

/**
 * The inputs the Export form has, in the shape a supervisor job needs.
 *
 * Deliberately the same numbers `queueJob` captures for the Render Queue: the
 * range in seconds (end exclusive), the output size, the comp's own size, and
 * everything captured at click time rather than read live mid-render.
 */
export interface SupervisorSpecInput {
  compositionId: string;
  compositionName: string;
  format: string;
  width: number;
  height: number;
  fps: number;
  /** Export range in seconds, end exclusive. */
  range: { startSec: number; endSec: number };
  quality: 'high' | 'medium' | 'draft';
  proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444';
  transparent: boolean;
  videoEncoder?: RenderJobSpec['videoEncoder'];
  chapters?: RenderJobSpec['chapters'];
  /** The snapshot main reserved and the editor wrote. */
  projectPath: string;
  /** Where the finished file goes. */
  outPath: string;
}

/**
 * The frame range as the CLI request wants it — inclusive frame indices —
 * derived so that `frameRangeToSeconds` on the other side gives back exactly
 * the seconds the form captured. A range of 0–1 s at 24 fps is frames 0–23:
 * 24 frames, not 25, which is the off-by-one the export path has had before.
 */
export function frameRangeFor(range: { startSec: number; endSec: number }, fps: number): { startFrame: number; endFrame: number } {
  const startFrame = Math.max(0, Math.round(range.startSec * fps));
  const endFrame = Math.max(startFrame, Math.round(range.endSec * fps) - 1);
  return { startFrame, endFrame };
}

/** A queue job from the form's choices. Pure, so the mapping is testable. */
export function buildSupervisorSpec(input: SupervisorSpecInput): ExportJobSpec {
  const { startFrame, endFrame } = frameRangeFor(input.range, input.fps);
  // Round-trip check in the type: the seconds the window will compute from
  // these frames are the seconds that were captured here.
  void frameRangeToSeconds;
  const name = input.outPath.replace(/^.*[\\/]/, '');
  const spec: ExportJobSpec = {
    projectPath: input.projectPath,
    comp: input.compositionId,
    outPath: input.outPath,
    format: input.format,
    startFrame,
    endFrame,
    fps: input.fps,
    width: input.width,
    height: input.height,
    quality: input.quality,
    transparent: input.transparent,
    label: `${input.compositionName} → ${name}`,
    totalFrames: endFrame - startFrame + 1,
  };
  if (input.proresProfile) spec.proresProfile = input.proresProfile;
  if (input.videoEncoder) spec.videoEncoder = input.videoEncoder;
  if (input.chapters && input.chapters.length > 0) spec.chapters = input.chapters;
  return spec;
}

/** `Rendering 120 / 480 · 31.2 fps · 12s left` — the one line a row shows. */
export function describeProgress(job: ExportJobRecord): string {
  const p = job.progress;
  switch (job.status) {
    case 'queued': return job.attempts > 0 ? 'Queued again' : 'Queued';
    case 'preparing': return 'Opening the project…';
    case 'rendering': {
      const parts = [`Frame ${p.frame} / ${p.totalFrames}`];
      if (p.fps !== null) parts.push(`${p.fps.toFixed(1)} fps`);
      if (p.etaSec !== null) parts.push(`${formatEta(p.etaSec)} left`);
      return parts.join(' · ');
    }
    case 'encoding': return 'Finishing the encode…';
    case 'completed': return `Done · ${p.totalFrames} frames`;
    case 'failed': return job.error ?? 'Failed';
    case 'cancelled': return 'Cancelled';
  }
}

/** Seconds as `0:42` / `12:05` / `1:03:20`. */
export function formatEta(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** Everything a caller needs to put a job on the queue, in order. */
export interface EnqueueSteps {
  /** Ask where the file goes. Null when the user cancelled the dialog. */
  chooseOutputPath(defaultName: string): Promise<string | null>;
  /** Reserve an id and a snapshot path. */
  reserve(): Promise<{ id: string; projectPath: string }>;
  /** Write the project there — `ProjectManager.snapshotTo`. */
  enqueue(id: string, spec: ExportJobSpec, priority?: number): Promise<ExportJobRecord>;
}

function requireBridge(): Required<Bridge> {
  const b = bridge();
  if (!b) throw new Error('This build has no export supervisor.');
  return b;
}

export const exportSupervisorClient = {
  chooseOutputPath: (defaultName: string): Promise<string | null> => requireBridge().chooseOutputPath(defaultName),
  reserve: (): Promise<{ id: string; projectPath: string }> => requireBridge().reserve(),
  async enqueue(id: string, spec: ExportJobSpec, priority = 0): Promise<ExportJobRecord> {
    const job = await requireBridge().enqueue({ id, spec, priority });
    if (!isExportJobRecord(job)) throw new Error('The export queue returned something that is not a job.');
    return job;
  },
  cancel: (id: string): Promise<boolean> => requireBridge().cancel(id),
  async retry(id: string): Promise<ExportJobRecord | null> {
    const job = await requireBridge().retry(id);
    return isExportJobRecord(job) ? job : null;
  },
  setPriority: (id: string, priority: number): Promise<boolean> => requireBridge().setPriority(id, priority),
  remove: (id: string): Promise<boolean> => requireBridge().remove(id),
  async list(): Promise<ExportJobRecord[]> {
    const list = await requireBridge().list();
    return Array.isArray(list) ? list.filter(isExportJobRecord) : [];
  },
  /**
   * Start receiving pushes. Resolves the current queue so a late subscriber
   * (the editor reloaded mid-render) sees the running job, and returns the
   * unsubscribe. Events with a shape this side does not recognise are dropped.
   */
  async subscribe(onEvent: (event: ExportQueueEvent) => void): Promise<{ jobs: ExportJobRecord[]; unsubscribe: () => void }> {
    const b = requireBridge();
    const unsubscribe = b.onEvent((raw) => {
      const e = raw as ExportQueueEvent;
      if (!e || typeof e !== 'object') return;
      if (e.type === 'job' && isExportJobRecord(e.job)) onEvent(e);
      else if (e.type === 'snapshot' && Array.isArray(e.jobs)) onEvent({ type: 'snapshot', jobs: e.jobs.filter(isExportJobRecord) });
    });
    const list = await b.subscribe();
    return { jobs: Array.isArray(list) ? list.filter(isExportJobRecord) : [], unsubscribe };
  },
};
