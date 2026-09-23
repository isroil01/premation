/**
 * The handlers behind the tool schemas.
 *
 * Four rules run through all of them:
 *
 * 0. **A write goes through a `SceneGraph` setter or `writeProp`, never through
 *    `getNode(id).components.find(...).props`.** That getter rebuilds a fresh
 *    copy on every read, so an in-place `.props` assignment lands in a throwaway
 *    and is discarded — and the tool then reports success having changed
 *    nothing. Five tools were written that way and every one was a silent
 *    no-op, which is why three of the assistant panel's own quick presets had
 *    never produced their headline effect. `propWriteSurvival.test.ts` asserts a
 *    read-back per tool, and the `no-restricted-syntax` rule in
 *    `eslint.config.js` fails the build on the pattern rather than relying on
 *    anyone remembering this paragraph.
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
import { ALL_TOOL_DEFS, bindAlias, mutates } from '@motion/ai-tools';
import { EFFECT_DEFS, effectDefFor } from '@core/effects/effects';
import { ANIMATOR_PARAMS } from '@core/text/textAnimators';
import { addTextAnimator, updateAnimator, readAnimatorData } from '@core/text/textAnimators';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { isRiggableKind } from '@core/scene/rigLogo';
import { nextRigIds, usedRigIds } from '@core/rig/rigIds';
import { readNodePuppet } from '@core/rig/puppet';
import { updateDropShadow, updateOuterGlow } from '@core/effects/layerStyles';

import {
  addPathOp, defaultPathOpOf, newPathOpId, readPathOps, readTrimOp,
  ensureTrimOp, updatePathOp, addRepeaterOp, pathOpPropPath, type PathOp,
} from '@core/scene/pathOps';

import { is3DEnabled, set3DEnabled } from '@core/scene/threeD';
import { defaultPolystar, setNodePolystar } from '@core/scene/polystar';
import {
  MATERIAL_PCT_DEFAULTS,
  setNodeAcceptsLights,
  setNodeMaterialPct,
  setNodeShininess,
  setNodeSpecular,
} from '@core/scene/material';
import { rectangleMask, ellipseMask, addMaskPath, type MaskMode } from '@core/effects/mask';
import { refreshAfterLegacy } from './toolContext';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { useAiProviderStore } from '@stores/aiProviderStore';
import { useSelectionStore } from '@stores/selectionStore';
import { insertMedia, insertSvgLayer } from '@core/scene/sceneInsert';
import { convertSvgLayerToShapes } from '@core/svg/svgConvert';
import { analyseAudio } from '@motion/audio';
import { resolveStyle, buildCustomStyle, setRuntimeStyle, type CustomStyleInput } from './design';
import { decodeBase64Bytes } from './decodeBase64';
import { generateImageBytes } from './aiImage';
import { generateVideoBytes, generateSpeechBytes, generate3dBytes } from './aiMedia';
import { exportCompositionVideo } from './aiExport';
import { readAudioAssetId } from './audioForCaster';
import type { AiImageResult, AiMediaResult } from '@app-types/motionEditor';
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
import { setNodeMatte, readMatte } from '@core/effects/matte';
import { setNodeMotionBlur } from '@core/effects/motionBlur';
import { CRAFT_HANDLERS } from './craftHandlers';
import { mapSeq, filterSeq } from './asyncList';
import { engineOr } from './toolContext';
import type { Command } from '@motion/engine-api';

const def = (name: string) => {
  const d = ALL_TOOL_DEFS.find((t) => t.name === name);
  if (!d) throw new Error(`No definition for tool '${name}'`);
  return d;
};

const ok = (content: string, data?: unknown): ToolResult => ({ ok: true, content, data });
const fail = (content: string): ToolResult => ({ ok: false, content });

/** The standard "that id doesn't exist" repair hint. */
const unknownNode = async (ctx: ToolContext, id: string): Promise<string> =>
  `unknown nodeId '${id}' — did you mean: ${(await ctx.scene.nearest(id)).join(', ') || '(no layers exist yet)'}?`;

// ── Read ──────────────────────────────────────────────────────────

const describeScene: AiTool['handler'] = async (input, ctx) => {
  const { subtreeOf, includeTracks, limit } = input as { subtreeOf?: string; includeTracks?: boolean; limit?: number };
  const all = await ctx.scene.all();
  if (subtreeOf && !await ctx.scene.has(subtreeOf)) return fail((await unknownNode(ctx, subtreeOf)));

  let nodes = all;
  if (subtreeOf) {
    const keep = new Set<string>([subtreeOf]);
    // `all` is parents-before-children, so one pass collects the subtree.
    for (const n of all) if (n.parent && keep.has(n.parent)) keep.add(n.id);
    nodes = all.filter((n) => keep.has(n.id));
  }

  const cap = limit ?? 120;
  const shown = nodes.slice(0, cap);
  const comp = await ctx.comp.get();

  const payload = {
    composition: { ...comp, playhead: ctx.comp.playhead() },
    selection: ctx.scene.selection(),
    layerCount: nodes.length,
    layers: await mapSeq(shown, async (n) => ({
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
        ? { tracks: (await ctx.anim.tracks(n.id)).map((t) => ({ prop: t.prop, keys: t.keyframes.map((k) => [k.t, k.value]) })) }
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

const readTracks: AiTool['handler'] = async (input, ctx) => {
  const { nodeId, props } = input as { nodeId: string; props?: string[] };
  if (!await ctx.scene.has(nodeId)) return fail((await unknownNode(ctx, nodeId)));
  let tracks = await ctx.anim.tracks(nodeId);
  if (props?.length) tracks = tracks.filter((t) => props.includes(t.prop));
  if (!tracks.length) return ok(`${nodeId} has no animated properties${props?.length ? ' matching those props' : ''}.`);
  // [t, value] pairs — roughly 4x cheaper in tokens than objects.
  const payload = tracks.map((t) => ({
    prop: t.prop,
    keys: t.keyframes.map((k) => [k.t, k.value, k.easing]),
  }));
  return ok(`Times are composition seconds. [t, value, easing]:\n${JSON.stringify(payload)}`, payload);
};

const evaluateAt: AiTool['handler'] = async (input, ctx) => {
  const { nodeId, t } = input as { nodeId: string; t?: number };
  if (!await ctx.scene.has(nodeId)) return fail((await unknownNode(ctx, nodeId)));
  const compT = t ?? ctx.comp.playhead();
  const animated = await ctx.anim.evaluate(nodeId, compT);
  const node = (await ctx.scene.get(nodeId))!;
  // Fall back to the node's base transform for properties with no track —
  // evaluateNode only reports animated props.
  const payload = {
    t: compT,
    values: { x: node.x, y: node.y, rotation: node.rotation, opacity: node.opacity, ...animated },
  };
  return ok(JSON.stringify(payload), payload);
};

const getSelection: AiTool['handler'] = async (_input, ctx) => {
  const ids = ctx.scene.selection();
  if (!ids.length) return ok('Nothing is selected.', []);
  const payload = await mapSeq(ids, async (id) => {
    const n = await ctx.scene.get(id);
    return { id, name: n?.name ?? id, kind: n?.kind ?? 'unknown' };
  });
  return ok(JSON.stringify(payload), payload);
};

const listCapabilities: AiTool['handler'] = async (input, ctx) => {
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
  if (want('all')) payload.presets = await ctx.anim.listPresets();
  return ok(JSON.stringify(payload), payload);
};

const listPresetsHandler: AiTool['handler'] = async (_input, ctx) => {
  const names = await ctx.anim.listPresets();
  return ok(JSON.stringify(names), names);
};

// ── Write: structure ──────────────────────────────────────────────

const createLayer: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    id?: string; kind: string; name: string; x?: number; y?: number; width?: number; height?: number;
    text?: string; shape?: string; fill?: string; parent?: string;
    points?: number; outerRadius?: number; innerRadius?: number; roundness?: number;
  };
  if (i.parent && !await ctx.scene.has(i.parent)) return fail((await unknownNode(ctx, i.parent)));
  // Accept x-only or y-only (the old code discarded BOTH if either was missing,
  // silently centring the layer). Only when NEITHER is given do we hand the
  // facade `undefined`, which fans the layer out instead of stacking at centre.
  const comp = await ctx.comp.get();
  const at =
    i.x !== undefined || i.y !== undefined
      ? { x: i.x ?? comp.width / 2, y: i.y ?? comp.height / 2 }
      : undefined;
  const id = await ctx.scene.create(i.kind, i.name, at);
  if (!id) return fail(`Could not create a ${i.kind} layer — the insert produced no node.`);
  // Bind the caller's handle BEFORE anything else, so a later call in the same
  // batch can address this layer without a round-trip through the model.
  bindAlias(ctx, i.id, id);
  if (i.text !== undefined) await ctx.scene.setProp(id, 'content', i.text);
  if (i.fill) await ctx.scene.setProp(id, 'fill', i.fill);
  // Polygon / star are PARAMETRIC — the same `fx.polystar` node the UI's
  // Polygon and Star tools create (ports.ts), whose outline `buildSnapshot`
  // recomputes from live parameters every frame. Writing `shapeType: 'polygon'`
  // alone, as this used to, names a primitive the renderer has no SDF for and
  // carries no Geometry either — so it fell through to the rect and drew a
  // square, with no way to say how many sides.
  const polystarType = i.kind === 'shape' && (i.shape === 'polygon' || i.shape === 'star') ? i.shape : null;
  let polystar: ReturnType<typeof defaultPolystar> | null = null;
  if (polystarType) {
    const outer = Math.max(1, i.outerRadius ?? Math.min(i.width ?? 200, i.height ?? 200) / 2);
    // Hexagon / five-point star: what `insertShape` has always drawn for these
    // two names, so an un-parameterised call keeps its familiar look.
    const base = defaultPolystar(polystarType, outer, i.points ?? (polystarType === 'polygon' ? 6 : 5));
    polystar = {
      ...base,
      ...(polystarType === 'star' && i.innerRadius !== undefined
        ? { innerRadius: Math.max(0, i.innerRadius) }
        : {}),
      ...(i.roundness !== undefined
        ? { outerRoundness: i.roundness, innerRoundness: polystarType === 'star' ? i.roundness : 0 }
        : {}),
    };
    await ctx.scene.setProp(id, 'shapeType', 'polystar');
    // B5 gap: the parametric polystar block has no engine command yet.
    ctx.engine.legacy('create_layer polystar (fx.polystar has no engine command)');
    setNodePolystar(id, polystar);
  } else if (i.shape) {
    await ctx.scene.setProp(id, 'shapeType', i.shape);
  }
  if (i.parent) await ctx.scene.reparent(id, i.parent);

  // GPU renderer builds its model matrix from layer.width × layer.scaleX and
  // layer.height × layer.scaleY. Without explicit size the quad is zero-area
  // and invisible on WebGL/WebGPU. Apply safe defaults when the AI omits them.
  const kind = i.kind;
  if (kind === 'solid') {
    await ctx.scene.setProp(id, 'width', i.width ?? comp.width);
    await ctx.scene.setProp(id, 'height', i.height ?? comp.height);
  } else if (polystar) {
    // The box follows the radius — the renderer sizes a polystar's raster from
    // its live outer radius anyway, and the selection outline reads these.
    await ctx.scene.setProp(id, 'width', polystar.outerRadius * 2);
    await ctx.scene.setProp(id, 'height', polystar.outerRadius * 2);
  } else if (kind === 'shape') {
    await ctx.scene.setProp(id, 'width', i.width ?? 200);
    await ctx.scene.setProp(id, 'height', i.height ?? 200);
  } else if (kind === 'text') {
    // Text width drives line-wrapping; height is derived from line count.
    // Default to a wide strip so short text renders in a single line.
    if (i.width !== undefined) await ctx.scene.setProp(id, 'width', i.width);
    else await ctx.scene.setProp(id, 'width', Math.round(comp.width * 0.75));
    if (i.height !== undefined) await ctx.scene.setProp(id, 'height', i.height);
  } else {
    // For all other kinds (null, group, camera, light, etc.) apply only if provided.
    if (i.width !== undefined) await ctx.scene.setProp(id, 'width', i.width);
    if (i.height !== undefined) await ctx.scene.setProp(id, 'height', i.height);
  }

  // Report what the scene ACTUALLY holds, read back — not the request echoed.
  // The special inserters (camera/light/adjustment/particle) name and select
  // their own node, and a reply that repeats `i.name` regardless is how "Created
  // light layer 'My Key Light'" got said about a layer called "Light 1".
  const made = await ctx.scene.get(id);
  const realName = made?.name ?? i.name;
  const renamed = realName !== i.name ? ` (requested '${i.name}' — the engine named it '${realName}')` : '';
  const shapeNote = polystar
    ? ` It is a parametric ${polystar.starType}: ${polystar.points} points, outer radius ${polystar.outerRadius}px` +
      (polystar.starType === 'star' ? `, inner radius ${polystar.innerRadius}px` : '') +
      `. Keyframe 'polystar.points' / 'polystar.outerRadius' / 'polystar.innerRadius' / ` +
      `'polystar.outerRoundness' / 'polystar.rotation' with set_keyframes.`
    : '';
  return ok(
    `Created ${i.kind} layer '${realName}' with id ${id}${renamed}. Use this id in later calls.${shapeNote}`,
    { id, name: realName, ...(polystar ? { polystar } : {}) },
  );
};

const deleteLayer: AiTool['handler'] = async (input, ctx) => {
  const { nodeIds } = input as { nodeIds: string[] };
  const bad: string[] = [];
  let removed = 0;
  for (const id of nodeIds) {
    if (!await ctx.scene.has(id)) { bad.push((await unknownNode(ctx, id))); continue; }
    await ctx.scene.remove(id);
    removed++;
  }
  if (bad.length) return { ok: false, content: `Deleted ${removed}. Failed:\n- ${bad.join('\n- ')}` };
  return ok(`Deleted ${removed} layer(s).`);
};

const reparentLayer: AiTool['handler'] = async (input, ctx) => {
  const { nodeId, parentId } = input as { nodeId: string; parentId?: string | null };
  if (!await ctx.scene.has(nodeId)) return fail((await unknownNode(ctx, nodeId)));
  if (parentId && !await ctx.scene.has(parentId)) return fail((await unknownNode(ctx, parentId)));
  if (parentId === nodeId) return fail('A layer cannot be its own parent.');
  await ctx.scene.reparent(nodeId, parentId ?? null);
  return ok(`Re-parented ${nodeId} to ${parentId ?? 'the top level'}.`);
};

const updateLayer: AiTool['handler'] = async (input, ctx) => {
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
    matte?: { mode: string; inverted?: boolean; sourceId?: string } | string;
    removeMatte?: boolean;
  };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

  const node = defaultSceneGraph.getNode(i.nodeId);
  const applied: string[] = [];

  const sw = (patch: Record<string, unknown>): Command[] => [{ type: 'setLayerSwitches', layers: [i.nodeId], patch } as Command];
  if (i.threeD !== undefined && node) {
    await engineOr(ctx.engine, 'update_layer threeD refused by the engine', sw({ threeD: !!i.threeD }), () => undefined, () => set3DEnabled(i.nodeId, !!i.threeD));
    applied.push(`threeD=${!!i.threeD}`);
  }
  // Material switches. Without these `set_light` was a tool that could not
  // change a pixel from a library-emitted batch: shading is gated on the 3D
  // switch AND `acceptsLights`, the flag defaults to false, and the only writer
  // was the inspector checkbox. A light could be created, positioned and tuned,
  // and nothing in the scene would ever be lit by it.
  // B5 gap: material options (accepts lights, ambient, diffuse, specular,
  // shininess) and track mattes keep their legacy writers.
  const legacyMaterial = i.acceptsLights !== undefined || typeof i.ambient === 'number' || typeof i.diffuse === 'number' ||
    typeof i.specular === 'number' || typeof i.shininess === 'number' || i.removeMatte || i.matte !== undefined;
  if (legacyMaterial && node) ctx.engine.legacy('update_layer material options / track matte');
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
    const name = String(i.name);
    await engineOr(ctx.engine, 'update_layer rename refused by the engine', [{ type: 'renameLayer', layer: i.nodeId, name } as Command], () => undefined, () => { node.name = name; });
    applied.push('name');
  }
  if (i.visible !== undefined && node) {
    await engineOr(ctx.engine, 'update_layer visibility refused by the engine', sw({ visible: !!i.visible }), () => undefined, () => { node.visible = !!i.visible; });
    applied.push('visible');
  }
  if (i.locked !== undefined && node) {
    await engineOr(ctx.engine, 'update_layer lock refused by the engine', sw({ locked: !!i.locked }), () => undefined, () => { node.locked = !!i.locked; });
    applied.push('locked');
  }
  if (i.motionBlur !== undefined && node) {
    await engineOr(ctx.engine, 'update_layer motion blur refused by the engine', sw({ motionBlur: !!i.motionBlur }), () => undefined, () => setNodeMotionBlur(i.nodeId, !!i.motionBlur));
    applied.push(`motionBlur=${!!i.motionBlur}`);
  }
  if (i.blendMode !== undefined && node) {
    await engineOr(ctx.engine, `update_layer blend mode '${i.blendMode}' refused by the engine`, [{ type: 'setBlendMode', layers: [i.nodeId], mode: i.blendMode } as Command], () => undefined, () => setNodeBlend(i.nodeId, i.blendMode as any));
    applied.push(`blendMode=${i.blendMode}`);
  }
  if (i.removeMatte && node) {
    setNodeMatte(i.nodeId, undefined);
    applied.push('removeMatte');
  } else if (i.matte !== undefined && node) {
    // readMatte normalises whatever the model sent: the 1.2.0 {mode,inverted}
    // shape or the legacy four-value spelling. Tolerating both means the tool
    // schema and the prompt do not need a flag day.
    setNodeMatte(i.nodeId, readMatte(i.matte));
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
    'cornerRadius', 'cornerRadiusTL', 'cornerRadiusTR', 'cornerRadiusBR', 'cornerRadiusBL', 'backdropBlur',
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
    if (await ctx.scene.setProp(i.nodeId, map[key] ?? key, i[key])) applied.push(key);
  }

  if (!applied.length) return fail('Nothing to update — pass at least one property besides nodeId.');
  refreshAfterLegacy(ctx);
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

const setKeyframes: AiTool['handler'] = async (input, ctx) => {
  const { keyframes } = input as { keyframes: KeyframeInput[] };
  const bad: string[] = [];
  const touched = new Set<string>();
  let applied = 0;
  /**
   * Where each key of THIS call landed, per track — to catch two keys becoming
   * one.
   *
   * `ctx.time.toLayerTime` rides the renderer's own axis, and that axis is
   * frame-rounded inside a clip (`compToKeyframeTime`): at 30 fps, t=0.00 and
   * t=0.01 are the same stored time. The engine upserts by exact time, so the
   * second key silently REPLACED the first and the call still reported "Set 2
   * keyframes" — a hold-then-jump authored as two keys came out as a constant.
   * The snap is the engine's rule and stays; what changes is that it is said.
   */
  const landed = new Map<string, Map<number, { index: number; t: number }>>();
  const merged: Array<{ nodeId: string; prop: string; kept: number; replaced: number; t: number }> = [];
  const mergeNotes: string[] = [];

  for (const [i, k] of keyframes.entries()) {
    if (!await ctx.scene.has(k.nodeId)) { bad.push(`keyframes[${i}]: ${(await unknownNode(ctx, k.nodeId))}`); continue; }
    if (!isAnimatableProp(k.prop)) {
      bad.push(`keyframes[${i}]: '${k.prop}' is not animatable. Call list_capabilities for the real property paths.`);
      continue;
    }
    /**
     * An `effect.<id>.<param>` track whose effect does not exist is a SILENT
     * no-op, and that is worse than an error.
     *
     * `isAnimatableProp` accepts any `effect.*` path by prefix, so the keyframes
     * are validated, stored, and never sampled — the renderer has no effect with
     * that id to read them into. Two authored techniques shipped exactly this:
     * they invented `effect.<idPrefix>_flash_<i>.radius` because `add_effect`
     * generated its own id and a flat emitter cannot read a return value. The
     * glow they claimed to animate never animated, on every run, for as long as
     * they existed.
     *
     * `isPuppetScalar` already excludes `puppet.<pin>.position` for precisely
     * this reason, and its comment says so. The same care was simply never
     * extended to effects. `add_effect { id }` is the other half of the fix —
     * this makes the mistake loud instead of invisible.
     */
    if (k.prop.startsWith('effect.')) {
      const effectId = k.prop.slice('effect.'.length).split('.')[0]!;
      if (!(await ctx.scene.listEffects(k.nodeId)).some((e) => e.id === effectId)) {
        const have = (await ctx.scene.listEffects(k.nodeId)).map((e) => `${e.id} (${e.type})`).join(', ');
        bad.push(
          `keyframes[${i}]: ${k.nodeId} has no effect '${effectId}', so '${k.prop}' would store ` +
            `keyframes nothing ever reads. ${have ? `It has: ${have}.` : 'It has no effects.'} ` +
            `Call add_effect first — pass its \`id\` if you need to know the name in advance.`,
        );
        continue;
      }
    }
    // A camera is 3D by nature — its z (dolly) needs no 3D switch, and it never
    // renders rotationX/Y (it uses orbitYaw/orbitPitch instead).
    const isCamera = (await ctx.scene.get(k.nodeId))?.kind === 'camera';
    if (
      !isCamera &&
      (THREE_D_PROPS as readonly string[]).includes(k.prop) &&
      !is3DEnabled(defaultSceneGraph.getNode(k.nodeId)!)
    ) {
      bad.push(`keyframes[${i}]: '${k.prop}' needs the 3D switch — call update_layer { nodeId: '${k.nodeId}', threeD: true } first.`);
      continue;
    }

    // Where the engine will store this key (the frame-snapped layer axis) —
    // only to spot two requested times collapsing onto one key. The WRITES
    // below speak composition time; the engine converts the value AND its
    // easing together, which is the bug this design exists to prevent.
    const lt = await ctx.time.toLayerTime(k.nodeId, k.t);
    const trackKey = `${k.nodeId}.${k.prop}`;
    const slots = landed.get(trackKey) ?? new Map<number, { index: number; t: number }>();
    landed.set(trackKey, slots);
    const earlier = slots.get(lt);
    // Same requested time twice is a caller overwriting itself on purpose (or a
    // plain duplicate) — only DIFFERENT times that collapse are worth a warning.
    if (earlier && earlier.t !== k.t) {
      merged.push({ nodeId: k.nodeId, prop: k.prop, kept: i, replaced: earlier.index, t: lt });
      mergeNotes.push(
        `keyframes[${earlier.index}] (t=${earlier.t}s) and keyframes[${i}] (t=${k.t}s) on ${trackKey} ` +
          `landed on the same frame — only keyframes[${i}]'s value (${k.value}) survives`,
      );
    }
    slots.set(lt, { index: i, t: k.t });
    await ctx.anim.setKeyframe(k.nodeId, k.prop, k.t, k.value, k.easing ?? 'linear');
    if (k.easing === 'bezier' && k.bezier) {
      await ctx.anim.setBezier(k.nodeId, k.prop, k.t, k.bezier);
    }
    touched.add(trackKey);
    applied++;
  }

  // A single keyframe on a property holds a constant — usually a mistake worth
  // naming, since the model thinks it animated something.
  const singles = await filterSeq([...touched], async (key) => {
    const [nodeId, ...rest] = key.split('.');
    const prop = rest.join('.');
    return ((await ctx.anim.tracks(nodeId!)).find((t) => t.prop === prop)?.keyframes.length ?? 0) < 2;
  });
  const warn = singles.length
    ? `\nNote: ${singles.join(', ')} now has only ONE keyframe, so it holds a constant. Add a second at a different time to make it move.`
    : '';

  const fps = (await ctx.comp.get()).fps || 30;
  const mergeWarn = mergeNotes.length
    ? `\nWARNING: keyframe times snap to the frame grid (one frame = ${(1 / fps).toFixed(4)}s at ` +
      `${fps} fps), so ${mergeNotes.length} key(s) MERGED:\n- ${mergeNotes.join('\n- ')}` +
      `\nSpace keys at least one frame apart — for an instant jump, put the two values on consecutive ` +
      `frames and give the first one easing "hold".`
    : '';
  // Distinct stored keys — what the caller will actually find on the timeline.
  const stored = applied - merged.length;

  if (bad.length) {
    return {
      ok: false,
      content: `Applied ${applied} of ${keyframes.length} keyframes. Rejected:\n- ${bad.join('\n- ')}${warn}${mergeWarn}`,
      ...(merged.length ? { data: { merged } } : {}),
    };
  }
  return ok(
    `Set ${stored} keyframes across ${touched.size} propert${touched.size === 1 ? 'y' : 'ies'}.${warn}${mergeWarn}`,
    merged.length ? { merged } : undefined,
  );
};

const removeKeyframes: AiTool['handler'] = async (input, ctx) => {
  const { targets } = input as { targets: { nodeId: string; prop: string; t?: number }[] };
  const bad: string[] = [];
  let n = 0;
  for (const [i, tg] of targets.entries()) {
    if (!await ctx.scene.has(tg.nodeId)) { bad.push(`targets[${i}]: ${(await unknownNode(ctx, tg.nodeId))}`); continue; }
    if (tg.t === undefined) {
      const track = (await ctx.anim.tracks(tg.nodeId)).find((t) => t.prop === tg.prop);
      if (!track) { bad.push(`targets[${i}]: ${tg.nodeId} has no '${tg.prop}' track.`); continue; }
      for (const k of [...track.keyframes]) await ctx.anim.removeKeyframe(tg.nodeId, tg.prop, k.t);
      n += track.keyframes.length;
    } else {
      await ctx.anim.removeKeyframe(tg.nodeId, tg.prop, tg.t);
      n++;
    }
  }
  if (bad.length) return { ok: false, content: `Removed ${n}. Failed:\n- ${bad.join('\n- ')}` };
  return ok(`Removed ${n} keyframe(s).`);
};

const setEasing: AiTool['handler'] = async (input, ctx) => {
  const { targets } = input as { targets: { nodeId: string; prop: string; t: number; easing?: string; bezier?: number[]; roving?: boolean }[] };
  const bad: string[] = [];
  let n = 0;
  for (const [i, tg] of targets.entries()) {
    if (!await ctx.scene.has(tg.nodeId)) { bad.push(`targets[${i}]: ${(await unknownNode(ctx, tg.nodeId))}`); continue; }
    // The key the engine will address: the requested time, snapped the way
    // the engine snaps it (tracks report composition seconds).
    const at = await ctx.time.toCompTime(tg.nodeId, await ctx.time.toLayerTime(tg.nodeId, tg.t));
    const track = (await ctx.anim.tracks(tg.nodeId)).find((t) => t.prop === tg.prop);
    const exists = track?.keyframes.some((k) => Math.abs(k.t - at) < 1e-4);
    if (!exists) {
      // Naming the times that DO exist saves a guess-and-retry round trip.
      const times = track?.keyframes.map((k) => k.t).join(', ') ?? 'none';
      bad.push(`targets[${i}]: no '${tg.prop}' keyframe at t=${tg.t} on ${tg.nodeId}. Existing times: ${times}.`);
      continue;
    }
    if (tg.easing) await ctx.anim.setEasing(tg.nodeId, tg.prop, tg.t, tg.easing);
    if (tg.easing === 'bezier' && tg.bezier) await ctx.anim.setBezier(tg.nodeId, tg.prop, tg.t, tg.bezier);
    if (tg.roving !== undefined) await ctx.anim.setRoving(tg.nodeId, tg.prop, tg.t, tg.roving);
    n++;
  }
  if (bad.length) return { ok: false, content: `Updated ${n}. Failed:\n- ${bad.join('\n- ')}` };
  return ok(`Updated easing on ${n} keyframe(s).`);
};

const setExpression: AiTool['handler'] = async (input, ctx) => {
  const { nodeId, prop, expression } = input as { nodeId: string; prop: string; expression: string };
  if (!await ctx.scene.has(nodeId)) return fail((await unknownNode(ctx, nodeId)));
  if (!isAnimatableProp(prop)) return fail(`'${prop}' is not animatable. Call list_capabilities.`);
  await ctx.anim.setExpression(nodeId, prop, expression);
  if (!expression.trim()) return ok(`Removed the expression on ${nodeId}.${prop}.`);
  // Compile errors are reported here rather than discovered at render time.
  const err = await ctx.anim.getExpressionError(nodeId, prop);
  if (err) {
    await ctx.anim.setExpression(nodeId, prop, '');
    return fail(`Expression rejected and not applied: ${err}. It must be a single expression returning a number — no 'return', no statements.`);
  }
  // Presence stopped being the same question as enablement. `setExpression`
  // preserves a disabled expression's state, so writing a formula onto a
  // property the user switched off does NOT make it drive the value — and
  // claiming otherwise sends the model hunting a rendering bug that is not there.
  if (!await ctx.anim.isExpressionEnabled(nodeId, prop)) {
    return ok(
      `Applied expression to ${nodeId}.${prop}, but the expression on that property is ` +
        `DISABLED, so its keyframed or static value still applies. It can be re-enabled ` +
        `from the expression editor.`,
    );
  }
  return ok(`Applied expression to ${nodeId}.${prop}. It now overrides any keyframed value.`);
};

// ── Write: effects + text ─────────────────────────────────────────

const addEffectHandler: AiTool['handler'] = async (input, ctx) => {
  const { nodeId, type, amount, id: wantedId } = input as {
    nodeId: string; type: string; amount?: number; id?: string;
  };
  if (!await ctx.scene.has(nodeId)) return fail((await unknownNode(ctx, nodeId)));
  const id = await ctx.scene.addEffect(nodeId, type, wantedId);
  if (!id) return fail(`Could not add '${type}' to ${nodeId}.`);
  if (amount !== undefined) await ctx.scene.updateEffect(nodeId, id, amount);
  // `effectDefFor`, not a scan of the built-in array: `ctx.scene.addEffect`
  // resolves plugin effects too, so a scan here would report an effect it had
  // just successfully added as having no parameters — and the model would then
  // have no key to keyframe.
  const d = effectDefFor(type);
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

const updateEffectHandler: AiTool['handler'] = async (input, ctx) => {
  const { nodeId, effectId, amount, remove } = input as { nodeId: string; effectId: string; amount?: number; remove?: boolean };
  if (!await ctx.scene.has(nodeId)) return fail((await unknownNode(ctx, nodeId)));
  if (remove) {
    await ctx.scene.removeEffect(nodeId, effectId);
    return ok(`Removed effect ${effectId} from ${nodeId}.`);
  }
  if (amount === undefined) return fail('Pass amount, or remove: true.');
  await ctx.scene.updateEffect(nodeId, effectId, amount);
  return ok(`Set effect ${effectId} to ${amount}.`);
};

const textAnimator: AiTool['handler'] = async (input, ctx) => {
  const i = input as Record<string, unknown> & { nodeId: string; index?: number; remove?: boolean };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));
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
    const a = sweep.fromSec; // composition seconds — the engine converts
    const b = sweep.toSec;
    const easing = sweep.easing ?? 'bezier';
    await ctx.anim.setKeyframe(i.nodeId, prop, a, sweep.fromOffset ?? -100, easing);
    await ctx.anim.setKeyframe(i.nodeId, prop, b, sweep.toOffset ?? 100, 'linear');
    if (easing === 'bezier') {
      // A default that is not linear: a linear selector sweep gives every
      // character exactly the same timing, which is the flat machine-gun type-on.
      await ctx.anim.setBezier(i.nodeId, prop, a, (sweep.bezier as [number, number, number, number]) ?? [0.22, 0.61, 0.36, 1]);
    }
    swept = ` Selector sweeps ${sweep.fromOffset ?? -100}% → ${sweep.toOffset ?? 100}% between ${sweep.fromSec}s and ${sweep.toSec}s.`;
  }

  refreshAfterLegacy(ctx);
  return ok(
    `Text animator ${index} on ${i.nodeId} is ready.${swept}` +
    (sweep ? '' : ` It has a STATIC selector, so it currently applies a constant style rather than an animation — pass \`sweep\`, or keyframe "ta.${index}.offset".`),
    { index },
  );
};

// ── Media ─────────────────────────────────────────────────────────

const listAssets: AiTool['handler'] = async () => {
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
  refreshAfterLegacy(ctx);
  return ok(`Added ${asset.type} layer "${asset.name}" with id '${id}'. Animate it like any other layer.`, { id });
};


/**
 * Generate an image and place it as a layer.
 *
 * Three things this must get right, all of them learned from the surrounding
 * code rather than invented here:
 *
 *  • **The key never comes near this process.** The request carries a provider
 *    id and a prompt; the gateway (motion-back) or the desktop shell
 *    (`ai:image` IPC) holds the key and makes the call. Same boundary as
 *    `/ai/stream` / `ai:stream`.
 *  • **The result becomes a real asset.** Bytes go through `addAsset`, so the
 *    image lands in the user's library, survives a reload, saves with the
 *    project, and can be reused — rather than living as a blob URL that dies
 *    with the tab.
 *  • **Failures are reported, never swallowed.** An image that did not arrive
 *    has to say why, because it costs the user money and several seconds.
 */
const generateImage: AiTool['handler'] = async (input, ctx) => {
  const { id: alias, prompt, aspect, x, y } = input as {
    id?: string; prompt: string; aspect?: string; x?: number; y?: number;
  };

  const comp = await ctx.comp.get();
  // Aspect is advisory — the gateway / shell maps it onto a size the provider accepts.
  // Sending the comp's own dimensions lets a square comp get a square image
  // without the model having to reason about it.
  const dims =
    aspect === 'square' ? { width: 1024, height: 1024 }
    : aspect === 'portrait' ? { width: 1024, height: 1536 }
    : aspect === 'landscape' ? { width: 1536, height: 1024 }
    : { width: comp.width, height: comp.height };

  const provider = useAiProviderStore.getState().provider;

  let res: AiImageResult;
  try {
    res = await generateImageBytes({ provider, prompt, ...dims });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      `Image generation failed: ${message}. The scene is unchanged and no layer was added. ` +
      `Carry on with the rest of the piece rather than retrying — a second attempt costs again.`,
    );
  }
  if (!res.ok) {
    return fail(`Image generation failed: ${res.message}. The scene is unchanged.`);
  }

  // base64 → File. Tagged `source: 'ai'` so it uploads to the cloud (small,
  // generated, worth syncing) rather than taking the local-disk path that user
  // library imports now use.
  const bytes = decodeBase64Bytes(res.base64);
  const ext = res.mime === 'image/jpeg' ? 'jpg' : 'png';
  const name = `${prompt.slice(0, 40).replace(/[^\w -]/g, '').trim() || 'generated'}.${ext}`;
  const file = new File([bytes as BlobPart], name, { type: res.mime });

  const asset = await useAssetStore.getState().addAsset(file, null, { source: 'ai' });
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
  refreshAfterLegacy(ctx);
  // No credits any more — image generation runs on the user's own key and their
  // provider bills them directly, so there is nothing of ours to report.
  return ok(
    `Generated an image and placed it as layer '${id}'.` +
      ` It is in the asset library as "${name}" — reuse it rather than generating again.`,
    { id, assetId: asset.id },
  );
};

async function bytesToAsset(
  res: AiMediaResult,
  name: string,
  mimeOverride?: string,
): Promise<{ ok: true; asset: ImportedAsset } | { ok: false; message: string }> {
  if (!res.ok) return { ok: false, message: res.message };
  const mime = mimeOverride ?? res.mime;
  const bytes = decodeBase64Bytes(res.base64);
  const file = new File([bytes as BlobPart], name, { type: mime });
  const asset = await useAssetStore.getState().addAsset(file, null, { source: 'ai' });
  return { ok: true, asset };
}

const generateVideo: AiTool['handler'] = async (input, ctx) => {
  const { id: alias, prompt, durationSec, x, y } = input as {
    id?: string; prompt: string; durationSec?: number; x?: number; y?: number;
  };
  let res: AiMediaResult;
  try {
    res = await generateVideoBytes({ prompt, durationSec });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Video generation failed: ${message}. The scene is unchanged.`);
  }
  if (!res.ok) return fail(`Video generation failed: ${res.message}. The scene is unchanged.`);

  const name = `${prompt.slice(0, 36).replace(/[^\w -]/g, '').trim() || 'generated'}.${res.extension}`;
  const placed = await bytesToAsset(res, name, 'video/mp4');
  if (!placed.ok) return fail(placed.message);

  await insertMedia(placed.asset);
  const nodeId = ctx.scene.selection()[0] ?? useSelectionStore.getState().ids[0];
  if (!nodeId) return fail(`Generated "${name}" but could not resolve the new layer id.`);
  bindAlias(ctx, alias, nodeId);
  if (x !== undefined || y !== undefined) {
    const node = defaultSceneGraph.getNode(nodeId);
    const t = node?.components.find((c) => c.type === 'Transform');
    if (t) {
      if (x !== undefined) defaultSceneGraph.writeProp(nodeId, t.id, 'x', x);
      if (y !== undefined) defaultSceneGraph.writeProp(nodeId, t.id, 'y', y);
    }
  }
  refreshAfterLegacy(ctx);
  return ok(`Generated a video clip and placed it as layer '${nodeId}'. Asset "${name}" is in the library.`, { id: nodeId });
};

const generateSpeech: AiTool['handler'] = async (input, ctx) => {
  const { text, voiceId } = input as { text: string; voiceId?: string };
  let res: AiMediaResult;
  try {
    res = await generateSpeechBytes({ text, voiceId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Speech generation failed: ${message}.`);
  }
  if (!res.ok) return fail(`Speech generation failed: ${res.message}.`);

  const name = `voiceover.${res.extension}`;
  const placed = await bytesToAsset(res, name, 'audio/mpeg');
  if (!placed.ok) return fail(placed.message);

  await insertMedia(placed.asset);
  const nodeId = ctx.scene.selection()[0] ?? useSelectionStore.getState().ids[0];
  refreshAfterLegacy(ctx);
  return ok(
    nodeId
      ? `Generated voice-over and added audio layer '${nodeId}'.`
      : `Generated voice-over and added it to the library as "${name}".`,
    { id: nodeId },
  );
};

const generate3dModel: AiTool['handler'] = async (input, ctx) => {
  const { prompt, name: assetName } = input as { prompt: string; name?: string };
  let res: AiMediaResult;
  try {
    res = await generate3dBytes({ prompt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`3D generation failed: ${message}.`);
  }
  if (!res.ok) return fail(`3D generation failed: ${res.message}.`);

  const label = assetName?.trim()
    || `${prompt.slice(0, 36).replace(/[^\w -]/g, '').trim() || 'model'}.${res.extension}`;
  const placed = await bytesToAsset(res, label, res.mime);
  if (!placed.ok) return fail(placed.message);

  // Place a 3D null as a scene placeholder — the compositor does not yet draw
  // glTF meshes, but the asset is in the library and the layer anchors it.
  const comp = await ctx.comp.get();
  const nodeId = await ctx.scene.create('null', label.replace(/\.(glb|gltf)$/i, '') || '3D Model', {
    x: comp.width / 2,
    y: comp.height / 2,
  });
  set3DEnabled(nodeId, true);
  const node = defaultSceneGraph.getNode(nodeId);
  const t = node?.components.find((c) => c.type === 'Transform');
  if (t) {
    defaultSceneGraph.writeProp(nodeId, t.id, 'assetId', placed.asset.id);
  }
  refreshAfterLegacy(ctx);

  return ok(
    `Generated a 3D model (asset ${placed.asset.id}) and placed null layer '${nodeId}' in 3D space. ` +
    'The GLB is in the library; mesh draw of glTF is not in the compositor yet — the null marks its place.',
    { id: nodeId, assetId: placed.asset.id },
  );
};

const exportVideoTool: AiTool['handler'] = async (input, ctx) => {
  const { format, quality, useWorkArea, mode } = input as {
    format?: 'mp4' | 'webm' | 'gif';
    quality?: 'high' | 'medium' | 'draft';
    useWorkArea?: boolean;
    mode?: 'queue' | 'immediate';
  };
  const result = await exportCompositionVideo({
    format,
    quality,
    useWorkArea,
    mode: mode ?? 'queue',
    signal: ctx.signal,
  });
  if (!result.ok) {
    return fail(`Export failed: ${result.message}. The composition is unchanged.`);
  }
  if (result.mode === 'queue') {
    return ok(
      `Queued ${format ?? 'mp4'} export as job '${result.jobId}' in the Render Queue` +
      (result.started ? ' and started rendering.' : '. Open Render Queue to choose an output folder and Start.'),
      { jobId: result.jobId },
    );
  }
  return ok(
    `Exported the composition as ${format ?? 'mp4'}${result.videoCodec ? ` (${result.videoCodec})` : ''}.`,
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
  refreshAfterLegacy(ctx);
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
    // A reference image the user attached to the AI prompt: small (already
    // re-encoded JPEG) and part of an AI flow, so it uploads to the cloud rather
    // than the local-disk path user library imports take.
    asset = await useAssetStore.getState().addAsset(file, null, { source: 'ai' });
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
  refreshAfterLegacy(ctx);
  return ok(`Added attachment image layer "${asset.name}" with id '${id}'. Animate it like any other layer.`, { id });
};

// ── Write: masks ──────────────────────────────────────────────────

const createMask: AiTool['handler'] = async (input, ctx) => {
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
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

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
  refreshAfterLegacy(ctx);
  return ok(
    `Added a ${i.shape} mask (${Math.round(w)}×${Math.round(h)}, mode ${path.mode}) to ${i.nodeId} ` +
      `with maskId '${path.id}'. It clips the layer to the ${path.inverted ? 'outside' : 'inside'} of the shape.`,
    { maskId: path.id },
  );
};

// ── Write: comp + presets ─────────────────────────────────────────

const updateComposition: AiTool['handler'] = async (input, ctx) => {
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
  // The composition store and the timeline's time domain must agree, or layer
  // clips keep the OLD length and everything past the old end gets culled.
  // `setCompositionSettings` updates both; the facade's legacy path mirrors
  // duration/fps into the TimelineController as the Settings dialog does.
  await ctx.comp.update(patch as never);
  const note = blocked.length ? ' (ignored width/height — size is locked)' : '';
  return ok(`Composition updated${note}: ${JSON.stringify(await ctx.comp.get())}`);
};

const applyPreset: AiTool['handler'] = async (input, ctx) => {
  const { nodeId, preset, atTime } = input as { nodeId: string; preset: string; atTime?: number };
  if (!await ctx.scene.has(nodeId)) return fail((await unknownNode(ctx, nodeId)));
  const t = atTime ?? 0;
  const applied = await ctx.anim.applyPreset(nodeId, preset, t);
  if (!applied) {
    return fail(`No preset named '${preset}'. Available: ${(await ctx.anim.listPresets()).join(', ')}`);
  }
  return ok(`Applied '${preset}' to ${nodeId} at ${t}s.`);
};

// ── High-level composition (Tool Intelligence) ────────────────────

const addBackground: AiTool['handler'] = async (input, ctx) => {
  const i = input as { style?: string; color?: string };
  const id = await recipeBackground(ctx, resolveStyle(i.style), i.color);
  refreshAfterLegacy(ctx);
  return ok(`Added a full-comp background (id ${id}).`, { id });
};

const addTitle: AiTool['handler'] = async (input, ctx) => {
  const i = input as { text: string; level?: 'title' | 'subtitle' | 'tagline'; style?: string; y?: number; scene?: number; entrance?: EntranceArchetype };
  if (typeof i.scene === 'number') selectScene(i.scene);
  const id = await recipeText(ctx, resolveStyle(i.style), { text: i.text, level: i.level ?? 'title', y: i.y, entrance: i.entrance });
  refreshAfterLegacy(ctx);
  return ok(`Added ${i.level ?? 'title'} "${i.text}" (id ${id}), positioned and animated in.`, { id });
};

const addEmblem: AiTool['handler'] = async (input, ctx) => {
  const i = input as { style?: string; y?: number; size?: number; scene?: number; entrance?: EntranceArchetype };
  if (typeof i.scene === 'number') selectScene(i.scene);
  const id = await recipeEmblem(ctx, resolveStyle(i.style), { y: i.y, size: i.size, entrance: i.entrance });
  refreshAfterLegacy(ctx);
  return ok(`Added a glowing emblem (id ${id}) with an animated entrance and pulse.`, { id });
};

const addCards: AiTool['handler'] = async (input, ctx) => {
  const i = input as { count?: number; style?: string; y?: number; scene?: number; entrance?: EntranceArchetype };
  if (typeof i.scene === 'number') selectScene(i.scene);
  const ids = await recipeCards(ctx, resolveStyle(i.style), { count: i.count, y: i.y, entrance: i.entrance });
  refreshAfterLegacy(ctx);
  return ok(`Added a row of ${ids.length} card(s), staggered in. Ids: ${ids.join(', ')}.`, { ids });
};

const staggerIn: AiTool['handler'] = async (input, ctx) => {
  const i = input as { nodeIds: string[]; style?: string; entrance?: EntranceArchetype };
  const bad = await filterSeq(i.nodeIds, async (n) => !(await ctx.scene.has(n)));
  const applied = await recipeStaggerIn(ctx, resolveStyle(i.style), i.nodeIds, i.entrance);
  refreshAfterLegacy(ctx);
  if (bad.length) return { ok: applied > 0, content: `Staggered ${applied} layer(s). Unknown ids: ${bad.join(', ')}.` };
  return ok(`Gave ${applied} layer(s) a staggered entrance.`);
};

const defineStyle: AiTool['handler'] = async (input) => {
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

const addCameraMove: AiTool['handler'] = async (input, ctx) => {
  const i = input as { kind?: 'push_in' | 'pull_out'; style?: string; durationSec?: number };
  const move = await recipeCameraMove(ctx, { kind: i.kind, durationSec: i.durationSec });
  refreshAfterLegacy(ctx);
  // The camera is named on its own, not counted: it is what moves, not one of
  // the layers the move is across. The old `targets.length + 1` told the model
  // it had one more content layer than it made — and hid that a camera layer
  // was created at all, which the next call needs to know to animate it.
  return ok(
    `Added a slow ${i.kind ?? 'push_in'} across ${move.layers} layer(s) (now 3D), driven by ` +
      `${move.createdCamera ? 'a new' : 'the existing'} 3D camera (id ${move.cameraId}).`,
    { cameraId: move.cameraId },
  );
};

const addKineticTitle: AiTool['handler'] = async (input, ctx) => {
  const i = input as { text: string; style?: string; y?: number; fontSize?: number; scene?: number };
  if (typeof i.scene === 'number') selectScene(i.scene);
  const ids = await recipeKineticText(ctx, resolveStyle(i.style), { text: i.text, y: i.y, fontSize: i.fontSize });
  refreshAfterLegacy(ctx);
  if (!ids.length) return fail('The phrase had no words to animate.');
  return ok(`Added kinetic typography: ${ids.length} word(s) popping in on the beat. Ids: ${ids.join(', ')}.`, { ids });
};

const addLightSweep: AiTool['handler'] = async (input, ctx) => {
  const i = input as { style?: string; at?: number };
  const id = await recipeLightSweep(ctx, resolveStyle(i.style), { at: i.at });
  refreshAfterLegacy(ctx);
  return ok(`Added a light sweep (id ${id}) passing across the frame.`, { id });
};

const addAmbientOrbs: AiTool['handler'] = async (input, ctx) => {
  const i = input as { count?: number; style?: string };
  const ids = await recipeFloatingOrbs(ctx, resolveStyle(i.style), { count: i.count });
  refreshAfterLegacy(ctx);
  return ok(`Added ${ids.length} ambient orb(s) drifting at background depth. Ids: ${ids.join(', ')}.`, { ids });
};

const addLowerThird: AiTool['handler'] = async (input, ctx) => {
  const i = input as { title: string; subtitle?: string; style?: string; scene?: number };
  if (typeof i.scene === 'number') selectScene(i.scene);
  const ids = await recipeLowerThird(ctx, resolveStyle(i.style), { title: i.title, subtitle: i.subtitle });
  refreshAfterLegacy(ctx);
  return ok(`Added a lower third ("${i.title}"). Ids: ${ids.join(', ')}.`, { ids });
};

const addScene: AiTool['handler'] = async (input, ctx) => {
  const i = input as { index: number; startSec: number; durationSec: number; background?: string; transition?: 'dissolve' | 'cut'; style?: string };
  const id = await recipeScene(ctx, resolveStyle(i.style), {
    index: i.index,
    startSec: i.startSec,
    durationSec: i.durationSec,
    background: i.background,
    transition: i.transition,
  });
  refreshAfterLegacy(ctx);
  return ok(
    `Opened scene ${i.index} at ${i.startSec}s for ${i.durationSec}s (bg id ${id}). ` +
      `Content added now enters at ${i.startSec}s and exits at its end.`,
    { id },
  );
};

const addTransition: AiTool['handler'] = async (input, ctx) => {
  const i = input as { atSec: number; kind?: 'fade_black' | 'flash'; durationSec?: number };
  const id = await recipeTransition(ctx, { atSec: i.atSec, kind: i.kind, durationSec: i.durationSec });
  refreshAfterLegacy(ctx);
  return ok(`Added a ${i.kind ?? 'fade_black'} transition at ${i.atSec}s (id ${id}).`, { id });
};

interface CreatePuppetRigInput {
  layerId: string;
  pins: {
    name: string; x: number; y: number;
    rotation?: number; stiffness?: number; scale?: number; overlap?: number;
  }[];
}

const createPuppetRig: AiTool['handler'] = async (input, ctx) => {
  const i = input as CreatePuppetRigInput;
  if (!await ctx.scene.has(i.layerId)) {
    const near = (await ctx.scene.nearest(i.layerId)).join(', ');
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
  await ctx.scene.setPuppet(i.layerId, { pins: pinsList });
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

const setPuppetPinKeyframes: AiTool['handler'] = async (input, ctx) => {
  const i = input as SetPuppetPinKeyframesInput;
  if (!await ctx.scene.has(i.layerId)) {
    const near = (await ctx.scene.nearest(i.layerId)).join(', ');
    return { ok: false, content: `Layer id '${i.layerId}' not found. Did you mean: ${near || 'none'}?` };
  }
  const rig = await ctx.scene.readPuppet(i.layerId);
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
    const lt = k.timeSec; // composition seconds — the engine converts
    await ctx.anim.setPointsKeyframe(i.layerId, prop, lt, [{ x: k.x, y: k.y }]);
  }
  return {
    ok: true,
    content:
      `Set ${i.keyframes.length} position keyframe(s) on pin '${i.pinId}' of layer '${i.layerId}'. ` +
      `The pin now animates along ${prop}.`,
    data: { layerId: i.layerId, pinId: i.pinId, keyframes: i.keyframes.length },
  };
};

import { liveMergeSelectedPaths, type MergeOp } from '@core/scene/mergePaths';

const mergePathsHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as { op: MergeOp; nodeIds: string[] };
  const missing = await filterSeq(i.nodeIds, async (id) => !(await ctx.scene.has(id)));
  if (missing.length > 0) return fail(`Unknown nodeId(s): ${missing.join(', ')}`);
  useSelectionStore.getState().set(i.nodeIds);
  // Live merge keeps sources animatable — the designed-motion default.
  const resultIds = liveMergeSelectedPaths(i.op);
  if (resultIds.length === 0) return fail(`Failed to apply merge operation '${i.op}' on layers.`);
  return ok(`Applied live merge '${i.op}'. Result: ${resultIds.join(', ')}. Sources stay editable.`, { resultIds });
};

/** Patch (creating if absent) a node's trim entry; returns its op id. */
function applyTrim(nodeId: string, i: { start?: number; end?: number; offset?: number }): string {
  const patch: Partial<PathOp> = {};
  if (i.start !== undefined) patch.start = i.start;
  if (i.end !== undefined) patch.end = i.end;
  if (i.offset !== undefined) patch.offset = i.offset;
  const opId = ensureTrimOp(nodeId);
  updatePathOp(nodeId, opId, patch);
  return opId;
}

/**
 * Kinds that never reach the shape path pipeline.
 *
 * Path operators are applied in ONE place — `buildSnapshot`'s shape branch,
 * which seeds the chain from the layer's outline. Every kind below renders some
 * other way (an SVG layer is its stored document rasterized to a texture, like
 * an image; text is glyph runs; the rest draw nothing of their own), so an
 * `fx.pathOps` entry on one of them is stored, keyframeable, visible in the
 * timeline — and read by nothing. `set_trim_path` on an SVG ring reported
 * success and the ring stayed fully drawn, which is the silent no-op this whole
 * file exists to prevent. A deny-list rather than `kind === 'shape'` because
 * shape-rendered kinds are open-ended (solids, plugin kinds fall back to shape).
 */
const NO_PATH_PIPELINE = new Set(['svg', 'image', 'video', 'text', 'audio', 'camera', 'light', 'null', 'group', 'comp']);

/** Every shape-pipeline layer under `rootId` (inclusive), in stack order. */
async function shapeDescendants(ctx: ToolContext, rootId: string): Promise<string[]> {
  const all = await ctx.scene.all();
  const keep = new Set<string>([rootId]);
  // `all` is parents-before-children, so one pass collects the subtree.
  for (const n of all) if (n.parent && keep.has(n.parent)) keep.add(n.id);
  return all.filter((n) => keep.has(n.id) && !NO_PATH_PIPELINE.has(n.kind)).map((n) => n.id);
}

const setTrimPathHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as { nodeId: string; start?: number; end?: number; offset?: number; convertSvg?: boolean };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));
  if (i.start === undefined && i.end === undefined && i.offset === undefined) {
    return fail(`Nothing to set — give at least one of start, end or offset (percentages, 0..100).`);
  }

  const kind = (await ctx.scene.get(i.nodeId))?.kind ?? 'shape';
  if (kind === 'svg') {
    if (!i.convertSvg) {
      return fail(
        `'${i.nodeId}' is an SVG layer: it renders as its document rasterized to a texture, so it has no ` +
          `path for Trim to cut and the trim would change nothing. Call set_trim_path again with ` +
          `convertSvg: true to convert it into editable shape layers first (one per SVG path — masks and ` +
          `filters are flattened, and the layer's id CHANGES to a group id that the reply returns), ` +
          `or build the stroke as a shape layer with create_layer instead.`,
      );
    }
    // The user's own Inspector ▸ "Convert to editable shapes", not a second
    // parser: same geometry, same carried transform, same Revert.
    const groupId = convertSvgLayerToShapes(i.nodeId);
    if (!groupId) {
      return fail(
        `'${i.nodeId}' has no vector paths to convert (an SVG that only embeds a bitmap, for instance) — ` +
          `it stays an SVG layer and cannot be trimmed.`,
      );
    }
    // Handles bound to the SVG layer would now point at a deleted node.
    for (const [handle, real] of ctx.aliases) if (real === i.nodeId) ctx.aliases.set(handle, groupId);
    const shapeIds = await shapeDescendants(ctx, groupId);
    if (!shapeIds.length) return fail(`Converted '${i.nodeId}' to group '${groupId}', but it holds no shape layers to trim.`);
    const trims = shapeIds.map((id) => ({ nodeId: id, opId: applyTrim(id, i) }));
    return ok(
      `Converted SVG layer '${i.nodeId}' into group '${groupId}' (${shapeIds.length} shape layer(s)) and set ` +
        `trim on each: start ${i.start ?? 0}%, end ${i.end ?? 100}%, offset ${i.offset ?? 0}%. '${i.nodeId}' no longer ` +
        `exists — use '${groupId}' for the whole mark. Each shape has its OWN trim track: keyframe ` +
        `${trims.slice(0, 3).map((t) => `'${pathOpPropPath(t.opId, 'end')}' on ${t.nodeId}`).join(', ')}` +
        `${trims.length > 3 ? ', … (all listed in data.trims)' : ''} from 0 to 100 for the draw-on.`,
      { groupId, trims },
    );
  }
  if (NO_PATH_PIPELINE.has(kind)) {
    return fail(
      `'${i.nodeId}' is a ${kind} layer, and Trim Paths only cuts SHAPE layers — on a ${kind} it would store a ` +
        `track nothing renders. ` +
        (kind === 'group'
          ? `Trim the shape layers inside the group one by one.`
          : `Draw the path as a shape layer (create_layer kind:"shape") and trim that.`),
    );
  }
  // A PATCH, so naming one field is an edit rather than a reset. Trim is an
  // entry in the `fx.pathOps` chain since document version 1.4.0 — the same
  // ordered stack the deformers live in — so this creates the entry if the
  // layer has none and then patches it by id.
  const opId = applyTrim(i.nodeId, i);
  const t = readTrimOp(defaultSceneGraph.getNode(i.nodeId)!);
  return ok(
    `Trim path on '${i.nodeId}' is now start ${t?.start ?? 0}%, end ${t?.end ?? 100}%, offset ${t?.offset ?? 0}%. ` +
      `Keyframe '${pathOpPropPath(opId, 'end')}' from 0 to 100 for a stroke draw-on. ` +
      `Trim CUTS the path, so a filled shape's fill follows it.`,
    { nodeId: i.nodeId, opId },
  );
};

/**
 * Per-copy opacity is a MULTIPLIER, not a pair of endpoints.
 *
 * The tool takes the first and last copy's opacity because that is how a person
 * describes a fading array; the engine takes the ratio between one copy and the
 * next. Deriving it here is the whole reason this is a translation layer:
 * `endOpacity` used to be passed through under its own name and dropped.
 */
function perCopyOpacity(copies: number, startPct: number, endPct: number): number {
  if (copies <= 1 || startPct <= 0) return 1;
  const ratio = Math.max(0, Math.min(100, endPct)) / Math.max(1, startPct);
  return ratio ** (1 / (copies - 1));
}

const addRepeaterHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    nodeId: string;
    copies?: number;
    positionX?: number;
    positionY?: number;
    rotation?: number;
    scale?: number;
    anchorX?: number;
    anchorY?: number;
    startOpacity?: number;
    endOpacity?: number;
    opId?: string;
  };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

  const chain = readPathOps(defaultSceneGraph.getNode(i.nodeId)!);
  const repeaters = chain.filter((o) => o.type === 'repeater');

  /**
   * UPDATE — only when the caller names the operator.
   *
   * This used to be the ONLY behaviour: every call went through
   * `updateRepeaterOp`, which patches "the node's repeater", so a second call
   * returned the first call's op id and overwrote it. After Effects stacks N
   * repeaters — a dot grid is a row repeated down the columns — and the chain
   * already applies them in order (`applyPathOpChain`), so the single-repeater
   * limit lived in this handler alone.
   */
  if (i.opId !== undefined) {
    const target = repeaters.find((o) => o.id === i.opId);
    if (!target) {
      return fail(
        `'${i.nodeId}' has no repeater '${i.opId}'. ` +
          (repeaters.length
            ? `Its repeaters are: ${repeaters.map((o) => o.id).join(', ')}.`
            : 'It has no repeaters — omit opId to add one.'),
      );
    }
    // A PATCH: only what was named changes. Opacity is derived from a PAIR, so
    // it is re-derived only when the caller supplied at least one end of it.
    const copiesNow = i.copies !== undefined ? Math.max(1, Math.round(i.copies)) : (target.copies ?? 1);
    const patch: Partial<PathOp> = {
      ...(i.copies !== undefined ? { copies: copiesNow } : {}),
      ...(i.positionX !== undefined ? { offsetX: i.positionX } : {}),
      ...(i.positionY !== undefined ? { offsetY: i.positionY } : {}),
      ...(i.rotation !== undefined ? { offsetRotation: i.rotation } : {}),
      ...(i.scale !== undefined ? { offsetScale: i.scale } : {}),
      ...(i.anchorX !== undefined ? { anchorX: i.anchorX } : {}),
      ...(i.anchorY !== undefined ? { anchorY: i.anchorY } : {}),
      ...(i.startOpacity !== undefined || i.endOpacity !== undefined
        ? { offsetOpacity: perCopyOpacity(copiesNow, i.startOpacity ?? 100, i.endOpacity ?? i.startOpacity ?? 100) }
        : {}),
    };
    if (!Object.keys(patch).length) return fail(`Nothing to update on repeater '${i.opId}' — pass at least one field to change.`);
    updatePathOp(i.nodeId, target.id, patch);
    return ok(
      `Updated repeater '${target.id}' on '${i.nodeId}' (${Object.keys(patch).join(', ')}).`,
      { nodeId: i.nodeId, opId: target.id, repeaterCount: repeaters.length },
    );
  }

  const copies = Math.max(1, Math.round(i.copies ?? 3));
  const start = i.startOpacity ?? 100;
  const end = i.endOpacity ?? start;

  // Field-for-field into the vocabulary the repeater OPERATOR actually reads.
  // The old shape shared exactly ONE name with it (`copies`), so even a write
  // that had landed would have produced N identical stacked copies.
  const repOpId = addRepeaterOp(i.nodeId, {
    copies,
    offsetX: i.positionX ?? 0,
    offsetY: i.positionY ?? 0,
    offsetRotation: i.rotation ?? 0,
    offsetScale: i.scale ?? 1,
    offsetOpacity: perCopyOpacity(copies, start, end),
    ...(i.anchorX !== undefined ? { anchorX: i.anchorX } : {}),
    ...(i.anchorY !== undefined ? { anchorY: i.anchorY } : {}),
  });

  const closes = Math.abs(copies * (i.rotation ?? 0) - 360) < 1;
  const total = repeaters.reduce((n, o) => n * Math.max(1, Math.round(o.copies ?? 1)), copies);
  return ok(
    `Repeater '${repOpId}' on '${i.nodeId}': ${copies} copies, ${i.rotation ?? 0}° apart` +
      (closes ? ' (a closed ring)' : '') +
      (repeaters.length
        ? `. It is repeater #${repeaters.length + 1} on this layer and repeats the OUTPUT of the ` +
          `${repeaters.length} before it — ${total} copies in all. Pass opId to edit one instead of stacking`
        : '') +
      // The REAL keyframe paths, id-scoped like every other operator's. This
      // advertised 'repeater.copies' / 'repeater.offset', which were never
      // property paths this app has understood — a caller following the advice
      // wrote a track nothing samples. Same reason `set_path_op` returns
      // `pathop.<id>.amount` rather than a friendly name.
      `. Animate '${pathOpPropPath(repOpId, 'copies')}' or ` +
      `'${pathOpPropPath(repOpId, 'offset')}' to build it on.` +
      (closes && !i.anchorX
        ? ` NOTE: anchorX is 0, so every copy pivots about its own origin and the ring has no radius — set anchorX to the radius you want.`
        : ''),
    { nodeId: i.nodeId, opId: repOpId, repeaterCount: repeaters.length + 1 },
  );
};

/** Tool-facing operator names → the engine's `PathOpType`. */
const PATH_OP_ALIASES: Record<string, PathOp['type']> = {
  zigzag: 'zigzag',
  pucker: 'pucker',
  // The name in the system prompt and in the panel's quick presets. It is not an
  // engine operator; passing it through failed `isPathOpType` and silently
  // coerced the whole operator to `none`.
  puckerBloat: 'pucker',
  twist: 'twist',
  roundCorners: 'roundCorners',
  offset: 'offset',
  roughen: 'roughen',
  wiggleTransform: 'wiggleTransform',
};

const addPathOperatorHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    nodeId: string;
    op: string;
    amount?: number;
    detail?: number;
    wigglesPerSecond?: number;
  };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

  const type = PATH_OP_ALIASES[i.op];
  if (!type) {
    return fail(
      `Unknown path operator '${i.op}'. Use one of: ${Object.keys(PATH_OP_ALIASES).join(', ')}.`,
    );
  }

  // The TYPE's own defaults, not zigzag's: a wiggleTransform must inherit its
  // 2 wiggles/second and correlation 50 or an unspecified call adds a frozen
  // wiggle — an operator that appears to do nothing.
  const base = defaultPathOpOf(type);
  const op: PathOp = {
    ...base,
    id: newPathOpId(),
    type,
    amount: i.amount ?? base.amount,
    detail: i.detail ?? base.detail,
    wigglesPerSecond: Math.max(0, i.wigglesPerSecond ?? base.wigglesPerSecond ?? 0),
  };
  // Push onto the CHAIN. `fx.pathOp` — the single slot this used to write — was
  // replaced by `fx.pathOps` in document version 1.3.0, and the reader
  // deliberately does not accept the old shape.
  addPathOp(i.nodeId, op);

  const chain = readPathOps(defaultSceneGraph.getNode(i.nodeId)!);
  return ok(
    `Added '${type}' to '${i.nodeId}' (operator ${chain.length} in the chain, id '${op.id}'). ` +
      `Keyframe 'pathop.${op.id}.amount' to animate the deformation.`,
    { nodeId: i.nodeId, opId: op.id },
  );
};

const createSkeletonRigHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as { layerId: string; bones: Array<{ id: string; parentId?: string; length: number; x?: number; y?: number; rotation?: number }> };
  if (!await ctx.scene.has(i.layerId)) return fail((await unknownNode(ctx, i.layerId)));
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
  refreshAfterLegacy(ctx);
  return ok(`Created skeleton rig with ${bones.length} bones on layer '${i.layerId}'.`, { layerId: i.layerId, boneCount: bones.length });
};

const poseSkeletonHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as { layerId: string; bonePoses: Array<{ boneId: string; timeSec: number; rotation: number; x?: number; y?: number }> };
  if (!await ctx.scene.has(i.layerId)) return fail((await unknownNode(ctx, i.layerId)));
  for (const p of i.bonePoses) {
    const lt = p.timeSec; // composition seconds — the engine converts
    await ctx.anim.setKeyframe(i.layerId, `bone.${p.boneId}.rotation`, lt, p.rotation);
    if (p.x !== undefined) await ctx.anim.setKeyframe(i.layerId, `bone.${p.boneId}.x`, lt, p.x);
    if (p.y !== undefined) await ctx.anim.setKeyframe(i.layerId, `bone.${p.boneId}.y`, lt, p.y);
  }
  refreshAfterLegacy(ctx);
  return ok(`Set ${i.bonePoses.length} bone pose keyframes on layer '${i.layerId}'.`, { layerId: i.layerId, poseCount: i.bonePoses.length });
};

const applyLayerStyleHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as { nodeId: string; styleType: 'drop_shadow' | 'outer_glow'; color: string; opacity?: number; size?: number; distance?: number; angle?: number };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

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
  refreshAfterLegacy(ctx);
  return ok(`Applied ${i.styleType} layer style on '${i.nodeId}'.`);
};

const recolorLottieVectorHandler: AiTool['handler'] = async (input, ctx) => {
  const { nodeId, color } = input as { nodeId: string; color: string };
  if (!await ctx.scene.has(nodeId)) return fail((await unknownNode(ctx, nodeId)));

  let count = 0;
  const traverseAndRecolor = (id: string) => {
    const node = defaultSceneGraph.getNode(id);
    if (!node) return;
    const kind = readNodeKind(node);
    if (kind === 'shape') {
      const style = node.components.find((c) => c.type === 'Style');
      // `node.components` is a fresh copy per read, so `style.props.fill = …`
      // recoloured a throwaway. `writeProp` reaches the engine component.
      if (style && defaultSceneGraph.writeProp(id, style.id, 'fill', color)) {
        count++;
      }
    }
    for (const childId of node.children) {
      traverseAndRecolor(childId);
    }
  };

  traverseAndRecolor(nodeId);
  refreshAfterLegacy(ctx);
  return ok(`Recolored ${count} vector shapes inside Lottie/group '${nodeId}' to ${color}.`);
};

// ── Recipe handlers whose defs live in craft.ts ────────────────────

const addLogoReveal: AiTool['handler'] = async (input, ctx) => {
  const i = input as { text: string; shape?: 'ellipse' | 'star' | 'rect'; style?: string };
  const s = resolveStyle(i.style);
  const ids = await recipeLogoReveal(ctx, s, { text: i.text, shape: i.shape });
  refreshAfterLegacy(ctx);
  return ok(`Built trim-path logo reveal sequence for "${i.text}".`, { ids });
};

const addRadialBurst: AiTool['handler'] = async (input, ctx) => {
  const i = input as { count?: number; x?: number; y?: number; style?: string };
  const s = resolveStyle(i.style);
  const id = await recipeRadialBurst(ctx, s, { count: i.count, x: i.x, y: i.y });
  refreshAfterLegacy(ctx);
  return ok(`Added radial repeater burst accent '${id}'.`, { id });
};

const addPathMorph: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    nodeId?: string; op?: 'puckerBloat' | 'zigzag'; amount?: number; fromAmount?: number;
    startSec?: number; durationSec?: number; pingPong?: boolean; fill?: string; x?: number; y?: number;
    style?: string;
  };
  if (i.nodeId !== undefined) {
    if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));
    const kind = (await ctx.scene.get(i.nodeId))?.kind ?? 'shape';
    // Same gate as set_trim_path, same reason: a path operator on a layer with
    // no shape path is stored and never rendered.
    if (NO_PATH_PIPELINE.has(kind)) {
      return fail(
        `'${i.nodeId}' is a ${kind} layer — a path morph distorts a SHAPE layer's outline, and a ${kind} has ` +
          `none. Pass the id of a shape layer, or omit nodeId to have one created.`,
      );
    }
  }
  const s = resolveStyle(i.style);
  const r = await recipePathMorph(ctx, s, i);
  refreshAfterLegacy(ctx);
  const span = `${r.startSec.toFixed(2)}s → ${r.endSec.toFixed(2)}s`;
  return ok(
    (r.created
      ? `Created shape layer '${r.id}' (fill ${i.fill ?? s.palette.accent}, on top of the stack) and morphed it`
      : `Morphed existing layer '${r.id}' in place — no new layer, its fill and position are untouched`) +
      `: ${i.op ?? 'puckerBloat'} ${i.fromAmount ?? 0} → ${i.amount ?? 35}${i.pingPong ? ` → ${i.fromAmount ?? 0}` : ''} over ${span}. ` +
      `The animated track is '${r.prop}' — retime or extend it with set_keyframes.`,
    { id: r.id, opId: r.opId, prop: r.prop, created: r.created },
  );
};

// ── Registry wiring ───────────────────────────────────────────────

/**
 * Mutating tools whose handlers write ONLY through the ToolContext facades (or
 * engine commands), audited for B5. Their writes go to the engine; anything the
 * API cannot express yet is named inside the facade / handler with
 * `ctx.engine.legacy(<gap>)`. Every OTHER mutating tool (text animators, masks,
 * media, path ops, rigs, layer styles, the compose recipes, …) still calls
 * legacy document helpers and is recorded as a gap wholesale by `buildAiTools`.
 */
export const ENGINE_ROUTED_TOOLS: ReadonlySet<string> = new Set([
  'create_layer', 'delete_layer', 'reparent_layer', 'update_layer',
  'set_keyframes', 'remove_keyframes', 'set_easing', 'set_expression',
  'add_effect', 'update_effect', 'update_effect_param', 'update_composition', 'apply_preset',
  'set_spring', 'set_motion_blur', 'create_precomp', 'set_time_remap', 'set_light', 'set_shadow_stack',
  'create_puppet_rig', 'set_puppet_pin_keyframes', 'pose_skeleton',
]);

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
  generate_video: generateVideo,
  generate_speech: generateSpeech,
  generate_3d_model: generate3dModel,
  export_video: exportVideoTool,
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
    const raw = HANDLERS[d.name];
    if (!raw) throw new Error(`Tool '${d.name}' is declared but has no handler`);
    // A mutating tool that still writes through legacy helpers records the gap
    // up front, so its turn commits as a snapshot entry (B5, see the list).
    const handler: AiTool['handler'] = !mutates(d.kind) || ENGINE_ROUTED_TOOLS.has(d.name)
      ? raw
      : (input, ctx) => {
          ctx.engine?.legacy(`${d.name} writes through legacy helpers`);
          return raw(input, ctx);
        };
    return { ...def(d.name), handler };
  });

  return tools;
}

