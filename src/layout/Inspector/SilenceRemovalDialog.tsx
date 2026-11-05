/**
 * Remove Silence — the dialog.
 *
 * Three numbers and a sentence. The sentence is the whole design: this edit
 * deletes material and closes gaps across two layers at once, and there is no
 * way to judge a threshold in dBFS by looking at it. So the readout says what
 * WILL happen — how many gaps, how many seconds, across how many layers —
 * recomputed by the same detector the Apply runs, so it cannot be optimistic
 * about anything: the engine's audioAnalysis job — the readout is its summary
 * (debounced), and Apply is the same job with `removeSilence`. The page never
 * decodes.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { useDialogPrimaryAction } from '@components/Modal';
import { Slider } from '@components/Slider';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import { useMirrorLayers, useMirrorSelect } from '@hooks/useMirror';
import { pairedSoundLayersIn } from '@core/mirror/audio';
import { setAudioToolOpener } from './audioCommands';
import { totalSilenceSec, DEFAULT_SILENCE_OPTIONS, type SilenceRange } from '@core/audio/silenceRemoval';
import { previewEngineJob, runEngineJob } from '@core/engine/engineJobs';
import { t } from '@core/i18n';
import styles from './AudioToolDialog.module.css';

interface Props {
  nodeId: string;
  onDone: () => void;
}

interface EngineSilence {
  silence?: { ranges: SilenceRange[]; gaps: number; secondsRemoved: number };
}

const silenceJob = (nodeId: string, o: { thresholdDb: number; minSilenceMs: number; paddingMs: number }, remove: boolean) => ({
  kind: 'audioAnalysis' as const,
  value: {
    layer: nodeId, beats: false, amplitudeKeyframes: false, silence: true, removeSilence: remove, beatMarkers: false,
    silenceThresholdDb: o.thresholdDb, silenceMinMs: o.minSilenceMs, silencePaddingMs: o.paddingMs,
  },
});

/**
 * The engine's detector, debounced: `undefined` while unknown, `null` when the
 * engine does not run the job (or the audio could not be analysed), else its ranges.
 */
function useEngineSilences(nodeId: string, o: { thresholdDb: number; minSilenceMs: number; paddingMs: number }): SilenceRange[] | null | undefined {
  const [state, setState] = useState<SilenceRange[] | null | undefined>(undefined);
  const key = `${nodeId}|${o.thresholdDb}|${o.minSilenceMs}|${o.paddingMs}`;
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void previewEngineJob<EngineSilence>(silenceJob(nodeId, o, false))
        .then((out) => {
          if (!alive) return;
          setState(out && out.status === 'done' ? out.result?.silence?.ranges ?? [] : null);
        })
        .catch(() => { if (alive) setState(null); });
    }, 250);
    return (): void => {
      alive = false;
      clearTimeout(timer);
    };
    // `key` carries every input.
  }, [key]);  // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** "Removed 3 gaps (1.20s) from 2 layers." — whole sentences per plural form. */
function removedMessage(gaps: number, sec: string, layers: number): string {
  const vars = { gaps, sec, layers };
  if (gaps === 1) {
    return layers === 1
      ? t('inspector.silenceRemoval.removedOneOne', 'Removed {gaps} gap ({sec}s) from {layers} layer.', vars)
      : t('inspector.silenceRemoval.removedOneOther', 'Removed {gaps} gap ({sec}s) from {layers} layers.', vars);
  }
  return layers === 1
    ? t('inspector.silenceRemoval.removedOtherOne', 'Removed {gaps} gaps ({sec}s) from {layers} layer.', vars)
    : t('inspector.silenceRemoval.removedOtherOther', 'Removed {gaps} gaps ({sec}s) from {layers} layers.', vars);
}

export function SilenceRemovalDialog({ nodeId, onDone }: Props): JSX.Element {
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_SILENCE_OPTIONS.thresholdDb);
  const [minSilenceMs, setMinSilenceMs] = useState(DEFAULT_SILENCE_OPTIONS.minSilenceMs);
  const [paddingMs, setPaddingMs] = useState(DEFAULT_SILENCE_OPTIONS.paddingMs);
  const [busy, setBusy] = useState(false);

  const engineRanges = useEngineSilences(nodeId, { thresholdDb, minSilenceMs, paddingMs });
  const loading = engineRanges === undefined;

  // Every layer the cut will touch — named, because "this also cuts your video
  // bar" is not something to discover after pressing Apply.
  // From the document mirror (B4): the same file in the same composition.
  const layerIds = useMirrorSelect(['layers'], (m) => m.layerIds());
  const headers = useMirrorLayers(layerIds);
  const paired = useMemo(() => pairedSoundLayersIn(headers, nodeId), [nodeId, headers]);
  const pairedNames = useMemo(
    () => paired.map((id) => headers.find((l) => l?.id === id)?.name || id),
    [paired, headers],
  );

  const ranges: SilenceRange[] = useMemo(() => engineRanges ?? [], [engineRanges]);
  const total = totalSilenceSec(ranges);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const out = await runEngineJob<EngineSilence>(silenceJob(nodeId, { thresholdDb, minSilenceMs, paddingMs }, true));
      const result: { gaps: number; secondsRemoved: number; error?: string } = !out
        ? { gaps: 0, secondsRemoved: 0, error: t('inspector.silenceRemoval.noEngine', 'Silence removal runs in the engine, and this engine does not run it.') }
        : out.status === 'done'
          ? { gaps: out.result?.silence?.gaps ?? 0, secondsRemoved: out.result?.silence?.secondsRemoved ?? 0 }
          : { gaps: 0, secondsRemoved: 0, error: out.error?.message ?? t('inspector.silenceRemoval.failed', 'The silences could not be removed.') };
      useUIStore.getState().notify(
        result.error
          ? { level: 'warning', message: result.error, durationMs: 5000 }
          : {
              level: 'success',
              message: removedMessage(result.gaps, result.secondsRemoved.toFixed(2), paired.length),
              durationMs: 4000,
            },
      );
      if (!result.error) onDone();
    } finally {
      setBusy(false);
    }
  };
  useDialogPrimaryAction(busy || ranges.length === 0 ? null : () => void apply());

  return (
    <div className={styles.body}>
      <p className={styles.intro}>
        {t('inspector.silenceRemoval.intro', 'Finds stretches quieter than the threshold, cuts them out and closes the gap.')}
        {paired.length > 1 ? ` ${t('inspector.silenceRemoval.paired', 'Applies to {names} together — they share a source file.', { names: pairedNames.join(t('inspector.silenceRemoval.and', ' and ')) })}` : null}
      </p>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.silenceRemoval.threshold', 'Threshold')}</span>
        <div className={styles.control}>
          <Slider
            value={thresholdDb}
            min={-70}
            max={-10}
            step={1}
            onChange={setThresholdDb}
            aria-label={t('inspector.silenceRemoval.thresholdLabel', 'Silence threshold')}
          />
          <span className={styles.value}>{thresholdDb} dB</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.silenceRemoval.minSilence', 'Min silence')}</span>
        <div className={styles.control}>
          <Slider
            value={minSilenceMs}
            min={50}
            max={3000}
            step={50}
            onChange={setMinSilenceMs}
            aria-label={t('inspector.silenceRemoval.minSilenceLabel', 'Minimum silence')}
          />
          <span className={styles.value}>{minSilenceMs} ms</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t('inspector.silenceRemoval.padding', 'Padding')}</span>
        <div className={styles.control}>
          <Slider
            value={paddingMs}
            min={0}
            max={500}
            step={10}
            onChange={setPaddingMs}
            aria-label={t('inspector.silenceRemoval.paddingLabel', 'Padding kept at each end')}
          />
          <span className={styles.value}>{paddingMs} ms</span>
        </div>
      </div>

      <div className={styles.readout} role="status">
        {loading ? (
          <span>{t('inspector.silenceRemoval.analysing', 'Analysing audio…')}</span>
) : engineRanges === null ? (
          <span className={styles.warn}>{t('inspector.silenceRemoval.notAnalysed', 'This layer’s audio could not be analysed.')}</span>
        ) : ranges.length === 0 ? (
          <span>{t('inspector.silenceRemoval.nothing', 'Nothing quiet enough, or long enough, to remove.')}</span>
        ) : (
          <>
            <span>
              {ranges.length === 1
                ? t('inspector.silenceRemoval.willRemoveOne', 'Will remove {n} gap totalling {sec} s', { n: ranges.length, sec: total.toFixed(2) })
                : t('inspector.silenceRemoval.willRemoveOther', 'Will remove {n} gaps totalling {sec} s', { n: ranges.length, sec: total.toFixed(2) })}
            </span>
            <span className={styles.readoutNote}>
              {paired.length > 1
                ? t('inspector.silenceRemoval.keepingAcross', 'Keeping {ms} ms at each end, across {n} layers.', { ms: paddingMs, n: paired.length })
                : t('inspector.silenceRemoval.keeping', 'Keeping {ms} ms at each end.', { ms: paddingMs })}
            </span>
          </>
        )}
      </div>

      <div className={styles.actions}>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>
          {t('inspector.silenceRemoval.cancel', 'Cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={busy || ranges.length === 0}
          onClick={() => void apply()}
        >
          {busy ? t('inspector.silenceRemoval.removing', 'Removing…') : t('inspector.silenceRemoval.apply', 'Apply')}
        </Button>
      </div>
    </div>
  );
}

/** Open the dialog for a layer. Also the shape the command calls. */
export function openSilenceRemovalDialog(nodeId: string): void {
  openModal({
    title: t('inspector.silenceRemoval.title', 'Remove silence'),
    size: 'sm',
    render: (close) => <SilenceRemovalDialog nodeId={nodeId} onDone={close} />,
  });
}

setAudioToolOpener('silence', openSilenceRemovalDialog);

export default SilenceRemovalDialog;
