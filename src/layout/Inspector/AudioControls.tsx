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
import { useSceneRevision } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import { useClipRevision } from '@hooks/useClipRevision';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { audioEngine } from '@core/audio/AudioEngine';
import { audioComponent, isAudioNode, readAudioClipTimings } from '@core/audio/audioScene';
import { AudioEffectsSection } from './AudioEffectsSection';
import { getTimelineController } from '@core/timeline/TimelineController';
import {
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
import { KeyframeRow } from './KeyframeRow';
import {
  AUDIO_LEVEL_DB_PROP, MIN_LEVEL_DB, MAX_LEVEL_DB, percentToDb,
  AUDIO_PAN_PROP, MIN_PAN, MAX_PAN,
} from '@core/audio/audioParams';
import { DEFAULT_FADE_SEC, type FadeSide } from '@core/audio/audioFades';
import { useEngineEdit } from './useEngineEdit';
import { scalarValueCommands } from './inspectorEdits';
import { barTimingCommand, convertAudioToKeyframesEdit, fadeEdit, muteEdit, unbarredTimingCommand } from './audioEdits';
// Importing the command module registers "Remove Silence…" and "Duck Under
// Voice…"; importing the dialogs is what tells those commands how to open. The
// three are pulled in together here so the menu entries cannot exist without a
// dialog behind them.
import '@core/audio/audioCommands';
import { openSilenceRemovalDialog } from './SilenceRemovalDialog';
import { openDuckingDialog } from './DuckingDialog';
import { openGateDialog } from './GateDialog';
import styles from './AudioControls.module.css';
import toolStyles from './AudioToolDialog.module.css';

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
  // A scrubbed timing / level field is ONE gesture; a typed value one entry.
  const timingEdit = useEngineEdit();
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
  // dB is the stored form; the percent is the legacy fallback (see the
  // KeyframeRow below and `staticLevelDb` in audioScene).
  const levelDb =
    typeof p[AUDIO_LEVEL_DB_PROP] === 'number'
      ? (p[AUDIO_LEVEL_DB_PROP] as number)
      : percentToDb(num(p.__level, 100));
  // Centred is the absence of the prop, not a stored 0 — see `panOf`.
  const pan = typeof p[AUDIO_PAN_PROP] === 'number' ? (p[AUDIO_PAN_PROP] as number) : 0;
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

  /** Level / Pan typed or scrubbed with the stopwatch off (KeyframeRow's static route). */
  const writeStatic = (track: string, label: string, v: number): void => {
    timingEdit.send(`Set ${label}`, scalarValueCommands(track, [{ nodeId, value: v }], { seconds: time }));
  };

  const fadeHere = (side: FadeSide): void => {
    void fadeEdit([nodeId], side);
  };

  // ── Timing writers ───────────────────────────────────────────────
  // A layer IS its bar (ENGINE_API.md §3.1): Start moves the bar's head to the
  // value, In / Out trim its edges — `setLayerTiming`, absolute, so a scrub is
  // one gesture. The in-point measures source seconds from the head, the
  // out-point from the head too, hence `start + (out − in)`. A layer with no
  // bar edits its Audio component's own Start / In / Out (`audio/clip*`).
  // A legacy multi-bar layer edits the layer's first / last bar (the API's
  // bar model); its Start moves the whole layer.
  const sendTiming = (field: 'start' | 'in' | 'out', label: string, v: number): void => {
    timingEdit.send(label, timing.clipId ? barTimingCommand(nodeId, field, timing, v) : unbarredTimingCommand(nodeId, field, v));
  };
  const setStart = (v: number): void => sendTiming('start', 'Clip start', Math.max(0, v));
  const setIn = (v: number): void => sendTiming('in', 'In point', clamp(v, 0, timing.outSec));
  const setOut = (v: number): void => sendTiming('out', 'Out point', clamp(v, timing.inSec, duration || Infinity));

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

      {/* Level is `audioLevelDb`, keyed through the same KeyframeRow a video
          layer's track uses — one control, one prop, one stopwatch for every
          layer that makes a sound. The legacy `__level` percent is only read
          (via `percentToDb`) so an older project opens at the gain it had; the
          first edit writes dB and the percent stops being consulted. */}
      <KeyframeRow
        nodeId={nodeId}
        prop={AUDIO_LEVEL_DB_PROP}
        label="Level"
        value={levelDb}
        unit="dB"
        min={MIN_LEVEL_DB}
        max={MAX_LEVEL_DB}
        precision={1}
        onStatic={(v) => writeStatic(AUDIO_LEVEL_DB_PROP, 'Level', v)}
      />

      <KeyframeRow
        nodeId={nodeId}
        prop={AUDIO_PAN_PROP}
        label="Pan"
        value={pan}
        unit="%"
        min={MIN_PAN}
        max={MAX_PAN}
        onStatic={(v) => writeStatic(AUDIO_PAN_PROP, 'Pan', v)}
      />

      <InspectorRow label="Mute" align="center">
        <Switch checked={muted} onChange={(e) => muteEdit(nodeId, e.currentTarget.checked)} aria-label="Mute audio" />
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
          {...timingEdit.scrub('Clip start')}
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
          {...timingEdit.scrub('In point')}
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
          {...timingEdit.scrub('Out point')}
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

      <div className={styles.sectionLabel}>
        Edit
        <span className={styles.hint}>cuts and levels</span>
      </div>
      <div className={toolStyles.toolButtons}>
        {/* The fades write ordinary level keyframes (see `audioFades`), so they
            are reshapeable in the graph editor afterwards and compose with a
            duck rather than replacing it. Wrapped in a history entry here
            because the command path is not the only way in. */}
        <button
          type="button"
          className={toolStyles.toolButton}
          title={`Ramp up from silence over ${DEFAULT_FADE_SEC}s from where this layer's bar starts`}
          onClick={() => fadeHere('in')}
        >
          Fade in
        </button>
        <button
          type="button"
          className={toolStyles.toolButton}
          title={`Ramp down to silence over the last ${DEFAULT_FADE_SEC}s of this layer's bar`}
          onClick={() => fadeHere('out')}
        >
          Fade out
        </button>
        <button
          type="button"
          className={toolStyles.toolButton}
          title="Find the dead air in this take and cut it out, closing the gaps"
          onClick={() => openSilenceRemovalDialog(nodeId)}
        >
          Remove silence…
        </button>
        <button
          type="button"
          className={toolStyles.toolButton}
          title="Hold this layer’s level down whenever another layer is talking"
          onClick={() => openDuckingDialog(nodeId)}
        >
          Duck under voice…
        </button>
        <button
          type="button"
          className={toolStyles.toolButton}
          title="Pull this layer down wherever it is below a threshold — room tone, hiss"
          onClick={() => openGateDialog(nodeId)}
        >
          Noise gate…
        </button>
      </div>

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
  const options: AudioKeyframeOptions = useMemo(() => ({
    ...DEFAULT_AUDIO_KEYFRAME_OPTIONS,
    frameStep: preset.frameStep,
    minDelta: preset.minDelta,
    smoothing,
    gain,
  }), [preset.frameStep, preset.minDelta, smoothing, gain]);

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

  const estimate = useMemo(() => (env ? planAudioKeyframes(env, options).length : null), [env, options]);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const n = await convertAudioToKeyframesEdit(nodeId, options);
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
          className={toolStyles.toolButton}
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
