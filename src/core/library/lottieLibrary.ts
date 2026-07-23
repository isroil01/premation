/**
 * Lottie library — bundled, genuinely importable Lottie/Bodymovin documents.
 *
 * Every item is a REAL Lottie JSON authored programmatically against the exact
 * feature set `planLottieImport` understands (ty:4 shape layers, rc/el + fl,
 * animated `ty:'sh'` bezier paths → `path.points` vertex-morph data tracks,
 * animated o/r/p/s transform channels with bezier easing, parenting), so a
 * library insert runs through the SAME pipeline as a user's file import —
 * plan → applyImportPlan — with `updateComp:false` and an offset so the
 * animation lands where it was dropped instead of resizing the comp.
 *
 * `importLottieFile` is the one shared home for file-based imports (panel
 * button and TopNav menu both use it).
 */

import { unzipSync, strFromU8 } from 'fflate';
import { planLottieImport, type LottieJson } from '@core/lottie/lottieImport';
import { applyImportPlan } from '@core/lottie/lottieImportApply';
import { createToolContext } from '@core/ai/toolContext';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController } from '@core/timeline/TimelineController';

export type LottieCategory = 'micro-ui' | 'widgets' | 'controls';

export interface LottieLibItem {
  id: string;
  name: string;
  cat: LottieCategory;
  /** Accent colour shown on the card. */
  color: string;
  /** Frame count at 30 fps (shown on the card). */
  frames: number;
  /** The actual Lottie document this item imports. */
  doc: LottieJson;
}

// ── Tiny Lottie authoring helpers ──────────────────────────────────
// All documents live in a 200×200 box centred at (100,100), 30 fps.

const FPS = 30;
const BOX = 200;
/** Design-box centre — insert offsets are computed against this. */
export const LOTTIE_DESIGN_CENTER = BOX / 2;

type Vec = readonly number[];
interface RawKf {
  t: number;
  s: Vec;
  /** ease: standard [ox, oy, ix, iy] cubic; omitted → easeOut default. */
  e?: readonly [number, number, number, number];
  /** hold frame */
  h?: boolean;
}

const EASE_OUT: readonly [number, number, number, number] = [0.33, 0, 0.2, 1];

function ch(value: Vec): { a: 0; k: number[] } {
  return { a: 0, k: [...value] };
}
function chAnim(kfs: readonly RawKf[]): { a: 1; k: object[] } {
  return {
    a: 1,
    k: kfs.map((kf) => {
      const e = kf.e ?? EASE_OUT;
      return kf.h
        ? { t: kf.t, s: [...kf.s], h: 1 }
        : { t: kf.t, s: [...kf.s], o: { x: [e[0]], y: [e[1]] }, i: { x: [e[2]], y: [e[3]] } };
    }),
  };
}
/** [r,g,b] 0..255 → Lottie colour channel. */
function col(hex: string): { a: 0; k: number[] } {
  const n = parseInt(hex.slice(1), 16);
  return ch([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]);
}

type PathPt = readonly [number, number];
/** A bezier outline in layer-local coordinates. `i`/`o` are tangents RELATIVE
 *  to each vertex (Lottie convention — lottiePathKeyframes adds them back). */
export interface BezShape {
  v: readonly PathPt[];
  i?: readonly PathPt[];
  o?: readonly PathPt[];
  c?: boolean;
}
/** One path-morph keyframe (frame time + full shape). */
interface PathKf {
  t: number;
  p: BezShape;
}

type ShapeSpec =
  | { kind: 'rect'; w: number; h: number; fill: string; radius?: number }
  | { kind: 'ellipse'; w: number; h: number; fill: string }
  /** Real animated-path geometry: `ty:'sh'` whose ks runs through
   *  lottiePathKeyframes → a `path.points` data track (vertex morphing). */
  | { kind: 'path'; fill: string; path: BezShape | readonly PathKf[] };

const ZERO2: PathPt = [0, 0];
function toBezJson(b: BezShape): object {
  return {
    v: b.v.map((p) => [p[0], p[1]]),
    i: b.v.map((_, k) => [...(b.i?.[k] ?? ZERO2)]),
    o: b.v.map((_, k) => [...(b.o?.[k] ?? ZERO2)]),
    c: b.c ?? true,
  };
}
/** `sh.ks` — static (`a:0`) or keyframed (`a:1`) shape-path property. */
function pathProp(path: BezShape | readonly PathKf[]): object {
  if (Array.isArray(path)) {
    return { a: 1, k: (path as readonly PathKf[]).map((kf) => ({ t: kf.t, s: [toBezJson(kf.p)] })) };
  }
  return { a: 0, k: toBezJson(path as BezShape) };
}
interface LayerSpec {
  name: string;
  ind: number;
  parent?: number;
  shape?: ShapeSpec;
  /** null layer (rotator/scaler parent) when no shape. */
  x?: number | readonly RawKf[];
  y?: number | readonly RawKf[];
  /** Combined animated position (overrides x/y). */
  p?: readonly RawKf[];
  rotation?: number | readonly RawKf[];
  scale?: number | readonly RawKf[]; // uniform %
  /** Non-uniform animated scale — each kf's `s` is [sx, sy] % (squash/stretch). */
  scaleXY?: readonly RawKf[];
  opacity?: number | readonly RawKf[];
}

function scalarOrKfs(v: number | readonly RawKf[] | undefined, dflt: number): object {
  if (v === undefined) return ch([dflt]);
  return typeof v === 'number' ? ch([v]) : chAnim(v);
}

function layer(spec: LayerSpec): object {
  const px = typeof spec.x === 'number' ? spec.x : LOTTIE_DESIGN_CENTER;
  const py = typeof spec.y === 'number' ? spec.y : LOTTIE_DESIGN_CENTER;
  const p = spec.p
    ? chAnim(spec.p)
    : Array.isArray(spec.x) || Array.isArray(spec.y)
      ? // split-position: per-axis animated channels
        {
          s: true,
          x: typeof spec.x === 'number' || spec.x === undefined ? ch([px]) : chAnim(spec.x),
          y: typeof spec.y === 'number' || spec.y === undefined ? ch([py]) : chAnim(spec.y),
        }
      : ch([px, py]);
  const scale = spec.scaleXY
    ? chAnim(spec.scaleXY)
    : spec.scale === undefined
      ? ch([100, 100])
      : typeof spec.scale === 'number'
        ? ch([spec.scale, spec.scale])
        : chAnim(spec.scale.map((k) => ({ ...k, s: [k.s[0]!, k.s[0]!] })));
  const geom =
    spec.shape === undefined
      ? null
      : spec.shape.kind === 'path'
        ? { ty: 'sh', ks: pathProp(spec.shape.path) }
        : spec.shape.kind === 'ellipse'
          ? { ty: 'el', s: ch([spec.shape.w, spec.shape.h]), p: ch([0, 0]) }
          : {
              ty: 'rc',
              s: ch([spec.shape.w, spec.shape.h]),
              p: ch([0, 0]),
              r: ch([spec.shape.radius ?? 0]),
            };
  const shapes = spec.shape && geom
    ? [
        {
          ty: 'gr',
          it: [geom, { ty: 'fl', c: col(spec.shape.fill), o: ch([100]) }],
        },
      ]
    : [];
  return {
    ty: spec.shape ? 4 : 3,
    ind: spec.ind,
    ...(spec.parent !== undefined ? { parent: spec.parent } : {}),
    nm: spec.name,
    ks: {
      o: scalarOrKfs(spec.opacity, 100),
      r: scalarOrKfs(spec.rotation, 0),
      p,
      s: scale,
      a: ch([0, 0]),
    },
    ...(spec.shape ? { shapes } : {}),
  };
}

function doc(name: string, frames: number, layers: readonly object[]): LottieJson {
  return { v: '5.7.0', nm: name, fr: FPS, op: frames, w: BOX, h: BOX, layers: layers as never[] } as LottieJson;
}

// ── The documents ──────────────────────────────────────────────────

const PILL_STEPPER_DOC = doc('Pill Stepper', 60, [
  layer({
    name: 'Outer Container', ind: 1,
    shape: { kind: 'rect', w: 140, h: 48, fill: '#09090b', radius: 24 },
    scale: [{ t: 0, s: [95] }, { t: 15, s: [105] }, { t: 25, s: [100] }],
  }),
  layer({
    name: 'Left White Capsule', ind: 2, parent: 1, x: 67, y: 100,
    shape: { kind: 'rect', w: 66, h: 44, fill: '#ffffff', radius: 22 },
  }),
  layer({
    name: 'Right Dark Capsule', ind: 3, parent: 1, x: 133, y: 100,
    shape: { kind: 'rect', w: 66, h: 44, fill: '#000000', radius: 22 },
  }),
  layer({
    name: 'Minus Glyph', ind: 4, parent: 2, x: 67, y: 100,
    shape: { kind: 'rect', w: 16, h: 3, fill: '#000000', radius: 1.5 },
    scale: [{ t: 12, s: [100] }, { t: 18, s: [80] }, { t: 26, s: [100] }],
  }),
  layer({
    name: 'Plus H Glyph', ind: 5, parent: 3, x: 133, y: 100,
    shape: { kind: 'rect', w: 16, h: 3, fill: '#ffffff', radius: 1.5 },
    scale: [{ t: 15, s: [100] }, { t: 22, s: [130] }, { t: 30, s: [100] }],
  }),
  layer({
    name: 'Plus V Glyph', ind: 6, parent: 3, x: 133, y: 100,
    shape: { kind: 'rect', w: 3, h: 16, fill: '#ffffff', radius: 1.5 },
    scale: [{ t: 15, s: [100] }, { t: 22, s: [130] }, { t: 30, s: [100] }],
  }),
  layer({
    name: 'Counter Number', ind: 7, x: 18, y: 100,
    shape: { kind: 'ellipse', w: 18, h: 18, fill: '#ffffff' },
    scale: [{ t: 15, s: [100] }, { t: 22, s: [140] }, { t: 30, s: [100] }],
  }),
]);

const DYNAMIC_ISLAND_DOC = doc('Dynamic Island', 60, [
  layer({
    name: 'Pill Container', ind: 1,
    shape: { kind: 'rect', w: 140, h: 46, fill: '#09090b', radius: 23 },
    scaleXY: [
      { t: 0, s: [50, 60] },
      { t: 18, s: [115, 110] },
      { t: 28, s: [100, 100] },
    ],
  }),
  layer({
    name: 'Waveform Bar 1', ind: 2, parent: 1, x: 75, y: 100,
    shape: { kind: 'rect', w: 4, h: 20, fill: '#38bdf8', radius: 2 },
    scaleXY: [{ t: 0, s: [100, 40] }, { t: 15, s: [100, 120] }, { t: 30, s: [100, 40] }],
  }),
  layer({
    name: 'Waveform Bar 2', ind: 3, parent: 1, x: 84, y: 100,
    shape: { kind: 'rect', w: 4, h: 28, fill: '#38bdf8', radius: 2 },
    scaleXY: [{ t: 5, s: [100, 120] }, { t: 20, s: [100, 30] }, { t: 35, s: [100, 120] }],
  }),
  layer({
    name: 'Waveform Bar 3', ind: 4, parent: 1, x: 93, y: 100,
    shape: { kind: 'rect', w: 4, h: 16, fill: '#38bdf8', radius: 2 },
    scaleXY: [{ t: 10, s: [100, 30] }, { t: 25, s: [100, 140] }, { t: 40, s: [100, 30] }],
  }),
  layer({
    name: 'Status Dot', ind: 5, parent: 1, x: 130, y: 100,
    shape: { kind: 'ellipse', w: 10, h: 10, fill: '#22c55e' },
    scale: [{ t: 0, s: [80] }, { t: 20, s: [120] }, { t: 40, s: [80] }],
  }),
]);

const FLUID_SWITCH_DOC = doc('Fluid Switch', 50, [
  layer({
    name: 'Track Background', ind: 1,
    shape: { kind: 'rect', w: 144, h: 44, fill: '#18181b', radius: 22 },
  }),
  layer({
    name: 'Sliding White Pill', ind: 2,
    shape: { kind: 'rect', w: 66, h: 36, fill: '#ffffff', radius: 18 },
    x: [{ t: 0, s: [67] }, { t: 20, s: [133] }, { t: 28, s: [133] }],
    scaleXY: [
      { t: 0, s: [100, 100] },
      { t: 10, s: [130, 80] },
      { t: 22, s: [95, 105] },
      { t: 28, s: [100, 100] },
    ],
  }),
  layer({
    name: 'Left Icon Dot', ind: 3, x: 67, y: 100,
    shape: { kind: 'ellipse', w: 10, h: 10, fill: '#000000' },
  }),
  layer({
    name: 'Right Icon Dot', ind: 4, x: 133, y: 100,
    shape: { kind: 'ellipse', w: 10, h: 10, fill: '#a1a1aa' },
  }),
]);

const GLASS_ACTION_DOC = doc('Glass Action Pill', 60, [
  layer({
    name: 'Outer Glow Ring', ind: 1,
    shape: { kind: 'ellipse', w: 110, h: 110, fill: '#6366f1' },
    opacity: [{ t: 0, s: [0] }, { t: 15, s: [40] }, { t: 35, s: [0] }],
    scale: [{ t: 0, s: [80] }, { t: 35, s: [140] }],
  }),
  layer({
    name: 'Glass Container', ind: 2,
    shape: { kind: 'rect', w: 130, h: 44, fill: '#0f172a', radius: 22 },
    scale: [{ t: 0, s: [95] }, { t: 18, s: [105] }, { t: 26, s: [100] }],
  }),
  layer({
    name: 'Success Check Circle', ind: 3, parent: 2, x: 100, y: 100,
    shape: { kind: 'ellipse', w: 24, h: 24, fill: '#10b981' },
    scale: [{ t: 20, s: [0] }, { t: 32, s: [120] }, { t: 40, s: [100] }],
  }),
]);

const FACE_ID_DOC = doc('Face ID Scan', 50, [
  layer({
    name: 'Scan Ring Outer', ind: 1,
    shape: { kind: 'ellipse', w: 110, h: 110, fill: '#38bdf8' },
    opacity: 30,
    scale: [{ t: 0, s: [90] }, { t: 20, s: [110] }, { t: 40, s: [90] }],
  }),
  layer({
    name: 'Center Lock Box', ind: 2,
    shape: { kind: 'rect', w: 50, h: 50, fill: '#09090b', radius: 14 },
    rotation: [{ t: 0, s: [0] }, { t: 25, s: [90] }, { t: 50, s: [180] }],
  }),
  layer({
    name: 'Biometric Dot', ind: 3, parent: 2, x: 100, y: 100,
    shape: { kind: 'ellipse', w: 16, h: 16, fill: '#22c55e' },
    scale: [{ t: 15, s: [60] }, { t: 30, s: [120] }, { t: 40, s: [100] }],
  }),
]);

const VOLUME_PILL_DOC = doc('Volume Slider Pill', 50, [
  layer({
    name: 'Pill Track', ind: 1,
    shape: { kind: 'rect', w: 44, h: 130, fill: '#18181b', radius: 22 },
  }),
  layer({
    name: 'Level Fill', ind: 2, parent: 1, x: 100, y: 120,
    shape: { kind: 'rect', w: 38, h: 80, fill: '#f43f5e', radius: 19 },
    scaleXY: [{ t: 0, s: [100, 30] }, { t: 20, s: [100, 110] }, { t: 30, s: [100, 100] }],
  }),
  layer({
    name: 'Speaker Dot', ind: 3, parent: 1, x: 100, y: 145,
    shape: { kind: 'ellipse', w: 10, h: 10, fill: '#ffffff' },
  }),
]);

const TOAST_BANNER_DOC = doc('Notification Toast', 60, [
  layer({
    name: 'Toast Container', ind: 1,
    shape: { kind: 'rect', w: 150, h: 42, fill: '#09090b', radius: 21 },
    p: [
      { t: 0, s: [100, 40] },
      { t: 18, s: [100, 105] },
      { t: 26, s: [100, 100] },
    ],
    scale: [{ t: 0, s: [80] }, { t: 18, s: [108] }, { t: 26, s: [100] }],
  }),
  layer({
    name: 'Notification Badge', ind: 2, parent: 1, x: 42, y: 100,
    shape: { kind: 'ellipse', w: 18, h: 18, fill: '#a855f7' },
    scale: [{ t: 15, s: [0] }, { t: 25, s: [120] }, { t: 32, s: [100] }],
  }),
]);

const LIQUID_TOGGLE_DOC = doc('Liquid Spring Toggle', 50, [
  layer({
    name: 'Toggle Track', ind: 1,
    shape: { kind: 'rect', w: 120, h: 56, fill: '#18181b', radius: 28 },
  }),
  layer({
    name: 'Active Glow Fill', ind: 2, parent: 1, x: 100, y: 100,
    shape: { kind: 'rect', w: 112, h: 48, fill: '#10b981', radius: 24 },
    opacity: [{ t: 0, s: [0] }, { t: 20, s: [100] }],
  }),
  layer({
    name: 'Liquid Thumb Dot', ind: 3,
    shape: { kind: 'ellipse', w: 44, h: 44, fill: '#ffffff' },
    x: [{ t: 0, s: [66] }, { t: 20, s: [134] }, { t: 28, s: [134] }],
    scaleXY: [
      { t: 0, s: [100, 100] },
      { t: 10, s: [135, 75] },
      { t: 22, s: [90, 110] },
      { t: 28, s: [100, 100] },
    ],
  }),
]);

export const LOTTIE_ITEMS: readonly LottieLibItem[] = [
  { id: 'lot-pill-stepper',   name: 'Pill Stepper',       cat: 'micro-ui', color: '#ffffff', frames: 60, doc: PILL_STEPPER_DOC },
  { id: 'lot-dynamic-island', name: 'Dynamic Island',    cat: 'widgets',  color: '#38bdf8', frames: 60, doc: DYNAMIC_ISLAND_DOC },
  { id: 'lot-fluid-switch',   name: 'Fluid Switch',       cat: 'micro-ui', color: '#e2e8f0', frames: 50, doc: FLUID_SWITCH_DOC },
  { id: 'lot-glass-action',   name: 'Glass Action Pill',  cat: 'controls', color: '#6366f1', frames: 60, doc: GLASS_ACTION_DOC },
  { id: 'lot-face-id',        name: 'Face ID Scan',       cat: 'widgets',  color: '#22c55e', frames: 50, doc: FACE_ID_DOC },
  { id: 'lot-volume-pill',    name: 'Volume Slider Pill', cat: 'controls', color: '#f43f5e', frames: 50, doc: VOLUME_PILL_DOC },
  { id: 'lot-toast-banner',   name: 'Notification Toast', cat: 'widgets',  color: '#a855f7', frames: 60, doc: TOAST_BANNER_DOC },
  { id: 'lot-liquid-toggle',  name: 'Liquid Toggle',      cat: 'micro-ui', color: '#10b981', frames: 50, doc: LIQUID_TOGGLE_DOC },
] as const;

export function getLottieItem(id: string): LottieLibItem | null {
  return LOTTIE_ITEMS.find((l) => l.id === id) ?? null;
}

// ── Insert / import ────────────────────────────────────────────────

/**
 * Insert a bundled item through the REAL Lottie import pipeline, centred at
 * (x, y) — comp centre when omitted — without resizing the user's comp.
 * Returns the created node ids (empty on failure).
 */
export function insertLottieItem(lottieId: string, x?: number, y?: number): string[] {
  const item = getLottieItem(lottieId);
  if (!item) return [];
  const comp = useCompositionStore.getState();
  const px = x ?? comp.width / 2;
  const py = y ?? comp.height / 2;
  const plan = planLottieImport(item.doc);
  const { nodeIds } = applyImportPlan(plan, createToolContext(new AbortController().signal), {
    updateComp: false,
    offset: { x: px - LOTTIE_DESIGN_CENTER, y: py - LOTTIE_DESIGN_CENTER },
  });
  if (nodeIds.length > 0) {
    useSelectionStore.getState().set(nodeIds);
    getTimelineController().syncFromScene();
    bumpScene();
  }
  return nodeIds;
}

export interface LottieFileImportResult {
  nodeIds: string[];
  warnings: string[];
}

/**
 * Import a user's .json or .lottie file — shared entry point for file imports
 * (TopNav menu and the Lottie panel both call this). Unpacks .lottie ZIP archives.
 */
export async function importLottieFile(file: File): Promise<LottieFileImportResult> {
  let json: LottieJson;
  const fileName = file.name.toLowerCase();

  if (fileName.endsWith('.lottie') || file.type.includes('zip') || file.type.includes('lottie')) {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const unzipped = unzipSync(buffer);
    let jsonStr: string | null = null;

    const manifestKey = Object.keys(unzipped).find((k) => k.endsWith('manifest.json'));
    if (manifestKey) {
      try {
        const manifest = JSON.parse(strFromU8(unzipped[manifestKey]!));
        const animId = manifest.animations?.[0]?.id;
        if (animId) {
          const match = Object.keys(unzipped).find((k) => k.includes(animId) && k.endsWith('.json'));
          if (match) jsonStr = strFromU8(unzipped[match]!);
        }
      } catch {
        /* fallback below */
      }
    }

    if (!jsonStr) {
      const jsonKey =
        Object.keys(unzipped).find((k) => k.endsWith('.json') && !k.endsWith('manifest.json')) ??
        Object.keys(unzipped).find((k) => k.endsWith('.json'));
      if (jsonKey) {
        jsonStr = strFromU8(unzipped[jsonKey]!);
      }
    }

    if (!jsonStr) {
      throw new Error('No valid Lottie JSON found inside .lottie file archive.');
    }
    json = JSON.parse(jsonStr) as LottieJson;
  } else {
    json = JSON.parse(await file.text()) as LottieJson;
  }

  const plan = planLottieImport(json);

  // NEVER resize the user's composition on import. A file import drops the
  // animation INTO the active scene, centred — exactly like a library insert —
  // instead of redefining the comp's size/fps/duration. The old default
  // (`updateComp` true) silently resized the current (often freshly-created)
  // scene to the imported file's dimensions, which is never what the user wants.
  const comp = useCompositionStore.getState();
  const designCx = plan.comp.width / 2;
  const designCy = plan.comp.height / 2;
  const { nodeIds, warnings } = applyImportPlan(plan, createToolContext(new AbortController().signal), {
    updateComp: false,
    offset: { x: comp.width / 2 - designCx, y: comp.height / 2 - designCy },
  });
  if (nodeIds.length > 0) {
    // Select the freshly imported layers so the user sees what landed (and where).
    useSelectionStore.getState().set(nodeIds);
    getTimelineController().syncFromScene();
    bumpScene();
  }
  return { nodeIds, warnings };
}
