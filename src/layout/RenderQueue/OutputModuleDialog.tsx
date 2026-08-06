/**
 * OutputModuleDialog — the settings a queued render is created with, in the shape
 * After Effects users expect (format, resolution, frame rate, duration, channels).
 */

import { useMemo, useState } from 'react';
import { Icon } from '@components/Icon';
import { OutputFormat } from '@stores/renderQueueStore';
import { canEncodeLocally, type ExportQuality } from '@core/export/videoSink';
import styles from './OutputModuleDialog.module.css';

export interface OutputSettings {
  format: OutputFormat;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  transparent: boolean;
  quality: ExportQuality;
}

/** Every queueable format, with the formats only ffmpeg can produce marked. */
const FORMATS: ReadonlyArray<{ value: OutputFormat; label: string; desktopOnly?: boolean }> = [
  { value: 'mp4', label: 'H.264 MP4', desktopOnly: true },
  { value: 'webm', label: 'WebM VP9' },
  { value: 'mov', label: 'ProRes 4444 MOV (alpha)', desktopOnly: true },
  { value: 'gif', label: 'Animated GIF' },
  { value: 'png-sequence', label: 'PNG Sequence' },
  { value: 'jpg-sequence', label: 'JPEG Sequence' },
];

/** Formats that carry an alpha channel — the rest cannot honour "transparent". */
const ALPHA_FORMATS: ReadonlySet<OutputFormat> = new Set(['webm', 'mov', 'gif', 'png-sequence']);

interface OutputModuleDialogProps {
  initialWidth: number;
  initialHeight: number;
  initialFps: number;
  initialDuration: number;
  onConfirm: (settings: OutputSettings) => void;
  onCancel: () => void;
}

export function OutputModuleDialog({
  initialWidth,
  initialHeight,
  initialFps,
  initialDuration,
  onConfirm,
  onCancel,
}: OutputModuleDialogProps): JSX.Element {
  // Only offer what this build can actually encode: queueing an MP4 in the
  // browser would fail at encode time, after the whole render had run.
  const formats = useMemo(() => {
    const local = canEncodeLocally();
    return FORMATS.filter((f) => local || !f.desktopOnly);
  }, []);

  const [format, setFormat] = useState<OutputFormat>(formats[0]?.value ?? 'webm');
  const [width, setWidth] = useState(initialWidth);
  const [height, setHeight] = useState(initialHeight);
  const [fps, setFps] = useState(initialFps);
  const [duration, setDuration] = useState(initialDuration);
  const [transparent, setTransparent] = useState(false);
  const [quality, setQuality] = useState<ExportQuality>('high');
  const supportsAlpha = ALPHA_FORMATS.has(format);

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <h2>Output Module Settings</h2>
          <button type="button" className={styles.closeBtn} onClick={onCancel}>
            <Icon name="close" size="md" />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.fieldRow}>
            <label>Format</label>
            <select value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
              {formats.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>

          <div className={styles.fieldRow}>
            <label>Resolution</label>
            <div className={styles.multiInput}>
              <input 
                type="number" 
                value={width} 
                onChange={(e) => setWidth(Number(e.target.value))} 
                min={1} 
              />
              <span>×</span>
              <input 
                type="number" 
                value={height} 
                onChange={(e) => setHeight(Number(e.target.value))} 
                min={1} 
              />
            </div>
          </div>

          <div className={styles.fieldRow}>
            <label>Frame Rate</label>
            <input 
              type="number" 
              value={fps} 
              onChange={(e) => setFps(Number(e.target.value))} 
              min={1} 
            />
          </div>

          <div className={styles.fieldRow}>
            <label>Duration (s)</label>
            <input 
              type="number" 
              value={duration} 
              onChange={(e) => setDuration(Number(e.target.value))} 
              min={0.1}
              step={0.1}
            />
          </div>

          <div className={styles.fieldRow}>
            <label>Quality</label>
            <select value={quality} onChange={(e) => setQuality(e.target.value as ExportQuality)}>
              <option value="high">High — best quality, slowest</option>
              <option value="medium">Medium — balanced</option>
              <option value="draft">Draft — fast, visibly compressed</option>
            </select>
          </div>

          <div className={styles.fieldRow}>
            <label>Channels</label>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={transparent && supportsAlpha}
                disabled={!supportsAlpha}
                onChange={(e) => setTransparent(e.target.checked)}
                // Offering alpha for MP4 or JPEG would promise transparency the
                // container cannot carry, and silently flatten it instead.
                title={supportsAlpha ? undefined : `${format} has no alpha channel`}
              />
              RGB + Alpha (Transparent)
            </label>
          </div>
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.cancelBtn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.okBtn}
            onClick={() =>
              onConfirm({
                format,
                width,
                height,
                fps,
                durationSec: duration,
                transparent: transparent && supportsAlpha,
                quality,
              })
            }
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
