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
 */

import { useState } from 'react';
import { Segmented } from '@components/Segmented';
import { ValueField } from '@components/ValueField';
import { defaultAnimation } from '@motion/animation';
import { useActiveWorkspace, useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useUIStore } from '@stores/uiStore';
import { useAnimationRevision } from '@hooks/useAnimationRevision';
import { getNodeLayerTime, type FrameBlend } from '@core/scene/layerTime';
import { runAnimEdit } from '@core/animation/animationCommands';
import { compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import {
  REMAP_PROP,
  SPEED_PROP,
  readRetimeMode,
  type RetimeMode,
} from '@core/animation/retime';
import {
  SPEED_PRESETS,
  addRetimeKey,
  applySpeedPreset,
  fitSpeedToFootage,
  moveRetimeKey,
  rampStyleOf,
  removeSpeedKey,
  retimeBarInfo,
  retimeSummary,
  retimedSourceSeconds,
  retimedSpeedAt,
  setRampStyle,
  setRetimeMode,
  setSourceFrameAt,
  setSpeedAt,
  sourceFrameAt,
  type RampStyle,
} from '@core/animation/retimeCommands';
import { AnimToggle } from './AnimToggle';
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

export function RetimeSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  useAnimationRevision();
  const time = useActiveWorkspace()?.time ?? 0;
  const fps = useCompositionStore((c) => c.fps) || 30;
  const [selectedT, setSelectedT] = useState<number | null>(null);

  const mode = readRetimeMode(defaultAnimation, nodeId);
  const bar = retimeBarInfo(nodeId);
  const blend = getNodeLayerTime(nodeId).frameBlend;
  const inSec = bar?.inSec ?? 0;
  const outSec = bar?.outSec ?? Math.max(inSec + 1, useCompositionStore.getState().durationSeconds || 1);

  const seek = (t: number): void => useProjectStore.getState().actions.setTime(t, Math.round(t * fps));

  const changeMode = (next: RetimeMode): void => {
    // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
    const approximate = setRetimeMode([nodeId], next);
    setSelectedT(null);
    if (approximate) notify('Converted to Speed %. The frames at your old keys are kept; check the curve between them.');
  };

  const speedNow = Math.round(retimedSpeedAt(nodeId, time, bar) * 100);
  const summary = mode === 'normal' ? null : retimeSummary(nodeId);

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
          time={time}
          fps={fps}
          inSec={inSec}
          outSec={outSec}
          runsOutAtSec={summary?.runsOutAtSec ?? null}
          selectedT={selectedT}
          onSelect={setSelectedT}
          seek={seek}
        />
      )}

      {mode === 'frames' && (
        <FrameControls
          nodeId={nodeId}
          time={time}
          fps={fps}
          inSec={inSec}
          outSec={outSec}
          runsOutAtSec={summary?.runsOutAtSec ?? null}
          selectedT={selectedT}
          onSelect={setSelectedT}
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
                    // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
                    if (fitSpeedToFootage(nodeId)) notify('Scaled the speed curve to end on the last frame.', 'success');
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
  time: number;
  fps: number;
  inSec: number;
  outSec: number;
  runsOutAtSec: number | null;
  selectedT: number | null;
  onSelect: (t: number | null) => void;
  seek: (t: number) => void;
}

function SpeedControls({ nodeId, time, fps, inSec, outSec, runsOutAtSec, selectedT, onSelect, seek }: ModeControlsProps): JSX.Element {
  const tracks = defaultAnimation.getTrackKeyframes(nodeId, SPEED_PROP) ?? [];
  // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
  const u = compToKeyframeTime(nodeId, time);
  const valueNow = defaultAnimation.sample(nodeId, SPEED_PROP, u) ?? 100;
  const curve = tracks.length > 1;

  const keys: RetimeGraphKey[] = tracks.map((k) => ({ t: k.t, compT: keyframeToCompTime(nodeId, k.t), value: k.value }));
  // The point a Ramp style edits: the selected one, else the one the playhead is in.
  const focusKey = tracks.find((k) => k.t === selectedT)
    ?? [...tracks].reverse().find((k) => k.t <= u + 1e-9)
    ?? tracks[0];
  const ramp: RampStyle = rampStyleOf(focusKey?.easing);

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
              // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
              runAnimEdit('Constant speed', () => defaultAnimation.setKeyframes(nodeId, SPEED_PROP, [
                { t: compToKeyframeTime(nodeId, inSec), value: valueNow, easing: 'linear' },
              ]));
              onSelect(null);
            } else {
              // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
              addRetimeKey(nodeId, SPEED_PROP, time, valueNow);
            }
          }}
        />
        <span className={styles.label}>Speed</span>
        <div className={styles.field}>
          <ValueField
            value={Math.round(valueNow * 10) / 10}
            // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
            onChange={(v) => setSpeedAt(nodeId, time, v, `retime:speed:${nodeId}:${u}`)}
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
        // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
        sample={(t) => defaultAnimation.sample(nodeId, SPEED_PROP, compToKeyframeTime(nodeId, t)) ?? 100}
        runsOutAtSec={runsOutAtSec}
        selectedT={selectedT}
        onSelect={onSelect}
        onMove={(fromT, compT, value) => {
          // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
          const toT = compToKeyframeTime(nodeId, compT);
          moveRetimeKey(nodeId, SPEED_PROP, fromT, toT, value);
          onSelect(toT);
          return toT;
        }}
        onNudge={(fromT, compT, value) => {
          // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
          const toT = compToKeyframeTime(nodeId, compT);
          runAnimEdit('Nudge speed point', () => moveRetimeKey(nodeId, SPEED_PROP, fromT, toT, value));
          onSelect(toT);
        }}
        onAdd={(compT, value) => { addRetimeKey(nodeId, SPEED_PROP, compT, value); onSelect(compToKeyframeTime(nodeId, compT)); }}
        // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
        onRemove={(t) => { removeSpeedKey(nodeId, t); onSelect(null); }}
        onSeek={seek}
        ariaLabel="Speed curve across the clip"
      />

      {curve && (
        <div className={styles.row}>
          <span className={styles.label} title={selectedT !== null ? 'Ramp out of the selected point' : 'Ramp out of the point before the playhead'}>
            Ramp
          </span>
          <Segmented
            className={styles.grow}
            size="sm"
            fullWidth
            aria-label="How speed changes after this point"
            options={RAMP_OPTIONS}
            value={ramp}
            // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
            onChange={(style) => setRampStyle(nodeId, style, focusKey?.t ?? null)}
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
              // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
              if (applySpeedPreset([nodeId], p.id) === 0) notify('This layer has no clip bar to shape a preset across.', 'warning');
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

function FrameControls({ nodeId, time, fps, inSec, outSec, runsOutAtSec, selectedT, onSelect, seek }: ModeControlsProps): JSX.Element {
  const bar = retimeBarInfo(nodeId);
  const srcFps = bar?.sourceFps ?? fps;
  const offset = bar?.clip.offsetSec ?? 0;
  const frameNow = sourceFrameAt(nodeId, time, bar);
  const totalFrames = bar?.sourceDurationSec ? Math.round(bar.sourceDurationSec * srcFps) : null;
  const remap = defaultAnimation.getTrackKeyframes(nodeId, REMAP_PROP) ?? [];
  const keys: RetimeGraphKey[] = remap.map((k) => ({
    t: k.t,
    compT: keyframeToCompTime(nodeId, k.t, REMAP_PROP),
    value: Math.round((k.value + offset) * srcFps),
  }));
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
          // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
          onToggle={() => setRetimeMode([nodeId], 'normal')}
        />
        <span className={styles.label}>Source frame</span>
        <div className={styles.field}>
          <ValueField
            value={frameNow}
            // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
            onChange={(v) => setSourceFrameAt(nodeId, time, Math.round(v), `retime:frame:${nodeId}:${time}`)}
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
        sample={(t) => retimedSourceSeconds(nodeId, t, bar) * srcFps}
        runsOutAtSec={runsOutAtSec}
        selectedT={selectedT}
        onSelect={onSelect}
        onMove={(fromT, compT, value) => {
          // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
          const toT = compToKeyframeTime(nodeId, compT, REMAP_PROP);
          moveRetimeKey(nodeId, REMAP_PROP, fromT, toT, chainOfFrame(value));
          onSelect(toT);
          return toT;
        }}
        onNudge={(fromT, compT, value) => {
          // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
          const toT = compToKeyframeTime(nodeId, compT, REMAP_PROP);
          runAnimEdit('Nudge frame key', () => moveRetimeKey(nodeId, REMAP_PROP, fromT, toT, chainOfFrame(value)));
          onSelect(toT);
        }}
        onAdd={(compT, value) => addRetimeKey(nodeId, REMAP_PROP, compT, chainOfFrame(value))}
        onRemove={(t) => {
          if (remap.length <= 1) return;
          // B3-legacy: engine gap — Twixtor-style retime keys (speed integration, ramp styles, presets, fit, source-frame keys, approximate-conversion report) have no API commands beyond setRetime.
          runAnimEdit('Remove frame key', () => defaultAnimation.removeKeyframe(nodeId, REMAP_PROP, t));
          onSelect(null);
        }}
        onSeek={seek}
        ariaLabel="Source frame across the clip"
      />
    </>
  );
}

export default RetimeSection;
