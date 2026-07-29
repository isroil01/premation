/**
 * The handlers behind the tool schemas.
 *
 * Three rules run through all of them:
 *
 * 1. **Every keyframe time converts through `ctx.time`.** The model speaks
 *    composition seconds; the engine stores layer time. Converting a value but
 *    not its easing is what made the old op path silently drop edits on any
 *    layer whose clip didn't start at zero.
 * 2. **Partial success is success.** A batch with two bad entries applies the
 *    other 198 and tells the model exactly what it got wrong. Dropping the
 *    whole call — or worse, dropping the bad ones silently, as the old
 *    server-side validator did — wastes a turn or corrupts the result.
 * 3. **Failures are addressed to the model.** "unknown nodeId 'ttl' — did you
 *    mean title_1?" is a repair instruction. "Invalid input" is not.
 */

import type { AiTool, ToolContext, ToolResult } from '@motion/ai-tools';
import { ALL_TOOL_DEFS, bindAlias } from '@motion/ai-tools';
import { EFFECT_DEFS } from '@core/effects/effects';
import { ANIMATOR_PARAMS } from '@core/text/textAnimators';
import { addTextAnimator, updateAnimator, readAnimatorData } from '@core/text/textAnimators';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { isRiggableKind } from '@core/scene/rigLogo';
import { nextRigIds, usedRigIds } from '@core/rig/rigIds';
import { readNodePuppet } from '@core/rig/puppet';
import { updateDropShadow, updateOuterGlow } from '@core/effects/layerStyles';

import { is3DEnabled, set3DEnabled } from '@core/scene/threeD';
import {
  MATERIAL_PCT_DEFAULTS,
  setNodeAcceptsLights,
  setNodeMaterialPct,
  setNodeShininess,
  setNodeSpecular,
} from '@core/scene/material';
import { rectangleMask, ellipseMask, addMaskPath, type MaskMode } from '@core/effects/mask';
import { bumpScene } from '@stores/sceneStore';
import { useAssetStore } from '@stores/assetStore';
import { useAiProviderStore } from '@stores/aiProviderStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { insertMedia, insertSvgLayer } from '@core/scene/sceneInsert';
import { analyseAudio } from '@motion/audio';
import { api } from '@core/api/client';
import { resolveStyle, buildCustomStyle, setRuntimeStyle, type CustomStyleInput } from './design';
import type { EntranceArchetype } from './archetypes';
import {
  recipeBackground,
  recipeText,
  recipeEmblem,
  recipeCards,
  recipeStaggerIn,
  recipeCameraMove,
  recipeKineticText,
  recipeLightSweep,
  recipeFloatingOrbs,
  recipeLowerThird,
  recipeScene,
  recipeTransition,
  recipeLogoReveal,
  recipeRadialBurst,
  recipePathMorph,
} from './recipes';
import { selectScene } from './sceneWindow';
import { TRANSFORM_PROPS, THREE_D_PROPS, SPECIAL_PROPS, CAMERA_PROPS, isAnimatableProp } from './toolContext';
import { setNodeBlend } from '@core/effects/blendMode';
import { setNodeMatte } from '@core/effects/matte';
import { setNodeMotionBlur } from '@core/effects/motionBlur';
import { CRAFT_HANDLERS } from './craftHandlers';

const def = (name: string) => {
  const d = ALL_TOOL_DEFS.find((t) => t.name === name);
  if (!d) throw new Error(`No definition for tool '${name}'`);
  return d;
};

const ok = (content: string, data?: unknown): ToolResult => ({ ok: true, content, data });
const fail = (content: string): ToolResult => ({ ok: false, content });

/** The standard "that id doesn't exist" repair hint. */
const unknownNode = (ctx: ToolContext, id: string): string =>
  `unknown nodeId '${id}' — did you mean: ${ctx.scene.nearest(id).join(', ') || '(no layers exist yet)'}?`;

// ── Read ──────────────────────────────────────────────────────────

const describeScene: AiTool['handler'] = (input, ctx) => {
  const { subtreeOf, includeTracks, limit } = input as { subtreeOf?: string; includeTracks?: boolean; limit?: number };
  const all = ctx.scene.all();
  if (subtreeOf && !ctx.scene.has(subtreeOf)) return fail(unknownNode(ctx, subtreeOf));

  let nodes = all;
  if (subtreeOf) {
    const keep = new Set<string>([subtreeOf]);
    // `all` is parents-before-children, so one pass collects the subtree.
    for (const n of all) if (n.parent && keep.has(n.parent)) keep.add(n.id);
    nodes = all.filter((n) => keep.has(n.id));
  }

  const cap = limit ?? 120;
  const shown = nodes.slice(0, cap);
  const comp = ctx.comp.get();

  const payload = {
    composition: { ...comp, playhead: ctx.comp.playhead() },
    selection: ctx.scene.selection(),
    layerCount: nodes.length,
    layers: shown.map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      parent: n.parent,
      ...(n.visible ? {} : { visible: false }),
      ...(n.locked ? { locked: true } : {}),
      x: Math.round(n.x * 100) / 100,
      y: Math.round(n.y * 100) / 100,
      rotation: n.rotation,
      opacity: n.opacity,
      // Design read-back: what it looks like, so the model doesn't guess colour/size.
      ...(n.fill !== undefined ? { fill: n.fill } : {}),
      ...(n.width !== undefined ? { width: Math.round(n.width) } : {}),
      ...(n.height !== undefined ? { height: Math.round(n.height) } : {}),
      ...(n.text !== undefined ? { text: n.text } : {}),
      ...(n.fontSize !== undefined ? { fontSize: n.fontSize } : {}),
      ...(n.fontWeight !== undefined ? { fontWeight: n.fontWeight } : {}),
      ...(n.fontFamily !== undefined ? { fontFamily: n.fontFamily } : {}),
      ...(n.animated.length ? { animated: n.animated } : {}),
      ...(includeTracks && n.animated.length
        ? { tracks: ctx.anim.tracks(n.id).map((t) => ({ prop: t.prop, keys: t.keyframes.map((k) => [ctx.time.toCompTime(n.id, k.t), k.value]) })) }
        : {}),
    })),
  };

  // Truncation must be visible and actionable — a silent cut reads to the model
  // as "that's the whole comp" and it will confidently edit the wrong thing.
  const note =
    nodes.length > shown.length
      ? `\n\nShowing ${shown.length} of ${nodes.length} layers. Call describe_scene with subtreeOf to drill into a group.`
      : '';
  return ok(JSON.stringify(payload) + note, payload);
};

const readTracks: AiTool['handler'] = (input, ctx) => {
  const { nodeId, props } = input as { nodeId: string; props?: string[] };
  if (!ctx.scene.has(nodeId)) return fail(unknownNode(ctx, nodeId));
  let tracks = ctx.anim.tracks(nodeId);
  if (props?.length) tracks = tracks.filter((t) => props.includes(t.prop));
  if (!tracks.length) return ok(`${nodeId} has no animated properties${props?.length ? ' matching those props' : ''}.`);
  // [t, value] pairs — roughly 4x cheaper in tokens than objects.
  const payload = tracks.map((t) => ({
    prop: t.prop,
    keys: t.keyframes.map((k) => [ctx.time.toCompTime(nodeId, k.t), k.value, k.easing]),
  }));
  return ok(`Times are composition seconds. [t, value, easing]:\n${JSON.stringify(payload)}`, payload);
};

const evaluateAt: AiTool['handler'] = (input, ctx) => {
  const { nodeId, t } = input as { nodeId: string; t?: number };
  if (!ctx.scene.has(nodeId)) return fail(unknownNode(ctx, nodeId));
  const compT = t ?? ctx.comp.playhead();
  const animated = ctx.anim.evaluate(nodeId, ctx.time.toLayerTime(nodeId, compT));
  const node = ctx.scene.get(nodeId)!;
  // Fall back to the node's base transform for properties with no track —
  // evaluateNode only reports animated props.
  const payload = {
    t: compT,
    values: { x: node.x, y: node.y, rotation: node.rotation, opacity: node.opacity, ...animated },
  };
  return ok(JSON.stringify(payload), payload);
};

const getSelection: AiTool['handler'] = (_input, ctx) => {
  const ids = ctx.scene.selection();
  if (!ids.length) return ok('Nothing is selected.', []);
  const payload = ids.map((id) => {
    const n = ctx.scene.get(id);
    return { id, name: n?.name ?? id, kind: n?.kind ?? 'unknown' };
  });
  return ok(JSON.stringify(payload), payload);
};

const listCapabilities: AiTool['handler'] = (input, ctx) => {
  const { area } = input as { area?: string };
  const want = (a: string) => !area || area === 'all' || area === a;
  const payload: Record<string, unknown> = {};
  if (want('props')) {
    payload.animatableProps = {
      transform: TRANSFORM_PROPS,
      threeD: { props: THREE_D_PROPS, note: "Requires the layer's 3D switch — set it via update_layer { threeD: true }." },
      effects: 'effect.<effectId> — the id returned by add_effect',
      textAnimators: 'ta.<index>.<param> — index from text_animator',
      special: SPECIAL_PROPS,
      note: 'Values are numbers only. opacity 0..100, rotation in degrees, scale is a multiplier (1 = 100%).',
    };
  }
  if (want('effects')) {
    // Every parameter, not just the primary one — effects used to carry a
    // single scalar, so the AI had no way to know Glow has a colour or that
    // Drop Shadow has an angle.
    payload.effects = EFFECT_DEFS.map((e) => ({
      type: e.type,
      label: e.label,
      gpuOnly: e.gpuOnly === true,
      params: e.params.map((p) => ({
        key: p.key,
        label: p.label,
        type: p.type,
        ...(p.unit ? { unit: p.unit } : {}),
        ...(p.min !== undefined ? { min: p.min } : {}),
        ...(p.max !== undefined ? { max: p.max } : {}),
        default: p.default,
      })),
    }));
  }
  if (want('text')) {
    payload.textAnimator = { params: ANIMATOR_PARAMS, basedOn: ['characters', 'words', 'lines'], shapes: ['square', 'rampUp', 'rampDown', 'triangle', 'round', 'smooth'] };
  }
  if (want('easing')) {
    payload.easing = ['linear', 'step', 'ease', 'easeIn', 'easeOut', 'easeInOut', 'bezier', 'hold', 'autoBezier', 'continuousBezier'];
  }
  if (want('kinds')) {
    payload.layerKinds = ['shape', 'text', 'solid', 'null', 'group', 'camera', 'light', 'adjustment', 'particle'];
  }
  if (want('puppet')) {
    payload.puppet = {
      tool: 'create_puppet_rig — place deformation pins on a layer (layer-local coords centered on the origin).',
      tracks: {
        position: 'puppet.<pinId>.position — data track (points kind). Animate via set_puppet_pin_keyframes (or canvas pin drags); holds [{x,y}] per keyframe, linear tween.',
        rotation: 'puppet.<pinId>.rotation — scalar keyframe track (degrees); keyframeable via set_keyframes. Rotates the deformation rigidly around the pin.',
        stiffness: 'puppet.<pinId>.stiffness — scalar keyframe track (>= 0); keyframeable via set_keyframes. Sharpens the pin\'s influence falloff.',
      },
      tools: 'create_puppet_rig (rig + pins) → set_puppet_pin_keyframes (animate pin position) + set_keyframes on .rotation/.stiffness.',
      note: 'Pin ids are returned by create_puppet_rig. Rig mesh settings live on the layer fx.puppet block (meshDensity 2-50, meshExpansion px, solver lbs|arap, meshMode grid|silhouette, maxRotationDeg = Mesh Rotation Refinement).',
    };
  }
  if (want('all')) payload.presets = ctx.anim.listPresets();
  return ok(JSON.stringify(payload), payload);
};

const listPresetsHandler: AiTool['handler'] = (_input, ctx) => {
  const names = ctx.anim.listPresets();
  return ok(JSON.stringify(names), names);
};

// ── Write: structure ──────────────────────────────────────────────

const createLayer: AiTool['handler'] = (input, ctx) => {
  const i = input as { id?: string; kind: string; name: string; x?: number; y?: number; width?: number; height?: number; text?: string; shape?: string; fill?: string; parent?: string };
  if (i.parent && !ctx.scene.has(i.parent)) return fail(unknownNode(ctx, i.parent));
  // Accept x-only or y-only (the old code discarded BOTH if either was missing,
  // silently centring the layer). Only when NEITHER is given do we hand the
  // facade `undefined`, which fans the layer out instead of stacking at centre.
  const comp = ctx.comp.get();
  const at =
    i.x !== undefined || i.y !== undefined
      ? { x: i.x ?? comp.width / 2, y: i.y ?? comp.height / 2 }
      : undefined;
  const id = ctx.scene.create(i.kind, i.name, at);
  // Bind the caller's handle BEFORE anything else, so a later call in the same
  // batch can address this layer without a round-trip through the model.
  bindAlias(ctx, i.id, id);
  if (i.text !== undefined) ctx.scene.setProp(id, 'content', i.text);
  if (i.fill) ctx.scene.setProp(id, 'fill', i.fill);
  if (i.shape) ctx.scene.setProp(id, 'shapeType', i.shape);
  if (i.parent) ctx.scene.reparent(id, i.parent);

  // GPU renderer builds its model matrix from layer.width × layer.scaleX and
  // layer.height × layer.scaleY. Without explicit size the quad is zero-area
  // and invisible on WebGL/WebGPU. Apply safe defaults when the AI omits them.
  const kind = i.kind;
  if (kind === 'solid') {
    ctx.scene.setProp(id, 'width', i.width ?? comp.width);
    ctx.scene.setProp(id, 'height', i.height ?? comp.height);
  } else if (kind === 'shape') {
    ctx.scene.setProp(id, 'width', i.width ?? 200);
    ctx.scene.setProp(id, 'height', i.height ?? 200);
  } else if (kind === 'text') {
    // Text width drives line-wrapping; height is derived from line count.
    // Default to a wide strip so short text renders in a single line.
    if (i.width !== undefined) ctx.scene.setProp(id, 'width', i.width);
    else ctx.scene.setProp(id, 'width', Math.round(comp.width * 0.75));
    if (i.height !== undefined) ctx.scene.setProp(id, 'height', i.height);
  } else {
    // For all other kinds (null, group, camera, light, etc.) apply only if provided.
    if (i.width !== undefined) ctx.scene.setProp(id, 'width', i.width);
    if (i.height !== undefined) ctx.scene.setProp(id, 'height', i.height);
  }

  return ok(`Created ${i.kind} layer '${i.name}' with id ${id}. Use this id in later calls.`, { id });
};

const deleteLayer: AiTool['handler'] = (input, ctx) => {
  const { nodeIds } = input as { nodeIds: string[] };
  const bad: string[] = [];
  let removed = 0;
  for (const id of nodeIds) {
    if (!ctx.scene.has(id)) { bad.push(unknownNode(ctx, id)); continue; }
    ctx.scene.remove(id);
    removed++;
  }
  if (bad.length) return { ok: false, content: `Deleted ${removed}. Failed:\n- ${bad.join('\n- ')}` };
  return ok(`Deleted ${removed} layer(s).`);
};

const reparentLayer: AiTool['handler'] = (input, ctx) => {
  const { nodeId, parentId } = input as { nodeId: string; parentId?: string | null };
  if (!ctx.scene.has(nodeId)) return fail(unknownNode(ctx, nodeId));
  if (parentId && !ctx.scene.has(parentId)) return fail(unknownNode(ctx, parentId));
  if (parentId === nodeId) return fail('A layer cannot be its own parent.');
  ctx.scene.reparent(nodeId, parentId ?? null);
  return ok(`Re-parented ${nodeId} to ${parentId ?? 'the top level'}.`);
};

const updateLayer: AiTool['handler'] = (input, ctx) => {
  const i = input as Record<string, unknown> & {
    nodeId: string;
    threeD?: boolean;
    acceptsLights?: boolean;
    ambient?: number;
    diffuse?: number;
    specular?: number;
    shininess?: number;
    name?: string;
    visible?: boolean;
    locked?: boolean;
    motionBlur?: boolean;
    blendMode?: string;
    matte?: { mode: 'alpha' | 'luma' | 'alpha-inv' | 'luma-inv'; sourceId?: string };
    removeMatte?: boolean;
  };
  if (!ctx.scene.has(i.nodeId)) return fail(unknownNode(ctx, i.nodeId));

  const node = defaultSceneGraph.getNode(i.nodeId);
  const applied: string[] = [];

  if (i.threeD !== undefined && node) {
    set3DEnabled(i.nodeId, !!i.threeD);
    applied.push(`threeD=${!!i.threeD}`);
  }
  // Material switches. Without these `set_light` was a tool that could not
  // change a pixel from a library-emitted batch: shading is gated on the 3D
  // switch AND `acceptsLights`, the flag defaults to false, and the only writer
  // was the inspector checkbox. A light could be created, positioned and tuned,
  // and nothing in the scene would ever be lit by it.
  if (i.acceptsLights !== undefined && node) {
    setNodeAcceptsLights(i.nodeId, !!i.acceptsLights);
    applied.push(`acceptsLights=${!!i.acceptsLights}`);
  }
  for (const key of ['ambient', 'diffuse'] as const) {
    const v = i[key];
    if (typeof v === 'number' && node) {
      setNodeMaterialPct(i.nodeId, key, v, MATERIAL_PCT_DEFAULTS[key]);
      applied.push(`${key}=${v}`);
    }
  }
  if (typeof i.specular === 'number' && node) {
    setNodeSpecular(i.nodeId, i.specular);
    applied.push(`specular=${i.specular}`);
  }
  if (typeof i.shininess === 'number' && node) {
    setNodeShininess(i.nodeId, i.shininess);
    applied.push(`shininess=${i.shininess}`);
  }
  if (i.name !== undefined && node) {
    node.name = String(i.name);
    applied.push('name');
  }
  if (i.visible !== undefined && node) {
    node.visible = !!i.visible;
    applied.push('visible');
  }
  if (i.locked !== undefined && node) {
    node.locked = !!i.locked;
    applied.push('locked');
  }
  if (i.motionBlur !== undefined && node) {
    setNodeMotionBlur(i.nodeId, !!i.motionBlur);
    applied.push(`motionBlur=${!!i.motionBlur}`);
  }
  if (i.blendMode !== undefined && node) {
    setNodeBlend(i.nodeId, i.blendMode as any);
    applied.push(`blendMode=${i.blendMode}`);
  }
  if (i.removeMatte && node) {
    setNodeMatte(i.nodeId, 'none');
    applied.push('removeMatte');
  } else if (i.matte !== undefined && node) {
    setNodeMatte(i.nodeId, i.matte);
    applied.push(`matte=${JSON.stringify(i.matte)}`);
  }

  // 'text' is the tool's word for the Text component's `content` prop.
  const map: Record<string, string> = { text: 'content' };
  for (const key of [
    'text', 'fontSize', 'fontWeight', 'fill', 'x', 'y', 'width', 'height',
    'rotation', 'scaleX', 'scaleY', 'opacity',
    // Typesetting. All three are read by buildSnapshot and none was reachable —
    // so every AI-authored headline shipped at the font's default tracking and a
    // body line-height, which is most of why generated type reads as untypeset.
    'fontFamily', 'letterSpacing', 'lineHeight', 'align',
    // Both are read by buildSnapshot (cornerRadius:189, backdropBlur:190) and
    // were unreachable from any tool. `backdropBlur` in particular is the whole
    // glass-surface vocabulary and it was already fully wired and tested.
    'cornerRadius', 'backdropBlur',
    // Static 3D placement. Previously the ONLY way to give a layer a z was a
    // one-keyframe `set_keyframes` call, which sets the value but also creates
    // an animation track — so a technique that later animated z inherited a
    // keyframe it did not author and started from the wrong place.
    'z', 'rotationX', 'rotationY',
    // Camera. These were keyframeable and NOT settable, which meant every
    // library-emitted camera ran on the engine's default lens — `emitCamera`
    // picked one and its `update_layer` call was rejected for an unknown
    // property, on all six camera techniques, silently. They route to the
    // Transform component, which is where CameraSection writes them too and
    // where `cameraFromNode` reads them from.
    ...CAMERA_PROPS,
  ]) {
    if (i[key] === undefined) continue;
    // The 3D props are inert without the switch, and silently so. Refusing is
    // better than writing a value the renderer will never read.
    if ((CAMERA_PROPS as readonly string[]).includes(key) && node && readNodeKind(node) !== 'camera') {
      return fail(
        `'${key}' is a camera property and '${i.nodeId}' is a ${readNodeKind(node)}. ` +
        `Create one with create_layer { kind: "camera" } first.`,
      );
    }
    if ((THREE_D_PROPS as readonly string[]).includes(key) && node && !is3DEnabled(node)) {
      return fail(
        `'${key}' needs the layer's 3D switch — pass threeD: true in this same call (it is applied first).`,
      );
    }
    if (ctx.scene.setProp(i.nodeId, map[key] ?? key, i[key])) applied.push(key);
  }

  if (!applied.length) return fail('Nothing to update — pass at least one property besides nodeId.');
  bumpScene();
  return ok(`Updated ${i.nodeId}: ${applied.join(', ')}.`);
};

// ── Write: animation ──────────────────────────────────────────────

interface KeyframeInput {
  nodeId: string;
  prop: string;
  t: number;
  value: number;
  easing?: string;
  bezier?: number[];
}

const setKeyframes: AiTool['handler'] = (input, ctx) => {
  const { keyframes } = input as { keyframes: KeyframeInput[] };
  const bad: string[] = [];
  const touched = new Set<string>();
  let applied = 0;

  for (const [i, k] of keyframes.entries()) {
    if (!ctx.scene.has(k.nodeId)) { bad.push(`keyframes[${i}]: ${unknownNode(ctx, k.nodeId)}`); continue; }
    if (!isAnimatableProp(k.prop)) {
      bad.push(`keyframes[${i}]: '${k.prop}' is not animatable. Call list_capabilities for the real property paths.`);
      continue;
    }
    // A camera is 3D by nature — its z (dolly) needs no 3D switch, and it never
    // renders rotationX/Y (it uses orbitYaw/orbitPitch instead).
    const isCamera = ctx.scene.get(k.nodeId)?.kind === 'camera';
    if (
      !isCamera &&
      (THREE_D_PROPS as readonly string[]).includes(k.prop) &&
      !is3DEnabled(defaultSceneGraph.getNode(k.nodeId)!)
    ) {
      bad.push(`keyframes[${i}]: '${k.prop}' needs the 3D switch — call update_layer { nodeId: '${k.nodeId}', threeD: true } first.`);
      continue;
    }

    // The one conversion, done once, for the value AND its easing. Splitting
    // these is exactly the bug this design exists to prevent.
    const lt = ctx.time.toLayerTime(k.nodeId, k.t);
    ctx.anim.setKeyframe(k.nodeId, k.prop, lt, k.value, k.easing ?? 'linear');
    if (k.easing === 'bezier' && k.bezier) {
      ctx.anim.setBezier(k.nodeId, k.prop, lt, k.bezier);
    }
    touched.add(`${k.nodeId}.${k.prop}`);
    applied++;
  }

  // A single keyframe on a property holds a constant — usually a mistake worth
  // naming, since the model thinks it animated something.
  const singles = [...touched].filter((key) => {
    const [nodeId, ...rest] = key.split('.');
    const prop = rest.join('.');
    return (ctx.anim.tracks(nodeId!).find((t) => t.prop === prop)?.keyframes.length ?? 0) < 2;
  });
  const warn = singles.length
    ? `\nNote: ${singles.join(', ')} now has only ONE keyframe, so it holds a constant. Add a second at a different time to make it move.`
    : '';

  if (bad.length) {
    return { ok: false, content: `Applied ${applied} of ${keyframes.length} keyframes. Rejected:\n- ${bad.join('\n- ')}${warn}` };
  }
  return ok(`Set ${applied} keyframes across ${touched.size} propert${touched.size === 1 ? 'y' : 'ies'}.${warn}`);
};

const removeKeyframes: AiTool['handler'] = (input, ctx) => {
  const { targets } = input as { targets: { nodeId: string; prop: string; t?: number }[] };
  const bad: string[] = [];
  let n = 0;
  for (const [i, tg] of targets.entries()) {
    if (!ctx.scene.has(tg.nodeId)) { bad.push(`targets[${i}]: ${unknownNode(ctx, tg.nodeId)}`); continue; }
    if (tg.t === undefined) {
      const track = ctx.anim.tracks(tg.nodeId).find((t) => t.prop === tg.prop);
      if (!track) { bad.push(`targets[${i}]: ${tg.nodeId} has no '${tg.prop}' track.`); continue; }
      for (const k of [...track.keyframes]) ctx.anim.removeKeyframe(tg.nodeId, tg.prop, k.t);
      n += track.keyframes.length;
    } else {
      ctx.anim.removeKeyframe(tg.nodeId, tg.prop, ctx.time.toLayerTime(tg.nodeId, tg.t));
      n++;
    }
  }
  if (bad.length) return { ok: false, content: `Removed ${n}. Failed:\n- ${bad.join('\n- ')}` };
  return ok(`Removed ${n} keyframe(s).`);
};

const setEasing: AiTool['handler'] = (input, ctx) => {
  const { targets } = input as { targets: { nodeId: string; prop: string; t: number; easing?: string; bezier?: number[]; roving?: boolean }[] };
  const bad: string[] = [];
  let n = 0;
  for (const [i, tg] of targets.entries()) {
    if (!ctx.scene.has(tg.nodeId)) { bad.push(`targets[${i}]: ${unknownNode(ctx, tg.nodeId)}`); continue; }
    const lt = ctx.time.toLayerTime(tg.nodeId, tg.t);
    const track = ctx.anim.tracks(tg.nodeId).find((t) => t.prop === tg.prop);
    const exists = track?.keyframes.some((k) => Math.abs(k.t - lt) < 1e-4);
    if (!exists) {
      // Naming the times that DO exist saves a guess-and-retry round trip.
      const times = track?.keyframes.map((k) => ctx.time.toCompTime(tg.nodeId, k.t)).join(', ') ?? 'none';
      bad.push(`targets[${i}]: no '${tg.prop}' keyframe at t=${tg.t} on ${tg.nodeId}. Existing times: ${times}.`);
      continue;
    }
    if (tg.easing) ctx.anim.setEasing(tg.nodeId, tg.prop, lt, tg.easing);
    if (tg.easing === 'bezier' && tg.bezier) ctx.anim.setBezier(tg.nodeId, tg.prop, lt, tg.bezier);
    if (tg.roving !== undefined) ctx.anim.setRoving(tg.nodeId, tg.prop, lt, tg.roving);
    n++;
  }
  if (bad.length) return { ok: false, content: `Updated ${n}. Failed:\n- ${bad.join('\n- ')}` };
  return ok(`Updated easing on ${n} keyframe(s).`);
};

const setExpression: AiTool['handler'] = (input, ctx) => {
  const { nodeId, prop, expression } = input as { nodeId: string; prop: string; expression: string };
  if (!ctx.scene.has(nodeId)) return fail(unknownNode(ctx, nodeId));
  if (!isAnimatableProp(prop)) return fail(`'${prop}' is not animatable. Call list_capabilities.`);
  ctx.anim.setExpression(nodeId, prop, expression);
  if (!expression.trim()) return ok(`Removed the expression on ${nodeId}.${prop}.`);
  // Compile errors are reported here rather than discovered at render time.
  const err = ctx.anim.getExpressionError(nodeId, prop);
  if (err) {
    ctx.anim.setExpression(nodeId, prop, '');
    return fail(`Expression rejected and not applied: ${err}. It must be a single expression returning a number — no 'return', no statements.`);
  }
  return ok(`Applied expression to ${nodeId}.${prop}. It now overrides any keyframed value.`);
};

// ── Write: effects + text ─────────────────────────────────────────

const addEffectHandler: AiTool['handler'] = (input, ctx) => {
  const { nodeId, type, amount } = input as { nodeId: string; type: string; amount?: number };
  if (!ctx.scene.has(nodeId)) return fail(unknownNode(ctx, nodeId));
  const id = ctx.scene.addEffect(nodeId, type);
  if (!id) return fail(`Could not add '${type}' to ${nodeId}.`);
  if (amount !== undefined) ctx.scene.updateEffect(nodeId, id, amount);
  const d = EFFECT_DEFS.find((e) => e.type === type);
  const primary = d?.params.find((p) => p.type === 'number');
  const params = d?.params.map((p) => p.key).join(', ') ?? '';
  return ok(
    `Added ${type} to ${nodeId} with effectId '${id}'. Params: ${params}.` +
      (primary
        ? ` ${primary.key} ranges ${primary.min}..${primary.max}${primary.unit ? ` ${primary.unit}` : ''}.`
        : '') +
      ` Animate any numeric param by keyframing prop "effect.${id}.<param>".`,
    { effectId: id },
  );
};

const updateEffectHandler: AiTool['handler'] = (input, ctx) => {
  const { nodeId, effectId, amount, remove } = input as { nodeId: string; effectId: string; amount?: number; remove?: boolean };
  if (!ctx.scene.has(nodeId)) return fail(unknownNode(ctx, nodeId));
  if (remove) {
    ctx.scene.removeEffect(nodeId, effectId);
    return ok(`Removed effect ${effectId} from ${nodeId}.`);
  }
  if (amount === undefined) return fail('Pass amount, or remove: true.');
  ctx.scene.updateEffect(nodeId, effectId, amount);
  return ok(`Set effect ${effectId} to ${amount}.`);
};

const textAnimator: AiTool['handler'] = (input, ctx) => {
  const i = input as Record<string, unknown> & { nodeId: string; index?: number; remove?: boolean };
  if (!ctx.scene.has(i.nodeId)) return fail(unknownNode(ctx, i.nodeId));
  const node = defaultSceneGraph.getNode(i.nodeId);
  if (!node || !node.components.some((c) => c.type === 'Text')) {
    return fail(`${i.nodeId} is not a text layer — text animators only apply to text.`);
  }

  let index = i.index;
  if (index === undefined) {
    addTextAnimator(i.nodeId);
    index = readAnimatorData(node).length - 1;
  } else if (index >= readAnimatorData(node).length) {
    return fail(`${i.nodeId} has no animator at index ${index}. It has ${readAnimatorData(node).length}.`);
  }

  const patch: Record<string, unknown> = {};
  // The animator model carries far more than transforms: blur, skew, fillOpacity
  // and characterOffset are what make a type-on read as designed rather than as
  // "the letters moved". They existed in the engine and were unreachable.
  for (const key of [
    'basedOn', 'shape', 'start', 'end', 'offset',
    'x', 'y', 'scale', 'scaleY', 'rotation', 'opacity', 'tracking',
    'lineSpacing', 'blur', 'skew', 'fillOpacity', 'characterOffset', 'color',
  ]) {
    if (i[key] !== undefined) patch[key] = i[key];
  }
  if (Object.keys(patch).length) updateAnimator(i.nodeId, index, patch);

  // ── Animate the selector in the same call ────────────────────────────────
  // An animator whose selector never moves is a static style, not an animation.
  // Making the sweep a second round-trip meant the model routinely forgot it —
  // so `sweep` folds it in here.
  const sweep = i.sweep as
    | { fromSec: number; toSec: number; fromOffset?: number; toOffset?: number; easing?: string; bezier?: number[] }
    | undefined;
  let swept = '';
  if (sweep) {
    if (sweep.toSec <= sweep.fromSec) {
      return fail(
        `sweep.toSec (${sweep.toSec}) must be after sweep.fromSec (${sweep.fromSec}) — a zero-length ` +
        `sweep writes two keyframes at one time and animates nothing.`,
      );
    }
    const prop = `ta.${index}.offset`;
    const a = ctx.time.toLayerTime(i.nodeId, sweep.fromSec);
    const b = ctx.time.toLayerTime(i.nodeId, sweep.toSec);
    const easing = sweep.easing ?? 'bezier';
    ctx.anim.setKeyframe(i.nodeId, prop, a, sweep.fromOffset ?? -100, easing);
    ctx.anim.setKeyframe(i.nodeId, prop, b, sweep.toOffset ?? 100, 'linear');
    if (easing === 'bezier') {
      // A default that is not linear: a linear selector sweep gives every
      // character exactly the same timing, which is the flat machine-gun type-on.
      ctx.anim.setBezier(i.nodeId, prop, a, (sweep.bezier as [number, number, number, number]) ?? [0.22, 0.61, 0.36, 1]);
    }
    swept = ` Selector sweeps ${sweep.fromOffset ?? -100}% → ${sweep.toOffset ?? 100}% between ${sweep.fromSec}s and ${sweep.toSec}s.`;
  }

  bumpScene();
  return ok(
    `Text animator ${index} on ${i.nodeId} is ready.${swept}` +
    (sweep ? '' : ` It has a STATIC selector, so it currently applies a constant style rather than an animation — pass \`sweep\`, or keyframe "ta.${index}.offset".`),
    { index },
  );
};

// ── Media ─────────────────────────────────────────────────────────

const listAssets: AiTool['handler'] = () => {
  const assets = useAssetStore.getState().assets;
  if (!assets.length) {
    return ok(
      'No media has been imported into this project. You cannot import files — ask the user to add ' +
        'images/videos/audio first, or build the scene from shapes and text.',
      { assets: [] },
    );
  }
  const lines = assets.map((a) => {
    const m = a.metadata;
    const dim = m?.width && m?.height ? ` ${m.width}×${m.height}` : '';
    const dur = m?.duration ? ` ${m.duration.toFixed(1)}s` : '';
    return `- ${a.id} "${a.name}" (${a.type}${dim}${dur})`;
  });
  return ok(
    `Imported assets (${assets.length}) — place one with create_media { assetId }:\n${lines.join('\n')}`,
    { assets: assets.map((a) => ({ id: a.id, name: a.name, type: a.type, ...a.metadata })) },
  );
};

const createMedia: AiTool['handler'] = async (input, ctx) => {
  const { id: alias, assetId, x, y } = input as { id?: string; assetId: string; x?: number; y?: number };
  const asset = useAssetStore.getState().assets.find((a) => a.id === assetId);
  if (!asset) {
    const avail = useAssetStore.getState().assets.map((a) => a.id).join(', ') || '(none imported)';
    return fail(`No imported asset with id '${assetId}'. Call list_assets first. Available ids: ${avail}.`);
  }

  await insertMedia(asset);
  // insertMedia selects the layer it just made — that selection is how we learn
  // the new node's id (the inserter doesn't return it).
  const id = ctx.scene.selection()[0] ?? useSelectionStore.getState().ids[0];
  if (!id) return fail(`Placed "${asset.name}" but could not resolve the new layer id.`);
  bindAlias(ctx, alias, id);

  if (x !== undefined || y !== undefined) {
    const node = defaultSceneGraph.getNode(id);
    const t = node?.components.find((c) => c.type === 'Transform');
    if (t) {
      if (x !== undefined) defaultSceneGraph.writeProp(id, t.id, 'x', x);
      if (y !== undefined) defaultSceneGraph.writeProp(id, t.id, 'y', y);
    }
  }
  bumpScene();
  return ok(`Added ${asset.type} layer "${asset.name}" with id '${id}'. Animate it like any other layer.`, { id });
};


/**
 * Generate an image and place it as a layer.
 *
 * Three things this must get right, all of them learned from the surrounding
 * code rather than invented here:
 *
 *  • **The key never comes near this process.** The request carries a provider
 *    id and a prompt; the server holds the key and makes the call. Same boundary
 *    as `/ai/stream`.
 *  • **The result becomes a real asset.** Bytes go through `addAsset`, so the
 *    image lands in the user's library, survives a reload, saves with the
 *    project, and can be reused — rather than living as a blob URL that dies
 *    with the tab.
 *  • **Failures are reported, never swallowed.** An image that did not arrive
 *    has to say why, because it cost the user credits and several seconds.
 */
const generateImage: AiTool['handler'] = async (input, ctx) => {
  const { id: alias, prompt, aspect, x, y } = input as {
    id?: string; prompt: string; aspect?: string; x?: number; y?: number;
  };

  const comp = ctx.comp.get();
  // Aspect is advisory — the gateway maps it onto a size the provider accepts.
  // Sending the comp's own dimensions lets a square comp get a square image
  // without the model having to reason about it.
  const dims =
    aspect === 'square' ? { width: 1024, height: 1024 }
    : aspect === 'portrait' ? { width: 1024, height: 1536 }
    : aspect === 'landscape' ? { width: 1536, height: 1024 }
    : { width: comp.width, height: comp.height };

  const provider = useAiProviderStore.getState().provider;

  let res: { ok: boolean; base64: string; mime: string; creditsUsed: number };
  try {
    res = await api.generateImage({ provider, prompt, ...dims });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      `Image generation failed: ${message}. The scene is unchanged and no layer was added. ` +
      `Carry on with the rest of the piece rather than retrying — a second attempt costs again.`,
    );
  }
  if (!res.ok || !res.base64) return fail('The image provider returned nothing. Try rewording the prompt.');

  // base64 → File, so this takes exactly the same path as a user drag-and-drop.
  const bytes = Uint8Array.from(atob(res.base64), (ch) => ch.charCodeAt(0));
  const ext = res.mime === 'image/jpeg' ? 'jpg' : 'png';
  const name = `${prompt.slice(0, 40).replace(/[^\w -]/g, '').trim() || 'generated'}.${ext}`;
  const file = new File([bytes as BlobPart], name, { type: res.mime });

  const asset = await useAssetStore.getState().addAsset(file);
  await insertMedia(asset);

  const id = ctx.scene.selection()[0] ?? useSelectionStore.getState().ids[0];
  if (!id) return fail(`Generated "${name}" and added it to the library, but could not resolve the new layer id.`);
  bindAlias(ctx, alias, id);

  if (x !== undefined || y !== undefined) {
    const node = defaultSceneGraph.getNode(id);
    const t = node?.components.find((c) => c.type === 'Transform');
    if (t) {
      if (x !== undefined) defaultSceneGraph.writeProp(id, t.id, 'x', x);
      if (y !== undefined) defaultSceneGraph.writeProp(id, t.id, 'y', y);
    }
  }
  bumpScene();
  return ok(
    `Generated an image and placed it as layer '${id}'` +
      (res.creditsUsed ? ` (${res.creditsUsed} credits).` : '.') +
      ` It is in the asset library as "${name}" — reuse it rather than generating again.`,
    { id, assetId: asset.id, creditsUsed: res.creditsUsed },
  );
};


/**
 * Build a layer from SVG markup the model wrote.
 *
 * This capability already existed for user imports; the AI simply could not
 * reach it. Everything about the path is unchanged — the same sanitizer, the
 * same scoping, the same layer shape — because the interesting risk here is
 * markup, and markup from a model deserves exactly the same treatment as markup
 * from a file the user dragged in. `insertSvgLayer` returning null IS the
 * sanitizer's refusal, and it is reported rather than retried.
 */
const importSvg: AiTool['handler'] = async (input, ctx) => {
  const { id: alias, markup, name, x, y } = input as {
    id?: string; markup: string; name: string; x?: number; y?: number;
  };
  if (!/<svg[\s>]/i.test(markup)) {
    return fail('That is not SVG markup — it must contain an <svg> element with a viewBox.');
  }

  const nodeId = insertSvgLayer(markup, name, {
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
  });
  if (!nodeId) {
    return fail(
      `The SVG could not be used: sanitizing rejected it. Write self-contained markup — inline ` +
      `geometry only, no <script>, no <image href>, no external references.`,
    );
  }
  bindAlias(ctx, alias, nodeId);
  bumpScene();
  return ok(`Added SVG layer "${name}" with id '${nodeId}'. Animate it like any other layer.`, { id: nodeId });
};

/**
 * Tempo, beat grid and onsets for an audio layer.
 *
 * Decoding happens HERE rather than in `@motion/audio`, and that split is the
 * point: the browser has `decodeAudioData` and Node does not, so keeping it out
 * of the package is what lets the analysis be tested against synthesised signals
 * whose answer is known exactly.
 */
const analyseAudioTool: AiTool['handler'] = async (input) => {
  const { nodeId, maxBeats } = input as { nodeId: string; maxBeats?: number };
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return fail(`No layer with id '${nodeId}'.`);

  const src = useAssetStore.getState().assets.find((a) => a.id === readAudioAssetId(node))?.src;
  if (!src) {
    return fail(
      `Layer '${nodeId}' has no audio asset to analyse. Call describe_scene and pick a layer of ` +
      `kind 'audio'.`,
    );
  }

  try {
    const buf = await fetch(src).then((r) => r.arrayBuffer());
    const AudioCtor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return fail('This environment cannot decode audio.');
    const actx = new AudioCtor();
    const decoded = await actx.decodeAudioData(buf);
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    const a = analyseAudio(channels, decoded.sampleRate);
    void actx.close();

    const cap = Math.max(1, Math.min(512, maxBeats ?? 128));
    const beats = a.beats.slice(0, cap).map((t) => Number(t.toFixed(3)));
    const onsets = a.onsets.slice(0, cap).map((t) => Number(t.toFixed(3)));

    // Say plainly when there is no usable tempo. A grid at the wrong tempo puts
    // every cut in the wrong place for the whole piece, which is worse than
    // timing from the brief.
    const verdict =
      a.tempoConfidence < 0.25
        ? `No reliable tempo (confidence ${a.tempoConfidence}). Time this from the brief, not from a grid.`
        : `${a.bpm} BPM, confidence ${a.tempoConfidence}.`;

    return ok(
      `${verdict} ${a.durationSec.toFixed(1)}s of audio, ${a.beats.length} beats and ` +
      `${a.onsets.length} onsets detected` +
      (beats.length < a.beats.length ? ` (first ${beats.length} returned).` : '.'),
      { bpm: a.bpm, tempoConfidence: a.tempoConfidence, beats, onsets, durationSec: a.durationSec },
    );
  } catch (err) {
    return fail(`Could not analyse that audio: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/** The asset id an audio layer points at, whatever component carries it. */
function readAudioAssetId(node: { components: { props: Record<string, unknown> }[] }): string | undefined {
  for (const c of node.components) {
    const v = c.props.assetId ?? c.props.src;
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

const createMediaFromAttachment: AiTool['handler'] = async (input, ctx) => {
  const { index, name, x, y } = input as { index: number; name?: string; x?: number; y?: number };
  if (!ctx.images || !ctx.images[index]) {
    return fail(`No attached reference image found at index ${index}. Attach images to your prompt to use this tool.`);
  }
  const img = ctx.images[index]!;
  
  let file: File;
  try {
    const byteCharacters = atob(img.dataBase64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: img.mediaType });
    const filename = name ? `${name.replace(/\s+/g, '_')}.jpg` : `attachment_${index}.jpg`;
    file = new File([blob], filename, { type: img.mediaType });
  } catch (err) {
    return fail(`Failed to decode base64 attachment: ${err instanceof Error ? err.message : err}`);
  }

  let asset;
  try {
    asset = await useAssetStore.getState().addAsset(file);
  } catch (err) {
    return fail(`Failed to upload reference image: ${err instanceof Error ? err.message : err}`);
  }
  if (!asset) {
    return fail(`Could not upload and create asset for reference image.`);
  }

  await insertMedia(asset);
  const id = ctx.scene.selection()[0] ?? useSelectionStore.getState().ids[0];
  if (!id) return fail(`Placed attachment "${asset.name}" but could not resolve the new layer id.`);

  if (x !== undefined || y !== undefined) {
    const node = defaultSceneGraph.getNode(id);
    const t = node?.components.find((c) => c.type === 'Transform');
    if (t) {
      if (x !== undefined) defaultSceneGraph.writeProp(id, t.id, 'x', x);
      if (y !== undefined) defaultSceneGraph.writeProp(id, t.id, 'y', y);
    }
  }
  bumpScene();
  return ok(`Added attachment image layer "${asset.name}" with id '${id}'. Animate it like any other layer.`, { id });
};

// ── Write: masks ──────────────────────────────────────────────────

const createMask: AiTool['handler'] = (input, ctx) => {
  const i = input as {
    nodeId: string;
    shape: 'rectangle' | 'ellipse';
    mode?: MaskMode;
    width?: number;
    height?: number;
    feather?: number;
    opacity?: number;
    expansion?: number;
    inverted?: boolean;
  };
  if (!ctx.scene.has(i.nodeId)) return fail(unknownNode(ctx, i.nodeId));

  // Size the mask to the layer's bounds unless told otherwise. Text has no
  // width/height prop, so fall back to a sensible square the AI can resize.
  const node = defaultSceneGraph.getNode(i.nodeId);
  const tp = (node?.components.find((c) => c.type === 'Transform')?.props ?? {}) as Record<string, unknown>;
  const w = i.width ?? (typeof tp.width === 'number' && tp.width > 0 ? tp.width : 200);
  const h = i.height ?? (typeof tp.height === 'number' && tp.height > 0 ? tp.height : 200);

  const path = i.shape === 'ellipse' ? ellipseMask(w, h) : rectangleMask(w, h);
  if (i.mode) path.mode = i.mode;
  if (i.feather !== undefined) path.feather = i.feather;
  if (i.opacity !== undefined) path.opacity = i.opacity;
  if (i.expansion !== undefined) path.expansion = i.expansion;
  if (i.inverted !== undefined) path.inverted = i.inverted;

  addMaskPath(i.nodeId, path);
  bumpScene();
  return ok(
    `Added a ${i.shape} mask (${Math.round(w)}×${Math.round(h)}, mode ${path.mode}) to ${i.nodeId} ` +
      `with maskId '${path.id}'. It clips the layer to the ${path.inverted ? 'outside' : 'inside'} of the shape.`,
    { maskId: path.id },
  );
};

// ── Write: comp + presets ─────────────────────────────────────────

const updateComposition: AiTool['handler'] = (input, ctx) => {
  const patch = { ...(input as Record<string, number | string>) };
  // Size is fixed at creation — strip any width/height a model still sends
  // (older prompts / schema drift) so it can never resize the canvas.
  const blocked = ['width', 'height'].filter((k) => k in patch);
  for (const k of blocked) delete patch[k];
  if (!Object.keys(patch).length) {
    return fail(
      blocked.length
        ? 'Composition width/height are fixed at creation and cannot be changed. Design for the current frame instead.'
        : 'Pass at least one setting to change (duration, fps, or background).',
    );
  }
  ctx.comp.update(patch as never);
  // The composition store and the timeline's time domain must agree, or layer
  // clips keep the OLD length and everything past the old end gets culled
  // (scene 3 vanishing at the previous duration boundary). Mirror duration/fps
  // into the TimelineController exactly as the Composition Settings dialog does.
  if (typeof patch.durationSeconds === 'number') {
    getTimelineController().setDurationSeconds(useCompositionStore.getState().durationSeconds);
  }
  if (typeof patch.fps === 'number') {
    getTimelineController().setFrameRate(useCompositionStore.getState().fps);
  }
  const note = blocked.length ? ' (ignored width/height — size is locked)' : '';
  return ok(`Composition updated${note}: ${JSON.stringify(ctx.comp.get())}`);
};

const applyPreset: AiTool['handler'] = (input, ctx) => {
  const { nodeId, preset, atTime } = input as { nodeId: string; preset: string; atTime?: number };
  if (!ctx.scene.has(nodeId)) return fail(unknownNode(ctx, nodeId));
  const t = atTime ?? 0;
  const applied = ctx.anim.applyPreset(nodeId, preset, ctx.time.toLayerTime(nodeId, t));
  if (!applied) {
    return fail(`No preset named '${preset}'. Available: ${ctx.anim.listPresets().join(', ')}`);
  }
  return ok(`Applied '${preset}' to ${nodeId} at ${t}s.`);
};

// ── High-level composition (Tool Intelligence) ────────────────────

const addBackground: AiTool['handler'] = (input, ctx) => {
  const i = input as { style?: string; color?: string };
  const id = recipeBackground(ctx, resolveStyle(i.style), i.color);
  bumpScene();
  return ok(`Added a full-comp background (id ${id}).`, { id });
};

const addTitle: AiTool['handler'] = (input, ctx) => {
  const i = input as { text: string; level?: 'title' | 'subtitle' | 'tagline'; style?: string; y?: number; scene?: number; entrance?: EntranceArchetype };
  if (typeof i.scene === 'number') selectScene(i.scene);
  const id = recipeText(ctx, resolveStyle(i.style), { text: i.text, level: i.level ?? 'title', y: i.y, entrance: i.entrance });
  bumpScene();
  return ok(`Added ${i.level ?? 'title'} "${i.text}" (id ${id}), positioned and animated in.`, { id });
};

const addEmblem: AiTool['handler'] = (input, ctx) => {
  const i = input as { style?: string; y?: number; size?: number; scene?: number; entrance?: EntranceArchetype };
  if (typeof i.scene === 'number') selectScene(i.scene);
  const id = recipeEmblem(ctx, resolveStyle(i.style), { y: i.y, size: i.size, entrance: i.entrance });
  bumpScene();
  return ok(`Added a glowing emblem (id ${id}) with an animated entrance and pulse.`, { id });
};

const addCards: AiTool['handler'] = (input, ctx) => {
  const i = input as { count?: number; style?: string; y?: number; scene?: number; entrance?: EntranceArchetype };
  if (typeof i.scene === 'number') selectScene(i.scene);
  const ids = recipeCards(ctx, resolveStyle(i.style), { count: i.count, y: i.y, entrance: i.entrance });
  bumpScene();
  return ok(`Added a row of ${ids.length} card(s), staggered in. Ids: ${ids.join(', ')}.`, { ids });
};

const staggerIn: AiTool['handler'] = (input, ctx) => {
  const i = input as { nodeIds: string[]; style?: string; entrance?: EntranceArchetype };
  const bad = i.nodeIds.filter((n) => !ctx.scene.has(n));
  const applied = recipeStaggerIn(ctx, resolveStyle(i.style), i.nodeIds, i.entrance);
  bumpScene();
  if (bad.length) return { ok: applied > 0, content: `Staggered ${applied} layer(s). Unknown ids: ${bad.join(', ')}.` };
  return ok(`Gave ${applied} layer(s) a staggered entrance.`);
};

const defineStyle: AiTool['handler'] = (input) => {
  // `accent` is accepted at the TOP LEVEL and folded into the palette.
  //
  // Both the system prompt ("call define_style FIRST — give it the accent
  // colour") and this tool's own description ("a single accent colour is
  // enough") promised an `accent` argument that the schema did not have. With
  // `additionalProperties: false` that was a hard reject, so the one tool that
  // makes a run on-brand — the one the prompt pushes the model to call first —
  // failed exactly when it was used as documented. An explicit top-level
  // `palette.accent` still wins if both are given.
  const raw = input as CustomStyleInput & { accent?: string };
  const i: CustomStyleInput = raw.accent
    ? { ...raw, palette: { accent: raw.accent, ...(raw.palette ?? {}) } }
    : raw;
  const style = buildCustomStyle(i);
  setRuntimeStyle(style);
  return ok(
    `Defined custom style "${style.name}": accent ${style.palette.accent} on ${style.palette.bg}, ` +
      `title ${style.type.titlePx}px/${style.type.weightTitle}, entrance ${style.entranceDur}s, stagger ${style.staggerSec}s, ` +
      `glow ${style.glow ? 'on' : 'off'}. Compose tools that omit style (or pass "custom") now use it.`,
    { style },
  );
};

const addCameraMove: AiTool['handler'] = (input, ctx) => {
  const i = input as { kind?: 'push_in' | 'pull_out'; style?: string; durationSec?: number };
  const scaled = recipeCameraMove(ctx, { kind: i.kind, durationSec: i.durationSec });
  bumpScene();
  return ok(`Added a slow ${i.kind ?? 'push_in'} across ${scaled} layer(s).`);
};

const addKineticTitle: AiTool['handler'] = (input, ctx) => {
  const i = input as { text: string; style?: string; y?: number; fontSize?: number; scene?: number };
  if (typeof i.scene === 'number') selectScene(i.scene);
  const ids = recipeKineticText(ctx, resolveStyle(i.style), { text: i.text, y: i.y, fontSize: i.fontSize });
  bumpScene();
  if (!ids.length) return fail('The phrase had no words to animate.');
  return ok(`Added kinetic typography: ${ids.length} word(s) popping in on the beat. Ids: ${ids.join(', ')}.`, { ids });
};

const addLightSweep: AiTool['handler'] = (input, ctx) => {
  const i = input as { style?: string; at?: number };
  const id = recipeLightSweep(ctx, resolveStyle(i.style), { at: i.at });
  bumpScene();
  return ok(`Added a light sweep (id ${id}) passing across the frame.`, { id });
};

const addAmbientOrbs: AiTool['handler'] = (input, ctx) => {
  const i = input as { count?: number; style?: string };
  const ids = recipeFloatingOrbs(ctx, resolveStyle(i.style), { count: i.count });
  bumpScene();
  return ok(`Added ${ids.length} ambient orb(s) drifting at background depth. Ids: ${ids.join(', ')}.`, { ids });
};

const addLowerThird: AiTool['handler'] = (input, ctx) => {
  const i = input as { title: string; subtitle?: string; style?: string; scene?: number };
  if (typeof i.scene === 'number') selectScene(i.scene);
  const ids = recipeLowerThird(ctx, resolveStyle(i.style), { title: i.title, subtitle: i.subtitle });
  bumpScene();
  return ok(`Added a lower third ("${i.title}"). Ids: ${ids.join(', ')}.`, { ids });
};

const addScene: AiTool['handler'] = (input, ctx) => {
  const i = input as { index: number; startSec: number; durationSec: number; background?: string; transition?: 'dissolve' | 'cut'; style?: string };
  const id = recipeScene(ctx, resolveStyle(i.style), {
    index: i.index,
    startSec: i.startSec,
    durationSec: i.durationSec,
    background: i.background,
    transition: i.transition,
  });
  bumpScene();
  return ok(
    `Opened scene ${i.index} at ${i.startSec}s for ${i.durationSec}s (bg id ${id}). ` +
      `Content added now enters at ${i.startSec}s and exits at its end.`,
    { id },
  );
};

const addTransition: AiTool['handler'] = (input, ctx) => {
  const i = input as { atSec: number; kind?: 'fade_black' | 'flash'; durationSec?: number };
  const id = recipeTransition(ctx, { atSec: i.atSec, kind: i.kind, durationSec: i.durationSec });
  bumpScene();
  return ok(`Added a ${i.kind ?? 'fade_black'} transition at ${i.atSec}s (id ${id}).`, { id });
};

interface CreatePuppetRigInput {
  layerId: string;
  pins: {
    name: string; x: number; y: number;
    rotation?: number; stiffness?: number; scale?: number; overlap?: number;
  }[];
}

const createPuppetRig: AiTool['handler'] = (input, ctx) => {
  const i = input as CreatePuppetRigInput;
  if (!ctx.scene.has(i.layerId)) {
    const near = ctx.scene.nearest(i.layerId).join(', ');
    return {
      ok: false,
      content: `Layer id '${i.layerId}' not found. Did you mean: ${near || 'none'}?`,
    };
  }
  // A puppet warp mesh needs a bitmap alpha or path silhouette. Groups /
  // precomps / nulls / cameras have no such surface — rig would silently
  // no-op. Tell the model to rasterize (Rig Logo) first.
  const puppetNode = defaultSceneGraph.getNode(i.layerId);
  if (puppetNode && !isRiggableKind(readNodeKind(puppetNode))) {
    return fail(
      `Layer '${i.layerId}' is a ${readNodeKind(puppetNode)} — puppet rigs only apply to shape or image layers. ` +
        `Rasterize it first (the "Rig Logo for Animation" command flattens a group/precomp to a single riggable image).`,
    );
  }
  // Ordinal ids, not timestamps: `pin_${Date.now}_${idx}` collided whenever
  // two rigs were authored inside the same millisecond, and colliding pins
  // share one set of animation tracks.
  const pinIds = nextRigIds(
    'pin_',
    usedRigIds(puppetNode ? readNodePuppet(puppetNode)?.pins : undefined),
    i.pins.length,
  );
  const pinsList = i.pins.map((p, idx) => ({
    id: pinIds[idx]!,
    name: p.name || `Pin ${idx + 1}`,
    x: p.x,
    y: p.y,
    ...(typeof p.rotation === 'number' ? { rotation: p.rotation } : {}),
    ...(typeof p.stiffness === 'number' ? { stiffness: Math.max(0, p.stiffness) } : {}),
    ...(typeof p.scale === 'number' ? { scale: Math.max(0.01, p.scale) } : {}),
    ...(typeof p.overlap === 'number'
      ? { overlap: Math.max(-100, Math.min(100, p.overlap)) }
      : {}),
  }));
  ctx.scene.setPuppet(i.layerId, { pins: pinsList });
  const ids = pinsList.map((p) => ({ id: p.id, name: p.name }));
  return {
    ok: true,
    content:
      `Created puppet rig with ${pinsList.length} pins on layer '${i.layerId}'. ` +
      `Pin ids: ${pinsList.map((p) => p.id).join(', ')}. ` +
      `Animate via tracks puppet.<pinId>.rotation and puppet.<pinId>.stiffness (set_keyframes); ` +
      `pin positions animate via the puppet.<pinId>.position data track (canvas pin drags).`,
    data: { layerId: i.layerId, pinsCount: pinsList.length, pins: ids },
  };
};

interface SetPuppetPinKeyframesInput {
  layerId: string;
  pinId: string;
  keyframes: { timeSec: number; x: number; y: number }[];
}

const setPuppetPinKeyframes: AiTool['handler'] = (input, ctx) => {
  const i = input as SetPuppetPinKeyframesInput;
  if (!ctx.scene.has(i.layerId)) {
    const near = ctx.scene.nearest(i.layerId).join(', ');
    return { ok: false, content: `Layer id '${i.layerId}' not found. Did you mean: ${near || 'none'}?` };
  }
  const rig = ctx.scene.readPuppet(i.layerId);
  if (!rig) {
    return { ok: false, content: `Layer '${i.layerId}' has no puppet rig. Call create_puppet_rig first.` };
  }
  if (!rig.pins.some((p) => p.id === i.pinId)) {
    const ids = rig.pins.map((p) => p.id).join(', ');
    return { ok: false, content: `Pin '${i.pinId}' is not on layer '${i.layerId}'. Pins: ${ids || 'none'}.` };
  }
  if (!i.keyframes || i.keyframes.length === 0) {
    return { ok: false, content: 'Provide at least one keyframe.' };
  }
  const prop = `puppet.${i.pinId}.position`;
  for (const k of i.keyframes) {
    const lt = ctx.time.toLayerTime(i.layerId, k.timeSec);
    ctx.anim.setPointsKeyframe(i.layerId, prop, lt, [{ x: k.x, y: k.y }]);
  }
  return {
    ok: true,
    content:
      `Set ${i.keyframes.length} position keyframe(s) on pin '${i.pinId}' of layer '${i.layerId}'. ` +
      `The pin now animates along ${prop}.`,
    data: { layerId: i.layerId, pinId: i.pinId, keyframes: i.keyframes.length },
  };
};

import { mergeSelectedPaths, type MergeOp } from '@core/scene/mergePaths';

const mergePathsHandler: AiTool['handler'] = (input, ctx) => {
  const i = input as { op: MergeOp; nodeIds: string[] };
  const missing = i.nodeIds.filter((id) => !ctx.scene.has(id));
  if (missing.length > 0) return fail(`Unknown nodeId(s): ${missing.join(', ')}`);
  useSelectionStore.getState().set(i.nodeIds);
  const resultIds = mergeSelectedPaths(i.op);
  if (resultIds.length === 0) return fail(`Failed to apply merge operation '${i.op}' on layers.`);
  return ok(`Applied merge operation '${i.op}'. Generated node(s): ${resultIds.join(', ')}.`, { resultIds });
};

const setTrimPathHandler: AiTool['handler'] = (input, ctx) => {
  const i = input as { nodeId: string; start?: number; end?: number; offset?: number };
  if (!ctx.scene.has(i.nodeId)) return fail(unknownNode(ctx, i.nodeId));
  const node = defaultSceneGraph.getNode(i.nodeId);
  if (!node) return fail(`Node '${i.nodeId}' not found.`);
  const geom = node.components.find((c) => c.type === 'Geometry');
  if (!geom) return fail(`Node '${i.nodeId}' has no Geometry component.`);
  if (i.start !== undefined) geom.props.trimStart = i.start;
  if (i.end !== undefined) geom.props.trimEnd = i.end;
  if (i.offset !== undefined) geom.props.trimOffset = i.offset;
  bumpScene();
  return ok(`Updated trim path on layer '${i.nodeId}'.`, { nodeId: i.nodeId });
};

const addRepeaterHandler: AiTool['handler'] = (input, ctx) => {
  const i = input as {
    nodeId: string;
    copies?: number;
    positionX?: number;
    positionY?: number;
    rotation?: number;
    scaleX?: number;
    scaleY?: number;
    startOpacity?: number;
    endOpacity?: number;
  };
  if (!ctx.scene.has(i.nodeId)) return fail(unknownNode(ctx, i.nodeId));
  const node = defaultSceneGraph.getNode(i.nodeId);
  if (!node) return fail(`Node '${i.nodeId}' not found.`);
  let fx = node.components.find((c) => c.type === 'fx');
  if (!fx) {
    fx = { id: `${i.nodeId}_fx`, type: 'fx', props: {} };
    node.components.push(fx);
  }
  fx.props.repeater = {
    copies: i.copies ?? 3,
    positionX: i.positionX ?? 100,
    positionY: i.positionY ?? 0,
    rotation: i.rotation ?? 0,
    scaleX: i.scaleX ?? 1,
    scaleY: i.scaleY ?? 1,
    startOpacity: i.startOpacity ?? 100,
    endOpacity: i.endOpacity ?? 100,
  };
  bumpScene();
  return ok(`Added repeater to layer '${i.nodeId}'.`, { nodeId: i.nodeId });
};

const addPathOperatorHandler: AiTool['handler'] = (input, ctx) => {
  const i = input as { nodeId: string; op: 'zigzag' | 'puckerBloat' | 'twist' | 'roundCorners'; amount?: number };
  if (!ctx.scene.has(i.nodeId)) return fail(unknownNode(ctx, i.nodeId));
  const node = defaultSceneGraph.getNode(i.nodeId);
  if (!node) return fail(`Node '${i.nodeId}' not found.`);
  let fx = node.components.find((c) => c.type === 'fx');
  if (!fx) {
    fx = { id: `${i.nodeId}_fx`, type: 'fx', props: {} };
    node.components.push(fx);
  }
  fx.props.pathOp = { type: i.op, amount: i.amount ?? 20 };
  bumpScene();
  return ok(`Applied path operator '${i.op}' to layer '${i.nodeId}'.`, { nodeId: i.nodeId });
};

const setTextOnPathHandler: AiTool['handler'] = (input, ctx) => {
  const i = input as { nodeId: string; pathNodeId: string; align?: string };
  if (!ctx.scene.has(i.nodeId)) return fail(unknownNode(ctx, i.nodeId));
  if (!ctx.scene.has(i.pathNodeId)) return fail(unknownNode(ctx, i.pathNodeId));
  const node = defaultSceneGraph.getNode(i.nodeId);
  if (!node) return fail(`Node '${i.nodeId}' not found.`);
  const textComp = node.components.find((c) => c.type === 'Text');
  if (!textComp) return fail(`Node '${i.nodeId}' is not a text layer.`);
  textComp.props.pathNodeId = i.pathNodeId;
  if (i.align) textComp.props.pathAlign = i.align;
  bumpScene();
  return ok(`Set text layer '${i.nodeId}' to follow path layer '${i.pathNodeId}'.`, { nodeId: i.nodeId });
};

const createSkeletonRigHandler: AiTool['handler'] = (input, ctx) => {
  const i = input as { layerId: string; bones: Array<{ id: string; parentId?: string; length: number; x?: number; y?: number; rotation?: number }> };
  if (!ctx.scene.has(i.layerId)) return fail(unknownNode(ctx, i.layerId));
  const node = defaultSceneGraph.getNode(i.layerId);
  if (!node) return fail(`Node '${i.layerId}' not found.`);
  if (!isRiggableKind(readNodeKind(node))) {
    return fail(
      `Layer '${i.layerId}' is a ${readNodeKind(node)} — skeleton rigs only apply to shape or image layers. ` +
        `Rasterize it first (the "Rig Logo for Animation" command flattens a group/precomp to a single riggable image).`,
    );
  }
  // Bone ids come from the model, so duplicates are possible — and a duplicate
  // is silent and destructive (both bones share `bone.<id>.rotation`, so posing
  // one poses the other, and deleting one wipes the other's animation). Reject
  // rather than write a corrupt rig.
  const seenBoneIds = new Set<string>();
  const dupes = i.bones.map((b) => b.id).filter((id) => !seenBoneIds.has(id) ? (seenBoneIds.add(id), false) : true);
  if (dupes.length > 0) {
    return fail(
      `Duplicate bone ids in create_skeleton_rig: ${[...new Set(dupes)].join(', ')}. ` +
        `Bone ids key their animation tracks (bone.<id>.rotation) and must be unique within a layer.`,
    );
  }
  const bones = i.bones.map((b) => ({
    id: b.id,
    parentId: b.parentId ?? null,
    length: b.length,
    x: b.x ?? 0,
    y: b.y ?? 0,
    rotation: b.rotation ?? 0,
  }));
  defaultSceneGraph.setSkeleton(i.layerId, { bones, ikTargets: [] });
  bumpScene();
  return ok(`Created skeleton rig with ${bones.length} bones on layer '${i.layerId}'.`, { layerId: i.layerId, boneCount: bones.length });
};

const poseSkeletonHandler: AiTool['handler'] = (input, ctx) => {
  const i = input as { layerId: string; bonePoses: Array<{ boneId: string; timeSec: number; rotation: number; x?: number; y?: number }> };
  if (!ctx.scene.has(i.layerId)) return fail(unknownNode(ctx, i.layerId));
  for (const p of i.bonePoses) {
    const lt = ctx.time.toLayerTime(i.layerId, p.timeSec);
    ctx.anim.setKeyframe(i.layerId, `bone.${p.boneId}.rotation`, lt, p.rotation);
    if (p.x !== undefined) ctx.anim.setKeyframe(i.layerId, `bone.${p.boneId}.x`, lt, p.x);
    if (p.y !== undefined) ctx.anim.setKeyframe(i.layerId, `bone.${p.boneId}.y`, lt, p.y);
  }
  bumpScene();
  return ok(`Set ${i.bonePoses.length} bone pose keyframes on layer '${i.layerId}'.`, { layerId: i.layerId, poseCount: i.bonePoses.length });
};

const applyLayerStyleHandler: AiTool['handler'] = (input, ctx) => {
  const i = input as { nodeId: string; styleType: 'drop_shadow' | 'outer_glow'; color: string; opacity?: number; size?: number; distance?: number; angle?: number };
  if (!ctx.scene.has(i.nodeId)) return fail(unknownNode(ctx, i.nodeId));

  if (i.styleType === 'drop_shadow') {
    updateDropShadow(i.nodeId, {
      enabled: true,
      color: i.color,
      opacity: i.opacity ?? 0.5,
      blur: i.size ?? 8,
      distance: i.distance ?? 8,
      angle: i.angle ?? 90,
    });
  } else {
    updateOuterGlow(i.nodeId, {
      enabled: true,
      color: i.color,
      opacity: i.opacity ?? 0.9,
      size: i.size ?? 16,
    });
  }
  bumpScene();
  return ok(`Applied ${i.styleType} layer style on '${i.nodeId}'.`);
};

const recolorLottieVectorHandler: AiTool['handler'] = (input, ctx) => {
  const { nodeId, color } = input as { nodeId: string; color: string };
  if (!ctx.scene.has(nodeId)) return fail(unknownNode(ctx, nodeId));

  let count = 0;
  const traverseAndRecolor = (id: string) => {
    const node = defaultSceneGraph.getNode(id);
    if (!node) return;
    const kind = readNodeKind(node);
    if (kind === 'shape') {
      const style = node.components.find((c) => c.type === 'Style');
      if (style) {
        style.props.fill = color;
        count++;
      }
    }
    for (const childId of node.children) {
      traverseAndRecolor(childId);
    }
  };

  traverseAndRecolor(nodeId);
  bumpScene();
  return ok(`Recolored ${count} vector shapes inside Lottie/group '${nodeId}' to ${color}.`);
};

// ── Recipe handlers whose defs live in craft.ts ────────────────────

const addLogoReveal: AiTool['handler'] = (input, ctx) => {
  const i = input as { text: string; shape?: 'ellipse' | 'star' | 'rect'; style?: string };
  const s = resolveStyle(i.style);
  const ids = recipeLogoReveal(ctx, s, { text: i.text, shape: i.shape });
  bumpScene();
  return ok(`Built trim-path logo reveal sequence for "${i.text}".`, { ids });
};

const addRadialBurst: AiTool['handler'] = (input, ctx) => {
  const i = input as { count?: number; x?: number; y?: number; style?: string };
  const s = resolveStyle(i.style);
  const id = recipeRadialBurst(ctx, s, { count: i.count, x: i.x, y: i.y });
  bumpScene();
  return ok(`Added radial repeater burst accent '${id}'.`, { id });
};

const addPathMorph: AiTool['handler'] = (input, ctx) => {
  const i = input as { op?: 'puckerBloat' | 'zigzag'; amount?: number; style?: string };
  const s = resolveStyle(i.style);
  const id = recipePathMorph(ctx, s, { op: i.op, amount: i.amount });
  bumpScene();
  return ok(`Added organic shape path morph '${id}'.`, { id });
};

// ── Registry wiring ───────────────────────────────────────────────

const HANDLERS: Record<string, AiTool['handler']> = {
  // The craft primitives (spring, precomp, time remap, shadow stack, surface
  // treatment, …) live in their own file — this one is already 1300 lines.
  ...CRAFT_HANDLERS,
  apply_layer_style: applyLayerStyleHandler,
  add_logo_reveal: addLogoReveal,
  add_radial_burst: addRadialBurst,
  add_path_morph: addPathMorph,
  recolor_lottie_vector: recolorLottieVectorHandler,
  describe_scene: describeScene,

  read_tracks: readTracks,
  evaluate_at: evaluateAt,
  get_selection: getSelection,
  list_capabilities: listCapabilities,
  list_presets: listPresetsHandler,
  list_assets: listAssets,
  create_layer: createLayer,
  create_puppet_rig: createPuppetRig,
  set_puppet_pin_keyframes: setPuppetPinKeyframes,
  merge_paths: mergePathsHandler,
  set_trim_path: setTrimPathHandler,
  add_repeater: addRepeaterHandler,
  add_path_operator: addPathOperatorHandler,
  set_text_on_path: setTextOnPathHandler,
  create_skeleton_rig: createSkeletonRigHandler,
  pose_skeleton: poseSkeletonHandler,
  delete_layer: deleteLayer,
  reparent_layer: reparentLayer,
  update_layer: updateLayer,
  set_keyframes: setKeyframes,
  remove_keyframes: removeKeyframes,
  set_easing: setEasing,
  set_expression: setExpression,
  add_effect: addEffectHandler,
  update_effect: updateEffectHandler,
  text_animator: textAnimator,
  create_media: createMedia,
  generate_image: generateImage,
  import_svg: importSvg,
  analyse_audio: analyseAudioTool,
  create_media_from_attachment: createMediaFromAttachment,
  create_mask: createMask,
  update_composition: updateComposition,
  apply_preset: applyPreset,
  define_style: defineStyle,
  add_background: addBackground,
  add_title: addTitle,
  add_emblem: addEmblem,
  add_cards: addCards,
  stagger_in: staggerIn,
  add_camera_move: addCameraMove,
  add_kinetic_title: addKineticTitle,
  add_light_sweep: addLightSweep,
  add_ambient_orbs: addAmbientOrbs,
  add_lower_third: addLowerThird,
  add_scene: addScene,
  add_transition: addTransition,
};

/**
 * Every tool definition bound to its handler.
 *
 * `ALL_TOOL_DEFS` is the ONLY source. Five tools used to be defined inline here
 * and pushed onto the result, which meant the registry and the static list
 * disagreed — the backend's tool catalogue, the provider emitters and every
 * drift check read the list and never saw them. The throw below is what keeps
 * the two halves in step: a def with no handler fails at boot rather than deep
 * inside a run.
 */
export function buildAiTools(): AiTool[] {
  const tools = ALL_TOOL_DEFS.map((d) => {
    const handler = HANDLERS[d.name];
    if (!handler) throw new Error(`Tool '${d.name}' is declared but has no handler`);
    return { ...def(d.name), handler };
  });

  return tools;
}

