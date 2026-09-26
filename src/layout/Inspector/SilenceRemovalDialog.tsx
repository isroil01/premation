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
 *
 * With an engine that runs jobs (the C++ engine as owner) the detector is the
 * engine's audioAnalysis job: the readout is its summary (debounced), and
 * Apply is the same job with `removeSilence` — the page never decodes.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@components/Button';
import { Slider } from '@components/Slider';
import { openModal } from '@stores/modalStore';
import { useUIStore } from '@stores/uiStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorLayers, useMirrorSelect } from '@hooks/useMirror';
import { pairedSoundLayersIn, soundLayers } from '@core/mirror/audio';
import { setAudioToolOpener } from '@core/audio/audioCommands';
import {
  detectSilences,
  loadNodeMono,
  totalSilenceSec,
  DEFAULT_SILENCE_OPTIONS,
  type SilenceRange,
} from '@core/audio/silenceRemoval';
import { removeSilencesEdit } from './audioEdits';
import { previewEngineJob, runEngineJob } from '@core/engine/engineJobs';
import styles from './AudioToolDialog.module.css';

interface Props {
  nodeId: string;
  onDone: () => void;
}

/** Samples, once, for the life of the dialog (`enabled` false: the engine analyses, nothing is decoded here). */
function useSource(nodeId: string, enabled: boolean): {
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
    if (!enabled) {
      setState({ samples: null, sampleRate: 0, loading: false });
      return;
    }
    // Asked synchronously first: a layer with no sound is knowable without a
    // decode, and starting one only to throw it away is both a wasted round
    // trip and a "Decoding audio…" flash that resolves into "no audio".
    // (The mirror: an audio or video layer with a source file.)
    if (!soundLayers(documentMirror()).some((s) => s.id === nodeId)) {
      setState({ samples: null, sampleRate: 0, loading: false });
      return;
    }
    setState({ samples: null, sampleRate: 0, loading: true });
    // Engine-side until E2: the decode (the editor's audio engine).
    void loadNodeMono(nodeId).then((src) => {
      if (!alive) return;
      setState({ samples: src?.samples ?? null, sampleRate: src?.sampleRate ?? 0, loading: false });
    });
    return (): void => {
      alive = false;
    };
  }, [nodeId, enabled]);
  return state;
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
 * engine does not run jobs (the page path), else its ranges.
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
          if (!out) setState(null);
          else setState(out.status === 'done' ? out.result?.silence?.ranges ?? [] : []);
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

export function SilenceRemovalDialog({ nodeId, onDone }: Props): JSX.Element {
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_SILENCE_OPTIONS.thresholdDb);
  const [minSilenceMs, setMinSilenceMs] = useState(DEFAULT_SILENCE_OPTIONS.minSilenceMs);
  const [paddingMs, setPaddingMs] = useState(DEFAULT_SILENCE_OPTIONS.paddingMs);
  const [busy, setBusy] = useState(false);

  const engineRanges = useEngineSilences(nodeId, { thresholdDb, minSilenceMs, paddingMs });
  const viaEngine = engineRanges !== null;
  const { samples, sampleRate, loading: pageLoading } = useSource(nodeId, !viaEngine);
  const loading = engineRanges === undefined || pageLoading;

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

  const ranges: SilenceRange[] = useMemo(
    () => engineRanges ?? (samples ? detectSilences(samples, sampleRate, { thresholdDb, minSilenceMs, paddingMs }) : []),
    [engineRanges, samples, sampleRate, thresholdDb, minSilenceMs, paddingMs],
  );
  const total = totalSilenceSec(ranges);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      let result: Awaited<ReturnType<typeof removeSilencesEdit>>;
      const out = viaEngine ? await runEngineJob<EngineSilence>(silenceJob(nodeId, { thresholdDb, minSilenceMs, paddingMs }, true)) : null;
      if (out) {
        result = out.status === 'done'
          ? { gaps: out.result?.silence?.gaps ?? 0, secondsRemoved: out.result?.silence?.secondsRemoved ?? 0, clipsDeleted: 0 }
          : { gaps: 0, secondsRemoved: 0, clipsDeleted: 0, error: out.error?.message ?? 'The silences could not be removed.' };
      } else {
        result = await removeSilencesEdit(paired, ranges);
      }
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
