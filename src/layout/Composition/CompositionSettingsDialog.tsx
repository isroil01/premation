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
import { sanitize as sanitizeComp } from '@stores/compositionStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow, useMirrorProjectSettings } from '@hooks/useMirror';
import { edit as engineEdit } from '@core/engine/uiEdits';
import type { ColorWorkingSpace } from '@motion/engine-api';
import { compRecordFromSettings, settingsFps } from '@core/mirror/compFacts';
import {
  resolveSsao,
  resolveFog,
  resolveGroundShadows,
  resolveRenderer,
  resolvePixelAspect,
  DEFAULT_PIXEL_ASPECT,
  type CompositionSettings as CompRecord,
  type SsaoSettings,
  type FogSettings,
  type GroundShadowSettings,
  type RendererSettings,
} from '@stores/projectStore';
import { saveCompositionSettingsEdit } from './compositionEdits';
import { useGuidesStore, type GridStyle } from '@stores/guidesStore';
import { useColorManagementStore, type IntermediateBitDepth } from '@stores/colorManagementStore';
import { useViewerLutStore } from '@stores/viewerLutStore';
import {
  SIZE_PRESETS,
  SIZE_GROUPS,
  sizeGroupLabel,
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
  pixelAspectLabel,
} from './pixelAspectPresets';
import {
  ENVIRONMENT_PRESETS,
  DEFAULT_ENVIRONMENT_PRESET,
  isEnvironmentPresetId,
  type EnvironmentPresetId,
} from '@core/scene/environmentLight';
import styles from './CompositionSettingsDialog.module.css';
import { t } from '@core/i18n';

export type TabId = 'general' | 'background' | 'grid' | 'world' | 'renderer' | 'time' | 'color';

/* eslint-disable design-system/no-hex-color -- Studio background hex values are composition document presets */
function studioColorSwatches(): Array<{ label: string; hex: string }> {
  return [
    { label: t('composition.settings.swatchStudioDark', 'Studio Dark'), hex: '#101014' },
    { label: t('composition.settings.swatchDeepBlack', 'Deep Black'), hex: '#000000' },
    { label: t('composition.settings.swatchSlateCharcoal', 'Slate Charcoal'), hex: '#1c1c22' },
    { label: t('composition.settings.swatchCleanWhite', 'Clean White'), hex: '#ffffff' },
  ];
}
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

/** The active composition's record, from the mirror (a blank default when the document has none yet). */
function initialRecord(): CompRecord {
  const id = activeCompIdNow() ?? '';
  const settings = documentMirror().comp(id)?.settings;
  return settings
    ? compRecordFromSettings(id, settings)
    : { id, name: 'Composition', width: 1920, height: 1080, fps: 30, durationSeconds: 10, background: '#000000', transparent: false, startFrame: 0 };
}

/** FPS chips match a typed rate within display precision (23.976 is not exactly representable). */
const sameRate = (a: number, b: number): boolean => Math.abs(a - b) < 1e-3;

export function CompositionSettings({ close }: { close?: () => void }): JSX.Element {
  // B4: the draft starts from the active composition's settings in the document mirror.
  const initialComp = useRef(initialRecord()).current;
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
  // File > Project Settings > Color > Working Space (AE): the project's colour-managed working space (OCIO).
  const projectSettings = useMirrorProjectSettings();
  const projectWorkingSpace = projectSettings?.workingSpace ?? 'none';
  const setProjectWorkingSpace = (ws: ColorWorkingSpace): void => {
    void engineEdit('Project Settings', { type: 'setProjectSettings', patch: { workingSpace: ws } });
  };
  // File > Project Settings > Color > Blend Colors Using 1.0 Gamma (AE): off = layers mix in display values.
  const linearBlending = projectSettings?.linearBlending ?? false;
  const setLinearBlending = (on: boolean): void => {
    void engineEdit('Project Settings', { type: 'setProjectSettings', patch: { linearBlending: on } });
  };
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
    if (s.width === s.height) return t('composition.settings.square', 'Square');
    return s.width > s.height ? t('composition.settings.landscape', 'Landscape') : t('composition.settings.portrait', 'Portrait');
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
  const fog = resolveFog(s);
  const patchFog = (patch: Partial<FogSettings>): void => update({ fog: { ...fog, ...patch } });
  const groundShadows = resolveGroundShadows(s);
  const patchGroundShadows = (patch: Partial<GroundShadowSettings>): void =>
    update({ groundShadows: { ...groundShadows, ...patch } });
  // Renderer (U3): per-comp quality knobs, stored under the World JSON beside `ssao`.
  const renderer = resolveRenderer(s);
  const patchRenderer = (patch: Partial<RendererSettings>): void => update({ renderer: { ...renderer, ...patch } });

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
      <div className={styles.navTabs} role="tablist" aria-label={t('composition.settings.compositionSettingsTabs', 'Composition settings tabs')}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'general'}
          className={`${styles.navTab} ${activeTab === 'general' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('general')}
        >
          <Icon name="sliders-h" size="sm" />
          <span>{t('composition.settings.general', 'General')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'background'}
          className={`${styles.navTab} ${activeTab === 'background' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('background')}
        >
          <Icon name="brush" size="sm" />
          <span>{t('composition.settings.background', 'Background')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'grid'}
          className={`${styles.navTab} ${activeTab === 'grid' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('grid')}
        >
          <Icon name="grid" size="sm" />
          <span>{t('composition.settings.gridGuides', 'Grid & Guides')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'world'}
          className={`${styles.navTab} ${activeTab === 'world' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('world')}
        >
          <Icon name="axis-world" size="sm" />
          <span>{t('composition.settings.world', 'World')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'renderer'}
          className={`${styles.navTab} ${activeTab === 'renderer' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('renderer')}
        >
          <Icon name="cube" size="sm" />
          <span>{t('composition.settings.renderer', 'Renderer')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'time'}
          className={`${styles.navTab} ${activeTab === 'time' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('time')}
        >
          <Icon name="keyframe" size="sm" />
          <span>{t('composition.settings.time', 'Time')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'color'}
          className={`${styles.navTab} ${activeTab === 'color' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('color')}
        >
          <Icon name="palette" size="sm" />
          <span>{t('composition.settings.color', 'Color')}</span>
        </button>
      </div>

      <div className={styles.tabBody}>
        {/* TAB 1: GENERAL */}
        {activeTab === 'general' && (
          <div className={styles.columns}>
            {/* Left Column: Live Visual Interactive Preview Card */}
            <div className={styles.leftCol}>
              <div className={styles.previewCard} aria-label={t('composition.settings.compositionPreview', 'Composition preview')}>
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
                  <span>{t('composition.settings.popularPresets', 'Popular Presets')}</span>
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
                <div className={styles.label}>{t('composition.settings.compositionName2', 'Composition Name')}</div>
                <Input
                  value={s.name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Composition 1"
                  aria-label={t('composition.settings.compositionName', 'Composition name')}
                />
              </div>

              {/* Dimensions & Presets */}
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <div className={styles.label}>
                    <Icon name="sliders-h" size="sm" />
                    <span>{t('composition.settings.resolutionPreset2', 'Resolution & Preset')}</span>
                  </div>
                  <span className={styles.metaBadge}>
                    {matchingPreset ? matchingPreset.label : t('composition.settings.customSize', 'Custom Size')}
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
                  aria-label={t('composition.settings.resolutionPreset', 'Resolution preset')}
                >
                  <option value="custom">{t('composition.settings.customSizeOption', 'Custom Size ({w}×{h})', { w: s.width, h: s.height })}</option>
                  {SIZE_GROUPS.map((group) => (
                    <optgroup key={group} label={sizeGroupLabel(group)}>
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
                    <span className={styles.fieldLabel}>{t('composition.settings.width', 'Width')}</span>
                    <ValueField
                      value={s.width}
                      onChange={handleWidthChange}
                      min={16}
                      max={7680}
                      step={1}
                      unit="px"
                      aria-label={t('composition.settings.width', 'Width')}
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
                    <span className={styles.fieldLabel}>{t('composition.settings.height', 'Height')}</span>
                    <ValueField
                      value={s.height}
                      onChange={handleHeightChange}
                      min={16}
                      max={7680}
                      step={1}
                      unit="px"
                      aria-label={t('composition.settings.height', 'Height')}
                    />
                  </div>

                  <IconButton
                    size="sm"
                    variant="secondary"
                    onClick={handleSwapDimensions}
                    tooltip={t('composition.settings.swapWidthAndHeightFlip', 'Swap width and height (flip orientation)')}
                    aria-label={t('composition.settings.swapWidthAndHeight', 'Swap width and height')}
                  >
                    <Icon name="rotate" size="sm" />
                  </IconButton>
                </div>
              </div>

              {/* Time & Frame Rate */}
              <div className={styles.section}>
                <div className={styles.label}>{t('composition.settings.timeFrameRate', 'Time & Frame Rate')}</div>
                <div className={styles.timingRow}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('composition.settings.frameRate2', 'Frame Rate')}</span>
                    <ValueField
                      value={s.fps}
                      onChange={setFps}
                      min={1}
                      max={240}
                      step={1}
                      unit="fps"
                      aria-label={t('composition.settings.frameRate', 'Frame rate')}
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('composition.settings.duration', 'Duration')}</span>
                    <ValueField
                      value={s.durationSeconds}
                      onChange={setDuration}
                      min={0.1}
                      max={MAX_DURATION}
                      step={0.5}
                      unit="s"
                      aria-label={t('composition.settings.duration', 'Duration')}
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel} title={t('composition.settings.theTimecodeFrame0Is', 'The timecode frame 0 is labelled with (display only)')}>
                      {t('composition.settings.startFrame', 'Start Frame')}
                    </span>
                    <ValueField
                      value={s.startFrame}
                      onChange={setStartFrame}
                      min={0}
                      step={1}
                      unit="f"
                      aria-label={t('composition.settings.startTimecodeFrames', 'Start timecode (frames)')}
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
                  {t('composition.settings.timecodeStarts', 'Timecode starts at {tc} · display only', { tc: framesToTimecode(0, s.fps, s.startFrame) })}
                </div>
              </div>

              {/* Pixel Aspect Ratio */}
              <div className={styles.section}>
                <div className={styles.label}>{t('composition.settings.pixelAspectRatio2', 'Pixel Aspect Ratio')}</div>
                <div className={styles.row}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('composition.settings.preset', 'Preset')}</span>
                    <select
                      className={styles.selectInput}
                      value={parPresetId}
                      onChange={(e) => {
                        const preset = PIXEL_ASPECT_PRESETS.find((p) => p.id === e.target.value);
                        setPixelAspect(preset ? preset.value : DEFAULT_PIXEL_ASPECT);
                      }}
                      aria-label={t('composition.settings.pixelAspectRatioPreset', 'Pixel aspect ratio preset')}
                    >
                      {parPresetId === '' && <option value="">{t('composition.settings.custom', 'Custom')}</option>}
                      {PIXEL_ASPECT_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>{pixelAspectLabel(p)}</option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('composition.settings.ratio', 'Ratio')}</span>
                    <ValueField
                      value={pixelAspect}
                      onChange={setPixelAspect}
                      min={0.1}
                      max={10}
                      step={0.01}
                      precision={4}
                      aria-label={t('composition.settings.pixelAspectRatio', 'Pixel aspect ratio')}
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
              <div className={styles.label}>{t('composition.settings.sceneCanvasBackground', 'Scene Canvas Background')}</div>
              <span className={styles.metaBadge}>
                {s.transparent ? t('composition.settings.transparent', 'Transparent') : bgPaint.type.toUpperCase()}
              </span>
            </div>
            <p className={styles.hint}>
              {t('composition.settings.theCompositionBackgroundRenderedOn', 'The composition background rendered on the canvas and included in video exports.')}
            </p>

            {/* Fill Mode Segmented Control */}
            <div className={styles.bgRow} style={{ marginTop: 2 }}>
              <div className={styles.segmentedControl}>
                {(['solid', 'linear', 'radial'] as FillType[]).map((ft) => (
                  <button
                    key={ft}
                    type="button"
                    title={ft === 'solid'
                      ? t('composition.settings.bgSolidTitle', 'Solid background')
                      : ft === 'linear'
                        ? t('composition.settings.bgLinearTitle', 'Linear background')
                        : t('composition.settings.bgRadialTitle', 'Radial background')}
                    className={`${styles.segmentBtn} ${!s.transparent && bgPaint.type === ft ? styles.segmentBtnActive : ''}`}
                    disabled={s.transparent}
                    onClick={() => setBgType(ft)}
                  >
                    {ft === 'solid'
                      ? t('composition.settings.bgSolid', 'Solid')
                      : ft === 'linear'
                        ? t('composition.settings.bgLinear', 'Linear')
                        : t('composition.settings.bgRadial', 'Radial')}
                  </button>
                ))}
              </div>
            </div>

            {/* Canvas Alpha Channel Switch */}
            <div className={styles.colorCardRow} style={{ marginTop: 4 }}>
              <span className={styles.colorCardLabel}>{t('composition.settings.canvasTransparencyAlpha', 'Canvas Transparency (Alpha)')}</span>
              <Switch
                checked={s.transparent}
                aria-label={t('composition.settings.canvasTransparency', 'Canvas Transparency')}
                onChange={(e) => setTransparent(e.target.checked)}
              />
            </div>

            {/* Quick Studio Color Swatches */}
            <div className={styles.colorCardRow}>
              <span className={styles.colorCardLabel}>{t('composition.settings.studioPresets', 'Studio Presets')}</span>
              <div className={styles.swatchRow} role="group" aria-label={t('composition.settings.studioSwatches', 'Studio swatches')}>
                {studioColorSwatches().map((swatch) => {
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
                    <span className={styles.colorCardLabel}>{t('composition.settings.solidFillColor', 'Solid Fill Color')}</span>
                    <ColorPicker
                      value={s.background}
                      onChange={(hex) => setBackgroundPaint(solidFill(hex))}
                      aria-label={t('composition.settings.backgroundColor', 'Background color')}
                    />
                  </div>
                )}

                {bgPaint.type === 'linear' && (
                  <div className={styles.colorCardRow}>
                    <span className={styles.colorCardLabel}>{t('composition.settings.gradientAngle2', 'Gradient Angle')}</span>
                    <div style={{ width: 140 }}>
                      <ValueField
                        value={bgPaint.angle}
                        onChange={(angle) => setBackgroundPaint({ ...bgPaint, angle })}
                        min={0}
                        max={360}
                        step={1}
                        unit="°"
                        aria-label={t('composition.settings.gradientAngle', 'Gradient angle')}
                      />
                    </div>
                  </div>
                )}

                {bgPaint.type === 'radial' && (
                  <div className={styles.colorCardRow}>
                    <span className={styles.colorCardLabel}>{t('composition.settings.gradientRadius2', 'Gradient Radius')}</span>
                    <div style={{ width: 140 }}>
                      <ValueField
                        value={Math.round(bgPaint.radius * 100)}
                        onChange={(v) => setBackgroundPaint({ ...bgPaint, radius: v / 100 })}
                        min={1}
                        max={200}
                        step={1}
                        unit="%"
                        aria-label={t('composition.settings.gradientRadius', 'Gradient radius')}
                      />
                    </div>
                  </div>
                )}

                {bgPaint.type !== 'solid' && (
                  <div className={styles.stopsContainer}>
                    <div className={styles.sectionHeader}>
                      <span className={styles.colorCardLabel}>{t('composition.settings.gradientStops', 'Gradient Stops')}</span>
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
                          aria-label={t('composition.settings.stopColor', 'Stop color')}
                        />
                        <ValueField
                          value={Math.round(stop.offset * 100)}
                          onChange={(v) => writeStop(stop.id, { offset: v / 100 })}
                          min={0}
                          max={100}
                          step={1}
                          unit="%"
                          aria-label={t('composition.settings.stopPosition', 'Stop position')}
                        />
                        <button
                          type="button"
                          className={styles.chip}
                          title={t('composition.settings.removeStop', 'Remove stop')}
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
                      {t('composition.settings.addStop', 'Add Stop')}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Export Format Alpha Preserved Card */}
            {s.transparent && (
              <div className={styles.formatCalloutCard} style={{ marginTop: 4 }}>
                <div className={styles.formatCalloutItem}>
                  <span className={styles.formatTagPreserved}>✓ {t('composition.settings.keepsAlpha', 'Keeps Alpha:')}</span>
                  <span><strong>MOV</strong> (ProRes 4444), <strong>WebM</strong> (VP9), <strong>PNG</strong> {t('composition.settings.andPngSequence', '& PNG sequence.')}</span>
                </div>
                <div className={styles.formatCalloutItem}>
                  <span style={{ color: 'var(--color-text-muted)' }}>{t('composition.settings.compositedOverBlack', 'Composited over black:')}</span>
                  <span>{t('composition.settings.mp4GifJpgSequenceNo', 'MP4, GIF, JPG sequence (no alpha channel).')}</span>
                </div>
                <div className={styles.formatCalloutItem}>
                  <span style={{ color: 'var(--color-text-muted)' }}>{t('composition.settings.lottieJson', 'Lottie / JSON:')}</span>
                  <span>{t('composition.settings.carriesNoCanvasBackgroundTakes', 'Carries no canvas background; takes whatever is behind the player.')}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: GRID & GUIDES */}
        {activeTab === 'grid' && (
          <>
            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.pixelGrid', 'Pixel Grid')}</div>
              <div className={styles.row}>
                <Switch checked={gridOn} onChange={() => toggleGrid()} label={t('composition.settings.showGrid', 'Show grid')} />
                <Switch checked={snapToGrid} onChange={() => toggleSnapToGrid()} label={t('composition.settings.snapToGrid', 'Snap to grid')} />
              </div>

              <div className={styles.row} style={{ marginTop: 4 }}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.gridlineEvery', 'Gridline every')}</span>
                  <ValueField
                    value={gridSpacing}
                    onChange={setGridSpacing}
                    min={1}
                    max={10000}
                    step={1}
                    unit="px"
                    aria-label={t('composition.settings.gridlineEveryPixels', 'Gridline every (pixels)')}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.subdivisions', 'Subdivisions')}</span>
                  <ValueField
                    value={gridSubdivisions}
                    onChange={setGridSubdivisions}
                    min={1}
                    max={64}
                    step={1}
                    aria-label={t('composition.settings.gridSubdivisions', 'Grid subdivisions')}
                  />
                </div>
              </div>

              <div className={styles.row} style={{ marginTop: 4 }}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.style', 'Style')}</span>
                  <select
                    className={styles.selectInput}
                    value={gridStyle}
                    onChange={(e) => setGridStyle(e.target.value as GridStyle)}
                    aria-label={t('composition.settings.gridStyle', 'Grid style')}
                  >
                    <option value="lines">{t('composition.settings.lines', 'Lines')}</option>
                    <option value="dashed">{t('composition.settings.dashedLines', 'Dashed Lines')}</option>
                    <option value="dots">{t('composition.settings.dots', 'Dots')}</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.lineColor', 'Line color')}</span>
                  <ColorPicker
                    value={gridColor}
                    onChange={setGridColor}
                    aria-label={t('composition.settings.gridLineColor', 'Grid line color')}
                  />
                </div>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.proportionalGrid', 'Proportional Grid')}</div>
              <div className={styles.bgRow}>
                <Switch
                  checked={proportionalGrid}
                  onChange={() => toggleProportionalGrid()}
                  label={t('composition.settings.showProportionalGrid', 'Show proportional grid')}
                />
              </div>
              <div className={styles.row} style={{ marginTop: 4 }}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.columns', 'Columns')}</span>
                  <ValueField
                    value={proportionalColumns}
                    onChange={setProportionalColumns}
                    min={1}
                    max={64}
                    step={1}
                    aria-label={t('composition.settings.proportionalGridColumns', 'Proportional grid columns')}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.rows', 'Rows')}</span>
                  <ValueField
                    value={proportionalRows}
                    onChange={setProportionalRows}
                    min={1}
                    max={64}
                    step={1}
                    aria-label={t('composition.settings.proportionalGridRows', 'Proportional grid rows')}
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
              <div className={styles.label}>{t('composition.settings.defaultSkyPreset', 'Default Sky Preset')}</div>
              <p className={styles.hint}>
                {t('composition.settings.theSkyAnEnvironmentLight', 'The sky an environment light starts on. Existing lights keep their own image.')}
              </p>
              <div className={styles.field}>
                <select
                  className={styles.selectInput}
                  value={defaultEnvPreset}
                  onChange={(e) => setDefaultEnvPreset(e.target.value)}
                  aria-label={t('composition.settings.defaultEnvironmentSky', 'Default environment sky')}
                >
                  {ENVIRONMENT_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.groundLevel2', 'Ground Level')}</div>
              <p className={styles.hint}>
                {t('composition.settings.reference3dFloorPlaneHeight', 'Reference 3D floor plane height, measured downward from the composition bottom.')}
              </p>
              <div className={styles.field} style={{ maxWidth: 200 }}>
                <span className={styles.fieldLabel}>{t('composition.settings.offsetFromCompBottom', 'Offset from comp bottom')}</span>
                <ValueField
                  value={groundLevel}
                  onChange={setGroundLevel}
                  step={10}
                  unit="px"
                  aria-label={t('composition.settings.groundLevel', 'Ground level')}
                />
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.groundShadows2', 'Ground Shadows')}</div>
              <p className={styles.hint}>
                {t('composition.settings.anInvisibleFloorAtThe', 'An invisible floor at the ground level catches the shadows of shadow-casting lights.')}
              </p>
              <div className={styles.colorCardRow}>
                <span className={styles.colorCardLabel}>{t('composition.settings.catchShadowsOnTheGround', 'Catch shadows on the ground')}</span>
                <Switch
                  checked={groundShadows.enabled}
                  onChange={(e) => patchGroundShadows({ enabled: e.target.checked })}
                  aria-label={t('composition.settings.groundShadows', 'Ground shadows')}
                />
              </div>
              <div className={styles.field} style={{ maxWidth: 200 }}>
                <span className={styles.fieldLabel}>{t('composition.settings.shadowOpacity', 'Shadow opacity')}</span>
                <ValueField
                  value={groundShadows.opacity}
                  onChange={(v) => patchGroundShadows({ opacity: v })}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  disabled={!groundShadows.enabled}
                  aria-label={t('composition.settings.groundShadowOpacity', 'Ground shadow opacity')}
                />
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.fog', 'Fog')}</div>
              <p className={styles.hint}>
                {t('composition.settings.distanceFogOverThe3d', 'Distance fog over the 3D layers, thickening away from the camera.')}
              </p>
              <div className={styles.colorCardRow}>
                <span className={styles.colorCardLabel}>{t('composition.settings.enableFog', 'Enable fog')}</span>
                <Switch checked={fog.enabled} onChange={(e) => patchFog({ enabled: e.target.checked })} aria-label={t('composition.settings.enableFog', 'Enable fog')} />
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('composition.settings.falloff', 'Falloff')}</span>
                <select
                  className={styles.selectInput}
                  value={fog.mode}
                  disabled={!fog.enabled}
                  onChange={(e) => {
                    const v = e.target.value;
                    patchFog({ mode: v === 'exponential' || v === 'exponential2' ? v : 'linear' });
                  }}
                  aria-label={t('composition.settings.fogFalloff', 'Fog falloff')}
                >
                  <option value="linear">{t('composition.settings.linearStartToEnd', 'Linear (start to end)')}</option>
                  <option value="exponential">{t('composition.settings.exponential', 'Exponential')}</option>
                  <option value="exponential2">{t('composition.settings.exponentialSquared', 'Exponential squared')}</option>
                </select>
              </div>
              <div className={styles.row}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.start', 'Start')}</span>
                  <ValueField value={fog.start} onChange={(v) => patchFog({ start: v })} min={0} step={50} unit="px" disabled={!fog.enabled} aria-label={t('composition.settings.fogStart', 'Fog start')} />
                </div>
                {fog.mode === 'linear' ? (
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('composition.settings.end', 'End')}</span>
                    <ValueField value={fog.end} onChange={(v) => patchFog({ end: v })} min={1} step={50} unit="px" disabled={!fog.enabled} aria-label={t('composition.settings.fogEnd', 'Fog end')} />
                  </div>
                ) : (
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('composition.settings.density', 'Density')}</span>
                    <ValueField value={fog.density} onChange={(v) => patchFog({ density: v })} min={0} step={0.05} disabled={!fog.enabled} aria-label={t('composition.settings.fogDensity', 'Fog density')} />
                  </div>
                )}
              </div>
              <div className={styles.row}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.color', 'Color')}</span>
                  <ColorPicker value={fog.color} onChange={(v) => patchFog({ color: v })} aria-label={t('composition.settings.fogColor', 'Fog color')} />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.maxOpacity', 'Max opacity')}</span>
                  <ValueField value={fog.maxOpacity} onChange={(v) => patchFog({ maxOpacity: v })} min={0} max={100} step={1} unit="%" disabled={!fog.enabled} aria-label={t('composition.settings.fogMaximumOpacity', 'Fog maximum opacity')} />
                </div>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.backdropSky', 'Backdrop Sky')}</div>
              <div className={styles.colorCardRow}>
                <span className={styles.colorCardLabel}>{t('composition.settings.showSkyAsBackdrop', 'Show sky as backdrop')}</span>
                <Switch
                  checked={showSkyBackdrop}
                  onChange={(e) => update({ showSkyBackdrop: e.target.checked })}
                  aria-label={t('composition.settings.showSkyAsBackdrop', 'Show sky as backdrop')}
                />
              </div>
              <p className={styles.hint}>
                {t('composition.settings.theEnvironmentLightSSky', "The environment light's sky is drawn behind every layer, rotated with it. Needs an environment light.")}
              </p>
            </div>
          </>
        )}

        {/* TAB 5: RENDERER (U3) — the 3D renderer's quality knobs, per composition. */}
        {activeTab === 'renderer' && (
          <>
            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.shadows', 'Shadows')}</div>
              <p className={styles.hint}>
                {t('composition.settings.mappedShadowsFromTheLights', 'Mapped shadows from the lights that cast them. A larger map is sharper and costs more memory and time per light.')}
              </p>
              <div className={styles.row}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.shadowMapSize', 'Shadow map size')}</span>
                  <select
                    className={styles.selectInput}
                    value={renderer.shadowMapSize}
                    onChange={(e) => patchRenderer({ shadowMapSize: Number(e.target.value) === 512 ? 512 : Number(e.target.value) === 2048 ? 2048 : 1024 })}
                    aria-label={t('composition.settings.shadowMapSize', 'Shadow map size')}
                  >
                    <option value={512}>{t('composition.settings.shadowMap512', '512 px (fast)')}</option>
                    <option value={1024}>1024 px</option>
                    <option value={2048}>{t('composition.settings.shadowMap2048', '2048 px (sharp)')}</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.shadowCastingLights', 'Shadow-casting lights')}</span>
                  <ValueField
                    value={renderer.shadowLightCap}
                    onChange={(v) => patchRenderer({ shadowLightCap: Math.max(0, Math.min(16, Math.round(v))) })}
                    min={0}
                    max={16}
                    step={1}
                    aria-label={t('composition.settings.shadowCastingLightCap', 'Shadow-casting light cap')}
                  />
                </div>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.ambientOcclusionSsao', 'Ambient Occlusion (SSAO)')}</div>
              <p className={styles.hint}>
                {t('composition.settings.contactDarkeningBetweenProximate3d', 'Contact darkening between proximate 3D surfaces. Dims ambient light only.')}
              </p>
              <div className={styles.colorCardRow}>
                <span className={styles.colorCardLabel}>{t('composition.settings.enableAmbientOcclusion2', 'Enable Ambient Occlusion')}</span>
                <Switch
                  checked={ssao.enabled}
                  onChange={(e) => patchSsao({ enabled: e.target.checked })}
                  aria-label={t('composition.settings.enableAmbientOcclusion', 'Enable ambient occlusion')}
                />
              </div>
              <div className={styles.row}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.radius', 'Radius')}</span>
                  <ValueField
                    value={ssao.radius}
                    onChange={(v) => patchSsao({ radius: v })}
                    min={1}
                    max={2000}
                    step={5}
                    unit="px"
                    disabled={!ssao.enabled}
                    aria-label={t('composition.settings.ambientOcclusionRadius', 'Ambient occlusion radius')}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('composition.settings.intensity', 'Intensity')}</span>
                  <ValueField
                    value={ssao.intensity}
                    onChange={(v) => patchSsao({ intensity: v })}
                    min={0}
                    max={2}
                    step={0.05}
                    disabled={!ssao.enabled}
                    aria-label={t('composition.settings.ambientOcclusionIntensity', 'Ambient occlusion intensity')}
                  />
                </div>
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('composition.settings.quality', 'Quality')}</span>
                <select
                  className={styles.selectInput}
                  value={ssao.quality}
                  disabled={!ssao.enabled}
                  onChange={(e) => patchSsao({ quality: e.target.value === 'full' ? 'full' : 'half' })}
                  aria-label={t('composition.settings.ambientOcclusionQuality', 'Ambient occlusion quality')}
                >
                  <option value="half">{t('composition.settings.halfResolutionFasterPreview', 'Half resolution (faster preview)')}</option>
                  <option value="full">{t('composition.settings.fullResolutionCrispContactEdges', 'Full resolution (crisp contact edges)')}</option>
                </select>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.depthOfField', 'Depth of Field')}</div>
              <p className={styles.hint}>
                {t('composition.settings.howManySamplesTheCamera', "How many samples the camera's depth of field gathers. Draft is for working; High for the final look.")}
              </p>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('composition.settings.quality', 'Quality')}</span>
                <select
                  className={styles.selectInput}
                  value={renderer.dofQuality}
                  onChange={(e) => patchRenderer({ dofQuality: e.target.value === 'draft' || e.target.value === 'high' ? e.target.value : 'medium' })}
                  aria-label={t('composition.settings.depthOfFieldQuality', 'Depth of field quality')}
                >
                  <option value="draft">{t('composition.settings.draftFastest', 'Draft (fastest)')}</option>
                  <option value="medium">{t('composition.settings.medium', 'Medium')}</option>
                  <option value="high">{t('composition.settings.highSmoothestBokeh', 'High (smoothest bokeh)')}</option>
                </select>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.antiAliasing', 'Anti-aliasing')}</div>
              <p className={styles.hint}>
                {t('composition.settings.multisamplingOnThe3dRuns', 'Multisampling on the 3D runs smooths layer edges in depth. Off is fastest on heavy scenes.')}
              </p>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>MSAA</span>
                <select
                  className={styles.selectInput}
                  value={renderer.msaa}
                  onChange={(e) => patchRenderer({ msaa: Number(e.target.value) === 1 ? 1 : 4 })}
                  aria-label={t('composition.settings.multisampleAntiAliasing', 'Multisample anti-aliasing')}
                >
                  <option value={1}>{t('composition.settings.off', 'Off')}</option>
                  <option value={4}>4× MSAA</option>
                </select>
              </div>
            </div>
          </>
        )}

        {/* TAB 6: TIME */}
        {activeTab === 'time' && <ResponsiveTimeSection />}

        {/* TAB 7: COLOR */}
        {activeTab === 'color' && (
          <>
            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.projectWorkingSpace', 'Project colour management')}</div>
              <p className={styles.hint}>
                {t('composition.settings.projectWorkingSpaceHint', 'Footage is converted from its own profile (Interpret Footage ▸ Color) into this space, blended there, and shown through the display transform. None draws pixels as they are.')}
              </p>
              <select
                className={styles.selectInput}
                value={projectWorkingSpace}
                aria-label={t('composition.settings.projectWorkingSpace', 'Project colour management')}
                onChange={(e) => setProjectWorkingSpace(e.target.value as ColorWorkingSpace)}
              >
                <option value="none">{t('composition.settings.wsNone', 'None (unmanaged)')}</option>
                <option value="srgb">sRGB IEC61966-2.1</option>
                <option value="rec709">Rec. 709</option>
                <option value="rec2020">Rec. 2020</option>
                <option value="displayP3">Display P3</option>
                <option value="srgbLinear">{t('composition.settings.wsSrgbLinear', 'sRGB (linear blending)')}</option>
                <option value="acescg">ACEScg</option>
                <option value="acescct">ACEScct</option>
              </select>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.blendColors', 'Blend colors')}</div>
              <p className={styles.hint}>
                {t('composition.settings.blendColorsHint', 'Gamma mixes opacity, soft edges and blend modes in display values, as After Effects does by default. Linear (Blend Colors Using 1.0 Gamma) mixes light; projects made before this setting keep it.')}
              </p>
              <div className={styles.row}>
                <Button variant={!linearBlending ? 'primary' : 'secondary'} size="sm" onClick={() => setLinearBlending(false)}>
                  {t('composition.settings.blendGamma', 'Gamma')}
                </Button>
                <Button variant={linearBlending ? 'primary' : 'secondary'} size="sm" onClick={() => setLinearBlending(true)}>
                  {t('composition.settings.blendLinear', 'Linear (1.0 gamma)')}
                </Button>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.workingSpace', 'Working Space')}</div>
              <p className={styles.hint}>{t('composition.settings.internalColorPipelineSpaceWhere', 'Internal color pipeline space where math runs.')}</p>
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
              <div className={styles.label}>{t('composition.settings.displayTransform', 'Display Transform')}</div>
              <p className={styles.hint}>{t('composition.settings.outputMappingToTheViewport', 'Output mapping to the viewport monitor canvas.')}</p>
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
                  {t('composition.settings.pqPreview', 'PQ (preview)')}
                </Button>
                <Button
                  variant={cm.displayTransform === 'hlg' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setDisplayTransform('hlg')}
                >
                  {t('composition.settings.hlgPreview', 'HLG (preview)')}
                </Button>
              </div>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.viewerLut', 'Viewer LUT')}</div>
              <p className={styles.hint}>
                {t('composition.settings.optionalMonitor3dLutCube', 'Optional monitor 3D LUT (.cube). Session-only, never baked into export.')}
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
                  {t('composition.settings.loadCube', 'Load .cube…')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!viewerLutName}
                  onClick={() => clearViewerLut()}
                >
                  {t('composition.settings.clearLut', 'Clear LUT')}
                </Button>
              </div>
              {viewerLutName && (
                <span className={styles.metaBadge} title={viewerLutName}>
                  {t('composition.settings.lutActive', 'Active: {name}', { name: viewerLutName })}
                </span>
              )}
            </div>

            <div className={styles.section}>
              <div className={styles.label}>{t('composition.settings.intermediateBitDepth', 'Intermediate Bit Depth')}</div>
              <p className={styles.hint}>{t('composition.settings.floatPrecisionForSceneColor', 'Float precision for scene-color and render targets.')}</p>
              <div className={styles.row}>
                <Button
                  variant={cm.bitDepth === 16 ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setBitDepth(16 as IntermediateBitDepth)}
                >
                  {t('composition.settings.bitDepth16', '16-bit float')}
                </Button>
                <Button
                  variant={cm.bitDepth === 32 ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setBitDepth(32 as IntermediateBitDepth)}
                >
                  {t('composition.settings.bitDepth32', '32-bit float')}
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
            {t('composition.settings.cancel', 'Cancel')}
          </Button>
        }
        primary={
          <Button
            variant="primary"
            size="md"
            leftIcon={<Icon name="check" size="md" />}
            onClick={handleSave}
          >
            {t('composition.settings.saveChanges', 'Save Changes')}
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
  const description = t('composition.settings.description', '{name} · {w} × {h} · {fps} fps', { name: comp?.name || t('composition.settings.defaultName', 'Composition'), w: comp?.width ?? 1920, h: comp?.height ?? 1080, fps: settingsFps(comp) });

  openModal({
    id: 'composition-settings',
    title: t('composition.settings.title', 'Composition Settings'),
    description,
    size: 'lg',
    className: styles.dialogWindow,
    render: (close) => <CompositionSettings close={close} />,
  });
}


