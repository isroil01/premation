/**
 * CompositionSettingsDialog — comprehensive composition setup modal: name,
 * resolution & dimensions, aspect ratio lock, frame rate, duration, background paint,
 * 3D environment, pixel grid & guides, responsive time, and color management.
 *
 * Sized and styled consistently with the application's modern modal dialogs
 * (New Composition, Export Dialog, Studio Preferences) with centered scrim framing,
 * live interactive preview, and non-destructive Cancel / Save Changes workflow.
 */

import { useState, useRef, useMemo } from 'react';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { ResponsiveTimeSection } from './ResponsiveTimeSection';
import { Button } from '@components/Button';
import { Input } from '@components/Input';
import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { framesToTimecode } from '@core/time/timecode';
import { ColorPicker } from '@components/ColorPicker';
import {
  convertFill, solidFill, makeStop, sortedStops,
  type FillPaint, type FillType, type ColorStop,
} from '@core/paint/fill';
import { openModal } from '@stores/modalStore';
import { DialogFooter, useDialogPrimaryAction } from '@components/Modal';
import { useCompositionStore, sanitize as sanitizeComp } from '@stores/compositionStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { settingsFps } from '@core/mirror/compFacts';
import {
  resolveSsao,
  resolvePixelAspect,
  DEFAULT_PIXEL_ASPECT,
  type CompositionSettings as CompRecord,
  type SsaoSettings,
} from '@stores/projectStore';
import { saveCompositionSettingsEdit } from './compositionEdits';
import { useGuidesStore, type GridStyle } from '@stores/guidesStore';
import { useColorManagementStore, type IntermediateBitDepth } from '@stores/colorManagementStore';
import { useViewerLutStore } from '@stores/viewerLutStore';
import {
  SIZE_PRESETS,
  SIZE_GROUPS,
  aspectRatioLabel,
  clampDimension,
  clampFps,
  clampDuration,
  MAX_DURATION,
  FPS_PRESETS,
  type SizePreset,
} from '@core/composition/presets';
import {
  PIXEL_ASPECT_PRESETS,
  findPixelAspectPreset,
  describePixelAspect,
} from './pixelAspectPresets';
import {
  ENVIRONMENT_PRESETS,
  DEFAULT_ENVIRONMENT_PRESET,
  isEnvironmentPresetId,
  type EnvironmentPresetId,
} from '@core/scene/environmentLight';
import styles from './CompositionSettingsDialog.module.css';

export type TabId = 'general' | 'background' | 'grid' | 'world' | 'time' | 'color';

/* eslint-disable design-system/no-hex-color -- Studio background hex values are composition document presets */
const STUDIO_COLOR_SWATCHES = [
  { label: 'Studio Dark', hex: '#101014' },
  { label: 'Deep Black', hex: '#000000' },
  { label: 'Slate Charcoal', hex: '#1c1c22' },
  { label: 'Clean White', hex: '#ffffff' },
];
/* eslint-enable design-system/no-hex-color */

const POPULAR_PRESETS: readonly SizePreset[] = [
  SIZE_PRESETS.find((p) => p.id === 'yt_1080')!,
  SIZE_PRESETS.find((p) => p.id === 'ig_reel')!,
  SIZE_PRESETS.find((p) => p.id === 'uhd_4k')!,
  SIZE_PRESETS.find((p) => p.id === 'ig_post')!,
].filter(Boolean);

/** The comp record fields a draft carries (the store's action members dropped). */
function recordOf(c: CompRecord): CompRecord {
  return { ...c };
}

/** A gradient's representative flat colour — what `background` mirrors (compositionStore's rule). */
function paintColor(p: FillPaint, fallback: string): string {
  return p.type === 'solid' ? p.color : sortedStops(p.stops)[0]?.color ?? fallback;
}

/**
 * The dialog edits a DRAFT of the comp record; nothing reaches the document
 * until Save Changes, which sends the changed fields as ONE engine edit
 * (`setCompositionSettings`, undoable — the live writes it replaced were
 * not). Cancel just closes.
 */
function useDraft(initial: CompRecord): {
  s: CompRecord;
  update: (patch: Partial<CompRecord>) => void;
  setBackgroundPaint: (paint: FillPaint) => void;
  setTransparent: (v: boolean) => void;
} {
  const [s, setDraft] = useState<CompRecord>(() => recordOf(initial));
  return {
    s,
    update: (patch) => setDraft((d) => ({ ...d, ...sanitizeComp(patch) })),
    setBackgroundPaint: (paint) => setDraft((d) => (paint.type === 'solid'
      ? { ...d, background: paint.color, backgroundPaint: undefined }
      : { ...d, background: paintColor(paint, d.background), backgroundPaint: paint })),
    setTransparent: (v) => setDraft((d) => ({ ...d, transparent: v })),
  };
}

/** FPS chips match a typed rate within display precision (23.976 is not exactly representable). */
const sameRate = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;

export function CompositionSettings({ close }: { close?: () => void }): JSX.Element {
  const initialComp = useRef(useCompositionStore.getState().comp()).current;
  const { s, update, setBackgroundPaint, setTransparent } = useDraft(initialComp);

  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [aspectLocked, setAspectLocked] = useState(false);
  const lockRatio = useRef((s.width || 1920) / Math.max(1, s.height || 1080));

  // Grid overlay is view/session state (guidesStore)
  const gridOn = useGuidesStore((g) => g.grid);
  const snapToGrid = useGuidesStore((g) => g.snapToGrid);
  const gridSpacing = useGuidesStore((g) => g.gridSpacing);
  const gridSubdivisions = useGuidesStore((g) => g.gridSubdivisions);
  const gridStyle = useGuidesStore((g) => g.gridStyle);
  const gridColor = useGuidesStore((g) => g.gridColor);
  const proportionalGrid = useGuidesStore((g) => g.proportionalGrid);
  const proportionalColumns = useGuidesStore((g) => g.proportionalColumns);
  const proportionalRows = useGuidesStore((g) => g.proportionalRows);
  const toggleGrid = useGuidesStore((g) => g.toggleGrid);
  const toggleSnapToGrid = useGuidesStore((g) => g.toggleSnapToGrid);
  const setGridSpacing = useGuidesStore((g) => g.setGridSpacing);
  const setGridSubdivisions = useGuidesStore((g) => g.setGridSubdivisions);
  const setGridStyle = useGuidesStore((g) => g.setGridStyle);
  const setGridColor = useGuidesStore((g) => g.setGridColor);
  const toggleProportionalGrid = useGuidesStore((g) => g.toggleProportionalGrid);
  const setProportionalColumns = useGuidesStore((g) => g.setProportionalColumns);
  const setProportionalRows = useGuidesStore((g) => g.setProportionalRows);

  const cm = useColorManagementStore();
  const setWorkingSpace = useColorManagementStore((c) => c.setWorkingSpace);
  const setDisplayTransform = useColorManagementStore((c) => c.setDisplayTransform);
  const setBitDepth = useColorManagementStore((c) => c.setBitDepth);
  const viewerLutName = useViewerLutStore((v) => v.name);
  const loadViewerLut = useViewerLutStore((v) => v.loadFromText);
  const clearViewerLut = useViewerLutStore((v) => v.clear);

  const setName = (name: string): void => update({ name });
  const setFps = (fps: number): void => update({ fps: clampFps(fps) });
  const setDuration = (durationSeconds: number): void => update({ durationSeconds: clampDuration(durationSeconds) });
  const setStartFrame = (startFrame: number): void => update({ startFrame });

  // Aspect ratio lock toggle
  const toggleAspectLock = (): void => {
    if (!aspectLocked && s.width > 0 && s.height > 0) {
      lockRatio.current = s.width / s.height;
    }
    setAspectLocked((prev) => !prev);
  };

  // Dimensions change handlers
  const handleWidthChange = (newW: number): void => {
    const clampedW = clampDimension(newW);
    if (aspectLocked && lockRatio.current > 0) {
      const clampedH = clampDimension(Math.round(clampedW / lockRatio.current));
      update({ width: clampedW, height: clampedH });
    } else {
      update({ width: clampedW });
    }
  };

  const handleHeightChange = (newH: number): void => {
    const clampedH = clampDimension(newH);
    if (aspectLocked && lockRatio.current > 0) {
      const clampedW = clampDimension(Math.round(clampedH * lockRatio.current));
      update({ width: clampedW, height: clampedH });
    } else {
      update({ height: clampedH });
    }
  };

  // Swap width & height (landscape ↔ portrait)
  const handleSwapDimensions = (): void => {
    const prevW = s.width;
    const prevH = s.height;
    if (aspectLocked && prevW > 0) {
      lockRatio.current = prevH / prevW;
    }
    update({ width: prevH, height: prevW });
  };

  // Preset selection
  const handleSelectPreset = (preset: SizePreset): void => {
    if (preset.width > 0 && preset.height > 0) {
      lockRatio.current = preset.width / preset.height;
    }
    update({ width: preset.width, height: preset.height });
  };

  const matchingPreset = useMemo(() => {
    return SIZE_PRESETS.find((p) => p.width === s.width && p.height === s.height);
  }, [s.width, s.height]);

  const orientation = useMemo(() => {
    if (s.width === s.height) return 'Square';
    return s.width > s.height ? 'Landscape' : 'Portrait';
  }, [s.width, s.height]);

  // Pixel aspect ratio
  const pixelAspect = resolvePixelAspect(s);
  const setPixelAspect = (val: number): void => update({ pixelAspect: val });
  const parPresetId = findPixelAspectPreset(pixelAspect)?.id ?? '';

  // World (3D)
  const defaultEnvPreset: EnvironmentPresetId = isEnvironmentPresetId(s.defaultEnvPreset)
    ? s.defaultEnvPreset
    : DEFAULT_ENVIRONMENT_PRESET;
  const setDefaultEnvPreset = (v: string): void => {
    if (isEnvironmentPresetId(v)) update({ defaultEnvPreset: v });
  };
  const groundLevel = Number.isFinite(s.groundLevel) ? (s.groundLevel as number) : 0;
  const setGroundLevel = (v: number): void => update({ groundLevel: v });
  const showSkyBackdrop = s.showSkyBackdrop === true;
  const ssao = resolveSsao(s);
  const patchSsao = (patch: Partial<SsaoSettings>): void => update({ ssao: { ...ssao, ...patch } });

  // Background paint
  const bgPaint: FillPaint = s.backgroundPaint ?? solidFill(s.background);
  // `convertFill` is a pure paint conversion into the DRAFT (the ratchet's verb pattern flags the name).
  const setBgType = (type: FillType): void => setBackgroundPaint(convertFill(bgPaint, type));
  const writeStops = (stops: ColorStop[]): void => {
    if (bgPaint.type === 'solid') return;
    setBackgroundPaint({ ...bgPaint, stops });
  };
  const writeStop = (id: string, patch: Partial<ColorStop>): void => {
    if (bgPaint.type === 'solid') return;
    writeStops(bgPaint.stops.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };
  const addStop = (): void => {
    if (bgPaint.type === 'solid') return;
    writeStops([...bgPaint.stops, makeStop(0.5, '#888888')]);
  };
  const removeStop = (id: string): void => {
    if (bgPaint.type === 'solid' || bgPaint.stops.length <= 2) return;
    writeStops(bgPaint.stops.filter((x) => x.id !== id));
  };

  // Preview box style reflecting aspect ratio and background paint
  const previewBoxStyle = useMemo(() => {
    const maxBoxW = 200;
    const maxBoxH = 110;
    const canvasAspect = (s.width || 1920) / (s.height || 1080);
    let boxW = maxBoxW;
    let boxH = boxW / canvasAspect;
    if (boxH > maxBoxH) {
      boxH = maxBoxH;
      boxW = boxH * canvasAspect;
    }

    let backgroundStyle: React.CSSProperties = {
      backgroundColor: s.transparent ? 'transparent' : s.background,
    };

    if (!s.transparent && s.backgroundPaint) {
      if (s.backgroundPaint.type === 'linear') {
        const stopsStr = sortedStops(s.backgroundPaint.stops)
          .map((st) => `${st.color} ${Math.round(st.offset * 100)}%`)
          .join(', ');
        backgroundStyle = {
          background: `linear-gradient(${s.backgroundPaint.angle}deg, ${stopsStr})`,
        };
      } else if (s.backgroundPaint.type === 'radial') {
        const stopsStr = sortedStops(s.backgroundPaint.stops)
          .map((st) => `${st.color} ${Math.round(st.offset * 100)}%`)
          .join(', ');
        backgroundStyle = {
          background: `radial-gradient(circle at center, ${stopsStr})`,
        };
      }
    }

    return {
      width: `${Math.max(28, Math.round(boxW))}px`,
      height: `${Math.max(28, Math.round(boxH))}px`,
      ...backgroundStyle,
    };
  }, [s.width, s.height, s.background, s.transparent, s.backgroundPaint]);

  const totalFrames = Math.max(1, Math.round(s.durationSeconds * s.fps));
  const timecodeString = framesToTimecode(s.durationSeconds, s.fps);

  // Gradient track preview bar for Background tab
  const gradientTrackPreview = useMemo(() => {
    if (bgPaint.type === 'solid') return null;
    const stopsStr = sortedStops(bgPaint.stops)
      .map((st) => `${st.color} ${Math.round(st.offset * 100)}%`)
      .join(', ');
    return `linear-gradient(90deg, ${stopsStr})`;
  }, [bgPaint]);

  // Cancel & Save handlers. Nothing was written while the dialog was open, so
  // Cancel has nothing to revert.
  const handleCancel = (): void => {
    close?.();
  };

  const handleSave = (): void => {
    close?.();
    const compId = initialComp.id;
    // B4: the composition (or a group opened in its own tab) must still be in the document.
    const m = documentMirror();
    if (!m.comp(compId) && !m.layer(compId)) return;
    void saveCompositionSettingsEdit(compId, initialComp, s);
  };

  useDialogPrimaryAction(handleSave);

  return (
    <div className={styles.root}>
      {/* Top Navigation Tabs */}
      <div className={styles.navTabs} role="tablist" aria-label="Composition settings tabs">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'general'}
          className={`${styles.navTab} ${activeTab === 'general' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('general')}
        >
          <Icon name="sliders-h" size="sm" />
          <span>General</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'background'}
          className={`${styles.navTab} ${activeTab === 'background' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('background')}
        >
          <Icon name="brush" size="sm" />
          <span>Background</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'grid'}
          className={`${styles.navTab} ${activeTab === 'grid' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('grid')}
        >
          <Icon name="grid" size="sm" />
          <span>Grid & Guides</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'world'}
          className={`${styles.navTab} ${activeTab === 'world' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('world')}
        >
          <Icon name="axis-world" size="sm" />
          <span>World</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'time'}
          className={`${styles.navTab} ${activeTab === 'time' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('time')}
        >
          <Icon name="keyframe" size="sm" />
          <span>Time</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'color'}
          className={`${styles.navTab} ${activeTab === 'color' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('color')}
        >
          <Icon name="palette" size="sm" />
          <span>Color</span>
        </button>
      </div>

      <div className={styles.tabBody}>
        {/* TAB 1: GENERAL */}
        {activeTab === 'general' && (
          <div className={styles.columns}>
            {/* Left Column: Live Visual Interactive Preview Card */}
            <div className={styles.leftCol}>
              <div className={styles.previewCard} aria-label="Composition preview">
                <div className={styles.previewViewport}>
                  <div
                    data-testid="composition-preview-frame"
                    data-transparent={s.transparent}
                    className={`${styles.previewCanvasFrame} ${s.transparent ? styles.checkerboard : ''}`}
                    style={previewBoxStyle}
                  >
                    <div className={styles.viewfinderGuide} />
                    <div className={styles.previewCenterCross} />
                  </div>
                </div>

                <div className={styles.previewMeta}>
                  <div className={styles.previewMetaRow}>
                    <div className={styles.metaItem}>
                      <span className={styles.metaBadge}>{orientation}</span>
                      <span>{aspectRatioLabel(s.width, s.height)}</span>
                    </div>
                    <div className={styles.metaItem}>
                      <span>{s.width} × {s.height} px</span>
                    </div>
                  </div>

                  <div className={styles.previewMetaRow}>
                    <div className={styles.metaItem}>
                      <span>{s.fps} fps</span>
                    </div>
                    <div className={styles.metaItem}>
                      <span>{timecodeString} ({totalFrames}f)</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Quick Popular Presets */}
              <div className={styles.section}>
                <div className={styles.label}>
                  <Icon name="play" size="sm" />
                  <span>Popular Presets</span>
                </div>
                <div className={styles.chips}>
                  {POPULAR_PRESETS.map((p) => {
                    const isSelected = s.width === p.width && s.height === p.height;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`${styles.chip} ${isSelected ? styles.chipActive : ''}`}
                        onClick={() => handleSelectPreset(p)}
                        title={`${p.label} (${p.width}×${p.height})`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Right Column: Controls Form */}
            <div className={styles.rightCol}>
              {/* Composition Name */}
              <div className={styles.section}>
                <div className={styles.label}>Composition Name</div>
                <Input
                  value={s.name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Composition 1"
                  aria-label="Composition name"
                />
              </div>

              {/* Dimensions & Presets */}
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <div className={styles.label}>
                    <Icon name="sliders-h" size="sm" />
                    <span>Resolution & Preset</span>
                  </div>
                  <span className={styles.metaBadge}>
                    {matchingPreset ? matchingPreset.label : 'Custom Size'}
                  </span>
                </div>

                {/* Preset Dropdown */}
                <select
                  value={matchingPreset?.id ?? 'custom'}
                  onChange={(e) => {
                    const preset = SIZE_PRESETS.find((p) => p.id === e.target.value);
                    if (preset) handleSelectPreset(preset);
                  }}
                  className={styles.selectInput}
                  aria-label="Resolution preset"
                >
                  <option value="custom">Custom Size ({s.width}×{s.height})</option>
                  {SIZE_GROUPS.map((group) => (
                    <optgroup key={group} label={group}>
                      {SIZE_PRESETS.filter((p) => p.group === group).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} — {p.width}×{p.height} ({aspectRatioLabel(p.width, p.height)})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>

                {/* Dimensions Controls: Width, Lock, Height, Swap */}
                <div className={styles.dimensionControlsRow}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Width</span>
                    <ValueField
                      value={s.width}
                      onChange={handleWidthChange}
                      min={16}
                      max={7680}
                      step={1}
                      unit="px"
                      aria-label="Width"
                    />
                  </div>

                  <IconButton
                    size="sm"
                    variant="secondary"
                    active={aspectLocked}
                    onClick={toggleAspectLock}
                    tooltip={aspectLocked ? 'Aspect ratio locked (click to unlock)' : 'Lock aspect ratio'}
                    aria-label={aspectLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                  >
                    <Icon name="link" size="sm" />
                  </IconButton>

                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Height</span>
                    <ValueField
                      value={s.height}
                      onChange={handleHeightChange}
                      min={16}
                      max={7680}
                      step={1}
                      unit="px"
                      aria-label="Height"
                    />
                  </div>

                  <IconButton
                    size="sm"
                    variant="secondary"
                    onClick={handleSwapDimensions}
                    tooltip="Swap width and height (flip orientation)"
                    aria-label="Swap width and height"
                  >
                    <Icon name="rotate" size="sm" />
                  </IconButton>
                </div>
              </div>

              {/* Time & Frame Rate */}
              <div className={styles.section}>
                <div className={styles.label}>Time & Frame Rate</div>
                <div className={styles.timingRow}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Frame Rate</span>
                    <ValueField
                      value={s.fps}
                      onChange={setFps}
                      min={1}
                      max={240}
                      step={1}
                      unit="fps"
                      aria-label="Frame rate"
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Duration</span>
                    <ValueField
                      value={s.durationSeconds}
                      onChange={setDuration}
                      min={0.1}
                      max={MAX_DURATION}
                      step={0.5}
                      unit="s"
                      aria-label="Duration"
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel} title="The timecode frame 0 is labelled with (display only)">
                      Start Frame
                    </span>
                    <ValueField
                      value={s.startFrame}
                      onChange={setStartFrame}
                      min={0}
                      step={1}
                      unit="f"
                      aria-label="Start timecode (frames)"
                    />
                  </div>
                </div>

                <div className={styles.chips}>
                  {FPS_PRESETS.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      title={f.label}
                      className={`${styles.chip} ${sameRate(f.value, s.fps) ? styles.chipActive : ''}`}
                      onClick={() => setFps(f.value)}
                    >
                      {f.value} fps
                    </button>
                  ))}
                </div>

                <div className={styles.hint} style={{ opacity: 0.7, marginTop: 2 }}>
                  {`Timecode starts at ${framesToTimecode(0, s.fps, s.startFrame)} · display only`}
                </div>
              </div>

              {/* Pixel Aspect Ratio */}
              <div className={styles.section}>
                <div className={styles.label}>Pixel Aspect Ratio</div>
                <div className={styles.row}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Preset</span>
                    <select
                      className={styles.selectInput}
                      value={parPresetId}
                      onChange={(e) => {
                        const preset = PIXEL_ASPECT_PRESETS.find((p) => p.id === e.target.value);
                        setPixelAspect(preset ? preset.value : DEFAULT_PIXEL_ASPECT);
                      }}
                      aria-label="Pixel aspect ratio preset"
                    >
                      {parPresetId === '' && <option value="">Custom</option>}
                      {PIXEL_ASPECT_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Ratio</span>
                    <ValueField
                      value={pixelAspect}
                      onChange={setPixelAspect}
                      min={0.1}
                      max={10}
                      step={0.01}
                      precision={4}
                      aria-label="Pixel aspect ratio"
                    />
                  </div>
                </div>
                <div className={styles.hint} style={{ opacity: 0.7 }}>
                  {describePixelAspect(pixelAspect)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: BACKGROUND */}
        {activeTab === 'background' && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.label}>Scene Canvas Background</div>
              <span className={styles.metaBadge}>
                {s.transparent ? 'Transparent' : bgPaint.type.toUpperCase()}
              </span>
            </div>
            <p className={styles.hint}>
              The composition background rendered on the canvas and included in video exports.
            </p>

            {/* Fill Mode Segmented Control */}
            <div className={styles.bgRow} style={{ marginTop: 2 }}>
              <div className={styles.segmentedControl}>
                {(['solid', 'linear', 'radial'] as FillType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    title={`${t[0]!.toUpperCase()}${t.slice(1)} background`}
                    className={`${styles.segmentBtn} ${!s.transparent && bgPaint.type === t ? styles.segmentBtnActive : ''}`}
                    disabled={s.transparent}
                    onClick={() => setBgType(t)}
                  >
                    {t === 'solid' ? 'Solid' : t === 'linear' ? 'Linear' : 'Radial'}
                  </button>
                ))}
              </div>
            </div>

            {/* Canvas Alpha Channel Switch */}
            <div className={styles.colorCardRow} style={{ marginTop: 4 }}>
              <span className={styles.colorCardLabel}>Canvas Transparency (Alpha)</span>
              <Switch
                checked={s.transparent}
                aria-label="Canvas Transparency"
                onChange={(e) => setTransparent(e.target.checked)}
              />
            </div>

            {/* Quick Studio Color Swatches */}
            <div className={styles.colorCardRow}>
              <span className={styles.colorCardLabel}>Studio Presets</span>
              <div className={styles.swatchRow} role="group" aria-label="Studio swatches">
                {STUDIO_COLOR_SWATCHES.map((swatch) => {
                  const isSelected =
                    !s.transparent &&
                    bgPaint.type === 'solid' &&
                    s.background.toLowerCase() === swatch.hex.toLowerCase();
                  return (
                    <button
                      key={swatch.hex}
                      type="button"
                      className={`${styles.colorSwatch} ${isSelected ? styles.colorSwatchActive : ''}`}
                      style={{ backgroundColor: swatch.hex }}
                      onClick={() => {
                        setBackgroundPaint(solidFill(swatch.hex));
                        setTransparent(false);
                      }}
                      title={swatch.label}
                      aria-label={swatch.label}
                    />
                  );
                })}
              </div>
            </div>

            {!s.transparent && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {bgPaint.type === 'solid' && (
                  <div className={styles.colorCardRow}>
                    <span className={styles.colorCardLabel}>Solid Fill Color</span>
                    <ColorPicker
                      value={s.background}
                      onChange={(hex) => setBackgroundPaint(solidFill(hex))}
                      aria-label="Background color"
                    />
                  </div>
                )}

                {bgPaint.type === 'linear' && (
                  <div className={styles.colorCardRow}>
                    <span className={styles.colorCardLabel}>Gradient Angle</span>
                    <div style={{ width: 140 }}>
                      <ValueField
                        value={bgPaint.angle}
                        onChange={(angle) => setBackgroundPaint({ ...bgPaint, angle })}
                        min={0}
                        max={360}
                        step={1}
                        unit="°"
                        aria-label="Gradient angle"
                      />
                    </div>
                  </div>
                )}

                {bgPaint.type === 'radial' && (
                  <div className={styles.colorCardRow}>
                    <span className={styles.colorCardLabel}>Gradient Radius</span>
                    <div style={{ width: 140 }}>
                      <ValueField
                        value={Math.round(bgPaint.radius * 100)}
                        onChange={(v) => setBackgroundPaint({ ...bgPaint, radius: v / 100 })}
                        min={1}
                        max={200}
                        step={1}
                        unit="%"
                        aria-label="Gradient radius"
                      />
                    </div>
                  </div>
                )}

                {bgPaint.type !== 'solid' && (
                  <div className={styles.stopsContainer}>
                    <div className={styles.sectionHeader}>
                      <span className={styles.colorCardLabel}>Gradient Stops</span>
                      {gradientTrackPreview && (
                        <div
                          className={styles.gradientTrackPreview}
                          style={{ background: gradientTrackPreview, maxWidth: 260 }}
                        />
                      )}
                    </div>
                    {sortedStops(bgPaint.stops).map((stop) => (
                      <div key={stop.id} className={styles.stopRow}>
                        <ColorPicker
                          compact
                          value={stop.color}
                          onChange={(color) => writeStop(stop.id, { color })}
                          aria-label="Stop color"
                        />
                        <ValueField
                          value={Math.round(stop.offset * 100)}
                          onChange={(v) => writeStop(stop.id, { offset: v / 100 })}
                          min={0}
                          max={100}
                          step={1}
                          unit="%"
                          aria-label="Stop position"
                        />
                        <button
                          type="button"
                          className={styles.chip}
                          title="Remove stop"
                          disabled={bgPaint.stops.length <= 2}
                          onClick={() => removeStop(stop.id)}
                          style={{ height: 26, width: 26, padding: 0, display: 'grid', placeItems: 'center' }}
                        >
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                    ))}
                    <Button
                      variant="ghost"
                      size="sm"
                      leftIcon={<Icon name="plus" size="sm" />}
                      onClick={addStop}
                      style={{ alignSelf: 'flex-start', marginTop: 2 }}
                    >
                      Add Stop
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Export Format Alpha Preserved Card */}
            {s.transparent && (
              <div className={styles.formatCalloutCard} style={{ marginTop: 4 }}>
                <div className={styles.formatCalloutItem}>
                  <span className={styles.formatTagPreserved}>✓ Keeps Alpha:</span>
                  <span><strong>MOV</strong> (ProRes 4444), <strong>WebM</strong> (VP9), <strong>PNG</strong> & PNG sequence.</span>
                </div>
                <div className={styles.formatCalloutItem}>
                  <span style={{ color: 'var(--color-text-muted)' }}>Composited over black:</span>
                  <span>MP4, GIF, JPG sequence (no alpha channel).</span>
                </div>
                <div className={styles.formatCalloutItem}>
                  <span style={{ color: 'var(--color-text-muted)' }}>Lottie / JSON:</span>
                  <span>Carries no canvas background; takes whatever is behind the player.</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: GRID & GUIDES */}
        {activeTab === 'grid' && (
          <>
            <div className={styles.section}>
              <div className={styles.label}>Pixel Grid</div>
              <div className={styles.row}>
                <Switch checked={gridOn} onChange={() => toggleGrid()} label="Show grid" />
                <Switch checked={snapToGrid} onChange={() => toggleSnapToGrid()} label="Snap to grid" />
              </div>

              <div className={styles.row} style={{ marginTop: 4 }}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Gridline every</span>
                  <ValueField
                    value={gridSpacing}
                    onChange={setGridSpacing}
                    min={1}
                    max={10000}
                    step={1}
                    unit="px"
                    aria-label="Gridline every (pixels)"
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Subdivisions</span>
                  <ValueField
                    value={gridSubdivisions}
                    onChange={setGridSubdivisions}
                    min={1}
                    max={64}
                    step={1}
                    aria-label="Grid subdivisions"
                  />
                </div>
              </div>

              <div className={styles.row} style={{ marginTop: 4 }}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Style</span>
                  <select
                    className={styles.selectInput}
                    value={gridStyle}
                    onChange={(e) => setGridStyle(e.target.value as GridStyle)}
                    aria-label="Grid style"
                  >
                    <option value="lines">Lines</option>
                    <option value="dashed">Dashed Lines</option>
                    <option value="dots">Dots</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Line color</span>
                  <ColorPicker
                    value={gridColor}
                    onChange={setGridColor}
                    aria-label="Grid line color"
                  />
                </div>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Proportional Grid</div>
              <div className={styles.bgRow}>
                <Switch
                  checked={proportionalGrid}
                  onChange={() => toggleProportionalGrid()}
                  label="Show proportional grid"
                />
              </div>
              <div className={styles.row} style={{ marginTop: 4 }}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Columns</span>
                  <ValueField
                    value={proportionalColumns}
                    onChange={setProportionalColumns}
                    min={1}
                    max={64}
                    step={1}
                    aria-label="Proportional grid columns"
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Rows</span>
                  <ValueField
                    value={proportionalRows}
                    onChange={setProportionalRows}
                    min={1}
                    max={64}
                    step={1}
                    aria-label="Proportional grid rows"
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {/* TAB 4: WORLD */}
        {activeTab === 'world' && (
          <>
            <div className={styles.section}>
              <div className={styles.label}>Default Sky Preset</div>
              <p className={styles.hint}>
                The sky an environment light starts on. Existing lights keep their own image.
              </p>
              <div className={styles.field}>
                <select
                  className={styles.selectInput}
                  value={defaultEnvPreset}
                  onChange={(e) => setDefaultEnvPreset(e.target.value)}
                  aria-label="Default environment sky"
                >
                  {ENVIRONMENT_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Ground Level</div>
              <p className={styles.hint}>
                Reference 3D floor plane height, measured downward from the composition bottom.
              </p>
              <div className={styles.field} style={{ maxWidth: 200 }}>
                <span className={styles.fieldLabel}>Offset from comp bottom</span>
                <ValueField
                  value={groundLevel}
                  onChange={setGroundLevel}
                  step={10}
                  unit="px"
                  aria-label="Ground level"
                />
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Ambient Occlusion (SSAO)</div>
              <p className={styles.hint}>
                Contact darkening between proximate 3D surfaces. Dims ambient light only.
              </p>
              <div className={styles.colorCardRow}>
                <span className={styles.colorCardLabel}>Enable Ambient Occlusion</span>
                <Switch
                  checked={ssao.enabled}
                  onChange={(e) => patchSsao({ enabled: e.target.checked })}
                  aria-label="Enable ambient occlusion"
                />
              </div>
              <div className={styles.row}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Radius</span>
                  <ValueField
                    value={ssao.radius}
                    onChange={(v) => patchSsao({ radius: v })}
                    min={1}
                    max={2000}
                    step={5}
                    unit="px"
                    disabled={!ssao.enabled}
                    aria-label="Ambient occlusion radius"
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Intensity</span>
                  <ValueField
                    value={ssao.intensity}
                    onChange={(v) => patchSsao({ intensity: v })}
                    min={0}
                    max={2}
                    step={0.05}
                    disabled={!ssao.enabled}
                    aria-label="Ambient occlusion intensity"
                  />
                </div>
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>Quality</span>
                <select
                  className={styles.selectInput}
                  value={ssao.quality}
                  disabled={!ssao.enabled}
                  onChange={(e) => patchSsao({ quality: e.target.value === 'full' ? 'full' : 'half' })}
                  aria-label="Ambient occlusion quality"
                >
                  <option value="half">Half resolution (faster preview)</option>
                  <option value="full">Full resolution (crisp contact edges)</option>
                </select>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Backdrop Sky</div>
              <div
                className={styles.colorCardRow}
                title="Backdrop quad rendering is not yet available"
              >
                <span className={styles.colorCardLabel}>Show sky as backdrop</span>
                <Switch
                  checked={showSkyBackdrop}
                  disabled
                  onChange={(e) => update({ showSkyBackdrop: e.target.checked })}
                  aria-label="Show sky as backdrop"
                />
              </div>
              <p className={styles.hint}>
                Environment light is currently an irradiance probe, not a rendered background quad.
              </p>
            </div>
          </>
        )}

        {/* TAB 5: TIME */}
        {activeTab === 'time' && <ResponsiveTimeSection />}

        {/* TAB 6: COLOR */}
        {activeTab === 'color' && (
          <>
            <div className={styles.section}>
              <div className={styles.label}>Working Space</div>
              <p className={styles.hint}>Internal color pipeline space where math runs.</p>
              <div className={styles.row}>
                <Button
                  variant={cm.workingSpace === 'srgb-linear' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setWorkingSpace('srgb-linear')}
                >
                  sRGB linear
                </Button>
                <Button
                  variant={cm.workingSpace === 'aces-cg' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setWorkingSpace('aces-cg')}
                >
                  ACEScg
                </Button>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Display Transform</div>
              <p className={styles.hint}>Output mapping to the viewport monitor canvas.</p>
              <div className={styles.row}>
                <Button
                  variant={cm.displayTransform === 'srgb' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setDisplayTransform('srgb')}
                >
                  sRGB
                </Button>
                <Button
                  variant={cm.displayTransform === 'aces' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setDisplayTransform('aces')}
                >
                  ACES (sRGB ODT)
                </Button>
                <Button
                  variant={cm.displayTransform === 'pq' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setDisplayTransform('pq')}
                >
                  PQ (preview)
                </Button>
                <Button
                  variant={cm.displayTransform === 'hlg' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setDisplayTransform('hlg')}
                >
                  HLG (preview)
                </Button>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Viewer LUT</div>
              <p className={styles.hint}>
                Optional monitor 3D LUT (.cube). Session-only, never baked into export.
              </p>
              <div className={styles.row}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = '.cube,text/plain';
                    input.onchange = () => {
                      const file = input.files?.[0];
                      if (!file) return;
                      void file.text().then((text) => {
                        if (!loadViewerLut(text, file.name)) {
                          console.warn('[Viewer LUT] could not parse', file.name);
                        }
                      });
                    };
                    input.click();
                  }}
                >
                  Load .cube…
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!viewerLutName}
                  onClick={() => clearViewerLut()}
                >
                  Clear LUT
                </Button>
              </div>
              {viewerLutName && (
                <span className={styles.metaBadge} title={viewerLutName}>
                  Active: {viewerLutName}
                </span>
              )}
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Intermediate Bit Depth</div>
              <p className={styles.hint}>Float precision for scene-color and render targets.</p>
              <div className={styles.row}>
                <Button
                  variant={cm.bitDepth === 16 ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setBitDepth(16 as IntermediateBitDepth)}
                >
                  16-bit float
                </Button>
                <Button
                  variant={cm.bitDepth === 32 ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setBitDepth(32 as IntermediateBitDepth)}
                >
                  32-bit float
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Dialog Footer Actions */}
      <DialogFooter
        secondary={
          <Button variant="secondary" size="md" onClick={handleCancel}>
            Cancel
          </Button>
        }
        primary={
          <Button
            variant="primary"
            size="md"
            leftIcon={<Icon name="check" size="md" />}
            onClick={handleSave}
          >
            Save Changes
          </Button>
        }
      />
    </div>
  );
}

/**
 * Open Composition Settings as a standard modal dialog, styled consistently with
 * other popup modals in the application.
 */
export function openCompositionSettings(): void {
  // B4: the active composition's settings from the document mirror.
  const comp = documentMirror().comp(activeCompIdNow() ?? '')?.settings;
  const description = `${comp?.name || 'Composition'} · ${comp?.width ?? 1920} × ${comp?.height ?? 1080} · ${settingsFps(comp)} fps`;

  openModal({
    id: 'composition-settings',
    title: 'Composition Settings',
    description,
    size: 'lg',
    className: styles.dialogWindow,
    render: (close) => <CompositionSettings close={close} />,
  });
}


