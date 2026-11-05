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

import { t } from '@core/i18n';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { useDialogPrimaryAction } from '@components/Modal';
import { Slider } from '@components/Slider';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayers, useMirrorProperty, useMirrorSelect } from '@hooks/useMirror';
import { duckingOf, soundLayersIn } from '@core/mirror/audio';
import { setAudioToolOpener } from './audioCommands';
import { DEFAULT_DUCKING, type ApplyDuckingResult, type DuckingParams } from '@core/audio/ducking';
import { duckEdit, reduckEdit, removeDuckingEdit } from './audioEdits';
import { previewEngineJob } from '@core/engine/engineJobs';
import styles from './AudioToolDialog.module.css';

interface Props {
  nodeId: string;
  onDone: () => void;
}

export function DuckingDialog({ nodeId, onDone }: Props): JSX.Element {
  // The remembered ducking (`audio/ducking`) and the layers with sound, from
  // the document mirror (B4).
  const duckInfo = useMirrorProperty(nodeId, 'audio/ducking');
  const stored = useMemo(() => (duckInfo ? duckingOf(documentMirror(), nodeId) : null), [duckInfo, nodeId]);

  // Anything with sound except this layer. A video layer's own track is a
  // legitimate sidechain, which is why the list is not filtered by layer kind.
  const layerIds = useMirrorSelect(['layers'], (m) => m.layerIds());
  const headers = useMirrorLayers(layerIds);
  const sources = useMemo(() => soundLayersIn(headers).filter((l) => l.id !== nodeId), [nodeId, headers]);

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
  // over the whole work area on each pointer move. The numbers are the engine's
  // audioDuck job summary (apply: false) — the pass the bake runs.
  const key = `${voiceNodeId}|${JSON.stringify(params)}`;
  useEffect(() => {
    if (!voiceNodeId) {
      setPreview(null);
      return;
    }
    let alive = true;
    setAnalysing(true);
    const timer = setTimeout(() => {
      void (async () => {
        const viaEngine = await previewEngineJob<{ keyframes: number; peakDuckDb?: number }>({
          kind: 'audioDuck', value: { music: nodeId, voices: [voiceNodeId], params: JSON.stringify(params) },
        });
        if (!alive) return;
        setAnalysing(false);
        setPreview(viaEngine && viaEngine.status === 'done' && viaEngine.result
          ? { keyframes: viaEngine.result.keyframes, peakDb: viaEngine.result.peakDuckDb ?? 0 }
          : null);
      })().catch(() => {
        if (!alive) return;
        setAnalysing(false);
        setPreview(null);
      });
    }, 200);
    return (): void => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, voiceNodeId, nodeId]);

  const report = (result: ApplyDuckingResult, verb: 'ducked' | 'reducked'): void => {
    const vars = { n: result.keyframes, db: result.peakDuckDb };
    const one = result.keyframes === 1;
    const message = verb === 'ducked'
      ? (one
        ? t('inspector.ducking.duckedOne', 'Ducked — {n} level keyframe, down to {db} dB.', vars)
        : t('inspector.ducking.duckedOther', 'Ducked — {n} level keyframes, down to {db} dB.', vars))
      : (one
        ? t('inspector.ducking.reduckedOne', 'Re-ducked — {n} level keyframe, down to {db} dB.', vars)
        : t('inspector.ducking.reduckedOther', 'Re-ducked — {n} level keyframes, down to {db} dB.', vars));
    useUIStore.getState().notify(
      result.error
        ? { level: 'warning', message: result.error, durationMs: 5000 }
        : { level: 'success', message, durationMs: 4000 },
    );
    if (!result.error) onDone();
  };

  const run = async (fn: () => Promise<ApplyDuckingResult>, verb: 'ducked' | 'reducked'): Promise<void> => {
    setBusy(true);
    try {
      report(await fn(), verb);
    } finally {
      setBusy(false);
    }
  };
  useDialogPrimaryAction(busy || !voiceNodeId ? null : () => void run(() => duckEdit(nodeId, voiceNodeId, params), 'ducked'));

  const drop = async (): Promise<void> => {
    setBusy(true);
    try {
      const ok = await removeDuckingEdit(nodeId);
      useUIStore.getState().notify({
        level: ok ? 'success' : 'warning',
        message: ok ? t('inspector.ducking.removed', 'Ducking removed, level track cleared.') : t('inspector.ducking.nothingToRemove', 'This layer has no ducking to remove.'),
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
        {t('inspector.ducking.intro', 'Writes level keyframes on this layer that pull it down whenever the sidechain layer is above the threshold. Preview and export read the same track.')}
      </p>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.ducking.sidechain', 'Sidechain')}</span>
        <div className={styles.control}>
          <select
            className={styles.select}
            value={voiceNodeId}
            onChange={(e) => setVoiceNodeId(e.target.value)}
            aria-label={t('inspector.ducking.sidechainLayer', 'Sidechain layer')}
          >
            {sources.length === 0 ? <option value="">{t('inspector.ducking.noOtherLayer', 'No other layer has sound')}</option> : null}
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.ducking.duckBy', 'Duck by')}</span>
        <div className={styles.control}>
          <Slider
            value={params.duckDb}
            min={-40}
            max={0}
            step={1}
            onChange={(v) => set('duckDb', v)}
            aria-label={t('inspector.ducking.duckAmount', 'Duck amount')}
          />
          <span className={styles.value}>{params.duckDb} dB</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.ducking.threshold', 'Threshold')}</span>
        <div className={styles.control}>
          <Slider
            value={params.thresholdDb}
            min={-60}
            max={-5}
            step={1}
            onChange={(v) => set('thresholdDb', v)}
            aria-label={t('inspector.ducking.sidechainThreshold', 'Sidechain threshold')}
          />
          <span className={styles.value}>{params.thresholdDb} dB</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.ducking.attack', 'Attack')}</span>
        <div className={styles.control}>
          <Slider
            value={params.attackMs}
            min={0}
            max={1000}
            step={10}
            onChange={(v) => set('attackMs', v)}
            aria-label={t('inspector.ducking.attack', 'Attack')}
          />
          <span className={styles.value}>{params.attackMs} ms</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.ducking.release', 'Release')}</span>
        <div className={styles.control}>
          <Slider
            value={params.releaseMs}
            min={0}
            max={3000}
            step={50}
            onChange={(v) => set('releaseMs', v)}
            aria-label={t('inspector.ducking.release', 'Release')}
          />
          <span className={styles.value}>{params.releaseMs} ms</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.ducking.hold', 'Hold')}</span>
        <div className={styles.control}>
          <Slider
            value={params.holdMs}
            min={0}
            max={2000}
            step={50}
            onChange={(v) => set('holdMs', v)}
            aria-label={t('inspector.ducking.hold', 'Hold')}
          />
          <span className={styles.value}>{params.holdMs} ms</span>
        </div>
      </div>

      <div className={styles.readout} role="status">
        {!voiceNodeId ? (
          <span className={styles.warn}>{t('inspector.ducking.nothingToDuck', 'Nothing to duck under — this comp has only one layer with sound.')}</span>
        ) : analysing ? (
          <span>{t('inspector.ducking.analysing', 'Analysing the sidechain…')}</span>
        ) : !preview ? (
          <span className={styles.warn}>{t('inspector.ducking.notDecoded', 'That layer’s audio has not decoded, or is silent here.')}</span>
        ) : preview.peakDb === 0 ? (
          <span>{t('inspector.ducking.neverCrosses', 'Never crosses the threshold — nothing would duck. Try a lower threshold.')}</span>
        ) : (
          <>
            <span>
              {preview.keyframes === 1
                ? t('inspector.ducking.willWriteOne', 'Will write {n} level keyframe, down to {db} dB', { n: preview.keyframes, db: preview.peakDb })
                : t('inspector.ducking.willWriteOther', 'Will write {n} level keyframes, down to {db} dB', { n: preview.keyframes, db: preview.peakDb })}
            </span>
            <span className={styles.readoutNote}>{t('inspector.ducking.workAreaNote', 'Over the work area, or the whole comp when none is set.')}</span>
          </>
        )}
      </div>

      <div className={styles.actionsSplit}>
        <div className={styles.actionsLeft}>
          {stored ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => reduckEdit(nodeId), 'reducked')}>
                {t('inspector.ducking.reduck', 'Re-duck')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void drop()}>
                {t('inspector.ducking.remove', 'Remove')}
              </Button>
            </>
          ) : null}
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>
            {t('inspector.ducking.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={busy || !voiceNodeId}
            onClick={() => void run(() => duckEdit(nodeId, voiceNodeId, params), 'ducked')}
          >
            {busy ? t('inspector.ducking.applying', 'Applying…') : t('inspector.ducking.apply', 'Apply')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Open the dialog for a layer. Also the shape the command calls. */
export function openDuckingDialog(nodeId: string): void {
  openModal({
    title: t('inspector.ducking.title', 'Duck under voice'),
    size: 'sm',
    render: (close) => <DuckingDialog nodeId={nodeId} onDone={close} />,
  });
}

setAudioToolOpener('ducking', openDuckingDialog);

export default DuckingDialog;
