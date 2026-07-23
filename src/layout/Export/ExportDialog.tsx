/**
 * ExportDialog — one-click export presets (spec §Export). Renders off-screen
 * and shows progress; never blocks the editor.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { cn } from '@utils/cn';
import { openModal } from '@stores/modalStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { useRenderQueueStore, outputExtFor, type OutputFormat } from '@stores/renderQueueStore';
import { useLayoutStore } from '@stores/layoutStore';
import { runExport, isAbortError, EXPORT_PRESETS, type ExportFormat } from '@core/export/exportManager';
import styles from './ExportDialog.module.css';

const RES = [
  { label: 'Full', scale: 1 },
  { label: 'Half', scale: 0.5 },
  { label: 'Quarter', scale: 0.25 },
];

function ExportDialog({ duration, fps }: { duration: number; fps: number }): JSX.Element {
  const [format, setFormat] = useState<ExportFormat>('webm');
  const [scaleIdx, setScaleIdx] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const notify = useUIStore((s) => s.notify);
  const time = useWorkspaceStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.time : 0)) ?? 0;
  const comp = useCompositionStore((s) => s.comp());
  const compName = useCompositionStore((s) => s.name);

  const scale = RES[scaleIdx]!.scale;
  const width = Math.round(comp.width * scale);
  const height = Math.round(comp.height * scale);
  const busy = progress !== null;

  // The in-flight export's abort controller — Cancel fires it, and closing the
  // dialog mid-export aborts too so a render never keeps burning invisibly.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const doExport = async (): Promise<void> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(0);
    try {
      await runExport({
        format, width, height, fps, duration, time,
        // rootId scopes the export to this comp — without it every composition
        // in the project renders into the same frame.
        comp: { ...comp, rootId: comp.id },
        onProgress: (f) => setProgress(f),
        signal: controller.signal,
      });
      notify({ level: 'success', message: 'Export complete — downloading', durationMs: 2600 });
    } catch (err) {
      if (isAbortError(err)) {
        notify({ level: 'info', message: 'Export cancelled', durationMs: 2600 });
      } else {
        notify({ level: 'error', message: 'Export failed', durationMs: 3000 });
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  };

  const cancelExport = (): void => {
    abortRef.current?.abort();
  };

  const queueJob = (): void => {
    const ext = outputExtFor(format as OutputFormat);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    useRenderQueueStore.getState().addJob({
      compositionName: compName ?? 'Comp 1',
      // Bind the job to the comp it was queued FROM, so the queue renders what
      // was asked for rather than whatever is active when it runs.
      compositionId: comp.id,
      background: comp.background,
      outputPath: `${compName ?? 'output'}_${ts}.${ext}`,
      format: format as OutputFormat,
      width,
      height,
      fps,
      durationSec: duration,
      transparent: false,
    });
    useLayoutStore.getState().openPanel('renderQueue');
    notify({ level: 'success', message: 'Added to Render Queue (F6)', durationMs: 2600 });
  };

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <div className={styles.label}>Format</div>
        <div className={styles.presets}>
          {EXPORT_PRESETS.map((p) => (
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

      {format !== 'json' ? (
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

      {busy ? (
        <div className={styles.progressRow}>
          <div className={styles.progressWrap}>
            <div className={styles.progressBar} style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            <span className={styles.progressText}>Rendering… {Math.round((progress ?? 0) * 100)}%</span>
          </div>
          <Button
            variant="secondary"
            size="md"
            onClick={cancelExport}
            title="Stop the export — nothing is downloaded"
          >
            Cancel
          </Button>
        </div>
      ) : null}



      <div className={styles.footer}>
        {(format === 'webm' || format === 'png-sequence' || format === 'jpg-sequence') && (
          <Button
            variant="secondary"
            size="md"
            leftIcon={<Icon name="queue" size={14} />}
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
          leftIcon={<Icon name="export" size={14} />}
          onClick={doExport}
          disabled={busy}
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
    size: 'sm',
    render: () => <ExportDialog duration={duration} fps={fps} />,
  });
}
