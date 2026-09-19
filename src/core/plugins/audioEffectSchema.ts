/**
 * `contributes.audioEffects` — a plugin that processes SOUND.
 *
 * ── Why this is a declared GRAPH and not a sample callback ──────────────────
 *
 * After Effects' `PF_Cmd_AUDIO_RENDER` hands a plugin a buffer of samples and
 * takes one back. Copying that here would break the one guarantee this app's
 * audio is built on, and it is worth being exact about which:
 *
 * `audioEffects.ts` states it — there is EXACTLY ONE function that turns a
 * list of effects into audio nodes, and both the live `AudioEngine` and the
 * offline `audioMixdown` call it. The failure that rule prevents is a mix that
 * sounds right while scrubbing and renders differently, "discoverable only by
 * exporting and listening, which is the worst possible feedback loop".
 *
 * A sample callback cannot keep that. Live playback would need an
 * AudioWorklet — which this codebase has a standing rule against, and which
 * `audioGate`/`audioDuck` already route around by baking to keyframes — while
 * the offline path could call the plugin directly. That is two implementations
 * of one effect, and the one that is wrong is the one you only hear after a
 * twenty-minute export.
 *
 * So a plugin declares a CHAIN of the same primitives the built-in effects are
 * made of, and the same builder wires it. Parity stays structural rather than
 * becoming something to test for, and a plugin audio effect works in preview
 * and in export because it is the same nodes in both.
 *
 * ── What that costs, honestly ───────────────────────────────────────────────
 *
 * A plugin cannot write a sample loop. It cannot ship a convolution reverb
 * from its own impulse response file, a spectral denoiser, or anything whose
 * maths is not expressible as WebAudio nodes. That is a real limit and it is
 * the deliberate price of the parity rule; the families it DOES cover — EQ,
 * filters, delay, modulation, distortion, stereo work, gain staging — are the
 * ones most audio plugins actually are.
 *
 * ── Every parameter rides `buildParamRamp` ──────────────────────────────────
 *
 * `audioParams.ts` set the rule: level was the first property through that
 * seam, and "pan, fades and audio-effect parameters are the same shape and
 * should reuse `buildParamRamp` rather than growing a second scheduling path".
 * A plugin's params are numbers for exactly that reason — a keyframed plugin
 * parameter schedules the way a keyframed built-in one does, through one path.
 */

/**
 * The node primitives a plugin may build with.
 *
 * Every one exists identically on `AudioContext` and `OfflineAudioContext`,
 * which is what makes live/offline parity a property of the list rather than
 * of the code that reads it. A node type that behaved differently between the
 * two would not belong here whatever it could do.
 */
export const AUDIO_NODE_KINDS = [
  'biquad',
  'gain',
  'delay',
  'panner',
  'compressor',
  'waveshaper',
] as const;
export type AudioNodeKind = (typeof AUDIO_NODE_KINDS)[number];

/** Filter shapes, mirroring `BiquadFilterType`. */
export const BIQUAD_TYPES = [
  'lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass',
] as const;
export type BiquadType = (typeof BIQUAD_TYPES)[number];

/**
 * A node's setting: a fixed number, or the name of one of the effect's params.
 *
 * `{ param: 'cutoff' }` is what makes a plugin audio effect ANIMATABLE — the
 * host resolves it through `buildParamRamp`, so the value is scheduled rather
 * than sampled once at connect time. A bare number is the constant case and
 * costs no ramp at all.
 */
export type AudioNodeValue = number | { param: string };

export interface PluginAudioNode {
  kind: AudioNodeKind;
  /** `biquad` only. */
  type?: BiquadType;
  /**
   * Node settings by name — `frequency`, `Q`, `gain`, `delayTime`, `pan`,
   * `threshold`, `ratio`, `attack`, `release`, `knee`.
   *
   * Checked against the node kind, because a `delayTime` on a biquad is a
   * setting that silently does nothing, and "my filter ignores one control" is
   * a bug an author cannot see from the manifest.
   */
  set?: Record<string, AudioNodeValue>;
  /** `waveshaper` only — the transfer curve, as a short list of samples. */
  curve?: number[];
}

export interface PluginAudioEffectParam {
  key: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  default: number;
}

export interface AudioEffectContribution {
  /** Plugin-local. The host namespaces it as `<pluginId>.<id>`. */
  id: string;
  label: string;
  /** Shown in the audio-effect menu's grouping. */
  category?: string;
  params: PluginAudioEffectParam[];
  /** Source → node → node → … → destination, in order. */
  chain: PluginAudioNode[];
}

/** AE ships about a dozen audio effects; a plugin declaring more than this is
 *  a menu nobody can scan, and every one is a graph the mixdown must build. */
export const MAX_AUDIO_EFFECTS_PER_PLUGIN = 8;
/** Long enough for a real chain (filter → delay → gain → pan), short enough
 *  that one effect cannot make the mixdown graph unbounded. */
export const MAX_AUDIO_CHAIN_NODES = 8;
export const MAX_AUDIO_PARAMS_PER_EFFECT = 12;
/** A transfer curve is a shape, not a sample buffer. */
export const MAX_WAVESHAPER_CURVE = 256;

const LOCAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PARAM_KEY_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;

/**
 * Which settings each node kind actually has.
 *
 * A closed list per kind rather than one shared list, because the failure of a
 * shared one is silent: `{ kind: 'gain', set: { frequency: 800 } }` would
 * typecheck, build, and do nothing at all.
 */
const NODE_SETTINGS: Readonly<Record<AudioNodeKind, readonly string[]>> = {
  biquad: ['frequency', 'Q', 'gain', 'detune'],
  gain: ['gain'],
  delay: ['delayTime'],
  panner: ['pan'],
  compressor: ['threshold', 'knee', 'ratio', 'attack', 'release'],
  waveshaper: [],
};

/** The longest a delay line may be, in seconds — `DelayNode` needs a maximum
 *  at construction, and an unbounded one is a buffer the host must reserve. */
export const MAX_DELAY_SECONDS = 5;

/**
 * Validate `contributes.audioEffects`, pushing messages rather than throwing.
 *
 * Same convention as every other contribution parser here: a refused plugin
 * must be able to say WHY, and an exception loses every message after the
 * first — an author fixing five mistakes one build at a time is the thing
 * these parsers exist to avoid.
 */
export function parseAudioEffects(
  raw: unknown,
  errors: string[],
  apiVersion?: number,
): AudioEffectContribution[] {
  const out: AudioEffectContribution[] = [];
  if (raw === undefined) return out;

  if (apiVersion !== undefined && apiVersion < AUDIO_EFFECTS_SINCE) {
    if (Array.isArray(raw) && raw.length === 0) return out;
    errors.push(`"contributes.audioEffects" requires "apiVersion": ${AUDIO_EFFECTS_SINCE}.`);
    return out;
  }
  if (!Array.isArray(raw)) {
    errors.push('"contributes.audioEffects" must be an array.');
    return out;
  }
  if (raw.length > MAX_AUDIO_EFFECTS_PER_PLUGIN) {
    errors.push(
      `"contributes.audioEffects" declares ${raw.length}; the limit is ${MAX_AUDIO_EFFECTS_PER_PLUGIN}.`,
    );
    return out;
  }

  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const at = `contributes.audioEffects[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`"${at}" must be an object.`);
      return;
    }
    const e = entry as Record<string, unknown>;

    const id = typeof e.id === 'string' ? e.id : '';
    if (!LOCAL_ID_RE.test(id)) {
      errors.push(`"${at}.id" must be lowercase letters, digits and dashes (1–64 characters).`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`"${at}.id" duplicates an earlier audio effect "${id}".`);
      return;
    }
    seen.add(id);

    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (!label || label.length > 48) {
      errors.push(`"${at}.label" is required (1–48 characters).`);
      return;
    }

    const params = parseParams(e.params, at, errors);
    if (!params) return;
    const chain = parseChain(e.chain, at, new Set(params.map((p) => p.key)), errors);
    if (!chain) return;

    out.push({
      id,
      label,
      params,
      chain,
      ...(typeof e.category === 'string' && e.category.trim() ? { category: e.category.trim() } : {}),
    });
  });

  return out;
}

/** The grammar audio effects arrived in. */
export const AUDIO_EFFECTS_SINCE = 8;

function parseParams(
  raw: unknown,
  at: string,
  errors: string[],
): PluginAudioEffectParam[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`"${at}.params" must be an array.`);
    return null;
  }
  if (raw.length > MAX_AUDIO_PARAMS_PER_EFFECT) {
    errors.push(`"${at}.params" declares ${raw.length}; the limit is ${MAX_AUDIO_PARAMS_PER_EFFECT}.`);
    return null;
  }

  const out: PluginAudioEffectParam[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const where = `${at}.params[${i}]`;
    const p = raw[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      errors.push(`"${where}" must be an object.`);
      return null;
    }
    const q = p as Record<string, unknown>;
    const key = typeof q.key === 'string' ? q.key : '';
    if (!PARAM_KEY_RE.test(key)) {
      errors.push(`"${where}.key" must be camelCase, starting with a lower-case letter.`);
      return null;
    }
    if (seen.has(key)) {
      errors.push(`"${at}.params" declares "${key}" twice.`);
      return null;
    }
    seen.add(key);

    const label = typeof q.label === 'string' ? q.label.trim() : '';
    if (!label || label.length > 48) {
      errors.push(`"${where}.label" is required (1–48 characters).`);
      return null;
    }
    const nums = ['min', 'max', 'default'] as const;
    for (const n of nums) {
      if (typeof q[n] !== 'number' || !Number.isFinite(q[n] as number)) {
        errors.push(`"${where}.${n}" must be a finite number.`);
        return null;
      }
    }
    const min = q.min as number;
    const max = q.max as number;
    const dflt = q.default as number;
    if (min >= max) {
      errors.push(`"${where}": "min" must be below "max".`);
      return null;
    }
    // A default outside the range is a control that jumps the first time it is
    // touched, which reads as the plugin losing the user's value.
    if (dflt < min || dflt > max) {
      errors.push(`"${where}.default" (${dflt}) is outside its own ${min}–${max} range.`);
      return null;
    }

    out.push({
      key, label, min, max, default: dflt,
      ...(typeof q.unit === 'string' && q.unit.trim() ? { unit: q.unit.trim() } : {}),
    });
  }
  return out;
}

function parseChain(
  raw: unknown,
  at: string,
  paramKeys: ReadonlySet<string>,
  errors: string[],
): PluginAudioNode[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    // A chain of nothing is an effect that cannot change the sound. Refused
    // rather than accepted as a pass-through, because it is always a mistake.
    errors.push(`"${at}.chain" must be a non-empty array of nodes.`);
    return null;
  }
  if (raw.length > MAX_AUDIO_CHAIN_NODES) {
    errors.push(`"${at}.chain" declares ${raw.length} nodes; the limit is ${MAX_AUDIO_CHAIN_NODES}.`);
    return null;
  }

  const out: PluginAudioNode[] = [];
  for (let i = 0; i < raw.length; i++) {
    const where = `${at}.chain[${i}]`;
    const n = raw[i];
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      errors.push(`"${where}" must be an object.`);
      return null;
    }
    const node = n as Record<string, unknown>;
    const kind = node.kind;
    if (typeof kind !== 'string' || !(AUDIO_NODE_KINDS as readonly string[]).includes(kind)) {
      errors.push(`"${where}.kind" must be one of: ${AUDIO_NODE_KINDS.join(', ')}.`);
      return null;
    }
    const k = kind as AudioNodeKind;

    if (k === 'biquad') {
      const t = node.type;
      if (typeof t !== 'string' || !(BIQUAD_TYPES as readonly string[]).includes(t)) {
        errors.push(`"${where}.type" must be one of: ${BIQUAD_TYPES.join(', ')}.`);
        return null;
      }
    } else if (node.type !== undefined) {
      errors.push(`"${where}.type" is only meaningful on a "biquad" node.`);
      return null;
    }

    let curve: number[] | undefined;
    if (k === 'waveshaper') {
      if (!Array.isArray(node.curve) || node.curve.length < 2) {
        errors.push(`"${where}.curve" must be an array of at least two numbers.`);
        return null;
      }
      if (node.curve.length > MAX_WAVESHAPER_CURVE) {
        errors.push(`"${where}.curve" has ${node.curve.length} points; the limit is ${MAX_WAVESHAPER_CURVE}.`);
        return null;
      }
      if (node.curve.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
        errors.push(`"${where}.curve" must contain only finite numbers.`);
        return null;
      }
      curve = [...(node.curve as number[])];
    } else if (node.curve !== undefined) {
      errors.push(`"${where}.curve" is only meaningful on a "waveshaper" node.`);
      return null;
    }

    let set: Record<string, AudioNodeValue> | undefined;
    if (node.set !== undefined) {
      if (!node.set || typeof node.set !== 'object' || Array.isArray(node.set)) {
        errors.push(`"${where}.set" must be an object.`);
        return null;
      }
      const allowed = NODE_SETTINGS[k];
      set = {};
      for (const [name, value] of Object.entries(node.set as Record<string, unknown>)) {
        if (!allowed.includes(name)) {
          errors.push(
            `"${where}.set.${name}" is not a setting of a "${k}" node`
            + `${allowed.length ? ` (it has: ${allowed.join(', ')})` : ' — it has none'}.`,
          );
          return null;
        }
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) {
            errors.push(`"${where}.set.${name}" must be a finite number.`);
            return null;
          }
          if (k === 'delay' && name === 'delayTime' && (value < 0 || value > MAX_DELAY_SECONDS)) {
            errors.push(`"${where}.set.delayTime" must be between 0 and ${MAX_DELAY_SECONDS} seconds.`);
            return null;
          }
          set[name] = value;
          continue;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          errors.push(`"${where}.set.${name}" must be a number or { "param": "<name>" }.`);
          return null;
        }
        const ref = (value as Record<string, unknown>).param;
        if (typeof ref !== 'string' || !paramKeys.has(ref)) {
          // A reference to nothing is a control the user can move that reaches
          // no node — the author's symptom is a slider that does nothing.
          errors.push(
            `"${where}.set.${name}" refers to "${String(ref)}", which this effect does not declare as a parameter.`,
          );
          return null;
        }
        set[name] = { param: ref };
      }
    }

    out.push({
      kind: k,
      ...(k === 'biquad' ? { type: node.type as BiquadType } : {}),
      ...(set && Object.keys(set).length > 0 ? { set } : {}),
      ...(curve ? { curve } : {}),
    });
  }
  return out;
}
