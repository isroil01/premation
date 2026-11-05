/**
 * UI store — ephemeral, non-persisted UI state.
 *
 * Holds things that don't belong in the panel or preference stores: focus,
 * hover, transient modals, tooltips, drag state. Anything a single user
 * action would set then immediately unset.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { subscribeWithSelector } from 'zustand/middleware';
import type { Disposable } from '@app-types/common';
import type { PinKind } from '@core/rig/puppet';

/**
 * Which of AE's two right-hand column blocks the timeline shows.
 *
 * AE's "Toggle Switches / Modes" button, and the reason its panel fits: the
 * layer switches (shy · fx · blur · adjustment · guide · T · 3D) and the mode
 * columns (Mode · TrkMat · Parent) occupy the same horizontal space, and you
 * see one set at a time. Ours used to render both unconditionally, which needs
 * ~760px of header — so at any normal panel width Mode, TrkMat and Parent were
 * pushed off the right edge and could not be reached at all.
 */
export type TimelineColumns = 'switches' | 'modes' | 'both';

/**
 * What the timeline's "what changed" lane is diffing against.
 *
 * TIMELINE-HEAT-ANCHOR. `off` costs nothing; the other two make `changeHeat`
 * fingerprint the document against a baseline on a throttle.
 */
export type TimelineHeatSource = 'off' | 'save' | 'ai';

export type BoneRigMode = 'draw' | 'pose' | 'weights';
export type BoneWeightMode = 'add' | 'subtract' | 'smooth' | 'pick';

export type Tool =
  | 'select'
  | 'direct-select'
  | 'rotate'
  | 'pan-behind'
  | 'hand'
  | 'zoom'
  | 'move'
  | 'pen'
  | 'pencil'
  | 'brush'
  // AE's Paint effect — strokes onto an EXISTING layer. Split out of `brush`,
  // which used to switch between the two based on what happened to be under
  // the cursor, so a second brush stroke silently became a paint stroke.
  | 'paint'
  // Paint with `mode: 'erase'` forced. Not a checkbox on the brush: an eraser
  // that can lay down colour because a shared setting was left on is not an
  // eraser, it is a trap.
  | 'eraser'
  | 'curvature'
  | 'line'
  // Drag a line across a shape layer: every crossing splits its path. Lives
  // beside the pen tools because it EDITS an outline rather than creating one.
  | 'knife'
  // SDK 1.4 (U): a native plugin's viewer tool (`pluginTool` says which); its drags go to the plugin.
  | 'plugin-tool'
  | 'text'
  // AE's Vertical Type Tool (Ctrl+T cycles it with the horizontal one).
  | 'vertical-text'
  | 'shape'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'mask-rect'
  | 'mask-ellipse'
  // The pen, aimed at the selected layer's masks. The plain `pen` used to do
  // this implicitly whenever exactly one layer was selected — which, because
  // drawing selects what it draws, was always.
  | 'mask-pen'
  // AE's Pen flyout: vertex tools that do one thing wherever they land, and
  // the Mask Feather tool (G cycles Pen ⇄ Mask Feather).
  | 'add-vertex'
  | 'delete-vertex'
  | 'convert-vertex'
  | 'mask-feather'
  | 'puppet-pin'
  | 'bone'
  // Roto Brush: paint foreground / background strokes on a footage layer and
  // the segmenter writes the matte as a mask path. The HOST owns the gesture
  // (`RotoBrushOverlay`), like puppet-pin and bone.
  | 'roto'
  // AE 26's Object Matte tool: hover a subject to preview its matte, click
  // (or drag a box) to select it, Shift / Alt-click to add / subtract. The
  // host owns the gesture (`ObjectMatteOverlay`); propagation and Freeze are
  // the Roto Brush's (same store, same engine job).
  | 'object-matte'
  // The rest of AE 26's Object Matte group: paint the selection exactly
  // (no edge snapping), and paint over hair to set the refine-edge radius.
  // Both are host gestures in RotoBrushOverlay, like the Roto Brush
  // (which the group calls Quick Selection).
  | 'selection-brush'
  | 'refine-edge';

interface UIState {
  /** Active tool in the toolbar. */
  activeTool: Tool;
  /** SDK 1.4 (U): the plugin tool while `activeTool` is `plugin-tool`. */
  pluginTool: { id: string; plugin: string; tool: string; command: string; name: string } | null;
  setPluginTool: (tool: { id: string; plugin: string; tool: string; command: string; name: string }) => void;
  /**
   * Armed Puppet pin variant while `activeTool` is `puppet-pin`.
   * Default is Position — the same first tool AE's flyout highlights.
   */
  puppetPinKind: PinKind;
  /**
   * Puppet tool option: a pin drag / typed pin value always writes a keyframe at
   * the playhead (After Effects: pins are animated from the moment they move).
   * Off, pins follow the app's rule — a key when the property is animated or
   * auto-keyframe is on, else the static value.
   */
  puppetAlwaysKey: boolean;
  /** Bone workflow mode: construct, animate, or bind the deformation mesh. */
  boneRigMode: BoneRigMode;
  /** Brush/picker armed while `boneRigMode === 'weights'`. */
  boneWeightMode: BoneWeightMode;
  /** Screen-pixel brush radius; intentionally independent of camera zoom. */
  boneBrushRadius: number;
  /** Whether the user is currently dragging. */
  isDragging: boolean;
  /** Generic "toast"-style notifications. */
  notifications: ReadonlyArray<Notification>;
  /** The status bar is mounted, so routine notices have a place to appear other than a card. */
  noticeLineMounted: boolean;
  /** Snap-to-grid / snap-to-object enabled. */
  snap: boolean;
  /** Whether the graph editor is currently open. */
  graphEditorOpen: boolean;
  /** Whether the global Shy layers toggle is active. */
  globalShy: boolean;
  /** AE's Toggle Switches / Modes — which right-hand column block is shown. */
  timelineColumns: TimelineColumns;
  /**
   * TIMELINE-HEAT-ANCHOR — the "what changed" lane's source.
   *
   * `off` is the default and the only state that costs nothing: the other two
   * make the lane diff the document against a baseline (see `changeHeat.ts`).
   * `save` tints what has moved since the last save or open; `ai` tints what
   * the most recent AI run touched.
   */
  timelineHeatSource: TimelineHeatSource;
  /** TIMELINE-TRANSCRIPT-LANE-ANCHOR — show the word lane under the ruler. */
  timelineTranscriptLane: boolean;
  /**
   * Long-running background work — a render, a cache pass, a transcription, a
   * model download. Each job owns ONE progress toast for its lifetime and is
   * mirrored into the status-bar tray, which reads this list directly.
   */
  jobs: ReadonlyArray<Job>;
  /**
   * When the crash-recovery autosave last wrote a snapshot (epoch ms), or
   * null if it has not yet this session. The status bar shows it; the Files
   * tab of Preferences shows it in full.
   */
  lastAutosaveAt: number | null;
}

/** Where a job is. `running` is the only state the tray animates. */
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  label: string;
  status: JobStatus;
  /** 0–1, or indeterminate while the total is unknown. */
  progress: number | 'indeterminate';
  startedAt: number;
  finishedAt?: number;
  /** The closing line — "Written to renders/out.mp4", the error message. */
  message?: string;
  action?: Notification['action'];
  /** The toast this job drives, so progress writes land on one card. */
  toastId?: string;
  /** What sort of work, for the Tasks panel's icon. Absent reads as `other`. */
  kind?: JobKind;
  /** The live status line while running ("Frame 120 of 300"), under the label. */
  statusLine?: string;
  /** A failed job's error text (the outcome's detail, else its message). */
  error?: string;
  /**
   * Stop the work. Present only when the starter has a real handle (an engine
   * job's `cancel`, a download's `cancelDownload`); the Tasks panel shows its
   * × only then. The job stays `running` until the starter calls `finishJob`.
   */
  cancel?: () => void;
  /** `cancelJob` was called; the starter reports the stop as `cancelled`. */
  cancelRequested?: boolean;
  /** When `progress` last changed to a number (the ETA's "now" sample). */
  progressAt?: number;
  /**
   * The ETA's baseline: the first numeric sample after the warm-up
   * (`ETA_WARMUP_MS` and `ETA_WARMUP_PROGRESS`), so a slow first frame or a
   * file open does not skew the rate.
   */
  etaFrom?: { at: number; progress: number };
}

/** What a job is doing — picks its icon in the Tasks panel. */
export type JobKind = 'export' | 'render' | 'download' | 'transcribe' | 'import' | 'analysis' | 'other';

/** The fields a starter may set on a running job. */
export interface JobPatch {
  progress?: number | 'indeterminate';
  label?: string;
  statusLine?: string;
  cancel?: () => void;
}

/**
 * Routine feedback ("Deleted selected layers", "Imported 2 files", a job's
 * progress): the status bar says it and the work goes on, as After Effects' Info
 * panel does. Only warnings and errors are cards over the work (NotificationHost).
 */
export function isQuietNotification(n: Pick<Notification, 'level'>): boolean {
  return n.level === 'info' || n.level === 'success';
}

/** The newest routine notice for the status bar; a job's progress is the job tray's. */
export function latestQuietNotification(s: { notifications: ReadonlyArray<Notification> }): Notification | null {
  for (let i = s.notifications.length - 1; i >= 0; i--) {
    const n = s.notifications[i]!;
    if (isQuietNotification(n) && n.progress === undefined) return n;
  }
  return null;
}

export interface Notification {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  /** Auto-dismiss after this many ms. 0 means manual dismiss only. */
  durationMs: number;
  createdAt: number;
  /**
   * One optional inline action.
   *
   * For the small class of notice that a user should be able to ACT on without
   * hunting for where. A modal would interrupt; a toast with no action is a
   * dead end.
   *
   * "Update ready ▸ Restart now" was the case this was built for and is no
   * longer one of them: a pending update outlives any toast, and a notice the
   * user can dismiss while the fact stays true is a notice that lies. It is a
   * persistent title-bar button now (`UpdateButton`). What belongs here is the
   * genuinely transient — something that HAPPENED and has a follow-up.
   *
   * One action, not a list: a toast with a row of buttons is a dialog wearing a
   * disguise, and the whole point is not to block.
   */
  action?: {
    label: string;
    onSelect(): void;
  };
  /**
   * Progress for work that is still happening: 0–1 draws a bar, `indeterminate`
   * draws a sweep. Absent means the toast is a plain notice.
   */
  progress?: number | 'indeterminate';
  /**
   * Stays until dismissed or until its job finishes, whatever `durationMs`
   * says. A progress toast is sticky by construction — dismissing "Rendering…
   * 40%" on a timer would tell the user the render stopped.
   */
  sticky?: boolean;
  /**
   * Collapse key. Toasts sharing a group replace one another rather than
   * stacking: ten "Cached 12 frames" notices are one notice that changed.
   */
  group?: string;
  /** Optional second line — an error's detail, a file path. */
  detail?: string;
}

/** What `finishJob` needs to say about how the work ended. */
export interface JobOutcome {
  status: Exclude<JobStatus, 'running'>;
  message?: string;
  detail?: string;
  action?: Notification['action'];
}

interface UIActions {
  setActiveTool(tool: Tool): void;
  setPuppetPinKind(kind: PinKind): void;
  setPuppetAlwaysKey(on: boolean): void;
  setBoneRigMode(mode: BoneRigMode): void;
  setBoneWeightMode(mode: BoneWeightMode): void;
  setBoneBrushRadius(radius: number): void;
  setDragging(isDragging: boolean): void;
  notify(notification: Omit<Notification, 'id' | 'createdAt'>): string;
  /** Patch a live toast in place — progress, message, action. No-op if gone. */
  updateNotification(id: string, patch: Partial<Omit<Notification, 'id' | 'createdAt'>>): void;
  dismissNotification(id: string): void;
  setNoticeLineMounted(mounted: boolean): void;
  /**
   * Begin a background job: adds it to the tray and opens its progress toast.
   * Re-using an id restarts that job (the previous toast is replaced).
   */
  startJob(job: {
    id: string;
    label: string;
    progress?: number | 'indeterminate';
    kind?: JobKind;
    statusLine?: string;
    /** Register the stop handle here, or later through `updateJob`. */
    cancel?: () => void;
  }): void;
  /**
   * Patch a running job. Coalesced to `JOB_UPDATE_INTERVAL_MS` per job (about
   * 4 Hz): a download's progress events arrive far faster than anyone reads a
   * bar, and each write re-renders the tray, the toast and the Tasks panel.
   * A patch carrying `cancel` is applied at once.
   */
  updateJob(id: string, patch: JobPatch): void;
  /**
   * End a job. The progress toast is dismissed and, unless the job was
   * cancelled silently, a closing toast is shown with the outcome and its one
   * follow-up action ("Reveal file", "Retry"). The finished job stays in
   * `jobs` as history for the Tasks panel (the newest `MAX_FINISHED_JOBS`).
   */
  finishJob(id: string, outcome: JobOutcome): void;
  /** Ask a running job to stop through its `cancel` handle. No-op without one. */
  cancelJob(id: string): void;
  /** Drop a finished job from the history now. */
  clearJob(id: string): void;
  /** Drop every finished job (the Tasks panel's "Clear finished"). */
  clearFinishedJobs(): void;
  setLastAutosaveAt(at: number | null): void;
  toggleSnap(): void;
  setGraphEditorOpen(open: boolean): void;
  setGlobalShy(open: boolean): void;
  setTimelineColumns(columns: TimelineColumns): void;
  /** AE's button: Switches → Modes → Both → Switches. */
  cycleTimelineColumns(): void;
  setTimelineHeatSource(source: TimelineHeatSource): void;
  /** off → since save → last AI run → off. */
  cycleTimelineHeatSource(): void;
  setTimelineTranscriptLane(on: boolean): void;
}

export type UIStore = UIState & UIActions;

/** How many finished jobs the Tasks panel keeps as history. */
export const MAX_FINISHED_JOBS = 20;
/** Minimum gap between two applied `updateJob` patches of one job (~4 Hz). */
export const JOB_UPDATE_INTERVAL_MS = 250;
/** No time-remaining estimate before this much of the job has run… */
export const ETA_WARMUP_MS = 1500;
/** …or before this much progress: the first frames are rarely the typical ones. */
export const ETA_WARMUP_PROGRESS = 0.03;

/**
 * Time left on a running job in ms, from its progress rate since the warm-up
 * baseline (`etaFrom`) — null while there is nothing honest to say: an
 * indeterminate job, one still warming up, or one that has not moved since.
 * The time since the last sample is taken off, so the figure keeps counting
 * down between sparse updates (never below zero).
 */
export function estimateJobRemainingMs(job: Job, now: number): number | null {
  if (job.status !== 'running' || typeof job.progress !== 'number') return null;
  if (job.progress >= 1) return 0;
  const from = job.etaFrom;
  const at = job.progressAt;
  if (!from || at === undefined) return null;
  const dp = job.progress - from.progress;
  const dt = at - from.at;
  if (dp <= 0 || dt <= 0) return null;
  const remaining = ((1 - job.progress) * dt) / dp - Math.max(0, now - at);
  return Math.max(0, remaining);
}

/** Whether `cancelJob` was called for the running job `id` (starters use it to report `cancelled`). */
export function isJobCancelRequested(id: string): boolean {
  return useUIStore.getState().jobs.some((j) => j.id === id && j.status === 'running' && j.cancelRequested === true);
}

/* Per-job coalescing of `updateJob` (module state: timers are not UI state). */
const pendingJobPatches = new Map<string, { patch: JobPatch; timer: ReturnType<typeof setTimeout> }>();
const lastJobFlushAt = new Map<string, number>();

function dropPendingJobPatch(id: string): JobPatch | undefined {
  const pending = pendingJobPatches.get(id);
  if (!pending) return undefined;
  clearTimeout(pending.timer);
  pendingJobPatches.delete(id);
  return pending.patch;
}

/** Keep the newest `MAX_FINISHED_JOBS` finished jobs; running ones always stay. */
function trimFinished(jobs: Job[]): Job[] {
  const finished = jobs.filter((j) => j.status !== 'running');
  if (finished.length <= MAX_FINISHED_JOBS) return jobs;
  const keep = new Set(
    [...finished].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, MAX_FINISHED_JOBS),
  );
  return jobs.filter((j) => j.status === 'running' || keep.has(j));
}

export const useUIStore = create<UIStore>()(
  subscribeWithSelector(
    immer((set) => ({
      activeTool: 'select',
      pluginTool: null,
      puppetPinKind: 'position',
      puppetAlwaysKey: true,
      boneRigMode: 'draw',
      boneWeightMode: 'add',
      boneBrushRadius: 40,
      isDragging: false,
      notifications: [],
      noticeLineMounted: false,
      snap: true,
      graphEditorOpen: false,
      globalShy: false,
      // Both, not 'modes': the toggle exists so the panel CAN be narrowed, not
      // so it starts with controls missing. Defaulting to 'modes' hid every
      // per-layer switch (shy · fx · blur · adjustment · guide · T · 3D) until
      // you found the button, which is a worse first run than a wide header.
      timelineColumns: 'both',
      timelineHeatSource: 'off',
      timelineTranscriptLane: false,
      jobs: [],
      lastAutosaveAt: null,

      setActiveTool: (tool) =>
        set((s) => {
          s.activeTool = tool;
        }),
      setPluginTool: (tool) =>
        set((s) => {
          s.pluginTool = tool;
          s.activeTool = 'plugin-tool';
        }),
      setPuppetPinKind: (kind) =>
        set((s) => {
          s.puppetPinKind = kind;
        }),
      setPuppetAlwaysKey: (on) =>
        set((s) => {
          s.puppetAlwaysKey = on;
        }),
      setBoneRigMode: (mode) =>
        set((s) => {
          s.boneRigMode = mode;
        }),
      setBoneWeightMode: (mode) =>
        set((s) => {
          s.boneWeightMode = mode;
        }),
      setBoneBrushRadius: (radius) =>
        set((s) => {
          s.boneBrushRadius = Math.max(4, Math.min(400, radius));
        }),
      setDragging: (isDragging) =>
        set((s) => {
          s.isDragging = isDragging;
        }),
      notify: (n) => {
        const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        // A progress toast is sticky whatever the caller said — see `sticky`.
        const sticky = n.sticky ?? n.progress !== undefined;
        set((s) => {
          // One toast per group: the newer notice REPLACES the older one in
          // its slot rather than stacking under it.
          if (n.group) s.notifications = s.notifications.filter((x) => x.group !== n.group);
          s.notifications.push({
            ...n,
            sticky,
            id,
            createdAt: Date.now(),
          });
        });
        if (n.durationMs > 0 && !sticky) {
          window.setTimeout(() => {
            useUIStore.getState().dismissNotification(id);
          }, n.durationMs);
        }
        return id;
      },
      updateNotification: (id, patch) =>
        set((s) => {
          const n = s.notifications.find((x) => x.id === id);
          if (n) Object.assign(n, patch);
        }),
      dismissNotification: (id) =>
        set((s) => {
          s.notifications = s.notifications.filter((n) => n.id !== id);
        }),

      setNoticeLineMounted: (mounted) =>
        set((s) => {
          s.noticeLineMounted = mounted;
        }),

      startJob: ({ id, label, progress = 'indeterminate', kind, statusLine, cancel }) => {
        dropPendingJobPatch(id);
        lastJobFlushAt.delete(id);
        const prev = useUIStore.getState().jobs.find((j) => j.id === id);
        if (prev?.toastId) useUIStore.getState().dismissNotification(prev.toastId);
        const toastId = useUIStore.getState().notify({
          level: 'info',
          message: label,
          durationMs: 0,
          progress,
          sticky: true,
          group: `job:${id}`,
        });
        const startedAt = Date.now();
        set((s) => {
          // A finished run under the same id (the Export panel reuses one) is
          // history: it stays, renamed, so the restart does not erase it.
          const rest = s.jobs.flatMap((j) => {
            if (j.id !== id) return [j];
            return j.status === 'running' ? [] : [{ ...j, id: `${j.id}#${j.finishedAt ?? j.startedAt}` }];
          });
          const job: Job = { id, label, status: 'running', progress, startedAt, toastId };
          if (kind !== undefined) job.kind = kind;
          if (statusLine !== undefined) job.statusLine = statusLine;
          if (cancel !== undefined) job.cancel = cancel;
          if (typeof progress === 'number') job.progressAt = startedAt;
          s.jobs = [...rest, job];
        });
      },
      updateJob: (id, patch) => {
        const job = useUIStore.getState().jobs.find((j) => j.id === id);
        if (!job || job.status !== 'running') return;
        const now = Date.now();
        const queued = pendingJobPatches.get(id);
        if (queued) {
          queued.patch = { ...queued.patch, ...patch };
          if (patch.cancel !== undefined) flushJobPatch(id);
          return;
        }
        const last = lastJobFlushAt.get(id);
        if (last === undefined || now - last >= JOB_UPDATE_INTERVAL_MS || patch.cancel !== undefined) {
          lastJobFlushAt.set(id, now);
          applyJobPatch(id, patch, now);
          return;
        }
        const timer = setTimeout(() => flushJobPatch(id), JOB_UPDATE_INTERVAL_MS - (now - last));
        pendingJobPatches.set(id, { patch, timer });
      },
      finishJob: (id, outcome) => {
        // The last progress write first, so a coalesced label is not lost.
        flushJobPatch(id);
        lastJobFlushAt.delete(id);
        const job = useUIStore.getState().jobs.find((j) => j.id === id);
        if (!job) return;
        if (job.toastId) useUIStore.getState().dismissNotification(job.toastId);
        const finishedAt = Date.now();
        set((s) => {
          const j = s.jobs.find((x) => x.id === id);
          if (!j) return;
          j.status = outcome.status;
          j.finishedAt = finishedAt;
          j.progress = outcome.status === 'done' ? 1 : j.progress;
          j.toastId = undefined;
          j.cancel = undefined;
          if (outcome.message !== undefined) j.message = outcome.message;
          if (outcome.action !== undefined) j.action = outcome.action;
          if (outcome.status === 'failed') {
            const error = outcome.detail ?? outcome.message;
            if (error !== undefined) j.error = error;
          }
          s.jobs = trimFinished(s.jobs);
        });
        // A cancelled job with nothing to say is not news.
        if (outcome.message) {
          useUIStore.getState().notify({
            level: outcome.status === 'done' ? 'success' : outcome.status === 'failed' ? 'error' : 'info',
            message: outcome.message,
            durationMs: outcome.status === 'failed' ? 8000 : 4200,
            group: `job:${id}`,
            ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
            ...(outcome.action !== undefined ? { action: outcome.action } : {}),
          });
        }
      },
      cancelJob: (id) => {
        const job = useUIStore.getState().jobs.find((j) => j.id === id);
        if (!job || job.status !== 'running' || !job.cancel || job.cancelRequested) return;
        const cancel = job.cancel;
        set((s) => {
          const j = s.jobs.find((x) => x.id === id);
          if (j) j.cancelRequested = true;
        });
        try {
          cancel();
        } catch {
          /* a handle that throws has nothing left to stop; the starter still reports the outcome */
        }
      },
      clearJob: (id) =>
        set((s) => {
          // Only a FINISHED job clears; a running one is still the tray's business.
          s.jobs = s.jobs.filter((j) => j.id !== id || j.status === 'running');
        }),
      clearFinishedJobs: () =>
        set((s) => {
          s.jobs = s.jobs.filter((j) => j.status === 'running');
        }),
      setLastAutosaveAt: (at) =>
        set((s) => {
          s.lastAutosaveAt = at;
        }),
      toggleSnap: () =>
        set((s) => {
          s.snap = !s.snap;
        }),
      setGraphEditorOpen: (open) =>
        set((s) => {
          s.graphEditorOpen = open;
        }),
      setGlobalShy: (open) =>
        set((s) => {
          s.globalShy = open;
        }),
      setTimelineColumns: (columns) =>
        set((s) => {
          s.timelineColumns = columns;
        }),
      cycleTimelineColumns: () =>
        set((s) => {
          s.timelineColumns =
            s.timelineColumns === 'switches'
              ? 'modes'
              : s.timelineColumns === 'modes'
                ? 'both'
                : 'switches';
        }),
      setTimelineHeatSource: (source) =>
        set((s) => {
          s.timelineHeatSource = source;
        }),
      cycleTimelineHeatSource: () =>
        set((s) => {
          // off → save → ai → off. `off` is in the cycle rather than needing a
          // second control: the lane is a review aid you turn on for a minute,
          // and a toggle you cannot switch back off from the same button is
          // the one people complain about.
          s.timelineHeatSource =
            s.timelineHeatSource === 'off' ? 'save' : s.timelineHeatSource === 'save' ? 'ai' : 'off';
        }),
      setTimelineTranscriptLane: (on) =>
        set((s) => {
          s.timelineTranscriptLane = on;
        }),
    })),
  ),
);

/** Apply a queued `updateJob` patch now (finishJob, a `cancel` patch, the timer). */
function flushJobPatch(id: string): void {
  const patch = dropPendingJobPatch(id);
  if (!patch) return;
  const now = Date.now();
  lastJobFlushAt.set(id, now);
  applyJobPatch(id, patch, now);
}

/** One store write (and one toast write) for a coalesced patch. */
function applyJobPatch(id: string, patch: JobPatch, now: number): void {
  const job = useUIStore.getState().jobs.find((j) => j.id === id);
  if (!job || job.status !== 'running') return;
  useUIStore.setState((s) => {
    const j = s.jobs.find((x) => x.id === id);
    if (!j) return;
    if (patch.progress !== undefined) {
      j.progress = patch.progress;
      if (typeof patch.progress === 'number') {
        j.progressAt = now;
        // The baseline is the first sample past the warm-up, never earlier.
        if (!j.etaFrom && now - j.startedAt >= ETA_WARMUP_MS && patch.progress >= ETA_WARMUP_PROGRESS) {
          j.etaFrom = { at: now, progress: patch.progress };
        }
      }
    }
    if (patch.label !== undefined) j.label = patch.label;
    if (patch.statusLine !== undefined) j.statusLine = patch.statusLine;
    if (patch.cancel !== undefined) j.cancel = patch.cancel;
  });
  if (job.toastId && (patch.progress !== undefined || patch.label !== undefined)) {
    useUIStore.getState().updateNotification(job.toastId, {
      ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
      ...(patch.label !== undefined ? { message: patch.label } : {}),
    });
  }
}

/** Subscribe to a slice without React — for engines. */
export function subscribeUI(
  selector: (s: UIState) => unknown,
  listener: () => void,
): Disposable {
  const unsub = useUIStore.subscribe(selector, listener);
  return { dispose: unsub };
}
