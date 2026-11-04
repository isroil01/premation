/**
 * Audio Effects — the inspector surface for a layer's audio chain.
 *
 * Writes the chain that `readAudioEffects` reads and that BOTH the live engine
 * and the offline mixdown build from. That round trip is the point: without a
 * writer this would be unreachable code, which is the "composed but unexecuted"
 * failure this repo has shipped before — tests green, feature absent.
 *
 * Parameters are plain numbers by design, and each is a keyframeable property
 * of the layer (`audio/fx/<effect id>/<key>`, SDK 1.4 A2): the stopwatch keys
 * the `audiofx.<id>.<key>` track the mixer ramps. CLAP plugins' effects
 * (`clap:<id>`, PluginInfo.audio) sit in the same chain with their own params.
 */

import { ValueField } from '@components/ValueField';
import { StopwatchButton } from '@components/PropertyRow';
import { Switch } from '@components/Switch';
import { useMirrorProperty } from '@hooks/useMirror';
import { useMirrorJson } from '@hooks/useMirrorFields';
import {
  AUDIO_EFFECTS_PROP,
  AUDIO_EFFECT_DEFS,
  AUDIO_EFFECT_FLAGS,
  AUDIO_WAVEFORMS,
  DISTORTION_CURVES,
  WAVE_EFFECTS,
  hasFlag,
  isClapEffectType,
  readAudioEffects,
  type AudioEffect,
  type AudioEffectType,
  type ClapEffectType,
  type AudioWaveform,
  type DistortionCurve,
} from '@core/audio/audioEffects';
import { shortId } from '@utils/lang';
import { values } from '@core/engine/propRefs';
import { isLayer } from '@core/mirror/docFacts';
import { isTrackAnimated, readTrack } from '@core/mirror/selection';
import { pluginAudioEffects } from '@core/nativePlugins/pluginContrib';
import { documentMirror } from '@stores/documentMirror';
import { useActiveWorkspace } from '@stores/projectStore';
import { useMirrorTrackWatch } from '@hooks/useMirror';
import { scalarValueCommands, stopwatchCommands } from './inspectorEdits';
import { t } from '@core/i18n';
import { useEngineEdit, type EngineEdit } from './useEngineEdit';
import styles from './ParentControl.module.css';
import ta from './TextAnimatorControls.module.css';
import tStyles from './TransformSection.module.css';

const TYPES = Object.keys(AUDIO_EFFECT_DEFS) as AudioEffectType[];

type ParamDef = { key: string; label: string; unit?: string; min: number; max: number; default: number };

/** A chain entry's name and params: a built-in's from AUDIO_EFFECT_DEFS, a CLAP plugin's from PluginInfo.audio
 *  (a plugin that is not loaded shows no params and passes the sound through). */
function defOf(type: AudioEffectType | ClapEffectType): { label: string; params: ReadonlyArray<ParamDef> } {
  if (!isClapEffectType(type)) return AUDIO_EFFECT_DEFS[type];
  const p = pluginAudioEffects().find((x) => x.type === type);
  return p ?? { label: t('inspector.audioEffects.missingPlugin', '{name} (not installed)', { name: type.slice(5) }), params: [] };
}

/**
 * One param: a number field and its stopwatch. Animated, a write keys the playhead on
 * `audio/fx/<effect id>/<key>`; static, it rewrites the chain (one entry).
 */
function AudioParamRow({ nodeId, effectId, effectLabel, def, stored, edit, setStatic }: {
  nodeId: string;
  effectId: string;
  effectLabel: string;
  def: ParamDef;
  stored: number;
  edit: EngineEdit;
  setStatic: (v: number) => void;
}): JSX.Element {
  const time = useActiveWorkspace()?.time ?? 0;
  const path = `audio/fx/${effectId}/${def.key}`;
  useMirrorTrackWatch([nodeId], [path]);
  const m = documentMirror();
  const animated = isTrackAnimated(m, nodeId, path);
  const shown = animated ? (readTrack(m, nodeId, path, time) ?? stored) : stored;
  const name = t('inspector.audioEffects.paramOf', '{effect} {param}', { effect: effectLabel, param: def.label });
  return (
    <div className={ta.paramRow}>
      <StopwatchButton
        animated={animated}
        label={name}
        onToggle={() => edit.send(animated ? `Remove ${def.label} animation` : `Animate ${def.label}`, stopwatchCommands([nodeId], [path], time))}
      />
      <span className={ta.paramLabel}>{def.label}</span>
      <ValueField
        value={shown}
        onChange={(v) => {
          if (animated) edit.send('Audio effect parameter', scalarValueCommands(path, [{ nodeId, value: v }], { seconds: time }));
          else setStatic(v);
        }}
        {...edit.scrub('Audio effect parameter')}
        unit={def.unit}
        min={def.min}
        max={def.max}
        precision={2}
        aria-label={name}
      />
    </div>
  );
}

/**
 * Read → transform → send the whole chain: the `audio/effects` json field
 * (the fx component's `audioEffects`), one entry per action; a param
 * scrub is one gesture of absolute chains.
 */
function writeChain(e: EngineEdit, nodeId: string, label: string, next: AudioEffect[]): void {
  if (!isLayer(nodeId)) return;
  e.send(label, { type: 'setProperty', prop: { layer: nodeId, path: 'audio/effects' }, value: values.json(next) });
}

export function AudioEffectsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const fxEdit = useEngineEdit();
  // `audio/effects` exists only on a layer that carries sound; without it there
  // is nowhere to write, so the section would be a control that cannot take effect.
  const info = useMirrorProperty(nodeId, 'audio/effects');
  const raw = useMirrorJson<unknown>(nodeId, 'audio/effects');
  if (!info) return null;

  // The document's chain, validated the way the audio graph builder validates
  // it (a pure use of `readAudioEffects` over the mirror's json value).
  const chain = readAudioEffects({ components: [{ type: 'fx', props: { [AUDIO_EFFECTS_PROP]: raw } }] }) ?? [];

  const add = (type: AudioEffectType | ClapEffectType): void => {
    const params: Record<string, number> = {};
    for (const p of defOf(type).params) params[p.key] = p.default;
    writeChain(fxEdit, nodeId, 'Add audio effect', [...chain, { id: shortId('afx'), type, params }]);
  };
  const update = (id: string, patch: Partial<AudioEffect>): void =>
    writeChain(fxEdit, nodeId, 'Audio effect', chain.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const setParam = (id: string, key: string, v: number): void =>
    writeChain(fxEdit, nodeId, 'Audio effect parameter', chain.map((e) => (e.id === id ? { ...e, params: { ...e.params, [key]: v } } : e)));
  /**
   * Set or clear a boolean option.
   *
   * Clearing REMOVES the key rather than storing `false`, so an effect nobody
   * has ticked anything on carries no `flags` array at all and a document
   * round-trips byte for byte — the same rule the pan prop follows.
   */
  const setFlag = (id: string, flag: string, on: boolean): void =>
    writeChain(fxEdit, nodeId, 'Audio effect', chain.map((e) => {
      if (e.id !== id) return e;
      const next = (e.flags ?? []).filter((f) => f !== flag);
      if (on) next.push(flag);
      const { flags: _drop, ...rest } = e;
      return next.length > 0 ? { ...rest, flags: next } : rest;
    }));
  const remove = (id: string): void => writeChain(fxEdit, nodeId, 'Remove audio effect', chain.filter((e) => e.id !== id));
  const move = (id: string, delta: number): void => {
    // Order is audible: an EQ before a delay colours the echoes too, after it
    // colours only the dry signal.
    const i = chain.findIndex((e) => e.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= chain.length) return;
    const next = [...chain];
    [next[i], next[j]] = [next[j]!, next[i]!];
    writeChain(fxEdit, nodeId, 'Reorder audio effects', next);
  };

  return (
    <>
      <div className={styles.row}>
        <span
          className={styles.label}
          title={t('inspector.audioEffects.hint', 'Effects apply before the layer level, in order, and are included in exported audio.')}
        >
          {t('inspector.audioEffects.title', 'Audio Effects')}
        </span>
        <select
          className={styles.select}
          style={{ width: 140 }}
          value=""
          onChange={(e) => { if (e.currentTarget.value) add(e.currentTarget.value as AudioEffectType | ClapEffectType); }}
          aria-label={t('inspector.audioEffects.add', 'Add audio effect')}
        >
          <option value="">{t('inspector.audioEffects.addPlaceholder', 'Add effect…')}</option>
          {TYPES.map((ty) => <option key={ty} value={ty}>{AUDIO_EFFECT_DEFS[ty].label}</option>)}
          {pluginAudioEffects().length > 0 && (
            <optgroup label={t('inspector.audioEffects.pluginGroup', 'Plugins (CLAP)')}>
              {pluginAudioEffects().map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
            </optgroup>
          )}
        </select>
      </div>

      {chain.length === 0 && (
        <p className={tStyles.helpLine}>{t('inspector.audioEffects.empty', 'No audio effects. They apply before the layer level, in order, and export with the audio.')}</p>
      )}

      {chain.map((e, i) => (
        <div key={e.id} style={{ marginBottom: 6 }}>
          <div className={styles.row}>
            <span className={styles.label} style={{ color: 'var(--color-text-secondary)' }}>
              {defOf(e.type).label}
            </span>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <Switch
                checked={e.enabled !== false}
                onChange={(ev) => update(e.id, { enabled: ev.currentTarget.checked })}
                aria-label={t('inspector.audioEffects.enable', 'Enable {name}', { name: defOf(e.type).label })}
              />
              <button type="button" className={styles.select} style={{ width: 'auto', padding: '0 6px' }}
                disabled={i === 0} onClick={() => move(e.id, -1)} aria-label={t('inspector.audioEffects.moveUp', 'Move effect up')}>↑</button>
              <button type="button" className={styles.select} style={{ width: 'auto', padding: '0 6px' }}
                disabled={i === chain.length - 1} onClick={() => move(e.id, 1)} aria-label={t('inspector.audioEffects.moveDown', 'Move effect down')}>↓</button>
              <button type="button" className={styles.select} style={{ width: 'auto', padding: '0 6px' }}
                onClick={() => remove(e.id)} aria-label={t('inspector.audioEffects.remove', 'Remove {name}', { name: defOf(e.type).label })}>✕</button>
            </span>
          </div>

          {e.type === 'high-low-pass' && (
            <div className={ta.paramRow}>
              <div />
              <span className={ta.paramLabel}>{t('inspector.audioEffects.mode', 'Mode')}</span>
              <select
                className={styles.select}
                value={e.mode ?? 'highpass'}
                onChange={(ev) => update(e.id, { mode: ev.currentTarget.value as 'highpass' | 'lowpass' })}
                aria-label={t('inspector.audioEffects.filterMode', 'Filter mode')}
              >
                <option value="highpass">{t('inspector.audioEffects.highPass', 'High Pass')}</option>
                <option value="lowpass">{t('inspector.audioEffects.lowPass', 'Low Pass')}</option>
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
          {!isClapEffectType(e.type) && WAVE_EFFECTS.has(e.type) && (
            <div className={ta.paramRow}>
              <div />
              <span className={ta.paramLabel}>{t('inspector.audioEffects.waveform', 'Waveform')}</span>
              <select
                className={styles.select}
                value={e.wave ?? 'sine'}
                onChange={(ev) => update(e.id, { wave: ev.currentTarget.value as AudioWaveform })}
                aria-label={t('inspector.audioEffects.waveformOf', '{name} waveform', { name: defOf(e.type).label })}
              >
                {AUDIO_WAVEFORMS
                  // White Noise is a BUFFER, not an oscillator, so it is only
                  // offered where something can play one. An LFO set to noise
                  // would be a control that quietly fell back to a sine.
                  .filter((w) => w.value !== 'white-noise' || e.type === 'tone')
                  .map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </select>
            </div>
          )}

          {/* Distortion's character. Discrete like Mode and Waveform, and for
              the same reason: halfway between a tube and a fuzz is a third
              curve, not a blend of two. */}
          {e.type === 'distortion' && (
            <div className={ta.paramRow}>
              <div />
              <span className={ta.paramLabel}>{t('inspector.audioEffects.type', 'Type')}</span>
              <select
                className={styles.select}
                value={e.curve ?? 'soft-clip'}
                onChange={(ev) => update(e.id, { curve: ev.currentTarget.value as DistortionCurve })}
                aria-label={t('inspector.audioEffects.distortionType', 'Distortion type')}
              >
                {DISTORTION_CURVES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
          )}

          {/*
            Boolean options, rendered straight from `AUDIO_EFFECT_FLAGS` — the
            SAME table the graph builder reads. A flag cannot appear here without
            something consuming it, nor be consumed without appearing: the
            dead-control shape this file's header warns about.
          */}
          {(isClapEffectType(e.type) ? [] : AUDIO_EFFECT_FLAGS[e.type] ?? []).map((f) => (
            <div className={ta.paramRow} key={f.key}>
              <div />
              <span className={ta.paramLabel} title={f.hint}>{f.label}</span>
              <Switch
                checked={hasFlag(e, f.key)}
                onChange={(ev) => setFlag(e.id, f.key, ev.currentTarget.checked)}
                aria-label={t('inspector.audioEffects.paramOf', '{effect} {param}', { effect: defOf(e.type).label, param: f.label })}
              />
            </div>
          ))}

          {defOf(e.type).params.map((p) => (
            <AudioParamRow
              key={p.key}
              nodeId={nodeId}
              effectId={e.id}
              effectLabel={defOf(e.type).label}
              def={p}
              stored={e.params?.[p.key] ?? p.default}
              edit={fxEdit}
              setStatic={(v) => setParam(e.id, p.key, v)}
            />
          ))}
        </div>
      ))}
    </>
  );
}

export default AudioEffectsSection;
