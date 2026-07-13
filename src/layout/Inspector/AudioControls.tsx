/**
 * AudioControls (Prompt 8) — the "Audio" section of the inspector, shown only
 * for audio layers. Displays the decoded waveform with a playhead marker and
 * edits level / in-out trim / mute. Playback itself is driven by the transport
 * via the AudioEngine; this panel just edits the layer's Audio component.
 */

import { useEffect, useMemo, useState } from 'react';
import { ValueField } from '@components/ValueField';
import { Switch } from '@components/Switch';
import { Slider } from '@components/Slider';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import { useActiveWorkspace } from '@stores/projectStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { audioEngine } from '@core/audio/AudioEngine';
import { audioComponent, isAudioNode } from '@core/audio/audioScene';
import { waveformPath } from '@core/audio/waveform';
import { InspectorRow } from '@components/Inspector';
import styles from './AudioControls.module.css';

const WAVE_W = 264;
const WAVE_H = 52;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

export function AudioControls({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
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
  const path = useMemo(
    () => (wave ? waveformPath(wave.peaks, WAVE_W, WAVE_H) : ''),
    [wave],
  );

  if (!node || !comp || !isAudioNode(node)) return null;

  const p = comp.props;
  const duration = num(p.__duration, 0);
  const level = num(p.__level, 100);
  const inSec = num(p.__in, 0);
  const outSec = num(p.__out, duration);
  const muted = p.__muted === true;

  const write = (key: string, value: unknown): void => {
    defaultSceneGraph.writeProp(nodeId, comp.id, key, value);
    bumpScene();
  };

  // Playhead x within the clip (only meaningful while over the trimmed region).
  const playX = duration > 0 ? (Math.min(duration, Math.max(0, time)) / duration) * WAVE_W : 0;
  const inX = duration > 0 ? (inSec / duration) * WAVE_W : 0;
  const outX = duration > 0 ? (outSec / duration) * WAVE_W : WAVE_W;

  return (
    <div className={styles.root}>
      <div className={styles.title}>Audio</div>

      <div className={styles.waveBox}>
        {wave ? (
          <svg
            className={styles.wave}
            viewBox={`0 0 ${WAVE_W} ${WAVE_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Waveform"
          >
            <rect x={0} y={0} width={inX} height={WAVE_H} className={styles.trim} />
            <rect x={outX} y={0} width={Math.max(0, WAVE_W - outX)} height={WAVE_H} className={styles.trim} />
            <path d={path} className={styles.fill} />
            <line x1={playX} y1={0} x2={playX} y2={WAVE_H} className={styles.playhead} />
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

      <InspectorRow label="In" align="center">
        <ValueField value={inSec} min={0} max={outSec} unit="s" precision={2} onChange={(v) => write('__in', v)} aria-label="In point" />
      </InspectorRow>
      <InspectorRow label="Out" align="center">
        <ValueField value={outSec} min={inSec} max={duration || undefined} unit="s" precision={2} onChange={(v) => write('__out', v)} aria-label="Out point" />
      </InspectorRow>

      <InspectorRow label="Mute" align="center">
        <Switch checked={muted} onChange={(e) => write('__muted', e.currentTarget.checked)} aria-label="Mute audio" />
      </InspectorRow>
    </div>
  );
}

export default AudioControls;
