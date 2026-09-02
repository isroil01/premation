/**
 * Remove Silence — the dialog.
 *
 * Three numbers and a sentence. The sentence is the whole design: this edit
 * deletes material and closes gaps across two layers at once, and there is no
 * way to judge a threshold in dBFS by looking at it. So the readout says what
 * WILL happen — how many gaps, how many seconds, across how many layers —
 * recomputed from the same `detectSilences` the Apply runs, so it cannot be
 * optimistic about anything.
 *
 * The decode happens once when the dialog opens; the three sliders then only
 * re-run the detector, which is milliseconds on samples already in memory. That
 * is why the parameters can be live rather than behind a "Preview" button.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { Slider } from '@components/Slider';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setAudioToolOpener } from '@core/audio/audioCommands';
import {
  audioVoiceFor,
  detectSilences,
  loadNodeMono,
  pairedAudioNodeIds,
  removeSilences,
  totalSilenceSec,
  DEFAULT_SILENCE_OPTIONS,
  type SilenceRange,
} from '@core/audio/silenceRemoval';
import styles from './AudioToolDialog.module.css';

interface Props {
  nodeId: string;
  onDone: () => void;
}

/** Samples, once, for the life of the dialog. */
function useSource(nodeId: string): {
  samples: Float32Array | null;
  sampleRate: number;
  loading: boolean;
} {
  const [state, setState] = useState<{ samples: Float32Array | null; sampleRate: number; loading: boolean }>({
    samples: null,
    sampleRate: 0,
    loading: true,
  });
  useEffect(() => {
    let alive = true;
    // Asked synchronously first: a layer with no sound is knowable without a
    // decode, and starting one only to throw it away is both a wasted round
    // trip and a "Decoding audio…" flash that resolves into "no audio".
    if (!audioVoiceFor(nodeId)) {
      setState({ samples: null, sampleRate: 0, loading: false });
      return;
    }
    setState({ samples: null, sampleRate: 0, loading: true });
    void loadNodeMono(nodeId).then((src) => {
      if (!alive) return;
      setState({ samples: src?.samples ?? null, sampleRate: src?.sampleRate ?? 0, loading: false });
    });
    return (): void => {
      alive = false;
    };
  }, [nodeId]);
  return state;
}

export function SilenceRemovalDialog({ nodeId, onDone }: Props): JSX.Element {
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_SILENCE_OPTIONS.thresholdDb);
  const [minSilenceMs, setMinSilenceMs] = useState(DEFAULT_SILENCE_OPTIONS.minSilenceMs);
  const [paddingMs, setPaddingMs] = useState(DEFAULT_SILENCE_OPTIONS.paddingMs);
  const [busy, setBusy] = useState(false);

  const { samples, sampleRate, loading } = useSource(nodeId);

  // Every layer the cut will touch — named, because "this also cuts your video
  // bar" is not something to discover after pressing Apply.
  const paired = useMemo(() => pairedAudioNodeIds(nodeId), [nodeId]);
  const pairedNames = useMemo(
    () => paired.map((id) => defaultSceneGraph.getNode(id)?.name ?? id),
    [paired],
  );

  const ranges: SilenceRange[] = useMemo(
    () => (samples ? detectSilences(samples, sampleRate, { thresholdDb, minSilenceMs, paddingMs }) : []),
    [samples, sampleRate, thresholdDb, minSilenceMs, paddingMs],
  );
  const total = totalSilenceSec(ranges);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await removeSilences(paired, ranges);
      useUIStore.getState().notify(
        result.error
          ? { level: 'warning', message: result.error, durationMs: 5000 }
          : {
              level: 'success',
              message:
                `Removed ${result.gaps} gap${result.gaps === 1 ? '' : 's'} `
                + `(${result.secondsRemoved.toFixed(2)}s) from `
                + `${paired.length} layer${paired.length === 1 ? '' : 's'}.`,
              durationMs: 4000,
            },
      );
      if (!result.error) onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.body}>
      <p className={styles.intro}>
        Finds stretches quieter than the threshold, cuts them out and closes the gap.
        {paired.length > 1 ? ` Applies to ${pairedNames.join(' and ')} together — they share a source file.` : null}
      </p>

      <div className={styles.row}>
        <span className={styles.label}>Threshold</span>
        <div className={styles.control}>
          <Slider
            value={thresholdDb}
            min={-70}
            max={-10}
            step={1}
            onChange={setThresholdDb}
            aria-label="Silence threshold"
          />
          <span className={styles.value}>{thresholdDb} dB</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Min silence</span>
        <div className={styles.control}>
          <Slider
            value={minSilenceMs}
            min={50}
            max={3000}
            step={50}
            onChange={setMinSilenceMs}
            aria-label="Minimum silence"
          />
          <span className={styles.value}>{minSilenceMs} ms</span>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Padding</span>
        <div className={styles.control}>
          <Slider
            value={paddingMs}
            min={0}
            max={500}
            step={10}
            onChange={setPaddingMs}
            aria-label="Padding kept at each end"
          />
          <span className={styles.value}>{paddingMs} ms</span>
        </div>
      </div>

      <div className={styles.readout} role="status">
        {loading ? (
          <span>Decoding audio…</span>
        ) : !samples ? (
          <span className={styles.warn}>This layer&rsquo;s audio has not decoded — nothing to analyse.</span>
        ) : ranges.length === 0 ? (
          <span>Nothing quiet enough, or long enough, to remove.</span>
        ) : (
          <>
            <span>
              Will remove <strong>{ranges.length}</strong> gap{ranges.length === 1 ? '' : 's'} totalling{' '}
              <strong>{total.toFixed(2)}</strong> s
            </span>
            <span className={styles.readoutNote}>
              Keeping {paddingMs} ms at each end
              {paired.length > 1 ? `, across ${paired.length} layers` : ''}.
            </span>
          </>
        )}
      </div>

      <div className={styles.actions}>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={busy || ranges.length === 0}
          onClick={() => void apply()}
        >
          {busy ? 'Removing…' : 'Apply'}
        </Button>
      </div>
    </div>
  );
}

/** Open the dialog for a layer. Also the shape the command calls. */
export function openSilenceRemovalDialog(nodeId: string): void {
  openModal({
    title: 'Remove silence',
    size: 'sm',
    render: (close) => <SilenceRemovalDialog nodeId={nodeId} onDone={close} />,
  });
}

setAudioToolOpener('silence', openSilenceRemovalDialog);

export default SilenceRemovalDialog;
