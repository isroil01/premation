/**
 * ExportDialog — pick a format, see exactly what will be written, export it.
 *
 * The preview is the point: every frame it shows comes from the real export path
 * (same snapshot builder, same comp scoping, same 1:1 comp→frame view), so a
 * render that would come out empty is visible here instead of in a media player.
 *
 * Nothing in this dialog blocks the editor. Frames are rasterised between yields
 * and, on the desktop, encoded by ffmpeg in a separate process.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { cn } from '@utils/cn';
import { openModal } from '@stores/modalStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { useRenderQueueStore, outputExtFor, type OutputFormat } from '@stores/renderQueueStore';
import { useLayoutStore } from '@stores/layoutStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { runExport, isAbortError, availableExportPresets, type ExportFormat } from '@core/export/exportManager';
import type { ExportQuality } from '@core/export/videoSink';
import { ExportPreview } from './ExportPreview';
import styles from './ExportDialog.module.css';
import { compSizeOf } from '@core/composition/compSizes';

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

/** Formats that produce a moving picture, so the extra controls apply. */
const MOVING: ReadonlySet<ExportFormat> = new Set(['mp4', 'webm', 'mov', 'gif']);

/** Formats the render queue can run. */
const QUEUEABLE: ReadonlySet<ExportFormat> = new Set(['mp4', 'webm', 'mov', 'gif', 'png-sequence', 'jpg-sequence']);

function ExportDialog({ duration, fps }: { duration: number; fps: number }): JSX.Element {
  const presets = useMemo(() => availableExportPresets(), []);
  const [format, setFormat] = useState<ExportFormat>(presets[0]?.format ?? 'webm');
  const [scaleIdx, setScaleIdx] = useState(0);
  const [quality, setQuality] = useState<ExportQuality>('high');
  const [transparent, setTransparent] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const notify = useUIStore((s) => s.notify);
  const time = useWorkspaceStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.time : 0)) ?? 0;
  const baseComp = useCompositionStore((s) => s.comp());
  const compName = useCompositionStore((s) => s.name);

  const scale = RES[scaleIdx]!.scale;
  const width = Math.round(baseComp.width * scale);
  const height = Math.round(baseComp.height * scale);
  const busy = progress !== null;

  // Alpha only survives in formats that have an alpha channel. Offering the
  // toggle for MP4 or JPEG would promise transparency the file cannot carry.
  const supportsAlpha = format === 'webm' || format === 'mov' || format === 'png' || format === 'png-sequence' || format === 'gif';
  const alpha = transparent && supportsAlpha;

  // The export range: the work area when one is set, otherwise the whole comp.
  // This mirrors what the exporter itself resolves, so the preview scrubber spans
  // exactly the frames that will be written.
  const workArea = getTimelineController().getWorkArea();
  const rangeStart = workArea ? workArea.start : 0;
  const rangeDuration = workArea ? Math.max(0, workArea.end - workArea.start) : duration;

  // A stable comp object, or the preview re-renders on every parent render.
  const comp = useMemo(
    () => ({ ...baseComp, rootId: baseComp.id, transparent: alpha, compSizeOf }),
    [baseComp, alpha],
  );

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const doExport = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(0);
    try {
      await runExport({
        format,
        width,
        height,
        fps,
        duration,
        time,
        quality,
        // rootId scopes the export to this comp — without it every composition in
        // the project renders into the same frame.
        comp,
        onProgress: setProgress,
        signal: controller.signal,
      });
      notify({ level: 'success', message: 'Export complete', durationMs: 2600 });
    } catch (err) {
      if (isAbortError(err)) {
        notify({ level: 'info', message: 'Export cancelled', durationMs: 2600 });
      } else {
        // Say what went wrong. "Export failed" with no reason left users with
        // nothing to act on, and the reasons here are all actionable (ffmpeg
        // missing, format unsupported in this build, nothing rendered).
        notify({
          level: 'error',
          message: err instanceof Error ? err.message : 'Export failed',
          durationMs: 8000,
        });
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  }, [format, width, height, fps, duration, time, quality, comp, notify]);

  const queueJob = (): void => {
    const ext = outputExtFor(format as OutputFormat);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    useRenderQueueStore.getState().addJob({
      compositionName: compName ?? 'Comp 1',
      // Bind the job to the comp it was queued FROM, so the queue renders what
      // was asked for rather than whatever is active when it runs.
      compositionId: baseComp.id,
      background: baseComp.background,
      outputPath: `${compName ?? 'output'}_${ts}.${ext}`,
      format: format as OutputFormat,
      width,
      height,
      // The comp's own size, kept separate from the output size so a half- or
      // quarter-resolution job still frames the whole composition.
      compWidth: baseComp.width,
      compHeight: baseComp.height,
      fps,
      durationSec: duration,
      transparent: alpha,
      quality,
    });
    useLayoutStore.getState().openPanel('renderQueue');
    notify({ level: 'success', message: 'Added to Render Queue (F6)', durationMs: 2600 });
  };

  const activePreset = presets.find((p) => p.format === format);
  const frameCount = Math.max(1, Math.round(rangeDuration * fps));

  return (
    <div className={styles.root}>
      <ExportPreview
        width={width}
        height={height}
        fps={fps}
        durationSec={rangeDuration}
        startSec={rangeStart}
        comp={comp}
        disabled={busy}
      />

      <div className={styles.summary}>
        <span>{width} × {height}</span>
        <span>{fps} fps</span>
        <span>{frameCount} frames · {rangeDuration.toFixed(2)}s</span>
        {workArea ? <span className={styles.summaryNote}>work area only</span> : null}
      </div>

      <div className={styles.section}>
        <div className={styles.label}>Format</div>
        <div className={styles.presets}>
          {presets.map((p) => (
            <button
              key={p.format}
              type="button"
              disabled={busy}
              className={cn(styles.preset, format === p.format && styles.presetOn)}
              onClick={() => setFormat(p.format)}
            >
              <span className={styles.presetLabel}>{p.label}</span>
              <span className={styles.presetHint}>{p.hint}</span>
            </button>
          ))}
        </div>
      </div>

      {format !== 'json' && format !== 'lottie' ? (
        <div className={styles.section}>
          <div className={styles.label}>Resolution</div>
          <div className={styles.resRow}>
            {RES.map((r, i) => (
              <button
                key={r.label}
                type="button"
                disabled={busy}
                className={cn(styles.resChip, i === scaleIdx && styles.resChipOn)}
                onClick={() => setScaleIdx(i)}
              >
                {r.label}
              </button>
            ))}
            <span className={styles.dims}>{width} × {height}</span>
          </div>
        </div>
      ) : null}

      {MOVING.has(format) ? (
        <div className={styles.section}>
          <div className={styles.label}>Quality</div>
          <div className={styles.resRow}>
            {QUALITY.map((q) => (
              <button
                key={q.value}
                type="button"
                disabled={busy}
                title={q.hint}
                className={cn(styles.resChip, quality === q.value && styles.resChipOn)}
                onClick={() => setQuality(q.value)}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {supportsAlpha ? (
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={transparent}
            disabled={busy}
            onChange={(e) => setTransparent(e.target.checked)}
          />
          <span>
            Transparent background
            <span className={styles.checkHint}>
              {format === 'gif' ? ' — GIF alpha is 1-bit, so edges will look hard.' : ''}
            </span>
          </span>
        </label>
      ) : null}

      {busy ? (
        <div className={styles.progressRow}>
          <div className={styles.progressWrap}>
            <div className={styles.progressBar} style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            <span className={styles.progressText}>Rendering… {Math.round((progress ?? 0) * 100)}%</span>
          </div>
          <Button
            variant="secondary"
            size="md"
            onClick={() => abortRef.current?.abort()}
            title="Stop the export — nothing is written"
          >
            Cancel
          </Button>
        </div>
      ) : null}

      <div className={styles.footer}>
        {QUEUEABLE.has(format) && (
          <Button
            variant="secondary"
            size="md"
            leftIcon={<Icon name="queue" size="md" />}
            onClick={queueJob}
            disabled={busy}
            title="Queue this render in the Render Queue (F6) instead of exporting now"
          >
            Add to Queue
          </Button>
        )}
        <Button
          variant="primary"
          size="md"
          leftIcon={<Icon name="export" size="md" />}
          onClick={doExport}
          disabled={busy}
          title={activePreset?.hint}
        >
          {busy ? 'Exporting…' : 'Export now'}
        </Button>
      </div>
    </div>
  );
}

/** Open the export dialog as a modal. */
export function openExportDialog(duration: number, fps: number): void {
  openModal({
    id: 'export-dialog',
    title: 'Export composition',
    size: 'md',
    render: () => <ExportDialog duration={duration} fps={fps} />,
  });
}
