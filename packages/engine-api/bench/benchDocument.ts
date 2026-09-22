/**
 * The benchmark payloads — built identically by native/protocol/bench/bench_protocol.cpp
 * (the byte sizes printed by both must match; that is a cross-language check).
 *
 *   setProperty       one drag write (the per-pointer-move message)
 *   dragEvents        the event batch that answers it
 *   docHeaders        getDocument() for a 2000-layer composition, layer headers only
 *   docFull           the same with every layer's 12-property tree + 2 position keyframes
 */

import type { Command, DocumentSnapshot, EventBatch, KeyframeSet, LayerInfo, PropertyInfo, PropertyTree, Value } from '../src/generated/types';

const F = 705_600_000;
const FPF = 23_520_000; // 30 fps

export const layerId = (i: number): string => `layer-${i.toString(16).padStart(30, '0')}`;

const KINDS = ['text', 'shape', 'image'] as const;

type PropSpec = [path: string, name: string, matchName: string, type: 'vec3' | 'vec2' | 'scalar' | 'choice' | 'bool', dims: number];

export const PROPS: PropSpec[] = [
  ['transform/anchorPoint', 'Anchor Point', 'ADBE Anchor Point', 'vec3', 3],
  ['transform/position', 'Position', 'ADBE Position', 'vec3', 3],
  ['transform/scale', 'Scale', 'ADBE Scale', 'vec3', 3],
  ['transform/orientation', 'Orientation', 'ADBE Orientation', 'vec3', 3],
  ['transform/xRotation', 'X Rotation', 'ADBE Rotate X', 'scalar', 1],
  ['transform/yRotation', 'Y Rotation', 'ADBE Rotate Y', 'scalar', 1],
  ['transform/rotation', 'Z Rotation', 'ADBE Rotate Z', 'scalar', 1],
  ['transform/opacity', 'Opacity', 'ADBE Opacity', 'scalar', 1],
  ['material/castsShadows', 'Casts Shadows', 'ADBE Casts Shadows', 'choice', 1],
  ['material/acceptsLights', 'Accepts Lights', 'ADBE Accept Lights', 'bool', 1],
  ['audio/levels', 'Audio Levels', 'ADBE Audio Levels', 'vec2', 2],
  ['timeRemap', 'Time Remap', 'ADBE Time Remapping', 'scalar', 1],
];

function propValue(i: number, t: PropSpec[3]): Value {
  switch (t) {
    case 'vec3':
      return { kind: 'vec3', value: { x: i, y: i * 2, z: 0 } };
    case 'vec2':
      return { kind: 'vec2', value: { x: 0, y: 0 } };
    case 'scalar':
      return { kind: 'scalar', value: 100 };
    case 'choice':
      return { kind: 'choice', value: 'off' };
    case 'bool':
      return { kind: 'bool', value: true };
  }
}

export function makeLayer(i: number): LayerInfo {
  const kind = KINDS[i % 3]!;
  const l: LayerInfo = {
    id: layerId(i),
    comp: 'comp-main',
    kind,
    name: `Layer ${i + 1}`,
    switches: {
      visible: true,
      audioEnabled: false,
      solo: false,
      locked: false,
      shy: false,
      collapse: false,
      quality: 'best',
      effectsEnabled: true,
      motionBlur: i % 5 === 0,
      adjustment: false,
      threeD: i % 7 === 0,
      guide: false,
      frameBlend: 'off',
      autoOrient: 'off',
      preserveTransparency: false,
      label: i % 16,
    },
    timing: { inPoint: i * FPF, outPoint: i * FPF + 10 * F, startTime: i * FPF, stretch: 1, timeRemapEnabled: false, retime: 'normal' },
    blendMode: 'normal',
    matte: { mode: 'none' },
    children: [],
    hasVideo: true,
    hasAudio: false,
    markers: [],
    comment: '',
  };
  if (i % 4 === 3) l.parent = layerId(i - 1);
  if (kind === 'image') l.source = 'item-image';
  return l;
}

export function makeTree(i: number): PropertyTree {
  const nodes: PropertyInfo[] = PROPS.map(([path, name, matchName, type, dims]) => ({
    path,
    name,
    matchName,
    kind: 'property',
    valueType: type,
    animatable: true,
    animated: path === 'transform/position',
    dimensions: dims,
    separated: false,
    enabled: true,
    value: propValue(i, type),
    choices: type === 'choice' ? ['off', 'on', 'only'] : [],
    unit: '',
    expression: '',
    expressionEnabled: false,
    expressionError: '',
    keyframeCount: path === 'transform/position' ? 2 : 0,
    children: [],
    hidden: false,
  }));
  return { layer: layerId(i), nodes };
}

export function makeKeyframes(i: number): KeyframeSet {
  const id = layerId(i);
  return {
    prop: { layer: id, path: 'transform/position' },
    keyframes: [0, 1].map((j) => ({
      id: `${id}/k${j}`,
      time: j * F,
      value: { kind: 'vec3', value: { x: i + j * 100, y: i, z: 0 } },
      easing: 'bezier',
      bezier: { x1: 0.33, y1: 0, x2: 0.67, y2: 1 },
      continuous: false,
      roving: false,
      spatialInterp: 'legacy',
      spatialIn: [],
      spatialOut: [],
      label: 0,
    })),
  };
}

export function makeDocument(n: number, full: boolean): DocumentSnapshot {
  const layers: LayerInfo[] = [];
  for (let i = 0; i < n; i++) layers.push(makeLayer(i));
  return {
    revision: 1,
    projectPath: 'C:/projects/bench.motion',
    dirty: false,
    settings: {
      bitDepth: 'u8',
      workingSpace: 'srgb',
      linearBlending: false,
      ocioConfig: '',
      timeDisplay: 'timecode',
      expressionEngine: 'premation',
      framesStartAt: 0,
      audioSampleRate: 48000,
    },
    items: [],
    comps: [
      {
        id: 'comp-main',
        settings: {
          name: 'Main',
          width: 1920,
          height: 1080,
          pixelAspect: 1,
          frameRate: { num: 30, den: 1 },
          duration: 60 * F,
          startTimecode: 0,
          background: { r: 0, g: 0, b: 0, a: 1 },
          transparent: false,
          workArea: { start: 0, duration: 60 * F },
          motionBlur: { shutterAngle: 180, shutterPhase: -90, samplesPerFrame: 16, adaptiveSampleLimit: 128 },
          renderer3d: 'classic',
          globalLightAngle: 120,
          globalLightAltitude: 45,
          dropFrame: false,
          preserveFrameRate: false,
          preserveResolution: false,
        },
        layers: layers.map((l) => l.id),
        markers: [],
      },
    ],
    layers,
    propertyTrees: full ? layers.map((_, i) => makeTree(i)) : [],
    keyframes: full ? layers.map((_, i) => makeKeyframes(i)) : [],
    renderQueue: [],
  };
}

export const setPropertyCommand: Command = {
  type: 'setProperty',
  prop: { layer: layerId(42), path: 'transform/position' },
  value: { kind: 'vec3', value: { x: 960.5, y: 540.25, z: 0 } },
  time: 2 * F,
};

/** What the engine answers a drag write with: the keyframe's new value. */
export function dragEvents(): EventBatch {
  const set = makeKeyframes(42);
  set.keyframes[1]!.value = { kind: 'vec3', value: { x: 960.5, y: 540.25, z: 0 } };
  return {
    fromRevision: 100,
    toRevision: 101,
    events: [{ type: 'keyframesChanged', sets: [set] }],
    causedBy: 7,
    origin: 'ui',
  };
}
