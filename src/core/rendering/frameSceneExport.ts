/**
 * FrameScene → RenderFrameFile (packages/engine-api/schema/96_render.eapi).
 *
 * Phase D2 of docs/NATIVE_CORE_PLAN.md: the C++ render graph
 * (native/engine/src/render_graph) renders exactly what the TypeScript renderer
 * renders, from the SAME flat render description. This module serialises the
 * live `FrameScene` a frame was drawn from, the viewport it was drawn through,
 * the colour-pipeline state, and the texels of every texture the scene samples
 * (read back from the GPU after upload, so the C++ side samples the very bytes
 * the TS shaders sampled — text, vector and video rasters included, until E3/E1
 * produce them natively).
 *
 * Pure mapping + an injected texture reader: no GPU, no DOM, no store. The
 * render-tests harness drives it (`native` backend); nothing on a frame path
 * calls it.
 */

import {
  codecs,
  type RenderBlob,
  type RenderCamera3D,
  type RenderEffect,
  type RenderEffectParam,
  type RenderEnvMap,
  type RenderFrameFile,
  type RenderLight3D,
  type RenderOverlays,
  type RenderTextureFormat,
  type RenderTextureRef,
  type Renderable as WireRenderable,
} from '@motion/engine-api';
import type { FrameScene, Renderable, SceneLight3D } from '@motion/renderer';

type EnvironmentMap = NonNullable<FrameScene['envMap']>;

/** Bump when the mapping below changes meaning (not for additive fields). */
export const FRAME_FILE_FORMAT_VERSION = 1;

export interface FrameCaptureView {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  center: { x: number; y: number };
  zoom: number;
  /** overlays.background (display-referred). */
  clearColor: { r: number; g: number; b: number; a: number };
  frameClip: { x: number; y: number; width: number; height: number } | null;
  overlaysActive: boolean;
  /** What OverlayPass draws (Viewport.overlays), when overlaysActive. */
  overlays?: CapturedOverlays;
}

type CapturedColor = { r: number; g: number; b: number; a: number };

/** The OverlayPass inputs of Viewport.overlays. */
export interface CapturedOverlays {
  grid: boolean;
  gridSpacing: number;
  gridSubdivisions: number;
  gridStyle: 'lines' | 'dashed' | 'dots';
  gridColor?: CapturedColor;
  proportionalGrid: boolean;
  proportionalColumns: number;
  proportionalRows: number;
  compRect: { x: number; y: number; width: number; height: number } | null;
  guides: Array<{ axis: 'x' | 'y'; position: number; color?: CapturedColor }>;
}

/** colorPipeline.ts ViewerLutMeta. */
export interface CapturedViewerLut {
  size: number;
  is1d: boolean;
  intensity: number;
  domainMin: number;
  domainMax: number;
}

/** The texture key the viewer LUT strip is registered under (EffectPass VIEWER_LUT_TEXTURE_KEY). */
export const VIEWER_LUT_KEY = 'viewer-lut';

export interface FrameCapture {
  scene: FrameScene;
  view: FrameCaptureView;
  colorPipeline: { workingSpace: 'srgb-linear' | 'aces-cg'; displayTransform: 'srgb' | 'aces' | 'pq' | 'hlg'; bitDepth: 16 | 32 };
  viewerLutActive: boolean;
  /** The viewer LUT's parameters when active (its strip is the texture VIEWER_LUT_KEY). */
  viewerLut?: CapturedViewerLut | null;
  capabilities: { float16Textures: boolean; float32Textures: boolean };
  surfaceFormat: string;
  /** WebGPU adapter vendor ('amd', 'nvidia', …), empty when unknown. */
  adapterVendor: string;
}

export interface TextureReadback {
  width: number;
  height: number;
  format: string;
  data: Uint8Array;
  mipmapped: boolean;
}

/** What the texture provider said about a key when the frame rendered. */
export interface ResolvedTextureInfo {
  sampleLinear: boolean;
  ready: boolean;
  read(): Promise<TextureReadback | null>;
}

export type TextureResolver = (key: string) => ResolvedTextureInfo | null;

/** WGSL of a registered (plugin) shader by name, or undefined. */
export type ShaderResolver = (name: string) => string | undefined;

const TEXTURE_FORMATS: Record<string, RenderTextureFormat> = {
  rgba8unorm: 'rgba8unorm',
  'rgba8unorm-srgb': 'rgba8unormSrgb',
  bgra8unorm: 'bgra8unorm',
  rgba16float: 'rgba16float',
  rgba32float: 'rgba32float',
  r8unorm: 'r8unorm',
};

function wireFormat(format: string): RenderTextureFormat {
  return TEXTURE_FORMATS[format] ?? 'rgba8unorm';
}

function mat(m: ArrayLike<number>): number[] {
  return Array.from(m, (v) => v);
}

function isColorLike(v: unknown): v is { r: number; g: number; b: number; a: number } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.r === 'number' && typeof o.g === 'number' && typeof o.b === 'number' && typeof o.a === 'number'
    && Object.keys(o).length === 4;
}

function param(name: string, kind: RenderEffectParam['kind']): RenderEffectParam {
  return { name, kind, number: 0, numbers: [], text: '', texts: [] };
}

/** Flatten one effect entry, field by field, in declaration order. */
export function effectToWire(e: Record<string, unknown>): RenderEffect {
  const params: RenderEffectParam[] = [];
  const add = (name: string, v: unknown): void => {
    if (v === undefined || v === null || typeof v === 'function') return;
    if (typeof v === 'number') {
      params.push({ ...param(name, 'number'), number: v });
    } else if (typeof v === 'boolean') {
      params.push({ ...param(name, 'flag'), number: v ? 1 : 0 });
    } else if (typeof v === 'string') {
      params.push({ ...param(name, 'text'), text: v });
    } else if (ArrayBuffer.isView(v)) {
      params.push({ ...param(name, 'numbers'), numbers: Array.from(v as unknown as ArrayLike<number>, (x) => x) });
    } else if (Array.isArray(v)) {
      if (v.every((x) => typeof x === 'string')) {
        params.push({ ...param(name, 'texts'), texts: v as string[] });
      } else {
        // Numbers, or rows of numbers (FxVec4[]) flattened in order.
        const flat: number[] = [];
        for (const x of v) {
          if (typeof x === 'number') flat.push(x);
          else if (Array.isArray(x) || ArrayBuffer.isView(x)) { const arr = x as ArrayLike<number>; for (let j = 0; j < arr.length; j++) flat.push(arr[j]!); }
        }
        params.push({ ...param(name, 'numbers'), numbers: flat });
      }
    } else if (isColorLike(v)) {
      params.push({ ...param(name, 'color'), numbers: [v.r, v.g, v.b, v.a] });
    } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) add(`${name}.${k}`, x);
    }
  };
  for (const [k, v] of Object.entries(e)) if (k !== 'type') add(k, v);
  return { type: String(e.type), params };
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function lightToWire(l: SceneLight3D): RenderLight3D {
  return {
    type: l.type,
    color: [l.color.r, l.color.g, l.color.b],
    gain: l.gain, x: l.x, y: l.y, z: l.z, radius: l.radius,
    aimX: l.aimX, aimY: l.aimY, aimZ: l.aimZ,
    halfConeRad: l.halfConeRad, coneFeatherRad: l.coneFeatherRad,
    falloffMode: l.falloffMode, falloffDistance: l.falloffDistance,
    ...(l.shadowMap !== undefined ? { shadowMap: l.shadowMap } : {}),
    ...(l.shadowMapSize !== undefined ? { shadowMapSize: l.shadowMapSize } : {}),
    ...(l.shadowBias !== undefined ? { shadowBias: l.shadowBias } : {}),
    ...(l.shadowSoftness !== undefined ? { shadowSoftness: l.shadowSoftness } : {}),
    ...(l.shadowDarkness !== undefined ? { shadowDarkness: l.shadowDarkness } : {}),
  };
}

function envToWire(e: EnvironmentMap): RenderEnvMap {
  return {
    id: e.id, width: e.width, height: e.height, levels: e.levels, scale: e.scale,
    data: bytesOf(e.data), intensity: e.intensity, rotationDeg: e.rotationDeg,
  };
}

function cameraToWire(c: NonNullable<FrameScene['camera3d']>): RenderCamera3D {
  const d = c.dof;
  return {
    view: mat(c.view),
    projection: mat(c.projection),
    eye: c.eye ? [c.eye[0], c.eye[1], c.eye[2]] : [],
    ...(d ? { dof: { ...d } } : {}),
  };
}

function optNum<K extends string>(k: K, v: number | undefined): Partial<Record<K, number>> {
  return v === undefined ? {} : ({ [k]: v } as Record<K, number>);
}

function renderableToWire(r: Renderable, keys: Set<string>, shaders: Set<string>): WireRenderable {
  const note = (k: string | undefined): void => { if (k) keys.add(k); };
  note(r.textureKey);
  note(r.maskTextureKey);
  note(r.lutTextureKey);
  note(r.adjustment?.lutTextureKey);
  note(r.generator?.textureKey);
  if (r.extrudedMesh) {
    for (const range of r.extrudedMesh.ranges) note(range.textureKey);
    const p = r.extrudedMesh.pbr;
    note(p?.normalKey); note(p?.metallicRoughnessKey); note(p?.occlusionKey); note(p?.emissiveKey);
  }
  for (const e of r.effects ?? []) {
    const lutKey = (e as { lutTextureKey?: unknown }).lutTextureKey;
    if (typeof lutKey === 'string') note(lutKey);
    const shader = (e as { type: string; shader?: unknown }).type === 'plugin' ? (e as { shader?: unknown }).shader : undefined;
    if (typeof shader === 'string') shaders.add(shader);
  }

  const shade = r.threeD?.shade;
  const g = r.generator;
  return {
    id: r.id,
    kind: r.kind,
    modelMatrix: mat(r.modelMatrix),
    bounds: { x: r.bounds.x, y: r.bounds.y, width: r.bounds.width, height: r.bounds.height },
    opacity: r.opacity,
    blend: r.blend,
    ...optNum('advancedBlend', r.advancedBlend),
    preserveTransparency: !!r.preserveTransparency,
    depthExempt: !!r.depthExempt,
    ...optNum('backdropBlur', r.backdropBlur),
    ...(r.glass ? { glass: { ...r.glass, tint: { ...r.glass.tint }, rim: { ...r.glass.rim } } } : {}),
    sampling: r.sampling ?? 'linear',
    ...(r.color ? { color: { r: r.color.r, g: r.color.g, b: r.color.b, a: r.color.a } } : {}),
    ...(r.sdf ? { sdf: { ...r.sdf } } : {}),
    ...(r.colorMatrix ? { colorMatrix: { m: mat(r.colorMatrix.m), offset: mat(r.colorMatrix.offset) } } : {}),
    effects: (r.effects ?? []).map((e) => effectToWire(e as unknown as Record<string, unknown>)),
    ...(r.textureKey !== undefined ? { textureKey: r.textureKey } : {}),
    ...(r.uvRect ? { uvRect: { x: r.uvRect.x, y: r.uvRect.y, width: r.uvRect.width, height: r.uvRect.height } } : {}),
    clip: !!r.clip,
    motionSamples: (r.motionSamples ?? []).map((s) => ({ modelMatrix: mat(s.modelMatrix), opacity: s.opacity })),
    cornerPin: r.cornerPin ? mat(r.cornerPin) : [],
    ...(r.maskId !== undefined ? { maskId: r.maskId } : {}),
    ...(r.maskTextureKey !== undefined ? { maskTextureKey: r.maskTextureKey } : {}),
    ...(r.lutTextureKey !== undefined ? { lutTextureKey: r.lutTextureKey } : {}),
    ...(r.adjustment
      ? {
          adjustment: {
            ...(r.adjustment.colorMatrix
              ? { colorMatrix: { m: mat(r.adjustment.colorMatrix.m), offset: mat(r.adjustment.colorMatrix.offset) } }
              : {}),
            ...(r.adjustment.lutTextureKey !== undefined ? { lutTextureKey: r.adjustment.lutTextureKey } : {}),
          },
        }
      : {}),
    ...(r.matte ? { matte: { mode: r.matte.mode, inverted: r.matte.inverted, sourceId: r.matte.sourceId } } : {}),
    matteSource: !!r.matteSource,
    lightWash: !!r.lightWash,
    ...(r.precomp
      ? {
          precomp: {
            ...(r.precomp.camera3d ? { camera3d: cameraToWire(r.precomp.camera3d) } : {}),
            lights3d: (r.precomp.lights3d ?? []).map(lightToWire),
            ...(r.precomp.envMap ? { envMap: envToWire(r.precomp.envMap) } : {}),
            ...(r.precomp.flat ? { flatWidth: r.precomp.flat.width, flatHeight: r.precomp.flat.height } : {}),
          },
        }
      : {}),
    precompChildren: r.precomp ? r.precomp.renderables.map((c) => renderableToWire(c, keys, shaders)) : [],
    ...(g
      ? {
          generator: {
            instances: bytesOf(g.instances),
            count: g.count,
            stride: g.stride,
            primitive: g.primitive,
            ...(g.mesh ? { meshVertices: bytesOf(g.mesh.vertices), meshIndices: bytesOf(g.mesh.indices) } : {}),
            meshIndexFormat: g.mesh && g.mesh.indices instanceof Uint32Array ? 'uint32' : 'uint16',
            ...(g.textureKey !== undefined ? { textureKey: g.textureKey } : {}),
            cellSize: [g.cellSize[0], g.cellSize[1]],
            blend: g.blend,
            revision: g.revision,
            width: g.width,
            height: g.height,
            ...optNum('perspective', g.perspective),
          },
        }
      : {}),
    ...(r.deformedMesh
      ? {
          deformedMesh: {
            vertices: bytesOf(r.deformedMesh.vertices),
            triangles: bytesOf(r.deformedMesh.triangles),
            ...(r.deformedMesh.depth ? { depth: bytesOf(r.deformedMesh.depth) } : {}),
          },
        }
      : {}),
    ...(r.extrudedMesh
      ? {
          extrudedMesh: {
            key: r.extrudedMesh.key,
            vertices: bytesOf(r.extrudedMesh.vertices),
            indices: bytesOf(r.extrudedMesh.indices),
            indexFormat: r.extrudedMesh.indices instanceof Uint32Array ? 'uint32' : 'uint16',
            ranges: r.extrudedMesh.ranges.map((x) => ({
              role: x.role, first: x.first, count: x.count,
              color: { r: x.color.r, g: x.color.g, b: x.color.b, a: x.color.a },
              gain: x.gain, textured: !!x.textured,
              ...(x.textureKey !== undefined ? { textureKey: x.textureKey } : {}),
            })),
            ...(r.extrudedMesh.pbr
              ? {
                  pbr: {
                    ...(r.extrudedMesh.pbr.normalKey !== undefined ? { normalKey: r.extrudedMesh.pbr.normalKey } : {}),
                    ...(r.extrudedMesh.pbr.metallicRoughnessKey !== undefined
                      ? { metallicRoughnessKey: r.extrudedMesh.pbr.metallicRoughnessKey } : {}),
                    ...(r.extrudedMesh.pbr.occlusionKey !== undefined ? { occlusionKey: r.extrudedMesh.pbr.occlusionKey } : {}),
                    ...(r.extrudedMesh.pbr.emissiveKey !== undefined ? { emissiveKey: r.extrudedMesh.pbr.emissiveKey } : {}),
                    normalScale: r.extrudedMesh.pbr.normalScale,
                    occlusionStrength: r.extrudedMesh.pbr.occlusionStrength,
                    emissive: [...r.extrudedMesh.pbr.emissive],
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(r.threeD
      ? {
          threeD: {
            model: mat(r.threeD.model),
            ...(r.threeD.castsShadow !== undefined ? { castsShadow: r.threeD.castsShadow } : {}),
            ...(shade
              ? {
                  shade: {
                    specular: shade.specular,
                    shininess: shade.shininess,
                    ...optNum('metal', shade.metal),
                    ...optNum('roughness', shade.roughness),
                    ...optNum('toonBands', shade.toonBands),
                    quadGain: shade.quadGain ? [...shade.quadGain] : [],
                    ...(shade.oneSided !== undefined ? { oneSided: shade.oneSided } : {}),
                    ...optNum('ambient', shade.ambient),
                    ...optNum('diffuse', shade.diffuse),
                    ...optNum('reflectionIntensity', shade.reflectionIntensity),
                    ...optNum('reflectionSharpness', shade.reflectionSharpness),
                    ...optNum('reflectionRolloff', shade.reflectionRolloff),
                    ...optNum('transparency', shade.transparency),
                    ...optNum('transparencyRolloff', shade.transparencyRolloff),
                    ...optNum('ior', shade.ior),
                    ...(shade.acceptsShadows !== undefined ? { acceptsShadows: shade.acceptsShadows } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/** FNV-1a over the bytes, 2 × 32-bit lanes, plus the shape — a content id, not a security hash. */
export function contentHash(width: number, height: number, format: string, data: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ width ^ (height << 16);
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b ^ (i & 0xff), 0x01000193);
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return `${format}:${width}x${height}:${hex(h1)}${hex(h2)}:${data.length}`;
}

function overlaysToWire(o: CapturedOverlays): RenderOverlays {
  return {
    grid: o.grid,
    gridSpacing: o.gridSpacing,
    gridSubdivisions: o.gridSubdivisions,
    gridStyle: o.gridStyle,
    ...(o.gridColor ? { gridColor: { ...o.gridColor } } : {}),
    proportionalGrid: o.proportionalGrid,
    proportionalColumns: o.proportionalColumns,
    proportionalRows: o.proportionalRows,
    ...(o.compRect ? { compRect: { ...o.compRect } } : {}),
    guides: o.guides.map((g) => ({ axis: g.axis, position: g.position, ...(g.color ? { color: { ...g.color } } : {}) })),
  };
}

/** Everything the scene references, before any texture is read. */
export function frameSceneToWire(capture: FrameCapture, sceneId: string, frame: number): {
  file: RenderFrameFile;
  keys: string[];
  shaders: string[];
} {
  const keys = new Set<string>(['texture:white']);
  const shaders = new Set<string>();
  const s = capture.scene;
  const v = capture.view;
  const lut = capture.viewerLutActive ? capture.viewerLut ?? null : null;
  if (lut) keys.add(VIEWER_LUT_KEY);
  const file: RenderFrameFile = {
    formatVersion: FRAME_FILE_FORMAT_VERSION,
    sceneId,
    frame,
    view: {
      cssWidth: v.cssWidth,
      cssHeight: v.cssHeight,
      devicePixelRatio: v.devicePixelRatio,
      cameraCenterX: v.center.x,
      cameraCenterY: v.center.y,
      cameraZoom: v.zoom,
      clearColor: { ...v.clearColor },
      ...(v.frameClip ? { frameClip: { ...v.frameClip } } : {}),
      overlaysActive: v.overlaysActive,
      workingSpace: capture.colorPipeline.workingSpace === 'aces-cg' ? 'acesCg' : 'srgbLinear',
      displayTransform: capture.colorPipeline.displayTransform,
      bitDepth: capture.colorPipeline.bitDepth,
      float16Textures: capture.capabilities.float16Textures,
      float32Textures: capture.capabilities.float32Textures,
      surfaceFormat: wireFormat(capture.surfaceFormat),
      viewerLutActive: capture.viewerLutActive,
      ...(capture.adapterVendor ? { adapterVendor: capture.adapterVendor } : {}),
      ...(v.overlaysActive && v.overlays ? { overlays: overlaysToWire(v.overlays) } : {}),
      ...(lut
        ? { viewerLut: { size: lut.size, is1d: lut.is1d, intensity: lut.intensity, domainMin: lut.domainMin, domainMax: lut.domainMax } }
        : {}),
    },
    scene: {
      compositionId: s.composition.id,
      width: s.composition.size.width,
      height: s.composition.size.height,
      ...(s.composition.background
        ? { background: { r: s.composition.background.r, g: s.composition.background.g, b: s.composition.background.b, a: s.composition.background.a } }
        : {}),
      renderables: s.renderables.map((r) => renderableToWire(r, keys, shaders)),
      hasEffects: !!s.hasEffects,
      ...optNum('dissolveFrame', s.dissolveFrame),
      ...(s.camera3d ? { camera3d: cameraToWire(s.camera3d) } : {}),
      lights3d: (s.lights3d ?? []).map(lightToWire),
      ...(s.envMap ? { envMap: envToWire(s.envMap) } : {}),
      ...(s.ssao ? { ssao: { ...s.ssao } } : {}),
    },
    textures: [],
    blobs: [],
    shaders: [],
  };
  return { file, keys: [...keys].sort(), shaders: [...shaders].sort() };
}

/**
 * Serialise one captured frame, reading back every texture it references.
 * Keys that do not resolve are recorded with an empty hash — the TS renderer
 * skipped those draws, and the C++ one must skip the same ones.
 */
export async function exportFrameFile(
  capture: FrameCapture,
  sceneId: string,
  frame: number,
  resolve: TextureResolver,
  shaderSource: ShaderResolver = () => undefined,
): Promise<Uint8Array> {
  const { file, keys, shaders } = frameSceneToWire(capture, sceneId, frame);
  for (const name of shaders) {
    const wgsl = shaderSource(name);
    if (wgsl !== undefined) file.shaders.push({ name, wgsl });
  }
  const refs: RenderTextureRef[] = [];
  const blobs = new Map<string, RenderBlob>();
  for (const key of keys) {
    const info = resolve(key);
    if (!info) {
      refs.push({ key, hash: '', sampleLinear: false, ready: false });
      continue;
    }
    const px = await info.read();
    if (!px) {
      refs.push({ key, hash: '', sampleLinear: info.sampleLinear, ready: info.ready });
      continue;
    }
    const hash = contentHash(px.width, px.height, px.format, px.data);
    if (!blobs.has(hash)) {
      blobs.set(hash, {
        hash, width: px.width, height: px.height, format: wireFormat(px.format), pixels: px.data, mipmapped: px.mipmapped,
      });
    }
    refs.push({ key, hash, sampleLinear: info.sampleLinear, ready: info.ready });
  }
  file.textures = refs;
  file.blobs = [...blobs.values()];
  return codecs.RenderFrameFile.encode(file);
}
