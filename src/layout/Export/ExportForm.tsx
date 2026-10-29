/**
 * ExportForm — pick a format, see exactly what will be written, export it.
 *
 * The preview is the point: every frame it shows is the ENGINE's (the renderer
 * the export runs), so a render that would come out wrong is visible here
 * instead of in a media player.
 *
 * Nothing in this form blocks the editor: a rendered format is a job on main's
 * export supervisor (`premation-engine --export`); the document formats
 * (Lottie, JSON, the cut lists) are written by `runDataExport`.
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
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton';
import { Switch } from '@components/Switch';
import { cn } from '@utils/cn';
import { useWorkspaceStore } from '@stores/projectStore';
import { usePlaybackClockStore } from '@stores/playbackClockStore';
import { useActiveCompRecord } from '@hooks/useActiveCompRecord';
import { useUIStore } from '@stores/uiStore';
import { outputExtFor, type OutputFormat } from '@stores/renderQueueStore';
import { showRenderQueue } from '@stores/timelinePanelStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompSettingsNow, useActiveTabCompSettings } from '@hooks/useMirrorFrame';
import { activeCompIdNow } from '@hooks/useMirror';
import { settingsHasWorkArea, settingsSetWorkArea } from '@core/mirror/compFacts';
import { flicksToSeconds } from '@motion/engine-api';
import { runDataExport, isAbortError, isDataExportFormat, availableExportPresets, type ExportFormat, type ExportPreset } from '@core/export/exportManager';
import {
  canEncodeLocally,
  isStreamedFormat,
  MP4_CODEC_ENCODER,
  MP4_CODEC_LABELS,
  offersDeepColour,
  PRORES_PROFILE_LABELS,
  type ExportQuality,
  type ExtraOutput,
  type Mp4Codec,
  type ProresProfile,
  type RenderJobSpec,
  type StreamedFormat,
} from '@core/export/renderSpec';
import { chaptersFromMarkers, formatCarriesChapters, type ExportChapter } from '@core/export/chapters';
import { openHelp } from '@layout/Help/openHelp';
import { exportSupervisorClient } from '@core/export/exportSupervisorClient';
import { addToRenderQueue, engineExportRefusal, FfmpegNotReadyError, placeExtraOutputs, queueEngineRender, reportQueueFailure, shouldUseSupervisor, stageWindowOnlyFootage } from './supervisorQueue';
import { ensureFfmpegFor } from '@stores/ffmpegStore';
import { ExportPreview } from './ExportPreview';
import { ExportQueueList } from './ExportQueueList';
import { useExportFormStore, type ExportFormChoices, type ExtraOutputChoice } from './exportFormStore';
import {
  deleteOutputTemplate,
  isBuiltinOutputTemplate,
  listOutputTemplates,
  saveOutputTemplate,
  type OutputTemplate,
} from '@core/export/outputTemplates';
import { customPrompt } from '@components/Modal/Dialogs';
import styles from './ExportDialog.module.css';
import { useState } from 'react';
import { t } from '@core/i18n';
import { PluginFormatOptions, isPluginFormat, pluginFormatExt, pluginOptionsField, usePluginExportPresets } from './pluginFormats';

const RES = [
  { label: 'Full', scale: 1 },
  { label: 'Half', scale: 0.5 },
  { label: 'Quarter', scale: 0.25 },
] as const;

/** The resolution preset's display label (RES labels stay as React keys). */
function resLabel(scale: number): string {
  if (scale === 0.5) return t('export.form.resolution.half', 'Half');
  if (scale === 0.25) return t('export.form.resolution.quarter', 'Quarter');
  return t('export.form.resolution.full', 'Full');
}

/** Called at render time: `t()` must not run at module scope. */
function qualityOptions(): ReadonlyArray<{ value: ExportQuality; label: string; hint: string }> {
  return [
    { value: 'high', label: t('export.form.quality.high', 'High'), hint: t('export.form.quality.highHint', 'Best quality. Slowest encode, largest file.') },
    { value: 'medium', label: t('export.form.quality.medium', 'Medium'), hint: t('export.form.quality.mediumHint', 'Balanced — a good default for review copies.') },
    { value: 'draft', label: t('export.form.quality.draft', 'Draft'), hint: t('export.form.quality.draftHint', 'Fast and visibly compressed. For checking timing.') },
  ];
}

/** A format category's display label (FORMAT_GROUPS ids are compared in code). */
function formatGroupLabel(group: { id: string; label: string }): string {
  switch (group.id) {
    case 'video': return t('export.form.category.video', 'Video');
    case 'frames': return t('export.form.category.frames', 'Frames');
    case 'audio': return t('export.form.category.audio', 'Audio');
    case 'editorial': return t('export.form.category.editorial', 'Editorial');
    case 'data': return t('export.form.category.data', 'Data');
    default: return group.label;
  }
}

const MOVING: ReadonlySet<ExportFormat> = new Set(['mp4', 'hdr10', 'hlg', 'webm', 'mov', 'gif']);
const SEQUENCES: ReadonlyArray<ExportFormat> = ['png-sequence', 'jpg-sequence', 'exr-sequence', 'tiff-sequence', 'dpx-sequence'];
const QUEUEABLE: ReadonlySet<ExportFormat> = new Set(['mp4', 'hdr10', 'hlg', 'webm', 'mov', 'gif', ...SEQUENCES]);
const RANGED: ReadonlySet<ExportFormat> = new Set(['mp4', 'hdr10', 'hlg', 'webm', 'mov', 'gif', 'wav', ...SEQUENCES]);
const HAS_AUDIO: ReadonlySet<ExportFormat> = new Set(['mp4', 'hdr10', 'hlg', 'webm', 'mov', ...SEQUENCES]);
const ALPHA_FORMATS: ReadonlySet<ExportFormat> = new Set(['webm', 'mov', 'png', 'png-sequence', 'gif', 'exr-sequence', 'tiff-sequence']);
const NON_RASTER: ReadonlySet<ExportFormat> = new Set(['wav', 'lottie', 'json', 'edl', 'otio', 'fcpxml', 'ale', 'mogrt']);

/** Explicit order (not Object.keys — numeric-looking keys re-sort): alpha-capable first, then by size. */
const PRORES_PROFILES: ReadonlyArray<ProresProfile> = ['4444', 'hq', '422', 'lt', 'proxy'];
/** Avid DNxHR, highest first. */
const DNXHR_PROFILES: ReadonlyArray<ProresProfile> = ['dnxhr-444', 'dnxhr-hqx', 'dnxhr-hq', 'dnxhr-sq', 'dnxhr-lb'];
const MP4_CODECS: ReadonlyArray<Mp4Codec> = ['h264', 'hevc', 'av1'];

const isDnxhr = (p: ProresProfile): boolean => p.startsWith('dnxhr-');

/** The mp4 encoder a job is queued with: H.264 follows Settings ▸ Export (software or hardware). */
function mp4EncoderFor(codec: Mp4Codec): NonNullable<RenderJobSpec['videoEncoder']> {
  return codec === 'h264' ? usePreferenceStore.getState().exportVideoEncoder : MP4_CODEC_ENCODER[codec];
}

const MAX_EXTRA_OUTPUTS = 7;

/**
 * A render-settings template from the form: format, codec, resolution (as a
 * scale of the comp), quality, depth, alpha, chapters, range, the extra
 * output modules and the post-render action.
 */
function templateFromForm(name: string, c: ExportFormChoices): OutputTemplate {
  return {
    name,
    format: c.format as OutputTemplate['format'],
    quality: c.quality,
    transparent: c.transparent,
    scale: RES[c.scaleIdx]?.scale ?? 1,
    fps: 'comp',
    chapters: c.chapters,
    proresProfile: c.proresProfile,
    mp4Codec: c.mp4Codec,
    bitDepth: c.bitDepth,
    rangeMode: c.rangeMode,
    extraOutputs: c.extraOutputs.map((e) => ({ format: e.format, mp4Codec: e.mp4Codec, proresProfile: e.proresProfile })),
    postRender: c.postRender,
  };
}

/**
 * The form choices a template sets. Its scale snaps to the nearest of the
 * form's sizes (Full / Half / Quarter); a frame-rate override is not applied
 * (the form renders at the composition's rate). Fields a template does not
 * carry keep the form's current value.
 */
function formFromTemplate(tpl: OutputTemplate, current: ExportFormChoices): Partial<ExportFormChoices> {
  let scaleIdx = 0;
  RES.forEach((r, i) => { if (Math.abs(r.scale - tpl.scale) < Math.abs((RES[scaleIdx]?.scale ?? 1) - tpl.scale)) scaleIdx = i; });
  return {
    format: tpl.format,
    activeCategory: FORMAT_GROUPS.find((g) => g.formats.includes(tpl.format))?.id ?? current.activeCategory,
    scaleIdx,
    quality: tpl.quality,
    transparent: tpl.transparent,
    chapters: tpl.chapters ?? current.chapters,
    proresProfile: tpl.proresProfile ?? current.proresProfile,
    mp4Codec: tpl.mp4Codec ?? 'h264',
    bitDepth: tpl.bitDepth ?? 8,
    rangeMode: tpl.rangeMode ?? current.rangeMode,
    extraOutputs: (tpl.extraOutputs ?? []).map((e) => ({ format: e.format, mp4Codec: e.mp4Codec ?? 'h264', proresProfile: e.proresProfile ?? 'hq' })),
    postRender: tpl.postRender ?? 'none',
  };
}
const EXTRA_FORMAT_LABELS: Record<StreamedFormat, string> = { mp4: 'MP4', mov: 'MOV', webm: 'WebM', gif: 'GIF' };

/** The form's extra output modules as a job's (the main output's quality applies to each). */
function extraOutputsOf(format: ExportFormat, choices: ReadonlyArray<ExtraOutputChoice>, quality: ExportQuality): ExtraOutput[] {
  if (!isStreamedFormat(format)) return [];
  return choices.map((c) => ({
    format: c.format,
    quality,
    ...(c.format === 'mov' ? { proresProfile: c.proresProfile } : {}),
    ...(c.format === 'mp4' ? { videoEncoder: mp4EncoderFor(c.mp4Codec) } : {}),
  }));
}

/** An extra output row's codec choices, in one list: `mp4:<codec>` / `mov:<profile>`. */
function codecChoices(format: StreamedFormat): ReadonlyArray<{ value: string; label: string }> {
  if (format === 'mp4') return MP4_CODECS.map((c) => ({ value: c, label: MP4_CODEC_LABELS[c] }));
  if (format === 'mov') return [...PRORES_PROFILES, ...DNXHR_PROFILES].map((p) => ({ value: p, label: PRORES_PROFILE_LABELS[p] }));
  return [];
}

const FORMAT_GROUPS: ReadonlyArray<{ id: string; label: string; formats: ExportFormat[] }> = [
  { id: 'video', label: 'Video', formats: ['mp4', 'hdr10', 'hlg', 'webm', 'mov', 'gif'] },
  { id: 'frames', label: 'Frames', formats: [...SEQUENCES, 'png'] },
  { id: 'audio', label: 'Audio', formats: ['wav'] },
  { id: 'editorial', label: 'Editorial', formats: ['otio', 'fcpxml', 'edl', 'ale'] },
  { id: 'data', label: 'Data', formats: ['lottie', 'json', 'mogrt'] },
];

/** The job id the immediate export runs under — one at a time, by design. */
export const EXPORT_JOB_ID = 'export';

// Whether the engine export can take a format now lives in ./supervisorQueue,
// shared with the Render Queue panel; re-exported so importers keep one name.
export { shouldUseSupervisor };

function dataPreviewMeta(format: ExportFormat): { icon: import('@components/Icon').IconName; title: string } {
  switch (format) {
    case 'wav': return { icon: 'audio', title: t('export.form.data.wav', 'Audio Mixdown · WAV') };
    case 'lottie': return { icon: 'sparkles', title: t('export.form.data.lottie', 'Lottie Animation JSON') };
    case 'json': return { icon: 'file', title: t('export.form.data.json', 'Premation Project Document') };
    case 'otio': return { icon: 'layers', title: t('export.form.data.otio', 'OpenTimelineIO Schema') };
    case 'fcpxml': return { icon: 'code', title: t('export.form.data.fcpxml', 'Final Cut Pro XML') };
    case 'edl': return { icon: 'layers', title: t('export.form.data.edl', 'CMX 3600 Edit Decision List') };
    case 'ale': return { icon: 'file', title: t('export.form.data.ale', 'Avid Log Exchange') };
    case 'mogrt': return { icon: 'component', title: t('export.form.data.mogrt', 'Motion Graphics Template (.mogrt.zip)') };
    default: return { icon: 'file', title: t('export.form.data.default', 'Project document') };
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
 * is what the document says when the button is pressed (the mirror's
 * `MirrorComp.markers`, B4; an unnamed marker reads "Marker", a placeholder).
 */
function chaptersForRange(startSec: number, endSec: number, fps: number): ExportChapter[] {
  const markers = documentMirror().comp(activeCompIdNow() ?? '')?.markers ?? [];
  const shifted = markers.map((m) => ({ time: flicksToSeconds(m.time) - startSec, label: m.name || t('export.form.markerPlaceholder', 'Marker') }));
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
}

/**
 * Everything a host needs to drive the form's actions. The form itself calls
 * this too; the store keeps the two calls in agreement.
 */
export function useExportModel(duration: number, fps: number): ExportModel {
  const presets = useMemo(() => availableExportPresets(), []);
  // P7c: native plugins' output modules (`plugin:<id>/<module>`) beside the built-in formats.
  const pluginFormats = usePluginExportPresets();
  const presetByFormat = useMemo(() => {
    const map = new Map<ExportFormat, ExportPreset>();
    for (const p of presets) map.set(p.format, p);
    for (const p of pluginFormats.presets) map.set(p.format, p);
    return map;
  }, [presets, pluginFormats.presets]);

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
      mp4Codec: 'h264',
      extraOutputs: [],
      postRender: 'none',
      bitDepth: 8,
      // Seeded from the COMP's own setting: a user who set "Transparent
      // background" in Composition Settings got an opaque export (and preview)
      // unless they re-toggled it here — the dialog's `false` overrode the comp.
      transparent: activeCompSettingsNow()?.transparent === true,
      // Default ON when the comp actually has labelled markers: someone who
      // took the trouble to name them meant them as structure.
      chapters: hasChapterMarkers(fps, duration),
      rangeMode: settingsHasWorkArea(activeCompSettingsNow()) ? 'work' : 'full',
    });
  }, [seeded, seed, presets, fps, duration]);

  const format = useExportFormStore((s) => s.format);
  const scaleIdx = useExportFormStore((s) => s.scaleIdx);
  const quality = useExportFormStore((s) => s.quality);
  const proresProfile = useExportFormStore((s) => s.proresProfile);
  const mp4Codec = useExportFormStore((s) => s.mp4Codec);
  const extraChoices = useExportFormStore((s) => s.extraOutputs);
  const postRender = useExportFormStore((s) => s.postRender);
  const bitDepth = useExportFormStore((s) => s.bitDepth);
  const transparent = useExportFormStore((s) => s.transparent);
  const chapters = useExportFormStore((s) => s.chapters);
  const rangeMode = useExportFormStore((s) => s.rangeMode);
  const progress = useExportFormStore((s) => s.progress);
  // The composition record (gradient paint included) from the document mirror (B4).
  const baseComp = useActiveCompRecord();
  const compName = useActiveTabCompSettings()?.name;

  // Playhead time is only needed for the single-frame PNG export. Gated on
  // format: subscribing unconditionally re-rendered the whole form (and for
  // PNG, a full GPU preview render) once per playback frame.
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const time = usePlaybackClockStore((s) =>
    format === 'png' ? (activeTabId ? s.clocks[activeTabId]?.time ?? 0 : 0) : 0,
  );

  const captureRange = useCallback((): { startSec: number; endSec: number } => {
    const wa = rangeMode === 'work' ? settingsSetWorkArea(activeCompSettingsNow()) : null;
    return wa ? { startSec: wa.start, endSec: wa.end } : { startSec: 0, endSec: duration };
  }, [rangeMode, duration]);

  const scale = RES[scaleIdx]?.scale ?? 1;
  const width = Math.round(baseComp.width * scale);
  const height = Math.round(baseComp.height * scale);
  const supportsAlpha =
    (ALPHA_FORMATS.has(format) || isPluginFormat(format))
    && (format !== 'webm' || canEncodeLocally())
    && (format !== 'mov' || proresProfile === '4444');
  const alpha = transparent && supportsAlpha;
  const supportsChapters = formatCarriesChapters(format) && canEncodeLocally();

  const captureChapters = useCallback((): ExportChapter[] => {
    if (!chapters || !supportsChapters) return [];
    const { startSec, endSec } = captureRange();
    return chaptersForRange(startSec, endSec, fps);
  }, [chapters, supportsChapters, captureRange, fps]);

  const activePreset = presetByFormat.get(format);
  const outputName = `${fileStem(compName ?? 'composition')}.${activePreset?.ext ?? format}`;
  const busy = progress !== null;

  /**
   * A rendered format: where the file goes, a snapshot of the project for the
   * engine to open, and a job on main's queue. Nothing waits on the render —
   * the queue list under the form and the status-bar tray follow it, and this
   * window can be closed. A still is the one frame under the playhead.
   *
   * Errors before the job exists (a refusal, the dialog cancelled, the
   * snapshot failing to write) are reported here; everything after is the
   * job's own record.
   */
  const exportViaSupervisor = useCallback(async (): Promise<void> => {
    const ui = useUIStore.getState();
    // Window-only footage is written to disk and relinked first (supervisorQueue).
    const refusal = engineExportRefusal() ?? (await stageWindowOnlyFootage());
    if (refusal) {
      ui.notify({ level: 'error', message: refusal, durationMs: 8000 });
      return;
    }
    // Before the save dialog: nobody should pick a destination and then be told
    // the file cannot be written. Opens the repair dialog when needed.
    if (!(await ensureFfmpegFor(format))) {
      reportQueueFailure(new FfmpegNotReadyError());
      return;
    }
    const outPath = await exportSupervisorClient.chooseOutputPath(outputName);
    if (!outPath) return;
    const chapterMarks = captureChapters();
    const range = format === 'png' ? { startSec: time, endSec: time + 1 / Math.max(1, fps) } : captureRange();
    try {
      await queueEngineRender({
        compositionId: baseComp.id,
        compositionName: compName ?? t('export.dialog.defaultCompName', 'Composition'),
        format,
        width,
        height,
        fps,
        range,
        quality,
        ...(format === 'mov' ? { proresProfile } : {}),
        ...(format === 'mp4' ? { videoEncoder: mp4EncoderFor(mp4Codec) } : {}),
        ...(offersDeepColour(format) && bitDepth === 16 ? { bitDepth: 16 as const } : {}),
        ...((): { extraOutputs?: ReturnType<typeof placeExtraOutputs> } => {
          const placed = placeExtraOutputs(extraOutputsOf(format, extraChoices, quality), outPath);
          return placed.length ? { extraOutputs: placed } : {};
        })(),
        ...(postRender !== 'none' ? { postRender } : {}),
        transparent: alpha,
        ...(chapterMarks.length ? { chapters: chapterMarks } : {}),
        ...pluginOptionsField(format),
        outPath,
      });
      ui.notify({ level: 'success', message: t('export.form.queued', 'Queued {name} — it renders in the background', { name: outputName }), durationMs: 3000 });
    } catch (err) {
      reportQueueFailure(err, t('export.form.queueFailed', 'The export could not be queued'));
    }
  }, [outputName, captureChapters, captureRange, baseComp.id, compName, format, width, height, fps, time, quality, proresProfile, mp4Codec, extraChoices, postRender, bitDepth, alpha]);

  const doExport = useCallback(async (): Promise<void> => {
    const store = useExportFormStore.getState();
    if (store.progress !== null) return;
    if (!isDataExportFormat(format)) {
      await exportViaSupervisor();
      return;
    }
    const controller = new AbortController();
    store.begin(controller);
    const ui = useUIStore.getState();
    ui.startJob({ id: EXPORT_JOB_ID, kind: 'export', label: t('export.form.jobLabel', 'Exporting {name}', { name: outputName }), progress: 0, cancel: () => controller.abort() });
    try {
      await runDataExport({
        format,
        width,
        height,
        fps,
        duration,
        rootId: baseComp.id,
        onProgress: (p) => {
          useExportFormStore.getState().setProgress(p);
          useUIStore.getState().updateJob(EXPORT_JOB_ID, { progress: p });
        },
      });
      useUIStore.getState().finishJob(EXPORT_JOB_ID, { status: 'done', message: t('export.form.complete', 'Export complete') });
    } catch (err) {
      if (isAbortError(err)) {
        useUIStore.getState().finishJob(EXPORT_JOB_ID, { status: 'cancelled', message: t('export.form.cancelled', 'Export cancelled') });
      } else {
        useUIStore.getState().finishJob(EXPORT_JOB_ID, {
          status: 'failed',
          message: err instanceof Error ? err.message : t('export.form.failed', 'Export failed'),
          action: { label: t('export.form.learnMore', 'Learn more'), onSelect: () => { void openHelp('exportFailed'); } },
        });
      }
    } finally {
      useExportFormStore.getState().end();
    }
  }, [format, width, height, fps, duration, baseComp.id, outputName, exportViaSupervisor]);

  const queueJob = useCallback((): boolean => {
    if (!QUEUEABLE.has(format) && !isPluginFormat(format)) return false;
    const refusal = engineExportRefusal();
    if (refusal) {
      useUIStore.getState().notify({ level: 'error', message: refusal, durationMs: 8000 });
      return false;
    }
    const ext = isPluginFormat(format) ? pluginFormatExt(format) : outputExtFor(format as OutputFormat);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // Capture the range AT QUEUE TIME. The work area is a live, global value;
    // without this snapshot, "Entire composition" still rendered the current
    // work area, and editing any timeline's in/out after queueing changed
    // what every pending job produced. Chapters are captured for the same
    // reason: markers are live editor state.
    const range = captureRange();
    const chapterMarks = captureChapters();
    // Main's queue: the job starts rendering in the engine — see `addToRenderQueue`.
    const { done } = addToRenderQueue({
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
      // F1: offered only on the engine export path, for the formats that keep 16 bits.
      ...(offersDeepColour(format) && useExportFormStore.getState().bitDepth === 16 ? { bitDepth: 16 as const } : {}),
      // Captured at queue time, like the range — see RenderJobSpec.videoEncoder.
      ...(format === 'mp4' ? { videoEncoder: mp4EncoderFor(mp4Codec) } : {}),
      ...(chapterMarks.length ? { chapters: chapterMarks } : {}),
      ...pluginOptionsField(format),
      ...((): { extraOutputs?: ExtraOutput[] } => {
        const extras = extraOutputsOf(format, useExportFormStore.getState().extraOutputs, quality);
        return extras.length ? { extraOutputs: extras } : {};
      })(),
      ...(useExportFormStore.getState().postRender !== 'none' ? { postRender: useExportFormStore.getState().postRender as 'import' } : {}),
    });
    showRenderQueue();
    // Failures (folder dialog, snapshot, ffmpeg) are reported by the queue
    // itself; success is said only once the job really exists.
    void done.then((id) => {
      if (!id) return;
      useUIStore.getState().notify({
        level: 'success',
        message: t('export.form.addedToQueue', 'Added to Render Queue (F6) — it renders in the background'),
        durationMs: 2600,
      });
    });
    return true;
  }, [format, captureRange, captureChapters, compName, baseComp, width, height, fps, duration, alpha, quality, proresProfile, mp4Codec]);

  const cancel = useCallback(() => {
    useExportFormStore.getState().abort?.abort();
  }, []);

  return { busy, progress, showQueue: QUEUEABLE.has(format) || isPluginFormat(format), outputName, activePreset, doExport, queueJob, cancel };
}

/**
 * Render-settings templates (AE's Render Settings / Output Module templates):
 * pick one to set the whole form, save the form under a name, delete a saved
 * one (a built-in's override resets to the shipped settings).
 */
function TemplateRow({ busy }: { busy: boolean }): JSX.Element {
  const [, setRev] = useState(0);
  const [selected, setSelected] = useState('');
  const patch = useExportFormStore((s) => s.patch);
  const templates = listOutputTemplates();
  const apply = (name: string): void => {
    setSelected(name);
    const tpl = templates.find((x) => x.name === name);
    if (tpl) patch(formFromTemplate(tpl, useExportFormStore.getState()));
  };
  const save = async (): Promise<void> => {
    const name = await customPrompt(
      t('renderQueue.outputModule.saveTemplateTitle', 'Save Template'),
      t('renderQueue.outputModule.templateName', 'Template name'),
      selected || t('renderQueue.outputModule.defaultTemplateName', 'My Template'),
    );
    if (!name?.trim()) return;
    if (saveOutputTemplate(templateFromForm(name.trim(), useExportFormStore.getState()))) {
      setSelected(name.trim());
      setRev((r) => r + 1);
    }
  };
  const remove = (): void => {
    if (!selected) return;
    deleteOutputTemplate(selected);
    if (!isBuiltinOutputTemplate(selected)) setSelected('');
    setRev((r) => r + 1);
  };
  return (
    <div className={styles.section}>
      <div className={styles.label}>{t('export.form.template', 'Template')}</div>
      <div className={cn(styles.outputRow, styles.templateRow)}>
        <select
          className={styles.outputSelect}
          value={selected}
          disabled={busy}
          aria-label={t('renderQueue.outputModule.templateLabel', 'Output template')}
          onChange={(e) => apply(e.target.value)}
        >
          <option value="">{t('renderQueue.outputModule.choose', '— choose —')}</option>
          {templates.map((tpl) => <option key={tpl.name} value={tpl.name}>{tpl.name}</option>)}
        </select>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void save(); }}>
          {t('renderQueue.outputModule.save', 'Save…')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || !selected} onClick={remove}>
          {isBuiltinOutputTemplate(selected) ? t('renderQueue.outputModule.reset', 'Reset') : t('renderQueue.outputModule.delete', 'Delete')}
        </Button>
      </div>
    </div>
  );
}

export interface ExportFormProps {
  duration: number;
  fps: number;
  host: 'modal' | 'panel';
}

export function ExportForm({ duration, fps, host }: ExportFormProps): JSX.Element {
  const presets = useMemo(() => availableExportPresets(), []);
  // P7c: native plugins' output modules (`plugin:<id>/<module>`) beside the built-in formats.
  const pluginFormats = usePluginExportPresets();
  const presetByFormat = useMemo(() => {
    const map = new Map<ExportFormat, ExportPreset>();
    for (const p of presets) map.set(p.format, p);
    for (const p of pluginFormats.presets) map.set(p.format, p);
    return map;
  }, [presets, pluginFormats.presets]);

  const format = useExportFormStore((s) => s.format);
  const activeCategory = useExportFormStore((s) => s.activeCategory);
  const scaleIdx = useExportFormStore((s) => s.scaleIdx);
  const quality = useExportFormStore((s) => s.quality);
  const proresProfile = useExportFormStore((s) => s.proresProfile);
  const mp4Codec = useExportFormStore((s) => s.mp4Codec);
  const extraChoices = useExportFormStore((s) => s.extraOutputs);
  const postRender = useExportFormStore((s) => s.postRender);
  const transparent = useExportFormStore((s) => s.transparent);
  const chapters = useExportFormStore((s) => s.chapters);
  const rangeMode = useExportFormStore((s) => s.rangeMode);
  const patch = useExportFormStore((s) => s.patch);
  const { busy, progress, activePreset, cancel } = useExportModel(duration, fps);
  const formatGroups = pluginFormats.group ? [...FORMAT_GROUPS, pluginFormats.group] : FORMAT_GROUPS;

  // The composition record from the document mirror (see useExportModel).
  const baseComp = useActiveCompRecord();
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const time = usePlaybackClockStore((s) =>
    format === 'png' ? (activeTabId ? s.clocks[activeTabId]?.time ?? 0 : 0) : 0,
  );

  const workArea = settingsSetWorkArea(useActiveTabCompSettings());
  const useWorkArea = rangeMode === 'work' && !!workArea;

  const scale = RES[scaleIdx]?.scale ?? 1;
  const width = Math.round(baseComp.width * scale);
  const height = Math.round(baseComp.height * scale);

  // WebM alpha exists only on the desktop path (ffmpeg stages PNG and encodes
  // yuva420p). The browser's WebCodecs VP9 profile-0 encode is opaque.
  // MOV alpha is a 4444-only fact: the 422 family has no alpha plane.
  const supportsAlpha =
    (ALPHA_FORMATS.has(format) || isPluginFormat(format))
    && (format !== 'webm' || canEncodeLocally())
    && (format !== 'mov' || proresProfile === '4444');
  const alpha = transparent && supportsAlpha;
  const showRaster = !NON_RASTER.has(format);
  const showRange = RANGED.has(format) || isPluginFormat(format);
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

  // 16 bits per channel: mov and the EXR / TIFF / DPX sequences, when main's engine export says it can.
  const bitDepth = useExportFormStore((s) => s.bitDepth);
  const [bitDepth16, setBitDepth16] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void exportSupervisorClient.capabilities().then((c) => { if (!cancelled) setBitDepth16(c.bitDepth16); });
    return () => { cancelled = true; };
  }, []);
  const offerBitDepth = offersDeepColour(format) && bitDepth16 && shouldUseSupervisor(format);

  const frameCount = format === 'png' ? 1 : Math.max(1, Math.round(rangeDuration * fps));
  const QUALITY = qualityOptions();
  const qualityHint = QUALITY.find((q) => q.value === quality)?.hint;
  const dataMeta = dataPreviewMeta(format);

  return (
    <div className={cn(styles.shell, host === 'panel' && styles.shellPanel)}>
      <div className={cn(styles.layout, host === 'panel' && styles.layoutStacked)}>
        <section className={styles.previewCol} aria-label={t('export.form.previewLabel', 'Export preview')}>
          {showRaster ? (
            <ExportPreview
              width={width}
              height={height}
              fps={fps}
              durationSec={format === 'png' ? 1 / Math.max(1, fps) : rangeDuration}
              startSec={format === 'png' ? time : rangeStart}
              singleFrame={format === 'png'}
              compId={baseComp.id}
              transparent={alpha}
              disabled={busy}
            />
          ) : (
            <div className={styles.dataPreview}>
              <Icon name={dataMeta.icon} size="lg" />
              <p className={styles.dataPreviewTitle}>{dataMeta.title}</p>
              <p className={styles.dataPreviewHint}>
                {activePreset?.hint ?? t('export.form.noRasterPreview', 'No raster preview for this format.')}
              </p>
            </div>
          )}

          <dl className={styles.stats}>
            <div>
              <dt>{t('export.form.stats.size', 'Size')}</dt>
              <dd>{showRaster ? `${width} × ${height}` : '—'}</dd>
            </div>
            <div>
              <dt>{t('export.form.stats.rate', 'Rate')}</dt>
              <dd>{showRaster ? `${fps} fps` : '—'}</dd>
            </div>
            <div>
              <dt>{t('export.form.stats.length', 'Length')}</dt>
              <dd>
                {format === 'png'
                  ? t('export.form.stats.oneFrame', '1 frame')
                  : showRaster
                    ? `${frameCount} · ${rangeDuration.toFixed(2)}s`
                    : '—'}
              </dd>
            </div>
          </dl>
        </section>

        <section className={styles.settingsCol} aria-label={t('export.form.settingsLabel', 'Export settings')}>
          <TemplateRow busy={busy} />
          <div className={styles.section}>
            <div className={styles.label}>{t('export.form.formatCategory', 'Format Category')}</div>
            <div className={styles.categoryTabs} role="tablist">
              {formatGroups.map((group) => {
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
                    {formatGroupLabel(group)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.label}>{t('export.form.formatPreset', 'Format Preset')}</div>
            <div className={styles.formatGrid} role="radiogroup" aria-label={t('export.form.formatPreset', 'Format Preset')}>
              {(formatGroups.find((g) => g.id === activeCategory)?.formats.filter((f) => presetByFormat.has(f)) ?? []).map((id) => {
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

          {isPluginFormat(format) ? <PluginFormatOptions format={format} disabled={busy} /> : null}

          {showRange ? (
            <div className={styles.section}>
              <div className={styles.label}>{t('export.form.range', 'Range')}</div>
              <div className={styles.seg} role="radiogroup" aria-label={t('export.form.rangeLabel', 'Export range')}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!useWorkArea}
                  disabled={busy}
                  className={cn(styles.segChip, !useWorkArea && styles.segChipOn)}
                  onClick={() => patch({ rangeMode: 'full' })}
                >
                  {t('export.form.rangeFull', 'Entire composition')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={useWorkArea}
                  disabled={busy || !workArea}
                  title={workArea ? t('export.form.rangeWorkTitle', 'Export the timeline work area') : t('export.form.rangeNoWorkArea', 'No work area is set — B / N on the timeline')}
                  className={cn(styles.segChip, useWorkArea && styles.segChipOn)}
                  onClick={() => workArea && patch({ rangeMode: 'work' })}
                >
                  {t('export.form.rangeWork', 'Work area')}
                </button>
              </div>
              {useWorkArea && workArea ? (
                <p className={styles.fieldNote}>
                  {workArea.start.toFixed(2)}s – {workArea.end.toFixed(2)}s
                </p>
              ) : null}
            </div>
          ) : format === 'png' ? (
            <p className={styles.fieldNote}>{t('export.form.pngNote', 'Exports the frame under the playhead as a single PNG.')}</p>
          ) : null}

          {showRaster ? (
            <div className={styles.section}>
              <div className={styles.label}>{t('export.form.resolution', 'Resolution')}</div>
              <div className={styles.seg} role="radiogroup" aria-label={t('export.form.resolutionLabel', 'Output resolution')}>
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
                    {resLabel(r.scale)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {showQuality ? (
            <div className={styles.section}>
              <div className={styles.label}>{t('export.form.quality', 'Quality')}</div>
              <div className={styles.seg} role="radiogroup" aria-label={t('export.form.qualityLabel', 'Encode quality')}>
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

          {format === 'mp4' ? (
            <div className={styles.section}>
              <div className={styles.label}>{t('export.form.videoCodec', 'Codec')}</div>
              <div className={styles.seg} role="radiogroup" aria-label={t('export.form.videoCodec', 'Codec')}>
                {MP4_CODECS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={mp4Codec === c}
                    disabled={busy}
                    className={cn(styles.segChip, mp4Codec === c && styles.segChipOn)}
                    onClick={() => patch({ mp4Codec: c })}
                  >
                    {MP4_CODEC_LABELS[c]}
                  </button>
                ))}
              </div>
              <p className={styles.fieldNote}>
                {mp4Codec === 'hevc'
                  ? t('export.form.hevcNote', 'Software HEVC (x265): about half the size of H.264 at the same quality. Slower to encode.')
                  : mp4Codec === 'av1'
                    ? t('export.form.av1Note', 'AV1 (SVT-AV1, 10-bit): the smallest files, for the web and modern players. Slowest to encode.')
                    : t('export.form.h264Note', 'Plays everywhere. The encoder (software or hardware) is set in Settings ▸ Export.')}
              </p>
            </div>
          ) : null}

          {format === 'mov' ? (
            <div className={styles.section}>
              <div className={styles.label}>{t('export.form.videoCodec', 'Codec')}</div>
              <div className={styles.seg} role="radiogroup" aria-label={t('export.form.movCodec', 'QuickTime codec')}>
                {(['prores', 'dnxhr'] as const).map((family) => (
                  <button
                    key={family}
                    type="button"
                    role="radio"
                    aria-checked={isDnxhr(proresProfile) === (family === 'dnxhr')}
                    disabled={busy}
                    className={cn(styles.segChip, isDnxhr(proresProfile) === (family === 'dnxhr') && styles.segChipOn)}
                    onClick={() => {
                      if (isDnxhr(proresProfile) !== (family === 'dnxhr')) patch({ proresProfile: family === 'dnxhr' ? 'dnxhr-hq' : '4444' });
                    }}
                  >
                    {family === 'dnxhr' ? 'Avid DNxHR' : 'Apple ProRes'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {format === 'mov' && isDnxhr(proresProfile) ? (
            <div className={styles.section}>
              <div className={styles.label}>{t('export.form.dnxhrProfile', 'DNxHR profile')}</div>
              <div className={styles.seg} role="radiogroup" aria-label={t('export.form.dnxhrProfile', 'DNxHR profile')}>
                {DNXHR_PROFILES.map((p) => (
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
                    {PRORES_PROFILE_LABELS[p].replace('DNxHR ', '')}
                  </button>
                ))}
              </div>
              <p className={styles.fieldNote}>
                {proresProfile === 'dnxhr-444' || proresProfile === 'dnxhr-hqx'
                  ? t('export.form.dnxhr10Note', '10-bit, for finishing and grading. No alpha channel.')
                  : t('export.form.dnxhr8Note', '8-bit 4:2:2, the Avid editing intermediate. No alpha channel.')}
              </p>
            </div>
          ) : null}

          {format === 'mov' && !isDnxhr(proresProfile) ? (
            <div className={styles.section}>
              <div className={styles.label}>{t('export.form.proresProfile', 'ProRes profile')}</div>
              <div className={styles.seg} role="radiogroup" aria-label={t('export.form.proresProfile', 'ProRes profile')}>
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
                    {p === '4444' ? '4444' : p === 'hq' ? '422 HQ' : p === '422' ? '422' : p === 'lt' ? '422 LT' : t('export.form.proresProxy', 'Proxy')}
                  </button>
                ))}
              </div>
              <p className={styles.fieldNote}>
                {proresProfile === '4444'
                  ? t('export.form.prores4444Note', 'Highest fidelity, and the only profile that carries alpha.')
                  : t('export.form.prores422Note', 'No alpha channel — smaller files for opaque delivery and edit handoff.')}
              </p>
            </div>
          ) : null}

          {offerBitDepth ? (
            <div className={styles.section}>
              <div className={styles.label}>{t('export.form.bitsPerChannel', 'Bits per channel')}</div>
              <div className={styles.seg} role="radiogroup" aria-label={t('export.form.bitsPerChannel', 'Bits per channel')}>
                {([8, 16] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={bitDepth === d}
                    disabled={busy}
                    className={cn(styles.segChip, bitDepth === d && styles.segChipOn)}
                    onClick={() => patch({ bitDepth: d })}
                  >
                    {t('export.form.bitDepth', '{n}-bit', { n: d })}
                  </button>
                ))}
              </div>
              <p className={styles.fieldNote}>
                {bitDepth === 16
                  ? t('export.form.bitDepth16Note', 'Rendered by the engine into a half-float surface (rgba64le). A job the engine cannot render is delivered at 8 bits, with a warning.')
                  : t('export.form.bitDepth8Note', '8 bits per channel, as every renderer writes it.')}
              </p>
            </div>
          ) : null}

          {MOVING.has(format) ? (
            <div
              className={styles.switchRow}
              title={
                supportsChapters
                  ? t('export.form.chaptersTitle', 'Composition markers with a label become chapter marks in the file.')
                  : t('export.form.chaptersUnsupportedTitle', 'Chapter marks are an MP4/MOV feature — this container cannot carry them.')
              }
            >
              <div className={styles.switchCopy}>
                <span className={styles.switchTitle}>{t('export.form.chapters', 'Chapters from markers')}</span>
                <span className={styles.switchHint}>
                  {!supportsChapters
                    ? t('export.form.chaptersUnsupported', 'Only MP4 and MOV carry chapters. WebM and GIF have nowhere to put them.')
                    : chapterCount === 0
                      ? t('export.form.chaptersNone', 'No labelled composition markers in this range — nothing to write.')
                      : writeChapters
                        ? chapterCount === 1
                          ? t('export.form.chaptersWriteOne', '{n} chapter, one per labelled marker, each running to the next.', { n: chapterCount })
                          : t('export.form.chaptersWriteOther', '{n} chapters, one per labelled marker, each running to the next.', { n: chapterCount })
                        : chapterCount === 1
                          ? t('export.form.chaptersAvailableOne', '{n} labelled marker available.', { n: chapterCount })
                          : t('export.form.chaptersAvailableOther', '{n} labelled markers available.', { n: chapterCount })}
                </span>
              </div>
              <Switch
                checked={writeChapters}
                disabled={busy || !supportsChapters || chapterCount === 0}
                onChange={(e) => patch({ chapters: e.currentTarget.checked })}
                aria-label={t('export.form.chapters', 'Chapters from markers')}
              />
            </div>
          ) : null}

          {isStreamedFormat(format) && shouldUseSupervisor(format) ? (
            <div className={styles.section}>
              <div className={styles.label}>{t('export.form.moreOutputs', 'More outputs from this render')}</div>
              {extraChoices.map((c, i) => {
                const setRow = (next: Partial<ExtraOutputChoice>): void =>
                  patch({ extraOutputs: extraChoices.map((x, j) => (j === i ? { ...x, ...next } : x)) });
                const codecs = codecChoices(c.format);
                return (
                  <div key={i} className={styles.outputRow}>
                    <select
                      className={styles.outputSelect}
                      value={c.format}
                      disabled={busy}
                      aria-label={t('export.form.outputFormat', 'Output {n} format', { n: i + 2 })}
                      onChange={(e) => setRow({ format: e.target.value as StreamedFormat })}
                    >
                      {(['mp4', 'mov', 'webm', 'gif'] as const).map((f) => <option key={f} value={f}>{EXTRA_FORMAT_LABELS[f]}</option>)}
                    </select>
                    {codecs.length > 0 ? (
                      <select
                        className={styles.outputSelect}
                        value={c.format === 'mp4' ? c.mp4Codec : c.proresProfile}
                        disabled={busy}
                        aria-label={t('export.form.outputCodec', 'Output {n} codec', { n: i + 2 })}
                        onChange={(e) => setRow(c.format === 'mp4' ? { mp4Codec: e.target.value as Mp4Codec } : { proresProfile: e.target.value as ProresProfile })}
                      >
                        {codecs.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : <span className={styles.outputSelect} aria-hidden="true" />}
                    <IconButton
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      tooltip={t('export.form.removeOutput', 'Remove this output')}
                      aria-label={t('export.form.removeOutput', 'Remove this output')}
                      onClick={() => patch({ extraOutputs: extraChoices.filter((_, j) => j !== i) })}
                    >
                      <Icon name="close" size="sm" />
                    </IconButton>
                  </div>
                );
              })}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || extraChoices.length >= MAX_EXTRA_OUTPUTS}
                onClick={() => patch({ extraOutputs: [...extraChoices, { format: format === 'mov' ? 'mp4' : 'mov', mp4Codec: 'h264', proresProfile: 'hq' }] })}
              >
                {t('export.form.addOutput', 'Add output')}
              </Button>
              <p className={styles.fieldNote}>
                {extraChoices.length > 0
                  ? t('export.form.moreOutputsNote', 'Rendered once, encoded {n} ways. Written beside the main file with the same name.', { n: extraChoices.length + 1 })
                  : t('export.form.moreOutputsHint', 'Write several files — say a ProRes master and an H.264 review copy — from one render.')}
              </p>
            </div>
          ) : null}

          {shouldUseSupervisor(format) && (MOVING.has(format) || format === 'png') ? (
            <div className={styles.section}>
              <div className={styles.label}>{t('export.form.postRender', 'When the render finishes')}</div>
              <div className={styles.seg} role="radiogroup" aria-label={t('export.form.postRender', 'When the render finishes')}>
                {(['none', 'import', 'importReplace'] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    role="radio"
                    aria-checked={postRender === a}
                    disabled={busy}
                    className={cn(styles.segChip, postRender === a && styles.segChipOn)}
                    onClick={() => patch({ postRender: a })}
                  >
                    {a === 'none'
                      ? t('export.form.postRender.none', 'Nothing')
                      : a === 'import'
                        ? t('export.form.postRender.import', 'Import')
                        : t('export.form.postRender.importReplace', 'Import & Replace Usage')}
                  </button>
                ))}
              </div>
              {postRender === 'importReplace' ? (
                <p className={styles.fieldNote}>
                  {t('export.form.postRender.replaceNote', 'Every layer that uses this composition switches to the rendered file — keyframes, effects and masks stay. Undo brings the composition back.')}
                </p>
              ) : null}
            </div>
          ) : null}

          {showRaster ? (
            <div className={styles.switchRow}>
              <div className={styles.switchCopy}>
                <span className={styles.switchTitle}>{t('export.form.transparent', 'Transparent background')}</span>
                <span className={styles.switchHint}>
                  {!supportsAlpha
                    ? activePreset?.label
                      ? t('export.form.noAlpha', '{format} has no alpha channel.', { format: activePreset.label })
                      : t('export.form.noAlphaGeneric', 'This format has no alpha channel.')
                    : format === 'gif'
                      ? t('export.form.gifAlpha', 'GIF alpha is 1-bit, so edges will look hard.')
                      : t('export.form.transparentHint', 'Keeps empty pixels clear instead of filling the comp colour.')}
                </span>
              </div>
              <Switch
                checked={alpha}
                disabled={busy || !supportsAlpha}
                onChange={(e) => patch({ transparent: e.currentTarget.checked })}
                aria-label={t('export.form.transparent', 'Transparent background')}
              />
            </div>
          ) : null}

          {showRaster && (
            <p className={styles.audioNote}>
              {HAS_AUDIO.has(format)
                ? t('export.form.audioMixed', 'Audio in the composition is mixed into the file.')
                : t('export.form.pictureOnly', 'This format is picture-only — no audio track.')}
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
            <span className={styles.progressText}>{t('export.form.rendering', 'Rendering… {pct}%', { pct: Math.round((progress ?? 0) * 100) })}</span>
          </div>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={cancel}
            title={t('export.form.cancelTitle', 'Stop the export — nothing is written')}
          >
            {t('export.form.cancel', 'Cancel')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
