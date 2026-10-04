/**
 * A layer's PROPERTY TREE — every property the timeline can show beneath it,
 * whether or not anything is keyframed yet.
 *
 * After Effects' timeline is not a list of animations; it is the layer's whole
 * property structure, and animation is something you START from it. Twirl a
 * layer open and Transform, Effects, Masks, Text, Contents, Layer Styles,
 * Material Options and Audio are all there with their stopwatches unlit. This
 * module answers "what is under this layer", so the timeline can be that.
 *
 * Before it, the timeline derived its sub-rows from `tracksFor(node)` — the
 * ANIMATED tracks — plus a hand-written Transform placeholder block. So a Glow's
 * radius simply did not exist in the timeline until it had been keyframed from
 * the inspector, which is backwards: the timeline is where you keyframe.
 *
 * ## What a row promises
 *
 * A row names REAL animation prop paths in `members`, and its stopwatch keys
 * exactly those. Which means a row is only emitted for something the engine can
 * actually animate. A registry entry flagged `keyframeable: false` is the one
 * exception: it gets a value row with no `members`, so the timeline shows it
 * without a stopwatch rather than offering a keyframe the renderer would
 * ignore. A dead stopwatch is worse than an absent one: it reports success and
 * changes nothing. (Material Options were that case until `readNodeMaterial`
 * took the frame's animated values; nothing is today.)
 *
 * ## What this module does NOT do
 *
 * It never reads keyframes. Rows come back static and ordered; the caller
 * (App's track model) merges the engine's tracks onto them. That split is what
 * lets a collapsed layer skip the whole thing — at 10k layers, building every
 * layer's tree per scene bump is the difference between a timeline and a
 * freeze.
 */

import { POSITION_PSEUDO_PROP } from '@motion/animation';
import {
  resolvePropertyMetaWith,
  type MetaNodeFacts,
  GROUP_PLACEHOLDER_PREFIX,
} from '@core/inspector/propertyMeta';
import {
  styleKeyFromEffectId,
} from '@core/effects/layerStyles';
import { AUDIO_LEVEL_DB_PROP, AUDIO_PAN_PROP } from '@core/audio/audioParams';

/**
 * The sections a layer's properties fall into, in AE's own twirl order.
 *
 * Text and Contents come FIRST because that is where AE puts the thing the
 * layer is; Transform sits below Masks and Effects, which reads wrong until you
 * remember that masks and effects apply before the layer is placed.
 */
export type TimelineGroupKey =
  | 'text'
  | 'contents'
  | 'masks'
  | 'effects'
  | 'transform'
  | 'styles'
  | 'camera'
  | 'light'
  | 'geometry'
  | 'material'
  | 'audio'
  | 'time';

export const TIMELINE_GROUP_ORDER: Readonly<Record<TimelineGroupKey, number>> = {
  text: 0,
  contents: 1,
  masks: 2,
  effects: 3,
  transform: 4,
  styles: 5,
  // AE twirls Camera Options / Light Options right under Transform; a layer
  // only ever has one of the two, so they share the slot in spirit.
  camera: 6,
  light: 7,
  // AE's Geometry Options sits directly above Material Options.
  geometry: 8,
  material: 9,
  audio: 10,
  time: 11,
};

/** The synthetic path of the whole-mask keyframe row (see `maskRow` below). */
export const MASK_ANIM_PROP = '__mask:path';

export interface StaticPropertyRow {
  /** The row's identity: an animation path, or a synthetic placeholder path. */
  prop: string;
  label: string;
  group: TimelineGroupKey;
  /**
   * The real animation paths behind this row. The stopwatch keys all of them
   * at once (AE's Position keys X and Y together), and the row is considered
   * animated when ANY of them is.
   *
   * Empty means the property cannot hold a keyframe — the row is shown for its
   * value alone, with no stopwatch.
   */
  members: ReadonlyArray<string>;
  /**
   * Collapse the members into ONE row even once animated, under this pseudo
   * path. Only Position does this today; every other group splits into its real
   * per-axis rows the moment one of them is keyed, exactly as AE does.
   */
  merged?: string;
  /** Paths the row's value field edits. Empty → the row shows no value. */
  valueProps: ReadonlyArray<string>;
  valueUnit?: string;
  /** Keyframed as a whole-mask track rather than a numeric one. */
  maskTrack?: boolean;
}

// ── Which section does an arbitrary path belong to? ──────────────────

const MATERIAL_PROPS: ReadonlySet<string> = new Set([
  'ambient', 'diffuse', 'specular', 'shininess', 'metal', 'lightTransmission', 'roughness',
  'acceptsLights', 'castsShadows', 'acceptsShadows',
  'reflectionIntensity', 'reflectionSharpness', 'reflectionRolloff',
  'transparency', 'transparencyRolloff', 'ior',
]);

/** The keyframeable Geometry Options — the depths buildSnapshot samples per frame. */
const GEOMETRY_PROPS: ReadonlySet<string> = new Set(['extrusionDepth', 'bevelDepth', 'holeBevelDepth']);

/** {@link groupForProp} over meta facts the caller already holds (the document mirror's, core/mirror/metaFacts.ts). */
export function groupForPropWith(prop: string, facts?: MetaNodeFacts): TimelineGroupKey {
  return prefixGroup(prop) ?? groupOfMeta(resolvePropertyMetaWith(prop, facts).group);
}

/** The groups decided by the track name alone. */
function prefixGroup(prop: string): TimelineGroupKey | null {
  if (prop === MASK_ANIM_PROP || prop.startsWith('mask.')) return 'masks';
  // AE lists Paint as an effect: Effects ▸ Paint ▸ Brush N.
  if (prop.startsWith('paint.')) return 'effects';
  if (prop.startsWith(GROUP_PLACEHOLDER_PREFIX) || prop === POSITION_PSEUDO_PROP) return 'transform';
  if (MATERIAL_PROPS.has(prop)) return 'material';
  if (GEOMETRY_PROPS.has(prop)) return 'geometry';
  if (prop === AUDIO_LEVEL_DB_PROP || prop === AUDIO_PAN_PROP || prop === 'audioLevel') return 'audio';
  if (prop.startsWith('effect.')) {
    const id = prop.slice('effect.'.length).split('.')[0] ?? '';
    return styleKeyFromEffectId(id) ? 'styles' : 'effects';
  }
  if (prop.startsWith('pathop.')) return 'contents';
  if (prop.startsWith('ta.')) return 'text';
  return null;
}

function groupOfMeta(group: string | undefined): TimelineGroupKey {
  switch (group) {
    case 'transform':
      return 'transform';
    case 'text':
      return 'text';
    case 'time':
      return 'time';
    case 'effects':
    case 'controls':
      return 'effects';
    case 'material':
      return 'material';
    case 'audio':
      return 'audio';
    case 'camera':
      return 'camera';
    case 'light':
      return 'light';
    default:
      // geometry / fill / stroke / trim / repeater / other — the layer's own
      // shape and paint, which is what AE calls Contents.
      return 'contents';
  }
}

// ── Audio ───────────────────────────────────────────────────────────

/**
 * The WAVEFORM row under the Audio group — AE's `LL`.
 *
 * A pseudo-row, like `POSITION_PSEUDO_PROP`: it has no keyframes and no
 * stopwatch, because a waveform is not a property, it is a picture of the
 * source. It exists so the timeline has somewhere to draw the peaks at the
 * layer's own time, under the level it belongs to — the clip bar can show them
 * too, but the bar is also the drag target and cannot be made taller just to
 * read the sound.
 */
export const AUDIO_WAVEFORM_ROW = '__audioWaveform';
