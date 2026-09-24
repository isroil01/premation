/**
 * RetimeSection — Speed for footage, audio-bearing video and compositions.
 *
 * One control decides how the layer's source is timed, the way Twixtor and AE's
 * Timewarp both split it:
 *
 *   Normal · Speed % · Frames
 *
 *   - SPEED %  — a keyframeable rate with its own curve, ramp style per point,
 *     one-click velocity presets, and a footage budget that says when a
 *     speed-up runs out of frames (and fixes it).
 *   - FRAMES   — which source frame shows when. Time Remap, finally in frames
 *     instead of seconds to two decimals, which could not name a frame.
 *
 * Smooth motion (frame blending) sits here too: slow motion without it is held
 * frames, so it belongs next to the speed that needs it, not three panels away.
 *
 * Switching modes converts rather than discarding (see `retimeCommands`).
 *
 * Every edit goes through the engine API (B3z, `retimeEdits`): `setRetime`
 * for the mode, keyframe commands on `layer/timeSpeed` / `timeRemap` for the
 * rest; a field scrub or a graph drag is ONE gesture.
 */

import { useMemo, useState } from 'react';
import { flicksToSeconds, type FrameBlend as ApiFrameBlend, type Keyframe } from '@motion/engine-api';
import type { EasingKind } from '@motion/animation';
import { Segmented } from '@components/Segmented';
import { ValueField } from '@components/ValueField';
import { useProjectStore } from '@stores/projectStore';
import { useThrottledTime } from '@stores/playbackClockStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { compFps, useActiveMirrorComp, useMirrorComp, useMirrorItem, useMirrorKeyframes, useMirrorLayer } from '@hooks/useMirror';
import type { FrameBlend } from '@core/scene/layerTime';
import { edit } from '@core/engine/uiEdits';
import { REMAP_PROP, SPEED_PROP, type RetimeMode } from '@core/animation/retime';
import { SPEED_PRESETS, rampStyleOf, type RampStyle, type RetimeBarInfo } from '@core/animation/retimeCommands';
import {
  REMAP_PATH,
  SPEED_PATH,
  mirrorRetimeBar,
  mirrorRetimeSummary,
  mirrorRetimedSourceSeconds,
  mirrorRetimedSpeedAt,
  mirrorSourceFrameAt,
  mirrorSpeedPercentAt,
  type RetimeMirrorRead,
} from '@core/mirror/retime';
import { numbersOfValue } from '@core/mirror/trackIndex';
import { AnimToggle } from './AnimToggle';
import { useEngineEdit } from './useEngineEdit';
import {
  addRetimeKeyCommands,
  constantSpeedCommands,
  fitToFootageCommands,
  moveRetimeKeyCommands,
  rampStyleCommands,
  setSourceFrameCommands,
  setSpeedCommands,
  speedPresetCommands,
} from './retimeEdits';
import { RetimeGraph, type RetimeGraphKey } from './RetimeGraph';
import { setLayersSwitch } from './inspectorEdits';
import ts from './TransformSection.module.css';
import styles from './RetimeSection.module.css';

const MODE_OPTIONS = [
  { value: 'normal' as const, label: 'Normal' },
  { value: 'speed' as const, label: 'Speed %' },
  { value: 'frames' as const, label: 'Frames' },
];

const RAMP_OPTIONS = [
  { value: 'smooth' as const, label: 'Smooth' },
  { value: 'linear' as const, label: 'Linear' },
  { value: 'instant' as const, label: 'Instant' },
];

const BLEND_OPTIONS = [
  { value: 'none' as const, label: 'Off' },
  { value: 'mix' as const, label: 'Blend' },
  { value: 'pixelMotion' as const, label: 'Optical flow' },
];

function notify(message: string, level: 'info' | 'success' | 'warning' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 4500 });
}

function formatSec(s: number): string {
  return `${s.toFixed(2)}s`;
}

/** The API's frame-blend switch as the section's options name it. */
const BLEND_OF: Record<ApiFrameBlend, FrameBlend> = { off: 'none', frameMix: 'mix', pixelMotion: 'pixelMotion' };

const NO_KEYS: readonly Keyframe[] = [];

/** A retime key's number (percent, or chain seconds). */
const keyNumber = (v: Parameters<typeof numbersOfValue>[0], fallback: number): number => numbersOfValue(v)[0] ?? fallback;

export function RetimeSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // Display time: exact while paused, throttled while playing (no render per played frame).
  const time = useThrottledTime();
  const activeComp = useActiveMirrorComp();
  // The rate as the settings dialog states it (NTSC 30000/1001 → 29.97).
  const fps = Number(compFps(activeComp).toFixed(3)) || 30;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // What the bar and the curves are built from — re-render when any changes.
  const layer = useMirrorLayer(nodeId);
  const ownerComp = useMirrorComp(layer?.comp);
  const sourceItem = useMirrorItem(layer?.source);
  const speedKeys = useMirrorKeyframes(nodeId, SPEED_PATH);
  const remapKeys = useMirrorKeyframes(nodeId, REMAP_PATH);
  // The mirror records above as a reader, so the bar and the footage budget
  // recompute exactly when one of them changes (identity = change test).
  const records = useMemo<RetimeMirrorRead>(() => ({
    layer: (id) => (id === nodeId ? layer : undefined),
    keyframes: (id, path) => (id !== nodeId ? NO_KEYS : path === SPEED_PATH ? speedKeys : path === REMAP_PATH ? remapKeys : NO_KEYS),
    comp: (id) => (id === ownerComp?.id ? ownerComp : undefined),
    item: (id) => (id === sourceItem?.id ? sourceItem : undefined),
  }), [nodeId, layer, speedKeys, remapKeys, ownerComp, sourceItem]);
  const bar = useMemo(() => mirrorRetimeBar(records, nodeId), [records, nodeId]);

  const mode: RetimeMode = layer?.timing.retime ?? 'normal';
  const blend = BLEND_OF[layer?.switches.frameBlend ?? 'off'];
  const inSec = bar?.inSec ?? 0;
  const activeDuration = activeComp ? flicksToSeconds(activeComp.settings.duration) : 0;
  const outSec = bar?.outSec ?? Math.max(inSec + 1, activeDuration || 1);

  const seek = (t: number): void => useProjectStore.getState().actions.setTime(t, Math.round(t * fps));

  const changeMode = (next: RetimeMode): void => {
    setSelectedId(null);
    if (next === mode) return;
    // Frames → Speed can only guarantee the frames at the old remap keys
    // (retimeCommands `bakeRemapToSpeed`): the only approximate conversion.
    const approximate = mode === 'frames' && next === 'speed';
    const label = next === 'normal' ? 'Normal Speed' : next === 'speed' ? 'Retime: Speed %' : 'Retime: Frame Number';
    void edit(label, { type: 'setRetime', layer: nodeId, mode: next }).then((r) => {
      if (r.ok && approximate) notify('Converted to Speed %. The frames at your old keys are kept; check the curve between them.');
    });
  };

  const speedNow = Math.round(mirrorRetimedSpeedAt(records, nodeId, time, bar) * 100);
  const summary = useMemo(
    () => (mode === 'normal' ? null : mirrorRetimeSummary(records, nodeId, bar)),
    [mode, records, nodeId, bar],
  );

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <h4 className={ts.title} style={{ margin: 0 }}>Speed</h4>
        {mode !== 'normal' && (
          <span className={styles.readout} data-slow={speedNow < 100 || undefined} title="Playback speed at the playhead">
            {speedNow}% here
          </span>
        )}
      </div>

      <Segmented
        size="sm"
        fullWidth
        aria-label="How this layer's source is timed"
        options={MODE_OPTIONS}
        value={mode}
        onChange={changeMode}
      />

      {mode === 'normal' && (
        <p className={styles.hint}>
          Plays as shot. <strong>Speed %</strong> for ramps and velocity edits;{' '}
          <strong>Frames</strong> to choose exactly which source frame shows when.
        </p>
      )}

      {mode === 'speed' && (
        <SpeedControls
          nodeId={nodeId}
          bar={bar}
          time={time}
          fps={fps}
          inSec={inSec}
          outSec={outSec}
          runsOutAtSec={summary?.runsOutAtSec ?? null}
          selectedId={selectedId}
          onSelect={setSelectedId}
          seek={seek}
        />
      )}

      {mode === 'frames' && (
        <FrameControls
          nodeId={nodeId}
          bar={bar}
          time={time}
          fps={fps}
          inSec={inSec}
          outSec={outSec}
          runsOutAtSec={summary?.runsOutAtSec ?? null}
          selectedId={selectedId}
          onSelect={setSelectedId}
          seek={seek}
        />
      )}

      {summary && (
        <div className={styles.summary}>
          <span>
            Plays {formatSec(Math.abs(summary.usedSec))} of footage in {formatSec(summary.outputSec)}
            {summary.availableSec !== null ? ` · ${formatSec(summary.availableSec)} available` : ''}
          </span>
          {summary.runsOutAtSec !== null && (
            <>
              <span className={styles.warning}>
                Footage runs out at {formatSec(summary.runsOutAtSec)} — the last frame holds.
              </span>
              {mode === 'speed' && (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => {
                    const cmds = fitToFootageCommands(nodeId);
                    if (!cmds) return;
                    void edit('Fit speed to footage', cmds).then((r) => {
                      if (r.ok) notify('Scaled the speed curve to end on the last frame.', 'success');
                    });
                  }}
                >
                  Fit to footage
                </button>
              )}
            </>
          )}
        </div>
      )}

      {mode !== 'normal' && (
        <div className={styles.row}>
          <span className={styles.label} title="Frame blending — slow motion without it repeats frames">Smooth motion</span>
          <Segmented
            className={styles.grow}
            size="sm"
            fullWidth
            aria-label="Smooth motion (frame blending)"
            options={BLEND_OPTIONS}
            value={blend}
            onChange={(v: FrameBlend) => { void setLayersSwitch([nodeId], { frameBlend: v === 'mix' ? 'frameMix' : v === 'pixelMotion' ? 'pixelMotion' : 'off' }, 'Frame Blending'); }}
          />
        </div>
      )}
    </div>
  );
}

interface ModeControlsProps {
  nodeId: string;
  /** The clip bar the curves are measured on (`mirrorRetimeBar`). */
  bar: RetimeBarInfo | null;
  time: number;
  fps: number;
  inSec: number;
  outSec: number;
  runsOutAtSec: number | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  seek: (t: number) => void;
}

function SpeedControls({ nodeId, bar, time, fps, inSec, outSec, runsOutAtSec, selectedId, onSelect, seek }: ModeControlsProps): JSX.Element {
  const speedEdit = useEngineEdit();
  // The speed keys (engine ids, comp flicks); the parent re-renders on `key:` for them.
  const tracks = useMirrorKeyframes(nodeId, SPEED_PATH);
  const m = documentMirror();
  const valueNow = mirrorSpeedPercentAt(m, nodeId, time, bar) ?? 100;
  const curve = tracks.length > 1;
  const offset = bar?.clip.offsetSec ?? 0;

  const keys: RetimeGraphKey[] = tracks.map((k) => {
    const compT = flicksToSeconds(k.time);
    return { id: k.id, t: compT + offset, compT, value: keyNumber(k.value, 100) };
  });
  // The point a Ramp style edits: the selected one, else the one the playhead is in.
  const focusKey = tracks.find((k) => k.id === selectedId)
    ?? [...tracks].reverse().find((k) => flicksToSeconds(k.time) <= time + 1e-9)
    ?? tracks[0];
  const ramp: RampStyle = rampStyleOf(focusKey?.easing as EasingKind | undefined);
  const focusId = focusKey?.id ?? null;

  return (
    <>
      <div className={styles.row}>
        <AnimToggle
          nodeId={nodeId}
          tracks={[SPEED_PROP]}
          label="Speed"
          animated={curve}
          values={() => [valueNow]}
          onToggle={() => {
            if (curve) {
              // Stopwatch off: back to one constant speed — the value showing now.
              void edit('Constant speed', constantSpeedCommands(nodeId, inSec, valueNow));
              onSelect(null);
            } else {
              void edit('Add speed point', addRetimeKeyCommands(nodeId, SPEED_PROP, time, valueNow));
            }
          }}
        />
        <span className={styles.label}>Speed</span>
        <div className={styles.field}>
          <ValueField
            value={Math.round(valueNow * 10) / 10}
            onChange={(v) => speedEdit.send('Set speed', setSpeedCommands(nodeId, time, v))}
            {...speedEdit.scrub('Set speed')}
            unit="%"
            precision={0}
            min={-1000}
            max={1000}
            aria-label="Playback speed"
          />
        </div>
      </div>

      <RetimeGraph
        kind="speed"
        inSec={inSec}
        outSec={outSec}
        fps={fps}
        time={time}
        keys={keys}
        sample={(t) => mirrorSpeedPercentAt(m, nodeId, t, bar) ?? 100}
        runsOutAtSec={runsOutAtSec}
        selectedId={selectedId}
        onSelect={onSelect}
        moveCommands={(id, compT, value) => moveRetimeKeyCommands(SPEED_PROP, id, compT, value)}
        dragLabel="Move speed point"
        onNudge={(id, compT, value) => {
          void edit('Nudge speed point', moveRetimeKeyCommands(SPEED_PROP, id, compT, value));
          onSelect(id);
        }}
        onAdd={(compT, value) => {
          void edit('Add speed point', addRetimeKeyCommands(nodeId, SPEED_PROP, compT, value)).then((r) => {
            const added = r.ok ? (r.value[0] as { ids?: string[] } | undefined)?.ids?.[0] : undefined;
            if (added) onSelect(added);
          });
        }}
        onRemove={(id) => {
          if (tracks.length <= 1) return;
          void edit('Remove speed point', { type: 'deleteKeyframes', ids: [id] });
          onSelect(null);
        }}
        onSeek={seek}
        ariaLabel="Speed curve across the clip"
      />

      {curve && (
        <div className={styles.row}>
          <span className={styles.label} title={selectedId !== null ? 'Ramp out of the selected point' : 'Ramp out of the point before the playhead'}>
            Ramp
          </span>
          <Segmented
            className={styles.grow}
            size="sm"
            fullWidth
            aria-label="How speed changes after this point"
            options={RAMP_OPTIONS}
            value={ramp}
            onChange={(style) => { void edit(`Ramp: ${style}`, rampStyleCommands(nodeId, style, focusId)); }}
          />
        </div>
      )}

      <div className={styles.presets} role="group" aria-label="Velocity presets">
        {SPEED_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={styles.chip}
            title={`${p.hint} — across the whole clip`}
            onClick={() => {
              const plan = speedPresetCommands(nodeId, p.id);
              if (!plan) notify('This layer has no clip bar to shape a preset across.', 'warning');
              else void edit(plan.label, plan.commands);
              onSelect(null);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
    </>
  );
}

function FrameControls({ nodeId, bar, time, fps, inSec, outSec, runsOutAtSec, selectedId, onSelect, seek }: ModeControlsProps): JSX.Element {
  const frameEdit = useEngineEdit();
  const m = documentMirror();
  const srcFps = bar?.sourceFps ?? fps;
  const offset = bar?.clip.offsetSec ?? 0;
  const frameNow = mirrorSourceFrameAt(m, nodeId, time, bar);
  const totalFrames = bar?.sourceDurationSec ? Math.round(bar.sourceDurationSec * srcFps) : null;
  // Remap keys live on the chain axis = comp time; their values are chain seconds.
  const remap = useMirrorKeyframes(nodeId, REMAP_PATH);
  const keys: RetimeGraphKey[] = remap.map((k) => {
    const compT = flicksToSeconds(k.time);
    return { id: k.id, t: compT, compT, value: Math.round((keyNumber(k.value, 0) + offset) * srcFps) };
  });
  const chainOfFrame = (frame: number): number => Math.max(0, frame) / srcFps - offset;

  return (
    <>
      <div className={styles.row}>
        <AnimToggle
          nodeId={nodeId}
          tracks={[REMAP_PROP]}
          label="Source Frame"
          animated
          values={() => [chainOfFrame(frameNow)]}
          onToggle={() => { void edit('Normal Speed', { type: 'setRetime', layer: nodeId, mode: 'normal' }); }}
        />
        <span className={styles.label}>Source frame</span>
        <div className={styles.field}>
          <ValueField
            value={frameNow}
            onChange={(v) => frameEdit.send('Set source frame', setSourceFrameCommands(nodeId, time, chainOfFrame(Math.round(v))))}
            {...frameEdit.scrub('Set source frame')}
            precision={0}
            min={0}
            {...(totalFrames !== null ? { max: totalFrames - 1 } : {})}
            aria-label="Source frame shown at the playhead"
          />
        </div>
        {totalFrames !== null && <span className={styles.suffix}>of {totalFrames}</span>}
      </div>

      <RetimeGraph
        kind="frames"
        inSec={inSec}
        outSec={outSec}
        fps={fps}
        time={time}
        keys={keys}
        maxValue={totalFrames ?? undefined}
        sample={(t) => mirrorRetimedSourceSeconds(m, nodeId, t, bar) * srcFps}
        runsOutAtSec={runsOutAtSec}
        selectedId={selectedId}
        onSelect={onSelect}
        moveCommands={(id, compT, value) => moveRetimeKeyCommands(REMAP_PROP, id, compT, chainOfFrame(value))}
        dragLabel="Move frame key"
        onNudge={(id, compT, value) => {
          void edit('Nudge frame key', moveRetimeKeyCommands(REMAP_PROP, id, compT, chainOfFrame(value)));
          onSelect(id);
        }}
        onAdd={(compT, value) => { void edit('Add frame key', addRetimeKeyCommands(nodeId, REMAP_PROP, compT, chainOfFrame(value))); }}
        onRemove={(id) => {
          if (remap.length <= 1) return;
          void edit('Remove frame key', { type: 'deleteKeyframes', ids: [id] });
          onSelect(null);
        }}
        onSeek={seek}
        ariaLabel="Source frame across the clip"
      />
    </>
  );
}

export default RetimeSection;
