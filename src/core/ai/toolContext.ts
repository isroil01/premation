/**
 * The bridge between the pure `@motion/ai-tools` package and this app's engine
 * (NATIVE_CORE_PLAN §5 B5, ENGINE_API.md §12).
 *
 * Three jobs, all load-bearing:
 *
 * 1. **Writes are engine commands.** Every facade write that the engine API can
 *    express EXACTLY as the tool meant it is sent as a command on the turn's
 *    `AiEngineSession` — so an AI turn is one engine gesture (one undo entry,
 *    replayable from the command log, unchanged against the C++ engine). A
 *    write the API cannot express yet keeps its legacy writer, and says so:
 *    `session.legacy(<gap>)` names the gap, and the turn then commits as a
 *    whole-document snapshot entry instead (still one undo step). The gaps are
 *    listed in `LEGACY_GAPS` below; each engine route falls back to its legacy
 *    writer when the engine refuses (nothing changed on a refusal).
 *
 * 2. **Time.** The facades speak COMPOSITION seconds — the API's axis. The
 *    engine converts to each property's stored keyframe axis in one place (the
 *    same `compToKeyframeTime` the renderer samples on), for the value AND its
 *    easing, which is bug B1's fix by construction. Legacy writers convert here
 *    with the same function.
 *
 * 3. **The undo boundary.** No facade exposes the command system. A handler
 *    physically cannot push its own history entry, so thirty tool calls can't
 *    become thirty undo steps.
 *
 * Reads stay host reads of the live document (async, so they can become engine
 * queries with B4's mirror — docs/B3_PATTERNS.md §8), except where a write needs
 * an engine fact (keyframe ids come from the `getKeyframes` query).
 */

import type {
  AiEngineSession,
  AnimFacade,
  CompFacade,
  CompSettingsView,
  KeyframeView,
  LayerShapeSpec,
  SceneFacade,
  SceneNodeView,
  TimeFacade,
  ToolContext,
} from '@motion/ai-tools';
import { AiEngineError } from '@motion/ai-tools';
import {
  flicksToSeconds,
  secondsToFlicks,
  type Command,
  type CommandResult,
  type Easing,
  type KeyframeInsert,
  type LayerKind,
  type PropRef,
  type PropertyInfo,
  type PropertyInit,
  type Value,
} from '@motion/engine-api';
import { THREE_D_PROPS } from '@core/scene/threeD';
import { activeCompRootId } from '@core/scene/activeComp';
import { resetSceneWindow } from './sceneWindow';
import { setRuntimeStyle } from './design';
import { setEntranceSeed } from './archetypes';
import { SCENE_KIND_PROP } from '@core/scene/sceneKind';
import { POLYSTAR_FX_PROP } from '@core/scene/polystar';
import { parsePaintColorPath, parsePaintPropPath } from '@core/paint/paintProps';
import { nextDeviceNameIn } from '@core/mirror/deviceNames';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { documentMirror } from '@stores/documentMirror';
import { primaryParamKey } from '@core/effects/effects';
import { defaultPrecompName } from '@core/composition/precompose';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import type { EffectType } from '@core/effects/effects';
import { listPresets } from '@core/animation/animationPresets';
import { bumpScene } from '@stores/sceneStore';
import { engine } from '@core/engine/engineInstance';
import { layerSubtree } from '@core/mirror/docFacts';
import { membersOf, numbersOfValue, trackRefIn } from '@core/mirror/trackIndex';
import { keyTargetFor, keyAddressable, separateDimensionsCommand, apiColorOfHex, effectParamCommand, ENGINE_EASINGS, activePlayheadSeconds } from '@core/engine/trackWrites';
import { componentOfType, fieldWrite, propRefForTrack, memberWrite, memberWrites } from '@core/engine/propRefs';
import { apiUnitFactor } from '@core/engine/props';
import { fpsToRational } from '@core/engine/time';
import type { SceneNode } from '@core/types';
import { spreadPlacement } from './propOwner';
import { EngineTurnSession } from './aiEngineSession';
import { effectDefFor } from '@core/effects/effects';
import { FragmentBuilder } from '@/engine-client/fragmentBuilder';
import { allLayerIds, compLayerIds, hasNode, layerEffects, layerInfo, layerKind, layerView, puppetPins, staticField, treeOf } from './mirrorReads';

/**
 * Property paths the render pipeline actually samples.
 *
 * `PropPath` is a free-form string, so the engine will happily store a track
 * for `width` that nothing ever reads — the animation just silently doesn't
 * happen. This list is the real contract, and it is the single place it lives.
 */
export const TRANSFORM_PROPS = ['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'opacity'] as const;
// Imported from the scene layer, NOT re-declared. Two copies of the list that
// decides whether a layer counts as 3D is two chances to disagree — and this
// file's own docstring above insists the contract lives in ONE place.
export { THREE_D_PROPS };
export const SPECIAL_PROPS = ['timeRemap', 'precompTime'] as const;
/**
 * Camera-only props. The renderer samples any keyframed prop on the camera node
 * by name (readSceneCamera in buildSnapshot), so these all drive the view once
 * the animatable allowlist admits them. x / y / z come from TRANSFORM/THREE_D.
 */
export const CAMERA_PROPS = [
  'focalLength', // zoom
  'orbitYaw',
  'orbitPitch',
  // IN-PLACE rotation — a tripod pan / tilt / roll. Distinct from the orbit
  // pair above, which swings the EYE along an arc: without these the AI layer
  // can dolly-arc but cannot pan, and a pan is one of the most common camera
  // moves in motion design. `orientationZ` shipped keyframeable and inspectable
  // while being absent from this list, so a dutch angle was equally undrivable.
  'orientationX', // tilt
  'orientationY', // pan
  'orientationZ', // roll
  'poiX', // look-at target
  'poiY',
  'poiZ',
  'dofStrength',
  'focusDistance',
  'dofAperture',
] as const;

/**
 * A gradient FILL's geometry. `buildSnapshot`'s fillPaint resolution samples
 * these by name on any layer whose fill is a gradient — `fillAngle` for linear,
 * the other three for radial — and they are FRACTIONS of the layer box, the
 * paint model's own unit. `create_gradient kind:"radial"` builds exactly such a
 * fill, so without these in the gate the tool could create a radial backdrop
 * that nothing could then move.
 */
export const GRADIENT_FILL_PROPS = ['fillAngle', 'fillCenterX', 'fillCenterY', 'fillRadius'] as const;

/**
 * Layer tracks the renderer samples beyond the transform core — an EXPLICIT
 * list, deliberately not derived from the catalog.
 *
 * The obvious derivation ("every STATIC_PROPERTY_META row that is
 * keyframeable") is no filter at all: the catalog carries no
 * `keyframeable: false` entry, so it would admit `fontFamily`-adjacent rows,
 * material switches and audio levels alike, and the gate would stop meaning
 * "this animates". Each name here is one the native suite
 * (`animatableCatalog.native.test.ts`) keys on a real layer of the kind that
 * draws it and reads back as animated, so the list cannot claim a track the
 * engine does not address.
 */
export const SAMPLED_LAYER_PROPS = [
  'anchorX', 'anchorY',
  'skew', 'skewAxis',
  'fillOpacity',
  // Not 'strokeDashOffset': Dash Offset exists only on a dashed stroke (AE, and
  // the engine's property tree), and no AI tool sets a dash pattern.
  'strokeWidth', 'strokeOpacity',
  'letterSpacing',
] as const;

/**
 * A 3D layer's Material / Geometry Options that animate (the engine's
 * `material/…` and `geometry/…` rows, which exist once the layer is 3D):
 * an extrusion that grows, a surface that turns to chrome, glass that clears.
 * Held to the engine like the list above (animatableCatalog.native.test.ts).
 */
export const MATERIAL_PROPS = [
  'extrusionDepth', 'bevelDepth',
  'ambient', 'diffuse', 'specular', 'shininess',
  'metal', 'roughness', 'reflectionIntensity', 'reflectionSharpness', 'transparency', 'lightTransmission',
] as const;

/**
 * A light layer's animatable Light Options (`light/…`): a pulse, a spot that
 * opens, a shadow that softens, a key that tracks its subject. The point of
 * interest shares CAMERA_PROPS' names (poiX / poiY / poiZ).
 */
export const LIGHT_PROPS = ['intensity', 'lightCone', 'lightConeFeather', 'shadowDarkness', 'shadowDiffusion', 'falloffDistance'] as const;

const isPrefixed = (prop: string): boolean =>
  // 'pathop.' LOWERCASE: that is what `pathOpPropPath` writes and what the
  // renderer samples. This gate said `pathOp.` (camelCase) — a prefix no real
  // track has ever carried — so every AI attempt to keyframe a path operator
  // was rejected as "not animatable" while add_path_operator's own reply text
  // was telling the model to do exactly that.
  prop.startsWith('effect.') || prop.startsWith('ta.') || prop.startsWith('pathop.') ||
  // `polystar.<param>` — plain keys, one polystar per layer (see polystar.ts).
  // The renderer folds them in through `resolvePolystar` every frame.
  prop.startsWith('polystar.');

/**
 * Puppet pin scalar tracks: `puppet.<pinId>.rotation` / `puppet.<pinId>.stiffness`.
 * (`puppet.<pinId>.position` is a data track authored by pin drags /
 * create_puppet_rig, NOT a scalar keyframe — so it is deliberately excluded
 * here to avoid silently-dead scalar tracks.)
 */
const isPuppetScalar = (prop: string): boolean =>
  prop.startsWith('puppet.') && (prop.endsWith('.rotation') || prop.endsWith('.stiffness'));

/**
 * Skeleton scalar tracks the renderer samples (buildSnapshot rig section):
 * `bone.<boneId>.rotation|x|y` (FK pose; rotation stored in RADIANS — the
 * pose_skeleton tool converts from its degree-based schema) and
 * `ikTarget.<boneId>.x|y` (layer-local IK goal position, px — the chain solves
 * toward the animated target every frame).
 */
const isSkeletonScalar = (prop: string): boolean =>
  (prop.startsWith('bone.') &&
    (prop.endsWith('.rotation') || prop.endsWith('.x') || prop.endsWith('.y'))) ||
  ((prop.startsWith('ikTarget.') || prop.startsWith('ikPole.')) && (prop.endsWith('.x') || prop.endsWith('.y'))) ||
  // The chain's IK/FK switch (rigSpecs.ts `ikMode.{id}`: 0 = FK, 1 = IK).
  /^ikMode\.[^.]+$/.test(prop);

/**
 * Paint stroke tracks (AE Effects ▸ Paint ▸ Brush N): the numeric Stroke
 * Options / Transform keys `paint.<strokeId>.<key>` (`paintProps.ts`
 * PAINT_OPTION_KEYS / CLONE / TRANSFORM) and the colour channels
 * `paint.<strokeId>.color_r|g|b|a`. The Path (`paint.<id>.path`) is a `points`
 * data track, not a scalar — excluded for the same reason the puppet pin
 * Position is. paint_strokes' own reply tells the model to keyframe these;
 * until this the gate refused every one of them.
 */
const isPaintScalar = (prop: string): boolean =>
  parsePaintPropPath(prop) !== null || parsePaintColorPath(prop) !== null;

export function isAnimatableProp(prop: string): boolean {
  return (
    (TRANSFORM_PROPS as readonly string[]).includes(prop) ||
    (THREE_D_PROPS as readonly string[]).includes(prop) ||
    (SPECIAL_PROPS as readonly string[]).includes(prop) ||
    (CAMERA_PROPS as readonly string[]).includes(prop) ||
    (GRADIENT_FILL_PROPS as readonly string[]).includes(prop) ||
    (SAMPLED_LAYER_PROPS as readonly string[]).includes(prop) ||
    (MATERIAL_PROPS as readonly string[]).includes(prop) ||
    (LIGHT_PROPS as readonly string[]).includes(prop) ||
    isPrefixed(prop) ||
    isPuppetScalar(prop) ||
    isSkeletonScalar(prop) ||
    isPaintScalar(prop)
  );
}

/**
 * The writes the engine API cannot express EXACTLY yet, by the name a refusal
 * carries. Since B5's finish none of them writes around the engine: each is
 * refused (a failed tool call addressed to the model), never made by a legacy
 * writer. What is left (report B5):
 */
export const LEGACY_GAPS = {
  createKind: 'create_layer kind the engine has no layer kind for',
  setProp: 'static write the catalog does not address exactly (an owner-component mismatch, a gradient fill given as a colour, an unknown prop)',
  effectParam: 'effect parameter write the engine does not take (an unknown binding or option)',
  perMemberKey: 'per-member keyframe the API cannot address (the uniform `scale` override track, unknown bindings)',
  pointsKey: 'points keyframe on a property that is not one vec2 (a puppet pin Position takes exactly one point)',
  roving: 'roving on a track the catalog does not address',
  expression: 'expression on a track the catalog does not address',
  compSettings: 'composition settings the engine refuses',
} as const;

/** Cheap edit-distance, only used to say "did you mean…" on a bad node id. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

/**
 * Redraw today's panels after a tool's LEGACY writes. Engine commands refresh
 * the panels themselves (legacyRefresh.ts) — and a scene bump after them would
 * read to the engine as a write around it (it resyncs), turning an engine-only
 * turn into a snapshot turn. So: only when this turn has written around the
 * engine (docs/B3_PATTERNS.md: no `bumpScene()` after an engine command).
 */
export function refreshAfterLegacy(ctx: ToolContext): void {
  if ((ctx.engine?.legacyGaps.length ?? 1) > 0) bumpScene();
}

// ── Engine routing helpers ───────────────────────────────────────────

/**
 * Send `cmds` on the turn's session; `cmds === null` means the API cannot say
 * EXACTLY what the tool asked for — the write is refused (a typed
 * `AiEngineError`, which the registry hands to the model as a failed call)
 * rather than made around the engine. A refusal by the engine throws the same
 * way: nothing changed.
 */
export async function engineOnly<T>(
  session: AiEngineSession,
  why: string,
  cmds: Command[] | null,
  onOk: (results: CommandResult[]) => T | Promise<T>,
): Promise<T> {
  if (!cmds) throw new AiEngineError('unsupported', why);
  return onOk(await session.apply(cmds));
}

/**
 * "Member `prop` := `value` at comp time `t`" as the WHOLE value of its
 * property (the other members at their value there), or null when `prop` is
 * not one member of an animatable multi-member property (G1: Scale X / Y,
 * anchor axes, a colour channel).
 */
function memberKey(nodeId: string, prop: string, value: number, t: number): { prop: PropRef; value: Value } | null {
  const r = propRefForTrack(nodeId, prop);
  if (!r || !r.animatable || r.members.length < 2 || !r.members.includes(prop)) return null;
  const w = memberWrite(nodeId, prop, value, t);
  return w ? { prop: w.prop, value: w.value } : null;
}

/**
 * A bare `effect.<id>` track (the pre-param form) is that effect's primary
 * numeric parameter, `effect.<id>.<key>` — what the engine addresses.
 */
async function effectTrackOf(nodeId: string, prop: string): Promise<string> {
  const m = /^effect\.([^.]+)$/.exec(prop);
  if (!m) return prop;
  const fx = (await layerEffects(nodeId)).find((e) => e.id === m[1]);
  const primary = fx ? effectDefFor(fx.type as EffectType)?.params.find((p) => p.type === 'number') : undefined;
  return primary ? `${prop}.${primary.key}` : prop;
}

/**
 * The uniform `scale` shorthand (recipes key it) as ONE key of the whole Scale
 * vector, every axis the layer has at `value` — the engine has no uniform
 * scale property (AE's Scale is the vector with its link on).
 */
function uniformScaleKey(nodeId: string, value: number, t: number): { prop: PropRef; value: Value } | null {
  const axes = propRefForTrack(nodeId, 'scaleX')?.members.filter((m) => m === 'scaleX' || m === 'scaleY' || m === 'scaleZ') ?? [];
  if (axes.length < 2) return null;
  const ws = memberWrites(nodeId, Object.fromEntries(axes.map((m) => [m, value])), t);
  return ws && ws.length === 1 ? { prop: ws[0]!.prop, value: ws[0]!.value } : null;
}

/**
 * The API key a track's keyframe at a time IS: the track's own property, or —
 * one member of an unseparated vector — the whole vector's key, with the
 * dimension its per-dimension ease applies to (After Effects' Scale X handle).
 */
function keyRefFor(nodeId: string, prop: string): { ref: PropRef; dim?: number } | null {
  // The uniform `scale` shorthand keys the whole Scale vector (uniformScaleKey).
  if (prop === 'scale' && !propRefForTrack(nodeId, 'scale')) {
    const s = propRefForTrack(nodeId, 'scaleX');
    return s && s.animatable ? { ref: s.ref } : null;
  }
  const target = keyTargetFor(nodeId, prop);
  if (target && keyAddressable(nodeId, prop, target)) return { ref: target.ref };
  const r = propRefForTrack(nodeId, prop);
  if (!r || !r.animatable || !r.members.includes(prop)) return null;
  return r.members.length > 1 ? { ref: r.ref, dim: r.member } : { ref: r.ref };
}

const fpsNow = (): number => useCompositionStore.getState().fps || 30;

/** The id of the keyframe at comp time `t` on `ref` (nearest within half a frame), from the engine. */
async function keyIdAt(session: AiEngineSession, ref: PropRef, t: number): Promise<string | null> {
  const at = secondsToFlicks(t);
  const half = Math.max(1, secondsToFlicks(0.5 / fpsNow()));
  const start = Math.max(0, at - half);
  const res = await session.query({ type: 'getKeyframes', props: [ref], range: { start, duration: at + half - start } });
  let best: string | null = null;
  let bestD = Infinity;
  for (const set of res.sets) {
    for (const k of set.keyframes) {
      const d = Math.abs(k.time - at);
      if (d <= half && d < bestD) {
        best = k.id;
        bestD = d;
      }
    }
  }
  return best;
}

/** Kinds the engine's layer factory builds exactly as the AI wants them. */
const ENGINE_CREATE_KINDS: Partial<Record<string, LayerKind>> = {
  null: 'null',
  camera: 'camera',
  adjustment: 'adjustment',
  particle: 'particle',
  // G1: the drawn kinds are the layer factory's rectangle / text / group with
  // the AI's defaults as init (the size and fill the tool then overrides);
  // a light is ONE light — After Effects adds no ambient light beside it.
  shape: 'rectangle',
  solid: 'rectangle',
  text: 'text',
  group: 'group',
  light: 'light',
};

/** What the pre-engine insert gave each drawn kind (a 220 px blue rect, 32 px text). */
const ENGINE_CREATE_INIT: Partial<Record<string, PropertyInit[]>> = {
  shape: [
    { path: 'layer/width', value: { kind: 'scalar', value: 220 } },
    { path: 'layer/height', value: { kind: 'scalar', value: 220 } },
    { path: 'layer/fill', value: { kind: 'color', value: { r: 0x2b / 255, g: 0x7e / 255, b: 1, a: 1 } } },
  ],
  solid: [
    { path: 'layer/width', value: { kind: 'scalar', value: 220 } },
    { path: 'layer/height', value: { kind: 'scalar', value: 220 } },
    { path: 'layer/fill', value: { kind: 'color', value: { r: 0x2b / 255, g: 0x7e / 255, b: 1, a: 1 } } },
  ],
  text: [{ path: 'text/fontSize', value: { kind: 'scalar', value: 32 } }],
};

/**
 * A drawn shape the layer factory has no kind for (a line, a parametric
 * Polystar): the node the pre-engine insert built, as a detached value — laid
 * into a fragment and inserted with ONE `pasteLayers` (the Polygon / Star
 * tools' own route, workspace/ports.ts `insertDrawnLayers`).
 */
function drawnShapeNode(name: string, at: { x: number; y: number }, shape: LayerShapeSpec): SceneNode {
  const id = `shape_${Math.random().toString(36).slice(2, 10)}`;
  const line = shape.shapeType === 'line' ? lineParts(id, shape) : null;
  const props = {
    [SCENE_KIND_PROP]: 'shape', x: at.x, y: at.y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0,
    width: line?.width ?? 220, height: line?.height ?? 220, shapeType: shape.shapeType,
  };
  return {
    id, name, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: at.x, y: at.y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: line ? 'rgba(0,0,0,0)' : '#2b7eff' } },
      ...(line?.components ?? []),
    ],
  };
}

/**
 * A line is an OPEN two-point path with a stroke — what the Shape library's
 * Line inserts (layerBuilders.buildShape). `shapeType: 'line'` alone has no
 * path, and the renderer drew it as a thin rectangle: stroked, two parallel
 * rails (docs/PROGRAM_PERFORMANCE.md S5). Across a flat box (height under a
 * tenth of the width) it runs level, in a tall thin one upright, else corner
 * to corner (bottom-left → top-right, as the library's).
 */
function lineParts(id: string, shape: LayerShapeSpec): { width: number; height: number; components: SceneNode['components'] } {
  const w = Math.max(1, shape.width ?? 200);
  const h = Math.max(1, shape.height ?? 200);
  const ends = h <= w * 0.1 ? [[-w / 2, 0], [w / 2, 0]] : w <= h * 0.1 ? [[0, h / 2], [0, -h / 2]] : [[-w / 2, h / 2], [w / 2, -h / 2]];
  return {
    width: w,
    height: h,
    components: [
      { id: `${id}_g`, type: 'Geometry', props: { points: ends.map(([x, y]) => ({ x, y, inX: x, inY: y, outX: x, outY: y })), open: true } },
      { id: `${id}_fx`, type: 'fx', props: { stroke: { enabled: true, color: shape.color ?? '#2b7eff', width: 6, opacity: 1, cap: 'round', join: 'miter', align: 'center', dash: [] } } },
    ],
  };
}

// ── Facades ──────────────────────────────────────────────────────────

/** The session a facade writes through when none is given: each write is its own entry. */
function freeSession(): AiEngineSession {
  return new EngineTurnSession(engine(), 'ai');
}

export function createSceneFacade(session: AiEngineSession = freeSession()): SceneFacade {
  // The ACTIVE composition's layers: every tool that reads the scene (describe,
  // the camera lookup, structure warnings, recipes) means the comp it is
  // editing, and a precomp's layers live in their own composition.
  const views = async (): Promise<SceneNodeView[]> => {
    const out: SceneNodeView[] = [];
    for (const id of compLayerIds(activeCompRootId())) {
      const v = await layerView(id);
      if (v) out.push(v);
    }
    return out;
  };
  return {
    has: async (id) => hasNode(id),
    all: views,
    get: async (id) => layerView(id),
    nearest: async (id, limit = 5) =>
      allLayerIds()
        .map((lid) => {
          const name = layerInfo(lid)?.name ?? '';
          return { id: lid, name, d: Math.min(distance(id, lid), distance(id, name)) };
        })
        .sort((a, b) => a.d - b.d)
        .slice(0, limit)
        .map((c) => `${c.id}${c.name && c.name !== c.id ? ` ("${c.name}")` : ''}`),

    create: async (kind, name, at, shape) => {
      const ek = ENGINE_CREATE_KINDS[kind];
      if (!ek) throw new AiEngineError('unsupported', `${LEGACY_GAPS.createKind}: ${kind}`);
      const comp = useCompositionStore.getState().comp();
      const compId = activeCompRootId() as string;
      const trimmed = name.trim();
      const m = documentMirror();
      const layerName = trimmed || (kind === 'camera' || kind === 'light' ? nextDeviceNameIn(m, compId, kind) : '');
      // Nulls and the drawn kinds fan out like the legacy rects; the special
      // kinds keep their own default placement unless the model placed them.
      // (The grid index counts the composition roots too, as the scene walk did.)
      const fans = kind === 'null' || kind === 'shape' || kind === 'solid' || kind === 'text' || kind === 'group';
      const place = fans ? (at ?? spreadPlacement(allLayerIds().length + m.compIds.length, comp.width, comp.height)) : at;
      if (kind === 'shape' && shape && shape.shapeType !== 'rect' && shape.shapeType !== 'ellipse') {
        // Laid into a fragment, inserted as ONE pasteLayers (replayable, engine ids).
        const node = drawnShapeNode(layerName || name, place ?? { x: comp.width / 2, y: comp.height / 2 }, shape);
        const b = new FragmentBuilder({ idPrefix: 'ai' });
        b.addChild(null, node);
        if (shape.polystar) b.setFx(node.id, POLYSTAR_FX_PROP, shape.polystar);
        const built = b.build();
        if (!built) throw new AiEngineError('internal', `the ${shape.shapeType} insert produced no layer`);
        const r = await session.apply([{ type: 'pasteLayers', comp: compId, fragment: built.fragment } as Command]);
        return (r[0] as { layers?: string[] }).layers?.[0] ?? '';
      }
      const init: PropertyInit[] = [
        ...(place ? [{ path: 'transform/position', value: { kind: 'vec2', value: { x: place.x, y: place.y } } } as PropertyInit] : []),
        ...(ENGINE_CREATE_INIT[kind] ?? []),
      ];
      const cmd = {
        type: 'createLayer',
        comp: compId,
        // An ellipse is the factory's own kind (shapeType 'ellipse'), sized like the rect.
        kind: kind === 'shape' && shape?.shapeType === 'ellipse' ? 'ellipse' : ek,
        ...(layerName ? { name: layerName } : {}),
        init,
      } as Command;
      const r = await session.apply([cmd]);
      return (r[0] as { layer?: string }).layer ?? '';
    },

    remove: async (id) => {
      // The whole subtree in ONE `deleteLayers` (the doomed set: nothing is
      // re-parented), which is what the tool means by deleting a layer.
      await session.apply([{ type: 'deleteLayers', layers: layerSubtree(id) ?? [id] } as Command]);
    },

    reparent: async (id, parentId, options) => {
      await session.apply([{
        type: 'setParent',
        layers: [id],
        ...(parentId ? { parent: parentId } : {}),
        keepWorldTransform: options?.preserveWorld ?? true,
      } as Command]);
    },

    setProp: async (nodeId, prop, value) => {
      if (!layerInfo(nodeId)) return false;
      const cmds = await setPropCommands(nodeId, prop, value);
      if (cmds === false) return false;
      return engineOnly(session, `${LEGACY_GAPS.setProp}: ${prop}`, cmds, () => true);
    },

    addEffect: async (nodeId, type, id) => {
      // A caller-chosen id (a library emitter's handle, B5): the engine keeps
      // it. Ignored if the layer already has it (the legacy rule): no write.
      if (id && (await layerEffects(nodeId)).some((e) => e.id === id)) return id;
      const r = await session.apply([{ type: 'addEffect', layers: [nodeId], effect: type, params: [], ...(id ? { id } : {}) } as Command]);
      return ((r[0] as { groups?: string[] }).groups?.[0] ?? '').split('/')[1] ?? '';
    },
    updateEffect: async (nodeId, effectId, amount) => {
      const effect = (await layerEffects(nodeId)).find((e) => e.id === effectId);
      const key = effect ? primaryParamKey(effect.type as EffectType) : undefined;
      if (!effect || !key) return;
      // The write is addressed through the layer's property tree: a layer the
      // page never opened (made in the timeline, by a script, an import) has
      // none loaded yet, and every effect write on it was refused.
      await documentMirror().loadTree(nodeId);
      await engineOnly(session, `${LEGACY_GAPS.effectParam}: ${effect.type}.${key}`, effectParamCommand(nodeId, effectId, key, amount, playheadSeconds()), () => undefined);
    },
    updateEffectParam: async (nodeId, effectId, key, value) => {
      await documentMirror().loadTree(nodeId);
      await engineOnly(session, `${LEGACY_GAPS.effectParam}: ${key}`, effectParamCommand(nodeId, effectId, key, value, playheadSeconds()), () => undefined);
    },
    listEffects: async (nodeId) => layerEffects(nodeId),
    removeEffect: async (nodeId, effectId) => {
      if (!(await layerEffects(nodeId)).some((e) => e.id === effectId)) return;
      await session.apply([{ type: 'removePropertyGroups', groups: [{ layer: nodeId, path: `effects/${effectId}` }] } as Command]);
    },

    // The same Pre-compose the user gets (Layer ▸ Pre-compose, "Move all
    // attributes"): a REAL, reusable composition holding the layers, and a
    // composition layer in their place. The returned id is the composition
    // LAYER, which carries the precomp flag `set_time_remap` needs and the
    // transform/effects/masks that apply to the whole unit.
    precompose: async (nodeIds, name) => {
      const r = await session.apply([{
        type: 'precompose',
        comp: activeCompRootId(),
        layers: [...nodeIds],
        name: name || defaultPrecompName(),
        mode: 'moveAll',
        adjustDuration: false,
      } as Command]);
      return (r[0] as { layer?: string }).layer ?? '';
    },

    setTimeRemapEnabled: async (nodeId, enabled) => {
      const layer = layerInfo(nodeId);
      if (!layer) return false;
      const cmds: Command[] = [];
      // A composition LAYER (a precomp with a source) is always a precomp — its
      // flag is what makes it render its comp at all, so it is never cleared
      // here. On a group, `precomp` is the flag buildSnapshot checks before it
      // will sample timeRemap at all: its Precompose switch, `layer/precompose`.
      if (!(layer.kind === 'precomp' && layer.source)) {
        cmds.push({ type: 'setProperty', prop: { layer: nodeId, path: 'layer/precompose' }, value: { kind: 'bool', value: enabled } } as Command);
      }
      // The Time Remap PROPERTY exists only once remapping is enabled (AE's
      // Enable Time Remapping: its two boundary keys) — keys on `timeRemap`
      // are addressed through it. Disabling leaves an existing remap alone.
      if (enabled && !layer.timing.timeRemapEnabled) {
        cmds.push({ type: 'setTimeRemap', layer: nodeId, enabled: true } as Command);
      }
      if (cmds.length > 0) await session.apply(cmds);
      return true;
    },

    selection: () => useSelectionStore.getState().ids,
    setPuppet: async (nodeId, puppet) => {
      // The whole rig as `layer/puppet` (a rig preset's route, rigPaths.ts);
      // the tracks of pins the new rig no longer has go with them.
      await session.apply([{ type: 'setProperty', prop: { layer: nodeId, path: 'layer/puppet' }, value: { kind: 'json', value: JSON.stringify(puppet ?? null) } } as Command]);
    },
    readPuppet: async (nodeId) => {
      if (!layerInfo(nodeId)) return undefined;
      const pins = await puppetPins(nodeId);
      return pins.length > 0 ? { pins } : undefined;
    },
  };
}

/** The Text component's props, by the legacy routing rule (propOwner.ts `ownerOf`): they need a text layer. */
const TEXT_OWNED = new Set([
  'content', 'fontSize', 'fontWeight', 'fontFamily', 'letterSpacing', 'lineHeight', 'align', 'paragraphSpacing',
  'tracking', 'fontStyle', 'textAnchor',
  // Paragraph text (a box that wraps and aligns), vertical type, RTL paragraphs.
  'boxWidth', 'boxHeight', 'orientation', 'direction', 'language',
]);

/**
 * The engine commands for a static `setProp`, `null` when the API cannot say
 * EXACTLY what the tool meant (refused), or `false` when the layer has nothing
 * that prop could land on (a typographic prop on a shape, a fill on a null —
 * the legacy routing found no owner). A write on an ANIMATED property is a key
 * at the playhead — After Effects' setValue on a keyed property (G1); `time`
 * is ignored when static.
 */
async function setPropCommands(nodeId: string, prop: string, value: unknown): Promise<Command[] | null | false> {
  const t = playheadSeconds();
  const isText = layerKind(nodeId) === 'text';
  if (TEXT_OWNED.has(prop) && !isText) return false;
  const tree = await treeOf(nodeId);
  if (prop === 'fill' && !tree?.nodes.has('layer/fill')) return false;
  if (prop === 'content') {
    if (typeof value !== 'string') return null;
    const set = { type: 'setProperty', prop: { layer: nodeId, path: 'text/sourceText' }, value: { kind: 'string', value }, time: secondsToFlicks(t) } as Command;
    // The legacy writer kept the layer's style runs; so does this (the API's Source Text drops them).
    const runs = staticField(tree, 'text/styleRuns');
    const keep = Array.isArray(runs) && runs.length > 0 && !tree?.nodes.get('text/sourceText')?.animated
      ? [{ type: 'setProperty', prop: { layer: nodeId, path: 'text/styleRuns' }, value: { kind: 'json', value: JSON.stringify(runs) } } as Command]
      : [];
    return [set, ...keep];
  }
  // Static fields (G1: a layer's own fill colour, the Text component's strings
  // / choices) as the plugin host sends them, then one numeric member of its
  // property.
  const ownerType = TEXT_OWNED.has(prop) ? 'Text' : prop === 'fill' ? 'Style' : 'Transform';
  const owner = componentOfType(nodeId, ownerType);
  let fw = owner ? fieldWrite(nodeId, owner, prop, value, t) : null;
  // A static Style field (Backdrop Blur): update_layer documents it, and the
  // Transform lookup refused it as "a static write the catalog does not address".
  if (!fw && ownerType === 'Transform') {
    const style = componentOfType(nodeId, 'Style');
    fw = style ? fieldWrite(nodeId, style, prop, value, t) : null;
  }
  if (fw) return [{ type: 'setProperty', prop: fw.prop, value: fw.value, ...(fw.time !== undefined ? { time: fw.time } : {}) } as Command];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const r = propRefForTrack(nodeId, prop);
  if (!r || !r.members.includes(prop)) return null;
  const w = memberWrite(nodeId, prop, value, t);
  if (!w) return null;
  return [{ type: 'setProperty', prop: w.prop, value: w.value, ...(w.time !== undefined ? { time: w.time } : {}) } as Command];
}

/** The active composition's playhead, comp seconds (the comp facade's `playhead`). */
const playheadSeconds = activePlayheadSeconds;

/** A property's expression state for one member track (its per-dimension one on an unseparated vector). */
function expressionOf(info: PropertyInfo | undefined, member: number, members: number): { source: string; enabled: boolean; error: string } | null {
  if (!info) return null;
  const own = members > 1 ? info.memberExpressions?.find((e) => e.member === member) : undefined;
  if (own) return { source: own.source, enabled: own.enabled, error: own.error };
  return info.expression !== '' ? { source: info.expression, enabled: info.expressionEnabled, error: info.expressionError } : null;
}

/** The expression on `prop` of a layer, read from the mirror. */
async function trackExpressionOf(nodeId: string, prop: string): Promise<{ source: string; enabled: boolean; error: string } | null> {
  const tree = await treeOf(nodeId);
  const r = trackRefIn(tree, prop);
  return r ? expressionOf(r.info, r.member, r.members.length) : null;
}

/** Paths of the layer's properties an enabled expression drives (any member of a vector). */
function expressionPaths(tree: Awaited<ReturnType<typeof treeOf>>): string[] {
  if (!tree) return [];
  const out: string[] = [];
  for (const [path, info] of tree.nodes) {
    if (info.kind !== 'property') continue;
    const whole = info.expression !== '' && info.expressionEnabled;
    if (whole || info.memberExpressions?.some((e) => e.enabled)) out.push(path);
  }
  return out;
}

export function createAnimFacade(session: AiEngineSession = freeSession()): AnimFacade {
  const anim: AnimFacade = {
    isValidProp: async (_nodeId, prop) => isAnimatableProp(prop),

    setKeyframe: async (nodeId, rawProp, t, value, easing) => {
      // The facade resolves tracks on the layer's tree: load it (a layer this run just made is not yet).
      await treeOf(nodeId);
      const prop = await effectTrackOf(nodeId, rawProp);
      if (!Number.isFinite(value)) throw new AiEngineError('invalidArgument', `keyframe value for '${prop}' is not a finite number`);
      if (easing !== undefined && !ENGINE_EASINGS.has(easing)) throw new AiEngineError('invalidArgument', `unknown easing '${easing}' for '${prop}'`);
      const target = keyTargetFor(nodeId, prop);
      if (target) {
        const add = {
          type: 'addKeyframes',
          keys: [{
            prop: target.ref,
            time: secondsToFlicks(t),
            value: { kind: 'scalar', value: value * apiUnitFactor(target.member) },
            ...(easing ? { easing: easing as Easing } : {}),
            spatialIn: [],
            spatialOut: [],
          }],
        } as Command;
        await session.apply(keyAddressable(nodeId, prop, target) ? [add] : [separateDimensionsCommand(nodeId), add]);
        return;
      }
      // One member of a property that has no separate dimensions (Scale X / Y,
      // an anchor axis, a colour channel — AE keys the whole value): a key of
      // the whole value at t, the other members at their value there (G1).
      const w = prop === 'scale' ? uniformScaleKey(nodeId, value, t) : memberKey(nodeId, prop, value, t);
      if (!w) throw new AiEngineError('unsupported', `set_keyframes ${prop}: ${LEGACY_GAPS.perMemberKey}`);
      await session.apply([{ type: 'addKeyframes', keys: [{ prop: w.prop, time: secondsToFlicks(t), value: w.value, ...(easing ? { easing: easing as Easing } : {}), spatialIn: [], spatialOut: [] }] } as Command]);
    },

    setKeyframes: async (keys) => {
      // Every directly addressable key in one addKeyframes (a separate-dimensions
      // switch first where a member needs it); the rest — a member of an
      // unseparated value — one at a time, as setKeyframe writes them.
      const adds: KeyframeInsert[] = [];
      const pre: Command[] = [];
      const separated = new Set<string>();
      const slow: typeof keys[number][] = [];
      for (const k of keys) {
        await treeOf(k.nodeId);
        const prop = await effectTrackOf(k.nodeId, k.prop);
        if (!Number.isFinite(k.value)) throw new AiEngineError('invalidArgument', `keyframe value for '${prop}' is not a finite number`);
        if (k.easing !== undefined && !ENGINE_EASINGS.has(k.easing)) throw new AiEngineError('invalidArgument', `unknown easing '${k.easing}' for '${prop}'`);
        const target = keyTargetFor(k.nodeId, prop);
        if (!target) {
          slow.push(k);
          continue;
        }
        if (!keyAddressable(k.nodeId, prop, target) && !separated.has(k.nodeId)) {
          separated.add(k.nodeId);
          pre.push(separateDimensionsCommand(k.nodeId));
        }
        adds.push({
          prop: target.ref,
          time: secondsToFlicks(k.t),
          value: { kind: 'scalar', value: k.value * apiUnitFactor(target.member) },
          ...(k.easing ? { easing: k.easing as Easing } : {}),
          spatialIn: [],
          spatialOut: [],
        });
      }
      if (adds.length > 0) await session.apply([...pre, { type: 'addKeyframes', keys: adds } as Command]);
      for (const k of slow) await anim.setKeyframe(k.nodeId, k.prop, k.t, k.value, k.easing);
    },

    setPointsKeyframe: async (nodeId, prop, t, points, opts) => {
      await treeOf(nodeId);
      // A puppet pin's Position (`puppet/pins/<pin>/position`): one vec2 key at
      // comp time t, the pin's data track in the TS engine.
      const r = propRefForTrack(nodeId, prop);
      const p = points[0];
      if (!r || !r.animatable || r.valueType !== 'vec2' || !p || points.length !== 1) {
        throw new AiEngineError('unsupported', `${LEGACY_GAPS.pointsKey}: ${prop}`);
      }
      // The key's temporal ease and its spatial handles (path tangents, layer px
      // relative to the value) ride the same insert — one write per key.
      const bez = opts?.bezier && opts.bezier.length >= 4 ? opts.bezier : null;
      const easing = bez ? 'bezier' : opts?.easing && opts.easing !== 'linear' ? opts.easing : null;
      if (easing && !ENGINE_EASINGS.has(easing)) throw new AiEngineError('invalidArgument', `unknown easing '${easing}' for '${prop}'`);
      const tangent = (v: readonly number[] | undefined): number[] => (v && v.length >= 2 && v.every((n) => Number.isFinite(n)) ? [v[0]!, v[1]!] : []);
      const spatialIn = tangent(opts?.tangentIn), spatialOut = tangent(opts?.tangentOut);
      await session.apply([{ type: 'addKeyframes', keys: [{
        prop: r.ref, time: secondsToFlicks(t), value: { kind: 'vec2', value: { x: p.x, y: p.y } },
        ...(easing ? { easing: easing as Easing } : {}),
        ...(bez ? { bezier: { x1: bez[0]!, y1: bez[1]!, x2: bez[2]!, y2: bez[3]! } } : {}),
        ...(spatialIn.length || spatialOut.length ? { spatialInterp: 'bezier' } : {}),
        spatialIn, spatialOut,
      }] } as Command]);
    },

    removeKeyframe: async (nodeId, prop, t) => {
      await treeOf(nodeId);
      // AE: deleting a property's last key leaves it static at that key's value
      // (G1). A lone member of an unseparated vector (scaleX of Scale) has no
      // key of its own: its key IS the vector's, so that key goes — what AE's
      // timeline does when the key under one dimension is deleted.
      const k = keyRefFor(nodeId, prop);
      if (!k) throw new AiEngineError('unsupported', `remove_keyframes ${prop}: ${LEGACY_GAPS.perMemberKey}`);
      const id = await keyIdAt(session, k.ref, t);
      if (id) await session.apply([{ type: 'deleteKeyframes', ids: [id] } as Command]);
    },

    // Easing and handles patch the engine's key at t — on one member of an
    // unseparated vector, that dimension's own ease (`dim`). No key there: no-op.
    setEasing: async (nodeId, prop, t, easing) => {
      await treeOf(nodeId);
      if (!ENGINE_EASINGS.has(easing)) throw new AiEngineError('invalidArgument', `unknown easing '${easing}' for '${prop}'`);
      const k = keyRefFor(nodeId, prop);
      if (!k) throw new AiEngineError('unsupported', `set_easing ${prop}: ${LEGACY_GAPS.perMemberKey}`);
      const id = await keyIdAt(session, k.ref, t);
      if (id) await session.apply([{ type: 'updateKeyframes', patches: [{ id, easing: easing as Easing, ...(k.dim !== undefined ? { dim: k.dim } : {}), spatialIn: [], spatialOut: [] }] } as Command]);
    },
    setBezier: async (nodeId, prop, t, bezier) => {
      await treeOf(nodeId);
      const k = keyRefFor(nodeId, prop);
      if (!k) throw new AiEngineError('unsupported', `set_easing ${prop}: ${LEGACY_GAPS.perMemberKey}`);
      const id = await keyIdAt(session, k.ref, t);
      if (id) {
        const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = bezier;
        await session.apply([{ type: 'updateKeyframes', patches: [{ id, easing: 'bezier', bezier: { x1, y1, x2, y2 }, ...(k.dim !== undefined ? { dim: k.dim } : {}), spatialIn: [], spatialOut: [] }] } as Command]);
      }
    },
    setRoving: async (nodeId, prop, t, roving) => {
      await treeOf(nodeId);
      // Roving is a property of the (spatial) KEY: on merged Position the API
      // key is the whole vector, which is AE's rule (x and y rove together).
      const r = propRefForTrack(nodeId, prop);
      if (!r || !r.animatable || !r.members.includes(prop)) throw new AiEngineError('unsupported', `${LEGACY_GAPS.roving}: ${prop}`);
      const id = await keyIdAt(session, r.ref, t);
      if (id) await session.apply([{ type: 'updateKeyframes', patches: [{ id, roving, spatialIn: [], spatialOut: [] }] } as Command]);
    },
    setExpression: async (nodeId, prop, src) => {
      await treeOf(nodeId);
      const r = propRefForTrack(nodeId, prop);
      if (!r || !r.members.includes(prop)) throw new AiEngineError('unsupported', `${LEGACY_GAPS.expression}: ${prop}`);
      // A rewrite keeps the expression's enabled state (a new one is on).
      const enabled = (await trackExpressionOf(nodeId, prop))?.enabled ?? true;
      // One member of an unseparated vector is Premation's per-dimension
      // expression (`member`); a single-member property is the property's own.
      const member = r.members.length > 1 ? { member: r.member } : {};
      await session.apply([{ type: 'setExpression', prop: r.ref, source: src, enabled, ...member } as Command]);
    },
    getExpressionError: async (nodeId, prop) => (await trackExpressionOf(nodeId, prop))?.error || null,
    isExpressionEnabled: async (nodeId, prop) => (await trackExpressionOf(nodeId, prop))?.enabled ?? false,
    tracks: async (nodeId) => {
      await treeOf(nodeId);
      // The engine keys a property as a whole: every member of a keyed vector
      // lists the property's keys (stored units, composition seconds).
      const tree = await treeOf(nodeId);
      const out: Array<{ prop: string; keyframes: KeyframeView[] }> = [];
      for (const [path, keys] of documentMirror().layerKeyframes(nodeId)) {
        const info = tree?.nodes.get(path);
        if (!info) continue;
        membersOf(info).forEach((member, i) => {
          const factor = trackRefIn(tree, member)?.factor ?? 1;
          out.push({
            prop: member,
            keyframes: keys.map((k): KeyframeView => ({
              t: flicksToSeconds(k.time),
              value: (numbersOfValue(k.value)[i] ?? 0) / factor,
              easing: k.easing ?? 'linear',
            })),
          });
        });
      }
      return out;
    },
    expressionProps: async (nodeId) => {
      const tree = await treeOf(nodeId);
      const out: string[] = [];
      for (const path of expressionPaths(tree)) {
        const info = tree?.nodes.get(path);
        if (info) out.push(...membersOf(info));
      }
      return out;
    },
    evaluate: async (nodeId, t) => {
      await treeOf(nodeId);
      // The animated members' evaluated values at comp time t, asked of the engine.
      const tree = await treeOf(nodeId);
      const paths = [...new Set([...documentMirror().layerKeyframes(nodeId).keys(), ...expressionPaths(tree)])].filter((p) => tree?.nodes.has(p));
      if (paths.length === 0) return {};
      const res = await session.query({ type: 'getPropertyValues', props: paths.map((path) => ({ layer: nodeId, path })), time: secondsToFlicks(t), evaluated: true });
      const out: Record<string, number> = {};
      for (const v of res.values) {
        const info = tree?.nodes.get(v.prop.path);
        if (!info) continue;
        const nums = numbersOfValue(v.value);
        membersOf(info).forEach((member, i) => {
          const n = nums[i];
          if (typeof n === 'number') out[member] = n / (trackRefIn(tree, member)?.factor ?? 1);
        });
      }
      return out;
    },
    applyPreset: async (nodeId, name, atTime) => {
      await treeOf(nodeId);
      const preset = listPresets().find((p) => p.name === name);
      if (!preset) return false;
      // Composition seconds: the engine writes the preset's keys on the
      // layer's keyframe axis (start offset, stretch). A refusal (the preset
      // does not apply to this layer) changed nothing.
      try {
        await session.apply([{ type: 'applyPreset', layers: [nodeId], preset: name, time: secondsToFlicks(atTime) }]);
        return true;
      } catch (err) {
        if (err instanceof AiEngineError) return false;
        throw err;
      }
    },
    listPresets: async () => listPresets().map((p) => p.name),
  };
  return anim;
}

function compView(): CompSettingsView {
  const c = useCompositionStore.getState();
  return { width: c.width, height: c.height, fps: c.fps, durationSeconds: c.durationSeconds, background: c.background };
}

export function createCompFacade(session: AiEngineSession = freeSession()): CompFacade {
  return {
    get: async () => compView(),
    update: async (patch) => {
      const p: Record<string, unknown> = {};
      if (patch.width !== undefined) p.width = Math.round(patch.width);
      if (patch.height !== undefined) p.height = Math.round(patch.height);
      if (patch.durationSeconds !== undefined) p.duration = secondsToFlicks(patch.durationSeconds);
      if (patch.fps !== undefined) {
        // An exact rational: integers, NTSC (29.97 → 30000/1001), else millis.
        p.frameRate = Number.isFinite(patch.fps) && patch.fps > 0 ? fpsToRational(patch.fps) : null;
      }
      if (patch.background !== undefined) {
        const c = apiColorOfHex(patch.background);
        p.background = c && c.kind === 'color' ? c.value : null;
      }
      if (Object.keys(p).length === 0) return;
      const exact = Object.values(p).every((v) => v !== null);
      await engineOnly(session, LEGACY_GAPS.compSettings, exact ? [{ type: 'setCompositionSettings', comp: activeCompRootId(), patch: p } as Command] : null, () => undefined);
    },
    playhead: () => {
      const s = useProjectStore.getState();
      return s.tabs[s.activeTabId ?? '']?.time ?? 0;
    },
    motionBlur: async () => {
      const s = useMotionBlurStore.getState();
      return { enabled: s.enabled, shutterAngle: s.shutterAngle, shutterPhase: s.shutterPhase, samples: s.samples };
    },
    setMotionBlur: async (patch) => {
      // One setCompositionSettings (G1: MotionBlurSettings carries the comp's
      // Enable Motion Blur switch); the engine's store write clamps like the setters.
      const s = useMotionBlurStore.getState();
      const cmd = {
        type: 'setCompositionSettings',
        comp: activeCompRootId(),
        patch: {
          motionBlur: {
            shutterAngle: patch.shutterAngle ?? s.shutterAngle,
            shutterPhase: patch.shutterPhase ?? s.shutterPhase,
            samplesPerFrame: Math.max(0, Math.round(patch.samples ?? s.samples)),
            adaptiveSampleLimit: s.adaptiveSampleLimit,
            enabled: patch.enabled ?? s.enabled,
          },
        },
      } as Command;
      await session.apply([cmd]);
    },
  };
}

export function createTimeFacade(): TimeFacade {
  // Both directions ride the CANONICAL keyframe axis (what buildSnapshot
  // samples) — the same conversion the engine applies to every keyframe time.
  const map = async (nodeId: string, seconds: number, outward: boolean): Promise<number> => {
    const r = await engine().query({ type: 'mapLayerTime', layer: nodeId, time: secondsToFlicks(seconds), outward, keyframeAxis: true });
    return r.ok && r.value.time !== undefined ? flicksToSeconds(r.value.time) : seconds;
  };
  return {
    toLayerTime: (nodeId, compSeconds) => map(nodeId, compSeconds, false),
    toCompTime: (nodeId, layerSeconds) => map(nodeId, layerSeconds, true),
  };
}

/**
 * A tool context for one run. `session` is the turn's engine session
 * (`beginAiTransaction(...).session`); without one, writes go to the app
 * engine one entry at a time (tests, one-off calls).
 */
export function createToolContext(
  signal: AbortSignal,
  images?: readonly { mediaType: string; dataBase64: string }[],
  session: AiEngineSession = freeSession(),
): ToolContext {
  // A fresh run never inherits a scene window left open by the previous one,
  // nor the previous run's custom style; and each run gets its own entrance
  // variation seed so two runs of the same prompt differ.
  resetSceneWindow();
  setRuntimeStyle(null);
  setEntranceSeed((Math.random() * 0xffffffff) >>> 0);
  // Fresh per run. A library emitter produces its whole ToolCall[] before
  // anything executes, so it refers to layers by handles it invented; this is
  // where those handles get bound to real engine ids.
  return sessionToolContext(session, signal, new Map<string, string>(), images);
}

/**
 * A tool context over `session` WITHOUT starting a new run: the scene window,
 * the runtime style and the entrance seed stay as they are, and `aliases` is
 * the caller's. For a host whose "run" spans many separate calls — an MCP
 * client calls `define_style` once and expects the next calls to use it
 * (src/core/ai/mcp/mcpHost.ts). Call `createToolContext` once at the start.
 */
export function sessionToolContext(
  session: AiEngineSession,
  signal: AbortSignal,
  aliases: Map<string, string>,
  images?: readonly { mediaType: string; dataBase64: string }[],
): ToolContext {
  return {
    scene: createSceneFacade(session),
    anim: createAnimFacade(session),
    comp: createCompFacade(session),
    time: createTimeFacade(),
    engine: session,
    signal,
    images,
    aliases,
  };
}
