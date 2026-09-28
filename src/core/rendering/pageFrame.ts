/**
 * The TypeScript engine's frame for the PAGE's own renderer (B4) — the
 * fallback when the C++ engine does not draw a surface (EngineSurface off, the
 * Layer viewer, inspection panes, Presentation, scopes).
 *
 * This is engine code: the snapshot IS the TypeScript engine's evaluation of
 * its document at a time (buildSnapshot over the scene graph and the animation
 * engine). The page's surfaces hand it plain inputs — the time, the view, the
 * composition RECORD they draw (from the document mirror) and view options —
 * and get a RenderSnapshot back, one call per painted frame: the twin of the
 * C++ engine's FrameReady. They never read the scene graph themselves.
 */

import type { CompositionSettings } from '@stores/projectStore';
import type { Camera3dMode } from '@stores/guidesStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { compSizeOf } from '@core/composition/compSizes';
import { resolveViewCameraInput } from '@core/workspace/cameraNav';
import { createSceneGraphPort } from '@core/workspace/ports';
import type { MotionBlurConfig } from '@core/effects/motionBlur';
import { clipGeometrySignature } from '@core/timeline/TimelineController';
import { memoizedSceneContentHash } from './sceneContentHash';
import { isMediaDecodeRepaint } from './mediaRepaint';
import { getEventBus } from '@core/events/EventBus';
import { renderStillFrame } from '@core/export/offlineRenderer';
import { useCompositionStore } from '@stores/compositionStore';
import { buildSnapshot, type SnapshotFocus, type SnapshotComp } from './buildSnapshot';
import type { RenderOverlays, RenderSnapshot, RenderView } from './RenderBackend';

export interface PageFrameInput {
  /** Composition time, seconds. */
  time: number;
  focus?: SnapshotFocus;
  overlays?: RenderOverlays;
  view?: RenderView;
  motionBlur?: MotionBlurConfig;
  /** The composition drawn (its record: size, fps, background…). */
  comp: CompositionSettings;
  /** The subtree rendered; default the composition itself. */
  rootId?: string;
  /** The 3D view the surface looks through. */
  viewMode: Camera3dMode;
  draft3d?: boolean;
  useProxies?: boolean;
  /** Viewport only: Quality = Wireframe layers hide their pixels. */
  wireframeLayers?: boolean;
  /** Alpha channel view: the comp's own alpha, no background plate. */
  alpha?: boolean;
  /** Extra snapshot options a surface needs (the Layer viewer's isolation…). */
  extra?: Partial<SnapshotComp>;
}

/**
 * The page renderer's frame-cache CONTENT key: the TypeScript engine's scene +
 * animation content hash, memoized on the revision counters the caller keeps
 * (one walk per edit, not per frame — sceneContentHash.ts).
 */
export function pageFrameContentKey(sceneRev: number, animRev: number): string {
  return memoizedSceneContentHash(defaultSceneGraph, defaultAnimation, sceneRev, animRev);
}

/** The composition's clip geometry signature (bars live in the timeline engine, outside the content hash). */
export function pageFrameClipSignature(compId: string): string {
  return clipGeometrySignature(compId);
}

/** Why the TypeScript engine's frame changed (the page renderer's cache and repaint triggers). */
export type PageFrameChange =
  /** A clip bar moved / trimmed / split (timeline geometry, outside the content hash). */
  | 'clips'
  /** Animation changed (a keyframe edit, playback of an expression…). */
  | 'animation'
  /** A media decode landed (a video frame, a texture): repaint only, the content did not change. */
  | 'media'
  /** A node's props changed. */
  | 'node';

/**
 * Told whenever the TypeScript engine's frame may have changed, and why — the
 * page renderer's invalidation (its RAM preview key, its repaint). Engine-side
 * events of the engine that renders the page; the C++ engine's frames carry
 * their own revision.
 */
export function onPageFrameChanged(cb: (change: PageFrameChange) => void): () => void {
  const bus = getEventBus();
  const subs = [
    bus.on('DocumentChanged', (payload) => {
      if (payload?.source === 'timeline') cb('clips');
    }),
    bus.on('AnimationChanged', (payload) => cb(isMediaDecodeRepaint(payload) ? 'media' : 'animation')),
    bus.on('NodeUpdated', () => cb('node')),
  ];
  return () => { for (const s of subs) s.dispose(); };
}

/**
 * The export / preview renderer's composition input for `comp`: the record
 * scoped to its own subtree, with the engine's composition-size lookup
 * (nested comps) — what runExport and the export preview take.
 */
export function pageRenderComp(comp: CompositionSettings, transparent: boolean): CompositionSettings & { rootId: string; transparent: boolean; compSizeOf: typeof compSizeOf } {
  return { ...comp, rootId: comp.id, transparent, compSizeOf };
}

/**
 * One frame of `comp` at composition frame `frame`, rendered through the
 * deterministic offline path as a PNG (Save Frame As / Copy Frame).
 */
export function pageStillFrame(comp: CompositionSettings, frame: number): Promise<Blob | null> {
  return renderStillFrame(
    { width: comp.width, height: comp.height, fps: comp.fps, durationSec: comp.durationSeconds, comp: { ...comp, rootId: comp.id, compSizeOf } },
    frame,
  );
}

/**
 * The active composition's frame at `seconds` (clamped into it) from the
 * TypeScript engine's OWN composition record — for a render made while a
 * document is swapped into this engine (version compare), where the mirror
 * still describes the live document. Null when the renderer produced nothing.
 */
export async function pageActiveStillFrameAt(seconds: number): Promise<Blob | null> {
  const c = useCompositionStore.getState().comp();
  const last = Math.max(0, Math.round(c.durationSeconds * c.fps) - 1);
  const frame = Math.max(0, Math.min(Math.round(seconds * c.fps), last));
  return pageStillFrame(c, frame);
}

/** The TypeScript engine's snapshot of `input.comp` at `input.time` for the page renderer. */
export function pageFrameSnapshot(input: PageFrameInput): RenderSnapshot {
  const c = input.comp;
  return buildSnapshot(defaultSceneGraph, defaultAnimation, input.time, input.focus, input.overlays, input.view, input.motionBlur, {
    ...c,
    rootId: input.rootId ?? c.id,
    compSizeOf,
    ...(input.draft3d !== undefined ? { draft3d: input.draft3d } : {}),
    ...(input.useProxies !== undefined ? { useProxies: input.useProxies } : {}),
    ...(input.wireframeLayers ? { wireframeLayers: true } : {}),
    ...resolveViewCameraInput(c.width, c.height, input.viewMode),
    ...(input.alpha ? { transparent: true, backgroundPaint: undefined } : {}),
    ...(input.extra ?? {}),
  } as SnapshotComp);
}

let wireframePort: ReturnType<typeof createSceneGraphPort> | null = null;

/**
 * The page renderer's layers with their world geometry — what a page surface's
 * Quality = Wireframe overlay outlines (the page frame hides those layers'
 * pixels, so the boxes belong to the same frame). Goes with the page renderer.
 */
export function pageFrameWireframeNodes(): Iterable<{ id: string; worldBounds: { x: number; y: number; width: number; height: number }; worldCorners?: ReadonlyArray<{ x: number; y: number }> } | null | undefined> {
  wireframePort ??= createSceneGraphPort();
  return wireframePort.getNodes();
}
