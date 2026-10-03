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
import { writeTransformProps } from './transformWrite';
import { SCENE_KIND_PROP, type SceneKind } from './sceneKind';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';
import type { ImportedAsset } from '@stores/assetStore';
import { type ParsedShape } from '../../utils/svgParser';
import { defaultAnimation } from '@motion/animation';
import { copyNodeAnimation } from '@core/animation/cloneNodeAnimation';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { is3DEnabled } from './threeD';
import { readNodeLight } from './light';
import { flattenComposition, flattenScene, readNodeKind } from './sceneDerive';
import { type PrimitiveSpec } from './primitiveLayer';
import { getTimelineController } from '@core/timeline/TimelineController';
import { COMP_REF_PROP, wouldCreateCompCycle } from './compInstance';
import { DEFAULT_PARTICLE_CONFIG } from '@core/particles/particleSim';
import { detectImageSequence } from '@core/scene/imageSequence';
import { type SvgCapabilities } from '@core/svg/svgCapabilities';
import { enableContinuousRasterByDefault } from '@core/scene/continuousRaster';
import { type LayerSink } from '@/engine-client/layerSink';
import type { InsertFrame } from '@/engine-client/insertFragment';



export { activeCompRootId } from './activeComp';
import { activeCompRootId } from './activeComp';
import { defaultTextSize } from '@core/scene/textDefaults';


import { useProjectStore } from '@stores/projectStore';
import { Matrix } from '@motion/scene';

import { setParentPreservingWorld } from '@core/scene/parenting';
import { parentWorld2DAt } from '@core/scene/layerSpace';
import { useInfoStore } from '@stores/infoStore';

import { makeNode, placeInFrame, notifySvgWarnings, buildSvgLayer, buildSvgIconGroup, buildPrimitive, buildShape, outlineExtent, buildText, buildSolid, notifyCameraNeeds3D, buildCamera, notifyAmbientFill, buildLight, notify3DPrimitive, build3DPrimitive, notify3DText, build3DText, buildAudio, isSvgAsset, readSvgText, buildSvgDocument, buildFootage, buildImageNode, type PlaceOptions, type ShapeKind, type BPoint, type CameraSeed, type LightSeed, type Primitive3DKind, type BuiltSvgDocument } from './layerBuilders';
export {
  makeNode, placeInFrame, notifySvgWarnings, buildSvgLayer, buildSvgIconGroup, measureSvgText, intersectSvgPaths, buildPrimitive, buildShape, outlineExtent, buildText, buildSettingsSolid, buildSolid, notifyCameraNeeds3D, buildCamera, AMBIENT_FILL_INTENSITY, notifyAmbientFill, buildLight, notify3DPrimitive, build3DPrimitive, notify3DText, build3DText, buildAudio, isSvgAsset, readSvgText, buildSvgDocument, buildMedia, buildFootage, buildImageNode, buildImageSequence,
  type PlaceOptions, type ShapeKind, type CameraSeed, type LightSeed, type Primitive3DKind, type BuiltSvgDocument,
} from './layerBuilders';

/**
 * Places an inserted node under the active pointer cursor (or comp center if off-canvas),
 * and assigns a prominent, scene-proportional width/height/fontSize so elements are
 * visibly clear, large, and easy to edit across any composition resolution (HD, 4K, Reel, etc.).
 */
export function placeInComp(
  node: SceneNode,
  opts?: PlaceOptions,
): void {
  placeInFrame(node, legacyFrame(), opts);
}


/**
 * The insert frame read from the editor stores and the page replica (the
 * legacy inserts below). The engine-client inserts read theirs from the
 * mirror (engine-client/insertFragment.ts `insertFrame`).
 */
export function legacyFrame(): InsertFrame {
  const activeTabId = useProjectStore.getState().activeTabId;
  const activeTab = useProjectStore.getState().tabs[activeTabId ?? ''];
  const compId = activeTab?.compositionId ?? 'comp_root';
  const comp = useProjectStore.getState().comps[compId] ?? useCompositionStore.getState();
  const info = useInfoStore.getState();
  return {
    comp: activeCompRootId(),
    width: comp.width,
    height: comp.height,
    durationSeconds: comp.durationSeconds,
    fps: comp.fps,
    cursor: info.present ? { x: info.x, y: info.y } : null,
    ...(comp.defaultEnvPreset !== undefined ? { defaultEnvPreset: comp.defaultEnvPreset } : {}),
  };
}

/**
 * The page replica as a {@link LayerSink} — what the legacy inserts below
 * write through (and the parity tests' "before").
 */
export function legacySink(): LayerSink {
  return {
    addChild: (parent, node) => defaultSceneGraph.addChild(parent, node as SceneNode),
    setFxKey: (id, key, value) => defaultSceneGraph.setFxKey(id, key, value),
    setKeyframe: (id, prop, t, value, easing) => defaultAnimation.setKeyframe(id, prop, t, value, easing as never),
    setKeyframes: (id, prop, keys) => defaultAnimation.setKeyframes(id, prop, keys as never),
    setExpression: (id, prop, src) => defaultAnimation.setExpression(id, prop, src),
  };
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
  // Through the transform router (a keyed Position gets a key, not a base
  // write the renderer would ignore); it bumps the scene itself.
  writeTransformProps(nodeId, [{ prop: 'x', value: localX }, { prop: 'y', value: localY }], 'Move');
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
  const made = buildSvgLayer(legacySink(), legacyFrame(), svgText, name, opts);
  if (!made) return null;
  useSelectionStore.getState().set([made.id]);
  bumpScene();
  notifySvgWarnings(name, made.warnings);
  return made.id;
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
  let id: string | null = null;
  // ONE change notification for the whole import. Unbatched, every track wrote
  // through the full AnimationChanged listener chain (scene bump → synchronous
  // hit-test rebuild → autosave scheduling), which is what froze the app on
  // multi-shape animated files. The final bumpScene below is the visible one.
  defaultAnimation.batch(() => {
    id = buildSvgIconGroup(legacySink(), legacyFrame(), svgText, name, opts);
  });
  if (!id) return null;
  // Select ONLY the group — the icon is one selectable/movable body.
  useSelectionStore.getState().set([id]);
  bumpScene();
  return id;
}


/** Insert a primitive at the composition root, select it, and refresh the UI. */
export function insertPrimitive(kind: SceneKind, name: string): void {
  const id = buildPrimitive(legacySink(), legacyFrame(), kind, name);
  useSelectionStore.getState().set([id]);
  bumpScene();
}


/**
 * Insert a specific shape (rectangle / ellipse / line / star / polygon) rather
 * than the generic square `insertPrimitive('shape', …)` produced for every
 * preset. `rect`/`ellipse` render as native SDF primitives; the others carry a
 * `Geometry` component so the renderer draws their real outline as a path.
 */
export function insertShape(shape: ShapeKind, name: string, pos?: { x: number; y: number }): void {
  const id = buildShape(legacySink(), legacyFrame(), shape, name, pos);
  useSelectionStore.getState().set([id]);
  bumpScene();
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
export function insertText(name: string, fontSize = defaultTextSize(), fontWeight = 400, extraProps: Record<string, any> = {}): void {
  const id = buildText(legacySink(), legacyFrame(), name, fontSize, fontWeight, extraProps);
  useSelectionStore.getState().set([id]);
  bumpScene();
}


/** Insert a full-frame solid colour layer (background / matte / adjustment base).
 *  Seeded at comp size and centre so selection handles match the fill; the
 *  layer remains a normal transformable shape flagged `solid`. */
export function insertSolid(color = '#4f7ea8'): void {
  const id = buildSolid(legacySink(), legacyFrame(), color);
  useSelectionStore.getState().set([id]);
  bumpScene();
}


/** Insert a Camera layer, centred on the REAL comp and pulled back by its focal
 *  length so the comp plane renders 1:1. Position / z / focalLength are plain
 *  editable + keyframeable props (the inspector shows them automatically). */
/**
 * `Camera N` / `Light N` with the lowest N no layer of that kind in the active
 * comp already uses. Both inserts hard-coded "… 1", so the second camera was
 * another "Camera 1" — and the view menu, which lists cameras by name so you
 * can look through one, showed two identical entries.
 */
export function nextDeviceName(kind: 'camera' | 'light'): string {
  const base = kind === 'camera' ? 'Camera' : 'Light';
  const used = new Set<string>();
  for (const n of flattenComposition(defaultSceneGraph, activeCompRootId())) {
    if (readNodeKind(n) === kind && n.name) used.add(n.name.trim());
  }
  let i = 1;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

export function insertCamera(seed: CameraSeed = {}): void {
  const id = buildCamera(legacySink(), legacyFrame(), { ...seed, name: seed.name?.trim() || nextDeviceName('camera') });
  useSelectionStore.getState().set([id]);
  bumpScene();
  // A camera only affects layers whose 3D switch is on. Inserting one into an
  // all-2D scene silently did nothing — tell the user what to do next.
  // Only CONTENT layers count — other cameras/lights carry depth props but
  // aren't layers the camera can move.
  const anyThreeD = flattenScene(defaultSceneGraph).some((n) => {
    const k = readNodeKind(n);
    return n.id !== id && k !== 'camera' && k !== 'light' && is3DEnabled(n);
  });
  if (!anyThreeD) notifyCameraNeeds3D();
}


/**
 * True when `rootId` already holds a light that lifts every surface — an
 * ambient or an environment probe — so a new positional light is not the
 * only thing lighting the scene.
 */
export function compHasAmbientLight(rootId: string): boolean {
  return flattenComposition(defaultSceneGraph, rootId).some((n) => {
    if (readNodeKind(n) !== 'light') return false;
    const t = readNodeLight(n).type;
    return t === 'ambient' || t === 'environment';
  });
}

export function insertLight(seed: LightSeed = {}): void {
  const rootId = activeCompRootId();
  const made = buildLight(legacySink(), legacyFrame(), {
    ...seed,
    name: seed.name?.trim() || nextDeviceName('light'),
    compHasAmbient: compHasAmbientLight(rootId),
  });
  if (made.fill) notifyAmbientFill();
  useSelectionStore.getState().set([made.light]);
  bumpScene();
}


/**
 * Insert a 3D primitive layer (AE 3D Design Space).
 *
 * TWO GEOMETRY PATHS, on purpose:
 *
 *  • **Cube** and **Plane** stay on the extrusion / quad path. An extruded
 *    square already IS a real box — watertight walls, caps, a bevel you can
 *    animate, per-face materials — so routing it through a plain box mesh
 *    would trade features away for uniformity. A plane is a quad, and a quad
 *    can carry an image.
 *
 *  • Everything CURVED — sphere, cylinder, cone, torus, capsule (and `box`,
 *    reachable by re-typing one of them in the inspector) — is a generated
 *    triangle mesh carried by a `Primitive` component. Sweeping an outline
 *    along z cannot make these: a "sphere" built that way is a capsule, and a
 *    cylinder built as 20 flat strips shows its facets. See primitiveLayer.ts.
 *
 * `spec` overrides the type's defaults (the New 3D Primitive dialog passes the
 * radius / height / segment counts it collected); a bare call still inserts
 * the same default object it always did.
 */
export function insert3DPrimitive(type: Primitive3DKind = 'cube', spec?: Partial<PrimitiveSpec>): void {
  const id = build3DPrimitive(legacySink(), legacyFrame(), type, spec);
  useSelectionStore.getState().set([id]);
  bumpScene();
  notify3DPrimitive(type);
}


/** Insert a 3D Extruded Text layer pre-configured with solid contour volume extrusion. */
export function insert3DText(textLabel = '3D TEXT'): void {
  const id = build3DText(legacySink(), legacyFrame(), textLabel);
  useSelectionStore.getState().set([id]);
  bumpScene();
  notify3DText();
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
  const id = buildAudio(legacySink(), legacyFrame(), asset);
  useSelectionStore.getState().set([id]);
  bumpScene();
}


/**
 * Insert an SVG DOCUMENT (markup text) into the active composition — the one
 * router behind both dropping an `.svg` file and pasting SVG markup from the
 * clipboard (Illustrator, Figma, a browser), so the two land identically.
 *
 * SVG routing (hybrid architecture).
 *
 * The default is DEFERRED PARSING: the document is stored intact as one SVG
 * layer, rasterized faithfully, and parsed only when the user explicitly asks
 * for editable shapes (Convert to Editable Shapes). That is what makes import
 * instant, keeps a 300-path illustration to one layer, and reproduces
 * gradients, masks, filters, clip paths and patterns instead of approximating
 * them.
 *
 * The ONE exception is an ANIMATED document. Our compositor is texture-based
 * (createRenderBackend: "exactly ONE rendering engine: the GPU-backed
 * MotionRendererBackend"), so a stored SVG can only be rasterized, and a
 * rasterized animation is a dead frame 0. The existing translator turns SMIL
 * and CSS `@keyframes` into real keyframe tracks, which is a WORKING animation
 * the user can edit — so animated documents keep taking that path. Losing the
 * animation to gain fidelity is not a trade worth making; the reverse is
 * exactly what the shape path already does well.
 *
 * `sizeHint` is the source's probed pixel size (largest side), used only to
 * size an animated shape group; a clipboard paste has none and gets the
 * importer's 400px default.
 *
 * Returns the new layer id, or null when the markup cannot be read at all
 * (the file importer then falls back to a plain image; paste reports nothing
 * to paste).
 */
export function insertSvgDocument(
  svgText: string,
  name: string,
  opts?: { sizeHint?: number },
): string | null {
  let made: BuiltSvgDocument | null = null;
  defaultAnimation.batch(() => {
    made = buildSvgDocument(legacySink(), legacyFrame(), svgText, name, opts);
  });
  if (!made) return null;
  const { id, report } = made as BuiltSvgDocument;
  useSelectionStore.getState().set([id]);
  bumpScene();
  report();
  return id;
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
export async function insertMedia(asset: ImportedAsset): Promise<string | undefined> {
  if (asset.type === 'audio') {
    insertAudio(asset);
    return;
  }

  // SVG: one router shared with clipboard paste (see `insertSvgDocument`).
  // Falls through to the plain image path only when the markup is unreadable.
  if (isSvgAsset(asset)) {
    const svgText = await readSvgText(asset.src);
    if (svgText) {
      const sizeHint = Math.max(asset.metadata?.width ?? 0, asset.metadata?.height ?? 0) || undefined;
      const id = insertSvgDocument(svgText, asset.name, { sizeHint });
      if (id) return;
    }
  }

  const id = buildFootage(legacySink(), legacyFrame(), asset);
  useSelectionStore.getState().set([id]);
  bumpScene();
  return id;
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
  const id = buildImageNode(legacySink(), legacyFrame(), opts);
  useSelectionStore.getState().set([id]);
  bumpScene();
  return id;
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
  if (frames.length < 2) {
    // Nothing will reference these — revoke, or each refused drop keeps its
    // file bytes pinned for the session.
    for (const url of frames) URL.revokeObjectURL(url);
    return false;
  }
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
