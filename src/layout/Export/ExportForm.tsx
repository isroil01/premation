/**
 * ExportForm — pick a format, see exactly what will be written, export it.
 *
 * The preview is the point: every frame it shows comes from the real export path
 * (same snapshot builder, same comp scoping, same 1:1 comp→frame view), so a
 * render that would come out empty is visible here instead of in a media player.
 *
 * Nothing in this form blocks the editor. Frames are rasterised between yields
 * and, on the desktop, encoded by ffmpeg in a separate process.
 *
 * ── Two hosts, one form ──────────────────────────────────────────────────
 * This renders inside the Export DIALOG (the top-bar button) and inside the
 * docked Export PANEL (Window ▸ Export). The choices live in `exportFormStore`
 * so the two agree, and the actions come from `useExportModel` so each host
 * can put Export / Add to Queue in its own footer. `host` only changes layout:
 * the dialog has room for the preview beside the settings; the panel stacks.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { Icon } from '@components/Icon';
import { Switch } from '@components/Switch';
import { cn } from '@utils/cn';
import { useWorkspaceStore } from '@stores/projectStore';
import { usePlaybackClockStore } from '@stores/playbackClockStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { outputExtFor, type OutputFormat } from '@stores/renderQueueStore';
import { useLayoutStore } from '@stores/layoutStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { runExport, isAbortError, availableExportPresets, type ExportFormat, type ExportPreset } from '@core/export/exportManager';
import { canEncodeLocally, PRORES_PROFILE_LABELS, type ExportQuality, type ProresProfile } from '@core/export/videoSink';
import { chaptersFromMarkers, formatCarriesChapters, type ExportChapter } from '@core/export/chapters';
import { formatHdrCapabilityNote, formatHdrExportDoneNote } from '@core/export/hdrTransfer';
import { compSizeOf } from '@core/composition/compSizes';
import { openHelp } from '@layout/Help/openHelp';
import { getProjectManager } from '@core/services/coreServices';
import { buildSupervisorSpec, exportSupervisorClient } from '@core/export/exportSupervisorClient';
import { useExportQueueStore } from '@stores/exportQueueStore';
import { addToRenderQueue, shouldUseSupervisor } from './supervisorQueue';
import { ExportPreview } from './ExportPreview';
import { ExportQueueList } from './ExportQueueList';
import { useExportFormStore } from './exportFormStore';
import { loadRenderCapabilities, renderOnServer, serverEncodeFor, serverRenderAvailable } from './cloudRender';
import type { RenderCapabilities } from '@core/api/client';
import styles from './ExportDialog.module.css';
import { useState } from 'react';

const RES = [
  { label: 'Full', scale: 1 },
  { label: 'Half', scale: 0.5 },
  { label: 'Quarter', scale: 0.25 },
] as const;

const QUALITY: ReadonlyArray<{ value: ExportQuality; label: string; hint: string }> = [
  { value: 'high', label: 'High', hint: 'Best quality. Slowest encode, largest file.' },
  { value: 'medium', label: 'Medium', hint: 'Balanced — a good default for review copies.' },
  { value: 'draft', label: 'Draft', hint: 'Fast and visibly compressed. For checking timing.' },
];

const MOVING: ReadonlySet<ExportFormat> = new Set(['mp4', 'hdr10', 'hlg', 'webm', 'mov', 'gif']);
const QUEUEABLE: ReadonlySet<ExportFormat> = new Set(['mp4', 'hdr10', 'hlg', 'webm', 'mov', 'gif', 'png-sequence', 'jpg-sequence', 'exr-sequence']);
const RANGED: ReadonlySet<ExportFormat> = new Set(['mp4', 'hdr10', 'hlg', 'webm', 'mov', 'gif', 'wav', 'png-sequence', 'jpg-sequence', 'exr-sequence']);
const HAS_AUDIO: ReadonlySet<ExportFormat> = new Set(['mp4', 'hdr10', 'hlg', 'webm', 'mov', 'png-sequence', 'jpg-sequence', 'exr-sequence']);
const ALPHA_FORMATS: ReadonlySet<ExportFormat> = new Set(['webm', 'mov', 'png', 'png-sequence', 'gif', 'exr-sequence']);
const NON_RASTER: ReadonlySet<ExportFormat> = new Set(['wav', 'lottie', 'json', 'edl', 'otio', 'fcpxml', 'ale', 'mogrt']);

/** Explicit order (not Object.keys — numeric-looking keys re-sort): alpha-capable first, then by size. */
const PRORES_PROFILES: ReadonlyArray<ProresProfile> = ['4444', 'hq', '422', 'lt', 'proxy'];

const FORMAT_GROUPS: ReadonlyArray<{ id: string; label: string; formats: ExportFormat[] }> = [
  { id: 'video', label: 'Video', formats: ['mp4', 'hdr10', 'hlg', 'webm', 'mov', 'gif'] },
  { id: 'frames', label: 'Frames', formats: ['png-sequence', 'jpg-sequence', 'exr-sequence', 'png'] },
  { id: 'audio', label: 'Audio', formats: ['wav'] },
  { id: 'editorial', label: 'Editorial', formats: ['otio', 'fcpxml', 'edl', 'ale'] },
  { id: 'data', label: 'Data', formats: ['lottie', 'json', 'mogrt'] },
];

/** The job id the immediate export runs under — one at a time, by design. */
export const EXPORT_JOB_ID = 'export';

// The supervisor-or-window decision lives in ./supervisorQueue, shared with the
// Render Queue panel; re-exported so existing importers keep one name for it.
export { shouldUseSupervisor };

function dataPreviewMeta(format: ExportFormat): { icon: import('@components/Icon').IconName; title: string } {
  switch (format) {
    case 'wav': return { icon: 'audio', title: 'Audio Mixdown · WAV' };
    case 'lottie': return { icon: 'sparkles', title: 'Lottie Animation JSON' };
    case 'json': return { icon: 'file', title: 'Premation Project Document' };
    case 'otio': return { icon: 'layers', title: 'OpenTimelineIO Schema' };
    case 'fcpxml': return { icon: 'code', title: 'Final Cut Pro XML' };
    case 'edl': return { icon: 'layers', title: 'CMX 3600 Edit Decision List' };
    case 'ale': return { icon: 'file', title: 'Avid Log Exchange' };
    case 'mogrt': return { icon: 'component', title: 'Motion Graphics Template (.mogrt.zip)' };
    default: return { icon: 'file', title: 'Project document' };
  }
}

function fileStem(name: string): string {
  const trimmed = name.trim() || 'composition';
  return trimmed.replace(/[<>:"/\\|?*]+/g, '-');
}

/**
 * The comp's labelled markers as chapter marks on the DELIVERED file's clock.
 *
 * A work-area export starts at zero in the file, so a marker four seconds into
 * the comp becomes a chapter at `4 − startSec`, and a marker before the range
 * is not in the file at all (`chaptersFromMarkers` drops the negatives).
 *
 * Composition markers only: `getMarkers()` is the comp's own marker track,
 * where `getLayerMarkers()` would be a per-layer annotation that travels with a
 * trimmed layer — ten layers each carrying "start" would mint ten chapters over
 * the same second. Read at CALL time rather than cached, so what gets written
 * is what the timeline says when the button is pressed.
 */
function chaptersForRange(startSec: number, endSec: number, fps: number): ExportChapter[] {
  const shifted = getTimelineController()
    .getMarkers()
    .map((m) => ({ time: m.time - startSec, label: m.label }));
  return chaptersFromMarkers(shifted, fps, Math.max(0, endSec - startSec));
}

/** Whether the whole composition holds anything a chapter could be made of. */
function hasChapterMarkers(fps: number, durationSec: number): boolean {
  return chaptersForRange(0, durationSec, fps).length > 0;
}

export interface ExportModel {
  busy: boolean;
  progress: number | null;
  showQueue: boolean;
  outputName: string;
  activePreset: ExportPreset | undefined;
  doExport: () => Promise<void>;
  /** Queue the current choices; returns true when a job was added. */
  queueJob: () => boolean;
  cancel: () => void;
  /**
   * Render on the server, when this deployment has a render worker and the
   * project lives in the cloud. `null` when the option does not apply — the
   * hosts render no button rather than a disabled one, because "why is this
   * greyed out" has three different answers and none fits a tooltip.
   */
  serverRender: { label: string; run: () => Promise<void> } | null;
}

/**
 * Everything a host needs to drive the form's actions. The form itself calls
 * this too; the store keeps the two calls in agreement.
 */
export function useExportModel(duration: number, fps: number): ExportModel {
  const presets = useMemo(() => availableExportPresets(), []);
  const presetByFormat = useMemo(() => {
    const map = new Map<ExportFormat, ExportPreset>();
    for (const p of presets) map.set(p.format, p);
    return map;
  }, [presets]);

  const seed = useExportFormStore((s) => s.seed);
  const seeded = useExportFormStore((s) => s.seeded);
  useEffect(() => {
    if (seeded) return;
    const first = presets[0]?.format ?? 'webm';
    seed({
      format: first,
      activeCategory: FORMAT_GROUPS.find((g) => g.formats.includes(first))?.id ?? 'video',
      scaleIdx: 0,
      quality: 'high',
      proresProfile: '4444',
      // Seeded from the COMP's own setting: a user who set "Transparent
      // background" in Composition Settings got an opaque export (and preview)
      // unless they re-toggled it here — the dialog's `false` overrode the comp.
      transparent: !!useCompositionStore.getState().transparent,
      // Default ON when the comp actually has labelled markers: someone who
      // took the trouble to name them meant them as structure.
      chapters: hasChapterMarkers(fps, duration),
      rangeMode: getTimelineController().getWorkArea() ? 'work' : 'full',
    });
  }, [seeded, seed, presets, fps, duration]);

  const format = useExportFormStore((s) => s.format);
  const scaleIdx = useExportFormStore((s) => s.scaleIdx);
  const quality = useExportFormStore((s) => s.quality);
  const proresProfile = useExportFormStore((s) => s.proresProfile);
  const transparent = useExportFormStore((s) => s.transparent);
  const chapters = useExportFormStore((s) => s.chapters);
  const rangeMode = useExportFormStore((s) => s.rangeMode);
  const progress = useExportFormStore((s) => s.progress);
  const baseComp = useCompositionStore((s) => s.comp());
  const compName = useCompositionStore((s) => s.name);

  // Playhead time is only needed for the single-frame PNG export. Gated on
  // format: subscribing unconditionally re-rendered the whole form (and for
  // PNG, a full GPU preview render) once per playback frame.
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const time = usePlaybackClockStore((s) =>
    format === 'png' ? (activeTabId ? s.clocks[activeTabId]?.time ?? 0 : 0) : 0,
  );

  const captureRange = useCallback((): { startSec: number; endSec: number } => {
    const wa = rangeMode === 'work' ? getTimelineController().getWorkArea() : null;
    return wa ? { startSec: wa.start, endSec: wa.end } : { startSec: 0, endSec: duration };
  }, [rangeMode, duration]);

  const scale = RES[scaleIdx]?.scale ?? 1;
  const width = Math.round(baseComp.width * scale);
  const height = Math.round(baseComp.height * scale);
  const supportsAlpha =
    ALPHA_FORMATS.has(format)
    && (format !== 'webm' || canEncodeLocally())
    && (format !== 'mov' || proresProfile === '4444');
  const alpha = transparent && supportsAlpha;
  const supportsChapters = formatCarriesChapters(format) && canEncodeLocally();

  const captureChapters = useCallback((): ExportChapter[] => {
    if (!chapters || !supportsChapters) return [];
    const { startSec, endSec } = captureRange();
    return chaptersForRange(startSec, endSec, fps);
  }, [chapters, supportsChapters, captureRange, fps]);

  const comp = useMemo(
    () => ({ ...baseComp, rootId: baseComp.id, transparent: alpha, compSizeOf }),
    [baseComp, alpha],
  );

  const activePreset = presetByFormat.get(format);
  const outputName = `${fileStem(compName ?? 'composition')}.${activePreset?.ext ?? format}`;
  const busy = progress !== null;

  /**
   * The out-of-process export: where the file goes, a snapshot of the project
   * for the hidden window to open, and a job on main's queue. Nothing waits
   * on the render — the queue list under the form and the status-bar tray
   * follow it, and this window can be closed.
   *
   * Errors before the job exists (the dialog cancelled, the snapshot failing
   * to write) are reported here; everything after is the job's own record.
   */
  const exportViaSupervisor = useCallback(async (): Promise<void> => {
    const ui = useUIStore.getState();
    const outPath = await exportSupervisorClient.chooseOutputPath(outputName);
    if (!outPath) return;
    const chapterMarks = captureChapters();
    const { exportVideoEncoder } = usePreferenceStore.getState();
    try {
      const { id, projectPath } = await exportSupervisorClient.reserve();
      await getProjectManager().snapshotTo(projectPath);
      const spec = buildSupervisorSpec({
        compositionId: baseComp.id,
        compositionName: compName ?? 'Composition',
        format,
        width,
        height,
        fps,
        range: captureRange(),
        quality,
        ...(format === 'mov' ? { proresProfile } : {}),
        ...(format === 'mp4' ? { videoEncoder: exportVideoEncoder } : {}),
        transparent: alpha,
        ...(chapterMarks.length ? { chapters: chapterMarks } : {}),
        projectPath,
        outPath,
      });
      await useExportQueueStore.getState().connect();
      await exportSupervisorClient.enqueue(id, spec);
      ui.notify({ level: 'success', message: `Queued ${spec.label} — it renders in the background`, durationMs: 3000 });
    } catch (err) {
      ui.notify({ level: 'error', message: err instanceof Error ? err.message : 'The export could not be queued', durationMs: 8000 });
    }
  }, [outputName, captureChapters, captureRange, baseComp.id, compName, format, width, height, fps, quality, proresProfile, alpha]);

  const doExport = useCallback(async (): Promise<void> => {
    const store = useExportFormStore.getState();
    if (store.progress !== null) return;
    // Read at click time, like the range: the pipeline and encoder are
    // preferences, and what was set when Export was pressed is what runs.
    const { exportRawPipe, exportVideoEncoder, exportInProcess } = usePreferenceStore.getState();
    if (shouldUseSupervisor(format, exportInProcess)) {
      await exportViaSupervisor();
      return;
    }
    const controller = new AbortController();
    store.begin(controller);
    const ui = useUIStore.getState();
    ui.startJob({ id: EXPORT_JOB_ID, label: `Exporting ${outputName}`, progress: 0 });
    const chapterMarks = captureChapters();
    try {
      const done = await runExport({
        format,
        width,
        height,
        fps,
        duration,
        time,
        quality,
        ...(format === 'mov' ? { proresProfile } : {}),
        ...(format === 'mp4' ? { videoEncoder: exportVideoEncoder } : {}),
        rawPipe: exportRawPipe,
        ...(chapterMarks.length ? { chapters: chapterMarks } : {}),
        // Captured NOW, not read live mid-render: what you clicked is what
        // renders, even if the work area moves while the export runs.
        range: captureRange(),
        baseName: fileStem(compName ?? 'composition'),
        comp,
        onProgress: (p) => {
          useExportFormStore.getState().setProgress(p);
          useUIStore.getState().updateJob(EXPORT_JOB_ID, { progress: p });
        },
        signal: controller.signal,
      });
      const hdrNote = formatHdrExportDoneNote(done.videoCodec, done.hdrMastering);
      useUIStore.getState().finishJob(EXPORT_JOB_ID, { status: 'done', message: `Export complete${hdrNote}` });
      // A hardware encoder that fell back to software is a finished export
      // with something to say, not a failure — said once, here.
      if (done.warning) useUIStore.getState().notify({ level: 'warning', message: done.warning, durationMs: 8000 });
    } catch (err) {
      if (isAbortError(err)) {
        useUIStore.getState().finishJob(EXPORT_JOB_ID, { status: 'cancelled', message: 'Export cancelled' });
      } else {
        useUIStore.getState().finishJob(EXPORT_JOB_ID, {
          status: 'failed',
          message: err instanceof Error ? err.message : 'Export failed',
          action: { label: 'Learn more', onSelect: () => { void openHelp('exportFailed'); } },
        });
      }
    } finally {
      useExportFormStore.getState().end();
    }
  }, [format, width, height, fps, duration, time, quality, proresProfile, compName, comp, captureRange, captureChapters, outputName, exportViaSupervisor]);

  const queueJob = useCallback((): boolean => {
    if (!QUEUEABLE.has(format)) return false;
    const ext = outputExtFor(format as OutputFormat);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // Capture the range AT QUEUE TIME. The work area is a live, global value;
    // without this snapshot, "Entire composition" still rendered the current
    // work area, and editing any timeline's in/out after queueing changed
    // what every pending job produced. Chapters are captured for the same
    // reason: markers are live editor state.
    const range = captureRange();
    const chapterMarks = captureChapters();
    // Main's queue on desktop (the job starts rendering in its own window),
    // the in-window queue otherwise — see `addToRenderQueue`.
    const { where } = addToRenderQueue({
      compositionName: compName ?? 'Comp 1',
      compositionId: baseComp.id,
      background: baseComp.background,
      outputPath: `${fileStem(compName ?? 'output')}_${ts}.${ext}`,
      format: format as OutputFormat,
      width,
      height,
      compWidth: baseComp.width,
      compHeight: baseComp.height,
      fps,
      durationSec: duration,
      rangeStartSec: range.startSec,
      rangeEndSec: range.endSec,
      transparent: alpha,
      quality,
      ...(format === 'mov' ? { proresProfile } : {}),
      // Captured at queue time, like the range — see RenderJobSpec.videoEncoder.
      ...(format === 'mp4' ? { videoEncoder: usePreferenceStore.getState().exportVideoEncoder } : {}),
      ...(chapterMarks.length ? { chapters: chapterMarks } : {}),
    });
    useLayoutStore.getState().openPanel('renderQueue');
    useUIStore.getState().notify({
      level: 'success',
      message: where === 'supervisor'
        ? 'Added to Render Queue (F6) — it renders in the background'
        : 'Added to Render Queue (F6)',
      durationMs: 2600,
    });
    return true;
  }, [format, captureRange, captureChapters, compName, baseComp, width, height, fps, duration, alpha, quality, proresProfile]);

  const cancel = useCallback(() => {
    useExportFormStore.getState().abort?.abort();
  }, []);

  // Server rendering: a deployment fact, read once. Nothing here blocks the
  // form — the button simply appears when the answer comes back positive.
  const [caps, setCaps] = useState<RenderCapabilities | null>(null);
  useEffect(() => {
    let alive = true;
    void loadRenderCapabilities().then((c) => { if (alive) setCaps(c); });
    return () => { alive = false; };
  }, []);
  const serverEncode = serverEncodeFor(format, quality, proresProfile, caps);
  const serverRender = useMemo(() => {
    if (!serverRenderAvailable(caps) || !serverEncode) return null;
    return {
      label: `Render on server (${serverEncode.codec === 'prores4444' ? 'ProRes 4444' : serverEncode.codec.toUpperCase()})`,
      run: () =>
        renderOnServer({
          encode: serverEncode,
          width,
          height,
          fps,
          duration,
          transparent: alpha,
          outputName,
        }),
    };
  }, [caps, serverEncode, width, height, fps, duration, alpha, outputName]);

  return { busy, progress, showQueue: QUEUEABLE.has(format), outputName, activePreset, doExport, queueJob, cancel, serverRender };
}

export interface ExportFormProps {
  duration: number;
  fps: number;
  host: 'modal' | 'panel';
}

export function ExportForm({ duration, fps, host }: ExportFormProps): JSX.Element {
  const presets = useMemo(() => availableExportPresets(), []);
  const presetByFormat = useMemo(() => {
    const map = new Map<ExportFormat, ExportPreset>();
    for (const p of presets) map.set(p.format, p);
    return map;
  }, [presets]);

  const format = useExportFormStore((s) => s.format);
  const activeCategory = useExportFormStore((s) => s.activeCategory);
  const scaleIdx = useExportFormStore((s) => s.scaleIdx);
  const quality = useExportFormStore((s) => s.quality);
  const proresProfile = useExportFormStore((s) => s.proresProfile);
  const transparent = useExportFormStore((s) => s.transparent);
  const chapters = useExportFormStore((s) => s.chapters);
  const rangeMode = useExportFormStore((s) => s.rangeMode);
  const patch = useExportFormStore((s) => s.patch);
  const { busy, progress, activePreset, cancel } = useExportModel(duration, fps);

  const baseComp = useCompositionStore((s) => s.comp());
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const time = usePlaybackClockStore((s) =>
    format === 'png' ? (activeTabId ? s.clocks[activeTabId]?.time ?? 0 : 0) : 0,
  );

  const workArea = getTimelineController().getWorkArea();
  const useWorkArea = rangeMode === 'work' && !!workArea;

  const scale = RES[scaleIdx]?.scale ?? 1;
  const width = Math.round(baseComp.width * scale);
  const height = Math.round(baseComp.height * scale);

  // WebM alpha exists only on the desktop path (ffmpeg stages PNG and encodes
  // yuva420p). The browser's WebCodecs VP9 profile-0 encode is opaque.
  // MOV alpha is a 4444-only fact: the 422 family has no alpha plane.
  const supportsAlpha =
    ALPHA_FORMATS.has(format)
    && (format !== 'webm' || canEncodeLocally())
    && (format !== 'mov' || proresProfile === '4444');
  const alpha = transparent && supportsAlpha;
  const showRaster = !NON_RASTER.has(format);
  const showRange = RANGED.has(format);
  const showQuality = MOVING.has(format);

  const rangeStart = useWorkArea && workArea ? workArea.start : 0;
  const rangeDuration = useWorkArea && workArea ? Math.max(0, workArea.end - workArea.start) : duration;

  // Chapters ride in the container, so only MP4/MOV can carry them. WebM is
  // excluded on purpose: this repo's muxer writes no Chapters element.
  const supportsChapters = formatCarriesChapters(format) && canEncodeLocally();
  const chapterCount = useMemo(
    () => chaptersForRange(rangeStart, rangeStart + rangeDuration, fps).length,
    [rangeStart, rangeDuration, fps],
  );
  const writeChapters = chapters && supportsChapters && chapterCount > 0;

  const comp = useMemo(
    () => ({ ...baseComp, rootId: baseComp.id, transparent: alpha, compSizeOf }),
    [baseComp, alpha],
  );

  /** null = probing / unknown; true/false = host ffmpeg has libx265. */
  const [hdrLibx265, setHdrLibx265] = useState<boolean | null>(null);
  const isHdrFormat = format === 'hdr10' || format === 'hlg';
  useEffect(() => {
    if (!isHdrFormat) return;
    let cancelled = false;
    setHdrLibx265(null);
    const probe = window.motionEditor?.render?.probeHdr;
    if (!probe) {
      setHdrLibx265(false);
      return;
    }
    void probe().then((r) => {
      if (!cancelled) setHdrLibx265(!!r?.libx265);
    }).catch(() => {
      if (!cancelled) setHdrLibx265(false);
    });
    return () => { cancelled = true; };
  }, [isHdrFormat]);

  const frameCount = format === 'png' ? 1 : Math.max(1, Math.round(rangeDuration * fps));
  const qualityHint = QUALITY.find((q) => q.value === quality)?.hint;
  const dataMeta = dataPreviewMeta(format);

  return (
    <div className={cn(styles.shell, host === 'panel' && styles.shellPanel)}>
      <div className={cn(styles.layout, host === 'panel' && styles.layoutStacked)}>
        <section className={styles.previewCol} aria-label="Export preview">
          {showRaster ? (
            <ExportPreview
              width={width}
              height={height}
              fps={fps}
              durationSec={format === 'png' ? 1 / Math.max(1, fps) : rangeDuration}
              startSec={format === 'png' ? time : rangeStart}
              singleFrame={format === 'png'}
              comp={comp}
              disabled={busy}
            />
          ) : (
            <div className={styles.dataPreview}>
              <Icon name={dataMeta.icon} size="lg" />
              <p className={styles.dataPreviewTitle}>{dataMeta.title}</p>
              <p className={styles.dataPreviewHint}>
                {activePreset?.hint ?? 'No raster preview for this format.'}
              </p>
            </div>
          )}

          <dl className={styles.stats}>
            <div>
              <dt>Size</dt>
              <dd>{showRaster ? `${width} × ${height}` : '—'}</dd>
            </div>
            <div>
              <dt>Rate</dt>
              <dd>{showRaster ? `${fps} fps` : '—'}</dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>
                {format === 'png'
                  ? '1 frame'
                  : showRaster
                    ? `${frameCount} · ${rangeDuration.toFixed(2)}s`
                    : '—'}
              </dd>
            </div>
          </dl>
        </section>

        <section className={styles.settingsCol} aria-label="Export settings">
          <div className={styles.section}>
            <div className={styles.label}>Format Category</div>
            <div className={styles.categoryTabs} role="tablist">
              {FORMAT_GROUPS.map((group) => {
                const items = group.formats.filter((f) => presetByFormat.has(f));
                if (items.length === 0) return null;
                const on = activeCategory === group.id;
                return (
                  <button
                    key={group.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    disabled={busy}
                    className={cn(styles.categoryTab, on && styles.categoryTabOn)}
                    onClick={() => {
                      const firstInGroup = group.formats.find((f) => presetByFormat.has(f));
                      patch({
                        activeCategory: group.id,
                        ...(firstInGroup && !group.formats.includes(format) ? { format: firstInGroup } : {}),
                      });
                    }}
                  >
                    {group.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.label}>Format Preset</div>
            <div className={styles.formatGrid} role="radiogroup" aria-label="Format Preset">
              {(FORMAT_GROUPS.find((g) => g.id === activeCategory)?.formats.filter((f) => presetByFormat.has(f)) ?? []).map((id) => {
                const p = presetByFormat.get(id)!;
                const on = format === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={busy}
                    title={p.hint}
                    className={cn(styles.formatCard, on && styles.formatCardOn)}
                    onClick={() => patch({ format: id })}
                  >
                    <span className={styles.formatName}>{p.label}</span>
                    <span className={styles.formatExt}>.{p.ext}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {activePreset ? <p className={styles.formatHint}>{activePreset.hint}</p> : null}
          {isHdrFormat ? (
            <p
              className={cn(
                styles.hdrNote,
                hdrLibx265 === false && styles.hdrNoteWarn,
                hdrLibx265 === true && styles.hdrNoteOk,
              )}
              role="status"
            >
              {formatHdrCapabilityNote(hdrLibx265)}
            </p>
          ) : null}

          {showRange ? (
            <div className={styles.section}>
              <div className={styles.label}>Range</div>
              <div className={styles.seg} role="radiogroup" aria-label="Export range">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!useWorkArea}
                  disabled={busy}
                  className={cn(styles.segChip, !useWorkArea && styles.segChipOn)}
                  onClick={() => patch({ rangeMode: 'full' })}
                >
                  Entire composition
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={useWorkArea}
                  disabled={busy || !workArea}
                  title={workArea ? 'Export the timeline work area' : 'No work area is set — B / N on the timeline'}
                  className={cn(styles.segChip, useWorkArea && styles.segChipOn)}
                  onClick={() => workArea && patch({ rangeMode: 'work' })}
                >
                  Work area
                </button>
              </div>
              {useWorkArea && workArea ? (
                <p className={styles.fieldNote}>
                  {workArea.start.toFixed(2)}s – {workArea.end.toFixed(2)}s
                </p>
              ) : null}
            </div>
          ) : format === 'png' ? (
            <p className={styles.fieldNote}>Exports the frame under the playhead as a single PNG.</p>
          ) : null}

          {showRaster ? (
            <div className={styles.section}>
              <div className={styles.label}>Resolution</div>
              <div className={styles.seg} role="radiogroup" aria-label="Output resolution">
                {RES.map((r, i) => (
                  <button
                    key={r.label}
                    type="button"
                    role="radio"
                    aria-checked={i === scaleIdx}
                    disabled={busy}
                    className={cn(styles.segChip, i === scaleIdx && styles.segChipOn)}
                    onClick={() => patch({ scaleIdx: i })}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {showQuality ? (
            <div className={styles.section}>
              <div className={styles.label}>Quality</div>
              <div className={styles.seg} role="radiogroup" aria-label="Encode quality">
                {QUALITY.map((q) => (
                  <button
                    key={q.value}
                    type="button"
                    role="radio"
                    aria-checked={quality === q.value}
                    disabled={busy}
                    title={q.hint}
                    className={cn(styles.segChip, quality === q.value && styles.segChipOn)}
                    onClick={() => patch({ quality: q.value })}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
              {qualityHint ? <p className={styles.fieldNote}>{qualityHint}</p> : null}
            </div>
          ) : null}

          {format === 'mov' ? (
            <div className={styles.section}>
              <div className={styles.label}>ProRes profile</div>
              <div className={styles.seg} role="radiogroup" aria-label="ProRes profile">
                {PRORES_PROFILES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={proresProfile === p}
                    disabled={busy}
                    title={PRORES_PROFILE_LABELS[p]}
                    className={cn(styles.segChip, proresProfile === p && styles.segChipOn)}
                    onClick={() => patch({ proresProfile: p })}
                  >
                    {p === '4444' ? '4444' : p === 'hq' ? '422 HQ' : p === '422' ? '422' : p === 'lt' ? '422 LT' : 'Proxy'}
                  </button>
                ))}
              </div>
              <p className={styles.fieldNote}>
                {proresProfile === '4444'
                  ? 'Highest fidelity, and the only profile that carries alpha.'
                  : 'No alpha channel — smaller files for opaque delivery and edit handoff.'}
              </p>
            </div>
          ) : null}

          {MOVING.has(format) ? (
            <div
              className={styles.switchRow}
              title={
                supportsChapters
                  ? 'Composition markers with a label become chapter marks in the file.'
                  : 'Chapter marks are an MP4/MOV feature — this container cannot carry them.'
              }
            >
              <div className={styles.switchCopy}>
                <span className={styles.switchTitle}>Chapters from markers</span>
                <span className={styles.switchHint}>
                  {!supportsChapters
                    ? 'Only MP4 and MOV carry chapters. WebM and GIF have nowhere to put them.'
                    : chapterCount === 0
                      ? 'No labelled composition markers in this range — nothing to write.'
                      : writeChapters
                        ? `${chapterCount} chapter${chapterCount === 1 ? '' : 's'}, one per labelled marker, each running to the next.`
                        : `${chapterCount} labelled marker${chapterCount === 1 ? '' : 's'} available.`}
                </span>
              </div>
              <Switch
                checked={writeChapters}
                disabled={busy || !supportsChapters || chapterCount === 0}
                onChange={(e) => patch({ chapters: e.currentTarget.checked })}
                aria-label="Chapters from markers"
              />
            </div>
          ) : null}

          {showRaster ? (
            <div className={styles.switchRow}>
              <div className={styles.switchCopy}>
                <span className={styles.switchTitle}>Transparent background</span>
                <span className={styles.switchHint}>
                  {!supportsAlpha
                    ? `${activePreset?.label ?? 'This format'} has no alpha channel.`
                    : format === 'gif'
                      ? 'GIF alpha is 1-bit, so edges will look hard.'
                      : 'Keeps empty pixels clear instead of filling the comp colour.'}
                </span>
              </div>
              <Switch
                checked={alpha}
                disabled={busy || !supportsAlpha}
                onChange={(e) => patch({ transparent: e.currentTarget.checked })}
                aria-label="Transparent background"
              />
            </div>
          ) : null}

          {showRaster && (
            <p className={styles.audioNote}>
              {HAS_AUDIO.has(format)
                ? 'Audio in the composition is mixed into the file.'
                : 'This format is picture-only — no audio track.'}
            </p>
          )}
        </section>
      </div>

      <ExportQueueList />

      {busy ? (
        <div className={styles.progressRow}>
          <div className={styles.progressWrap} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
            {/* Width is the measured progress — the one inline value here. */}
            <div className={styles.progressBar} style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            <span className={styles.progressText}>Rendering… {Math.round((progress ?? 0) * 100)}%</span>
          </div>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={cancel}
            title="Stop the export — nothing is written"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
