/**
 * AudioWaveformSection — inspector controls for a shape layer's Audio Waveform
 * generator (fx.audioWaveform block). This is a waveform ENVELOPE visualizer —
 * it draws the amplitude outline of a referenced audio layer, NOT an FFT /
 * frequency spectrum. Labelled as such so it isn't mistaken for a spectrum.
 *
 * The whole config is one json field, `layer/audioWaveform`: each edit sends
 * the current config with one key changed (audioEdits.ts) — one undo entry per
 * pick / typed value, one per scrub. Only rendered when the layer carries the
 * block (see ShapeEffects, which also owns the "+ Add" entry point).
 */

import { ValueField } from '@components/ValueField';
import type { LayerInfo } from '@motion/engine-api';
import type { SceneNode } from '@core/types';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys } from '@hooks/useMirror';
import { useMirrorJson } from '@hooks/useMirrorFields';
import { compLayersDeep } from '@core/mirror/layerFields';
import {
  AUDIO_WAVEFORM_FX_KEY,
  readNodeAudioWaveform,
  defaultAudioWaveform,
  type AudioWaveformConfig,
} from '@core/audio/audioWaveformGen';
import { edit } from '@core/engine/uiEdits';
import { useEngineEdit } from './useEngineEdit';
import { audioWaveformCommands } from './audioEdits';
import styles from './TransformSection.module.css';

/**
 * Every audio layer of every composition (the source list), from the mirror.
 * Re-renders when a comp's stack, the layer set or a listed layer's header (a
 * rename) changes.
 */
function useAudioLayers(): LayerInfo[] {
  const m = documentMirror();
  const list = m.compIds.flatMap((c) => compLayersDeep(m, c)).filter((l) => l.kind === 'audio');
  useMirrorKeys(['comps', 'layers', ...m.compIds.map((c) => `order:${c}`), ...list.map((l) => `layer:${l.id}`)]);
  return list;
}

export function AudioWaveformSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  // `layer/audioWaveform` — the fx block, raw json (null when the layer has none).
  const raw = useMirrorJson<unknown>(nodeId, 'layer/audioWaveform');
  // Honest source list: only real audio-kind layers.
  const audioLayers = useAudioLayers();
  const eng = useEngineEdit();
  // Normalised exactly as the generator normalises it — a pure use of
  // `readNodeAudioWaveform` over the mirror's value (it reads only `components`).
  const cfg = raw === undefined
    ? null
    : readNodeAudioWaveform({ components: [{ type: 'fx', props: { [AUDIO_WAVEFORM_FX_KEY]: raw } }] } as unknown as SceneNode);
  if (!cfg) return null;

  // The whole config with one key changed (absolute: a scrub's every message
  // carries the full value). One entry per pick / typed value, or the scrub's.
  const set = <K extends keyof AudioWaveformConfig>(key: K, value: AudioWaveformConfig[K]): void => {
    eng.send('Edit Audio Waveform', audioWaveformCommands(nodeId, { ...cfg, [key]: value }));
  };
  const scrub = eng.scrub('Edit Audio Waveform');

  const sourceMissing = cfg.sourceLayerId !== '' && !audioLayers.some((n) => n.id === cfg.sourceLayerId);

  return (
    <div className={styles.section}>
      <h4 className={styles.title}>Audio Waveform</h4>
      <div className={styles.inlineRows}>
        <p style={{ margin: '0 0 4px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          Draws the amplitude <strong>envelope</strong> of an audio layer (not a frequency spectrum).
        </p>

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Source</span>
          <select
            className={styles.select}
            style={{ width: 130 }}
            value={cfg.sourceLayerId}
            onChange={(e) => set('sourceLayerId', e.target.value)}
            aria-label="Source audio layer"
          >
            <option value="">— Select audio —</option>
            {audioLayers.map((n) => (
              <option key={n.id} value={n.id}>{n.name ?? n.id}</option>
            ))}
          </select>
        </div>

        {audioLayers.length === 0 && (
          <p style={{ margin: '2px 0 4px', fontSize: 'var(--font-size-micro)', color: '#ffb703', lineHeight: 1.5 }}>
            No audio layers in this scene — import an audio file first.
          </p>
        )}
        {sourceMissing && (
          <p style={{ margin: '2px 0 4px', fontSize: 'var(--font-size-micro)', color: '#ffb703', lineHeight: 1.5 }}>
            The linked audio layer no longer exists — pick another source.
          </p>
        )}

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Display</span>
          <select
            className={styles.select}
            style={{ width: 130 }}
            value={cfg.mode}
            onChange={(e) => set('mode', e.target.value as AudioWaveformConfig['mode'])}
            aria-label="Waveform display mode"
          >
            <option value="full">Full clip</option>
            <option value="playhead-window">Playhead window</option>
          </select>
        </div>

        {cfg.mode === 'playhead-window' && (
          <div className={styles.popoverRow}>
            <div style={{ width: 13 }} />
            <span className={styles.popoverLabel}>Window</span>
            <ValueField {...scrub} value={cfg.windowSec} unit="s" min={0} precision={2} onChange={(v) => set('windowSec', Number(v))} aria-label="Window seconds" />
          </div>
        )}

        <div className={styles.popoverRow}>
          <div style={{ width: 13 }} />
          <span className={styles.popoverLabel}>Height</span>
          <ValueField {...scrub} value={cfg.heightScale} min={0} precision={2} onChange={(v) => set('heightScale', Number(v))} aria-label="Height scale" />
        </div>
        <div className={styles.popoverRow}>
          <div style={{ width: 13 }} />
          <span className={styles.popoverLabel}>Thickness</span>
          <ValueField {...scrub} value={cfg.thickness} unit="px" min={0} onChange={(v) => set('thickness', Number(v))} aria-label="Thickness" />
        </div>
        <div className={styles.popoverRow}>
          <div style={{ width: 13 }} />
          <span className={styles.popoverLabel}>Samples</span>
          <ValueField {...scrub} value={cfg.samples} min={2} onChange={(v) => set('samples', Math.max(2, Math.floor(Number(v))))} aria-label="Samples" />
        </div>

        <button
          type="button"
          onClick={() => { void edit('Remove Audio Waveform', audioWaveformCommands(nodeId, null)); }}
          style={{
            marginTop: 6, height: 22, padding: '0 10px', fontSize: 'var(--font-size-micro)', fontWeight: 600,
            background: 'var(--color-surface-3)', color: 'var(--color-text-secondary)',
            border: '1px solid var(--color-border)', borderRadius: 4, cursor: 'pointer', alignSelf: 'flex-start',
          }}
        >
          Remove Audio Waveform
        </button>

        <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          Deterministic — driven by the source's precomputed peaks; scrubbing is stable. Nothing draws until the audio has decoded.
        </p>
      </div>
    </div>
  );
}

export { defaultAudioWaveform };
export default AudioWaveformSection;
