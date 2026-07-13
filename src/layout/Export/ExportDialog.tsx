/**
 * ExportDialog — one-click export presets (spec §Export). Renders off-screen
 * and shows progress; never blocks the editor.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
import { Button } from '@components/Button';
import { cn } from '@utils/cn';
import { openModal } from '@stores/modalStore';
import { useWorkspaceStore } from '@stores/workspaceStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { useRenderQueueStore, type OutputFormat } from '@stores/renderQueueStore';
import { useLayoutStore } from '@stores/layoutStore';
import { runExport, EXPORT_PRESETS, type ExportFormat } from '@core/export/exportManager';
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
  const time = useWorkspaceStore((s) => (s.activeId ? s.workspaces[s.activeId]?.time : 0)) ?? 0;
  const comp = useCompositionStore((s) => s.comp());
  const compName = useCompositionStore((s) => s.name);

  const scale = RES[scaleIdx]!.scale;
  const width = Math.round(comp.width * scale);
  const height = Math.round(comp.height * scale);
  const busy = progress !== null;

  const doExport = async (): Promise<void> => {
    setProgress(0);
    try {
      await runExport({ format, width, height, fps, duration, time, comp, onProgress: (f) => setProgress(f) });
      notify({ level: 'success', message: 'Export complete — downloading', durationMs: 2600 });
    } catch {
      notify({ level: 'error', message: 'Export failed', durationMs: 3000 });
    } finally {
      setProgress(null);
    }
  };

  const queueJob = (): void => {
    const ext = format === 'png-sequence' || format === 'jpg-sequence' ? 'zip' : 'webm';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    useRenderQueueStore.getState().addJob({
      compositionName: compName ?? 'Comp 1',
      outputPath: `${compName ?? 'output'}_${ts}.${ext}`,
      format: format as OutputFormat,
      width,
      height,
      fps,
      durationSec: duration,
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
        <div className={styles.progressWrap}>
          <div className={styles.progressBar} style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          <span className={styles.progressText}>Rendering… {Math.round((progress ?? 0) * 100)}%</span>
        </div>
      ) : null}

      <div className={styles.footer}>
        {(format === 'webm' || format === 'png-sequence' || format === 'jpg-sequence') && (
          <Button
            variant="secondary"
            size="md"
            leftIcon={<Icon name="layers" size={14} />}
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
          leftIcon={<Icon name="skip-forward" size={14} />}
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
