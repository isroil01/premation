/**
 * CompositionSettingsDialog (Prompt E1) — edit the composition's name, size,
 * frame rate, duration and BACKGROUND (the background was previously hardcoded
 * to a near-black constant). Also exposes the pasteboard (canvas surround)
 * colour under an "Environment" section.
 *
 * Writes flow to the compositionStore (render pipeline reads it live) and, for
 * fps/duration, into the TimelineController so the time domain stays consistent.
 */

import { Icon } from '@components/Icon';
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
import { useGuidesStore } from '@stores/guidesStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { FPS_PRESETS, MAX_DURATION } from '@core/composition/presets';
import styles from './CompositionSettingsDialog.module.css';

function CompositionSettings({ close }: { close: () => void }): JSX.Element {
  const s = useCompositionStore();

  // Grid overlay is view/session state (guidesStore), surfaced here so its
  // divisions + line colour are discoverable alongside the comp's own look.
  const gridOn = useGuidesStore((g) => g.grid);
  const gridDivisions = useGuidesStore((g) => g.gridDivisions);
  const gridColor = useGuidesStore((g) => g.gridColor);
  const toggleGrid = useGuidesStore((g) => g.toggleGrid);
  const setGridDivisions = useGuidesStore((g) => g.setGridDivisions);
  const setGridColor = useGuidesStore((g) => g.setGridColor);

  // Size is fixed at creation and displayed in the viewport top bar — no need to
  // repeat it here. This dialog edits only the mutable settings (name, fps,
  // duration, background, grid).

  const setName = (name: string): void => s.update({ name });
  const setFps = (fps: number): void => {
    s.update({ fps });
    getTimelineController().setFrameRate(useCompositionStore.getState().fps);
  };
  const setDuration = (durationSeconds: number): void => {
    s.update({ durationSeconds });
    getTimelineController().setDurationSeconds(useCompositionStore.getState().durationSeconds);
  };
  // Display-only: no TimelineController call, because the time domain is
  // unchanged — this only shifts what timecode frame 0 is labelled.
  const setStartFrame = (startFrame: number): void => s.update({ startFrame });

  // ── Background paint (solid / linear / radial) ──────────────────────
  // A solid is stored as the flat `background` colour (backgroundPaint cleared),
  // so the common case stays back-compatible; gradients ride on backgroundPaint.
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
      {/* Name */}
      <div className={styles.section}>
        <div className={styles.label}>Name</div>
        <Input value={s.name} onChange={(e) => setName(e.target.value)} aria-label="Composition name" />
      </div>


      {/* Frame rate + duration */}
      <div className={styles.section}>
        <div className={styles.label}>Frame rate & duration</div>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Frame rate</span>
            <ValueField value={s.fps} onChange={setFps} min={1} max={240} step={1} unit="fps" aria-label="Frame rate" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Duration</span>
            <ValueField value={s.durationSeconds} onChange={setDuration} min={0.1} max={MAX_DURATION} step={0.5} unit="s" aria-label="Duration" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel} title="The timecode frame 0 is labelled with (display only — timing is unchanged)">
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
        <div className={styles.hint} style={{ opacity: 0.6, fontSize: 11 }}>
          {`Timecode starts at ${framesToTimecode(0, s.fps, s.startFrame)} · display only`}
        </div>
        <div className={styles.chips}>
          {FPS_PRESETS.map((f) => (
            <button
              key={f.value}
              type="button"
              title={f.label}
              className={f.value === s.fps ? styles.chipOn : styles.chip}
              onClick={() => setFps(f.value)}
            >
              {f.value}
            </button>
          ))}
        </div>
      </div>

      {/* Scene background — the video screen's own background (customizable). */}
      <div className={styles.section}>
        <div className={styles.label}>Scene Background</div>
        <p className={styles.hint} style={{ marginTop: 0, marginBottom: 8 }}>
          The composition's own background — this is what appears on the video screen and in exports.
        </p>
        <div className={styles.bgRow}>
          {/* Style selector — solid colour, or a linear / radial gradient. */}
          <div className={styles.chips} style={{ margin: 0 }}>
            {(['solid', 'linear', 'radial'] as FillType[]).map((t) => (
              <button
                key={t}
                type="button"
                title={`${t[0]!.toUpperCase()}${t.slice(1)} background`}
                className={bgPaint.type === t ? styles.chipOn : styles.chip}
                disabled={s.transparent}
                onClick={() => setBgType(t)}
              >
                {t === 'solid' ? 'Solid' : t === 'linear' ? 'Linear' : 'Radial'}
              </button>
            ))}
          </div>
          <Switch
            checked={s.transparent}
            onChange={(e) => s.setTransparent(e.target.checked)}
            label="Transparent"
          />
        </div>

        {!s.transparent && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {bgPaint.type === 'solid' && (
              <ColorPicker
                value={s.background}
                onChange={(hex) => s.setBackgroundPaint(solidFill(hex))}
                className={styles.colorTrigger}
                aria-label="Background color"
              />
            )}

            {bgPaint.type === 'linear' && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Angle</span>
                <ValueField
                  value={bgPaint.angle}
                  onChange={(angle) => s.setBackgroundPaint({ ...bgPaint, angle })}
                  min={0}
                  max={360}
                  step={1}
                  unit="°"
                  aria-label="Gradient angle"
                />
              </label>
            )}

            {bgPaint.type === 'radial' && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Radius</span>
                <ValueField
                  value={Math.round(bgPaint.radius * 100)}
                  onChange={(v) => s.setBackgroundPaint({ ...bgPaint, radius: v / 100 })}
                  min={1}
                  max={200}
                  step={1}
                  unit="%"
                  aria-label="Gradient radius"
                />
              </label>
            )}

            {bgPaint.type !== 'solid' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className={styles.fieldLabel}>Gradient stops</span>
                {sortedStops(bgPaint.stops).map((stop) => (
                  <div key={stop.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="plus" size={12} />}
                  onClick={addStop}
                >
                  Add stop
                </Button>
              </div>
            )}
          </div>
        )}

        {s.transparent ? (
          <p className={styles.hint}>The comp has no background — exports keep an alpha channel.</p>
        ) : null}
      </div>

      {/* Grid overlay */}
      <div className={styles.section}>
        <div className={styles.label}>Grid</div>
        <div className={styles.bgRow}>
          <Switch checked={gridOn} onChange={() => toggleGrid()} label="Show grid" />
        </div>
        {gridOn && (
          <div className={styles.row} style={{ marginTop: 8 }}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Divisions</span>
              <ValueField
                value={gridDivisions}
                onChange={setGridDivisions}
                min={2}
                max={64}
                step={1}
                aria-label="Grid divisions"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Line color</span>
              <ColorPicker
                value={gridColor}
                onChange={setGridColor}
                className={styles.colorTrigger}
                aria-label="Grid line color"
              />
            </label>
          </div>
        )}
        <p className={styles.hint}>Overlay only — the grid never renders into exports.</p>
      </div>

      <div className={styles.footer}>
        <Button variant="primary" size="md" leftIcon={<Icon name="check" size={14} />} onClick={close}>
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
    size: 'sm',
    render: (close) => <CompositionSettings close={close} />,
  });
}
