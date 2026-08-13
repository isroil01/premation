/**
 * Audio Effects — the inspector surface for a layer's audio chain.
 *
 * Writes the chain that `readAudioEffects` reads and that BOTH the live engine
 * and the offline mixdown build from. That round trip is the point: without a
 * writer this would be unreachable code, which is the "composed but unexecuted"
 * failure this repo has shipped before — tests green, feature absent.
 *
 * Parameters are plain numbers by design. `audioParams.ts` reserves the ramp
 * seam for them ("audio-effect parameters are the same shape and should reuse
 * `buildParamRamp`"), so keeping them numeric is what will let them keyframe
 * without a second scheduling path. They are static for now; the keyframe
 * button belongs with that work, not ahead of it.
 */

import { ValueField } from '@components/ValueField';
import { Switch } from '@components/Switch';
import { useSceneRevision, bumpScene } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import {
  AUDIO_EFFECT_DEFS,
  AUDIO_EFFECTS_PROP,
  OSC_WAVES,
  WAVE_EFFECTS,
  readAudioEffects,
  type AudioEffect,
  type AudioEffectType,
} from '@core/audio/audioEffects';
import { shortId } from '@utils/lang';
import styles from './ParentControl.module.css';
import ta from './TextAnimatorControls.module.css';

const TYPES = Object.keys(AUDIO_EFFECT_DEFS) as AudioEffectType[];

/** Read → transform → write the whole chain. The props object is shared with
 *  the stored document, so an in-place mutation would not be seen. */
function writeChain(nodeId: string, next: AudioEffect[]): void {
  const node = defaultSceneGraph.getNode(nodeId);
  const fx = node?.components.find((c) => c.type === 'fx');
  if (!fx) return;
  defaultSceneGraph.writeProp(nodeId, fx.id, AUDIO_EFFECTS_PROP, next);
  bumpScene();
}

export function AudioEffectsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  // An `fx` component is where the chain lives; without one there is nowhere to
  // write, so the section would be a control that cannot take effect.
  if (!node.components.some((c) => c.type === 'fx')) return null;

  const chain = readAudioEffects(node) ?? [];

  const add = (type: AudioEffectType): void => {
    const params: Record<string, number> = {};
    for (const p of AUDIO_EFFECT_DEFS[type].params) params[p.key] = p.default;
    writeChain(nodeId, [...chain, { id: shortId('afx'), type, params }]);
  };
  const update = (id: string, patch: Partial<AudioEffect>): void =>
    writeChain(nodeId, chain.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const setParam = (id: string, key: string, v: number): void =>
    writeChain(nodeId, chain.map((e) => (e.id === id ? { ...e, params: { ...e.params, [key]: v } } : e)));
  const remove = (id: string): void => writeChain(nodeId, chain.filter((e) => e.id !== id));
  const move = (id: string, delta: number): void => {
    // Order is audible: an EQ before a delay colours the echoes too, after it
    // colours only the dry signal.
    const i = chain.findIndex((e) => e.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= chain.length) return;
    const next = [...chain];
    [next[i], next[j]] = [next[j]!, next[i]!];
    writeChain(nodeId, next);
  };

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>Audio Effects</span>
        <select
          className={styles.select}
          style={{ width: 140, fontSize: 'var(--font-size-xs)' }}
          value=""
          onChange={(e) => { if (e.currentTarget.value) add(e.currentTarget.value as AudioEffectType); }}
          aria-label="Add audio effect"
        >
          <option value="">Add effect…</option>
          {TYPES.map((t) => <option key={t} value={t}>{AUDIO_EFFECT_DEFS[t].label}</option>)}
        </select>
      </div>

      {chain.length === 0 && (
        <p style={{ margin: '2px 0 6px', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          Effects apply before the layer level, in order, and are included in exported audio.
        </p>
      )}

      {chain.map((e, i) => (
        <div key={e.id} style={{ marginBottom: 6 }}>
          <div className={styles.row}>
            <span className={styles.label} style={{ color: 'var(--color-text-secondary)' }}>
              {AUDIO_EFFECT_DEFS[e.type].label}
            </span>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <Switch
                checked={e.enabled !== false}
                onChange={(ev) => update(e.id, { enabled: ev.currentTarget.checked })}
                aria-label={`Enable ${AUDIO_EFFECT_DEFS[e.type].label}`}
              />
              <button type="button" className={styles.select} style={{ width: 'auto', padding: '0 6px' }}
                disabled={i === 0} onClick={() => move(e.id, -1)} aria-label="Move effect up">↑</button>
              <button type="button" className={styles.select} style={{ width: 'auto', padding: '0 6px' }}
                disabled={i === chain.length - 1} onClick={() => move(e.id, 1)} aria-label="Move effect down">↓</button>
              <button type="button" className={styles.select} style={{ width: 'auto', padding: '0 6px' }}
                onClick={() => remove(e.id)} aria-label={`Remove ${AUDIO_EFFECT_DEFS[e.type].label}`}>✕</button>
            </span>
          </div>

          {e.type === 'high-low-pass' && (
            <div className={ta.paramRow}>
              <div />
              <span className={ta.paramLabel}>Mode</span>
              <select
                className={styles.select}
                value={e.mode ?? 'highpass'}
                onChange={(ev) => update(e.id, { mode: ev.currentTarget.value as 'highpass' | 'lowpass' })}
                aria-label="Filter mode"
              >
                <option value="highpass">High Pass</option>
                <option value="lowpass">Low Pass</option>
              </select>
            </div>
          )}

          {/*
            Waveform, for the three effects that carry an oscillator.

            Gated on `WAVE_EFFECTS` — the SAME set the graph builder reads —
            rather than on a list repeated here. A control offered for an effect
            that ignores `wave` would be a setting that persists, keyframes
            nothing, and changes no sound: the exact dead-control shape this
            repo has now found five times.

            Discrete like Mode above, and for the same reason: half a sine and
            half a square is not a waveform, so there is nothing to interpolate.
          */}
          {WAVE_EFFECTS.has(e.type) && (
            <div className={ta.paramRow}>
              <div />
              <span className={ta.paramLabel}>Waveform</span>
              <select
                className={styles.select}
                value={e.wave ?? 'sine'}
                onChange={(ev) => update(e.id, { wave: ev.currentTarget.value as OscillatorType })}
                aria-label={`${AUDIO_EFFECT_DEFS[e.type].label} waveform`}
              >
                {OSC_WAVES.map((w) => (
                  <option key={w} value={w}>{w[0]!.toUpperCase() + w.slice(1)}</option>
                ))}
              </select>
            </div>
          )}

          {AUDIO_EFFECT_DEFS[e.type].params.map((p) => (
            <div className={ta.paramRow} key={p.key}>
              <div />
              <span className={ta.paramLabel}>{p.label}</span>
              <ValueField
                value={e.params?.[p.key] ?? p.default}
                onChange={(v) => setParam(e.id, p.key, v)}
                unit={p.unit}
                min={p.min}
                max={p.max}
                precision={2}
                aria-label={`${AUDIO_EFFECT_DEFS[e.type].label} ${p.label}`}
              />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

export default AudioEffectsSection;
