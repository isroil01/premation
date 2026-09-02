/**
 * Duck Under Voice — the dialog.
 *
 * Pick the layer that should push this one down, say how far and how fast, and
 * the level track is written as ordinary keyframes you can see and drag
 * afterwards. See `core/audio/ducking.ts` for why it bakes rather than running
 * a sidechain compressor at playback.
 *
 * Three actions rather than one, because a baked duck has three lifecycle
 * moments and hiding two of them is how a bake becomes untouchable: **Apply**
 * writes it, **Re-duck** runs it again after the voice changed (the reason the
 * parameters are remembered on the node at all), and **Remove** takes both the
 * track and the record away. Re-duck and Remove appear only once there is
 * something to redo or remove.
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
  applyDucking,
  computeDuckEnvelope,
  duckableLayers,
  readDucking,
  reduck,
  removeDucking,
  thinLevels,
  DEFAULT_DUCKING,
  type ApplyDuckingResult,
  type DuckingParams,
} from '@core/audio/ducking';
import styles from './AudioToolDialog.module.css';

interface Props {
  nodeId: string;
  onDone: () => void;
}

export function DuckingDialog({ nodeId, onDone }: Props): JSX.Element {
  const rev = useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  const stored = useMemo(() => (node ? readDucking(node) : null), [node, rev]);

  // Anything with sound except this layer. A video layer's own track is a
  // legitimate sidechain, which is why the list is not filtered by layer kind.
  const sources = useMemo(() => duckableLayers().filter((l) => l.id !== nodeId), [nodeId, rev]);

  const [voiceNodeId, setVoiceNodeId] = useState<string>(
    () => stored?.voiceNodeId ?? sources[0]?.id ?? '',
  );
  const [params, setParams] = useState<DuckingParams>(() => (stored ? { ...stored } : { ...DEFAULT_DUCKING }));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ keyframes: number; peakDb: number } | null>(null);
  const [analysing, setAnalysing] = useState(false);

  const set = <K extends keyof DuckingParams>(k: K, v: DuckingParams[K]): void => {
    setParams((p) => ({ ...p, [k]: v }));
  };

  // Preview, debounced: every slider drag would otherwise start an FFT pass
  // over the whole work area on each pointer move. The numbers come from
  // `computeDuckEnvelope` + `thinLevels` — the same two the bake runs — so the
  // count shown is the count written.
  const key = `${voiceNodeId}|${JSON.stringify(params)}`;
  useEffect(() => {
    if (!voiceNodeId) {
      setPreview(null);
      return;
    }
    let alive = true;
    setAnalysing(true);
    const timer = setTimeout(() => {
      void computeDuckEnvelope(voiceNodeId, params)
        .then((env) => {
          if (!alive) return;
          setAnalysing(false);
          if (!env) {
            setPreview(null);
            return;
          }
          let peak = 0;
          for (const g of env.gainDb) if (g < peak) peak = g;
          setPreview({ keyframes: thinLevels(env.gainDb).length, peakDb: Math.round(peak * 10) / 10 });
        })
        .catch(() => {
          if (!alive) return;
          setAnalysing(false);
          setPreview(null);
        });
    }, 200);
    return (): void => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, voiceNodeId]);

  const report = (result: ApplyDuckingResult, verb: string): void => {
    useUIStore.getState().notify(
      result.error
        ? { level: 'warning', message: result.error, durationMs: 5000 }
        : {
            level: 'success',
            message:
              `${verb} — ${result.keyframes} level keyframe${result.keyframes === 1 ? '' : 's'}, `
              + `down to ${result.peakDuckDb} dB.`,
            durationMs: 4000,
          },
    );
    if (!result.error) onDone();
  };

  const run = async (fn: () => Promise<ApplyDuckingResult>, verb: string): Promise<void> => {
    setBusy(true);
    try {
      report(await fn(), verb);
    } finally {
      setBusy(false);
    }
  };

  const drop = async (): Promise<void> => {
    setBusy(true);
    try {
      const ok = await removeDucking(nodeId);
      useUIStore.getState().notify({
        level: ok ? 'success' : 'warning',
        message: ok ? 'Ducking removed, level track cleared.' : 'This layer has no ducking to remove.',
        durationMs: 4000,
      });
      if (ok) onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.body}>
      <p className={styles.intro}>
        Writes level keyframes on this layer that pull it down whenever the sidechain layer is above
        the threshold. Preview and export read the same track.
      </p>

      <div className={styles.row}>
        <span className={styles.label}>Sidechain</span>
        <div className={styles.control}>
          <select
            className={styles.select}
            value={voiceNodeId}
            onChange={(e) => setVoiceNodeId(e.target.value)}
            aria-label="Sidechain layer"
          >
            {sources.length === 0 ? <option value="">No other layer has sound</option> : null}
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Duck by</span>
        <div className={styles.control}>
          <Slider
            value={params.duckDb}
            min={-40}
            max={0}
            step={1}
            onChange={(v) => set('duckDb', v)}
            aria-label="Duck amount"
          />
          <span className={styles.value}>{params.duckDb} dB</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Threshold</span>
        <div className={styles.control}>
          <Slider
            value={params.thresholdDb}
            min={-60}
            max={-5}
            step={1}
            onChange={(v) => set('thresholdDb', v)}
            aria-label="Sidechain threshold"
          />
          <span className={styles.value}>{params.thresholdDb} dB</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Attack</span>
        <div className={styles.control}>
          <Slider
            value={params.attackMs}
            min={0}
            max={1000}
            step={10}
            onChange={(v) => set('attackMs', v)}
            aria-label="Attack"
          />
          <span className={styles.value}>{params.attackMs} ms</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Release</span>
        <div className={styles.control}>
          <Slider
            value={params.releaseMs}
            min={0}
            max={3000}
            step={50}
            onChange={(v) => set('releaseMs', v)}
            aria-label="Release"
          />
          <span className={styles.value}>{params.releaseMs} ms</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Hold</span>
        <div className={styles.control}>
          <Slider
            value={params.holdMs}
            min={0}
            max={2000}
            step={50}
            onChange={(v) => set('holdMs', v)}
            aria-label="Hold"
          />
          <span className={styles.value}>{params.holdMs} ms</span>
        </div>
      </div>

      <div className={styles.readout} role="status">
        {!voiceNodeId ? (
          <span className={styles.warn}>Nothing to duck under — this comp has only one layer with sound.</span>
        ) : analysing ? (
          <span>Analysing the sidechain…</span>
        ) : !preview ? (
          <span className={styles.warn}>That layer&rsquo;s audio has not decoded, or is silent here.</span>
        ) : preview.peakDb === 0 ? (
          <span>Never crosses the threshold — nothing would duck. Try a lower threshold.</span>
        ) : (
          <>
            <span>
              Will write <strong>{preview.keyframes}</strong> level keyframe
              {preview.keyframes === 1 ? '' : 's'}, down to <strong>{preview.peakDb}</strong> dB
            </span>
            <span className={styles.readoutNote}>Over the work area, or the whole comp when none is set.</span>
          </>
        )}
      </div>

      <div className={styles.actionsSplit}>
        <div className={styles.actionsLeft}>
          {stored ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => reduck(nodeId), 'Re-ducked')}>
                Re-duck
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void drop()}>
                Remove
              </Button>
            </>
          ) : null}
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={busy || !voiceNodeId}
            onClick={() => void run(() => applyDucking(nodeId, voiceNodeId, params), 'Ducked')}
          >
            {busy ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Open the dialog for a layer. Also the shape the command calls. */
export function openDuckingDialog(nodeId: string): void {
  openModal({
    title: 'Duck under voice',
    size: 'sm',
    render: (close) => <DuckingDialog nodeId={nodeId} onDone={close} />,
  });
}

setAudioToolOpener('ducking', openDuckingDialog);

export default DuckingDialog;
