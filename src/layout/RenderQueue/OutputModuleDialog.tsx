/**
 * OutputModuleDialog — the settings a queued render is created with, in the shape
 * After Effects users expect (format, resolution, frame rate, duration, channels).
 */

import { useMemo, useState } from 'react';
import { Icon } from '@components/Icon';
import { OutputFormat } from '@stores/renderQueueStore';
import { canEncodeLocally, PRORES_PROFILE_LABELS, type ExportQuality, type ProresProfile } from '@core/export/videoSink';
import { useCompositionStore } from '@stores/compositionStore';
import {
  listOutputTemplates,
  saveOutputTemplate,
  deleteOutputTemplate,
  isBuiltinOutputTemplate,
  applyOutputTemplate,
} from '@core/export/outputTemplates';
import { customPrompt } from '@components/Modal/Dialogs';
import styles from './OutputModuleDialog.module.css';

export interface OutputSettings {
  format: OutputFormat;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  transparent: boolean;
  quality: ExportQuality;
  /** mov only — which ProRes flavour ffmpeg encodes. */
  proresProfile?: ProresProfile;
}

/** Explicit order (not Object.keys — numeric-looking keys re-sort): alpha first, then by size. */
const PRORES_PROFILES: ReadonlyArray<ProresProfile> = ['4444', 'hq', '422', 'lt', 'proxy'];

/** Every queueable format, with the formats only ffmpeg can produce marked. */
const FORMATS: ReadonlyArray<{ value: OutputFormat; label: string; desktopOnly?: boolean }> = [
  { value: 'mp4', label: 'H.264 MP4', desktopOnly: true },
  { value: 'webm', label: 'WebM VP9' },
  { value: 'mov', label: 'ProRes MOV', desktopOnly: true },
  { value: 'gif', label: 'Animated GIF' },
  { value: 'png-sequence', label: 'PNG Sequence' },
  { value: 'jpg-sequence', label: 'JPEG Sequence' },
  { value: 'exr-sequence', label: 'EXR Sequence' },
];

/** Formats that carry an alpha channel — the rest cannot honour "transparent". */
const ALPHA_FORMATS: ReadonlySet<OutputFormat> = new Set(['webm', 'mov', 'gif', 'png-sequence', 'exr-sequence']);

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
  // Seeded from the comp's own transparency, like the Export dialog — a
  // comp set transparent in Composition Settings queued opaque otherwise.
  const [transparent, setTransparent] = useState(() => !!useCompositionStore.getState().transparent);
  const [quality, setQuality] = useState<ExportQuality>('high');
  const [proresProfile, setProresProfile] = useState<ProresProfile>('4444');
  // MOV alpha only exists in 4444 — the 422 family has no alpha plane.
  const supportsAlpha = ALPHA_FORMATS.has(format) && (format !== 'mov' || proresProfile === '4444');

  // Templates. The list lives in localStorage, not React state, so `setTemplatesRev`
  // after a save/delete is what re-renders the dropdown — and the list is simply
  // re-read each render rather than memoized on the rev, because a dialog
  // re-renders a handful of times and a localStorage read is nothing.
  const [, setTemplatesRev] = useState(0);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const templates = listOutputTemplates();

  const applyTemplate = (name: string): void => {
    setSelectedTemplate(name);
    const t = templates.find((x) => x.name === name);
    if (!t) return;
    // Resolved against the COMP's size and rate (the initial values), not the
    // dialog's current fields — a template means "half of the comp", not "half
    // of whatever was last typed here".
    const out = applyOutputTemplate(t, { width: initialWidth, height: initialHeight, fps: initialFps });
    // Skip formats this build cannot encode (mp4 in the browser) rather than
    // silently queueing a render that fails at encode time.
    if (formats.some((f) => f.value === out.format)) setFormat(out.format);
    setWidth(out.width);
    setHeight(out.height);
    setFps(out.fps);
    setQuality(out.quality);
    setTransparent(out.transparent && ALPHA_FORMATS.has(out.format));
  };

  const saveAsTemplate = async (): Promise<void> => {
    // customPrompt, not window.prompt — the latter does not exist in Electron,
    // so Save would silently do nothing in the packaged app.
    const name = await customPrompt('Save Template', 'Template name', selectedTemplate || 'My Template');
    if (!name) return;
    saveOutputTemplate({
      name,
      format,
      quality,
      transparent: transparent && supportsAlpha,
      // Stored RELATIVE to the comp, so "Half Res" saved from an HD comp still
      // means half when applied to a 4K one.
      scale: initialWidth > 0 ? width / initialWidth : 1,
      fps: fps === initialFps ? 'comp' : fps,
    });
    setSelectedTemplate(name);
    setTemplatesRev((r) => r + 1);
  };

  const removeTemplate = (): void => {
    if (!selectedTemplate) return;
    deleteOutputTemplate(selectedTemplate);
    // Deleting a built-in's override restores the built-in, so only clear the
    // selection when the name is gone entirely.
    if (!isBuiltinOutputTemplate(selectedTemplate)) setSelectedTemplate('');
    setTemplatesRev((r) => r + 1);
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <h2>Output Module Settings</h2>
          <button type="button" className={styles.closeBtn} onClick={onCancel}>
            <Icon name="close" size="sm" />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.fieldRow}>
            <label>Template</label>
            <div className={styles.multiInput}>
              <select
                value={selectedTemplate}
                onChange={(e) => applyTemplate(e.target.value)}
                aria-label="Output template"
              >
                <option value="">— choose —</option>
                {templates.map((t) => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
              </select>
              <button type="button" className={styles.cancelBtn} onClick={saveAsTemplate} title="Save the current settings as a named template">
                Save…
              </button>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={removeTemplate}
                disabled={!selectedTemplate}
                title={isBuiltinOutputTemplate(selectedTemplate) ? 'Reset this built-in to its shipped settings' : 'Delete this template'}
              >
                {isBuiltinOutputTemplate(selectedTemplate) ? 'Reset' : 'Delete'}
              </button>
            </div>
          </div>

          <div className={styles.fieldRow}>
            <label>Format</label>
            <select value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
              {formats.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>

          {format === 'mov' ? (
            <div className={styles.fieldRow}>
              <label>ProRes Profile</label>
              <select
                value={proresProfile}
                onChange={(e) => setProresProfile(e.target.value as ProresProfile)}
                aria-label="ProRes profile"
              >
                {PRORES_PROFILES.map((p) => (
                  <option key={p} value={p}>{PRORES_PROFILE_LABELS[p]}</option>
                ))}
              </select>
            </div>
          ) : null}

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
              // Clamped on OK: raw number inputs let a cleared field submit
              // 0/NaN, which reached the renderer as fps 0 (NaN frame times),
              // width 0 (a 0×N canvas) or duration 0. Fall back to the comp's
              // own values rather than refusing — the dialog's initial state.
              onConfirm({
                format,
                width: Number.isFinite(width) && width >= 2 ? Math.round(width) : initialWidth,
                height: Number.isFinite(height) && height >= 2 ? Math.round(height) : initialHeight,
                fps: Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : initialFps,
                durationSec: Number.isFinite(duration) && duration > 0 ? duration : initialDuration,
                transparent: transparent && supportsAlpha,
                quality,
                ...(format === 'mov' ? { proresProfile } : {}),
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
