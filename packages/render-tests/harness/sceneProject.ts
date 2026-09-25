/**
 * A golden scene as a PROJECT DOCUMENT — the input of the `native-scene` gate
 * (docs/NATIVE_CORE_PLAN.md D2w).
 *
 * The `native` backend hands premation-render the FrameScene the TypeScript
 * built. `native-scene` hands the C++ engine the DOCUMENT instead: the scene
 * graph, animation, composition record, motion blur and colour settings, in
 * the EditorDocument shape `captureDocument()` saves (.motion) and the C++
 * engine opens (native/engine/src/core/docio.cpp `restore_document`). The C++
 * scene builder (native/engine/src/scene) then builds its OWN FrameScene per
 * frame and is diffed against the TypeScript one exported beside it.
 *
 * Harness scenes are authored on a bare SceneGraph whose layers are ROOTS; a
 * project's layers live under a composition root. So the scene is wrapped in
 * one (`comp_root`, a group — what `sceneProjectIO.createEmpty` seeds) unless
 * the scene already names its composition root (`comp.rootId`: scenes that
 * hold several compositions, e.g. a host and the comp it places). Wrapping is
 * transform-neutral: a comp root has no transform, so every layer's world
 * matrix is the one the unwrapped graph gives it.
 *
 * Media carried as `data:` URLs (the video fixture is inlined, see
 * scenes/video.ts) are written out as files beside the project and the node's
 * `src` rewritten to the file name, because the engine decodes files.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import type { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import type { Scene } from './sceneKit';
import { useAssetStore } from '@stores/assetStore';
import { CURRENT_DOCUMENT_VERSION } from '@core/project/migrations';

/** The composition root id a wrapped scene gets (sceneProjectIO's default). */
export const HARNESS_COMP_ROOT = 'comp_root';

export interface SceneProjectExport {
  /** EditorDocument JSON (version 1.1.0 shape). */
  document: Record<string, unknown>;
  /** The composition the frames render (the wrapper, or `comp.rootId`). */
  compId: string;
  /** Files the document references by name (decoded `data:` media). */
  media: Array<{ name: string; bytes: Uint8Array }>;
}

function dataUrlBytes(url: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] ?? '';
  const payload = m[3] ?? '';
  let bytes: Uint8Array;
  if (m[2]) {
    const bin = atob(payload);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : mime.includes('png') ? 'png'
    : mime.includes('jpeg') ? 'jpg' : mime.includes('svg') ? 'svg' : mime.includes('wav') ? 'wav' : 'bin';
  return { bytes, ext };
}

/** Plain JSON copy of one node (sceneProjectIO.capture's POJO form). */
function nodeJson(n: SceneNode): Record<string, unknown> {
  return {
    id: n.id,
    name: n.name,
    children: [...n.children],
    parent: n.parent,
    transform: JSON.parse(JSON.stringify(n.transform)),
    components: JSON.parse(JSON.stringify(n.components)),
    visible: n.visible,
    locked: n.locked,
    ...(n.solo ? { solo: true } : {}),
    ...(n.shy ? { shy: true } : {}),
    ...(n.color !== undefined ? { color: n.color } : {}),
  };
}

export function sceneToProject(scene: Scene, graph: SceneGraph, anim: AnimationEngine): SceneProjectExport {
  const nodes: Array<Record<string, unknown>> = [];
  graph.traverse((n) => nodes.push(nodeJson(n)));
  const media: SceneProjectExport['media'] = [];
  // data: media → files (every string prop named src / __src on any component).
  for (const n of nodes) {
    for (const c of n.components as Array<{ props: Record<string, unknown> }>) {
      for (const key of ['src', '__src']) {
        const v = c.props?.[key];
        if (typeof v !== 'string' || !v.startsWith('data:')) continue;
        const d = dataUrlBytes(v);
        if (!d) continue;
        const name = `media-${media.length}.${d.ext}`;
        media.push({ name, bytes: d.bytes });
        c.props[key] = name;
      }
    }
  }
  // Footage records the scene registered in the asset store (Interpret Footage lives
  // on them): the engine session holds them, so they ride as the session's assets.
  const referenced = new Set<string>();
  for (const n of nodes) {
    for (const c of n.components as Array<{ props: Record<string, unknown> }>) {
      for (const key of ['assetId', '__assetId']) {
        const v = c.props?.[key];
        if (typeof v === 'string' && v) referenced.add(v);
      }
    }
  }
  const assets = useAssetStore.getState().assets
    .filter((a) => referenced.has(a.id))
    .map((a) => {
      const rec = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
      if (typeof rec.src === 'string' && rec.src.startsWith('data:')) {
        const d = dataUrlBytes(rec.src);
        if (d) {
          const name = `media-${media.length}.${d.ext}`;
          media.push({ name, bytes: d.bytes });
          rec.src = name;
        }
      }
      delete rec.thumbSrc;
      return rec;
    });
  const roots = graph.getRoots().map((r) => r.id);
  const compId = scene.comp.rootId ?? HARNESS_COMP_ROOT;
  if (!scene.comp.rootId) {
    for (const n of nodes) if (n.parent === null || n.parent === undefined) n.parent = HARNESS_COMP_ROOT;
    nodes.unshift({
      id: HARNESS_COMP_ROOT,
      name: 'Composition 1',
      parent: null,
      children: roots,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      visible: true,
      locked: false,
      components: [{ id: `${HARNESS_COMP_ROOT}_meta`, type: 'group', props: { __kind: 'group' } }],
    });
  }
  const lastFrame = Math.max(0, ...scene.frames);
  const compRecord = (id: string, size: { width: number; height: number }): Record<string, unknown> => ({
    id,
    name: id,
    width: size.width,
    height: size.height,
    fps: scene.fps,
    // Long enough for every frame the scene renders; the harness passes no
    // duration to buildSnapshot, so nothing gates on it.
    durationSeconds: Math.max(10, (lastFrame + 2) / scene.fps),
    background: scene.comp.background,
    ...(scene.comp.transparent ? { transparent: true } : {}),
    ...(scene.comp.ssao ? { ssao: scene.comp.ssao } : {}),
  });
  const comps: Record<string, unknown> = { [compId]: compRecord(compId, scene.comp) };
  // Other roots of a multi-comp scene are compositions the host places.
  if (scene.comp.rootId) {
    for (const r of roots) {
      if (r === compId) continue;
      const size = scene.comp.compSizeOf?.(r);
      if (size) comps[r] = compRecord(r, size);
    }
  }
  const mb = scene.motionBlur;
  const document: Record<string, unknown> = {
    // The CURRENT document version: the scene is authored in memory with today's
    // code, so it must not be run through the load-time migrations again (1.8.0
    // stamps every light falloff: 'legacy', which the TypeScript frame never had).
    version: CURRENT_DOCUMENT_VERSION,
    scene: { version: '1.0.0', nodes },
    animation: anim.snapshot(),
    comps,
    motionBlur: mb
      ? {
          enabled: mb.enabled,
          shutterAngle: mb.shutterAngle,
          shutterPhase: mb.shutterPhase ?? -90,
          samples: mb.samples,
          adaptiveSampleLimit: mb.adaptiveSampleLimit ?? 128,
        }
      : { enabled: false, shutterAngle: 180, shutterPhase: -90, samples: 8, adaptiveSampleLimit: 128 },
    colorManagement: { workingSpace: 'srgb-linear', displayTransform: 'srgb', bitDepth: scene.nativeSetup?.bitDepth ?? 16 },
    // Every session asset the scene uses is listed (reconcileItems keeps only listed
    // footage), with its Interpret Footage record.
    projectItems: {
      folders: [],
      footage: Object.fromEntries(assets.map((a) => [
        a.id as string,
        { name: a.name ?? a.id, type: a.type, ...(a.interpret ? { interpret: a.interpret } : {}) },
      ])),
    },
    // The harness renders every layer at comp time (no clip bars): no timelines.
    openTabs: {
      tabOrder: ['tab1'],
      activeTabId: 'tab1',
      tabs: { tab1: { id: 'tab1', compositionId: compId, breadcrumbPath: [compId], title: compId, time: 0, frame: 0 } },
    },
    // What the harness hands buildSnapshot besides the document — read by the
    // C++ gate, never by restore (unknown keys are ignored there).
    harness: {
      sceneId: scene.id,
      frames: scene.frames,
      fps: scene.fps,
      size: scene.size,
      motionBlurFps: scene.motionBlur?.fps ?? null,
      motionBlurOn: !!scene.motionBlur,
      overlays: scene.nativeSetup?.overlays ?? null,
      viewerLut: !!scene.nativeSetup?.viewerLutCube,
      assets,
    },
  };
  return { document, compId, media };
}
