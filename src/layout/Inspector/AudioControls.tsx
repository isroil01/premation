/**
 * AudioControls — the "Audio" section of the inspector, shown only for audio
 * layers. Displays the decoded waveform with a playhead marker and edits
 * level / timing / mute. Playback itself is driven by the transport via the
 * AudioEngine; this panel just edits the layer.
 *
 * **Timing edits go to the timeline CLIP**, not to a private copy on the Audio
 * component. Start / In / Out here and the layer's bar in the timeline are the
 * same numbers seen two ways — drag the bar and these fields move, type here
 * and the bar moves. (They used to be two unrelated sets of numbers, and only
 * the inspector's set was ever read; see `audioScene` for the whole story.)
 * Layers with no bar — audio nested in a plain group, or a headless scene —
 * fall back to editing the component props, which is what the engine reads for
 * them too.
 */

import { useEffect, useMemo, useState } from 'react';
import { ValueField } from '@components/ValueField';
import { Switch } from '@components/Switch';
import { Slider } from '@components/Slider';
import { Popover } from '@components/Popover';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useClipRevision } from '@hooks/useClipRevision';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { audioEngine } from '@core/audio/AudioEngine';
import { audioComponent, isAudioNode, readAudioClipTimings } from '@core/audio/audioScene';
import { AudioEffectsSection } from './AudioEffectsSection';
import { getTimelineController } from '@core/timeline/TimelineController';
import {
  convertAudioToKeyframes,
  ensureAudioBuffer,
  amplitudeEnvelope,
  planAudioKeyframes,
  AUDIO_AMPLITUDE_PROP,
  DEFAULT_AUDIO_KEYFRAME_OPTIONS,
  type AudioKeyframeOptions,
} from '@core/audio/audioKeyframes';
import { useUIStore } from '@stores/uiStore';
import { waveformPath } from '@core/audio/waveform';
import { InspectorRow } from '@components/Inspector';
import styles from './AudioControls.module.css';

const WAVE_W = 264;
const WAVE_H = 52;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Where the layer's audible span sits and which slice of the file it plays. */
interface Timing {
  /** Clip id when the timeline owns this span; null when props do. */
  clipId: string | null;
  startSec: number;
  inSec: number;
  outSec: number;
}

export function AudioControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  useClipRevision();
  const time = useActiveWorkspace()?.time ?? 0;
  // Re-render when the engine finishes decoding a waveform.
  const [, setLoaded] = useState(0);
  useEffect(() => audioEngine.onChange(() => setLoaded((n) => n + 1)), []);

  const node = defaultSceneGraph.getNode(nodeId);
  const comp = node ? audioComponent(node) : undefined;

  // Kick off decoding for this asset (idempotent) so the waveform appears.
  const src = comp && typeof comp.props.__src === 'string' ? comp.props.__src : '';
  const assetId = comp && typeof comp.props.__assetId === 'string' ? comp.props.__assetId : '';
  useEffect(() => {
    if (assetId && src) void audioEngine.load(assetId, src);
  }, [assetId, src]);

  const wave = assetId ? audioEngine.getWaveform(assetId) : undefined;
  const path = useMemo(() => (wave ? waveformPath(wave.peaks, WAVE_W, WAVE_H) : ''), [wave]);

  // A split layer has several bars. Edit the one under the playhead so the
  // fields describe what you are hearing; fall back to the first.
  const clipTimings = readAudioClipTimings(nodeId);
  const activeIndex = Math.max(
    0,
    clipTimings.findIndex((t) => time >= t.startSec && time < t.startSec + (t.outSec - t.inSec)),
  );

  if (!node || !comp || !isAudioNode(node)) return null;

  const p = comp.props;
  const duration = num(p.__duration, 0);
  const level = num(p.__level, 100);
  const muted = p.__muted === true;

  const active = clipTimings[activeIndex];
  const timing: Timing = active
    ? { clipId: active.id, startSec: active.startSec, inSec: active.inSec, outSec: active.outSec }
    : {
        clipId: null,
        startSec: num(p.__start, 0),
        inSec: num(p.__in, 0),
        outSec: num(p.__out, duration),
      };

  const write = (key: string, value: unknown): void => {
    defaultSceneGraph.writeProp(nodeId, comp.id, key, value);
    bumpScene();
  };

  // ── Timing writers ───────────────────────────────────────────────
  // Clip-backed: express each edit as the bar move / edge trim it really is.
  // `trimClipTo` takes an ABSOLUTE comp time for the edge, so shifting the
  // in-point by (new − old) source-seconds moves the head edge by the same
  // amount; the out-point measures from the head, hence `start + (out − in)`.
  const controller = getTimelineController();
  const setStart = (v: number): void => {
    if (timing.clipId) controller.setClipStart(timing.clipId, Math.max(0, v));
    else write('__start', Math.max(0, v));
  };
  const setIn = (v: number): void => {
    const next = clamp(v, 0, timing.outSec);
    if (timing.clipId) controller.trimClipTo(timing.clipId, 'start', timing.startSec + (next - timing.inSec));
    else write('__in', next);
  };
  const setOut = (v: number): void => {
    const next = clamp(v, timing.inSec, duration || Infinity);
    if (timing.clipId) controller.trimClipTo(timing.clipId, 'end', timing.startSec + (next - timing.inSec));
    else write('__out', next);
  };

  // Waveform geometry: the trimmed-away head/tail are shaded, and the playhead
  // draws at the SOURCE position the comp playhead currently maps to (so it
  // tracks the sound even when the bar has been slid or trimmed).
  const spanSec = Math.max(0, timing.outSec - timing.inSec);
  const localSourceSec = timing.inSec + (time - timing.startSec);
  const overClip = time >= timing.startSec && time < timing.startSec + spanSec;
  const toX = (sec: number): number => (duration > 0 ? clamp(sec / duration, 0, 1) * WAVE_W : 0);
  const playX = toX(localSourceSec);
  const inX = toX(timing.inSec);
  const outX = duration > 0 ? toX(timing.outSec) : WAVE_W;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        {clipTimings.length > 1 ? (
          <div className={styles.clipBadge} title="This layer's bar was split — editing the clip under the playhead">
            Clip {activeIndex + 1}/{clipTimings.length}
          </div>
        ) : null}
      </div>

      <div className={styles.waveBox}>
        {wave ? (
          <svg
            className={styles.wave}
            viewBox={`0 0 ${WAVE_W} ${WAVE_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Waveform"
          >
            <path d={path} className={styles.fill} />
            <rect x={0} y={0} width={inX} height={WAVE_H} className={styles.trim} />
            <rect x={outX} y={0} width={Math.max(0, WAVE_W - outX)} height={WAVE_H} className={styles.trim} />
            <line x1={inX} y1={0} x2={inX} y2={WAVE_H} className={styles.trimEdge} />
            <line x1={outX} y1={0} x2={outX} y2={WAVE_H} className={styles.trimEdge} />
            {overClip ? <line x1={playX} y1={0} x2={playX} y2={WAVE_H} className={styles.playhead} /> : null}
          </svg>
        ) : (
          <div className={styles.decoding}>Decoding waveform…</div>
        )}
      </div>

      <InspectorRow label="Level" align="center">
        <div className={styles.levelRow}>
          <Slider value={level} min={0} max={200} onChange={(v) => write('__level', v)} aria-label="Audio level" />
          <span className={styles.levelVal}>{Math.round(level)}%</span>
        </div>
      </InspectorRow>

      <InspectorRow label="Mute" align="center">
        <Switch checked={muted} onChange={(e) => write('__muted', e.currentTarget.checked)} aria-label="Mute audio" />
      </InspectorRow>

      <div className={styles.sectionLabel}>
        Timing
        <span className={styles.hint}>{timing.clipId ? 'follows the timeline bar' : 'no timeline bar'}</span>
      </div>

      <InspectorRow label="Start" align="center">
        <ValueField
          value={timing.startSec}
          min={0}
          step={0.05}
          unit="s"
          precision={2}
          onChange={setStart}
          aria-label="Clip start"
        />
      </InspectorRow>
      <InspectorRow label="In" align="center">
        <ValueField
          value={timing.inSec}
          min={0}
          max={timing.outSec}
          step={0.05}
          unit="s"
          precision={2}
          onChange={setIn}
          aria-label="In point"
        />
      </InspectorRow>
      <InspectorRow label="Out" align="center">
        <ValueField
          value={timing.outSec}
          min={timing.inSec}
          max={duration || undefined}
          step={0.05}
          unit="s"
          precision={2}
          onChange={setOut}
          aria-label="Out point"
        />
      </InspectorRow>
      <InspectorRow label="Duration" align="center">
        <span className={styles.readonlyVal}>
          {spanSec.toFixed(2)}s <span className={styles.muted}>of {duration.toFixed(2)}s</span>
        </span>
      </InspectorRow>

      <div className={styles.sectionLabel}>Effects</div>
      <AudioEffectsSection nodeId={nodeId} />

      <div className={styles.sectionLabel}>Keyframes</div>
      <AudioToKeyframes nodeId={nodeId} />
    </div>
  );
}

// ── Convert audio to keyframes ─────────────────────────────────────

/** Detail presets — a plain-language front end for `minDelta` + `frameStep`. */
const DETAIL_PRESETS = [
  { id: 'coarse', label: 'Coarse', frameStep: 4, minDelta: 8 },
  { id: 'balanced', label: 'Balanced', frameStep: 2, minDelta: 3 },
  { id: 'detailed', label: 'Detailed', frameStep: 1, minDelta: 1 },
  { id: 'exact', label: 'Every frame', frameStep: 1, minDelta: 0 },
] as const;

type DetailId = (typeof DETAIL_PRESETS)[number]['id'];

/**
 * The conversion control: a popover of options with a LIVE keyframe count, then
 * one apply. The count matters — this writes a whole track, and the old
 * one-click button silently produced thousands of keyframes with no warning and
 * no way to ask for fewer.
 */
function AudioToKeyframes({ nodeId }: { nodeId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DetailId>('balanced');
  const [smoothing, setSmoothing] = useState(3);
  const [gain, setGain] = useState(1);
  const [busy, setBusy] = useState(false);
  /** Envelope for the preview count; null until decoded. */
  const [env, setEnv] = useState<number[] | null>(null);
  const [decoding, setDecoding] = useState(false);

  const preset = DETAIL_PRESETS.find((d) => d.id === detail) ?? DETAIL_PRESETS[1];
  const options: AudioKeyframeOptions = {
    ...DEFAULT_AUDIO_KEYFRAME_OPTIONS,
    frameStep: preset.frameStep,
    minDelta: preset.minDelta,
    smoothing,
    gain,
  };

  // Decode + sample the envelope once the popover opens, so the estimate is
  // real rather than a guess. Cancelled on close so a slow decode can't write
  // state into an unmounted popover.
  useEffect(() => {
    if (!open || env !== null) return;
    let cancelled = false;
    setDecoding(true);
    void (async () => {
      const buffer = await ensureAudioBuffer(nodeId);
      if (cancelled) return;
      const fps = getTimelineController().fps || 30;
      setEnv(buffer ? amplitudeEnvelope(buffer, fps) : []);
      setDecoding(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, env, nodeId]);

  const estimate = useMemo(() => (env ? planAudioKeyframes(env, options).length : null), [env, options.frameStep, options.minDelta, options.smoothing, options.gain]);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const n = await convertAudioToKeyframes(nodeId, options);
      useUIStore.getState().notify(
        n > 0
          ? {
              level: 'success',
              message: `Audio → ${n} keyframe${n === 1 ? '' : 's'} on “${AUDIO_AMPLITUDE_PROP}”`,
              durationMs: 3200,
            }
          : {
              level: 'warning',
              message: 'No audio could be decoded for this layer.',
              durationMs: 3200,
            },
      );
      if (n > 0) setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      trigger={
        <button
          type="button"
          className={styles.convertBtn}
          title={`Write the loudness envelope as keyframes (${AUDIO_AMPLITUDE_PROP}, 0–100) — drive any property from it`}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        >
          <Icon name="keyframe" size="sm" />
          <span>Convert audio to keyframes…</span>
        </button>
      }
    >
      <div className={styles.panel}>
        <div className={styles.panelTitle}>Convert audio to keyframes</div>
        <p className={styles.panelDesc}>
          Samples the layer&rsquo;s loudness into a <code>{AUDIO_AMPLITUDE_PROP}</code> track (0–100) you can drive any
          property from. Replaces the existing track.
        </p>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Detail</span>
          <div className={styles.segmented} role="radiogroup" aria-label="Keyframe detail">
            {DETAIL_PRESETS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={detail === d.id}
                className={detail === d.id ? styles.segOn : styles.seg}
                onClick={() => setDetail(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Smoothing</span>
          <div className={styles.levelRow}>
            <Slider value={smoothing} min={1} max={31} step={2} onChange={setSmoothing} aria-label="Smoothing" />
            <span className={styles.levelVal}>{smoothing === 1 ? 'off' : `${smoothing}f`}</span>
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Gain</span>
          <div className={styles.levelRow}>
            <Slider value={gain} min={0.25} max={4} step={0.25} onChange={setGain} aria-label="Amplitude gain" />
            <span className={styles.levelVal}>{gain}×</span>
          </div>
        </div>

        <div className={styles.estimate}>
          {decoding ? (
            <>Decoding audio…</>
          ) : estimate === null ? (
            <>&nbsp;</>
          ) : estimate === 0 ? (
            <span className={styles.warn}>No audio to convert.</span>
          ) : (
            <>
              <strong>{estimate.toLocaleString()}</strong> keyframes
              {estimate > 2000 ? <span className={styles.warn}> — try a coarser detail</span> : null}
            </>
          )}
        </div>

        <div className={styles.panelActions}>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={busy || estimate === 0} onClick={() => void apply()}>
            {busy ? 'Converting…' : 'Convert'}
          </Button>
        </div>
      </div>
    </Popover>
  );
}

export default AudioControls;
