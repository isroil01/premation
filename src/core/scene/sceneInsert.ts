/* eslint-disable no-restricted-syntax -- TODO(F11): UNCLASSIFIED, the largest cluster (99).
 * This file both CONSTRUCTS node literals before `addNode` (legitimate — the
 * object is not yet in the graph) and, in places, reads a node back with
 * getNode() and mutates it (not legitimate). Layer insertion demonstrably
 * works, so either the dangerous sites are compensated for elsewhere or they
 * are writing values that happen to match the defaults. Which is which is
 * exactly what F11's audit is for; suppressed wholesale rather than guessed at
 * one line at a time. */
/**
 * sceneInsert — shared "add a primitive to the composition" action, so the
 * insert controls can live anywhere (top tool bar, command palette, …) without
 * each call site re-implementing the node factory.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP, type SceneKind } from './seedDefaultScene';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import { runDocumentEdit } from '@core/commands/documentEdit';
import type { SceneNode } from '@core/types';
import type { ImportedAsset } from '@stores/assetStore';
import {
  parseSvgToShapes, isSimpleSvg, MAX_VECTOR_SHAPES,
  type ParsedShape, type ParsedGradientFill, type SvgTextMeasurer, type SvgPathIntersector, type SubPath as SvgSubPath,
} from '../../utils/svgParser';
import { flattenOutline, booleanPolygons } from '@core/scene/mergePaths';
import { measureTextSize, measureTextBoxes, DEFAULT_LINE_HEIGHT, type MeasuredTextStyle } from '@core/text/measureText';
import { scanSvgAnimations, type SvgShapeAnimation } from '../../utils/svgAnimation';
import { defaultAnimation } from '@motion/animation';
import { copyNodeAnimation } from '@core/animation/cloneNodeAnimation';
import { deleteLayerNode } from './deleteLayerNode';
import { bezierCorner as corner } from '@motion/workspace';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { Project3D } from '@motion/scene';
import { is3DEnabled } from './threeD';
import type { LightType } from './light';
import { flattenScene, readNodeKind } from './sceneDerive';
import { getTimelineController } from '@core/timeline/TimelineController';
import { COMP_REF_PROP, wouldCreateCompCycle } from './compInstance';
import { DEFAULT_PARTICLE_CONFIG } from '@core/particles/particleSim';
import { detectImageSequence } from '@core/scene/imageSequence';
import { makeStop, type FillPaint, type OpacityStop } from '@core/paint/fill';
import { addTrimOp, pathOpPropPath } from '@core/scene/pathOps';
import { sanitizeSvg } from '@core/svg/svgSanitize';
import { scanSvgCapabilities, isAnimatedSvg, svgCapabilityWarnings, type SvgCapabilities } from '@core/svg/svgCapabilities';
import { makeSvgComponent } from '@core/svg/svgLayer';
import { enableContinuousRasterByDefault } from '@core/scene/continuousRaster';
import { applyAlpha } from '@core/paint/fill';


let seq = 0;

export { activeCompRootId } from './activeComp';
import { activeCompRootId, activeCompSize } from './activeComp';
import { computeFit } from '@core/source/fitCommands';

/** Build a fresh scene node of `kind` with sensible default components. */
export function makeNode(kind: SceneKind, name: string): SceneNode {
  const id = `${kind}_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const transform = { position: { x: 160, y: 120 }, rotation: 0, scale: { x: 1, y: 1 } };
  const components: SceneNode['components'] =
    kind === 'text'
      ? [
          {
            id: `${id}_t`,
            type: 'Transform',
            props: {
              [SCENE_KIND_PROP]: kind,
              x: 160,
              y: 120,
              rotation: 0,
              scaleX: 1,
              scaleY: 1,
              anchorX: 0,
              anchorY: 0,
            },
          },
          { id: `${id}_c`, type: 'Text', props: { content: 'Text', fontSize: 32, opacity: 100 } },
        ]
      : kind === 'group'
        ? [
            {
              id: `${id}_t`,
              type: 'Transform',
              props: {
                [SCENE_KIND_PROP]: kind,
                x: 160,
                y: 120,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                anchorX: 0,
                anchorY: 0,
                width: 280,
                height: 280,
              },
            },
            { id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: kind } },
          ]
        : kind === 'image' || kind === 'video' || kind === 'svg'
        ? [
            {
              id: `${id}_t`,
              type: 'Transform',
              props: {
                [SCENE_KIND_PROP]: kind,
                x: 160,
                y: 120,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                anchorX: 0,
                anchorY: 0,
                width: 100,
                height: 100,
              },
            },
            { id: `${id}_s`, type: 'Style', props: { opacity: 100 } },
          ]
        : [
            {
              id: `${id}_t`,
              type: 'Transform',
              props: {
                [SCENE_KIND_PROP]: kind,
                x: 160,
                y: 120,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                anchorX: 0,
                anchorY: 0,
                width: 100,
                height: 100,
              },
            },
            { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#3b8276' } },
          ];
  return { id, name, parent: null, children: [], transform, visible: true, locked: false, components };
}

import { useProjectStore } from '@stores/projectStore';
import { Matrix } from '@motion/scene';

import { setParentPreservingWorld } from '@core/scene/parenting';
import { parentWorld2DAt } from '@core/scene/layerSpace';
import { useInfoStore } from '@stores/infoStore';
import { clamp01 } from '@utils/lang';

/**
 * Places an inserted node under the active pointer cursor (or comp center if off-canvas),
 * and assigns a prominent, scene-proportional width/height/fontSize so elements are
 * visibly clear, large, and easy to edit across any composition resolution (HD, 4K, Reel, etc.).
 */
export function placeInComp(
  node: SceneNode,
  opts?: { customW?: number; customH?: number; customFontSize?: number; exactSize?: boolean }
): void {
  const activeTabId = useProjectStore.getState().activeTabId;
  const activeTab = useProjectStore.getState().tabs[activeTabId ?? ''];
  const compId = activeTab?.compositionId ?? 'comp_root';
  const comp = useProjectStore.getState().comps[compId] ?? useCompositionStore.getState();

  // Target size ~28% of shorter comp edge (min 240px, max 960px)
  const compMinDim = Math.min(comp.width, comp.height);
  const targetSize = Math.max(240, Math.min(960, Math.round(compMinDim * 0.28)));

  let width = opts?.customW && opts.customW > 0 ? opts.customW : targetSize;
  let height = opts?.customH && opts.customH > 0 ? opts.customH : targetSize;

  // Scale up small custom dimensions (e.g. 24px - 180px) so elements match
  // scene scale. NEVER for `exactSize` callers: media fitted to the comp
  // (insertMedia's contain-fit) is exactly the size it must be — "helpfully"
  // enlarging a 64×48 clip fitted full-frame into a 64×48 comp to 240×180
  // is how new-comp-from-small-footage stopped being full frame.
  if (!opts?.exactSize && width < 220 && height < 220) {
    const aspect = (width / height) || 1;
    if (aspect >= 1) {
      width = targetSize;
      height = Math.round(targetSize / aspect);
    } else {
      height = targetSize;
      width = Math.round(targetSize * aspect);
    }
  }

  const info = useInfoStore.getState();
  const px = info.present ? info.x : comp.width / 2;
  const py = info.present ? info.y : comp.height / 2;

  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = px;
    t.props.y = py;
    t.props.width = width;
    t.props.height = height;
  }

  const textComp = node.components.find((c) => c.type === 'Text');
  if (textComp) {
    const proportionalFontSize = opts?.customFontSize || Math.max(48, Math.round(comp.height * 0.065));
    textComp.props.fontSize = proportionalFontSize;
  }

  node.transform.position.x = px;
  node.transform.position.y = py;
}

/**
 * Move a node's base Transform to a world point. Used by canvas drop-to-insert:
 * the insert helpers below all center in the comp and select the new node, so
 * the drop handler inserts then calls this on the fresh selection to land it
 * under the cursor instead. Bumps the scene.
 */
export function setNodeWorldPosition(nodeId: string, x: number, y: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  // The parent chain AT THE PLAYHEAD: dropping an asset onto a comp whose
  // container is keyframed has to land under the cursor, and the static
  // resolver put it wherever that container rests at time 0.
  const s = useProjectStore.getState();
  const pt = Matrix.transformPoint(
    Matrix.invert(parentWorld2DAt(nodeId, s.tabs[s.activeTabId ?? '']?.time ?? 0)),
    { x, y },
  );
  const localX = pt.x;
  const localY = pt.y;
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = localX;
    t.props.y = localY;
  }
  node.transform.position.x = localX;
  node.transform.position.y = localY;
  bumpScene();
}

/**
 * Insert an SVG as ONE layer, storing the original document intact.
 *
 * This is the DEFAULT import path (the hybrid architecture): no geometry
 * parsing, no keyframe generation, no layer explosion — a 300-path
 * illustration becomes exactly one layer, and what renders is the file itself
 * rasterized, so gradients, masks, filters, clip paths and patterns are all
 * reproduced rather than approximated.
 *
 * Returns the new node id, or null when the markup can't be read at all.
 */
export function insertSvgLayer(
  svgText: string,
  name: string,
  opts?: {
    x?: number;
    y?: number;
    capabilities?: SvgCapabilities;
    extraWarning?: string;
    livePlayback?: boolean;
  },
): string | null {
  const rootId = activeCompRootId();
  const node = makeNode('svg', name);

  // One parse+scan for the whole import: the router already did it to choose
  // this path, and sanitizing needs the same answer to tell whether it removed
  // anything. Re-deriving it is a full extra parse of a file that can be
  // megabytes.
  const capabilities = opts?.capabilities
    ?? scanSvgCapabilities(new DOMParser().parseFromString(svgText, 'image/svg+xml'));

  // Scope ids to the NODE id: the ids are baked into the stored markup, so the
  // scope has to be stable for the layer's lifetime or every render would
  // invalidate the texture cache.
  const clean = sanitizeSvg(svgText, node.id.replace(/[^\w-]/g, '_'), capabilities);
  if (!clean) return null;

  node.components.push(
    makeSvgComponent(`${node.id}_svg`, {
      sourceMarkup: svgText,
      sanitizedMarkup: clean.markup,
      size: { width: clean.width, height: clean.height, viewBox: clean.viewBox },
      capabilities,
      fileName: name,
      livePlayback: opts?.livePlayback === true,
    }),
  );

  placeInComp(node, { customW: clean.width, customH: clean.height });
  if (opts?.x !== undefined) {
    const t = node.components.find((c) => c.type === 'Transform');
    if (t) t.props.x = opts.x;
    node.transform.position.x = opts.x;
  }
  if (opts?.y !== undefined) {
    const t = node.components.find((c) => c.type === 'Transform');
    if (t) t.props.y = opts.y;
    node.transform.position.y = opts.y;
  }

  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  enableContinuousRasterByDefault(node.id);
  bumpScene();

  // Sanitizing can REMOVE content, so it is a fidelity change and has to be
  // disclosed — a silently-stripped <script>-driven animation is otherwise
  // indistinguishable from a rendering bug. Caller-supplied context joins the
  // SAME toast: two warning popups for one dropped file is how a user learns to
  // dismiss them without reading.
  const warnings = [...(opts?.extraWarning ? [opts.extraWarning] : []), ...svgCapabilityWarnings(capabilities)];
  if (warnings.length > 0) {
    useUIStore.getState().notify({
      level: 'warning',
      message: `“${name}”: ${warnings.join(' ')}`,
      durationMs: 7000,
    });
  }
  return node.id;
}

/**
 * Insert an SVG as ONE editable, movable icon: a group of shape/text layers,
 * scaled to a comfortable size and centered (or dropped at x/y), with the parts
 * positioned RELATIVE to the group so it behaves as a single body. Only the
 * GROUP is selected, so a drag moves the whole thing (mirrors the cursor lib).
 *
 * Returns the new group id, or null when the SVG has no vector geometry (caller
 * should fall back to a faithful image).
 */
export function insertSvgShapeGroup(
  svgText: string,
  name: string,
  opts?: { x?: number; y?: number; targetSize?: number; shapes?: ParsedShape[] },
): string | null {
  const comp = useCompositionStore.getState();
  // Callers that already parsed (to decide the route) pass the result back in;
  // parsing is the expensive half of an import and it is deterministic.
  const shapes = opts?.shapes
    ?? parseSvgToShapes(svgText, {
      maxDurationSeconds: comp.durationSeconds,
      measureText: measureSvgText,
      intersectPaths: intersectSvgPaths,
    });
  if (shapes.length === 0) return null;

  const rootId = activeCompRootId();
  const info = useInfoStore.getState();
  const px = opts?.x ?? (info.present ? info.x : comp.width / 2);
  const py = opts?.y ?? (info.present ? info.y : comp.height / 2);

  // Union bounding box of every part (SVG user space) → overall center + size.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    minX = Math.min(minX, s.centerX - s.width / 2);
    minY = Math.min(minY, s.centerY - s.height / 2);
    maxX = Math.max(maxX, s.centerX + s.width / 2);
    maxY = Math.max(maxY, s.centerY + s.height / 2);
  }
  const svgCx = (minX + maxX) / 2;
  const svgCy = (minY + maxY) / 2;
  const svgW = Math.max(1, maxX - minX);
  const svgH = Math.max(1, maxY - minY);

  // Scale so UI components and SVG groups land at a prominent, scene-proportional size.
  const compMinDim = Math.min(comp.width, comp.height);
  const proportionalTarget = Math.max(280, Math.min(960, Math.round(compMinDim * 0.32)));
  const target = opts?.targetSize ? Math.max(opts.targetSize, proportionalTarget) : proportionalTarget;
  const k = target / Math.max(svgW, svgH);

  const group = makeNode('group', name);
  // The Transform COMPONENT is the authority — `readBase` (buildSnapshot) and
  // `toWorkspaceNode` (selection) both read `props.x ?? node.transform.position.x`,
  // so writing only the node field left the group at makeNode's placeholder
  // (160, 120): on a 1920×1080 comp the icon landed in the top-left corner with
  // its parts straddling the canvas edge, which reads as "the parts scattered".
  // Size follows the content so the group's own bounds match what it contains.
  const gt = group.components.find((c) => c.type === 'Transform');
  if (gt) {
    gt.props.x = px;
    gt.props.y = py;
    gt.props.width = svgW * k;
    gt.props.height = svgH * k;
  }
  group.transform.position.x = px;
  group.transform.position.y = py;
  defaultSceneGraph.addChild(rootId, group);

  // ONE change notification for the whole import. Unbatched, every track wrote
  // through the full AnimationChanged listener chain (scene bump → synchronous
  // hit-test rebuild → autosave scheduling), which is what froze the app on
  // multi-shape animated files. The final bumpScene below is the visible one.
  defaultAnimation.batch(() => {
  for (const s of shapes) {
    const pathId = `shape_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
    // Part offset from the group center, scaled — keeps every part in register.
    const relX = (s.centerX - svgCx) * k;
    const relY = (s.centerY - svgCy) * k;
    const transform = { position: { x: relX, y: relY }, rotation: 0, scale: { x: 1, y: 1 } };

    const layerOpacity = Math.round(clamp01(s.opacity ?? 1) * 100);

    if (s.imageHref) {
      // An embedded bitmap becomes a real image layer. It was dropped before,
      // so any animated SVG built around a photo imported with a hole in it.
      const components: SceneNode['components'] = [
        {
          id: `${pathId}_t`,
          type: 'Transform',
          props: {
            [SCENE_KIND_PROP]: 'image',
            x: relX,
            y: relY,
            rotation: 0,
            width: s.width * k,
            height: s.height * k,
            src: s.imageHref,
          },
        },
        { id: `${pathId}_s`, type: 'Style', props: { opacity: layerOpacity } },
      ];
      defaultSceneGraph.addChild(group.id, { id: pathId, name: s.name, parent: group.id, children: [], transform, visible: true, locked: false, components });
    } else if (s.textContent) {
      const components: SceneNode['components'] = [
        { id: `${pathId}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: relX, y: relY, rotation: 0, width: s.width * k, height: s.height * k } },
        {
          id: `${pathId}_txt`,
          type: 'Text',
          props: {
            content: s.textContent,
            fontSize: (s.fontSize ?? 16) * k,
            fill: s.fill && s.fill !== 'none' ? s.fill : '#ffffff',
            opacity: layerOpacity,
            // The face the file asked for. Dropping these rendered every
            // imported label in the app's default font at the default weight —
            // the most visible way a text layer can be wrong while every
            // number around it is right.
            ...(s.fontFamily ? { fontFamily: s.fontFamily } : {}),
            ...(s.fontWeight ? { fontWeight: s.fontWeight } : {}),
            ...(s.fontStyle ? { fontStyle: s.fontStyle } : {}),
          },
        },
      ];
      defaultSceneGraph.addChild(group.id, { id: pathId, name: s.name, parent: group.id, children: [], transform, visible: true, locked: false, components });
    } else {
      const scale = (list: ReadonlyArray<{ x: number; y: number; inX: number; inY: number; outX: number; outY: number }>): typeof scaledPoints =>
        list.map((p) => ({ x: p.x * k, y: p.y * k, inX: p.inX * k, inY: p.inY * k, outX: p.outX * k, outY: p.outY * k }));
      const scaledPoints = s.points.map((p) => ({ x: p.x * k, y: p.y * k, inX: p.inX * k, inY: p.inY * k, outX: p.outX * k, outY: p.outY * k }));
      // A multi-run path is stored as RUNS, never as the flat shorthand: the
      // two are mutually exclusive (raster/subpaths.ts) and the flat form is
      // what filled every donut's hole.
      const scaledRuns = s.subpaths?.map((run) => ({ points: scale(run.points), open: !run.closed }));
      const fillPaint = s.fillPaint ? parsedGradientToFillPaint(s.fillPaint) : undefined;
      const fxProps: Record<string, unknown> = {};
      if (fillPaint) fxProps.fill = fillPaint;
      if (s.strokeColor) {
        fxProps.stroke = {
          enabled: true,
          color: s.strokeColor,
          width: (s.strokeWidth ?? 1) * k,
          opacity: clamp01(s.strokeOpacity ?? 1),
          cap: 'butt', join: 'miter', align: 'center', dash: [],
        };
      }
      const components: SceneNode['components'] = [
        { id: `${pathId}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: relX, y: relY, rotation: 0, width: s.width * k, height: s.height * k } },
        {
          id: `${pathId}_s`,
          type: 'Style',
          props: {
            opacity: layerOpacity,
            // When a FillPaint lives on fx, Style.fill is only a legacy fallback
            // (first stop). Transparent when fill was none.
            fill: svgFillToCss(s.fill, s.fillOpacity),
          },
        },
        // THE STROKE LIVES ON `fx`, NOT ON `Style`. `readNodeStroke` — the only
        // reader buildSnapshot has — looks at `fx.props.stroke`, so the stroke
        // written onto the Style component was picked up by nothing at all:
        // every imported outline icon rendered with no stroke, which on a
        // `fill="none"` file means it rendered as nothing.
        // Gradients also live on fx.fill (FillPaint) so AppearanceSection can
        // edit angle/stops — Style.fill alone cannot express a ramp.
        ...(Object.keys(fxProps).length > 0
          ? [{ id: `${pathId}_fx`, type: 'fx' as const, props: fxProps }]
          : []),
        {
          id: `${pathId}_g`,
          type: 'Geometry',
          props: scaledRuns
            ? { subpaths: scaledRuns }
            : { points: scaledPoints, ...(s.closed ? {} : { open: true }) },
        },
      ];
      defaultSceneGraph.addChild(group.id, { id: pathId, name: s.name, parent: group.id, children: [], transform, visible: true, locked: false, components });
    }

    // SMIL animation → real keyframe tracks on this part. Offsets arrive in SVG
    // user units, so they scale with the group exactly like the geometry did.
    if (s.animation) writeSvgAnimation(pathId, s.animation, relX, relY, k);
  }
  });

  // Select ONLY the group — the icon is one selectable/movable body.
  useSelectionStore.getState().set([group.id]);
  bumpScene();
  return group.id;
}

/*
 * There is deliberately no local `clamp01` here any more.
 *
 * This file carried its own, differing from `@utils/lang`'s in the one way that
 * mattered: an ABSENT value clamped to 1 rather than 0. That is right for what
 * it clamps — SVG opacity attributes, where "not specified" means fully opaque
 * — and wrong as a general rule, which is why the two could not simply merge.
 *
 * The resolution `lang.ts` documents is for the CALL SITE to state its own
 * default (`?? 1`) and leave the shared clamp to do only the clamping. Folding
 * a default into a clamp is what made two functions out of one.
 */

/**
 * The app's own text measurer, handed to the SVG parser.
 *
 * The parser cannot reach `@core` (nothing in `src/utils` does) and measuring
 * needs a canvas, so it asks for this instead. Returning null — no DOM, or a
 * runtime with no text metrics — simply leaves text at its unmeasured
 * placeholder box rather than shifting it by a guess.
 */
export const measureSvgText: SvgTextMeasurer = (t) => {
  const style: MeasuredTextStyle = {
    content: t.content,
    fontSize: t.fontSize,
    fontFamily: t.fontFamily ?? 'Inter',
    fontWeight: t.fontWeight ?? '400',
    fontStyle: t.fontStyle ?? 'normal',
    letterSpacing: 0,
    // The same default `readMeasuredTextStyle` will apply at render time, since
    // the Text component this creates does not set one — measure and draw have
    // to agree or the box is the wrong height.
    lineHeight: DEFAULT_LINE_HEIGHT,
    paragraphSpacing: 0,
  };
  const size = measureTextSize(style);
  const boxes = measureTextBoxes(style);
  if (!size || !boxes) return null;
  return { advance: boxes.advance, width: size.w, height: size.h, baselineOffset: boxes.baselineOffset };
};

/**
 * Cuts a shape's runs at a clip region, for the SVG parser.
 *
 * Injected for the same reason the measurer is: `polygon-clipping` lives behind
 * `@core/scene/mergePaths` and nothing in `src/utils` reaches into `@core`.
 *
 * Flattening is the honest cost — `polygon-clipping` works on polygons, so a
 * clipped circle comes back as a fine-grained polygon. Merge Paths already
 * makes exactly that trade, and the alternative on offer was dropping the clip
 * entirely and letting the shape spill past its boundary.
 */
export const intersectSvgPaths: SvgPathIntersector = (subject, clip) => {
  const toPolygon = (runs: readonly SvgSubPath[]): number[][][] => runs
    .map((r) => {
      const ring = flattenOutline(r.points, 8).map((p) => [p.x, p.y]);
      if (ring.length < 3) return null;
      // polygon-clipping wants each ring closed.
      ring.push([ring[0]![0]!, ring[0]![1]!]);
      return ring;
    })
    .filter((r): r is number[][] => r !== null);

  const a = toPolygon(subject);
  const b = toPolygon(clip);
  if (a.length === 0 || b.length === 0) return null;
  let result;
  try {
    result = booleanPolygons([a as never, b as never], 'intersect');
  } catch {
    // Self-intersecting input can make the clipper throw. Keeping the shape
    // uncut is a smaller error than losing it.
    return null;
  }
  const out: SvgSubPath[] = [];
  for (const poly of result) {
    for (const ring of poly) {
      // Drop the repeated closing vertex — a SubPath is implicitly closed.
      const pts = ring.slice(0, ring.length > 1
        && ring[0]![0] === ring[ring.length - 1]![0]
        && ring[0]![1] === ring[ring.length - 1]![1] ? -1 : undefined);
      if (pts.length < 3) continue;
      out.push({ points: pts.map((p) => corner(p[0]!, p[1]!)), closed: true });
    }
  }
  return out;
};

/**
 * An SVG paint as something Canvas2D will actually accept.
 *
 * `fill="none"` used to be stored verbatim, and `ctx.fillStyle = 'none'` is not
 * a parse error — the spec says an invalid assignment is IGNORED, so the
 * context kept whatever colour it had last (black, on a fresh one) and every
 * stroke-only outline icon was painted as a solid black blob. `transparent` is
 * a real colour that paints nothing, which is what the file asked for.
 *
 * `fill-opacity` folds into the colour's own alpha. Named colours are left
 * alone: `applyAlpha` reads them as opaque black, and a slightly-too-opaque
 * fill is a far smaller error than a black one.
 */
function svgFillToCss(fill: string | undefined, fillOpacity: number | undefined): string {
  if (!fill || fill === 'none') return 'transparent';
  const a = clamp01(fillOpacity ?? 1);
  if (a >= 1) return fill;
  if (a <= 0) return 'transparent';
  return /^#|^rgba?\(/i.test(fill.trim()) ? applyAlpha(fill, a) : fill;
}

/** Parsed SVG gradient → engine FillPaint (colour stops + optional opacity ramp). */
function parsedGradientToFillPaint(g: ParsedGradientFill): FillPaint {
  const stops = g.stops.map((s) => makeStop(s.offset, s.color));
  const opacityStops: OpacityStop[] = g.stops.some((s) => s.opacity < 1)
    ? g.stops.map((s, i) => ({ id: `op_${i}`, offset: s.offset, opacity: s.opacity }))
    : [];
  if (g.type === 'radial') {
    return {
      type: 'radial',
      cx: g.cx ?? 0.5,
      cy: g.cy ?? 0.5,
      radius: g.radius ?? 0.5,
      stops,
      ...(opacityStops.length ? { opacityStops } : {}),
    };
  }
  return {
    type: 'linear',
    angle: g.angle ?? 90,
    stops,
    ...(opacityStops.length ? { opacityStops } : {}),
  };
}

/**
 * Write an imported SVG's keyframes onto a shape node.
 *
 * `x`/`y` arrive as OFFSETS from the part's static position and in SVG user
 * units, so they are scaled by the same `k` the geometry was and re-based onto
 * `relX`/`relY` — otherwise an animated part would snap to the group origin the
 * moment its first keyframe was written.
 *
 * These writes go straight to the animation engine, which emits nothing on its
 * own, so they are only captured by history because the caller finishes with
 * `bumpScene` (history snapshots the animation engine alongside the scene).
 * A future caller that skips that bump would write keyframes undo cannot reach.
 */
function writeSvgAnimation(
  nodeId: string,
  anim: SvgShapeAnimation,
  relX: number,
  relY: number,
  k: number,
): void {
  const write = (prop: string, kfs: ReadonlyArray<{ time: number; value: number; hold?: boolean }> | undefined, map: (v: number) => number): void => {
    if (!kfs || kfs.length === 0) return;
    // One bulk write per track. Writing keyframe-at-a-time re-sorted the track
    // and fired a change notification for every one of them, which is what made
    // importing an animated SVG hang the app.
    defaultAnimation.setKeyframes(nodeId, prop, kfs.map((kf) => ({
      t: kf.time,
      value: map(kf.value),
      // `calcMode="discrete"` and `<set>` must step, not glide.
      ...(kf.hold ? { easing: 'hold' as const } : {}),
    })));
    // An endless loop is baked as ONE cycle plus this expression, so its cost
    // does not grow with the composition's length.
    if (anim.loop) defaultAnimation.setExpression(nodeId, prop, `loopOut('${anim.loop}')`);
  };
  write('x', anim.x, (v) => relX + v * k);
  write('y', anim.y, (v) => relY + v * k);
  write('rotation', anim.rotation, (v) => v);
  write('scaleX', anim.scaleX, (v) => v);
  write('scaleY', anim.scaleY, (v) => v);
  write('opacity', anim.opacity, (v) => v);
  // Draw-on (stroke-dashoffset) arrives as trim-END percent. Keyframes are
  // scoped to the trim ENTRY, so the entry has to exist before the track can
  // name it — `addTrimOp` returns the id for exactly that reason.
  if (anim.trimEnd) {
    const trimId = addTrimOp(nodeId, { start: 0, end: 100, offset: 0 });
    write(pathOpPropPath(trimId, 'end'), anim.trimEnd, (v) => v);
  }
}

/** Insert a primitive at the composition root, select it, and refresh the UI. */
export function insertPrimitive(kind: SceneKind, name: string): void {
  const rootId = activeCompRootId();
  const node = makeNode(kind, name);
  placeInComp(node);
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** The distinct shapes the shape library can insert. */
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'star' | 'polygon' | 'triangle' | 'arrow' | 'heart' | 'cross' | 'diamond' | 'crescent';

type Pt = { x: number; y: number };
type BPoint = ReturnType<typeof corner>;

/**
 * Give a closed outline Catmull-Rom bezier tangents at the indices `smoothAt`
 * marks (corners elsewhere). Curved shapes (heart, crescent) were committed as
 * straight-segment polygons — visibly faceted; the renderer draws real cubic
 * beziers, so handing it tangents is all "smooth clean shapes" needs.
 */
function withTangents(pts: readonly Pt[], smoothAt: (i: number) => boolean): BPoint[] {
  const n = pts.length;
  const k = 1 / 6;
  return pts.map((p, i) => {
    if (!smoothAt(i)) return corner(p.x, p.y);
    const prev = pts[(i - 1 + n) % n]!;
    const next = pts[(i + 1) % n]!;
    const tx = (next.x - prev.x) * k;
    const ty = (next.y - prev.y) * k;
    return { x: p.x, y: p.y, inX: p.x - tx, inY: p.y - ty, outX: p.x + tx, outY: p.y + ty };
  });
}

/** Outline points (local space, centred at 0,0, spanning ±w/2 · ±h/2) for the
 *  path-based shapes. `rect`/`ellipse` return null — they render as native SDF
 *  primitives keyed off the `shapeType` prop, no geometry needed. */
function shapeOutlinePoints(shape: ShapeKind, w: number, h: number): Array<{ x: number; y: number }> | null {
  const rx = w / 2;
  const ry = h / 2;
  const TOP = -Math.PI / 2; // start at 12 o'clock so shapes point up
  switch (shape) {
    case 'polygon': {
      // Regular hexagon.
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < 6; i++) {
        const a = TOP + (i / 6) * Math.PI * 2;
        pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry });
      }
      return pts;
    }
    case 'triangle': {
      // Regular triangle pointing up.
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < 3; i++) {
        const a = TOP + (i / 3) * Math.PI * 2;
        pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry });
      }
      return pts;
    }
    case 'arrow': {
      // Clean arrow pointing up.
      return [
        { x: 0, y: -ry },
        { x: rx, y: -ry + ry * 0.9 },
        { x: rx * 0.4, y: -ry + ry * 0.9 },
        { x: rx * 0.4, y: ry },
        { x: -rx * 0.4, y: ry },
        { x: -rx * 0.4, y: -ry + ry * 0.9 },
        { x: -rx, y: -ry + ry * 0.9 },
      ];
    }
    case 'heart': {
      // Symmetric heart outline
      return [
        { x: 0, y: -ry * 0.35 },
        { x: rx * 0.35, y: -ry },
        { x: rx * 0.85, y: -ry },
        { x: rx, y: -ry * 0.45 },
        { x: rx, y: ry * 0.1 },
        { x: 0, y: ry },
        { x: -rx, y: ry * 0.1 },
        { x: -rx, y: -ry * 0.45 },
        { x: -rx * 0.85, y: -ry },
        { x: -rx * 0.35, y: -ry },
      ];
    }
    case 'cross': {
      // Clean plus / cross shape
      const cx = rx * 0.35;
      const cy = ry * 0.35;
      return [
        { x: -cx, y: -ry },
        { x: cx, y: -ry },
        { x: cx, y: -cy },
        { x: rx, y: -cy },
        { x: rx, y: cy },
        { x: cx, y: cy },
        { x: cx, y: ry },
        { x: -cx, y: ry },
        { x: -cx, y: cy },
        { x: -rx, y: cy },
        { x: -rx, y: -cy },
        { x: -cx, y: -cy },
      ];
    }
    case 'diamond': {
      // Diamond shape
      return [
        { x: 0, y: -ry },
        { x: rx, y: 0 },
        { x: 0, y: ry },
        { x: -rx, y: 0 },
      ];
    }
    case 'crescent': {
      // Crescent moon shape
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i <= 10; i++) {
        const pct = i / 10;
        const a = -Math.PI/2 + pct * Math.PI;
        pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry });
      }
      for (let i = 10; i >= 0; i--) {
        const pct = i / 10;
        const a = -Math.PI/2 + pct * Math.PI;
        pts.push({ x: Math.cos(a) * rx * 0.52 + rx * 0.32, y: Math.sin(a) * ry });
      }
      return pts;
    }
    case 'star': {
      // 5-point star: alternating outer / inner radius.
      const pts: Array<{ x: number; y: number }> = [];
      const innerRatio = 0.42;
      for (let i = 0; i < 10; i++) {
        const a = TOP + (i / 10) * Math.PI * 2;
        const r = i % 2 === 0 ? 1 : innerRatio;
        pts.push({ x: Math.cos(a) * rx * r, y: Math.sin(a) * ry * r });
      }
      return pts;
    }
    case 'line':
      // Diagonal stroke (bottom-left → top-right), matching the library icon.
      return [{ x: -rx, y: ry }, { x: rx, y: -ry }];
    default:
      return null; // rect / ellipse
  }
}

/**
 * Insert a specific shape (rectangle / ellipse / line / star / polygon) rather
 * than the generic square `insertPrimitive('shape', …)` produced for every
 * preset. `rect`/`ellipse` render as native SDF primitives; the others carry a
 * `Geometry` component so the renderer draws their real outline as a path.
 */
export function insertShape(shape: ShapeKind, name: string, pos?: { x: number; y: number }): void {
  const rootId = activeCompRootId();
  const node = makeNode('shape', name);
  placeInComp(node);

  const transform = node.components.find((c) => c.type === 'Transform');
  const W = (transform?.props.width as number) || 280;
  const H = (transform?.props.height as number) || 280;

  if (transform) {
    transform.props.width = W;
    transform.props.height = H;
    transform.props.shapeType = shape;
    if (pos) {
      transform.props.x = Math.round(pos.x);
      transform.props.y = Math.round(pos.y);
    }
  }

  const pts = shapeOutlinePoints(shape, W, H);
  if (pts) {
    // Curved shapes get real bezier tangents; angular shapes stay corners.
    // Heart: everything curves except the top notch (0) and bottom tip (5).
    // Crescent: two arcs — smooth their bellies, keep the joining tips sharp
    // (outer arc spans 0..10, inner 11..21).
    const points: BPoint[] =
      shape === 'heart'
        ? withTangents(pts, (i) => i !== 0 && i !== 5)
        : shape === 'crescent'
          ? withTangents(pts, (i) => i !== 0 && i !== 10 && i !== 11 && i !== 21)
          : pts.map((p) => corner(p.x, p.y));
    node.components.push({
      id: `${node.id}_g`,
      type: 'Geometry',
      // A line is an open stroke — flag it so the renderer doesn't close the
      // 2-point path into a degenerate loop.
      props: { points, ...(shape === 'line' ? { open: true } : {}) },
    });
  }

  if (shape === 'line') {
    // A line encloses no area, so a fill is invisible — give it a stroke.
    // The stroke must live on the `fx` component: readNodeStroke reads only
    // fx, so a stroke stashed in Style props would never render.
    const style = node.components.find((c) => c.type === 'Style');
    if (style) style.props.fill = 'rgba(0,0,0,0)';
    node.components.push({
      id: `${node.id}_fx`,
      type: 'fx',
      props: {
        stroke: { enabled: true, color: '#2b7eff', width: 6, opacity: 1, cap: 'round', join: 'miter', align: 'center', dash: [] },
      },
    });
  }

  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  enableContinuousRasterByDefault(node.id);
  bumpScene();
}

/**
 * The box a custom outline needs, symmetric about the local origin.
 *
 * A path layer's `width`/`height` are NOT cosmetic. The renderer rasterizes a
 * custom path into a `width × height` canvas centred on the local origin
 * (`Canvas2DVectorRasterizer.drawPath`) and places that texture on a
 * `width × height` quad (`snapshotToFrameScene.centerModel`) — and since the
 * engine unification there is only the GPU backend, nothing else draws the
 * points. So a 0×0 path layer rasterizes to a 1×1 canvas, lands on a zero-area
 * quad, and renders NOTHING while still existing and selecting. That is exactly
 * how every imported Lottie `ty:'sh'` layer came in invisible — the file
 * imported, the layers were there, and the canvas showed only selection
 * outlines.
 *
 * Symmetric (`2 × max|v|`) because the rasterizer centres the box on the origin:
 * a tight min/max box would clip every outline that is not already centred.
 * Bezier handles are included — they can bulge well outside the anchors.
 */
export function outlineExtent(points: readonly BPoint[]): { width: number; height: number } {
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx = Math.max(mx, Math.abs(p.x), Math.abs(p.inX), Math.abs(p.outX));
    my = Math.max(my, Math.abs(p.y), Math.abs(p.inY), Math.abs(p.outY));
  }
  return { width: mx * 2, height: my * 2 };
}

/**
 * Insert a custom-outline path layer carrying a `Geometry` points component —
 * the vector primitive the generic `create('shape', …)` action can't build
 * (it only makes rects/ellipses). Used by the Lottie importer to land `ty:'sh'`
 * layers; pair with an animated `path.points` data track for a moving outline.
 * Returns the new node id. Does NOT select or centre — the importer positions
 * layers explicitly.
 */
export function insertPathNode(
  name: string,
  points: BPoint[],
  opts: { closed?: boolean; x?: number; y?: number; width?: number; height?: number } = {},
): string {
  const rootId = activeCompRootId();
  const node = makeNode('shape', name);
  const transform = node.components.find((c) => c.type === 'Transform');
  if (transform) {
    const extent = outlineExtent(points);
    transform.props.width = opts.width ?? extent.width;
    transform.props.height = opts.height ?? extent.height;
    transform.props.shapeType = 'path';
    if (opts.x !== undefined) transform.props.x = opts.x;
    if (opts.y !== undefined) transform.props.y = opts.y;
  }
  node.components.push({
    id: `${node.id}_g`,
    type: 'Geometry',
    // `open: true` stops the renderer closing an open outline into a loop.
    props: { points, ...(opts.closed === false ? { open: true } : {}) },
  });
  defaultSceneGraph.addChild(rootId, node);
  bumpScene();
  enableContinuousRasterByDefault(node.id);
  return node.id;
}

/** Insert a text layer seeded with a preset's font size / weight, label, and style overrides. */
export function insertText(name: string, fontSize = 32, fontWeight = 400, extraProps: Record<string, any> = {}): void {
  const rootId = activeCompRootId();
  const node = makeNode('text', name);
  placeInComp(node, { customFontSize: fontSize > 36 ? fontSize : undefined });
  if (extraProps.pos) {
    const t = node.components.find((c) => c.type === 'Transform');
    if (t) {
      t.props.x = Math.round(extraProps.pos.x);
      t.props.y = Math.round(extraProps.pos.y);
    }
  }
  const text = node.components.find((c) => c.type === 'Text');
  if (text) {
    text.props.content = name;
    text.props.fontSize = fontSize;
    text.props.fontWeight = fontWeight;
    // Map extraProps onto Text component props
    for (const [key, value] of Object.entries(extraProps)) {
      if (key !== 'fill' && key !== 'pos') {
        text.props[key] = value;
      }
    }
  }
  // Map fill color onto the Style component when present — but text nodes are
  // built with only [Transform, Text], so colored presets (Neon, Tag, Quote…)
  // silently lost their color. The renderer reads `fill` off ANY component,
  // and the inspector writes to Style ?? Text, so Text is the right fallback.
  if (extraProps.fill) {
    const target =
      node.components.find((c) => c.type === 'Style') ??
      node.components.find((c) => c.type === 'Text');
    if (target) {
      target.props.fill = extraProps.fill;
    }
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  enableContinuousRasterByDefault(node.id);
  bumpScene();
}

/** Insert a full-frame solid colour layer (background / matte / adjustment base).
 *  Seeded at comp size and centre so selection handles match the fill; the
 *  layer remains a normal transformable shape flagged `solid`. */
export function insertSolid(color = '#4f7ea8'): void {
  const rootId = activeCompRootId();
  const node = makeNode('shape', 'Solid');
  const comp = useCompositionStore.getState();
  const w = comp.width || 1920;
  const h = comp.height || 1080;
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = w / 2;
    t.props.y = h / 2;
    t.props.width = w;
    t.props.height = h;
    // CENTRED — not (w/2, h/2). That is After Effects' numbering, where a
    // layer's anchor is measured from its top-left corner; this model stores
    // the anchor as an offset FROM THE LAYER CENTRE (see `anchor.ts`, and the
    // `ax !== 0` neutrality test in buildSnapshot). Seeding it with half the
    // layer cancelled the position outright — the world matrix came out as the
    // identity — parking a comp-sized solid with its centre on the comp's
    // top-left corner, three quarters of it outside the frame. Every other
    // insert in this file already writes 0.
    t.props.anchorX = 0;
    t.props.anchorY = 0;
    t.props.rotation = 0;
    t.props.scaleX = 1;
    t.props.scaleY = 1;
  }
  node.transform.position.x = w / 2;
  node.transform.position.y = h / 2;
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setSolid(node.id, true);
  defaultSceneGraph.setFill(node.id, { type: 'solid', color });
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Optional seed params for {@link insertCamera} (AE New Camera dialog).
 *  Every field defaults to the legacy silent-insert behavior. */
export interface CameraSeed {
  name?: string;
  /** Focal length in comp px (see Project3D / CameraSection). */
  focalLength?: number;
  /** Two-node camera: seed a Point of Interest at the comp centre. */
  twoNode?: boolean;
}

/** Insert a Camera layer, centred on the REAL comp and pulled back by its focal
 *  length so the comp plane renders 1:1. Position / z / focalLength are plain
 *  editable + keyframeable props (the inspector shows them automatically). */
export function insertCamera(seed: CameraSeed = {}): void {
  const rootId = activeCompRootId();
  const node = makeNode('camera', seed.name?.trim() || 'Camera 1');
  const compSize = useCompositionStore.getState();
  const cam = Project3D.defaultCamera(compSize.width, compSize.height);
  const focal = typeof seed.focalLength === 'number' && seed.focalLength > 0 ? seed.focalLength : cam.focalLength;
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    // Seeded before the node enters the graph, so these become its base props.
    // z = -focalLength keeps the comp plane 1:1 for ANY chosen lens.
    t.props.x = cam.position.x;
    t.props.y = cam.position.y;
    t.props.z = -focal;
    t.props.focalLength = focal;
    if (seed.twoNode) {
      // Two-node camera: an explicit Point of Interest the camera looks at.
      t.props.poiX = compSize.width / 2;
      t.props.poiY = compSize.height / 2;
      t.props.poiZ = 0;
    }
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  // A camera only affects layers whose 3D switch is on. Inserting one into an
  // all-2D scene silently did nothing — tell the user what to do next.
  // Only CONTENT layers count — other cameras/lights carry depth props but
  // aren't layers the camera can move.
  const anyThreeD = flattenScene(defaultSceneGraph).some((n) => {
    const k = readNodeKind(n);
    return n.id !== node.id && k !== 'camera' && k !== 'light' && is3DEnabled(n);
  });
  if (!anyThreeD) {
    useUIStore.getState().notify({
      level: 'info',
      message: 'Camera added — it moves layers with the 3D switch on. Select a layer and enable 3D, then move or keyframe the camera.',
      durationMs: 9000,
    });
  }
}

/** Optional seed params for {@link insertLight} (AE New Light dialog).
 *  Every field defaults to the legacy silent-insert behavior. */
export interface LightSeed {
  name?: string;
  /** Light kind (see readNodeLight): point (default), spot, parallel, ambient. */
  type?: LightType;
  /** Light colour (hex) — stored on Style.fill. */
  color?: string;
  /** Brightness percent (default 100). */
  intensity?: number;
  /** Spot only: full cone width, degrees. */
  coneAngle?: number;
  /** Spot only: cone edge softness, percent (see `lightConeFeather`). */
  coneFeather?: number;
  /** Cast 2.5D drop-shadows from this light. */
  castShadows?: boolean;
}

/** Insert a Light layer */
export function insertLight(seed: LightSeed = {}): void {
  const rootId = activeCompRootId();
  const node = makeNode('light', seed.name?.trim() || 'Light 1');
  const compSize = useCompositionStore.getState();
  // Seed position + keyframeable intensity/radius; warm colour via Style.fill.
  // Radius scales with the comp so the glow reads on any size (a fixed 500px
  // was easy to miss on a 1920-wide comp over bright content).
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = compSize.width / 2;
    t.props.y = compSize.height / 2;
    t.props.intensity = typeof seed.intensity === 'number' ? seed.intensity : 100;
    t.props.radius = Math.round(Math.max(compSize.width, compSize.height) * 0.45);
    // Only write the optional props when chosen — an unseeded light keeps the
    // exact prop shape it always had (readNodeLight defaults cover the rest).
    if (seed.type && seed.type !== 'point') t.props.lightType = seed.type;
    if (seed.type === 'spot' && typeof seed.coneAngle === 'number') t.props.lightCone = seed.coneAngle;
    if (seed.type === 'spot' && typeof seed.coneFeather === 'number') t.props.lightConeFeather = seed.coneFeather;
    // Cast shadows ON for a NEW light unless the caller says otherwise.
    //
    // `readNodeLight` treats a missing prop as false, so adding a light did
    // nothing but wash the scene — the shadow projection could never engage and
    // there was no hint that a switch elsewhere was gating it. Writing the prop
    // explicitly only affects lights created from here; existing lights keep
    // whatever they were saved with.
    t.props.castShadows = seed.castShadows !== false;
  }
  const s = node.components.find((c) => c.type === 'Style');
  if (s) s.props.fill = seed.color ?? '#fff3c0';
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert a 3D Parametric Primitive Mesh layer (AE 3D Design Space). */
export function insert3DPrimitive(type: 'cube' | 'sphere' | 'plane' | 'cylinder' = 'cube'): void {
  const rootId = activeCompRootId();
  const label = type === 'cube' ? '3D Cube' : type === 'sphere' ? '3D Sphere' : type === 'cylinder' ? '3D Cylinder' : '3D Plane';
  const node = makeNode('shape', label);
  const compSize = useCompositionStore.getState();
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = compSize.width / 2;
    t.props.y = compSize.height / 2;
    t.props.z = 0;
    t.props.rotationX = 0;
    t.props.rotationY = 0;
    t.props.width = 240;
    t.props.height = 240;
    t.props.primitiveType = type;
    t.props.castsShadows = true;
    t.props.acceptsLights = true;
    // Real extruded geometry: a Cube is a square extruded by its side length; a
    // Cylinder and a Sphere are both extruded ELLIPSES (`shapeType`), which is
    // what buildSnapshot's extrusion pass understands.
    //
    // "3D Sphere" used to set only `primitiveType`, and nothing in the codebase
    // reads that prop — so it inserted a flat 240×240 SQUARE. The name-based
    // fallback (/circle|ellip|dot|orb/) doesn't match "3D Sphere" either. Giving
    // it an ellipse profile and depth makes it a real, shaded, lit 3D body; it is
    // a capsule rather than a true sphere until curved meshes exist, which the
    // label below now says out loud instead of silently shipping a square.
    if (type === 'sphere' || type === 'cylinder') t.props.shapeType = 'ellipse';
    if (type === 'cube' || type === 'cylinder') t.props.extrusionDepth = 240;
    if (type === 'sphere') t.props.extrusionDepth = 240;
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  useUIStore.getState().notify({
    level: 'info',
    message: `${label} added to 3D Design Space`,
    durationMs: 3000,
  });
}
/** Insert a 3D Extruded Text layer pre-configured with solid contour volume extrusion. */
export function insert3DText(textLabel = '3D TEXT'): void {
  const rootId = activeCompRootId();
  const node = makeNode('text', textLabel);
  placeInComp(node, { customFontSize: 64 });
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.z = 0;
    t.props.rotationX = 0;
    t.props.rotationY = 0;
    t.props.is3D = true;
    t.props.extrusionDepth = 35;
    t.props.bevelDepth = 4;
    t.props.castsShadows = true;
    t.props.acceptsLights = true;
  }
  const textComp = node.components.find((c) => c.type === 'Text');
  if (textComp) {
    textComp.props.content = textLabel;
    textComp.props.fontSize = 64;
    textComp.props.fontWeight = 700;
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  useUIStore.getState().notify({
    level: 'info',
    message: '3D Extruded Text added to scene',
    durationMs: 3000,
  });
}

/** Insert a Particle emitter layer, positioned at the comp centre with a
 *  ready-to-play default fountain. The emitter follows the layer's transform. */
export function insertParticle(): void {
  const rootId = activeCompRootId();
  const node = makeNode('particle', 'Particles 1');
  const compSize = useCompositionStore.getState();
  const w = compSize.width || 1920;
  const h = compSize.height || 1080;
  const pW = 400;
  const pH = 400;
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = w / 2;
    t.props.y = h / 2;
    t.props.width = pW;
    t.props.height = pH;
    t.props.anchorX = 0;
    t.props.anchorY = 0;
  }
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setParticle(node.id, {
    ...DEFAULT_PARTICLE_CONFIG,
    emitterWidth: pW,
    emitterHeight: pH,
  });
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert an Adjustment Layer */
export function insertAdjustmentLayer(): void {
  const rootId = activeCompRootId();
  const node = makeNode('adjustment', 'Adjustment Layer 1');
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setSolid(node.id, true);
  defaultSceneGraph.setFill(node.id, { type: 'solid', color: 'rgba(255,255,255,0)' });
  defaultSceneGraph.setAdjustment(node.id, true);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/**
 * Insert a COMPOSITION as a layer (AE's core organizing model): a node that
 * references another comp's root and renders its content through the precomp
 * texture path. The same comp can be placed any number of times; edits to the
 * source comp show up in every instance. Refuses reference cycles.
 * Returns the new node id, or null when refused.
 */
export function insertCompInstance(refCompId: string): string | null {
  const hostRootId = activeCompRootId();
  if (!defaultSceneGraph.getNode(refCompId)) return null;
  if (wouldCreateCompCycle(defaultSceneGraph, hostRootId, refCompId)) {
    useUIStore.getState().notify({
      level: 'warning',
      message: 'That would create a composition loop — this comp is already used inside the one you are inserting.',
      durationMs: 6000,
    });
    return null;
  }
  const refName = defaultSceneGraph.getNode(refCompId)?.name ?? 'Composition';
  const node = makeNode('comp', refName);
  placeInComp(node);
  // The instance composites its expanded content as one unit (precomp path)
  // and carries the reference the renderer expands.
  node.components.push({
    id: `${node.id}_fx`,
    type: 'fx',
    props: { precomp: true, [COMP_REF_PROP]: refCompId },
  });
  defaultSceneGraph.addChild(hostRootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  return node.id;
}

/** Group selected layers into a new Pre-composition folder */
export function precomposeSelected(): void {
  const selectionStore = useSelectionStore.getState();
  const selectedIds = selectionStore.ids;
  if (selectedIds.length === 0) return;

  // Put the precomp where the layers already are — AE replaces them in place.
  // This used to hardcode `getRoots[0]`, which yanked nested layers up to the
  // root, and now that comps are separate roots would also drop them into
  // whichever composition happens to be first rather than the active one.
  const first = defaultSceneGraph.getNode(selectedIds[0]!);
  const parentId = first?.parent ?? activeCompRootId();

  const preCompNode = makeNode('group', 'Pre-comp 1');
  defaultSceneGraph.addChild(parentId, preCompNode);

  for (const childId of selectedIds) {
    // Keyframe-aware: `setParent`'s own compensation is static-props-only, so
    // precomposing an animated layer moved it by the pre-comp's offset.
    setParentPreservingWorld(childId, preCompNode.id);
  }

  // Flag it a real precomp: its subtree now composites as one unit (group
  // opacity / blend / effects apply to the nested result).
  defaultSceneGraph.setPrecomp(preCompNode.id, true);

  // The moved nodes' clips (trims / splits / positions / markers) follow them
  // into the precomp's own timeline. Without this, the next syncFromScene saw
  // them as orphans of the parent comp and silently deleted every time edit.
  getTimelineController().transferNodeClips(selectedIds, parentId, preCompNode.id);

  selectionStore.set([preCompNode.id]);
  bumpScene();
}

/**
 * Insert an audio layer. Audio doesn't draw on the canvas — it
 * carries an `Audio` component (asset ref + level/trim), shows a waveform in the
 * inspector, and plays in sync with the transport via the AudioEngine.
 */
export function insertAudio(asset: ImportedAsset): void {
  const rootId = activeCompRootId();
  const duration = asset.metadata?.duration ?? 0;
  const node = makeNode('audio', asset.name);
  const transform = node.components.find((c) => c.type === 'Transform');
  node.components = [
    ...(transform ? [transform] : []),
    {
      id: `${node.id}_a`,
      type: 'Audio',
      // `__`-prefixed so the generic NodeInspector hides them — the dedicated
      // AudioControls section owns editing (level / in-out / mute / waveform).
      props: {
        __assetId: asset.id,
        __src: asset.src,
        __level: 100,
        __start: 0,
        __in: 0,
        __out: duration,
        __duration: duration,
        __muted: false,
      },
    },
  ];
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** An SVG asset. Detected by extension — an object URL carries no mime type,
 *  and `ImportedAsset.metadata` records only width/height/duration. */
function isSvgAsset(asset: ImportedAsset): boolean {
  return asset.type === 'image' && /\.svg(\?|#|$)/i.test(asset.name);
}

/**
 * Tell the user what came across and what did not.
 *
 * The features the translator does not cover (motion paths, colour animation,
 * geometry morphs, event-driven `begin`) are silently absent otherwise — the
 * user would just see part of their file not moving and have no idea why.
 *
 * `unsupported` comes from the PARSE the caller already did, not a fresh scan:
 * some of what fails to convert is only discovered while converting (a
 * `translateX(100%)` that resolves to no motion, a keyframe budget that ran
 * out), and a re-scan cannot see any of it.
 */
function reportSvgAnimation(name: string, converted: boolean, unsupported: ReadonlySet<string>): void {
  const anims = converted ? 1 : 0;
  if (anims === 0 && unsupported.size === 0) return;

  if (anims > 0 && unsupported.size === 0) {
    useUIStore.getState().notify({
      level: 'success',
      message: `“${name}” imported with its animation as editable keyframes.`,
      durationMs: 4000,
    });
    return;
  }
  const skipped = [...unsupported].slice(0, 3).join(', ');
  useUIStore.getState().notify({
    level: 'warning',
    message: anims > 0
      ? `“${name}” imported with keyframes, but some animation could not be converted (${skipped}).`
      : `“${name}” imported as shapes; its animation could not be converted (${skipped}).`,
    durationMs: 6000,
  });
}

/**
 * Why an animated SVG could not be converted, in the user's words.
 *
 * "It imports static" with no reason is the least actionable message the
 * importer can give — this is what turns it into something the user can act on
 * (re-export without a motion path, flatten a colour animation, and so on).
 */
function svgAnimationBlockers(svgText: string): string[] {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return ['unreadable SVG'];
  return [...scanSvgAnimations(doc).unsupported];
}

/**
 * True when vectorizing this SVG would flood the scene with layers.
 *
 * Counted from the parsed shapes rather than a tag regex, so `<g>` wrappers and
 * `<defs>` don't inflate it. Warns, because "my SVG imported as a flat image"
 * is otherwise indistinguishable from a bug.
 */
function isOversizedSvg(count: number, name: string): boolean {
  if (count <= MAX_VECTOR_SHAPES) return false;
  useUIStore.getState().notify({
    level: 'warning',
    message: `“${name}” has ${count} vector paths — too many to edit as layers, so it imported as one image. Simplify or flatten it in your vector tool to keep the paths editable.`,
    durationMs: 7000,
  });
  return true;
}

/** Read an asset's SVG source. Object URLs and data URLs both fetch fine. */
async function readSvgText(src: string): Promise<string | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes('<svg') ? text : null;
  } catch {
    return null; // unreadable source — fall back to the image path
  }
}

/**
 * Insert an imported media asset (image or video), auto-fitted to the frame.
 *
 * **Contain, not native.** This placed footage at its stored pixel size, so a
 * 4K clip dropped into a 1080 composition arrived at 3840×2160 — four times the
 * frame, centred, with the visible quarter being whatever happened to be in the
 * middle. The user's first action after every single import was to scale it
 * down by hand. Native size is still available on demand (Layer ▸ Set to Native
 * Size); it is just not what an import should guess.
 *
 * PAR-corrected via `sourceOf`, so an anamorphic or DV source fits by its
 * DISPLAY shape rather than its stored one.
 */
export async function insertMedia(asset: ImportedAsset): Promise<void> {
  const rootId = activeCompRootId();
  if (asset.type === 'audio') {
    insertAudio(asset);
    return;
  }

  // SVG routing (hybrid architecture).
  //
  // The default is DEFERRED PARSING: the file is stored intact as one SVG
  // layer, rasterized faithfully, and parsed only when the user explicitly
  // asks for editable shapes. That is what makes import instant, keeps a
  // 300-path illustration to one layer, and reproduces gradients, masks,
  // filters, clip paths and patterns instead of approximating them.
  //
  // The ONE exception is an ANIMATED file. Our compositor is texture-based
  // (createRenderBackend: "exactly ONE rendering engine: the GPU-backed
  // MotionRendererBackend"), so a stored SVG can only be rasterized, and a
  // rasterized animation is a dead frame 0. The existing translator turns SMIL
  // and CSS `@keyframes` into real keyframe tracks, which is a WORKING
  // animation the user can edit — so animated files keep taking that path.
  // Losing the animation to gain fidelity is not a trade worth making; the
  // reverse is exactly what the shape path already does well.
  if (isSvgAsset(asset)) {
    const svgText = await readSvgText(asset.src);
    if (svgText) {
      const caps = scanSvgCapabilities(new DOMParser().parseFromString(svgText, 'image/svg+xml'));

      if (!isAnimatedSvg(caps)) {
        // Static: store it intact. No parser, no keyframes, one layer.
        const id = insertSvgLayer(svgText, asset.name, { capabilities: caps });
        if (id) return;
        // Unreadable markup — fall through to the plain image path.
      } else {
        // Animated: prefer editable keyframes only when the conversion is
        // lossless (`isSimpleSvg`). Otherwise keep the intact document and
        // play it via Live SVG time-rasterization — matching the Assets
        // preview instead of flattening gradients/masks/filters.
        const unsupported = new Set<string>();
        const shapes = parseSvgToShapes(svgText, {
          maxDurationSeconds: useCompositionStore.getState().durationSeconds,
          unsupportedOut: unsupported,
          measureText: measureSvgText,
          intersectPaths: intersectSvgPaths,
        });
        const convertible = shapes.some((s) => s.animation);
        const simple = isSimpleSvg(svgText);
        if (simple && convertible && !isOversizedSvg(shapes.length, asset.name)) {
          const size = Math.max(asset.metadata?.width ?? 0, asset.metadata?.height ?? 0) || 400;
          const id = insertSvgShapeGroup(svgText, asset.name, { targetSize: size, shapes });
          if (id) {
            reportSvgAnimation(asset.name, convertible, unsupported);
            return;
          }
        }
        // Live SVG: full visual fidelity + time-scrubbed playback.
        const blockers = unsupported.size > 0 ? [...unsupported] : svgAnimationBlockers(svgText);
        const id = insertSvgLayer(svgText, asset.name, {
          capabilities: caps,
          livePlayback: true,
          extraWarning: convertible && !simple
            ? 'playing as a Live SVG so gradients, masks and filters stay intact (not editable shapes). Convert to Editable Shapes when you need per-path control.'
            : !convertible
              ? `playing as a Live SVG (${blockers.slice(0, 3).join(', ') || 'complex animation'}). Convert to Editable Shapes only if you need keyframes.`
              : 'playing as a Live SVG for full animated fidelity.',
        });
        if (id) return;
      }
    }
    // Falls through to the plain image path only when the markup is unreadable.
  }

  const kind = asset.type === 'video' ? 'video' : 'image';
  const hasProbedSize = !!(asset.metadata?.width && asset.metadata?.height);
  const storedW = asset.metadata?.width ?? 400;
  const storedH = asset.metadata?.height ?? 400;
  // PAR is a property of the FILE, so it applies before any fitting: an
  // anamorphic source is 1024 wide on screen even though it stores 720.
  const par = asset.interpret?.par ?? 1;
  const frame = activeCompSize();
  const fitted = computeFit(
    { width: Math.round(storedW * par), height: storedH },
    frame,
    'contain',
  );
  // A probe-failed source falls back to a 400×400 GUESS. Contain-fitting the
  // guess upscaled it to a full-height square (1080×1080 in a 1080p comp) —
  // wrong size, wrong aspect. A guessed box lands at its neutral size; the
  // layer re-fits naturally when the user scales it or relinks the source.
  const width = hasProbedSize ? fitted.width : Math.min(fitted.width, Math.round(storedW * par));
  const height = hasProbedSize ? fitted.height : Math.min(fitted.height, storedH);

  const node = makeNode(kind, asset.name);
  const transform = node.components.find(c => c.type === 'Transform');
  if (transform) {
    transform.props.src = asset.src;
    transform.props.assetId = asset.id;
  }
  placeInComp(node, { customW: width, customH: height, exactSize: true });
  
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/**
 * Insert a standalone image layer from a ready `src` (e.g. a UI Kit component's
 * inline SVG data URL). No ImportedAsset / asset library entry — the src is
 * stored directly on the layer, so it must be self-contained (a data URL) to
 * survive reload. Returns the new node id.
 */
export function insertImageNode(opts: {
  name: string;
  src: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}): string {
  const rootId = activeCompRootId();
  const node = makeNode('image', opts.name);
  const transform = node.components.find((c) => c.type === 'Transform');
  if (transform) {
    transform.props.src = opts.src;
  }
  placeInComp(node, { customW: opts.width, customH: opts.height });
  if (opts.x !== undefined) {
    if (transform) transform.props.x = opts.x;
    node.transform.position.x = opts.x;
  }
  if (opts.y !== undefined) {
    if (transform) transform.props.y = opts.y;
    node.transform.position.y = opts.y;
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  return node.id;
}

/**
 * Insert an image SEQUENCE (numbered stills) as one footage layer. Detects play
 * order from the filenames, creates a blob URL per frame, and stores the ordered
 * frame list on the layer's `fx` so buildSnapshot swaps `src` to the frame for
 * the current source time. Returns false if fewer than two numbered files.
 */
export async function insertImageSequence(files: File[], fps = 30): Promise<boolean> {
  if (files.length < 2) return false;
  const detected = detectImageSequence(files.map((f) => f.name));
  if (!detected) return false;
  const byName = new Map(files.map((f) => [f.name, f]));
  const frames: string[] = [];
  for (const n of detected.frames) {
    const f = byName.get(n);
    if (f) frames.push(URL.createObjectURL(f));
  }
  if (frames.length < 2) return false;
  // First frame's native size.
  const dims = await new Promise<{ w: number; h: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.width, h: img.height });
    img.onerror = () => resolve({ w: 400, h: 400 });
    img.src = frames[0]!;
  });
  const rootId = activeCompRootId();
  const node = makeNode('image', detected.base);
  const comp = useCompositionStore.getState();
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.width = dims.w;
    t.props.height = dims.h;
    t.props.src = frames[0];
    t.props.x = comp.width / 2;
    t.props.y = comp.height / 2;
    node.transform.position.x = comp.width / 2;
    node.transform.position.y = comp.height / 2;
  }
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setImageSequence(node.id, { frames, fps });
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  return true;
}

/**
 * Delete all currently selected layers (and their descendants recursively).
 * Locked layers are skipped. Clears the selection after deletion.
 */
export function deleteSelectedLayers(): void {
  const { ids } = useSelectionStore.getState();
  if (ids.length === 0) return;

  // Filter out locked nodes and roots.
  const toDelete = ids.filter((id) => {
    const node = defaultSceneGraph.getNode(id);
    return node && !node.locked && node.parent !== null;
  });
  if (toDelete.length === 0) return;

  runDocumentEdit(toDelete.length === 1 ? 'Delete layer' : 'Delete layers', () => {
    // One primitive, shared with the timeline's clip context menu — see
    // `deleteLayerNode`. The two routes used to delete different things, which
    // is why deleting from the timeline appeared not to work at all.
    for (const id of toDelete) deleteLayerNode(id);
    useSelectionStore.getState().clear();
    bumpScene();
  });
}

/**
 * Duplicate all currently selected layers, offsetting each copy by +20px/+20px
 * (classic AE behaviour). The copies are added adjacent to the originals.
 */
export function duplicateSelectedLayers(): void {
  const { ids } = useSelectionStore.getState();
  if (ids.length === 0) return;

  const newIds: string[] = [];

  for (const id of ids) {
    const original = defaultSceneGraph.getNode(id);
    if (!original || original.parent === null) continue;

    // Deep-clone the node with a new id.
    const dupId = `${id}_dup_${Math.random().toString(36).slice(2, 6)}`;
    const dupComponents = original.components.map((c) => ({
      ...c,
      id: `${dupId}_${c.type}`,
      // Deep-clone props. A shallow `{ ...c.props }` shared the `pathOps`
      // array (and the operator objects inside it) with the original, so
      // editing Trim on the copy moved the original too.
      props: structuredClone(c.props),
    }));

    const dupNode = {
      id: dupId,
      name: `${original.name ?? 'Layer'} copy`,
      parent: null as string | null,
      children: [] as string[],
      transform: {
        position: {
          x: original.transform.position.x + 20,
          y: original.transform.position.y + 20,
        },
        rotation: original.transform.rotation,
        scale: { ...original.transform.scale },
      },
      visible: original.visible,
      locked: false,
      components: dupComponents,
    };

    defaultSceneGraph.addChild(original.parent!, dupNode as Parameters<typeof defaultSceneGraph.addChild>[1]);
    // The copy must carry its own keyframes, data tracks, and expressions.
    // Without this, duplicating a trimmed bar and sliding it to 1s / 2s left
    // the copies static, and the originals all played the same animation in
    // composition time. Property tracks alone also dropped Source Text and
    // puppet-pin animation, so the duplicate looked like a bare object.
    copyNodeAnimation(id, dupId);
    // Apply the x/y offset on the Transform component too.
    const tComp = dupComponents.find((c) => c.type === 'Transform');
    if (tComp && typeof tComp.props.x === 'number') {
      tComp.props.x = (tComp.props.x as number) + 20;
      tComp.props.y = (tComp.props.y as number) + 20;
      defaultSceneGraph.setLocalTransform(dupId, {
        x: tComp.props.x as number,
        y: tComp.props.y as number,
        rotation: (tComp.props.rotation as number) ?? 0,
      });
    }
    newIds.push(dupId);
  }

  if (newIds.length > 0) {
    useSelectionStore.getState().set(newIds);
    bumpScene();
  }
}

// ── Layer actions (operate on the current selection) ──────────────────

/** Wrap the selected layers in a new plain Group and select it. */
export function groupSelectedLayers(): void {
  const sel = useSelectionStore.getState();
  const ids = sel.ids;
  if (ids.length === 0) return;
  // Group in place, like precompose — a selection inside a precomp should not
  // be yanked up to the comp root.
  const first = defaultSceneGraph.getNode(ids[0]!);
  const rootId = first?.parent ?? activeCompRootId();
  const group = makeNode('group', 'Group');
  defaultSceneGraph.addChild(rootId, group);
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    if (node && node.parent !== null) setParentPreservingWorld(id, group.id);
  }
  sel.set([group.id]);
  bumpScene();
}

/** Dissolve the selected group(s): reparent their children up, remove the group. */
export function ungroupSelected(): void {
  const sel = useSelectionStore.getState();
  const ids = sel.ids;
  if (ids.length === 0) return;
  const rootId = activeCompRootId();
  const freed: string[] = [];
  let changed = false;
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    if (!node) continue;
    const isGroup = node.components.some((c) => c.props[SCENE_KIND_PROP] === 'group' || c.type === 'group');
    if (!isGroup) continue;
    const parentId = node.parent ?? rootId;
    for (const child of defaultSceneGraph.getChildren(id)) {
      setParentPreservingWorld(child.id, parentId);
      freed.push(child.id);
    }
    defaultSceneGraph.removeNode(id);
    changed = true;
  }
  if (changed) {
    sel.set(freed);
    bumpScene();
  }
}

/** Toggle a boolean layer flag across the whole selection (all follow the
 *  first node's inverse, so one click flips them together). */
function toggleSelectionFlag(flag: 'locked' | 'solo' | 'visible'): void {
  const ids = useSelectionStore.getState().ids;
  if (ids.length === 0) return;
  const first = defaultSceneGraph.getNode(ids[0]!);
  if (!first) return;
  const next = flag === 'visible' ? first.visible === false : !first[flag];
  const label = flag === 'visible'
    ? (next ? 'Show layer' : 'Hide layer')
    : flag === 'locked'
      ? (next ? 'Lock layer' : 'Unlock layer')
      : (next ? 'Solo layer' : 'Unsolo layer');
  runDocumentEdit(label, () => {
    if (flag === 'visible') {
      for (const id of ids) {
        const node = defaultSceneGraph.getNode(id);
        if (node) node.visible = next;
      }
    } else {
      for (const id of ids) {
        const node = defaultSceneGraph.getNode(id);
        if (node) node[flag] = next;
      }
    }
    bumpScene();
  });
}

export const toggleSelectedLocked = (): void => toggleSelectionFlag('locked');
export const toggleSelectedSolo = (): void => toggleSelectionFlag('solo');
export const toggleSelectedVisible = (): void => toggleSelectionFlag('visible');

/**
 * Group the currently selected nodes into a single master group body.
 */
export function groupSelectedNodes(groupName = 'Group Assembly'): string | null {
  const selection = useSelectionStore.getState().ids;
  if (selection.length === 0) return null;

  const rootId = activeCompRootId();
  const nodes = selection.map((id) => defaultSceneGraph.getNode(id)).filter((n): n is SceneNode => Boolean(n));
  if (nodes.length === 0) return null;

  // Calculate center of selected nodes
  let sumX = 0, sumY = 0;
  for (const n of nodes) {
    sumX += n.transform.position.x;
    sumY += n.transform.position.y;
  }
  const groupX = Math.round(sumX / nodes.length);
  const groupY = Math.round(sumY / nodes.length);

  const group = makeNode('group', groupName);
  const tComp = group.components.find((c) => c.type === 'Transform');
  if (tComp) {
    tComp.props.x = groupX;
    tComp.props.y = groupY;
  }
  group.transform.position.x = groupX;
  group.transform.position.y = groupY;

  defaultSceneGraph.addChild(rootId, group);

  // Re-parent selected nodes under the new group, offsetting position relative to group center
  for (const n of nodes) {
    setParentPreservingWorld(n.id, group.id);
    const relX = n.transform.position.x - groupX;
    const relY = n.transform.position.y - groupY;
    n.transform.position.x = relX;
    n.transform.position.y = relY;
    const t = n.components.find((c) => c.type === 'Transform');
    if (t) {
      t.props.x = relX;
      t.props.y = relY;
    }
  }

  useSelectionStore.getState().set([group.id]);
  bumpScene();
  return group.id;
}

/**
 * Ungroup / Detach a group node into standalone sub-layers.
 */
export function ungroupSelectedNode(targetId?: string): string[] {
  const selection = targetId ? [targetId] : useSelectionStore.getState().ids;
  const newSelection: string[] = [];

  for (const id of selection) {
    const groupNode = defaultSceneGraph.getNode(id);
    if (!groupNode) continue;
    const children = defaultSceneGraph.getChildren(groupNode.id);
    if (children.length === 0) continue;

    const rootId = activeCompRootId();

    for (const child of children) {
      // The child's new local used to be computed here as "its position plus
      // the group's" — which happened to land right only because `getChildren`
      // hands back a snapshot taken before the relink, and which wrote raw base
      // props an animated layer's own tracks then overrode. One world-preserving
      // relink replaces both halves, and it is the same one the parent dropdown
      // and Group Layers use.
      setParentPreservingWorld(child.id, rootId);
      newSelection.push(child.id);
    }

    defaultSceneGraph.removeNode(groupNode.id);
  }

  if (newSelection.length > 0) {
    useSelectionStore.getState().set(newSelection);
    bumpScene();
  }
  return newSelection;
}
