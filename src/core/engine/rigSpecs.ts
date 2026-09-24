/**
 * RIG PROPERTIES (B3z WS-R) — puppet pins and skeletons as engine-API property
 * groups and properties (ENGINE_API.md §15.9 "Rigging — puppet and skeleton
 * paths"). After Effects' Puppet effect is the reference for the puppet; the
 * skeleton (Premation-only, Duik-like) follows the same conventions.
 *
 * This module is DATA shared by both engines: the TypeScript catalog
 * (`src/core/engine/rigProps.ts`) reads it directly, the C++ catalog
 * (`native/engine/src/core/rig.cpp`) reads the copy `crossEngineCatalog.test.ts`
 * generates into catalog_data.inc. Pure — no scene graph, no stores. Row ORDER
 * is the order both engines add the bindings in (the property tree is compared
 * across engines).
 *
 * Storage is the document's as it has always been: `fx.puppet` / `fx.skeleton`
 * and the `puppet.<pin>.*`, `bone.<id>.*`, `ikTarget.<id>.*`, `ikPole.<id>.*`,
 * `ikMode.<id>` keyframe tracks. `{id}` in a track name is the owner's id (the
 * pin, the bone; an IK goal's id is its bone's).
 */

/** Which object a rig property lives on. */
export type RigOwner = 'layer' | 'puppet' | 'pin' | 'skeleton' | 'bone' | 'ik' | 'controller';

/**
 * How a property's static value is stored on its owner object.
 *
 *   number     `owner[key]` — a number (absent = default)
 *   xy         `owner[keys[0]]`, `owner[keys[1]]` → vec2
 *   point      `owner[key]` = `{x, y}` → vec2 (absent = default)
 *   pinPosition `pin.position` = `{x, y}`, absent = the rest anchor `pin.x/y`
 *   choice     `owner[key]` — a string in `choices` (absent = default)
 *   string     `owner[key]` — a string (absent = '')
 *   parent     `bone.parentId` — a bone id or null (`''` in the API)
 *   json       `owner[key]` — any JSON (null = absent)
 *   ikMode     `target.ikMode` — `'fk'` = 0, anything else = 1
 *   bind       the bone's `bindPose` entry `keys` (absent entry = the bone itself)
 *   wholeRig   `fx[key]` — the whole rig (json object; null = none). A write drops
 *              the keyframe tracks of the pins / bones the new rig no longer has.
 *
 * A key may be a dotted path into a nested object (`link.kind`).
 */
export type RigCodec = 'number' | 'xy' | 'point' | 'pinPosition' | 'choice' | 'string' | 'parent' | 'json' | 'ikMode' | 'bind' | 'wholeRig';

export interface RigPropSpec {
  owner: RigOwner;
  /** Path under the owner's group (`position`, `mesh/density`). */
  path: string;
  label: string;
  matchName: string;
  type: 'scalar' | 'vec2' | 'choice' | 'string' | 'json';
  codec: RigCodec;
  /** Storage keys on the owner (one, or two for `xy` / a vec2 `bind`). */
  keys: readonly string[];
  /** Keyframe tracks behind an animatable value, in dimension order (`{id}` = the owner id). */
  tracks?: readonly string[];
  /** A data (points) track instead (`puppet.{id}.position`). */
  dataTrack?: string;
  /** The value an absent field reads as, in STORED units (API = stored × scale). */
  default: number | string | readonly number[] | null;
  /**
   * API unit = stored × this: `percent` ×100 (a multiplier stored as 1 = 100 %),
   * `radians` ×180/π (a bone's rotation is stored in radians, the API speaks
   * degrees — ENGINE_API.md §3.5).
   */
  scale?: 'percent' | 'radians';
  /** API unit label. */
  unit?: string;
  /** API-unit bounds; a static write outside is `outOfRange`. */
  min?: number;
  max?: number;
  choices?: readonly string[];
  /** Writing the default removes the stored key. */
  clearAtDefault?: boolean;
  /** Exists only once added (`addProperties` / `removeProperties`). */
  optional?: boolean;
  /**
   * A STATIC write captures the skeleton's bind pose first when it has none
   * (skeletonCommands `captureBindPose`): posing without keyframes must deform,
   * not drag the rest pose along.
   */
  poseCapture?: boolean;
}

export const RIG_MESH_DENSITY_DEFAULT = 22;

const MESH_MODES = ['grid', 'silhouette'] as const;

export const RIG_PROPS: readonly RigPropSpec[] = [
  // ── Whole rigs (a rig preset, an AI rig): `layer/puppet`, `layer/skeleton` on every layer that can deform ──
  { owner: 'layer', path: 'puppet', label: 'Puppet', matchName: 'Premation Puppet Rig', type: 'json', codec: 'wholeRig', keys: ['puppet'], default: null },
  { owner: 'layer', path: 'skeleton', label: 'Skeleton', matchName: 'Premation Skeleton Rig', type: 'json', codec: 'wholeRig', keys: ['skeleton'], default: null },
  // ── Puppet (AE: Puppet effect ▸ Mesh) ──
  { owner: 'puppet', path: 'mesh/density', label: 'Density', matchName: 'ADBE FreePin3 Mesh Density', type: 'scalar', codec: 'number', keys: ['meshDensity'], default: RIG_MESH_DENSITY_DEFAULT, min: 1 },
  { owner: 'puppet', path: 'mesh/expansion', label: 'Expansion', matchName: 'ADBE FreePin3 Mesh Expansion', type: 'scalar', codec: 'number', keys: ['meshExpansion'], default: 0, unit: 'px' },
  { owner: 'puppet', path: 'mesh/mode', label: 'Mesh', matchName: 'Premation Puppet Mesh Mode', type: 'choice', codec: 'choice', keys: ['meshMode'], default: 'grid', choices: MESH_MODES },
  { owner: 'puppet', path: 'mesh/solver', label: 'Solver', matchName: 'Premation Puppet Solver', type: 'choice', codec: 'choice', keys: ['solver'], default: 'arap', choices: ['arap', 'lbs'] },
  { owner: 'puppet', path: 'mesh/rotationRefinement', label: 'Mesh Rotation Refinement', matchName: 'ADBE FreePin3 Mesh Rotation Refinement', type: 'scalar', codec: 'number', keys: ['maxRotationDeg'], default: 0, min: 0, unit: '°', clearAtDefault: true },
  // ── Puppet pin (AE: Deform ▸ Puppet Pin N) ──
  { owner: 'pin', path: 'position', label: 'Position', matchName: 'ADBE FreePin3 PosPin Position', type: 'vec2', codec: 'pinPosition', keys: ['position'], dataTrack: 'puppet.{id}.position', default: [0, 0], unit: 'px' },
  { owner: 'pin', path: 'rotation', label: 'Rotation', matchName: 'ADBE FreePin3 PosPin Rotation', type: 'scalar', codec: 'number', keys: ['rotation'], tracks: ['puppet.{id}.rotation'], default: 0, unit: '°' },
  { owner: 'pin', path: 'scale', label: 'Scale', matchName: 'ADBE FreePin3 PosPin Scale', type: 'scalar', codec: 'number', keys: ['scale'], tracks: ['puppet.{id}.scale'], default: 1, scale: 'percent', unit: '%' },
  { owner: 'pin', path: 'stiffness', label: 'Amount', matchName: 'ADBE FreePin3 Stiffness Amount', type: 'scalar', codec: 'number', keys: ['stiffness'], tracks: ['puppet.{id}.stiffness'], default: 0, min: 0 },
  { owner: 'pin', path: 'overlap', label: 'In Front', matchName: 'ADBE FreePin3 PosPin Overlap', type: 'scalar', codec: 'number', keys: ['overlap'], tracks: ['puppet.{id}.overlap'], default: 0, min: -100, max: 100, clearAtDefault: true },
  { owner: 'pin', path: 'overlapExtent', label: 'Extent', matchName: 'ADBE FreePin3 PosPin Overlap Extent', type: 'scalar', codec: 'number', keys: ['overlapExtent'], default: 1, min: 0.05 },
  { owner: 'pin', path: 'kind', label: 'Pin Type', matchName: 'Premation Puppet Pin Type', type: 'choice', codec: 'choice', keys: ['kind'], default: 'advanced', choices: ['position', 'starch', 'bend', 'advanced', 'overlap'] },
  { owner: 'pin', path: 'restPosition', label: 'Rest Position', matchName: 'Premation Puppet Pin Rest', type: 'vec2', codec: 'xy', keys: ['x', 'y'], default: [0, 0], unit: 'px' },
  // ── Skeleton ──
  { owner: 'skeleton', path: 'mesh/density', label: 'Density', matchName: 'Premation Skeleton Mesh Density', type: 'scalar', codec: 'number', keys: ['meshDensity'], default: RIG_MESH_DENSITY_DEFAULT, min: 1 },
  { owner: 'skeleton', path: 'mesh/expansion', label: 'Expansion', matchName: 'Premation Skeleton Mesh Expansion', type: 'scalar', codec: 'number', keys: ['meshExpansion'], default: 0, unit: 'px' },
  { owner: 'skeleton', path: 'mesh/mode', label: 'Mesh', matchName: 'Premation Skeleton Mesh Mode', type: 'choice', codec: 'choice', keys: ['meshMode'], default: 'grid', choices: MESH_MODES },
  { owner: 'skeleton', path: 'weightPaint', label: 'Weight Paint', matchName: 'Premation Skeleton Weight Paint', type: 'json', codec: 'json', keys: ['weightPaint'], default: null },
  // ── Bone ──
  { owner: 'bone', path: 'position', label: 'Position', matchName: 'Premation Bone Position', type: 'vec2', codec: 'xy', keys: ['x', 'y'], tracks: ['bone.{id}.x', 'bone.{id}.y'], default: [0, 0], unit: 'px', poseCapture: true },
  { owner: 'bone', path: 'rotation', label: 'Rotation', matchName: 'Premation Bone Rotation', type: 'scalar', codec: 'number', keys: ['rotation'], tracks: ['bone.{id}.rotation'], default: 0, scale: 'radians', unit: '°', poseCapture: true },
  { owner: 'bone', path: 'scale', label: 'Scale', matchName: 'Premation Bone Scale', type: 'vec2', codec: 'xy', keys: ['scaleX', 'scaleY'], tracks: ['bone.{id}.scaleX', 'bone.{id}.scaleY'], default: [1, 1], scale: 'percent', unit: '%', poseCapture: true },
  { owner: 'bone', path: 'parent', label: 'Parent', matchName: 'Premation Bone Parent', type: 'string', codec: 'parent', keys: ['parentId'], default: '' },
  { owner: 'bone', path: 'length', label: 'Length', matchName: 'Premation Bone Length', type: 'scalar', codec: 'number', keys: ['length'], default: 100, min: 1, unit: 'px' },
  { owner: 'bone', path: 'influenceRadius', label: 'Influence Radius', matchName: 'Premation Bone Influence', type: 'scalar', codec: 'number', keys: ['influenceRadius'], default: 0, min: 0, unit: 'px', clearAtDefault: true },
  { owner: 'bone', path: 'restPosition', label: 'Rest Position', matchName: 'Premation Bone Rest Position', type: 'vec2', codec: 'bind', keys: ['x', 'y'], default: [0, 0], unit: 'px' },
  { owner: 'bone', path: 'restRotation', label: 'Rest Rotation', matchName: 'Premation Bone Rest Rotation', type: 'scalar', codec: 'bind', keys: ['rotation'], default: 0, scale: 'radians', unit: '°' },
  { owner: 'bone', path: 'restScale', label: 'Rest Scale', matchName: 'Premation Bone Rest Scale', type: 'vec2', codec: 'bind', keys: ['scaleX', 'scaleY'], default: [1, 1], scale: 'percent', unit: '%' },
  // ── IK goal (a sub-group of its end bone) ──
  { owner: 'ik', path: 'target', label: 'Target', matchName: 'Premation IK Target', type: 'vec2', codec: 'xy', keys: ['x', 'y'], tracks: ['ikTarget.{id}.x', 'ikTarget.{id}.y'], default: [0, 0], unit: 'px', poseCapture: true },
  { owner: 'ik', path: 'pole', label: 'Pole', matchName: 'Premation IK Pole', type: 'vec2', codec: 'point', keys: ['pole'], tracks: ['ikPole.{id}.x', 'ikPole.{id}.y'], default: [0, 0], unit: 'px', optional: true, poseCapture: true },
  { owner: 'ik', path: 'mode', label: 'IK/FK', matchName: 'Premation IK Mode', type: 'scalar', codec: 'ikMode', keys: ['ikMode'], tracks: ['ikMode.{id}'], default: 1, min: 0, max: 1 },
  { owner: 'ik', path: 'chainLength', label: 'Chain Length', matchName: 'Premation IK Chain Length', type: 'scalar', codec: 'number', keys: ['chainLength'], default: 2, min: 1, max: 8 },
  // ── Rig controller ──
  { owner: 'controller', path: 'shape', label: 'Shape', matchName: 'Premation Controller Shape', type: 'choice', codec: 'choice', keys: ['shape'], default: 'circle', choices: ['square', 'circle', 'arrow', 'arc'] },
  { owner: 'controller', path: 'side', label: 'Side', matchName: 'Premation Controller Side', type: 'choice', codec: 'choice', keys: ['side'], default: 'centre', choices: ['left', 'right', 'centre'] },
  { owner: 'controller', path: 'size', label: 'Size', matchName: 'Premation Controller Size', type: 'scalar', codec: 'number', keys: ['size'], default: 14, min: 1, unit: 'px' },
  { owner: 'controller', path: 'offset', label: 'Offset', matchName: 'Premation Controller Offset', type: 'vec2', codec: 'xy', keys: ['offsetX', 'offsetY'], default: [0, 0], unit: 'px', clearAtDefault: true },
  { owner: 'controller', path: 'drives', label: 'Drives', matchName: 'Premation Controller Link', type: 'choice', codec: 'choice', keys: ['link.kind'], default: 'ikTarget', choices: ['bone', 'ikTarget'] },
  { owner: 'controller', path: 'bone', label: 'Bone', matchName: 'Premation Controller Bone', type: 'string', codec: 'string', keys: ['link.boneId'], default: '' },
];

/** The group match names `addPropertyGroup` takes for rig groups. */
export const RIG_GROUP_MATCH = {
  puppet: 'ADBE FreePin3',
  pin: 'ADBE FreePin3 PosPin Atom',
  skeleton: 'Premation Skeleton',
  bone: 'Premation Bone',
  ik: 'Premation IK Goal',
  controller: 'Premation Rig Controller',
} as const;
