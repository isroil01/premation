/**
 * CompositionSettingsDialog (Prompt E1) — edit the composition's name, size,
 * frame rate, duration and BACKGROUND (the background was previously hardcoded
 * to a near-black constant). Also exposes the pasteboard (canvas surround)
 * colour under an "Environment" section.
 *
 * Writes flow to the compositionStore (render pipeline reads it live) and, for
 * fps/duration, into the TimelineController so the time domain stays consistent.
 */

import { useState } from 'react';
import { Icon } from '@components/Icon';
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
import { useCompositionStore } from '@stores/compositionStore';
import { resolveSsao, type SsaoSettings } from '@stores/projectStore';
import { useGuidesStore, type GridStyle } from '@stores/guidesStore';
import { useColorManagementStore, type IntermediateBitDepth } from '@stores/colorManagementStore';
import { useViewerLutStore } from '@stores/viewerLutStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { FPS_PRESETS, MAX_DURATION } from '@core/composition/presets';
import {
  ENVIRONMENT_PRESETS,
  DEFAULT_ENVIRONMENT_PRESET,
  isEnvironmentPresetId,
  type EnvironmentPresetId,
} from '@core/scene/environmentLight';
import styles from './CompositionSettingsDialog.module.css';

type TabId = 'general' | 'background' | 'grid' | 'world' | 'time' | 'color';

function CompositionSettings({ close }: { close: () => void }): JSX.Element {
  const s = useCompositionStore();
  const [activeTab, setActiveTab] = useState<TabId>('general');

  // Grid overlay is view/session state (guidesStore), surfaced here so its
  // divisions + line colour are discoverable alongside the comp's own look.
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

  const setName = (name: string): void => s.update({ name });
  const setFps = (fps: number): void => {
    s.update({ fps });
    getTimelineController().setFrameRate(useCompositionStore.getState().fps);
  };
  const setDuration = (durationSeconds: number): void => {
    s.update({ durationSeconds });
    getTimelineController().setDurationSeconds(useCompositionStore.getState().durationSeconds);
  };
  const setStartFrame = (startFrame: number): void => s.update({ startFrame });

  // ── World ──────────────────────────────────────────────────────────
  //
  // All three are absent on every document written before this tab existed, and
  // every read here supplies the value that reproduces the old behaviour
  // exactly — so opening this dialog on an old project and closing it again
  // changes nothing on disk.
  const defaultEnvPreset: EnvironmentPresetId = isEnvironmentPresetId(s.defaultEnvPreset)
    ? s.defaultEnvPreset
    : DEFAULT_ENVIRONMENT_PRESET;
  const setDefaultEnvPreset = (v: string): void => {
    if (isEnvironmentPresetId(v)) s.update({ defaultEnvPreset: v });
  };
  const groundLevel = Number.isFinite(s.groundLevel) ? (s.groundLevel as number) : 0;
  const setGroundLevel = (v: number): void => s.update({ groundLevel: v });
  const showSkyBackdrop = s.showSkyBackdrop === true;
  /*
    Ambient occlusion.

    Read through `resolveSsao` so an absent block (every document written before
    this group existed) reads as the defaults and NOTHING is written until the
    user actually changes something. `patchSsao` then writes the whole object,
    because the store's sanitizer validates it as a whole — see the note there
    on why a NaN radius is not a cosmetic problem.
  */
  const ssao = resolveSsao(s.comp());
  const patchSsao = (patch: Partial<SsaoSettings>): void => s.update({ ssao: { ...ssao, ...patch } });

  // ── Background paint (solid / linear / radial) ──────────────────────
  const bgPaint: FillPaint = s.backgroundPaint ?? solidFill(s.background);
  const setBgType = (type: FillType): void => s.setBackgroundPaint(convertFill(bgPaint, type));
  const writeStops = (stops: ColorStop[]): void => {
    if (bgPaint.type === 'solid') return;
    s.setBackgroundPaint({ ...bgPaint, stops });
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

  return (
    <div className={styles.root}>
      {/* Top Navigation Tabs */}
      <div className={styles.navTabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'general'}
          className={`${styles.navTab} ${activeTab === 'general' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('general')}
        >
          <Icon name="sliders-h" size="sm" />
          General
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'background'}
          className={`${styles.navTab} ${activeTab === 'background' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('background')}
        >
          <Icon name="brush" size="sm" />
          Background
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'grid'}
          className={`${styles.navTab} ${activeTab === 'grid' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('grid')}
        >
          <Icon name="grid" size="sm" />
          Grid & Guides
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'world'}
          className={`${styles.navTab} ${activeTab === 'world' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('world')}
        >
          <Icon name="axis-world" size="sm" />
          World
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'time'}
          className={`${styles.navTab} ${activeTab === 'time' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('time')}
        >
          <Icon name="keyframe" size="sm" />
          Time
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'color'}
          className={`${styles.navTab} ${activeTab === 'color' ? styles.navTabActive : ''}`}
          onClick={() => setActiveTab('color')}
        >
          <Icon name="palette" size="sm" />
          Color
        </button>
      </div>

      <div className={styles.tabBody}>
        {/* TAB 1: GENERAL */}
        {activeTab === 'general' && (
          <>
            <div className={styles.section}>
              <div className={styles.label}>Composition Name</div>
              <Input value={s.name} onChange={(e) => setName(e.target.value)} aria-label="Composition name" />
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Time & Frame Rate</div>
              <div className={styles.rowThree}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Frame rate</span>
                  <ValueField value={s.fps} onChange={setFps} min={1} max={240} step={1} unit="fps" aria-label="Frame rate" />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Duration</span>
                  <ValueField value={s.durationSeconds} onChange={setDuration} min={0.1} max={MAX_DURATION} step={0.5} unit="s" aria-label="Duration" />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel} title="The timecode frame 0 is labelled with (display only)">
                    Start timecode
                  </span>
                  <ValueField
                    value={s.startFrame}
                    onChange={setStartFrame}
                    min={0}
                    step={1}
                    unit="f"
                    aria-label="Start timecode (frames)"
                  />
                </label>
              </div>

              <div className={styles.hint} style={{ opacity: 0.6, marginTop: 4 }}>
                {`Timecode starts at ${framesToTimecode(0, s.fps, s.startFrame)} · display only`}
              </div>

              <div className={styles.field} style={{ marginTop: 6 }}>
                <span className={styles.fieldLabel}>Frame Rate Presets</span>
                <div className={styles.chips}>
                  {FPS_PRESETS.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      title={f.label}
                      className={`${styles.chip} ${f.value === s.fps ? styles.chipOn : ''}`}
                      onClick={() => setFps(f.value)}
                    >
                      {f.value} fps
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {/* TAB 2: BACKGROUND */}
        {activeTab === 'background' && (
          <div className={styles.section}>
            <div className={styles.label}>Scene Canvas Background</div>
            <p className={styles.hint}>
              The composition's background — rendered on canvas and captured in video exports.
            </p>

            <div className={styles.bgRow} style={{ marginTop: 4 }}>
              {/* Fill Mode Segmented Control */}
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
            <div className={styles.colorCardRow} style={{ marginTop: 6 }}>
              <span className={styles.colorCardLabel}>Canvas Transparency (Alpha)</span>
              <Switch
                checked={s.transparent}
                onChange={(e) => s.setTransparent(e.target.checked)}
              />
            </div>

            {!s.transparent && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                {bgPaint.type === 'solid' && (
                  <div className={styles.colorCardRow}>
                    <span className={styles.colorCardLabel}>Solid Fill Color</span>
                    <ColorPicker
                      value={s.background}
                      onChange={(hex) => s.setBackgroundPaint(solidFill(hex))}
                      aria-label="Background color"
                    />
                  </div>
                )}

                {bgPaint.type === 'linear' && (
                  <div className={styles.colorCardRow}>
                    <span className={styles.colorCardLabel}>Gradient Angle</span>
                    <ValueField
                      value={bgPaint.angle}
                      onChange={(angle) => s.setBackgroundPaint({ ...bgPaint, angle })}
                      min={0}
                      max={360}
                      step={1}
                      unit="°"
                      aria-label="Gradient angle"
                    />
                  </div>
                )}

                {bgPaint.type === 'radial' && (
                  <div className={styles.colorCardRow}>
                    <span className={styles.colorCardLabel}>Gradient Radius</span>
                    <ValueField
                      value={Math.round(bgPaint.radius * 100)}
                      onChange={(v) => s.setBackgroundPaint({ ...bgPaint, radius: v / 100 })}
                      min={1}
                      max={200}
                      step={1}
                      unit="%"
                      aria-label="Gradient radius"
                    />
                  </div>
                )}

                {bgPaint.type !== 'solid' && (
                  <div className={styles.stopsContainer}>
                    <span className={styles.colorCardLabel} style={{ fontSize: 'var(--font-size-micro)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Gradient Stops</span>
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
                          style={{ height: 24, width: 24, padding: 0, display: 'grid', placeItems: 'center' }}
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

            {/*
              Per-format, because the previous copy said "exported frames and
              video keep alpha channel" unconditionally — true for MOV/WebM/PNG
              and false for MP4/GIF/JPG. Somebody following it shipped a
              deliverable with a black background and no warning.

              "not currently preserved" rather than "not possible" for GIF on
              purpose: GIF does carry 1-bit transparency, the encoder's
              palettegen/paletteuse graph simply does not request it. The wording
              should not close off a feature the format allows.
            */}
            {s.transparent && (
              <div className={styles.hint} style={{ marginTop: 6 }}>
                <div style={{ color: '#38bdf8' }}>
                  ✓ Keeps alpha: <strong>MOV</strong> (ProRes 4444),{' '}
                  <strong>WebM</strong> (VP9), <strong>PNG</strong> and PNG sequence.
                </div>
                <div style={{ marginTop: 2 }}>
                  Composited over <strong>black</strong>: MP4, GIF and JPG sequence —
                  these formats carry no alpha channel (GIF&nbsp;transparency is
                  not currently preserved).
                </div>
                <div style={{ marginTop: 2 }}>
                  Lottie&nbsp;/&nbsp;JSON carry no composition background at all;
                  they take whatever is behind them where they are played.
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
                <label className={styles.field}>
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
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Subdivisions</span>
                  <ValueField
                    value={gridSubdivisions}
                    onChange={setGridSubdivisions}
                    min={1}
                    max={64}
                    step={1}
                    aria-label="Grid subdivisions"
                  />
                </label>
              </div>

              <div className={styles.row} style={{ marginTop: 4 }}>
                <label className={styles.field}>
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
                </label>
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
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Columns</span>
                  <ValueField
                    value={proportionalColumns}
                    onChange={setProportionalColumns}
                    min={1}
                    max={64}
                    step={1}
                    aria-label="Proportional grid columns"
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Rows</span>
                  <ValueField
                    value={proportionalRows}
                    onChange={setProportionalRows}
                    min={1}
                    max={64}
                    step={1}
                    aria-label="Proportional grid rows"
                  />
                </label>
              </div>
            </div>
          </>
        )}

        {/* TAB 4: WORLD — the comp's 3D environment (per-composition, saved) */}
        {activeTab === 'world' && (
          <>
            <div className={styles.section}>
              <div className={styles.label}>Default sky</div>
              <p className={styles.hint}>
                The sky a NEW environment light starts on. Existing lights keep
                whatever they were set to — this only decides where the next one
                begins, so a project working in one look does not re-pick it
                every time. Each light can still be pointed at its own image.
              </p>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Sky</span>
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
              </label>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Ground level</div>
              <p className={styles.hint}>
                Where the 3D reference floor sits, measured DOWN from the
                composition's bottom edge. 0 is the plane the ground grid has
                always drawn. Reference geometry only — it moves the grid you
                block out against, never a rendered pixel.
              </p>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Offset from comp bottom</span>
                <ValueField
                  value={groundLevel}
                  onChange={setGroundLevel}
                  step={10}
                  unit="px"
                  aria-label="Ground level"
                />
              </label>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Ambient occlusion</div>
              <p className={styles.hint}>
                Contact darkening between 3D surfaces that are close together —
                the dark seam where a box meets the floor. It dims AMBIENT light
                only: a lamp already has a shadow to say what it cannot see, and
                darkening it twice is how AO turns into grime. Off by default,
                and a composition that leaves it off renders exactly as it did
                before this existed.
              </p>
              <div className={styles.colorCardRow}>
                <span className={styles.colorCardLabel}>Enable</span>
                <Switch
                  checked={ssao.enabled}
                  onChange={(e) => patchSsao({ enabled: e.target.checked })}
                  aria-label="Enable ambient occlusion"
                />
              </div>
              <label className={styles.field}>
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
              </label>
              <p className={styles.hint}>
                How far a surface looks for something occluding it, in
                COMPOSITION px — a fixed size in the scene, not on screen, so
                zooming the viewport does not change how deep a crevice reads.
              </p>
              <label className={styles.field}>
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
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Quality</span>
                <select
                  className={styles.selectInput}
                  value={ssao.quality}
                  disabled={!ssao.enabled}
                  onChange={(e) => patchSsao({ quality: e.target.value === 'full' ? 'full' : 'half' })}
                  aria-label="Ambient occlusion quality"
                >
                  <option value="half">Half resolution (faster)</option>
                  <option value="full">Full resolution</option>
                </select>
              </label>
              <p className={styles.hint}>
                Half is the right default: AO is a low-frequency term and the
                shader magnifies it smoothly on the way back, so the buffer
                costs a quarter of the pixels for very nearly the same picture.
                Full is for a still where the contact edge is the subject.
              </p>
            </div>

            <div className={styles.section}>
              <div className={styles.label}>Backdrop</div>
              {/*
                Stored, not implemented — and said so plainly rather than
                shipped as a switch that appears to work.

                The environment probe is a low-frequency IRRADIANCE field (nine
                SH coefficients), which is enough to light a surface from every
                side and nowhere near enough to draw as scenery. Rendering the
                sky behind the scene needs the full image on a background quad,
                which is a renderer change this setting does not make. The
                control exists so the intent has somewhere to live and a
                document can carry it; the tooltip is the honest part.
              */}
              <div
                className={styles.colorCardRow}
                title="backdrop rendering is not yet available"
              >
                <span className={styles.colorCardLabel}>Show sky as backdrop</span>
                <Switch
                  checked={showSkyBackdrop}
                  disabled
                  onChange={(e) => s.update({ showSkyBackdrop: e.target.checked })}
                  aria-label="Show sky as backdrop"
                  title="backdrop rendering is not yet available"
                />
              </div>
              <p className={styles.hint} style={{ marginTop: 4 }}>
                Saved with the composition, but nothing draws it yet: the
                environment light is an irradiance probe, not a reflection or
                background map.
              </p>
            </div>
          </>
        )}

        {/* TAB 5: TIME — responsive/protected regions (M7) */}
        {activeTab === 'time' && <ResponsiveTimeSection />}

        {/* TAB 6: COLOR — project working space / display / bit depth */}
        {activeTab === 'color' && (
          <>
            <div className={styles.section}>
              <div className={styles.label}>Working space</div>
              <p className={styles.hint}>Where grade, blend, and blur maths run.</p>
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
              <div className={styles.label}>Display transform</div>
              <p className={styles.hint}>Output mapping to the preview canvas.</p>
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
              <p className={styles.hint}>
                Display transform maps the working buffer to the viewport only.
                Export ▸ HDR10 / HLG bakes its own PQ / HLG once (preview ODT is
                neutralized during that encode so the signal is not double-encoded).
                EXR sequence keeps float planes.
              </p>
            </div>
            <div className={styles.section}>
              <div className={styles.label}>Viewer LUT</div>
              <p className={styles.hint}>
                Optional monitor look (.cube) after the display transform.
                Session-only — not saved with the project and never baked into export.
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
                          // Malformed .cube — leave previous LUT (if any) in place.
                          console.warn('[Viewer LUT] could not parse', file.name);
                        }
                      });
                    };
                    input.click();
                  }}
                >
                  Load…
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!viewerLutName}
                  onClick={() => clearViewerLut()}
                >
                  Clear
                </Button>
                {viewerLutName ? (
                  <span className={styles.hint} title={viewerLutName}>{viewerLutName}</span>
                ) : null}
              </div>
            </div>
            <div className={styles.section}>
              <div className={styles.label}>Intermediate bit depth</div>
              <p className={styles.hint}>Float precision for scene-color and effect RTs.</p>
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

      <div className={styles.footer}>
        <Button variant="secondary" size="md" onClick={close} style={{ minWidth: 90 }}>
          Cancel
        </Button>
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size="md" />} onClick={close} style={{ minWidth: 90 }}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** Open the Composition Settings dialog as a modal. */
export function openCompositionSettings(): void {
  openModal({
    id: 'composition-settings',
    title: 'Composition settings',
    size: 'md',
    render: (close) => <CompositionSettings close={close} />,
  });
}

