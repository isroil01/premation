import { useState } from 'react';
import { Icon } from '@components/Icon';
import { OutputFormat } from '@stores/renderQueueStore';
import styles from './OutputModuleDialog.module.css';

export interface OutputSettings {
  format: OutputFormat;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  transparent: boolean;
  startFrame?: number;
  endFrame?: number;
}

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
  const [format, setFormat] = useState<OutputFormat>('mp4');
  const [width, setWidth] = useState(initialWidth);
  const [height, setHeight] = useState(initialHeight);
  const [fps, setFps] = useState(initialFps);
  const [duration, setDuration] = useState(initialDuration);
  const [transparent, setTransparent] = useState(false);

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <h2>Output Module Settings</h2>
          <button type="button" className={styles.closeBtn} onClick={onCancel}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.fieldRow}>
            <label>Format</label>
            <select value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
              <option value="mp4">H.264 MP4</option>
              <option value="webm">WebM VP9</option>
              <option value="png-sequence">PNG Sequence</option>
              <option value="jpg-sequence">JPEG Sequence</option>
              <option value="gif">Animated GIF</option>
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
            <label>Channels</label>
            <label className={styles.checkboxLabel}>
              <input 
                type="checkbox" 
                checked={transparent} 
                onChange={(e) => setTransparent(e.target.checked)} 
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
            onClick={() => onConfirm({ format, width, height, fps, durationSec: duration, transparent })}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
