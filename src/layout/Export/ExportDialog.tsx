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
import { Switch } from '@components/Switch';
import { cn } from '@utils/cn';
import { openModal } from '@stores/modalStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { useRenderQueueStore, outputExtFor, type OutputFormat } from '@stores/renderQueueStore';
import { useLayoutStore } from '@stores/layoutStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { runExport, isAbortError, availableExportPresets, type ExportFormat, type ExportPreset } from '@core/export/exportManager';
import { canEncodeLocally, PRORES_PROFILE_LABELS, type ExportQuality, type ProresProfile } from '@core/export/videoSink';
import { formatHdrCapabilityNote, formatHdrExportDoneNote } from '@core/export/hdrTransfer';
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

function ExportDialog({ duration, fps, onClose }: { duration: number; fps: number; onClose?: () => void }): JSX.Element {
  const presets = useMemo(() => availableExportPresets(), []);
  const presetByFormat = useMemo(() => {
    const map = new Map<ExportFormat, ExportPreset>();
    for (const p of presets) map.set(p.format, p);
    return map;
  }, [presets]);

  const [format, setFormat] = useState<ExportFormat>(presets[0]?.format ?? 'webm');
  const [activeCategory, setActiveCategory] = useState<string>(() => {
    const grp = FORMAT_GROUPS.find((g) => g.formats.includes(presets[0]?.format ?? 'webm'));
    return grp?.id ?? 'video';
  });
  const [scaleIdx, setScaleIdx] = useState(0);
  const [quality, setQuality] = useState<ExportQuality>('high');
  const [proresProfile, setProresProfile] = useState<ProresProfile>('4444');
  // Seeded from the COMP's own setting: a user who set "Transparent
  // background" in Composition Settings got an opaque export (and preview)
  // unless they re-toggled it here — the dialog's `false` overrode the comp.
  const [transparent, setTransparent] = useState(() => !!useCompositionStore.getState().transparent);
  const [progress, setProgress] = useState<number | null>(null);
  const notify = useUIStore((s) => s.notify);
  const baseComp = useCompositionStore((s) => s.comp());
  const compName = useCompositionStore((s) => s.name);

  // Playhead time is only needed for the single-frame PNG preview. Gated on
  // format: subscribing unconditionally re-rendered this whole dialog (and
  // for PNG, a full GPU preview render) once per playback frame.
  const time = useWorkspaceStore((s) =>
    format === 'png' ? (s.activeTabId ? s.tabs[s.activeTabId]?.time ?? 0 : 0) : 0,
  );

  const workArea = getTimelineController().getWorkArea();
  const [rangeMode, setRangeMode] = useState<'full' | 'work'>(() => (workArea ? 'work' : 'full'));
  const useWorkArea = rangeMode === 'work' && !!workArea;

  /** The export range, read at ACTION time (export/queue click) so it matches
   *  the timeline as it stands — the render-time live read and the
   *  dialog-open-time snapshot could disagree. End exclusive, seconds. */
  const captureRange = useCallback((): { startSec: number; endSec: number } => {
    const wa = rangeMode === 'work' ? getTimelineController().getWorkArea() : null;
    return wa ? { startSec: wa.start, endSec: wa.end } : { startSec: 0, endSec: duration };
  }, [rangeMode, duration]);

  const scale = RES[scaleIdx]!.scale;
  const width = Math.round(baseComp.width * scale);
  const height = Math.round(baseComp.height * scale);
  const busy = progress !== null;

  // WebM alpha exists only on the desktop path (ffmpeg stages PNG and encodes
  // yuva420p). The browser's WebCodecs VP9 profile-0 encode is opaque — the
  // toggle was offered there, did nothing, and the preset even promised
  // "keeps transparency".
  // MOV alpha is a 4444-only fact: the 422 family is yuv422p10le, no alpha
  // plane exists, and offering the toggle there would promise transparency
  // the encoder physically cannot write.
  const supportsAlpha =
    ALPHA_FORMATS.has(format)
    && (format !== 'webm' || canEncodeLocally())
    && (format !== 'mov' || proresProfile === '4444');
  const alpha = transparent && supportsAlpha;
  const showRaster = !NON_RASTER.has(format);
  const showRange = RANGED.has(format);
  const showQuality = MOVING.has(format);
  const showQueue = QUEUEABLE.has(format);

  const rangeStart = useWorkArea && workArea ? workArea.start : 0;
  const rangeDuration = useWorkArea && workArea ? Math.max(0, workArea.end - workArea.start) : duration;

  const comp = useMemo(
    () => ({ ...baseComp, rootId: baseComp.id, transparent: alpha, compSizeOf }),
    [baseComp, alpha],
  );

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

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

  const doExport = useCallback(async (): Promise<void> => {
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(0);
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
        // Captured NOW, not read live mid-render: what you clicked is what
        // renders, even if the work area moves while the export runs.
        range: captureRange(),
        baseName: fileStem(compName ?? 'composition'),
        comp,
        onProgress: setProgress,
        signal: controller.signal,
      });
      const hdrNote = formatHdrExportDoneNote(done.videoCodec, done.hdrMastering);
      notify({ level: 'success', message: `Export complete${hdrNote}`, durationMs: 4200 });
    } catch (err) {
      if (isAbortError(err)) {
        notify({ level: 'info', message: 'Export cancelled', durationMs: 2600 });
      } else {
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
  }, [format, width, height, fps, duration, time, quality, proresProfile, compName, comp, notify, captureRange]);

  const queueJob = (): void => {
    const ext = outputExtFor(format as OutputFormat);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // Capture the range AT QUEUE TIME. The work area is a live, global value;
    // without this snapshot, "Entire composition" still rendered the current
    // work area, and editing any timeline's in/out after queueing changed
    // what every pending job produced.
    const range = captureRange();
    useRenderQueueStore.getState().addJob({
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
    });
    useLayoutStore.getState().openPanel('renderQueue');
    notify({ level: 'success', message: 'Added to Render Queue (F6)', durationMs: 2600 });
    // Close the modal: it used to open the Render Queue panel BEHIND itself
    // and toast about a panel the user could not see.
    onClose?.();
  };

  const activePreset = presetByFormat.get(format);
  const frameCount = format === 'png' ? 1 : Math.max(1, Math.round(rangeDuration * fps));
  const outputName = `${fileStem(compName ?? 'composition')}.${activePreset?.ext ?? format}`;
  const qualityHint = QUALITY.find((q) => q.value === quality)?.hint;
  const dataMeta = dataPreviewMeta(format);

  return (
    <div className={styles.shell}>
      <div className={styles.layout}>
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
          {/* Format Category Tabs */}
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
                      setActiveCategory(group.id);
                      const firstInGroup = group.formats.find((f) => presetByFormat.has(f));
                      if (firstInGroup && !group.formats.includes(format)) {
                        setFormat(firstInGroup);
                      }
                    }}
                  >
                    {group.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Format Preset Cards for Active Category */}
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
                    onClick={() => setFormat(id)}
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
                  onClick={() => setRangeMode('full')}
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
                  onClick={() => workArea && setRangeMode('work')}
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
                    onClick={() => setScaleIdx(i)}
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
                    onClick={() => setQuality(q.value)}
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
                    onClick={() => setProresProfile(p)}
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
                onChange={(e) => setTransparent(e.currentTarget.checked)}
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

      {busy ? (
        <div className={styles.progressRow}>
          <div className={styles.progressWrap} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress ?? 0) * 100)}>
            <div className={styles.progressBar} style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            <span className={styles.progressText}>Rendering… {Math.round((progress ?? 0) * 100)}%</span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => abortRef.current?.abort()}
            title="Stop the export — nothing is written"
          >
            Cancel
          </Button>
        </div>
      ) : null}

      <div className={styles.footer}>
        <div className={styles.fileMeta} title={outputName}>
          <Icon name="export" size="sm" />
          <span className={styles.fileName}>{outputName}</span>
        </div>
        <div className={styles.footerActions}>
          {showQueue && (
            <Button
              variant="secondary"
              size="md"
              leftIcon={<Icon name="queue" size="sm" />}
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
            leftIcon={<Icon name="export" size="sm" />}
            onClick={doExport}
            disabled={busy}
            title={activePreset?.hint}
          >
            {busy ? 'Exporting…' : 'Export'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Open the export dialog as a modal. */
export function openExportDialog(duration: number, fps: number): void {
  const name = useCompositionStore.getState().name?.trim() || 'Composition';
  openModal({
    id: 'export-dialog',
    title: 'Export composition',
    description: name,
    size: 'lg',
    // Persistent: Esc / a backdrop click used to unmount the dialog, whose
    // cleanup ABORTS a running export — a reflex keypress killed a
    // twenty-minute render with only an "Export cancelled" toast.
    persistent: true,
    render: (close) => <ExportDialog duration={duration} fps={fps} onClose={close} />,
  });
}
