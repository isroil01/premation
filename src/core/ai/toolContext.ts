/**
 * The bridge between the pure `@motion/ai-tools` package and this app's real
 * engines.
 *
 * Two jobs, both load-bearing:
 *
 * 1. **Time.** The animation engine stores keyframes in *layer* time, while the
 *    model reasons in composition seconds. Every conversion funnels through
 *    `TimeFacade` here. The old op path converted in some places and not others
 *    — a value would land at 1.2s and its easing at 1.2s-minus-the-clip-start,
 *    i.e. nowhere — and it failed silently. One door means that can't recur.
 *
 * 2. **The undo boundary.** These facades expose *raw* mutators and no access
 *    to the command system. A handler physically cannot push its own history
 *    entry, so thirty tool calls can't become thirty undo steps. That is why
 *    handlers receive a context instead of importing `@core` themselves.
 */

import type {
  AnimFacade,
  CompFacade,
  KeyframeView,
  SceneFacade,
  SceneNodeView,
  TimeFacade,
  ToolContext,
} from '@motion/ai-tools';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { THREE_D_PROPS } from '@core/scene/threeD';
import { readNodePuppet } from '@core/rig/puppet';
import { activeCompRootId } from '@core/scene/activeComp';
import { resetSceneWindow } from './sceneWindow';
import { setRuntimeStyle } from './design';
import { setEntranceSeed } from './archetypes';
import { defaultAnimation, upsertDataKeyframe, type EasingKind } from '@motion/animation';
import { compToKeyframeTime, keyframeToCompTime } from '@core/timeline/TimelineController';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { reparentNode } from '@core/scene/parenting';
import { insertCamera, insertLight, insertAdjustmentLayer, insertParticle } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useProjectStore } from '@stores/projectStore';
import { updateUiComponentSvg } from '@core/library/uiKitLibrary';
import { addEffect, updateEffect, removeEffect, getNodeEffects } from '@core/effects/effects';
import type { EffectType } from '@core/effects/effects';
import { applyPresetByName, listPresets } from '@core/animation/animationPresets';
import { bumpScene } from '@stores/sceneStore';
import type { ID, SceneNode } from '@core/types';

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
  'poiX', // look-at target
  'poiY',
  'poiZ',
  'dofStrength',
  'focusDistance',
  'dofAperture',
] as const;

const isPrefixed = (prop: string): boolean =>
  prop.startsWith('effect.') || prop.startsWith('ta.') || prop.startsWith('pathOp.');

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
    isPrefixed(prop) ||
    isPuppetScalar(prop) ||
    isSkeletonScalar(prop)
  );
}

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

/** Layer kinds whose real insert seeds config the AI would otherwise lose. */
const SPECIAL_INSERTERS: Record<string, (() => void) | undefined> = {
  camera: insertCamera,
  light: insertLight,
  adjustment: insertAdjustmentLayer,
  particle: insertParticle,
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

export function createSceneFacade(): SceneFacade {
  return {
    has: (id) => !!defaultSceneGraph.getNode(id as ID),
    // flattenScene, NOT SceneGraph.traverse — traverse only walks the engine
    // root's direct children, so it misses everything nested.
    all: () => flattenScene(defaultSceneGraph).map(toView),
    get: (id) => {
      const n = defaultSceneGraph.getNode(id as ID);
      return n ? toView(n) : undefined;
    },
    nearest: (id, limit = 5) =>
      flattenScene(defaultSceneGraph)
        .map((n) => ({ id: n.id, name: n.name ?? '', d: Math.min(distance(id, n.id), distance(id, n.name ?? '')) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, limit)
        .map((c) => `${c.id}${c.name && c.name !== c.id ? ` ("${c.name}")` : ''}`),

    create: (kind, name, at) => {
      // Camera / light / adjustment / particle are NOT generic rects — they need
      // their real insert (which seeds the camera params, the light glow, the
      // adjustment flag, or the particle config). makeNode's else-branch used to
      // hand back a 220×220 blue rectangle for all of them (and a fake "camera"
      // could then hijack the view). Route them to the real inserters, which
      // select the new node, then read its id back.
      const inserter = SPECIAL_INSERTERS[kind];
      if (inserter) {
        inserter();
        const id = useSelectionStore.getState().ids[0];
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
    },
    remove: (id) => {
      defaultSceneGraph.removeNode(id as ID);
      bumpScene();
    },
    reparent: (id, parentId, options) => {
      reparentNode(id, parentId, options);
      bumpScene();
    },
    setProp: (nodeId, prop, value) => {
      const node = defaultSceneGraph.getNode(nodeId as ID);
      if (!node) return false;
      const style = node.components.find((c) => c.type === 'Style');
      const text = node.components.find((c) => c.type === 'Text');
      // Route each prop to the component that actually owns it — writing
      // `content` onto the Transform would be silently accepted and ignored.
      const owner =
        prop === 'content' || prop === 'fontSize' || prop === 'fontWeight' || prop === 'fontFamily' || prop === 'letterSpacing'
          ? text
          : prop === 'fill'
            // Shapes/solids carry fill on their Style; a text layer has NO Style
            // component — its colour lives as `fill` on the Text component.
            ? (style ?? text)
            : prop === 'opacity'
              ? (style ?? transformComponent(node))
              : transformComponent(node);
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
    },

    addEffect: (nodeId, type) => {
      const before = new Set(getNodeEffects(nodeId).map((e) => e.id));
      addEffect(nodeId, type as EffectType);
      const added = getNodeEffects(nodeId).find((e) => !before.has(e.id));
      return added?.id ?? '';
    },
    updateEffect: (nodeId, effectId, amount) => updateEffect(nodeId, effectId, amount),
    removeEffect: (nodeId, effectId) => removeEffect(nodeId, effectId),

    selection: () => useSelectionStore.getState().ids,
    setPuppet: (nodeId, puppet) => {
      defaultSceneGraph.setPuppet(nodeId as ID, puppet);
      bumpScene();
    },
    readPuppet: (nodeId) => {
      const node = defaultSceneGraph.getNode(nodeId as ID);
      if (!node) return undefined;
      const rig = readNodePuppet(node);
      if (!rig) return undefined;
      return { pins: rig.pins.map((p) => ({ id: p.id, name: p.name })) };
    },
  };
}

export function createAnimFacade(): AnimFacade {
  return {
    isValidProp: (_nodeId, prop) => isAnimatableProp(prop),
    setKeyframe: (nodeId, prop, t, value, easing) =>
      defaultAnimation.setKeyframe(nodeId, prop, t, value, easing as EasingKind | undefined),
    setPointsKeyframe: (nodeId, prop, t, points) => {
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
        keyframes: upsertDataKeyframe(track.keyframes, { t, value }),
      });
    },
    removeKeyframe: (nodeId, prop, t) => defaultAnimation.removeKeyframe(nodeId, prop, t),
    setEasing: (nodeId, prop, t, easing) => defaultAnimation.setEasing(nodeId, prop, t, easing as EasingKind),
    setBezier: (nodeId, prop, t, bezier) =>
      defaultAnimation.setBezier(nodeId, prop, t, [bezier[0]!, bezier[1]!, bezier[2]!, bezier[3]!]),
    setRoving: (nodeId, prop, t, roving) => defaultAnimation.setRoving(nodeId, prop, t, roving),
    setExpression: (nodeId, prop, src) => defaultAnimation.setExpression(nodeId, prop, src),
    getExpressionError: (nodeId, prop) => defaultAnimation.getExpressionError(nodeId, prop),
    tracks: (nodeId) =>
      defaultAnimation.tracksFor(nodeId).map((tr) => ({
        prop: tr.prop,
        // easing is optional on a stored keyframe; the engine treats absent as linear.
        keyframes: tr.keyframes.map((k): KeyframeView => ({ t: k.t, value: k.value, easing: k.easing ?? 'linear' })),
      })),
    evaluate: (nodeId, t) => Object.fromEntries(defaultAnimation.evaluateNode(nodeId, t)),
    applyPreset: (nodeId, name, atTime) => applyPresetByName(nodeId, name, atTime),
    listPresets: () => listPresets().map((p) => p.name),
  };
}

export function createCompFacade(): CompFacade {
  return {
    get: () => {
      const c = useCompositionStore.getState();
      return {
        width: c.width,
        height: c.height,
        fps: c.fps,
        durationSeconds: c.durationSeconds,
        background: c.background,
      };
    },
    update: (patch) => useCompositionStore.getState().update(patch),
    playhead: () => {
      const s = useProjectStore.getState();
      return s.tabs[s.activeTabId ?? '']?.time ?? 0;
    },
  };
}

export function createTimeFacade(): TimeFacade {
  // The facade keeps its historical names, but both directions ride the
  // CANONICAL keyframe axis (what buildSnapshot samples) — every AI tool that
  // authors keyframes through ctx.time inherits trim/split/stretch/precomp
  // correctness from here.
  return {
    toLayerTime: (nodeId, compSeconds) => compToKeyframeTime(nodeId, compSeconds),
    toCompTime: (nodeId, layerSeconds) => keyframeToCompTime(nodeId, layerSeconds),
  };
}

export function createToolContext(
  signal: AbortSignal,
  images?: readonly { mediaType: string; dataBase64: string }[],
): ToolContext {
  // A fresh run never inherits a scene window left open by the previous one,
  // nor the previous run's custom style; and each run gets its own entrance
  // variation seed so two runs of the same prompt differ.
  resetSceneWindow();
  setRuntimeStyle(null);
  setEntranceSeed((Math.random() * 0xffffffff) >>> 0);
  return {
    scene: createSceneFacade(),
    anim: createAnimFacade(),
    comp: createCompFacade(),
    time: createTimeFacade(),
    signal,
    images,
  };
}
