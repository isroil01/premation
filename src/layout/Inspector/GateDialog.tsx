/**
 * Noise Gate — the dialog.
 *
 * Set a threshold, and everything below it is pulled down. The result is
 * ordinary level keyframes you can see and drag afterwards; see
 * `core/audio/audioGate.ts` for why it bakes rather than running a gate node at
 * playback, and why that turns out to be an advantage.
 *
 * Three actions, matching the ducking dialog and for the same reason: a baked
 * curve has three lifecycle moments, and hiding two of them is how a bake
 * becomes untouchable. **Apply** writes it, **Re-gate** runs it again after the
 * take changed, **Remove** takes the track and the record away. The last two
 * appear only when there is something to redo or remove.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { Slider } from '@components/Slider';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSceneRevision } from '@stores/sceneStore';
import { setAudioToolOpener } from '@core/audio/audioCommands';
import {
  applyGate,
  computeGateEnvelope,
  gateLevels,
  planGate,
  readGate,
  removeGate,
  DEFAULT_GATE,
  type GateParams,
} from '@core/audio/audioGate';
import { staticLevelDbOf } from '@core/audio/audioFades';
import styles from './AudioToolDialog.module.css';

interface Props {
  nodeId: string;
  onDone: () => void;
}

interface Preview {
  keyframes: number;
  /** Fraction of the range the gate holds closed, 0..1. */
  closedFraction: number;
}

export function GateDialog({ nodeId, onDone }: Props): JSX.Element {
  const rev = useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  const stored = useMemo(() => (node ? readGate(node) : null), [node, rev]);

  const [params, setParams] = useState<GateParams>(() => (stored ? { ...stored } : { ...DEFAULT_GATE }));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [analysing, setAnalysing] = useState(false);

  const set = <K extends keyof GateParams>(k: K, v: GateParams[K]): void =>
    setParams((p) => ({ ...p, [k]: v }));

  /*
    Preview, debounced. Every slider drag would otherwise start a decode and an
    envelope pass over the whole work area on each pointer move. The numbers
    come from `planGate` and `gateLevels` — the same two the bake runs — so the
    count shown is the count written, which is the property that makes a
    preview worth having at all.
  */
  const key = JSON.stringify(params);
  useEffect(() => {
    let alive = true;
    setAnalysing(true);
    const timer = setTimeout(() => {
      void computeGateEnvelope(nodeId)
        .then((res) => {
          if (!alive) return;
          if (!res) {
            setPreview(null);
            return;
          }
          const curve = gateLevels(res.env, { ...params, fps: res.fps });
          let closed = 0;
          for (const v of curve) if (v < -0.5) closed++;
          setPreview({
            keyframes: planGate(res.env, {
              ...params,
              fps: res.fps,
              startCompSec: res.start,
              baseLevelDb: staticLevelDbOf(nodeId),
              toKeyframeTime: (t) => t,
            }).length,
            closedFraction: curve.length > 0 ? closed / curve.length : 0,
          });
        })
        .catch(() => { if (alive) setPreview(null); })
        .finally(() => { if (alive) setAnalysing(false); });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [nodeId, key]);

  const notify = (message: string, level: 'info' | 'warning' = 'info'): void => {
    useUIStore.getState().notify({ level, message, durationMs: 5000 });
  };

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await computeGateEnvelope(nodeId);
      if (!res) {
        notify('That layer has no decodable audio to gate.', 'warning');
        return;
      }
      // B3-legacy: engine gap — noise gate bakes keys from analysis; needs startJob/applyJobResult.
      const out = await applyGate(nodeId, res.env, {
        ...params,
        fps: res.fps,
        startCompSec: res.start,
      });
      if (out.error) notify(out.error, 'warning');
      else notify(`Gated — ${out.keyframes} level keyframes written.`);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const drop = async (): Promise<void> => {
    setBusy(true);
    try {
      // B3-legacy: engine gap — noise gate bakes keys from analysis; needs startJob/applyJobResult.
      if (await removeGate(nodeId)) notify('Noise gate removed.');
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.body}>
      <p className={styles.intro}>
        Pull this layer down wherever it is quieter than the threshold — room
        tone between phrases, hiss under a take. Written as level keyframes, so
        every one of them can be reshaped afterwards.
      </p>

      <div className={styles.row}>
        <span className={styles.label}>Threshold</span>
        <div className={styles.control}>
          <Slider
            value={params.thresholdDb}
            min={-80}
            max={0}
            step={1}
            onChange={(v) => set('thresholdDb', v)}
            aria-label="Gate threshold"
          />
          <span className={styles.value}>{`${params.thresholdDb} dB`}</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Range</span>
        <div className={styles.control}>
          <Slider
            value={params.rangeDb}
            min={-60}
            max={0}
            step={1}
            onChange={(v) => set('rangeDb', v)}
            aria-label="Gate range"
          />
          <span className={styles.value}>{params.rangeDb <= -60 ? 'Silence' : `${params.rangeDb} dB`}</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Attack</span>
        <div className={styles.control}>
          <Slider
            value={params.attackMs}
            min={0}
            max={200}
            step={1}
            onChange={(v) => set('attackMs', v)}
            aria-label="Gate attack"
          />
          <span className={styles.value}>{`${params.attackMs} ms`}</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Hold</span>
        <div className={styles.control}>
          <Slider
            value={params.holdMs}
            min={0}
            max={1000}
            step={10}
            onChange={(v) => set('holdMs', v)}
            aria-label="Gate hold"
          />
          <span className={styles.value}>{`${params.holdMs} ms`}</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Release</span>
        <div className={styles.control}>
          <Slider
            value={params.releaseMs}
            min={5}
            max={2000}
            step={5}
            onChange={(v) => set('releaseMs', v)}
            aria-label="Gate release"
          />
          <span className={styles.value}>{`${params.releaseMs} ms`}</span>
        </div>
      </div>

      <p className={styles.readout}>
        {analysing
          ? 'Listening…'
          : preview
            ? `${preview.keyframes} keyframes · closed for ${Math.round(preview.closedFraction * 100)}% of the range`
            : 'Nothing to analyse in this range.'}
      </p>
      {preview && preview.closedFraction > 0.9 && (
        <p className={styles.warn}>
          The gate is shut almost the whole time — the threshold is probably
          above the take itself. Try lowering it.
        </p>
      )}

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onDone} disabled={busy}>Cancel</Button>
        {stored && (
          <Button variant="ghost" onClick={() => void drop()} disabled={busy}>Remove</Button>
        )}
        <Button onClick={() => void run()} disabled={busy || !preview}>
          {stored ? 'Re-gate' : 'Apply'}
        </Button>
      </div>
    </div>
  );
}

/** Open the dialog for one layer. Registered below so the command can call it. */
export function openGateDialog(nodeId: string): void {
  openModal({
    title: 'Noise gate',
    size: 'sm',
    render: (close) => <GateDialog nodeId={nodeId} onDone={close} />,
  });
}

// Same contract the other two audio tools have: the dialog registers itself as
// it loads, so a command in `core/` never imports a React component.
setAudioToolOpener('gate', openGateDialog);

export default GateDialog;
