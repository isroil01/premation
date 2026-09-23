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
import { keyframeToCompTime } from '@core/timeline/TimelineController';
import { keyAxisTimeForDisplay } from '@core/engine/displayTime';
import { edit } from '@core/engine/uiEdits';
import {
  REMAP_PROP,
  SPEED_PROP,
  readRetimeMode,
  type RetimeMode,
} from '@core/animation/retime';
import {
  SPEED_PRESETS,
  rampStyleOf,
  retimeBarInfo,
  retimeSummary,
  retimedSourceSeconds,
  retimedSpeedAt,
  sourceFrameAt,
  type RampStyle,
} from '@core/animation/retimeCommands';
import { AnimToggle } from './AnimToggle';
import { useEngineEdit } from './useEngineEdit';
import {
  addRetimeKeyCommands,
  constantSpeedCommands,
  fitToFootageCommands,
  moveRetimeKeyCommands,
  rampStyleCommands,
  retimeKeyIds,
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

export function RetimeSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  useAnimationRevision();
  const time = useActiveWorkspace()?.time ?? 0;
  const fps = useCompositionStore((c) => c.fps) || 30;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const mode = readRetimeMode(defaultAnimation, nodeId);
  const bar = retimeBarInfo(nodeId);
  const blend = getNodeLayerTime(nodeId).frameBlend;
  const inSec = bar?.inSec ?? 0;
  const outSec = bar?.outSec ?? Math.max(inSec + 1, useCompositionStore.getState().durationSeconds || 1);

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
          selectedId={selectedId}
          onSelect={setSelectedId}
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
  time: number;
  fps: number;
  inSec: number;
  outSec: number;
  runsOutAtSec: number | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  seek: (t: number) => void;
}

function SpeedControls({ nodeId, time, fps, inSec, outSec, runsOutAtSec, selectedId, onSelect, seek }: ModeControlsProps): JSX.Element {
  const speedEdit = useEngineEdit();
  const tracks = defaultAnimation.getTrackKeyframes(nodeId, SPEED_PROP) ?? [];
  const ids = retimeKeyIds(nodeId, SPEED_PROP);
  const u = keyAxisTimeForDisplay(nodeId, time);
  const valueNow = defaultAnimation.sample(nodeId, SPEED_PROP, u) ?? 100;
  const curve = tracks.length > 1;

  const keys: RetimeGraphKey[] = tracks.flatMap((k) => {
    const id = ids.get(k.t);
    return id ? [{ id, t: k.t, compT: keyframeToCompTime(nodeId, k.t), value: k.value }] : [];
  });
  // The point a Ramp style edits: the selected one, else the one the playhead is in.
  const selectedT = keys.find((k) => k.id === selectedId)?.t;
  const focusKey = tracks.find((k) => k.t === selectedT)
    ?? [...tracks].reverse().find((k) => k.t <= u + 1e-9)
    ?? tracks[0];
  const ramp: RampStyle = rampStyleOf(focusKey?.easing);
  const focusId = focusKey ? ids.get(focusKey.t) ?? null : null;

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
        sample={(t) => defaultAnimation.sample(nodeId, SPEED_PROP, keyAxisTimeForDisplay(nodeId, t)) ?? 100}
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

function FrameControls({ nodeId, time, fps, inSec, outSec, runsOutAtSec, selectedId, onSelect, seek }: ModeControlsProps): JSX.Element {
  const frameEdit = useEngineEdit();
  const bar = retimeBarInfo(nodeId);
  const srcFps = bar?.sourceFps ?? fps;
  const offset = bar?.clip.offsetSec ?? 0;
  const frameNow = sourceFrameAt(nodeId, time, bar);
  const totalFrames = bar?.sourceDurationSec ? Math.round(bar.sourceDurationSec * srcFps) : null;
  const remap = defaultAnimation.getTrackKeyframes(nodeId, REMAP_PROP) ?? [];
  const ids = retimeKeyIds(nodeId, REMAP_PROP);
  const keys: RetimeGraphKey[] = remap.flatMap((k) => {
    const id = ids.get(k.t);
    return id ? [{ id, t: k.t, compT: keyframeToCompTime(nodeId, k.t, REMAP_PROP), value: Math.round((k.value + offset) * srcFps) }] : [];
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
        sample={(t) => retimedSourceSeconds(nodeId, t, bar) * srcFps}
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
