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
import { defaultAnimation, upsertDataKeyframe, SOURCE_TEXT_PROP, type EasingKind } from '@motion/animation';
import { compToKeyframeTime, keyframeToCompTime, getTimelineController } from '@core/timeline/TimelineController';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { readCompRef } from '@core/scene/compInstance';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { reparentNode } from '@core/scene/parenting';
import { insertCamera, insertLight, insertAdjustmentLayer, insertParticle, nextDeviceName } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { updateUiComponentSvg } from '@core/library/uiKitLibrary';
import {
  addEffect,
  updateEffect,
  updateEffectParam,
  removeEffect,
  getNodeEffects,
  primaryParamKey,
  effectDefFor,
  parseColorChannels,
} from '@core/effects/effects';
import { defaultPrecompName, precomposeNow } from '@core/composition/precompose';
import { setPrecomp } from '@core/scene/precomp';
import { useMotionBlurStore } from '@stores/motionBlurStore';
import type { EffectType } from '@core/effects/effects';
import { listPresets } from '@core/animation/animationPresets';
import { bumpScene } from '@stores/sceneStore';
import { engine } from '@core/engine/engineInstance';
import { propRefForTrack, memberWrite, fieldWrite } from '@core/engine/propRefs';
import { readRuns } from '@core/text/richText';
import { resolvePropertyMeta } from '@core/inspector/propertyMeta';
import { apiUnitFactor } from '@core/engine/props';
import type { ID, SceneNode } from '@core/types';
import { EngineTurnSession } from './aiEngineSession';

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
 * Every place a facade still writes AROUND the engine, by the name the turn
 * records (`session.legacy`). The engine API gaps behind them (report B5):
 */
export const LEGACY_GAPS = {
  createKind: 'create_layer kind the engine has no layer kind for',
  createRefused: 'create_layer refused by the engine (active comp is not a composition item)',
  removeSubtree: 'deleting a layer with children (the engine un-parents them; the tool deletes the subtree)',
  reparent: 'reparent refused by the engine',
  setProp: 'static write the catalog does not address exactly (the Transform width/height of a text layer, shapeType, owner-component mismatch, UI-kit SVG, a gradient fill given as a colour)',
  effectId: 'add_effect with a caller-chosen effect id (the engine mints ids)',
  effectParam: 'effect parameter write the engine does not take (an unknown binding or option)',
  precompose: 'precompose refused by the engine',
  timeRemap: 'time-remap switch on a group/precomp (legacy precomp flag)',
  puppet: 'puppet rig write (no puppet command beyond pins)',
  perMemberKey: 'per-member keyframe the API cannot address (the uniform `scale` override track, data tracks, unknown bindings)',
  pointsKey: 'points data keyframe (puppet pin position)',
  roving: 'roving on a key the API cannot address alone',
  expression: 'expression on a property the catalog does not address as one member',
  compSettings: 'composition settings refused by the engine',
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

const transformComponent = (node: SceneNode) =>
  node.components.find((c) => c.type === 'Transform') ??
  node.components.find((c) => typeof (c.props as Record<string, unknown>).x === 'number');

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

let createSeq = 0;

/**
 * A non-overlapping default position for a layer the model didn't place.
 * Steps through a loose 3-column grid centred on the comp so N un-placed layers
 * spread out instead of stacking on one pixel.
 */
function spreadPlacement(index: number, w: number, h: number): { x: number; y: number } {
  const cols = 3;
  const col = index % cols;
  const row = Math.floor(index / cols) % 3;
  return { x: w / 2 + (col - 1) * (w / 5), y: h / 2 + (row - 1) * (h / 5) };
}

// ── Legacy writers (the pre-engine facade, unchanged) ────────────────
//
// Kept verbatim so a gap costs replayability, never behaviour. Every call is
// reached only after `session.legacy(<gap>)`.

/**
 * Layer kinds whose real insert seeds config the AI would otherwise lose.
 *
 * Each takes the caller's NAME. They used to be called bare, so the inserter
 * minted its own ("Light 1", "Camera 1", "Adjustment Layer"…) and `create_layer`
 * then replied "Created light layer 'My Key Light'" about a layer called
 * something else — and the model went on to look for a name that did not exist.
 * Camera and light accept it as a seed; the other two have no seed, so they are
 * renamed once the insert has selected the new node.
 */
const SPECIAL_INSERTERS: Record<string, ((name: string) => void) | undefined> = {
  camera: (name) => insertCamera({ name }),
  light: (name) => insertLight({ name }),
  adjustment: () => insertAdjustmentLayer(),
  particle: () => insertParticle(),
};

function makeNode(kind: string, name: string, x: number, y: number, fill: string): SceneNode {
  const id = `${kind}_${(createSeq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const transform = { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } };
  const base = { [SCENE_KIND_PROP]: kind, x, y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 };
  const components: SceneNode['components'] =
    kind === 'text'
      ? [
          { id: `${id}_t`, type: 'Transform', props: { ...base } },
          { id: `${id}_c`, type: 'Text', props: { content: name, fontSize: 32, opacity: 100 } },
        ]
      : kind === 'group' || kind === 'null'
        ? [{ id: `${id}_t`, type: 'Transform', props: { ...base } }]
        : [
            { id: `${id}_t`, type: 'Transform', props: { ...base, width: 220, height: 220, shapeType: 'rect' } },
            { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill } },
          ];
  return { id, name, parent: null, children: [], transform, visible: true, locked: false, components };
}

function legacyCreate(kind: string, name: string, at?: { x: number; y: number }): string {
  // Camera / light / adjustment / particle are NOT generic rects — they need
  // their real insert (which seeds the camera params, the light glow, the
  // adjustment flag, or the particle config). Route them to the real
  // inserters, which select the new node, then read its id back.
  const inserter = SPECIAL_INSERTERS[kind];
  if (inserter) {
    inserter(name);
    const id = useSelectionStore.getState().ids[0];
    // The seedless inserters named the layer themselves. An empty name keeps
    // theirs rather than blanking the row.
    const made = id ? defaultSceneGraph.getNode(id as ID) : undefined;
    if (made && name.trim() && made.name !== name.trim()) made.name = name.trim();
    if (id && at) {
      const n = defaultSceneGraph.getNode(id as ID);
      const t = n && transformComponent(n);
      if (t) {
        defaultSceneGraph.writeProp(id as ID, t.id, 'x', at.x);
        defaultSceneGraph.writeProp(id as ID, t.id, 'y', at.y);
      }
    }
    bumpScene();
    return id ?? '';
  }
  const comp = useCompositionStore.getState().comp();
  // Anti-stack: when the model gives NO position, don't pile every layer on
  // the exact centre (the #1 cause of "everything overlapping"). Fan
  // successive un-placed layers across a loose grid around centre — the
  // model can reposition after it sees the result.
  const place = at ?? spreadPlacement(flattenScene(defaultSceneGraph).length, comp.width, comp.height);
  const node = makeNode(kind, name, place.x, place.y, '#2b7eff');
  const rootId = activeCompRootId() as ID;
  defaultSceneGraph.addChild(rootId, node);
  bumpScene();
  return node.id;
}

/** The component a static write lands on (the legacy routing rule). */
function ownerOf(node: SceneNode, prop: string): SceneNode['components'][number] | undefined {
  const style = node.components.find((c) => c.type === 'Style');
  const text = node.components.find((c) => c.type === 'Text');
  // Route each prop to the component that actually owns it — writing
  // `content` onto the Transform would be silently accepted and ignored.
  return (
    // Everything typographic belongs to the Text component. `lineHeight` and
    // `align` used to fall through to the Transform, where buildSnapshot
    // happens to still read them — a latent bug that would break the moment
    // prop reading was scoped per component.
    prop === 'content' || prop === 'fontSize' || prop === 'fontWeight' ||
    prop === 'fontFamily' || prop === 'letterSpacing' || prop === 'lineHeight' ||
    prop === 'align' || prop === 'paragraphSpacing'
      ? text
      : prop === 'fill'
        // Shapes/solids carry fill on their Style; a text layer has NO Style
        // component — its colour lives as `fill` on the Text component.
        ? (style ?? text)
        : prop === 'opacity'
          ? (style ?? transformComponent(node))
          : transformComponent(node)
  );
}

function legacySetProp(nodeId: string, prop: string, value: unknown): boolean {
  const node = defaultSceneGraph.getNode(nodeId as ID);
  if (!node) return false;
  const owner = ownerOf(node, prop);
  if (!owner) return false;
  const ok = defaultSceneGraph.writeProp(node.id, owner.id, prop, value);
  if (ok) {
    if ((node as any).rawUiSvg && (prop === 'fill' || prop === 'content')) {
      const style = node.components.find((c) => c.type === 'Style');
      const text = node.components.find((c) => c.type === 'Text');
      const currentFill = String((style?.props as any)?.fill ?? '');
      const currentText = String((text?.props as any)?.content ?? '');
      const newSvg = updateUiComponentSvg((node as any).rawUiSvg, currentFill, currentText);
      const transform = transformComponent(node);
      if (transform) {
        defaultSceneGraph.writeProp(node.id, transform.id, 'src', `data:image/svg+xml,${encodeURIComponent(newSvg)}`);
      }
    }
    bumpScene();
  }
  return ok;
}

function legacySetKeyframe(nodeId: string, prop: string, compT: number, value: number, easing?: string): void {
  defaultAnimation.setKeyframe(nodeId, prop, compToKeyframeTime(nodeId, compT), value, easing as EasingKind | undefined);
}

/** Legacy precomp (the user's Layer ▸ Pre-compose, "Move all attributes"). */
function legacyPrecompose(nodeIds: readonly string[], name: string): string {
  const result = precomposeNow([...nodeIds], {
    name: name || defaultPrecompName(),
    mode: 'move',
    adjustDuration: false,
    openNew: false,
  });
  return result?.instanceId ?? '';
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
 * Try the engine; on a typed refusal (nothing changed) record the gap and run
 * the legacy writer instead. `cmds === null` means "no exact engine route".
 */
export async function engineOr<T>(
  session: AiEngineSession,
  gap: string,
  cmds: Command[] | null,
  onOk: (results: CommandResult[]) => T | Promise<T>,
  legacy: () => T | Promise<T>,
): Promise<T> {
  let why = gap;
  if (cmds) {
    try {
      return await onOk(await session.apply(cmds));
    } catch (err) {
      if (!(err instanceof AiEngineError)) throw err;
      why = `${gap} — engine: ${err.code}`;
    }
  }
  session.legacy(why);
  return legacy();
}

const ENGINE_EASINGS: ReadonlySet<string> = new Set<Easing>([
  'linear', 'hold', 'bezier', 'ease', 'easeIn', 'easeOut', 'easeInOut', 'step', 'autoBezier', 'continuousBezier',
]);

const POSITION_DIMS = new Set(['x', 'y', 'z']);

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
 * The ONE engine property a tool's track name keys on its own: a single-member
 * property, or one dimension of Position (which the engine separates first,
 * AE's Separate Dimensions — the storage is per-dimension either way).
 */
function keyTarget(nodeId: string, prop: string): { ref: PropRef; separate: boolean; member: string } | null {
  if (!defaultSceneGraph.getNode(nodeId as ID)) return null;
  const r = propRefForTrack(nodeId, prop);
  if (!r || !r.animatable) return null;
  if (r.members.length === 1 && r.members[0] === prop && r.valueType === 'scalar') {
    return { ref: r.ref, separate: false, member: prop };
  }
  if (POSITION_DIMS.has(prop) && r.ref.path === 'transform/position' && r.members.includes(prop)) {
    return { ref: { layer: nodeId, path: `transform/position/${prop}` }, separate: true, member: prop };
  }
  return null;
}

/**
 * An EXISTING key of `prop` is its own API key: always for a single-member
 * property; for a Position dimension only once dimensions are separated
 * (merged, the API key is the whole vector — patching it would touch the
 * other dimensions too).
 */
function addressable(nodeId: string, prop: string, target: { ref: PropRef; separate: boolean }): boolean {
  return !target.separate || propRefForTrack(nodeId, prop)?.ref.path === target.ref.path;
}

const separateCmd = (nodeId: string): Command =>
  ({ type: 'setDimensionsSeparated', layer: nodeId, path: 'transform/position', separated: true }) as Command;

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

/** The stored keyframe (legacy read) the engine will patch — for fields the API has no "unset" for. */
function storedKeyAt(nodeId: string, prop: string, t: number) {
  const lt = compToKeyframeTime(nodeId, t);
  return defaultAnimation.getTrackKeyframes(nodeId, prop)?.find((k) => k.t === lt);
}

function hexToColor(s: string): Value | null {
  if (!/^#?[0-9a-fA-F]{3,8}$/.test(s.trim())) return null;
  const [r, g, b, a] = parseColorChannels(s);
  return { kind: 'color', value: { r, g, b, a } };
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

    create: async (kind, name, at) => {
      const ek = ENGINE_CREATE_KINDS[kind];
      if (!ek) {
        session.legacy(`${LEGACY_GAPS.createKind}: ${kind}`);
        return legacyCreate(kind, name, at);
      }
      const comp = useCompositionStore.getState().comp();
      const trimmed = name.trim();
      const layerName = trimmed || (kind === 'camera' ? nextDeviceName('camera') : kind === 'light' ? nextDeviceName('light') : '');
      // Nulls and the drawn kinds fan out like the legacy rects; the special
      // kinds keep their own default placement unless the model placed them.
      const fans = kind === 'null' || kind === 'shape' || kind === 'solid' || kind === 'text' || kind === 'group';
      const place = fans ? (at ?? spreadPlacement(flattenScene(defaultSceneGraph).length, comp.width, comp.height)) : at;
      const init: PropertyInit[] = [
        ...(place ? [{ path: 'transform/position', value: { kind: 'vec2', value: { x: place.x, y: place.y } } } as PropertyInit] : []),
        ...(ENGINE_CREATE_INIT[kind] ?? []),
      ];
      const cmd = {
        type: 'createLayer',
        comp: activeCompRootId(),
        kind: ek,
        ...(layerName ? { name: layerName } : {}),
        init,
      } as Command;
      return engineOr(
        session,
        LEGACY_GAPS.createRefused,
        [cmd],
        (r) => (r[0] as { layer?: string }).layer ?? '',
        () => legacyCreate(kind, name, at),
      );
    },

    remove: async (id) => {
      const node = defaultSceneGraph.getNode(id as ID);
      const childless = !!node && node.children.length === 0;
      await engineOr(
        session,
        LEGACY_GAPS.removeSubtree,
        childless ? [{ type: 'deleteLayers', layers: [id] } as Command] : null,
        () => undefined,
        () => {
          defaultSceneGraph.removeNode(id as ID);
          bumpScene();
        },
      );
    },

    reparent: async (id, parentId, options) => {
      const cmd = {
        type: 'setParent',
        layers: [id],
        ...(parentId ? { parent: parentId } : {}),
        keepWorldTransform: options?.preserveWorld ?? true,
      } as Command;
      await engineOr(session, LEGACY_GAPS.reparent, [cmd], () => undefined, () => {
        reparentNode(id, parentId, options);
        bumpScene();
      });
    },

    setProp: async (nodeId, prop, value) => {
      const node = defaultSceneGraph.getNode(nodeId as ID);
      if (!node) return false;
      const owner = ownerOf(node, prop);
      if (!owner) return false;
      return engineOr(session, `${LEGACY_GAPS.setProp}: ${prop}`, setPropCommand(node, owner.id, prop, value), () => true, () => legacySetProp(nodeId, prop, value));
    },

    addEffect: async (nodeId, type, id) => {
      const legacy = (): string => {
        const before = new Set(getNodeEffects(nodeId).map((e) => e.id));
        addEffect(nodeId, type as EffectType, id);
        const added = getNodeEffects(nodeId).find((e) => !before.has(e.id));
        return added?.id ?? '';
      };
      // A caller-chosen id is a promise the engine cannot keep (it mints ids).
      if (id) {
        // Ignored if the node already has it (the legacy rule): no write at all.
        if (getNodeEffects(nodeId).some((e) => e.id === id)) return legacy();
        session.legacy(LEGACY_GAPS.effectId);
        return legacy();
      }
      return engineOr(
        session,
        LEGACY_GAPS.effectParam,
        [{ type: 'addEffect', layers: [nodeId], effect: type, params: [] } as Command],
        (r) => ((r[0] as { groups?: string[] }).groups?.[0] ?? '').split('/')[1] ?? '',
        legacy,
      );
    },
    updateEffect: async (nodeId, effectId, amount) => {
      const effect = getNodeEffects(nodeId).find((e) => e.id === effectId);
      const key = effect ? primaryParamKey(effect.type as EffectType) : undefined;
      if (!effect || !key) return;
      await engineOr(
        session,
        `${LEGACY_GAPS.effectParam}: ${effect.type}.${key}`,
        effectParamCommand(nodeId, effectId, key, amount),
        () => undefined,
        () => updateEffect(nodeId, effectId, amount),
      );
    },
    updateEffectParam: async (nodeId, effectId, key, value) => {
      await engineOr(
        session,
        `${LEGACY_GAPS.effectParam}: ${key}`,
        effectParamCommand(nodeId, effectId, key, value),
        () => undefined,
        () => {
          updateEffectParam(nodeId, effectId, key, value as never);
          bumpScene();
        },
      );
    },
    listEffects: async (nodeId) => getNodeEffects(nodeId).map((e) => ({ id: e.id, type: e.type })),
    removeEffect: async (nodeId, effectId) => {
      const has = getNodeEffects(nodeId).some((e) => e.id === effectId);
      if (!has) return;
      await engineOr(
        session,
        LEGACY_GAPS.effectParam,
        [{ type: 'removePropertyGroups', groups: [{ layer: nodeId, path: `effects/${effectId}` }] } as Command],
        () => undefined,
        () => removeEffect(nodeId, effectId),
      );
    },

    // The same Pre-compose the user gets (Layer ▸ Pre-compose, "Move all
    // attributes"): a REAL, reusable composition holding the layers, and a
    // composition layer in their place. The returned id is the composition
    // LAYER, which carries the precomp flag `set_time_remap` needs and the
    // transform/effects/masks that apply to the whole unit.
    precompose: async (nodeIds, name) => {
      const cmd = {
        type: 'precompose',
        comp: activeCompRootId(),
        layers: [...nodeIds],
        name: name || defaultPrecompName(),
        mode: 'moveAll',
        adjustDuration: false,
      } as Command;
      return engineOr(session, LEGACY_GAPS.precompose, [cmd], (r) => (r[0] as { layer?: string }).layer ?? '', () => legacyPrecompose(nodeIds, name));
    },

    setTimeRemapEnabled: async (nodeId, enabled) => {
      const node = defaultSceneGraph.getNode(nodeId as ID);
      if (!node) return false;
      // A composition LAYER is always a precomp — its flag is what makes it
      // render its comp at all, so it is never cleared here.
      if (readCompRef(node)) return true;
      // `precomp` is the flag buildSnapshot checks before it will sample
      // timeRemap at all. It lives on the `fx` component, so it goes through
      // setPrecomp rather than writeProp on the Transform.
      session.legacy(LEGACY_GAPS.timeRemap);
      setPrecomp(nodeId, enabled);
      return true;
    },

    selection: () => useSelectionStore.getState().ids,
    setPuppet: async (nodeId, puppet) => {
      session.legacy(LEGACY_GAPS.puppet);
      defaultSceneGraph.setPuppet(nodeId as ID, puppet as never);
      bumpScene();
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
 * EXACTLY what the legacy writer does: the catalog must address the prop, the
 * property must be un-animated (a static write on an animated property is a
 * keyframe in the API), and the engine must land it on the component the
 * legacy routing chooses.
 */
function setPropCommand(node: SceneNode, ownerId: string, prop: string, value: unknown): Command[] | null {
  if ((node as { rawUiSvg?: unknown }).rawUiSvg && (prop === 'fill' || prop === 'content')) return null;
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
  // Static fields (G1): a layer's own fill colour, the Text component's
  // strings / choices (font family, alignment…).
  const fw = fieldWrite(node.id, ownerId, prop, value, t);
  if (fw) return [{ type: 'setProperty', prop: fw.prop, value: fw.value, ...(fw.time !== undefined ? { time: fw.time } : {}) } as Command];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // The engine writes a member onto the FIRST component carrying it as a number
  // (a text prop the layer has not stored as a number yet: its Text component).
  const first = node.components.find((c) => typeof (c.props as Record<string, unknown>)[prop] === 'number')
    ?? (resolvePropertyMeta(prop, node.id).group === 'text' ? node.components.find((c) => c.type === 'Text') : undefined)
    // A text layer's box (layer/width, layer/height): the Transform, like the legacy writer.
    ?? ((prop === 'width' || prop === 'height') ? node.components.find((c) => c.type === 'Transform') : undefined);
  if (!first || first.id !== ownerId) return null;
  const r = propRefForTrack(node.id, prop);
  if (!r || !r.members.includes(prop)) return null;
  const w = memberWrite(node.id, prop, value, t);
  if (!w) return null;
  return [{ type: 'setProperty', prop: w.prop, value: w.value, ...(w.time !== undefined ? { time: w.time } : {}) } as Command];
}

/** The active composition's playhead, comp seconds (the comp facade's `playhead`). */
function playheadSeconds(): number {
  const s = useProjectStore.getState();
  return s.tabs[s.activeTabId ?? '']?.time ?? 0;
}

/** The engine command for an effect parameter write, or null (see the gap list). */
function effectParamCommand(nodeId: string, effectId: string, key: string, value: number | string | boolean): Command[] | null {
  const effect = getNodeEffects(nodeId).find((e) => e.id === effectId);
  if (!effect) return null;
  const ref: PropRef = { layer: nodeId, path: `effects/${effectId}/${key}` };
  // An animated param takes a key at the playhead (AE setValue on a keyed property).
  const time = secondsToFlicks(playheadSeconds());
  // A dropdown given BY VALUE (the stored option value, as a number or its
  // string) or by label: the API takes the option's label (G1).
  const def = effectDefFor(effect.type)?.params.find((p) => p.key === key);
  if (def?.type === 'enum') {
    const opt = def.options?.find((o) => String(o.value) === String(value) || o.label === value);
    return opt ? [{ type: 'setProperty', prop: ref, value: { kind: 'choice', value: opt.label } } as Command] : null;
  }
  if (typeof value === 'number') {
    const member = `effect.${effectId}.${key}`;
    const r = propRefForTrack(nodeId, member);
    if (!r || r.members.length !== 1 || r.members[0] !== member) return null;
    return [{ type: 'setProperty', prop: r.ref, value: { kind: 'scalar', value: value * apiUnitFactor(member) }, time } as Command];
  }
  if (typeof value === 'boolean') {
    const r = propRefForTrack(nodeId, ref.path);
    if (!r || r.valueType !== 'bool') return null;
    return [{ type: 'setProperty', prop: ref, value: { kind: 'bool', value } } as Command];
  }
  const color = hexToColor(value);
  if (!color) return null;
  const r = propRefForTrack(nodeId, `effect.${effectId}.${key}_r`) ?? propRefForTrack(nodeId, ref.path);
  if (!r || r.valueType !== 'color') return null;
  return [{ type: 'setProperty', prop: r.ref, value: color, time } as Command];
}

export function createAnimFacade(session: AiEngineSession = freeSession()): AnimFacade {
  /** Patch the key at comp time `t` through the engine, or run the legacy writer. */
  const patchKey = async (
    nodeId: string,
    prop: string,
    t: number,
    gap: string,
    patch: (stored: ReturnType<typeof storedKeyAt>) => Record<string, unknown> | null,
    legacy: () => void,
  ): Promise<void> => {
    const target = keyTarget(nodeId, prop);
    const stored = storedKeyAt(nodeId, prop, t);
    // No key there: the legacy writers are silent no-ops, and so is this.
    if (!stored) return;
    const fields = target && addressable(nodeId, prop, target) ? patch(stored) : null;
    let cmds: Command[] | null = null;
    if (target && fields) {
      const id = await keyIdAt(session, target.ref, t);
      if (id) cmds = [{ type: 'updateKeyframes', patches: [{ id, spatialIn: [], spatialOut: [], ...fields }] } as Command];
    }
    await engineOr(session, gap, cmds, () => undefined, legacy);
  };

  return {
    isValidProp: async (_nodeId, prop) => isAnimatableProp(prop),

    setKeyframe: async (nodeId, prop, t, value, easing) => {
      const target = keyTarget(nodeId, prop);
      const ok = target && (easing === undefined || ENGINE_EASINGS.has(easing)) && Number.isFinite(value);
      let cmds: Command[] | null = null;
      if (target && ok) {
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
        cmds = addressable(nodeId, prop, target) ? [add] : [separateCmd(nodeId), add];
      } else if (!target && (easing === undefined || ENGINE_EASINGS.has(easing)) && Number.isFinite(value)) {
        // One member of a vector property that has no separate dimensions
        // (Scale X / Y, an anchor axis — AE keys the whole vector): a key of the
        // whole value at t, the other members at their value there (G1).
        const w = vectorMemberKey(nodeId, prop, value, t);
        if (w) cmds = [{ type: 'addKeyframes', keys: [{ prop: w.prop, time: secondsToFlicks(t), value: w.value, ...(easing ? { easing: easing as Easing } : {}), spatialIn: [], spatialOut: [] }] } as Command];
      }
      await engineOr(session, `${LEGACY_GAPS.perMemberKey}: ${prop}`, cmds, () => undefined, () => legacySetKeyframe(nodeId, prop, t, value, easing));
    },

    setPointsKeyframe: async (nodeId, prop, t, points) => {
      session.legacy(LEGACY_GAPS.pointsKey);
      const lt = compToKeyframeTime(nodeId, t);
      const track = defaultAnimation.getDataTrack(nodeId, prop) ?? {
        nodeId,
        prop,
        kind: 'points' as const,
        keyframes: [],
      };
      const value = points.map((p) => ({ x: p.x, y: p.y }));
      defaultAnimation.setDataTrack(nodeId, prop, {
        ...track,
        kind: 'points',
        keyframes: upsertDataKeyframe(track.keyframes, { t: lt, value }),
      });
    },

    removeKeyframe: async (nodeId, prop, t) => {
      const target = keyTarget(nodeId, prop);
      const legacy = (): void => defaultAnimation.removeKeyframe(nodeId, prop, compToKeyframeTime(nodeId, t));
      const stored = storedKeyAt(nodeId, prop, t);
      if (!stored) return; // nothing there — the legacy writer is a no-op too
      let cmds: Command[] | null = null;
      // AE: deleting a property's last key leaves it static at that key's value (G1).
      if (target && addressable(nodeId, prop, target)) {
        const id = await keyIdAt(session, target.ref, t);
        if (id) cmds = [{ type: 'deleteKeyframes', ids: [id] } as Command];
      }
      await engineOr(session, `${LEGACY_GAPS.perMemberKey}: ${prop}`, cmds, () => undefined, legacy);
    },

    setEasing: async (nodeId, prop, t, easing) => {
      await patchKey(
        nodeId, prop, t, `${LEGACY_GAPS.perMemberKey}: ${prop}`,
        (stored) => {
          if (!ENGINE_EASINGS.has(easing)) return null;
          // The legacy setter seeds default handles when switching to a curve.
          const seedBezier = easing === 'bezier' ? [0.25, 0.1, 0.25, 1] : (easing === 'autoBezier' || easing === 'continuousBezier') ? [0.333, 0, 0.667, 1] : null;
          const out: Record<string, unknown> = { easing };
          if (seedBezier && !stored?.bezier) out.bezier = { x1: seedBezier[0], y1: seedBezier[1], x2: seedBezier[2], y2: seedBezier[3] };
          if (easing === 'bezier' && stored?.continuous === undefined) out.continuous = true;
          return out;
        },
        () => defaultAnimation.setEasing(nodeId, prop, compToKeyframeTime(nodeId, t), easing as EasingKind),
      );
    },
    setBezier: async (nodeId, prop, t, bezier) => {
      const handles: [number, number, number, number] = [bezier[0]!, bezier[1]!, bezier[2]!, bezier[3]!];
      await patchKey(
        nodeId, prop, t, `${LEGACY_GAPS.perMemberKey}: ${prop}`,
        (stored) => ({
          easing: 'bezier',
          bezier: { x1: handles[0], y1: handles[1], x2: handles[2], y2: handles[3] },
          ...(stored?.continuous === undefined ? { continuous: true } : {}),
        }),
        () => defaultAnimation.setBezier(nodeId, prop, compToKeyframeTime(nodeId, t), handles),
      );
    },
    setRoving: async (nodeId, prop, t, roving) => {
      // Roving is a property of the (spatial) KEY: on merged Position the API
      // key is the whole vector, which is AE's rule (x and y rove together).
      const r = defaultSceneGraph.getNode(nodeId as ID) ? propRefForTrack(nodeId, prop) : null;
      const stored = storedKeyAt(nodeId, prop, t);
      if (!stored) return;
      let cmds: Command[] | null = null;
      if (r && r.animatable && r.members.includes(prop)) {
        const id = await keyIdAt(session, r.ref, t);
        if (id) cmds = [{ type: 'updateKeyframes', patches: [{ id, roving, spatialIn: [], spatialOut: [] }] } as Command];
      }
      await engineOr(session, LEGACY_GAPS.roving, cmds, () => undefined, () => defaultAnimation.setRoving(nodeId, prop, compToKeyframeTime(nodeId, t), roving));
    },
    setExpression: async (nodeId, prop, src) => {
      const r = defaultSceneGraph.getNode(nodeId as ID) ? propRefForTrack(nodeId, prop) : null;
      const single = !!r && r.members.length === 1 && r.members[0] === prop;
      const enabled = defaultAnimation.hasExpression(nodeId, prop) ? defaultAnimation.isExpressionEnabled(nodeId, prop) : true;
      const cmds = single ? [{ type: 'setExpression', prop: r!.ref, source: src, enabled } as Command] : null;
      await engineOr(session, `${LEGACY_GAPS.expression}: ${prop}`, cmds, () => undefined, () => defaultAnimation.setExpression(nodeId, prop, src));
    },
    getExpressionError: async (nodeId, prop) => defaultAnimation.getExpressionError(nodeId, prop),
    isExpressionEnabled: async (nodeId, prop) => defaultAnimation.isExpressionEnabled(nodeId, prop),
    tracks: async (nodeId) =>
      defaultAnimation.tracksFor(nodeId).map((tr) => ({
        prop: tr.prop,
        // easing is optional on a stored keyframe; the engine treats absent as linear.
        keyframes: tr.keyframes.map((k): KeyframeView => ({ t: keyframeToCompTime(nodeId, k.t), value: k.value, easing: k.easing ?? 'linear' })),
      })),
    evaluate: async (nodeId, t) => Object.fromEntries(defaultAnimation.evaluateNode(nodeId, compToKeyframeTime(nodeId, t))),
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
        // Integral rates only through the engine; NTSC rates keep the legacy path.
        if (Number.isInteger(patch.fps) && patch.fps > 0) p.frameRate = { num: patch.fps, den: 1 };
        else p.frameRate = null;
      }
      if (patch.background !== undefined) {
        const c = hexToColor(patch.background);
        p.background = c && c.kind === 'color' ? c.value : null;
      }
      const exact = Object.values(p).every((v) => v !== null);
      const cmds = exact && Object.keys(p).length > 0 ? [{ type: 'setCompositionSettings', comp: activeCompRootId(), patch: p } as Command] : null;
      await engineOr(session, LEGACY_GAPS.compSettings, cmds, () => undefined, () => {
        useCompositionStore.getState().update(patch);
        // The store and the timeline's time domain must agree, or clips keep the
        // OLD length (what the Composition Settings dialog mirrors, too).
        if (typeof patch.durationSeconds === 'number') getTimelineController().setDurationSeconds(useCompositionStore.getState().durationSeconds);
        if (typeof patch.fps === 'number') getTimelineController().setFrameRate(useCompositionStore.getState().fps);
      });
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
      // Each setter clamps and notifies autosave — going through them rather
      // than `set()` is what keeps the shutter round-tripping into the project
      // file and the render key changing.
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
      await engineOr(session, LEGACY_GAPS.compSettings, [cmd], () => undefined, () => {
        const st = useMotionBlurStore.getState();
        if (patch.enabled !== undefined) st.setEnabled(patch.enabled);
        if (patch.shutterAngle !== undefined) st.setShutterAngle(patch.shutterAngle);
        if (patch.shutterPhase !== undefined) st.setShutterPhase(patch.shutterPhase);
        if (patch.samples !== undefined) st.setSamples(patch.samples);
      });
    },
  };
}

export function createTimeFacade(): TimeFacade {
  // Both directions ride the CANONICAL keyframe axis (what buildSnapshot
  // samples) — the same conversion the engine applies to every keyframe time.
  return {
    toLayerTime: async (nodeId, compSeconds) => compToKeyframeTime(nodeId, compSeconds),
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

// ── The synchronous document context (importers, not AI turns) ────────

/**
 * What the Lottie importer writes through. It is a document BUILDER, not an AI
 * turn: since B3z (WS-L1) it only ever runs OFF-document — inside
 * `buildLayerFragment` / `insertBuiltLayers` (offDocument.ts) — so these
 * synchronous writers touch a scratch state and the result reaches the
 * document as ONE engine `pasteLayers` (layout/EditorLayout/lottieInsertEdits.ts).
 * `comp.update` must not be used there (`updateComp: false`): a composition
 * change is its own command.
 */
export interface LegacyDocumentContext {
  scene: {
    create(kind: string, name: string, at?: { x: number; y: number }): string;
    setProp(nodeId: string, prop: string, value: unknown): boolean;
    reparent(nodeId: string, parentId: string | null, options?: { preserveWorld?: boolean }): void;
  };
  comp: { update(patch: Partial<CompSettingsView>): void };
  time: { toLayerTime(nodeId: string, compSeconds: number): number };
}

export function createLegacyDocumentContext(): LegacyDocumentContext {
  return {
    scene: {
      create: legacyCreate,
      setProp: legacySetProp,
      reparent: (id, parentId, options) => {
        reparentNode(id, parentId, options);
        bumpScene();
      },
    },
    comp: { update: (patch) => useCompositionStore.getState().update(patch) },
    time: { toLayerTime: (nodeId, compSeconds) => compToKeyframeTime(nodeId, compSeconds) },
  };
}
