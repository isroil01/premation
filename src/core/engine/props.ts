/**
 * The property catalog: API property paths (ENGINE_API.md §3.4) ⇄ today's
 * storage, for one layer.
 *
 * Built on the two seams the editor already trusts for "every property a layer
 * has": `buildStaticPropertyTree` (the timeline's row list, AE-ordered) and
 * `read/writeStaticPropertyValue` (the inspector's static value seam, which
 * already knows effects, layer styles, masks, path operators, text animators,
 * text path, font axes, paint and plain component props). A row's MEMBERS are
 * the scalar keyframe tracks behind it; a vector or colour property is several
 * members read and written together, one API keyframe per time.
 *
 * Groups are addressed by their stable ids (effect id, mask id, text animator
 * id, selector id, path-op id, style key, paint stroke id), never by index.
 */

import {
  defaultAnimation,
  sampleTrack,
  type Keyframe as TsKeyframe,
  type DataKeyframe,
  type EasingKind,
  type SpatialInterp as TsSpatialInterp,
} from '@motion/animation';
import type {
  Value,
  ValueType,
  Keyframe,
  Easing,
  SpatialInterp,
  PropertyKind,
  BezierPath,
  Color,
} from '@motion/engine-api';
import { buildStaticPropertyTree, groupForProp, MASK_ANIM_PROP, type StaticPropertyRow } from '@core/timeline/propertyTree';
import { readStaticPropertyValue, writeStaticPropertyValue } from '@core/inspector/propertyValue';
import { resolvePropertyMeta, GROUP_PLACEHOLDER_PREFIX } from '@core/inspector/propertyMeta';
import { compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import {
  getNodeEffects,
  effectDefFor,
  paramsOf,
  updateEffectParam,
  parseColorChannels,
  channelsToColor,
  EFFECT_OPACITY_KEY,
} from '@core/effects/effects';
import { styleKeyFromEffectId, getNodeLayerStyles, setLayerStyles, defaultGlassStyle, LAYER_STYLE_COLOR_PARAMS, type LayerStyles } from '@core/effects/layerStyles';
import {
  readNodeMask,
  readNodeMaskAnim,
  type MaskPath,
  type MaskPoint,
  type MaskMode,
  type LayerMask,
  type MaskKeyframe,
} from '@core/effects/mask';
import { readAnimatorData, parseAnimatorTrack } from '@core/text/textAnimators';
import { readPathOps } from '@core/scene/pathOps';
import { is3DEnabled } from '@core/scene/threeD';
import { SOURCE_TEXT_PROP } from '@motion/animation';
import { AUDIO_LEVEL_DB_PROP, AUDIO_PAN_PROP } from '@core/audio/audioParams';
import { readNodeKind } from '@core/scene/sceneDerive';

/** audioKeyframes.ts AUDIO_AMPLITUDE_PROP (Convert Audio to Keyframes' track; not imported: that module pulls the audio engine in). */
const AUDIO_AMPLITUDE_TRACK = 'audioAmplitude';
/** A camera's Point of Interest tracks (camera3d.ts). */
const CAMERA_POI_TRACKS = ['poiX', 'poiY', 'poiZ'] as const;
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';
import { fail } from './errors';
import { secondsToFlicks, flicksToSeconds } from './time';
import { addFieldBindings, readField, writeField, effectFieldBinding, styleFieldBinding, setPrimaryFill, type FieldRef } from './fields';
import { fillStopsBinding, readFillStopsStatic, writeFillStopsStatic, fillStopsKeyToApi, apiToFillStopsKey } from './fillStops';
import { EFFECT_FIELDS, STYLE_FIELDS, GLASS_PROPERTIES } from './effectFieldSpecs';
import { parseTextPathPropPath } from '@core/text/textPath';
import { latentMembers } from './latentProps';
import { addPluginBindings, pluginApiPath, pluginPanelGroupPaths } from './pluginProps';
import { parseStrokeTrackPath } from '@core/rendering/strokeTracks';
import { strokeEntryAt } from '@core/paint/strokeValues';
import { normalizeStroke, storeNodeStrokeAt } from '@core/paint/stroke';
import {
  addRigBindings,
  rigGroupInfo,
  rigGroupPaths,
  rigMemberFactor,
  readRigStatic,
  writeRigStatic,
  pinKeyToApi,
  apiToPinKey,
  pinKeySpatial,
  type RigRef,
} from './rigProps';
import { addParticleBindings, readParticleColor, writeParticleColor } from './particleProps';
import { controlBindings, controlGroupInfo, controlGroupPath, readControls } from './controlProps';

/** The registered variable-font axes and the Text props their static values and keys live in (fontAxes.ts). */
const AXIS_OF_MEMBER: Readonly<Record<string, string>> = { fontWeight: 'wght', fontWidth: 'wdth', fontSlant: 'slnt' };

// ── Bindings ─────────────────────────────────────────────────────────

export type Special =
  | 'sourceText'
  | 'maskPath'
  | 'maskMode'
  | 'maskInverted'
  | 'effectParam'
  /** A static field (fields.ts): text / animator / selector fields, style runs, the text path's mask. */
  | 'field'
  /** The layer's own solid fill colour (`layer/fill`, fields.ts), keyed through fill_r/_g/_b/_a. */
  | 'layerFill'
  /** The primary fill's colour stops (`layer/fillStops`, fillStops.ts): static on the paint, keys on `fill.stops`. */
  | 'fillStops'
  /** A puppet / skeleton property (rigProps.ts): static value on the rig, keys on its tracks. */
  | 'rig';

export interface PropBinding {
  path: string;
  name: string;
  matchName: string;
  valueType: ValueType;
  /** Scalar keyframe tracks behind the value, in dimension order. */
  members: string[];
  /** Colour property: the stored hex lives at this track base (members = base_r/_g/_b/_a). */
  colorBase?: string;
  /** Data (non-scalar) keyframe track behind the value. */
  dataTrack?: string;
  special?: Special;
  /** Mask id for mask properties; effect id + key for non-numeric effect params. */
  maskId?: string;
  effectId?: string;
  paramKey?: string;
  /** A `field` binding's storage (fields.ts). */
  field?: FieldRef;
  /**
   * A LATENT binding (latentPropSpecs.ts): the component type(s) its first
   * static write stores on when no component carries the member yet ([] = the
   * static seam owns it). Absent = the Transform (every other binding).
   */
  home?: readonly string[];
  /** A `rig` binding's storage (rigProps.ts). */
  rig?: RigRef;
  animatable: boolean;
  separated?: boolean;
  unit: string;
  min?: number;
  max?: number;
  choices?: string[];
  defaultValue?: Value;
  hidden?: boolean;
}

export interface GroupBinding {
  path: string;
  name: string;
  matchName: string;
  kind: PropertyKind;
  enabled: boolean;
  /** Direct child paths (groups and properties) in order. */
  children: string[];
}

export interface Catalog {
  layer: string;
  props: PropBinding[];
  byPath: Map<string, PropBinding>;
  /** Scalar/data track → the binding that owns it. */
  byMember: Map<string, PropBinding>;
  groups: Map<string, GroupBinding>;
  /** Top-level paths in order. */
  roots: string[];
}

const ROOT_NAMES: Record<string, string> = {
  text: 'Text', contents: 'Contents', masks: 'Masks', effects: 'Effects', transform: 'Transform',
  styles: 'Layer Styles', camera: 'Camera Options', light: 'Light Options', geometry: 'Geometry Options',
  material: 'Material Options', audio: 'Audio', paint: 'Paint', layer: 'Layer', timeRemap: 'Time Remap',
  plugin: 'Plugin',
};

const INDEXED_ROOTS = new Set(['masks', 'effects', 'contents', 'styles', 'paint']);

function nodeOf(id: string): SceneNode {
  const n = defaultSceneGraph.getNode(id);
  if (!n) fail('notFound', `no layer '${id}'`, { layer: id });
  return n;
}

/** API path for a scalar track (or a row's synthetic prop). */
function apiPathFor(
  prop: string,
  row: StaticPropertyRow | null,
  node: SceneNode,
  animIds: string[],
  selIds: string[][],
): string {
  if (prop.startsWith(GROUP_PLACEHOLDER_PREFIX)) {
    const key = prop.slice(GROUP_PLACEHOLDER_PREFIX.length);
    if (key === 'anchor') return 'transform/anchorPoint';
    if (key === 'position') return 'transform/position';
    return `transform/${key}`;
  }
  if (row?.merged) return 'transform/position';
  if (row?.group === 'transform') {
    if (prop === 'x' || prop === 'y' || prop === 'z') return `transform/position/${prop}`;
    if (prop === 'rotationX') return 'transform/xRotation';
    if (prop === 'rotationY') return 'transform/yRotation';
    if (prop === 'opacity') return 'transform/opacity';
    if (prop === 'rotation') return 'transform/rotation';
  }
  const eff = /^effect\.([^.]+)\.(.+)$/.exec(prop);
  if (eff) {
    const styleKey = styleKeyFromEffectId(eff[1]!);
    if (styleKey) return `styles/${styleKey}/${eff[2]}`;
    if (eff[2] === EFFECT_OPACITY_KEY) return `effects/${eff[1]}/compositing/opacity`;
    return `effects/${eff[1]}/${eff[2]}`;
  }
  const glass = /^glass\.([A-Za-z]+)$/.exec(prop);
  if (glass) return `styles/glass/${glass[1]}`;
  const legacyEff = /^effect\.([^.]+)$/.exec(prop);
  if (legacyEff) return `effects/${legacyEff[1]}/amount`;
  const mask = /^mask\.([^.]+)\.(.+)$/.exec(prop);
  if (mask) return `masks/${mask[1]}/${mask[2]}`;
  const op = /^pathop\.([^.]+)\.(.+)$/.exec(prop);
  if (op) return `contents/${op[1]}/${op[2]}`;
  const poly = /^polystar\.(.+)$/.exec(prop);
  if (poly) return `contents/polystar/${poly[1]}`;
  const paint = /^paint\.([^.]+)\.(.+)$/.exec(prop);
  if (paint) return `paint/${paint[1]}/${paint[2]}`;
  const axis = /^text\.axis\.([A-Za-z0-9]{4})$/.exec(prop);
  if (axis) return `text/axes/${axis[1]}`;
  // wght / wdth / slnt: ONE API path per axis, like every other axis (G1).
  const legacyAxis = AXIS_OF_MEMBER[prop];
  if (legacyAxis) return `text/axes/${legacyAxis}`;
  // AE's Text ▸ Path Options ▸ <param>.
  const tp = parseTextPathPropPath(prop);
  if (tp) return `text/pathOptions/${tp}`;
  const ta = parseAnimatorTrack(prop);
  if (ta) {
    const aid = animIds[ta.anim] ?? `#${ta.anim}`;
    if (ta.sel === null) return `text/animators/${aid}/props/${ta.param}`;
    const sid = selIds[ta.anim]?.[ta.sel] ?? `#${ta.sel}`;
    return `text/animators/${aid}/selectors/${sid}/${ta.param}`;
  }
  if (prop === AUDIO_LEVEL_DB_PROP) return 'audio/levels';
  if (prop === AUDIO_PAN_PROP) return 'audio/pan';
  if (prop === 'timeRemap') return 'timeRemap';
  if (prop === 'timeSpeed') return 'layer/timeSpeed';
  // B3z: a plugin layer kind's prop / a contributed panel's param (pluginProps.ts).
  const plugin = pluginApiPath(prop);
  if (plugin) return plugin;
  const group = row?.group;
  if (group === 'material' || group === 'geometry' || group === 'camera' || group === 'light') return `${group}/${prop}`;
  if (group === 'text' && prop !== 'animators' && prop !== 'sourceText' && prop !== 'axes') return `text/${prop}`;
  void node;
  return `layer/${prop.replace(/\//g, '_')}`;
}

function valueTypeForMembers(n: number, color: boolean): ValueType {
  if (color) return 'color';
  return n <= 1 ? 'scalar' : n === 2 ? 'vec2' : n === 3 ? 'vec3' : 'vec4';
}

/** A timeline row of an effect's Compositing Options ▸ Effect Opacity. */
const EFFECT_OPACITY_ROW = /^effect\.(?!layerstyle:)[^.]+\.fx\.opacity$/;

const MASK_MODES: MaskMode[] = ['none', 'add', 'subtract', 'intersect', 'lighten', 'darken', 'difference'];

/** Build the catalog of one layer (live graph). */
export function catalogFor(layerId: string): Catalog {
  const node = nodeOf(layerId);
  const animators = readAnimatorData(node);
  const animIds = animators.map((a) => a.id);
  const selIds = animators.map((a) => (a.selectors ?? []).map((s) => s.id));
  const rows = buildStaticPropertyTree(layerId);
  const props: PropBinding[] = [];
  const byPath = new Map<string, PropBinding>();
  const byMember = new Map<string, PropBinding>();
  const add = (b: PropBinding): void => {
    if (byPath.has(b.path)) return;
    props.push(b);
    byPath.set(b.path, b);
    for (const m of b.members) if (!byMember.has(m)) byMember.set(m, b);
    if (b.dataTrack && !byMember.has(b.dataTrack)) byMember.set(b.dataTrack, b);
  };

  const mask = readNodeMask(node);
  const is3D = is3DEnabled(node);
  const addCompositing = (effectId: string): void => {
    add({
      path: `effects/${effectId}/compositing/opacity`, name: 'Effect Opacity', matchName: 'ADBE Effect Mask Opacity', valueType: 'scalar',
      members: [`effect.${effectId}.${EFFECT_OPACITY_KEY}`], animatable: true, unit: '%', min: 0, max: 100,
      defaultValue: { kind: 'scalar', value: 100 },
    });
    for (const spec of EFFECT_FIELDS) add(effectFieldBinding(effectId, spec));
  };

  // B3: expression controls (controlProps.ts) — `effects/ctrl_<name>/<param>`,
  // claiming their stored numbers' rows.
  const controls = controlBindings(node);
  const controlMembers = new Set(controls.flatMap((b) => b.members));

  for (const row of rows) {
    // Effect Opacity is listed for EVERY effect below (B3z), not only once touched.
    if (EFFECT_OPACITY_ROW.test(row.prop)) continue;
    if (row.members.length > 0 && row.members.every((m) => controlMembers.has(m))) continue;
    if (row.maskTrack || row.prop === MASK_ANIM_PROP) {
      // One Mask Path property per mask (whole-mask snapshots in fx.maskAnim).
      for (const p of mask?.paths ?? []) addMaskProps(p, add);
      continue;
    }
    const color = row.members.length === 4 && row.members.every((m, i) => m.endsWith(['_r', '_g', '_b', '_a'][i]!));
    if (row.members.length === 0) {
      // Data-track rows (paint path) and value-less rows.
      if (/^paint\.[^.]+\.path$/.test(row.prop)) {
        add({
          path: apiPathFor(row.prop, row, node, animIds, selIds), name: row.label, matchName: row.prop,
          valueType: 'path', members: [], dataTrack: row.prop, animatable: true, unit: '',
        });
      }
      continue;
    }
    if (row.prop.startsWith(`${GROUP_PLACEHOLDER_PREFIX}rotation`) && row.members.length > 1) {
      // AE: Z/X/Y Rotation are separate properties.
      for (const m of row.members) {
        const meta = resolvePropertyMeta(m, layerId);
        add({
          path: apiPathFor(m, { ...row, group: 'transform' }, node, animIds, selIds), name: meta.label,
          matchName: m, valueType: 'scalar', members: [m], animatable: true, unit: meta.unit,
          ...(meta.min !== undefined ? { min: meta.min } : {}), ...(meta.max !== undefined ? { max: meta.max } : {}),
          ...(typeof meta.defaultValue === 'number' ? { defaultValue: { kind: 'scalar', value: meta.defaultValue } as Value } : {}),
        });
      }
      continue;
    }
    const base = color ? row.prop : row.members[0]!;
    const meta = resolvePropertyMeta(color ? row.members[0]! : base, layerId);
    const path = apiPathFor(row.prop, row, node, animIds, selIds);
    const vt = valueTypeForMembers(row.members.length, color);
    const def = defaultFor(vt, row.members, layerId, meta.defaultValue);
    add({
      path,
      name: row.label,
      matchName: row.merged ?? row.prop,
      valueType: vt,
      members: [...row.members],
      ...(color ? { colorBase: row.prop } : {}),
      animatable: meta.keyframeable !== false,
      unit: !color && apiUnitFactor(row.members[0]) === 100 ? '%' : row.valueUnit ?? meta.unit ?? '',
      ...(meta.min !== undefined && !color ? { min: meta.min } : {}),
      ...(meta.max !== undefined && !color ? { max: meta.max } : {}),
      ...(def ? { defaultValue: def } : {}),
    });
  }

  for (const b of controls) add(b);

  // Separated position: the combined property still exists (not animatable).
  const sepX = byPath.get('transform/position/x');
  if (sepX) {
    const dims = ['x', 'y', ...(byPath.has('transform/position/z') ? ['z'] : [])];
    const b: PropBinding = {
      path: 'transform/position', name: 'Position', matchName: 'Position', valueType: dims.length === 3 ? 'vec3' : 'vec2',
      members: dims, animatable: false, separated: true, unit: 'px',
    };
    props.push(b);
    byPath.set(b.path, b);
  }
  void is3D;

  // Text: Source Text.
  const textComp = node.components.find((c) => c.type === 'Text');
  if (textComp) {
    add({
      path: 'text/sourceText', name: 'Source Text', matchName: 'ADBE Text Document', valueType: 'textDocument',
      members: [], dataTrack: SOURCE_TEXT_PROP, special: 'sourceText', animatable: true, unit: '',
    });
  }

  // Effects: the non-numeric params the timeline rows omit, then AE's
  // Compositing Options (B3z) — Effect Opacity (keyed on effect.<id>.fx.opacity,
  // static = Effect.opacity), Effect Mask and the label colour — on every effect.
  for (const effect of getNodeEffects(layerId)) {
    const edef = effectDefFor(effect.type);
    if (!edef) {
      addCompositing(effect.id);
      continue;
    }
    for (const p of edef.params) {
      if (p.type === 'number' || p.type === 'color' || p.type === 'resolved') continue;
      const vt: ValueType = p.type === 'checkbox' ? 'bool' : p.type === 'enum' ? 'choice' : p.type === 'layer' ? 'layer' : p.type === 'maskPath' ? 'string' : 'json';
      add({
        path: `effects/${effect.id}/${p.key}`, name: p.label, matchName: p.key, valueType: vt, members: [],
        special: 'effectParam', effectId: effect.id, paramKey: p.key, animatable: false, unit: p.unit ?? '',
        ...(p.type === 'enum' ? { choices: (p.options ?? []).map((o) => o.label) } : {}),
      });
    }
    addCompositing(effect.id);
  }

  // Layer styles (B3z): Glass as a first-class style (styles/glass/<param> on the
  // glass.<param> tracks) and the styles' switches (effectFieldSpecs.ts).
  const layerStyles = getNodeLayerStyles(layerId) as Record<string, object | undefined>;
  if (layerStyles.glass) {
    const gd = defaultGlassStyle() as unknown as Record<string, unknown>;
    for (const g of GLASS_PROPERTIES) {
      const m = `glass.${g.key}`;
      if (g.type === 'color') {
        add({
          path: `styles/glass/${g.key}`, name: g.label, matchName: m, valueType: 'color',
          members: [`${m}_r`, `${m}_g`, `${m}_b`, `${m}_a`], colorBase: m, animatable: true, unit: '',
        });
      } else {
        add({
          path: `styles/glass/${g.key}`, name: g.label, matchName: m, valueType: 'scalar', members: [m], animatable: true, unit: '',
          defaultValue: { kind: 'scalar', value: gd[g.key] as number },
        });
      }
    }
  }
  for (const spec of STYLE_FIELDS) if (layerStyles[spec.style]) add(styleFieldBinding(spec));

  // Masks without a mask-shape row (no rows are built for a mask with no paths).
  for (const p of mask?.paths ?? []) addMaskProps(p, add);

  // G1: static fields (text / animator / selector fields, style runs, Path
  // Options ▸ Path), Blur Y, the registered font axes and the layer's fill
  // colour — before the unclaimed tracks below, which they claim.
  addFieldBindings(node, layerId, animators, add, (p) => byPath.has(p));

  // B3z WS-R: puppet pins and skeletons (rigProps.ts) — they claim the
  // puppet.* / bone.* / ikTarget.* / ikPole.* / ikMode.* tracks.
  addRigBindings(node, layerId, add);

  // B3z: Gradient Fill ▸ Colors (fillStops.ts) — claims the fill.stops data track.
  const stops = fillStopsBinding(node, layerId);
  if (stops) add(stops);

  // B3z: a particle emitter's keyframeable numbers and colours (particleProps.ts).
  addParticleBindings(node, layerId, add, (m) => byMember.has(m));

  // B3z: LATENT numeric properties (latentPropSpecs.ts) — keyframeable
  // numbers the layer has before it stores them; same path as when stored.
  for (const l of latentMembers(node)) {
    if (byMember.has(l.member)) continue;
    const meta = resolvePropertyMeta(l.member, layerId);
    const path = apiPathFor(l.member, { prop: l.member, label: meta.label, group: groupForProp(l.member, layerId), members: [l.member], valueProps: [l.member] }, node, animIds, selIds);
    if (byPath.has(path)) continue;
    add({
      path, name: meta.label, matchName: l.member, valueType: 'scalar', members: [l.member],
      animatable: meta.keyframeable !== false, unit: meta.unit ?? '', home: l.home,
      ...(meta.min !== undefined ? { min: meta.min } : {}),
      ...(meta.max !== undefined ? { max: meta.max } : {}),
      ...(typeof meta.defaultValue === 'number' ? { defaultValue: { kind: 'scalar', value: meta.defaultValue * apiUnitFactor(l.member) } as Value } : {}),
    });
  }

  // B3z: PLUGIN properties (pluginProps.ts) — a plugin layer kind's props and
  // each contributed inspector panel's params, typed by what is stored; they
  // claim the plugin.* / pluginUi.* tracks.
  addPluginBindings(node, Object.keys(defaultAnimation.snapshotNode(layerId)?.tracks ?? {}), add);

  // Animated tracks the tree did not describe.
  const snap = defaultAnimation.snapshotNode(layerId);
  for (const prop of Object.keys(snap?.tracks ?? {})) {
    if (byMember.has(prop)) continue;
    const meta = resolvePropertyMeta(prop, layerId);
    add({
      path: apiPathFor(prop, null, node, animIds, selIds), name: meta.label || prop, matchName: prop,
      valueType: 'scalar', members: [prop], animatable: true, unit: meta.unit ?? '',
    });
  }
  // Convert Audio to Keyframes' track (B3z): an audio layer's `audioAmplitude`
  // (0–100) is addressable BEFORE its first key, so the conversion is a
  // keyframe command — the same binding the loop above gives it once keyed.
  if (readNodeKind(node) === 'audio' && !byMember.has(AUDIO_AMPLITUDE_TRACK)) {
    const meta = resolvePropertyMeta(AUDIO_AMPLITUDE_TRACK, layerId);
    add({
      path: apiPathFor(AUDIO_AMPLITUDE_TRACK, null, node, animIds, selIds), name: meta.label || AUDIO_AMPLITUDE_TRACK, matchName: AUDIO_AMPLITUDE_TRACK,
      valueType: 'scalar', members: [AUDIO_AMPLITUDE_TRACK], animatable: true, unit: meta.unit ?? '',
    });
  }
  // A ONE-node camera's Point of Interest (B3z): keying it aims the camera at
  // a point (camera3d `hasPOI`) — what Track Motion's camera follow writes.
  // A two-node camera lists these through its stored props already.
  if (readNodeKind(node) === 'camera') {
    for (const m of CAMERA_POI_TRACKS) {
      if (byMember.has(m)) continue;
      const meta = resolvePropertyMeta(m, layerId);
      add({ path: `camera/${m}`, name: meta.label || m, matchName: m, valueType: 'scalar', members: [m], animatable: true, unit: meta.unit ?? '' });
    }
  }
  for (const prop of Object.keys(snap?.data ?? {})) {
    if (byMember.has(prop)) continue;
    const kind = snap!.data[prop]!.kind;
    add({
      path: apiPathFor(prop, null, node, animIds, selIds), name: prop, matchName: prop,
      valueType: kind === 'text' ? 'string' : kind === 'points' ? 'path' : kind === 'gradientStops' ? 'gradient' : 'scalar',
      members: [], dataTrack: prop, animatable: true, unit: '',
    });
  }

  // Groups from path prefixes.
  const groups = new Map<string, GroupBinding>();
  const roots: string[] = [];
  const effects = getNodeEffects(layerId);
  const styles = getNodeLayerStyles(layerId) as Record<string, { enabled?: boolean } | undefined>;
  const ops = readPathOps(node);
  const groupName = (path: string): { name: string; matchName: string; enabled: boolean; kind: PropertyKind } => {
    const rig = rigGroupInfo(node, path);
    if (rig) return rig;
    const control = controlGroupInfo(node, path);
    if (control) return control;
    const seg = path.split('/');
    if (seg.length === 1) return { name: ROOT_NAMES[seg[0]!] ?? seg[0]!, matchName: seg[0]!, enabled: true, kind: INDEXED_ROOTS.has(seg[0]!) || path === 'text/animators' ? 'indexedGroup' : 'group' };
    if (seg[0] === 'effects' && seg.length === 2) {
      const e = effects.find((x) => x.id === seg[1]);
      return { name: e ? (effectDefFor(e.type)?.label ?? e.type) : seg[1]!, matchName: e?.type ?? seg[1]!, enabled: e?.enabled !== false, kind: 'group' };
    }
    if (seg[0] === 'effects' && seg.length === 3 && seg[2] === 'compositing') {
      return { name: 'Compositing Options', matchName: 'ADBE Effect Built In Params', enabled: true, kind: 'group' };
    }
    if (seg[0] === 'masks' && seg.length === 2) {
      const i = mask?.paths.findIndex((p) => p.id === seg[1]) ?? -1;
      const p = i >= 0 ? mask!.paths[i]! : undefined;
      return { name: p?.name ?? `Mask ${i + 1}`, matchName: 'ADBE Mask Atom', enabled: p ? p.mode !== 'none' : true, kind: 'group' };
    }
    if (seg[0] === 'styles' && seg.length === 2) {
      return { name: seg[1]!, matchName: `style:${seg[1]}`, enabled: styles[seg[1]!]?.enabled !== false, kind: 'group' };
    }
    if (seg[0] === 'contents' && seg.length === 2) {
      const o = ops.find((x) => x.id === seg[1]);
      return { name: o ? o.type : seg[1]!, matchName: o ? `pathop:${o.type}` : seg[1]!, enabled: (o as { enabled?: boolean } | undefined)?.enabled !== false, kind: 'group' };
    }
    if (path === 'text/animators') return { name: 'Animators', matchName: 'ADBE Text Animators', enabled: true, kind: 'indexedGroup' };
    if (path === 'text/pathOptions') return { name: 'Path Options', matchName: 'ADBE Text Path Options', enabled: true, kind: 'group' };
    if (seg[0] === 'text' && seg[1] === 'animators' && seg.length === 3) {
      const a = animators.find((x) => x.id === seg[2]);
      return { name: a?.name ?? `Animator ${animators.indexOf(a!) + 1}`, matchName: 'ADBE Text Animator', enabled: a?.enabled !== false, kind: 'group' };
    }
    if (seg[0] === 'text' && seg[1] === 'animators' && seg.length === 4) {
      return { name: seg[3] === 'props' ? 'Properties' : 'Selectors', matchName: seg[3] === 'props' ? 'ADBE Text Animator Properties' : 'ADBE Text Selectors', enabled: true, kind: seg[3] === 'selectors' ? 'indexedGroup' : 'group' };
    }
    if (seg[0] === 'text' && seg[1] === 'animators' && seg.length === 5) {
      const a = animators.find((x) => x.id === seg[2]);
      const s = a?.selectors?.find((x) => x.id === seg[4]);
      return { name: s ? `${s.kind ?? 'range'} selector` : seg[4]!, matchName: 'ADBE Text Selector', enabled: (s as { enabled?: boolean } | undefined)?.enabled !== false, kind: 'group' };
    }
    return { name: seg[seg.length - 1]!, matchName: seg[seg.length - 1]!, enabled: true, kind: 'group' };
  };
  const ensureGroup = (path: string): void => {
    if (groups.has(path)) return;
    const info = groupName(path);
    groups.set(path, { path, ...info, children: [] });
    const slash = path.lastIndexOf('/');
    if (slash < 0) roots.push(path);
    else {
      const parent = path.slice(0, slash);
      ensureGroup(parent);
      groups.get(parent)!.children.push(path);
    }
  };
  // Every group of the layer exists even when empty (an effect with no numeric params).
  for (const e of effects) ensureGroup(`effects/${e.id}`);
  for (const c of readControls(node)) ensureGroup(controlGroupPath(c.name));
  for (const p of mask?.paths ?? []) ensureGroup(`masks/${p.id}`);
  for (const a of animators) {
    ensureGroup(`text/animators/${a.id}/props`);
    for (const s of a.selectors ?? []) ensureGroup(`text/animators/${a.id}/selectors/${s.id}`);
  }
  for (const o of ops) ensureGroup(`contents/${o.id}`);
  for (const g of rigGroupPaths(node)) ensureGroup(g);
  for (const g of pluginPanelGroupPaths(node)) ensureGroup(g);
  for (const b of props) {
    const slash = b.path.lastIndexOf('/');
    if (slash < 0) {
      if (!roots.includes(b.path)) roots.push(b.path);
      continue;
    }
    const parent = b.path.slice(0, slash);
    // A separated dimension belongs to its combined property, not a group.
    if (byPath.has(parent)) continue;
    ensureGroup(parent);
    groups.get(parent)!.children.push(b.path);
  }
  return { layer: layerId, props, byPath, byMember, groups, roots };

  function addMaskProps(p: MaskPath, addFn: (b: PropBinding) => void): void {
    addFn({ path: `masks/${p.id}/path`, name: 'Mask Path', matchName: 'ADBE Mask Shape', valueType: 'path', members: [], special: 'maskPath', maskId: p.id, animatable: true, unit: '' });
    for (const key of ['feather', 'opacity', 'expansion'] as const) {
      const m = `mask.${p.id}.${key}`;
      const meta = resolvePropertyMeta(m, layerId);
      addFn({ path: `masks/${p.id}/${key}`, name: meta.label, matchName: `ADBE Mask ${key}`, valueType: 'scalar', members: [m], animatable: true, unit: meta.unit ?? '' });
    }
    addFn({ path: `masks/${p.id}/mode`, name: 'Mode', matchName: 'ADBE Mask Mode', valueType: 'choice', members: [], special: 'maskMode', maskId: p.id, animatable: false, unit: '', choices: [...MASK_MODES] as string[] });
    addFn({ path: `masks/${p.id}/inverted`, name: 'Inverted', matchName: 'ADBE Mask Inverted', valueType: 'bool', members: [], special: 'maskInverted', maskId: p.id, animatable: false, unit: '' });
  }
}

function defaultFor(vt: ValueType, members: readonly string[], layerId: string, d: unknown): Value | undefined {
  if (vt === 'color') return undefined;
  // Defaults are API values (AE units, see apiUnitFactor).
  if (members.length === 1) return typeof d === 'number' ? { kind: 'scalar', value: d * apiUnitFactor(members[0]) } : undefined;
  const vals = members.map((m) => {
    const v = resolvePropertyMeta(m, layerId).defaultValue;
    return typeof v === 'number' ? v * apiUnitFactor(m) : 0;
  });
  return vectorValue(vt, vals);
}

export function requireBinding(cat: Catalog, path: string): PropBinding {
  const b = cat.byPath.get(path);
  if (!b) fail('notFound', `layer '${cat.layer}' has no property '${path}'`, { layer: cat.layer, path });
  return b;
}

// ── Value conversion ─────────────────────────────────────────────────

/**
 * API units are After Effects units (ENGINE_API.md §3.5): pixels, degrees and
 * PERCENT for opacity and scale. Every member this engine stores in the AE unit
 * already (opacity 0..100, rotation in degrees, pixels) has factor 1; transform
 * scale is stored as a multiplier (1 = 100 %) and is converted HERE, at the
 * seam, both ways — every value that crosses the API (setProperty, keyframe
 * values, getPropertyValues/Tree, sampleProperty, change events) goes through
 * `toApiNums`/`fromApiNums`. The C++ engine stores the AE unit directly.
 */
const PERCENT_MULTIPLIER_MEMBERS = new Set(['scale', 'scaleX', 'scaleY', 'scaleZ']);

/** API value = stored value × this, for one member track. */
export function apiUnitFactor(member: string | undefined): number {
  if (member === undefined) return 1;
  if (PERCENT_MULTIPLIER_MEMBERS.has(member)) return 100;
  // A pin's / bone's scale (multiplier → %), a bone's rotation (radians → °).
  return rigMemberFactor(member) ?? 1;
}

/** Stored member numbers → API numbers (colours are never scaled). */
export function toApiNums(b: PropBinding, nums: number[]): number[] {
  if (b.colorBase) return nums;
  return nums.map((x, i) => x * apiUnitFactor(b.members[i]));
}

/** API numbers → stored member numbers. */
export function fromApiNums(b: PropBinding, nums: number[]): number[] {
  if (b.colorBase) return nums;
  return nums.map((x, i) => x / apiUnitFactor(b.members[i]));
}

export function vectorValue(vt: ValueType, v: number[]): Value {
  switch (vt) {
    case 'scalar': return { kind: 'scalar', value: v[0] ?? 0 };
    case 'vec2': return { kind: 'vec2', value: { x: v[0] ?? 0, y: v[1] ?? 0 } };
    case 'vec3': return { kind: 'vec3', value: { x: v[0] ?? 0, y: v[1] ?? 0, z: v[2] ?? 0 } };
    case 'vec4': return { kind: 'vec4', value: { x: v[0] ?? 0, y: v[1] ?? 0, z: v[2] ?? 0, w: v[3] ?? 0 } };
    case 'color': return { kind: 'color', value: { r: v[0] ?? 0, g: v[1] ?? 0, b: v[2] ?? 0, a: v[3] ?? 1 } };
    default: return { kind: 'scalar', value: v[0] ?? 0 };
  }
}

/** A numeric/vector/colour Value as its members' numbers, type-checked. */
export function numbersOf(b: PropBinding, value: Value): number[] {
  const n = b.members.length;
  const bad = (): never => fail('typeMismatch', `'${b.path}' takes a ${b.valueType}, got ${value.kind}`, { path: b.path, detail: JSON.stringify({ expected: b.valueType }) });
  let out: number[];
  switch (value.kind) {
    case 'scalar': out = [value.value]; break;
    case 'int': out = [value.value]; break;
    case 'bool': out = [value.value ? 1 : 0]; break;
    case 'vec2': out = [value.value.x, value.value.y]; break;
    case 'vec3': out = [value.value.x, value.value.y, value.value.z]; break;
    case 'vec4': out = [value.value.x, value.value.y, value.value.z, value.value.w]; break;
    case 'color': out = [value.value.r, value.value.g, value.value.b, value.value.a]; break;
    default: return bad();
  }
  if (b.valueType === 'color' && value.kind !== 'color') return bad();
  if (b.valueType !== 'color' && value.kind === 'color') return bad();
  if (out.length < n) {
    // A 2D value written to a 3D property keeps z; a scalar to a vector is a mismatch.
    if (out.length === 2 && n === 3) return out;
    return bad();
  }
  for (const x of out) if (!Number.isFinite(x)) fail('invalidArgument', `'${b.path}': value must be finite`, { path: b.path });
  return out.slice(0, n);
}

function colorOfString(s: unknown): Color | undefined {
  if (typeof s !== 'string') return undefined;
  if (!/^#?[0-9a-fA-F]{3,8}$/.test(s.trim())) return undefined;
  const [r, g, b, a] = parseColorChannels(s);
  return { r, g, b, a };
}

/**
 * The shape-stroke stack index a colour base names (`stroke`, `stroke.<i>.color`,
 * strokeTracks.ts) when the layer has that stroke — its colour lives in the
 * stack entry (`fx.stroke(s)`), not in a component string. A text layer's
 * `stroke` is its Text component's colour (the component scan below).
 */
function strokeColorIndex(node: SceneNode, base: string): number | undefined {
  const st = parseStrokeTrackPath(`${base}_r`);
  if (!st || st.param !== 'color') return undefined;
  if (st.index === 0 && node.components.some((c) => c.type === 'Text')) return undefined;
  return strokeEntryAt(node, st.index) ? st.index : undefined;
}

/** The stored hex behind a colour property's base path. */
function readColorBase(node: SceneNode, base: string): Color | undefined {
  const particle = readParticleColor(node, base);
  if (particle !== undefined) return colorOfString(particle);
  const si = strokeColorIndex(node, base);
  if (si !== undefined) return colorOfString(strokeEntryAt(node, si)!.color);
  const gl = /^glass\.(tintColor|rimColor)$/.exec(base);
  if (gl) return colorOfString((getNodeLayerStyles(node.id) as Record<string, Record<string, unknown> | undefined>).glass?.[gl[1]!]);
  const eff = /^effect\.([^.]+)\.(.+)$/.exec(base);
  if (eff) {
    const styleKey = styleKeyFromEffectId(eff[1]!);
    if (styleKey) {
      const style = (getNodeLayerStyles(node.id) as Record<string, Record<string, unknown> | undefined>)[styleKey];
      const field = Object.entries(LAYER_STYLE_COLOR_PARAMS[styleKey] ?? {}).find(([, p]) => p === eff[2])?.[0];
      return field ? colorOfString(style?.[field]) : undefined;
    }
    const e = getNodeEffects(node.id).find((x) => x.id === eff[1]);
    return e ? colorOfString(paramsOf(e)[eff[2]!]) : undefined;
  }
  for (const c of node.components) {
    const v = (c.props as Record<string, unknown>)[base];
    const col = colorOfString(v);
    if (col) return col;
  }
  return undefined;
}

function writeColorBase(node: SceneNode, base: string, c: Color): boolean {
  const hex = channelsToColor(c.r, c.g, c.b, c.a);
  const particle = writeParticleColor(node.id, node, base, hex);
  if (particle !== null) return particle;
  const si = strokeColorIndex(node, base);
  if (si !== undefined) {
    storeNodeStrokeAt(node.id, si, normalizeStroke({ ...strokeEntryAt(node, si)!, color: hex }));
    return true;
  }
  const gl = /^glass\.(tintColor|rimColor)$/.exec(base);
  if (gl) {
    const styles = getNodeLayerStyles(node.id);
    if (!styles.glass) return false;
    setLayerStyles(node.id, { ...styles, glass: { ...styles.glass, [gl[1]!]: hex } });
    return true;
  }
  const eff = /^effect\.([^.]+)\.(.+)$/.exec(base);
  if (eff) {
    const styleKey = styleKeyFromEffectId(eff[1]!);
    if (styleKey) {
      const styles = getNodeLayerStyles(node.id) as Record<string, Record<string, unknown> | undefined>;
      const style = styles[styleKey];
      const field = Object.entries(LAYER_STYLE_COLOR_PARAMS[styleKey] ?? {}).find(([, p]) => p === eff[2])?.[0];
      if (!style || !field) return false;
      setLayerStyles(node.id, { ...(styles as LayerStyles), [styleKey]: { ...style, [field]: hex } } as LayerStyles);
      return true;
    }
    if (!getNodeEffects(node.id).some((x) => x.id === eff[1])) return false;
    updateEffectParam(node.id, eff[1]!, eff[2]!, hex);
    return true;
  }
  const comp = node.components.find((x) => typeof (x.props as Record<string, unknown>)[base] === 'string');
  if (!comp) return false;
  defaultSceneGraph.writeProp(node.id, comp.id, base, hex);
  return true;
}

// Mask path ⇄ BezierPath (tangents relative, AE-style).
export function maskToBezier(p: MaskPath): BezierPath {
  const vertices: number[] = [];
  const inT: number[] = [];
  const outT: number[] = [];
  for (const pt of p.points) {
    vertices.push(pt.x, pt.y);
    inT.push(pt.inX - pt.x, pt.inY - pt.y);
    outT.push(pt.outX - pt.x, pt.outY - pt.y);
  }
  // Variable-width feather (B3z): a vertex's own feather is a feather point AT
  // that vertex (segment i, t 0); a vertex without one has none.
  const featherPoints: BezierPath['featherPoints'] = [];
  p.points.forEach((pt, i) => {
    if (typeof pt.feather === 'number') featherPoints.push({ segment: i, t: 0, radius: pt.feather, tension: 0 });
  });
  return { vertices, inTangents: inT, outTangents: outT, closed: p.closed, featherPoints };
}

/**
 * The per-vertex feathers a path's feather points say (B3z), or null for an
 * EMPTY list — which keeps each vertex's current feather by index (`prev`),
 * what a path write did before feather points existed (the viewport's reshape
 * and every client that builds a BezierPath without them rely on it). A
 * non-empty list is the whole answer: a vertex it does not list — or lists with
 * a negative radius, the "none" marker (`[{segment: 0, t: 0, radius: -1,
 * tension: 0}]` clears every vertex) — has no feather of its own. The model
 * holds one feather per VERTEX: `t` ≠ 0 or `tension` ≠ 0 is `unsupported`.
 */
function featherByVertex(b: BezierPath, n: number): Map<number, number | null> | null {
  const fps = b.featherPoints ?? [];
  if (fps.length === 0) return null;
  const out = new Map<number, number | null>();
  for (const f of fps) {
    if (!Number.isInteger(f.segment) || f.segment < 0 || f.segment >= n) fail('invalidArgument', `feather point segment ${f.segment} is not a vertex of the ${n}-vertex path`);
    if (!Number.isFinite(f.radius) || !Number.isFinite(f.t) || !Number.isFinite(f.tension)) fail('invalidArgument', 'feather point values must be finite');
    if (f.t !== 0 || f.tension !== 0) fail('unsupported', 'this engine stores one feather per vertex: feather points need t = 0 and tension = 0');
    if (out.has(f.segment)) fail('invalidArgument', `two feather points at vertex ${f.segment}`);
    out.set(f.segment, f.radius < 0 ? null : f.radius);
  }
  return out;
}

export function bezierToPoints(b: BezierPath, prev?: ReadonlyArray<MaskPoint>): MaskPoint[] {
  const n = Math.floor(b.vertices.length / 2);
  if (b.inTangents.length !== b.vertices.length && b.inTangents.length !== 0) fail('invalidArgument', 'path tangents must match vertices');
  if (b.outTangents.length !== b.vertices.length && b.outTangents.length !== 0) fail('invalidArgument', 'path tangents must match vertices');
  const feathers = featherByVertex(b, n);
  const out: MaskPoint[] = [];
  for (let i = 0; i < n; i++) {
    const x = b.vertices[2 * i]!;
    const y = b.vertices[2 * i + 1]!;
    const pt: MaskPoint = {
      x, y,
      inX: x + (b.inTangents[2 * i] ?? 0), inY: y + (b.inTangents[2 * i + 1] ?? 0),
      outX: x + (b.outTangents[2 * i] ?? 0), outY: y + (b.outTangents[2 * i + 1] ?? 0),
    };
    if (feathers) {
      const f = feathers.get(i);
      if (typeof f === 'number') pt.feather = f;
    } else {
      const old = prev?.[i];
      if (old?.feather !== undefined) pt.feather = old.feather;
    }
    out.push(pt);
  }
  return out;
}

/** The static (un-animated) value of a property, from the live graph. */
export function readStatic(layerId: string, b: PropBinding): Value {
  const node = nodeOf(layerId);
  switch (b.special) {
    case 'sourceText': {
      const text = node.components.find((c) => c.type === 'Text');
      const content = (text?.props as Record<string, unknown> | undefined)?.content;
      return { kind: 'textDocument', value: { text: typeof content === 'string' ? content : '', runs: [], paragraphs: [], orientation: 'horizontal', kerning: 'metrics' } };
    }
    case 'maskPath': {
      const p = readNodeMask(node)?.paths.find((x) => x.id === b.maskId);
      return p ? { kind: 'path', value: maskToBezier(p) } : { kind: 'none' };
    }
    case 'maskMode': {
      const p = readNodeMask(node)?.paths.find((x) => x.id === b.maskId);
      return { kind: 'choice', value: p?.mode ?? 'add' };
    }
    case 'maskInverted': {
      const p = readNodeMask(node)?.paths.find((x) => x.id === b.maskId);
      return { kind: 'bool', value: p?.inverted === true };
    }
    case 'effectParam': {
      const e = getNodeEffects(layerId).find((x) => x.id === b.effectId);
      const v = e ? paramsOf(e)[b.paramKey!] : undefined;
      const def = e ? effectDefFor(e.type)?.params.find((p) => p.key === b.paramKey) : undefined;
      if (b.valueType === 'bool') return { kind: 'bool', value: v === true || v === 1 };
      if (b.valueType === 'choice') {
        const opt = def?.options?.find((o) => o.value === v);
        return { kind: 'choice', value: opt?.label ?? String(v ?? '') };
      }
      if (b.valueType === 'layer') return { kind: 'layer', value: typeof v === 'string' ? v : '' };
      if (b.valueType === 'string') return { kind: 'string', value: typeof v === 'string' ? v : '' };
      return { kind: 'json', value: JSON.stringify(v ?? null) };
    }
    case 'field':
    case 'layerFill':
      return readField(node, b);
    case 'rig':
      return readRigStatic(node, b);
    case 'fillStops':
      return readFillStopsStatic(node);
    default: break;
  }
  if (b.colorBase) {
    const c = readColorBase(node, b.colorBase);
    if (c) return { kind: 'color', value: c };
    const ch = b.members.map((m) => readStaticPropertyValue(layerId, m) ?? 0);
    return vectorValue('color', ch);
  }
  if (b.dataTrack) return { kind: 'none' };
  const nums = b.members.map((m, i) => {
    const v = readStaticPropertyValue(layerId, m);
    if (v !== undefined) return v * apiUnitFactor(m);
    const d = b.defaultValue ? numbersOfDefault(b.defaultValue)[i] : undefined;  // already API units
    return d ?? 0;
  });
  return vectorValue(b.valueType, nums);
}

function numbersOfDefault(v: Value): number[] {
  switch (v.kind) {
    case 'scalar': return [v.value];
    case 'vec2': return [v.value.x, v.value.y];
    case 'vec3': return [v.value.x, v.value.y, v.value.z];
    default: return [];
  }
}

/** Write a property's static value (validation done by the caller's type check). */
export function writeStatic(layerId: string, b: PropBinding, value: Value): void {
  const node = nodeOf(layerId);
  switch (b.special) {
    case 'sourceText': {
      if (value.kind !== 'textDocument' && value.kind !== 'string') fail('typeMismatch', `'${b.path}' takes a textDocument`, { path: b.path });
      const text = value.kind === 'string' ? value.value : value.value.text;
      const comp = node.components.find((c) => c.type === 'Text');
      if (!comp) fail('notFound', 'not a text layer', { layer: layerId });
      const before = (comp.props as Record<string, unknown>).content;
      defaultSceneGraph.writeProp(layerId, comp.id, 'content', text);
      // Style runs index the OLD text; a changed text drops them rather than
      // styling the wrong characters (runs through the API arrive in B3).
      if (before !== text && (comp.props as Record<string, unknown>).__runs !== undefined) {
        defaultSceneGraph.writeProp(layerId, comp.id, '__runs', undefined);
      }
      return;
    }
    case 'maskPath':
    case 'maskMode':
    case 'maskInverted': {
      const m = readNodeMask(node) ?? { paths: [] };
      const idx = m.paths.findIndex((x) => x.id === b.maskId);
      if (idx < 0) fail('notFound', `no mask '${b.maskId}'`, { layer: layerId, path: b.path });
      const cur = m.paths[idx]!;
      let next: MaskPath;
      if (b.special === 'maskPath') {
        if (value.kind !== 'path') fail('typeMismatch', `'${b.path}' takes a path`, { path: b.path });
        next = { ...cur, points: bezierToPoints(value.value, cur.points), closed: value.value.closed };
      } else if (b.special === 'maskMode') {
        if (value.kind !== 'choice' || !MASK_MODES.includes(value.value as MaskMode)) fail('typeMismatch', `'${b.path}' takes one of ${MASK_MODES.join(', ')}`, { path: b.path });
        next = { ...cur, mode: value.value as MaskMode };
      } else {
        if (value.kind !== 'bool') fail('typeMismatch', `'${b.path}' takes a bool`, { path: b.path });
        next = { ...cur, inverted: value.value };
      }
      const paths = m.paths.slice();
      paths[idx] = next;
      defaultSceneGraph.setMask(layerId, { paths });
      // Mask mode/inversion hold across every shape keyframe too.
      if (b.special !== 'maskPath') {
        const anim = readNodeMaskAnim(node);
        if (anim.length > 0) {
          defaultSceneGraph.setMaskAnim(layerId, anim.map((k) => ({
            ...k,
            mask: { paths: k.mask.paths.map((p) => (p.id === b.maskId ? { ...p, mode: next.mode, inverted: next.inverted } : p)) },
          })));
        }
      }
      return;
    }
    case 'effectParam': {
      const e = getNodeEffects(layerId).find((x) => x.id === b.effectId);
      if (!e) fail('notFound', `no effect '${b.effectId}'`, { layer: layerId, path: b.path });
      const def = effectDefFor(e.type)?.params.find((p) => p.key === b.paramKey);
      let v: unknown;
      if (b.valueType === 'bool') {
        if (value.kind !== 'bool') fail('typeMismatch', `'${b.path}' takes a bool`, { path: b.path });
        v = value.value;
      } else if (b.valueType === 'choice') {
        if (value.kind !== 'choice') fail('typeMismatch', `'${b.path}' takes a choice`, { path: b.path });
        const opt = def?.options?.find((o) => o.label === value.value);
        if (!opt) fail('outOfRange', `'${value.value}' is not a choice of '${b.path}'`, { path: b.path, detail: JSON.stringify({ choices: b.choices }) });
        v = opt.value;
      } else if (b.valueType === 'layer') {
        if (value.kind !== 'layer') fail('typeMismatch', `'${b.path}' takes a layer`, { path: b.path });
        v = value.value;
      } else if (b.valueType === 'string') {
        if (value.kind !== 'string') fail('typeMismatch', `'${b.path}' takes a string`, { path: b.path });
        v = value.value;
      } else {
        if (value.kind !== 'json') fail('typeMismatch', `'${b.path}' takes json`, { path: b.path });
        try { v = JSON.parse(value.value); } catch { fail('invalidArgument', 'invalid json', { path: b.path }); }
      }
      updateEffectParam(layerId, b.effectId!, b.paramKey!, v as never);
      return;
    }
    case 'field':
    case 'layerFill':
      writeField(layerId, node, b, value);
      return;
    case 'rig':
      writeRigStatic(layerId, node, b, value);
      return;
    case 'fillStops':
      writeFillStopsStatic(layerId, node, b, value, setPrimaryFill);
      return;
    default: break;
  }
  if (b.dataTrack) fail('unsupported', `'${b.path}' has no static value in this engine; key it instead`, { path: b.path });
  if (b.colorBase) {
    if (value.kind !== 'color') fail('typeMismatch', `'${b.path}' takes a color`, { path: b.path });
    if (!writeColorBase(node, b.colorBase, value.value)) fail('notFound', `nowhere to store '${b.path}'`, { path: b.path });
    return;
  }
  const nums = fromApiNums(b, numbersOf(b, value));
  for (let i = 0; i < nums.length; i++) {
    const m = b.members[i]!;
    if (!writeStaticPropertyValue(layerId, m, nums[i]!)) {
      // A member no component carries yet: its HOME takes it (a latent
      // binding's, latentPropSpecs.ts), else the Transform component.
      const homes = b.home ?? ['Transform'];
      const t = homes.map((type) => node.components.find((c) => c.type === type)).find((c) => c !== undefined);
      if (!t) fail('notFound', `nowhere to store '${b.path}'`, { path: b.path });
      defaultSceneGraph.writeProp(layerId, t.id, m, nums[i]);
    }
  }
}

// ── Keyframes ────────────────────────────────────────────────────────

/** A keyframe as the engine sees one property: one entry per time, values per member. */
export interface KeyAt {
  /** Stored (keyframe-axis) seconds. */
  t: number;
  id: string;
  value: Value;
  easing: Easing;
  bezier?: [number, number, number, number];
  continuous: boolean;
  roving: boolean;
  spatialInterp: SpatialInterp;
  spatialIn: number[];
  spatialOut: number[];
  label: number;
  /** Per-dimension temporal interpolation when the dimensions differ (Keyframe.dims); empty = uniform. */
  dims: KeyDimAt[];
}

/** One dimension's temporal fields (the API's KeyframeDim). */
export interface KeyDimAt {
  easing: Easing;
  bezier?: [number, number, number, number];
  continuous: boolean;
}

function dimOf(k: TsKeyframe | undefined, lead: TsKeyframe): KeyDimAt {
  const src = k ?? lead;
  return {
    easing: toEasing(src.easing),
    ...(src.bezier ? { bezier: [...src.bezier] as [number, number, number, number] } : {}),
    continuous: src.continuous === true,
  };
}

function sameDim(a: KeyDimAt, b: KeyDimAt): boolean {
  if (a.easing !== b.easing || a.continuous !== b.continuous) return false;
  if (!a.bezier || !b.bezier) return !a.bezier && !b.bezier;
  return a.bezier.every((x, i) => x === b.bezier![i]);
}

/** The positional fallback id for a key that has no stable id yet (legacy / pre-API writes). */
export function fallbackKeyId(layerId: string, member: string, t: number): string {
  return `@${layerId}|${member}|${t}`;
}

export function parseFallbackKeyId(id: string): { layer: string; member: string; t: number } | null {
  const m = /^@(.+)\|(.+)\|(-?[0-9.eE+-]+)$/.exec(id);
  if (!m) return null;
  const t = Number(m[3]);
  return Number.isFinite(t) ? { layer: m[1]!, member: m[2]!, t } : null;
}

const toEasing = (e: EasingKind | undefined): Easing => (e ?? 'linear') as Easing;
const toSpatial = (s: TsSpatialInterp | undefined): SpatialInterp => (s ?? 'legacy') as SpatialInterp;

function sampleMember(layerId: string, prop: string, t: number, fallback: number): number {
  const kfs = defaultAnimation.getTrackKeyframes(layerId, prop);
  if (!kfs || kfs.length === 0) return fallback;
  return sampleTrack({ nodeId: layerId, prop, keyframes: kfs }, t) ?? fallback;
}

/** Whether a property is animated (any member track / data track / mask shape keys). */
export function isAnimated(layerId: string, b: PropBinding): boolean {
  if (b.special === 'maskPath') return readNodeMaskAnim(nodeOf(layerId)).length > 0;
  if (b.dataTrack) return defaultAnimation.isDataAnimated(layerId, b.dataTrack);
  return b.members.some((m) => defaultAnimation.isAnimated(layerId, m));
}

/** The property's keys, one per time, in stored-time order. */
export function readKeys(layerId: string, b: PropBinding): KeyAt[] {
  if (b.special === 'maskPath') {
    return readNodeMaskAnim(nodeOf(layerId)).map((k) => {
      const p = k.mask.paths.find((x) => x.id === b.maskId);
      return baseKey(k.t, maskKeyId(layerId, k, b.maskId!), p ? { kind: 'path', value: maskToBezier(p) } : { kind: 'none' }, k as unknown as DataKeyframe);
    });
  }
  if (b.dataTrack) {
    const track = defaultAnimation.getDataTrack(layerId, b.dataTrack);
    return (track?.keyframes ?? []).map((k) => {
      const key = baseKey(k.t, k.id ?? fallbackKeyId(layerId, b.dataTrack!, k.t), dataValueToApi(b, k.value, layerId), k);
      // A puppet pin's position key: its spatial tangents are the data key's si/so of point 0.
      return b.special === 'rig' ? { ...key, ...pinKeySpatial(k) } : key;
    });
  }
  const tracks = b.members.map((m) => defaultAnimation.getTrackKeyframes(layerId, m) ?? []);
  const times = new Set<number>();
  for (const t of tracks) for (const k of t) times.add(k.t);
  const sorted = [...times].sort((x, y) => x - y);
  const stat = readStatic(layerId, b);
  // Stored units below; converted to API units once per key (toApiNums).
  const statNums = stat.kind === 'none' ? [] : fromApiNums(b, numbersOfLoose(stat));
  return sorted.map((t) => {
    let lead: TsKeyframe | undefined;
    let leadMember = b.members[0]!;
    const nums = b.members.map((m, i) => {
      const k = tracks[i]!.find((x) => x.t === t);
      if (k && !lead) { lead = k; leadMember = m; }
      return k ? k.value : sampleMember(layerId, m, t, statNums[i] ?? 0);
    });
    const l = lead!;
    const spatialIn: number[] = [];
    const spatialOut: number[] = [];
    let anySpatial = false;
    const dims: KeyDimAt[] = [];
    b.members.forEach((_m, i) => {
      const k = tracks[i]!.find((x) => x.t === t);
      spatialIn.push(k?.si ?? 0);
      spatialOut.push(k?.so ?? 0);
      if (k?.si !== undefined || k?.so !== undefined) anySpatial = true;
      dims.push(dimOf(k, l));
    });
    const uniform = dims.every((d) => sameDim(d, dims[0]!));
    return {
      t,
      id: l.id ?? fallbackKeyId(layerId, leadMember, t),
      value: vectorValue(b.valueType, toApiNums(b, nums)),
      easing: toEasing(l.easing),
      ...(l.bezier ? { bezier: [...l.bezier] as [number, number, number, number] } : {}),
      continuous: l.continuous === true,
      roving: l.roving === true,
      spatialInterp: toSpatial(l.spatialInterp),
      spatialIn: anySpatial ? spatialIn : [],
      spatialOut: anySpatial ? spatialOut : [],
      label: l.label ?? 0,
      dims: uniform ? [] : dims,
    };
  });
}

function numbersOfLoose(v: Value): number[] {
  switch (v.kind) {
    case 'scalar': case 'int': return [v.value];
    case 'bool': return [v.value ? 1 : 0];
    case 'vec2': return [v.value.x, v.value.y];
    case 'vec3': return [v.value.x, v.value.y, v.value.z];
    case 'vec4': return [v.value.x, v.value.y, v.value.z, v.value.w];
    case 'color': return [v.value.r, v.value.g, v.value.b, v.value.a];
    default: return [];
  }
}

function baseKey(t: number, id: string, value: Value, k: { easing?: EasingKind; bezier?: [number, number, number, number]; label?: number }): KeyAt {
  return {
    t, id, value,
    easing: toEasing(k.easing),
    ...(k.bezier ? { bezier: [...k.bezier] as [number, number, number, number] } : {}),
    continuous: false, roving: false, spatialInterp: 'legacy', spatialIn: [], spatialOut: [], label: k.label ?? 0, dims: [],
  };
}

export function maskKeyId(layerId: string, k: MaskKeyframe, maskId: string): string {
  const id = (k as MaskKeyframe & { id?: string }).id;
  return id ? `${id}@${maskId}` : fallbackKeyId(layerId, `mask:${maskId}`, k.t);
}

function dataValueToApi(b: PropBinding, v: unknown, layerId?: string): Value {
  if (b.special === 'rig') return pinKeyToApi(v);
  if (b.special === 'fillStops') return fillStopsKeyToApi(nodeOf(layerId!), v);
  if (b.special === 'sourceText') {
    return { kind: 'textDocument', value: { text: typeof v === 'string' ? v : '', runs: [], paragraphs: [], orientation: 'horizontal', kerning: 'metrics' } };
  }
  if (typeof v === 'string') return { kind: 'string', value: v };
  if (typeof v === 'number') return { kind: 'scalar', value: v };
  if (Array.isArray(v) && v.length > 0 && typeof (v[0] as { x?: unknown }).x === 'number') {
    const pts = v as Array<{ x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }>;
    return { kind: 'path', value: {
      vertices: pts.flatMap((p) => [p.x, p.y]),
      inTangents: pts.flatMap((p) => [(p.inX ?? p.x) - p.x, (p.inY ?? p.y) - p.y]),
      outTangents: pts.flatMap((p) => [(p.outX ?? p.x) - p.x, (p.outY ?? p.y) - p.y]),
      closed: false, featherPoints: [],
    } };
  }
  return { kind: 'json', value: JSON.stringify(v ?? null) };
}

/** API value → a data keyframe value for this property's data track. */
export function apiToDataValue(b: PropBinding, value: Value): unknown {
  if (b.special === 'rig') return apiToPinKey(b, value);
  if (b.special === 'fillStops') return apiToFillStopsKey(b, value);
  if (b.special === 'sourceText') {
    if (value.kind === 'textDocument') return value.value.text;
    if (value.kind === 'string') return value.value;
    fail('typeMismatch', `'${b.path}' takes a textDocument`, { path: b.path });
  }
  switch (value.kind) {
    case 'string': return value.value;
    case 'scalar': return value.value;
    case 'path': return bezierToPoints(value.value).map((p) => ({ x: p.x, y: p.y, inX: p.inX, inY: p.inY, outX: p.outX, outY: p.outY }));
    case 'json': try { return JSON.parse(value.value); } catch { return fail('invalidArgument', 'invalid json', { path: b.path }); }
    default: return fail('typeMismatch', `'${b.path}' cannot take a ${value.kind}`, { path: b.path });
  }
}

/** Stored seconds → API flicks (comp time). */
export function keyTimeToFlicks(layerId: string, b: PropBinding, t: number): number {
  return secondsToFlicks(keyframeToCompTime(layerId, t, b.members[0] ?? b.dataTrack));
}

/** API flicks (comp time) → stored seconds on the property's keyframe axis. */
export function flicksToKeyTime(layerId: string, b: PropBinding, flicks: number): number {
  return compToKeyframeTime(layerId, flicksToSeconds(flicks), b.members[0] ?? b.dataTrack);
}

export function keyAtToApi(layerId: string, b: PropBinding, k: KeyAt): Keyframe {
  return {
    id: k.id,
    time: keyTimeToFlicks(layerId, b, k.t),
    value: k.value,
    easing: k.easing,
    ...(k.bezier ? { bezier: { x1: k.bezier[0], y1: k.bezier[1], x2: k.bezier[2], y2: k.bezier[3] } } : {}),
    continuous: k.continuous,
    roving: k.roving,
    spatialInterp: k.spatialInterp,
    spatialIn: k.spatialIn,
    spatialOut: k.spatialOut,
    label: k.label,
    dims: k.dims.map((d) => ({
      easing: d.easing,
      ...(d.bezier ? { bezier: { x1: d.bezier[0], y1: d.bezier[1], x2: d.bezier[2], y2: d.bezier[3] } } : {}),
      continuous: d.continuous,
    })),
  };
}

// ── Keyframe writes (all go through these) ───────────────────────────

/** One key to put on a property, in stored seconds. `id` is kept when replacing. */
export interface KeyWrite {
  t: number;
  id: string;
  value?: Value;
  easing?: Easing;
  bezier?: [number, number, number, number] | null;
  continuous?: boolean;
  roving?: boolean;
  spatialInterp?: SpatialInterp;
  spatialIn?: number[] | null;
  spatialOut?: number[] | null;
  label?: number;
  /**
   * Per-dimension temporal fields (Keyframe.dims): member i takes dims[i]'s easing,
   * handles (absent = cleared) and continuity instead of `easing` / `bezier` /
   * `continuous`. Ignored unless it has one entry per member.
   */
  dims?: ReadonlyArray<{ easing: Easing; bezier?: [number, number, number, number]; continuous: boolean }>;
  /** KeyframePatch.dim: `easing` / `bezier` / `continuous` reach only this member. */
  dim?: number;
}

const toTsEasing = (e: Easing): EasingKind => e as EasingKind;
const toTsSpatial = (s: SpatialInterp): TsSpatialInterp | undefined => (s === 'legacy' ? undefined : (s as TsSpatialInterp));

function applyKeyFields<T extends { easing?: EasingKind; bezier?: [number, number, number, number]; label?: number }>(k: T, w: KeyWrite): T {
  const out = { ...k };
  if (w.easing !== undefined) out.easing = toTsEasing(w.easing);
  if (w.bezier === null) delete out.bezier;
  else if (w.bezier) out.bezier = [...w.bezier];
  if (w.label !== undefined) {
    if (w.label) out.label = w.label;
    else delete out.label;
  }
  return out;
}

/**
 * Put keys on a property, replacing a key at the same stored time (the replaced
 * key's fields survive unless the write sets them). Values are given in full;
 * absent `value` = the property's evaluated value at that time.
 */
export function putKeys(layerId: string, b: PropBinding, writes: KeyWrite[]): void {
  if (writes.length === 0) return;
  if (b.special === 'maskPath') return putMaskKeys(layerId, b, writes);
  if (b.dataTrack) {
    const track = defaultAnimation.getDataTrack(layerId, b.dataTrack);
    const kind = track?.kind ?? (b.special === 'sourceText' ? 'text' : b.valueType === 'path' || b.special === 'rig' ? 'points' : b.valueType === 'gradient' ? 'gradientStops' : 'number');
    let keys: DataKeyframe[] = track ? track.keyframes.map((k) => ({ ...k })) : [];
    for (const w of writes) {
      const existing = keys.find((k) => k.t === w.t);
      const value = w.value ? apiToDataValue(b, w.value) : existing?.value ?? currentDataValue(layerId, b, w.t);
      const base: DataKeyframe = existing ? { ...existing } : { t: w.t, value: value as DataKeyframe['value'] };
      const next = applyKeyFields({ ...base, id: existing?.id ?? w.id, t: w.t, value: value as DataKeyframe['value'] }, w);
      if (b.special === 'rig') {
        // A pin's spatial tangents: per-dimension API lists ⇄ the data key's si/so of point 0.
        if (w.spatialIn === null) delete next.si;
        else if (w.spatialIn && w.spatialIn.length >= 2) next.si = [{ x: w.spatialIn[0]!, y: w.spatialIn[1]! }];
        if (w.spatialOut === null) delete next.so;
        else if (w.spatialOut && w.spatialOut.length >= 2) next.so = [{ x: w.spatialOut[0]!, y: w.spatialOut[1]! }];
      }
      keys = keys.filter((k) => k.t !== w.t).concat(next);
    }
    keys.sort((x, y) => x.t - y.t);
    defaultAnimation.setDataTrack(layerId, b.dataTrack, { nodeId: layerId, prop: b.dataTrack, kind, keyframes: keys });
    return;
  }
  if (b.members.length === 0) fail('notAnimatable', `'${b.path}' cannot take keyframes`, { path: b.path });
  const tracks = b.members.map((m) => (defaultAnimation.getTrackKeyframes(layerId, m) ?? []).map((k) => ({ ...k })));
  const perDim = (w: KeyWrite): boolean => !!w.dims && w.dims.length === b.members.length;
  for (const w of writes) {
    const nums = w.value
      ? (b.colorBase && w.value.kind !== 'color' ? fail('typeMismatch', `'${b.path}' takes a color`, { path: b.path }) : fromApiNums(b, numbersOf(b, w.value)))
      : null;
    // ONE key per time for every member (ENGINE_API.md §3.3): a member with no
    // key here (a lone member key of a legacy document) gets one, carrying the
    // keyed member's temporal fields — the whole key the API reported.
    const lead = tracks.map((list) => list.find((k) => k.t === w.t)).find((k) => k !== undefined);
    b.members.forEach((m, i) => {
      const list = tracks[i]!;
      const existing = list.find((k) => k.t === w.t);
      const v = nums ? nums[i] ?? existing?.value ?? 0 : existing?.value ?? sampleMember(layerId, m, w.t, staticNum(layerId, b, i));
      let next: TsKeyframe = existing ? { ...existing, value: v } : lead ? fillFrom(lead, w.t, v) : { t: w.t, value: v };
      const id = existing?.id ?? lead?.id ?? w.id;
      if (id) next.id = id;
      else delete next.id;
      if (w.dim === undefined || w.dim === i) {
        next = applyKeyFields(next, w);
        if (w.continuous !== undefined) next.continuous = w.continuous;
      } else if (w.label !== undefined) {
        next = applyKeyFields(next, { t: w.t, id: w.id, label: w.label });
      }
      if (perDim(w)) {
        const d = w.dims![i]!;
        next.easing = toTsEasing(d.easing);
        if (d.bezier) next.bezier = [...d.bezier];
        else delete next.bezier;
        next.continuous = d.continuous;
      }
      if (w.roving !== undefined) next.roving = w.roving;
      if (w.spatialInterp !== undefined) {
        const s = toTsSpatial(w.spatialInterp);
        if (s) next.spatialInterp = s;
        else delete next.spatialInterp;
      }
      if (w.spatialIn === null) delete next.si;
      else if (w.spatialIn && w.spatialIn.length > 0) next.si = w.spatialIn[i] ?? 0;
      if (w.spatialOut === null) delete next.so;
      else if (w.spatialOut && w.spatialOut.length > 0) next.so = w.spatialOut[i] ?? 0;
      tracks[i] = list.filter((k) => k.t !== w.t).concat(next).sort((x, y) => x.t - y.t);
    });
  }
  b.members.forEach((m, i) => defaultAnimation.setTrackKeyframes(layerId, m, tracks[i]!));
}

/** A member key filled in beside `lead` (the key the other members have at `t`): its temporal fields, this value. */
function fillFrom(lead: TsKeyframe, t: number, value: number): TsKeyframe {
  const k: TsKeyframe = { t, value };
  if (lead.easing !== undefined) k.easing = lead.easing;
  if (lead.bezier) k.bezier = [...lead.bezier];
  if (lead.continuous !== undefined) k.continuous = lead.continuous;
  if (lead.roving !== undefined) k.roving = lead.roving;
  if (lead.spatialInterp !== undefined) k.spatialInterp = lead.spatialInterp;
  if (lead.label !== undefined) k.label = lead.label;
  return k;
}

/**
 * Give every member a key at each of `times` where another member has one
 * (putKeys' fill, with no field written) — before a command moves those keys,
 * so the whole key moves (ENGINE_API.md §3.3).
 */
export function normalizeKeysAt(layerId: string, b: PropBinding, times: readonly number[]): void {
  if (b.members.length < 2 || b.special === 'maskPath' || b.dataTrack) return;
  const tracks = b.members.map((m) => defaultAnimation.getTrackKeyframes(layerId, m) ?? []);
  const lone = times.filter((t) => tracks.some((tr) => tr.some((k) => k.t === t)) && tracks.some((tr) => !tr.some((k) => k.t === t)));
  if (lone.length === 0) return;
  putKeys(layerId, b, lone.map((t) => ({ t, id: '' })));
}

function staticNum(layerId: string, b: PropBinding, i: number): number {
  // The layer's fill colour is a hex string on a component (or a paint object):
  // its channels have no numeric static seam.
  if (b.special === 'layerFill') return numbersOfLoose(readStatic(layerId, b))[i] ?? 0;
  // A rig property's static value lives on the rig (rigProps.ts), in API units.
  if (b.special === 'rig') return (numbersOfLoose(readStatic(layerId, b))[i] ?? 0) / apiUnitFactor(b.members[i]);
  const v = readStaticPropertyValue(layerId, b.members[i]!);
  return v ?? 0;
}

function currentDataValue(layerId: string, b: PropBinding, t: number): unknown {
  const v = defaultAnimation.sampleData(layerId, b.dataTrack!, t);
  if (v !== undefined) return v;
  if (b.special === 'sourceText') {
    const s = readStatic(layerId, b);
    return s.kind === 'textDocument' ? s.value.text : '';
  }
  // The first Colors key holds the paint's own stops.
  if (b.special === 'fillStops') return apiToFillStopsKey(b, readStatic(layerId, b));
  return fail('invalidArgument', `'${b.path}' needs a value for its first keyframe`, { path: b.path });
}

/** Remove the keys at these stored times. Removing the last key leaves the static value at it. */
export function dropKeys(layerId: string, b: PropBinding, times: number[]): void {
  if (times.length === 0) return;
  const drop = new Set(times);
  if (b.special === 'maskPath') {
    const node = nodeOf(layerId);
    const anim = readNodeMaskAnim(node);
    const keep = anim.filter((k) => !drop.has(k.t));
    if (keep.length === 0 && anim.length > 0) {
      // The shape at the last key becomes the static mask.
      const last = anim.find((k) => drop.has(k.t));
      if (last) defaultSceneGraph.setMask(layerId, structuredClone(last.mask));
    }
    defaultSceneGraph.setMaskAnim(layerId, keep.length > 0 ? keep : undefined);
    return;
  }
  if (b.dataTrack) {
    const track = defaultAnimation.getDataTrack(layerId, b.dataTrack);
    if (!track) return;
    const keep = track.keyframes.filter((k) => !drop.has(k.t));
    if (keep.length === 0 && b.special === 'sourceText') {
      const last = track.keyframes.find((k) => drop.has(k.t));
      if (last && typeof last.value === 'string') writeStatic(layerId, b, { kind: 'string', value: last.value });
    }
    if (keep.length === 0 && b.special === 'rig') {
      // AE: deleting a pin's last Position key leaves the pin where that key held it.
      const last = track.keyframes.find((k) => drop.has(k.t));
      if (last) writeStatic(layerId, b, pinKeyToApi(last.value));
    }
    if (keep.length === 0 && b.special === 'fillStops') {
      // AE: deleting the last Colors key leaves the gradient at that key's stops.
      const last = track.keyframes.find((k) => drop.has(k.t));
      const paint = nodeOf(layerId).components.find((c) => c.type === 'fx')?.props.fill as { type?: unknown } | undefined;
      if (last && (paint?.type === 'linear' || paint?.type === 'radial')) writeStatic(layerId, b, fillStopsKeyToApi(nodeOf(layerId), last.value));
    }
    defaultAnimation.setDataTrack(layerId, b.dataTrack, keep.length > 0 ? { ...track, keyframes: keep } : null);
    return;
  }
  const lastValues: number[] = [];
  let emptied = false;
  b.members.forEach((m, i) => {
    const kfs = defaultAnimation.getTrackKeyframes(layerId, m) ?? [];
    const keep = kfs.filter((k) => !drop.has(k.t));
    if (keep.length === 0 && kfs.length > 0) {
      emptied = true;
      lastValues[i] = kfs.find((k) => drop.has(k.t))!.value;
    }
    defaultAnimation.setTrackKeyframes(layerId, m, keep.length > 0 ? keep : null);
  });
  if (emptied && b.special === 'rig') {
    // AE: static at the last key's value — written on the rig (a bone's pose, an IK goal).
    const stat = numbersOfLoose(readStatic(layerId, b));
    const nums = b.members.map((m, i) => (lastValues[i] !== undefined ? lastValues[i]! * apiUnitFactor(m) : stat[i] ?? 0));
    writeStatic(layerId, b, vectorValue(b.valueType, nums));
  } else if (emptied && !b.colorBase) {
    // AE: deleting the last key leaves the property static at that key's value.
    b.members.forEach((m, i) => {
      if (lastValues[i] !== undefined) writeStaticPropertyValue(layerId, m, lastValues[i]!);
    });
  } else if (emptied && b.colorBase) {
    const c = lastValues;
    const color: Color = { r: c[0] ?? 0, g: c[1] ?? 0, b: c[2] ?? 0, a: c[3] ?? 1 };
    if (b.special === 'layerFill') writeField(layerId, nodeOf(layerId), b, { kind: 'color', value: color });
    else writeColorBase(nodeOf(layerId), b.colorBase, color);
  }
}

function putMaskKeys(layerId: string, b: PropBinding, writes: KeyWrite[]): void {
  const node = nodeOf(layerId);
  const staticMask: LayerMask = readNodeMask(node) ?? { paths: [] };
  let anim = readNodeMaskAnim(node).map((k) => ({ ...k }));
  for (const w of writes) {
    const existing = anim.find((k) => k.t === w.t);
    const baseMask: LayerMask = existing ? existing.mask : interpolateAt(anim, w.t) ?? staticMask;
    let mask: LayerMask = structuredClone(baseMask);
    if (w.value) {
      if (w.value.kind !== 'path') fail('typeMismatch', `'${b.path}' takes a path`, { path: b.path });
      const pts = w.value.value;
      mask = { paths: mask.paths.map((p) => (p.id === b.maskId ? { ...p, points: bezierToPoints(pts, p.points), closed: pts.closed } : p)) };
      if (!mask.paths.some((p) => p.id === b.maskId)) fail('notFound', `no mask '${b.maskId}'`, { path: b.path });
    }
    const entryId = (existing as { id?: string } | undefined)?.id ?? w.id.split('@')[0]!;
    const next = { ...(existing ?? {}), t: w.t, mask, id: entryId } as MaskKeyframe & { id: string };
    anim = anim.filter((k) => k.t !== w.t).concat(next);
  }
  anim.sort((x, y) => x.t - y.t);
  defaultSceneGraph.setMaskAnim(layerId, anim);
}

function interpolateAt(anim: MaskKeyframe[], t: number): LayerMask | undefined {
  if (anim.length === 0) return undefined;
  const before = [...anim].filter((k) => k.t <= t).pop();
  return (before ?? anim[0]!).mask;
}
