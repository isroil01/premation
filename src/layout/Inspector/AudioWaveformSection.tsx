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
import { Button } from '@components/Button';
import { cn } from '@utils/cn';
import type { LayerInfo } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys } from '@hooks/useMirror';
import { useMirrorJson } from '@hooks/useMirrorFields';
import { compLayersDeep } from '@core/mirror/layerFields';
import { normalizeAudioWaveform, defaultAudioWaveform, type AudioWaveformConfig } from '@core/mirror/audioWaveform';
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
  // Normalised exactly as the engine's generator reads it.
  const cfg = raw === undefined ? null : normalizeAudioWaveform(raw);
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
      {/* The section ("Audio waveform") already names this block; what it
          draws is the Source row's tooltip, not a paragraph in the list. */}
      <div className={styles.inlineRows}>
        <div className={styles.popoverRow}>
          <span
            className={styles.popoverLabel}
            title="Draws the amplitude envelope of an audio layer (not a frequency spectrum), from the source's precomputed peaks — deterministic, so scrubbing is stable. Nothing draws until the audio has decoded."
          >
            Source
          </span>
          <select
            className={cn(styles.select, styles.rowSelect)}
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
          <p className={styles.helpWarning} role="note">No audio layers in this scene — import an audio file first.</p>
        )}
        {sourceMissing && (
          <p className={styles.helpWarning} role="note">The linked audio layer no longer exists — pick another source.</p>
        )}

        <div className={styles.popoverRow}>
          <span className={styles.popoverLabel}>Display</span>
          <select
            className={cn(styles.select, styles.rowSelect)}
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

        <div className={styles.actionRow}>
          <Button size="sm" variant="secondary" onClick={() => { void edit('Remove Audio Waveform', audioWaveformCommands(nodeId, null)); }}>
            Remove Audio Waveform
          </Button>
        </div>
      </div>
    </div>
  );
}

export { defaultAudioWaveform };
export default AudioWaveformSection;
