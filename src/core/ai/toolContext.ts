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
  secondsToFlicks,
  type Command,
  type CommandResult,
  type Easing,
  type LayerKind,
  type PropRef,
  type PropertyInit,
  type Value,
} from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { THREE_D_PROPS } from '@core/scene/threeD';
import { readNodePuppet } from '@core/rig/puppet';
import { activeCompRootId } from '@core/scene/activeComp';
import { resetSceneWindow } from './sceneWindow';
import { setRuntimeStyle } from './design';
import { setEntranceSeed } from './archetypes';
import { defaultAnimation, SOURCE_TEXT_PROP, type EasingKind } from '@motion/animation';
import { compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { readCompRef } from '@core/scene/compInstance';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { POLYSTAR_FX_PROP } from '@core/scene/polystar';
import { nextDeviceName } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { getNodeEffects, primaryParamKey } from '@core/effects/effects';
import { defaultPrecompName } from '@core/composition/precompose';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import type { EffectType } from '@core/effects/effects';
import { listPresets } from '@core/animation/animationPresets';
import { bumpScene } from '@stores/sceneStore';
import { engine } from '@core/engine/engineInstance';
import { layerSubtree } from '@core/engine/doc';
import { keyTargetFor, keyAddressable, separateDimensionsCommand, apiColorOfHex, effectParamCommand, propWriteCommand, ENGINE_EASINGS, activePlayheadSeconds } from '@core/engine/trackWrites';
import { propRefForTrack, memberWrite, memberWrites } from '@core/engine/propRefs';
import { readRuns } from '@core/text/richText';
import { apiUnitFactor, keyAxisSeconds } from '@core/engine/props';
import { fpsToRational } from '@core/engine/time';
import { buildLayerFragment } from '@core/engine/offDocument';
import { assistantKeyframeCommands, type AssistantPlan } from '@core/engine/assistantKeys';
import type { ID, SceneNode } from '@core/types';
import { ownerOf, spreadPlacement, transformComponent } from './propOwner';
import { EngineTurnSession } from './aiEngineSession';
import { effectDefFor, readNodeEffects } from '@core/effects/effects';

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
  (prop.startsWith('ikTarget.') && (prop.endsWith('.x') || prop.endsWith('.y')));

export function isAnimatableProp(prop: string): boolean {
  return (
    (TRANSFORM_PROPS as readonly string[]).includes(prop) ||
    (THREE_D_PROPS as readonly string[]).includes(prop) ||
    (SPECIAL_PROPS as readonly string[]).includes(prop) ||
    (CAMERA_PROPS as readonly string[]).includes(prop) ||
    (GRADIENT_FILL_PROPS as readonly string[]).includes(prop) ||
    isPrefixed(prop) ||
    isPuppetScalar(prop) ||
    isSkeletonScalar(prop)
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

const num = (v: unknown, fb = 0): number => (typeof v === 'number' ? v : fb);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function toView(node: SceneNode): SceneNodeView {
  const t = transformComponent(node);
  const p = (t?.props ?? {}) as Record<string, unknown>;
  const styleP = (node.components.find((c) => c.type === 'Style')?.props ?? {}) as Record<string, unknown>;
  const textP = (node.components.find((c) => c.type === 'Text')?.props ?? {}) as Record<string, unknown>;

  // A gradient/image fill is an object, not a hex — report it as such rather
  // than dropping it, so the model knows the layer isn't a flat colour.
  const rawFill = styleP.fill ?? textP.fill ?? textP.color;
  const fill = str(rawFill) ?? (rawFill && typeof rawFill === 'object' ? 'gradient' : undefined);

  return {
    id: node.id,
    name: node.name ?? node.id,
    kind: readNodeKind(node),
    parent: (node.parent as string | null) ?? null,
    visible: node.visible !== false,
    locked: !!node.locked,
    x: num(p.x),
    y: num(p.y),
    rotation: num(p.rotation),
    opacity: num(styleP.opacity, 100),
    ...(fill !== undefined ? { fill } : {}),
    ...(optNum(p.width) !== undefined ? { width: optNum(p.width) } : {}),
    ...(optNum(p.height) !== undefined ? { height: optNum(p.height) } : {}),
    ...(str(textP.content) !== undefined ? { text: str(textP.content) } : {}),
    ...(optNum(textP.fontSize) !== undefined ? { fontSize: optNum(textP.fontSize) } : {}),
    ...(optNum(textP.fontWeight) !== undefined ? { fontWeight: optNum(textP.fontWeight) } : {}),
    ...(str(textP.fontFamily) !== undefined ? { fontFamily: str(textP.fontFamily) } : {}),
    animated: defaultAnimation.tracksFor(node.id).map((tr) => tr.prop),
  };
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
 * Send a keyframe helper's off-document result (`assistantKeyframeCommands`:
 * the legacy writer ran against a scratch state, its keyframe change read back
 * through the API model as `setKeyframes` per property). A helper that wrote a
 * track the API does not address is refused — never half-applied.
 */
export async function sendKeyPlan(session: AiEngineSession, plan: AssistantPlan<unknown>, what: string): Promise<void> {
  if (plan.unaddressed.length > 0) {
    throw new AiEngineError('unsupported', `${what}: the engine API does not address that track (${LEGACY_GAPS.perMemberKey})`);
  }
  if (plan.cmds.length > 0) await session.apply(plan.cmds);
}

/**
 * "Member `prop` := `value` at comp time `t`" as the WHOLE vector value of
 * its property (the other members at their value there), or null when `prop`
 * is not one member of an animatable vector (G1: Scale X / Y, anchor axes).
 */
function vectorMemberKey(nodeId: string, prop: string, value: number, t: number): { prop: PropRef; value: Value } | null {
  if (!defaultSceneGraph.getNode(nodeId as ID)) return null;
  const r = propRefForTrack(nodeId, prop);
  if (!r || !r.animatable || r.members.length < 2 || !r.members.includes(prop) || r.valueType === 'color') return null;
  const w = memberWrite(nodeId, prop, value, t);
  return w ? { prop: w.prop, value: w.value } : null;
}

/**
 * A bare `effect.<id>` track (the pre-param form) is that effect's primary
 * numeric parameter, `effect.<id>.<key>` — what the engine addresses.
 */
function effectTrackOf(nodeId: string, prop: string): string {
  const m = /^effect\.([^.]+)$/.exec(prop);
  const node = m ? defaultSceneGraph.getNode(nodeId as ID) : undefined;
  if (!m || !node) return prop;
  const fx = readNodeEffects(node).find((e) => e.id === m[1]);
  const primary = fx ? effectDefFor(fx.type)?.params.find((p) => p.type === 'number') : undefined;
  return primary ? `${prop}.${primary.key}` : prop;
}

/**
 * The uniform `scale` shorthand (recipes key it) as ONE key of the whole Scale
 * vector, every axis the layer has at `value` — the engine has no uniform
 * scale property (AE's Scale is the vector with its link on).
 */
function uniformScaleKey(nodeId: string, value: number, t: number): { prop: PropRef; value: Value } | null {
  if (!defaultSceneGraph.getNode(nodeId as ID)) return null;
  const axes = propRefForTrack(nodeId, 'scaleX')?.members.filter((m) => m === 'scaleX' || m === 'scaleY' || m === 'scaleZ') ?? [];
  if (axes.length < 2) return null;
  const ws = memberWrites(nodeId, Object.fromEntries(axes.map((m) => [m, value])), t);
  return ws && ws.length === 1 ? { prop: ws[0]!.prop, value: ws[0]!.value } : null;
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
 * Polystar): the node the pre-engine insert built, as a detached value — it is
 * inserted with ONE `pasteLayers` (the Polygon / Star tools' own route,
 * workspace/ports.ts `insertDrawnLayers`).
 */
function drawnShapeNode(name: string, at: { x: number; y: number }, shape: LayerShapeSpec): SceneNode {
  const id = `shape_${Math.random().toString(36).slice(2, 10)}`;
  const props = { [SCENE_KIND_PROP]: 'shape', x: at.x, y: at.y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, width: 220, height: 220, shapeType: shape.shapeType };
  return {
    id, name, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: at.x, y: at.y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  };
}

// ── Facades ──────────────────────────────────────────────────────────

/** The session a facade writes through when none is given: each write is its own entry. */
function freeSession(): AiEngineSession {
  return new EngineTurnSession(engine(), 'ai');
}

export function createSceneFacade(session: AiEngineSession = freeSession()): SceneFacade {
  return {
    has: async (id) => !!defaultSceneGraph.getNode(id as ID),
    // flattenScene, NOT SceneGraph.traverse — traverse only walks the engine
    // root's direct children, so it misses everything nested.
    all: async () => flattenScene(defaultSceneGraph).map(toView),
    get: async (id) => {
      const n = defaultSceneGraph.getNode(id as ID);
      return n ? toView(n) : undefined;
    },
    nearest: async (id, limit = 5) =>
      flattenScene(defaultSceneGraph)
        .map((n) => ({ id: n.id, name: n.name ?? '', d: Math.min(distance(id, n.id), distance(id, n.name ?? '')) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, limit)
        .map((c) => `${c.id}${c.name && c.name !== c.id ? ` ("${c.name}")` : ''}`),

    create: async (kind, name, at, shape) => {
      const ek = ENGINE_CREATE_KINDS[kind];
      if (!ek) throw new AiEngineError('unsupported', `${LEGACY_GAPS.createKind}: ${kind}`);
      const comp = useCompositionStore.getState().comp();
      const trimmed = name.trim();
      const layerName = trimmed || (kind === 'camera' ? nextDeviceName('camera') : kind === 'light' ? nextDeviceName('light') : '');
      // Nulls and the drawn kinds fan out like the legacy rects; the special
      // kinds keep their own default placement unless the model placed them.
      const fans = kind === 'null' || kind === 'shape' || kind === 'solid' || kind === 'text' || kind === 'group';
      const place = fans ? (at ?? spreadPlacement(flattenScene(defaultSceneGraph).length, comp.width, comp.height)) : at;
      const compId = activeCompRootId() as string;
      if (kind === 'shape' && shape && shape.shapeType !== 'rect' && shape.shapeType !== 'ellipse') {
        // Built off-document, inserted as ONE pasteLayers (replayable, engine ids).
        const node = drawnShapeNode(layerName || name, place ?? { x: comp.width / 2, y: comp.height / 2 }, shape);
        const built = buildLayerFragment(compId, () => {
          defaultSceneGraph.addChild(compId as ID, node);
          if (shape.polystar) defaultSceneGraph.setFxKey(node.id as ID, POLYSTAR_FX_PROP, shape.polystar);
        });
        if (!built) throw new AiEngineError('internal', `the ${shape.shapeType} insert produced no layer`);
        const r = await session.apply([{ type: 'pasteLayers', comp: compId, fragment: built.fragment, index: built.index } as Command]);
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
      // re-parented), which is what the tool means by deleting a layer. A
      // subtree crossing a precomp barrier deletes the layer itself (its
      // nested layers are another composition's).
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
      const node = defaultSceneGraph.getNode(nodeId as ID);
      if (!node) return false;
      const owner = ownerOf(node, prop);
      if (!owner) return false;
      return engineOnly(session, `${LEGACY_GAPS.setProp}: ${prop}`, setPropCommand(node, owner.id, prop, value), () => true);
    },

    addEffect: async (nodeId, type, id) => {
      // A caller-chosen id (a library emitter's handle, B5): the engine keeps
      // it. Ignored if the node already has it (the legacy rule): no write.
      if (id && getNodeEffects(nodeId).some((e) => e.id === id)) return id;
      const r = await session.apply([{ type: 'addEffect', layers: [nodeId], effect: type, params: [], ...(id ? { id } : {}) } as Command]);
      return ((r[0] as { groups?: string[] }).groups?.[0] ?? '').split('/')[1] ?? '';
    },
    updateEffect: async (nodeId, effectId, amount) => {
      const effect = getNodeEffects(nodeId).find((e) => e.id === effectId);
      const key = effect ? primaryParamKey(effect.type as EffectType) : undefined;
      if (!effect || !key) return;
      await engineOnly(session, `${LEGACY_GAPS.effectParam}: ${effect.type}.${key}`, effectParamCommand(nodeId, effectId, key, amount, playheadSeconds()), () => undefined);
    },
    updateEffectParam: async (nodeId, effectId, key, value) => {
      await engineOnly(session, `${LEGACY_GAPS.effectParam}: ${key}`, effectParamCommand(nodeId, effectId, key, value, playheadSeconds()), () => undefined);
    },
    listEffects: async (nodeId) => getNodeEffects(nodeId).map((e) => ({ id: e.id, type: e.type })),
    removeEffect: async (nodeId, effectId) => {
      if (!getNodeEffects(nodeId).some((e) => e.id === effectId)) return;
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
      const node = defaultSceneGraph.getNode(nodeId as ID);
      if (!node) return false;
      // A composition LAYER is always a precomp — its flag is what makes it
      // render its comp at all, so it is never cleared here.
      if (readCompRef(node)) return true;
      // `precomp` is the flag buildSnapshot checks before it will sample
      // timeRemap at all: a group's Precompose switch, `layer/precompose`.
      await session.apply([{ type: 'setProperty', prop: { layer: nodeId, path: 'layer/precompose' }, value: { kind: 'bool', value: enabled } } as Command]);
      return true;
    },

    selection: () => useSelectionStore.getState().ids,
    setPuppet: async (nodeId, puppet) => {
      // The whole rig as `layer/puppet` (a rig preset's route, rigPaths.ts);
      // the tracks of pins the new rig no longer has go with them.
      await session.apply([{ type: 'setProperty', prop: { layer: nodeId, path: 'layer/puppet' }, value: { kind: 'json', value: JSON.stringify(puppet ?? null) } } as Command]);
    },
    readPuppet: async (nodeId) => {
      const node = defaultSceneGraph.getNode(nodeId as ID);
      if (!node) return undefined;
      const rig = readNodePuppet(node);
      if (!rig) return undefined;
      return { pins: rig.pins.map((p) => ({ id: p.id, name: p.name })) };
    },
  };
}

/**
 * The engine command for a static `setProp`, or null when the API cannot say
 * EXACTLY what the tool meant: the catalog must address the prop, the
 * property must be un-animated (a static write on an animated property is a
 * keyframe in the API), and the engine must land it on the component the
 * legacy routing chooses.
 */
function setPropCommand(node: SceneNode, ownerId: string, prop: string, value: unknown): Command[] | null {
  // A static write on an ANIMATED property is a key at the playhead — After
  // Effects' setValue on a keyed property (G1); `time` is ignored when static.
  const t = playheadSeconds();
  if (prop === 'content') {
    const text = node.components.find((c) => c.type === 'Text');
    if (typeof value !== 'string' || !text || text.id !== ownerId) return null;
    const set = { type: 'setProperty', prop: { layer: node.id, path: 'text/sourceText' }, value: { kind: 'string', value }, time: secondsToFlicks(t) } as Command;
    // The legacy writer kept the layer's style runs; so does this (the API's Source Text drops them).
    const runs = readRuns(node);
    const keep = runs.length > 0 && !defaultAnimation.getDataTrack(node.id, SOURCE_TEXT_PROP)
      ? [{ type: 'setProperty', prop: { layer: node.id, path: 'text/styleRuns' }, value: { kind: 'json', value: JSON.stringify(runs) } } as Command]
      : [];
    return [set, ...keep];
  }
  // Static fields (G1) and numeric members, as the plugin host sends them too.
  return propWriteCommand(node, ownerId, prop, value, t);
}

/** The active composition's playhead, comp seconds (the comp facade's `playhead`). */
const playheadSeconds = activePlayheadSeconds;

export function createAnimFacade(session: AiEngineSession = freeSession()): AnimFacade {
  return {
    isValidProp: async (_nodeId, prop) => isAnimatableProp(prop),

    setKeyframe: async (nodeId, rawProp, t, value, easing) => {
      const prop = effectTrackOf(nodeId, rawProp);
      if (!Number.isFinite(value)) throw new AiEngineError('invalidArgument', `keyframe value for '${prop}' is not a finite number`);
      const target = keyTargetFor(nodeId, prop);
      const named = easing === undefined || ENGINE_EASINGS.has(easing);
      if (target && named) {
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
      // One member of a vector property that has no separate dimensions
      // (Scale X / Y, an anchor axis — AE keys the whole vector): a key of the
      // whole value at t, the other members at their value there (G1).
      const w = !target && named ? (prop === 'scale' ? uniformScaleKey(nodeId, value, t) : vectorMemberKey(nodeId, prop, value, t)) : null;
      if (w) {
        await session.apply([{ type: 'addKeyframes', keys: [{ prop: w.prop, time: secondsToFlicks(t), value: w.value, ...(easing ? { easing: easing as Easing } : {}), spatialIn: [], spatialOut: [] }] } as Command]);
        return;
      }
      // Anything else (an easing the API has no name for, a track keyed alone):
      // the per-track writer off-document, sent as the property's keys.
      await sendKeyPlan(session, assistantKeyframeCommands([nodeId], () => {
        defaultAnimation.setKeyframe(nodeId, prop, compToKeyframeTime(nodeId, t), value, easing as EasingKind | undefined);
      }), `set_keyframes ${prop}`);
    },

    setPointsKeyframe: async (nodeId, prop, t, points) => {
      // A puppet pin's Position (`puppet/pins/<pin>/position`): one vec2 key at
      // comp time t, the pin's data track in the TS engine.
      const r = defaultSceneGraph.getNode(nodeId as ID) ? propRefForTrack(nodeId, prop) : null;
      const p = points[0];
      if (!r || !r.animatable || r.valueType !== 'vec2' || !p || points.length !== 1) {
        throw new AiEngineError('unsupported', `${LEGACY_GAPS.pointsKey}: ${prop}`);
      }
      await session.apply([{ type: 'addKeyframes', keys: [{ prop: r.ref, time: secondsToFlicks(t), value: { kind: 'vec2', value: { x: p.x, y: p.y } }, spatialIn: [], spatialOut: [] }] } as Command]);
    },

    removeKeyframe: async (nodeId, prop, t) => {
      const target = keyTargetFor(nodeId, prop);
      // AE: deleting a property's last key leaves it static at that key's value (G1).
      if (target && keyAddressable(nodeId, prop, target)) {
        const id = await keyIdAt(session, target.ref, t);
        if (id) await session.apply([{ type: 'deleteKeyframes', ids: [id] } as Command]);
        return;
      }
      await sendKeyPlan(session, assistantKeyframeCommands([nodeId], () => {
        defaultAnimation.removeKeyframe(nodeId, prop, compToKeyframeTime(nodeId, t));
      }), `remove_keyframes ${prop}`);
    },

    // Easing and handles go through the per-track writer off-document: it
    // seeds default handles and continuity exactly as the legacy setter always
    // did, and a lone member's ease becomes the key's per-dimension ease.
    setEasing: async (nodeId, prop, t, easing) => {
      // An addressable key and a named easing: patch the engine's key directly.
      const target = ENGINE_EASINGS.has(easing) ? keyTargetFor(nodeId, prop) : null;
      const id = target ? await keyIdAt(session, target.ref, t) : null;
      if (id) {
        await session.apply([{ type: 'updateKeyframes', patches: [{ id, easing: easing as Easing, spatialIn: [], spatialOut: [] }] } as Command]);
        return;
      }
      await sendKeyPlan(session, assistantKeyframeCommands([nodeId], () => {
        defaultAnimation.setEasing(nodeId, prop, compToKeyframeTime(nodeId, t), easing as EasingKind);
      }), `set_easing ${prop}`);
    },
    setBezier: async (nodeId, prop, t, bezier) => {
      const handles: [number, number, number, number] = [bezier[0]!, bezier[1]!, bezier[2]!, bezier[3]!];
      // An addressable key: patch it on the engine (its easing curve), no page rebuild.
      const target = keyTargetFor(nodeId, prop);
      const id = target ? await keyIdAt(session, target.ref, t) : null;
      if (id) {
        const [x1, y1, x2, y2] = handles;
        await session.apply([{ type: 'updateKeyframes', patches: [{ id, easing: 'bezier', bezier: { x1, y1, x2, y2 }, spatialIn: [], spatialOut: [] }] } as Command]);
        return;
      }
      await sendKeyPlan(session, assistantKeyframeCommands([nodeId], () => {
        defaultAnimation.setBezier(nodeId, prop, compToKeyframeTime(nodeId, t), handles);
      }), `set_easing ${prop}`);
    },
    setRoving: async (nodeId, prop, t, roving) => {
      // Roving is a property of the (spatial) KEY: on merged Position the API
      // key is the whole vector, which is AE's rule (x and y rove together).
      const r = defaultSceneGraph.getNode(nodeId as ID) ? propRefForTrack(nodeId, prop) : null;
      if (!r || !r.animatable || !r.members.includes(prop)) throw new AiEngineError('unsupported', `${LEGACY_GAPS.roving}: ${prop}`);
      const id = await keyIdAt(session, r.ref, t);
      if (id) await session.apply([{ type: 'updateKeyframes', patches: [{ id, roving, spatialIn: [], spatialOut: [] }] } as Command]);
    },
    setExpression: async (nodeId, prop, src) => {
      const r = defaultSceneGraph.getNode(nodeId as ID) ? propRefForTrack(nodeId, prop) : null;
      if (!r || !r.members.includes(prop)) throw new AiEngineError('unsupported', `${LEGACY_GAPS.expression}: ${prop}`);
      const enabled = defaultAnimation.hasExpression(nodeId, prop) ? defaultAnimation.isExpressionEnabled(nodeId, prop) : true;
      // One member of an unseparated vector is Premation's per-dimension
      // expression (`member`); a single-member property is the property's own.
      const member = r.members.length > 1 ? { member: r.member } : {};
      await session.apply([{ type: 'setExpression', prop: r.ref, source: src, enabled, ...member } as Command]);
    },
    getExpressionError: async (nodeId, prop) => defaultAnimation.getExpressionError(nodeId, prop),
    isExpressionEnabled: async (nodeId, prop) => defaultAnimation.isExpressionEnabled(nodeId, prop),
    tracks: async (nodeId) =>
      defaultAnimation.tracksFor(nodeId).map((tr) => ({
        prop: tr.prop,
        // easing is optional on a stored keyframe; the engine treats absent as linear.
        keyframes: tr.keyframes.map((k): KeyframeView => ({ t: keyframeToCompTime(nodeId, k.t), value: k.value, easing: k.easing ?? 'linear' })),
      })),
    evaluate: async (nodeId, t) => Object.fromEntries(defaultAnimation.evaluateNode(nodeId, keyAxisSeconds(nodeId, t))),
    applyPreset: async (nodeId, name, atTime) => {
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
  return {
    toLayerTime: async (nodeId, compSeconds) => keyAxisSeconds(nodeId, compSeconds),
    toCompTime: async (nodeId, layerSeconds) => keyframeToCompTime(nodeId, layerSeconds),
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
  return {
    scene: createSceneFacade(session),
    anim: createAnimFacade(session),
    comp: createCompFacade(session),
    time: createTimeFacade(),
    engine: session,
    signal,
    images,
    // Fresh per run. A library emitter produces its whole ToolCall[] before
    // anything executes, so it refers to layers by handles it invented; this is
    // where those handles get bound to real engine ids.
    aliases: new Map<string, string>(),
  };
}
