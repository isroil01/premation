/**
 * A THROWAWAY scene drawn by the engine — library cards, template / preset
 * previews, component thumbnails (docs/TS_ENGINE_REMOVAL.md, "The order",
 * step 2: the page renderer is gone, so nothing in the page draws a scene).
 *
 * The scene is handed to the engine as a project DOCUMENT (the EditorDocument
 * shape a .motion file holds: scene nodes under a composition root, the
 * animation snapshot, one composition record) and drawn with
 * `renderDocumentStill` — the engine restores it into a scratch document, so
 * the open project, its history and its caches are untouched. The picture is
 * the one the engine draws once the item is inserted, which is the point of a
 * preview.
 *
 *   previewDocumentOf   nodes + animation + a composition → the document
 *   graphNodes          a throwaway SceneGraph's nodes as plain records
 *   previewStill        one frame of it, as a PNG blob (or null)
 *
 * Stills are asked ONE AT A TIME (`previewStill` queues): each one occupies
 * the engine's render thread and its session, which the viewport and the
 * user's edits share. Posters go ahead of flipbook frames.
 */

import { secondsToFlicks } from '@motion/engine-api';
import type { AnimSnapshot } from '@motion/animation';
import type SceneGraph from '@core/scene/SceneGraph';
import type { SceneNode } from '@core/types';
import { CURRENT_DOCUMENT_VERSION } from '@core/project/migrations';
import { engine } from './engineInstance';

/** The composition a preview document holds. */
export interface PreviewComp {
  /** The composition root's node id — also the composition's id. */
  rootId: string;
  width: number;
  height: number;
  /** CSS colour; absent or fully transparent = a transparent composition. */
  background?: string;
  /** Long enough for every time the preview asks (default 60 s). */
  durationSeconds?: number;
  fps?: number;
  name?: string;
}

/** A preview document, serialised once (every still of it sends the same text). */
export interface PreviewDocument {
  json: string;
  compId: string;
  width: number;
  height: number;
}

const EMPTY_ANIMATION: AnimSnapshot = { tracks: {}, expressions: {}, data: {} };

/** `rgba(…, 0)` / `transparent` / `#rrggbb00` — a background that draws nothing. */
export function isTransparentColor(css: string | undefined): boolean {
  if (!css) return true;
  const s = css.trim().toLowerCase();
  if (s === 'transparent') return true;
  const fn = /^(?:rgba|hsla)\(([^)]*)\)$/.exec(s);
  if (fn) {
    const parts = fn[1]!.split(/[,/]/).map((p) => p.trim());
    const a = parts.length === 4 ? Number.parseFloat(parts[3]!) : 1;
    return Number.isFinite(a) && a <= 0;
  }
  if (/^#[0-9a-f]{8}$/.test(s)) return s.endsWith('00');
  if (/^#[0-9a-f]{4}$/.test(s)) return s.endsWith('0');
  return false;
}

/** Plain JSON copy of one node (the form `sceneProjectIO.capture` saves). */
function nodeRecord(n: SceneNode): SceneNode {
  return {
    id: n.id,
    name: n.name,
    children: [...n.children],
    parent: n.parent,
    transform: JSON.parse(JSON.stringify(n.transform)) as SceneNode['transform'],
    components: JSON.parse(JSON.stringify(n.components)) as SceneNode['components'],
    visible: n.visible,
    locked: n.locked,
    ...(n.solo ? { solo: true } : {}),
    ...(n.shy ? { shy: true } : {}),
    ...(n.color !== undefined ? { color: n.color } : {}),
  };
}

/** Every node of a throwaway graph as plain records, in the graph's order. */
export function graphNodes(graph: SceneGraph): SceneNode[] {
  const nodes: SceneNode[] = [];
  graph.traverse((n) => nodes.push(nodeRecord(n)));
  return nodes;
}

/**
 * The document of a throwaway scene: `nodes` (the composition root `comp.rootId`
 * among them, the layers under it), its animation, and ONE composition record.
 * No timelines — every layer spans the composition, as in the scene the
 * builders made.
 */
export function previewDocumentOf(
  nodes: ReadonlyArray<SceneNode>,
  animation: AnimSnapshot | null,
  comp: PreviewComp,
): PreviewDocument {
  const transparent = isTransparentColor(comp.background);
  const record = {
    id: comp.rootId,
    name: comp.name ?? 'Preview',
    width: comp.width,
    height: comp.height,
    fps: comp.fps ?? 30,
    durationSeconds: comp.durationSeconds ?? 60,
    background: transparent ? '#000000' : comp.background,
    transparent,
    startFrame: 0,
  };
  const document = {
    // Authored in memory with today's builders: the CURRENT version, so the
    // engine's load-time migrations do not run over it.
    version: CURRENT_DOCUMENT_VERSION,
    scene: { version: '1.0.0', nodes },
    animation: animation ?? EMPTY_ANIMATION,
    comps: { [comp.rootId]: record },
    // Stated, so a preview never takes motion blur from a default.
    motionBlur: { enabled: false, shutterAngle: 180, shutterPhase: -90, samples: 8, adaptiveSampleLimit: 128 },
    // NO `projectItems`: the engine then keeps the open project's footage in the
    // scratch document (docio.cpp restore_document — a stated list would drop
    // every item it does not name), so a layer that references an imported
    // image / video by asset id still draws its media.
  };
  return { json: JSON.stringify(document), compId: comp.rootId, width: comp.width, height: comp.height };
}

// ── The still queue ──────────────────────────────────────────────────────────

/** `poster` stills are served before `frame` stills (a card's first picture before another card's motion). */
export type PreviewPriority = 'poster' | 'frame';

interface Job {
  priority: PreviewPriority;
  /** False once nobody wants the answer any more — the job is dropped unasked. */
  wanted: () => boolean;
  run: () => Promise<Blob | null>;
  resolve: (b: Blob | null) => void;
}

const jobs: Job[] = [];
let running = false;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      let at = jobs.findIndex((j) => j.priority === 'poster');
      if (at < 0) at = 0;
      const job = jobs.splice(at, 1)[0];
      if (!job) break;
      if (!job.wanted()) {
        job.resolve(null);
        continue;
      }
      let blob: Blob | null = null;
      try {
        blob = await job.run();
      } catch {
        blob = null; // a still that failed is a card without a picture, never a broken queue
      }
      job.resolve(blob);
    }
  } finally {
    running = false;
  }
}

/** The engine's largest still. */
const STILL_MAX = 4096;

/**
 * One frame of `doc` at composition second `seconds`, as a PNG whose long side
 * is at most `maxSize` — or null: the engine could not draw it (no engine
 * process in this harness, the renderer unavailable, a document it refuses),
 * or `wanted` said the answer is no longer needed before its turn came.
 */
export function previewStill(
  doc: PreviewDocument,
  seconds: number,
  maxSize: number,
  opts: { priority?: PreviewPriority; wanted?: () => boolean } = {},
): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    jobs.push({
      priority: opts.priority ?? 'frame',
      wanted: opts.wanted ?? (() => true),
      resolve,
      run: async () => {
        const res = await engine().query({
          type: 'renderDocumentStill',
          document: doc.json,
          comp: doc.compId,
          time: secondsToFlicks(Math.max(0, seconds)),
          maxSize: Math.max(1, Math.min(STILL_MAX, Math.round(maxSize))),
        });
        if (!res.ok || res.value.data.length === 0) return null;
        return new Blob([res.value.data as BlobPart], { type: `image/${res.value.format || 'png'}` });
      },
    });
    void pump();
  });
}

/** Test seam: stills waiting for their turn. */
export function pendingPreviewStills(): number {
  return jobs.length;
}
