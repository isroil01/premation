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
import { ALL_TOOL_DEFS, PREVIEW_VIDEO_MODEL, ToolRegistry, bindAlias, mutates, resolveAlias, snapVideoDuration, videoModel } from '@motion/ai-tools';
import { cameraMoveCapabilities, makeAddCameraMove } from './cameraMoveTool';
import { EFFECT_DEFS, effectDefFor } from '@core/effects/effects';
import { ANIMATOR_PARAMS } from '@core/text/textAnimators';
import { isRiggableKind } from '@core/scene/rigLogo';
import { nextRigIds, usedRigIds } from '@core/rig/rigIds';
import type { PinKind, PuppetPin, PuppetRig } from '@core/rig/puppet';
import { defaultGlassStyle, type LayerStyles } from '@core/effects/layerStyles';
import { MEDIA_HANDLERS, subjectStyleCatalog } from './mediaTools';
import { uiKindOf } from '@core/mirror/layerKinds';
import { documentMirror } from '@stores/documentMirror';
import { placeBehindSubject } from '@core/workspace/placeBehindSubjectPort';
import { renderedBoxes } from './renderedBounds';
import { layerBox, layerInfo, puppetPins } from './mirrorReads';

import { pathOpPropPath, type PathOp } from '@core/scene/pathOps';

import { defaultPolystar } from '@core/scene/polystar';
import { rectangleMask, ellipseMask, type MaskMode, type MaskPath } from '@core/effects/mask';
import { refreshAfterLegacy } from './toolContext';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { useAiProviderStore } from '@stores/aiProviderStore';
import { useSelectionStore } from '@stores/selectionStore';
import { analyseAudio } from '@motion/audio';
import { resolveStyle, buildCustomStyle, setRuntimeStyle, type CustomStyleInput } from './design';
import { decodeBase64Bytes } from './decodeBase64';
import { generateImageBytes } from './aiImage';
import { generateVideoBytes, generateSpeechBytes, generate3dBytes } from './aiMedia';
import { cachedAsset, generationKey, rememberAsset } from './aiMediaCache';
import { useAiMediaPrefsStore } from '@stores/aiMediaPrefsStore';
import { exportCompositionVideo } from './aiExport';
import { handedOverJobId, useRenderQueueStore } from '@stores/renderQueueStore';
import { useExportQueueStore } from '@stores/exportQueueStore';
import type { ExportJobRecord } from '@core/export/exportSupervisorClient';
import type { AiImageResult, AiMediaResult } from '@app-types/motionEditor';
import type { EntranceArchetype } from './archetypes';
import {
  recipeBackground,
  recipeText,
  recipeEmblem,
  recipeCards,
  recipeStaggerIn,
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
import { selectScene, sceneElementIds, forgetSceneElements } from './sceneWindow';
import { TRANSFORM_PROPS, THREE_D_PROPS, SPECIAL_PROPS, CAMERA_PROPS, SAMPLED_LAYER_PROPS, isAnimatableProp } from './toolContext';
import { readMatte } from '@core/effects/matte';
import { CRAFT_HANDLERS, clampEffectParam } from './craftHandlers';
import { mapSeq, filterSeq } from './asyncList';
import { engineOnly } from './toolContext';
import { activePlayheadSeconds, trackMatteCommand } from '@core/engine/trackWrites';
import { componentOfType, fieldWrite, memberWrite } from '@core/engine/propRefs';
import { maskToBezier } from '@core/engine/props';
import type { Primitive3DKind } from '@core/scene/layerBuilders';
import { isPrimitiveMeshType, type PrimitiveSpec } from '@core/scene/primitiveLayer';
import { parseCssColor } from '@core/text/cssColor';
import {
  addMaskFromPath, addPathOperator, addTextAnimatorGroup, applyLayerTiming, convertSvgLayer, ensurePathOperator, importAssetBytes,
  insertAssetLayer, insertModelPlaceholder, insertPrimitive3DLayer, insertSvgMarkupLayer, patchLayerStyle, patchPathOperator, patchTextAnimator,
  pathOperators, textAnimators, patchMask, keyMaskPath, removeMask, type LayerTimingSeconds, type MaskPatch,
} from './hostWrites';
import { flicksToSeconds, secondsToFlicks, type BezierPath, type Command, type PropertyWrite } from '@motion/engine-api';
import { mirrorMaskIds } from '@core/mirror/masks';
import { engine, engineIdle } from '@core/engine/engineInstance';
import { AUDIO_LEVELS_PATH, planFadeKeysIn } from '@core/mirror/audio';
import { activeCompRootId } from '@core/scene/activeComp';
import { colorValueHex } from '@core/mirror/paintFields';
import { defaultStroke, normalizeStroke, type Stroke } from '@core/paint/stroke';
import { sceneStructureWarnings } from './structureAdvisors';
import { MAX_STROKE_DASH_ENTRIES } from '@core/paint/strokeTracks';
import { mirrorStrokes } from '@core/mirror/paintFields';

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

/** The editor kind of a layer (the document mirror), null when it is not one. */
const kindOf = (id: string) => uiKindOf(layerInfo(id));

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
  // What the engine recorded against layers (a font that is not installed, an
  // effect on the CPU fallback, a feature it does not draw yet): the model sees
  // why a layer looks wrong instead of guessing.
  const shownIds = new Set(shown.map((n) => n.id));
  const problems = documentMirror().layerErrors(activeCompRootId() as string)
    .filter((e) => shownIds.has(e.layer))
    .slice(0, 40)
    .map((e) => ({ layer: e.layer, stage: e.stage, message: e.message }));

  // Whole-stack problems no single layer shows (structureAdvisors.ts): a
  // script built twice, two cameras live at once, stacked adjustment layers.
  const warnings = subtreeOf ? [] : (await sceneStructureWarnings(ctx)).map((w) => w.message);

  const payload = {
    composition: { ...comp, playhead: ctx.comp.playhead() },
    selection: ctx.scene.selection(),
    layerCount: nodes.length,
    ...(problems.length ? { problems } : {}),
    ...(warnings.length ? { warnings } : {}),
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
  // Post-expression values: `animated` is the engine's evaluated answer, so an
  // expression-driven prop reports what the frame draws, not its base value.
  const fromExpression = ctx.anim.expressionProps ? [...await ctx.anim.expressionProps(nodeId)] : [];
  const payload = {
    t: compT,
    values: { x: node.x, y: node.y, rotation: node.rotation, opacity: node.opacity, ...animated },
    ...(fromExpression.length > 0 ? { fromExpression } : {}),
  };
  const note = fromExpression.length > 0 ? `
Values for ${fromExpression.join(', ')} come from an expression (evaluated at t).` : '';
  return ok(JSON.stringify(payload) + note, payload);
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

/**
 * What a model must know about an effect that its params do not say — read
 * by list_capabilities and add_effect's reply. The samurai session keyed
 * Write-on's brush from (400, 300) to (1500, 800) as if from the top-left; the
 * brush is centre-relative, so the stroke ran off the frame.
 */
export const EFFECT_AI_NOTES: Readonly<Record<string, string>> = {
  'write-on':
    'Mode 0 (Brush Position) paints a trail where the brush has been: brushPositionX/Y are px from the LAYER CENTRE ' +
    '(0, 0 = centre; −width/2 = left edge), not from the top-left. Key them for the stroke path. For a tapered, ' +
    'calligraphic line key brushSize along the same times AND set brushTimeProps: 1 (Size) — as in After Effects, ' +
    'without it every dab takes the CURRENT size. strokeLength limits the trail to its last N seconds.',
  'light-sweep':
    'The sweep lights whatever alpha the layer has at that point of the effect stack — like After Effects. Add it ' +
    'BEFORE drop-shadow / glow (or keep shadows last): a drop-shadow placed earlier is lit too, so the band shows ' +
    'over the whole box of a text layer instead of the glyphs.',
};

const listCapabilities: AiTool['handler'] = async (input, ctx) => {
  const { area } = input as { area?: string };
  const want = (a: string) => !area || area === 'all' || area === a;
  const payload: Record<string, unknown> = {};
  if (want('props')) {
    payload.animatableProps = {
      transform: TRANSFORM_PROPS,
      threeD: { props: THREE_D_PROPS, note: "Requires the layer's 3D switch — set it via update_layer { threeD: true }." },
      layer: { props: SAMPLED_LAYER_PROPS, note: 'Anchor, skew, fill/stroke opacity, stroke width, text tracking.' },
      effects: 'effect.<effectId> — the id returned by add_effect',
      textAnimators: 'ta.<index>.<param> — index from text_animator',
      paint: 'paint.<strokeId>.<param> — strokeId from paint_strokes; param: start, end, diameter, angle, hardness, roundness, spacing, opacity, flow, positionX, positionY, scale, rotation, color_r/g/b/a',
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
      ...(EFFECT_AI_NOTES[e.type] ? { note: EFFECT_AI_NOTES[e.type] } : {}),
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
      tools: 'create_puppet_rig (rig + pins, kinds position|advanced|bend|starch|overlap, mesh settings, append) → set_puppet_pin_keyframes (many pins, eases, path tangents) + set_keyframes on .rotation/.stiffness/.scale.',
      note: 'Pin ids are returned by create_puppet_rig. Mesh settings: create_puppet_rig { mesh: { density 2-50, expansion px, mode grid|silhouette, solver arap|lbs, maxRotationDeg, traceAccuracy 0-100 %, alphaThreshold 0-255 } }; create_skeleton_rig { mesh: { density, expansion, mode, traceAccuracy, alphaThreshold, preserveVolume } }. ikMode.<boneId> is a 0..1 FK→IK blend (pose_skeleton ikPoses.ik).',
    };
  }
  if (want('media')) {
    payload.media = {
      coordinates: 'Points on footage are FOOTAGE px from the top-left of the picture (not comp px); times are composition seconds.',
      subjects: {
        tools: 'find_subjects (candidates) → select_subject (points / box / candidate; a new subject per call) → refine_subject (add / subtract / strokes / edge) → follow_subject (through the shot, a job) → apply_subject_style, place_behind_subject, get_editor_context (the active subject).',
        styles: subjectStyleCatalog(),
      },
      tracking: 'track_point (one click, auto feature, tracks outward from the playhead) → attach_to_track { mode: follow | transform | createNull | stabilize | effectPoint }.',
      transcription: 'transcribe (cues + word timings; createCaptions makes caption layers) — needs the user\'s Allow over MCP.',
      assets: 'describe_asset (metadata + contact sheet over MCP); render_frame { assetId, time } for one frame; create_media to place.',
      jobs: 'follow_subject and transcribe return a jobId; get_job_status polls or cancels it.',
    };
  }
  if (want('camera')) payload.cameraMoves = { tool: 'add_camera_move', kinds: cameraMoveCapabilities() };
  if (want('all')) payload.presets = await ctx.anim.listPresets();
  return ok(JSON.stringify(payload), payload);
};

const listPresetsHandler: AiTool['handler'] = async (_input, ctx) => {
  const names = await ctx.anim.listPresets();
  return ok(JSON.stringify(names), names);
};

// ── Write: structure ──────────────────────────────────────────────

const PRIMITIVE_KINDS: readonly Primitive3DKind[] = ['sphere', 'cylinder', 'cone', 'torus', 'capsule', 'box', 'cube', 'plane'];

/** create_layer { kind: 'primitive' }: the New 3D Primitive insert, sized and placed as asked. */
async function createPrimitive(
  i: { id?: string; name: string; x?: number; y?: number; width?: number; height?: number; fill?: string; parent?: string; primitive?: string; radius?: number; depth?: number; tube?: number },
  ctx: Parameters<AiTool['handler']>[1],
): Promise<Awaited<ReturnType<AiTool['handler']>>> {
  const type = (i.primitive ?? 'sphere') as Primitive3DKind;
  if (!PRIMITIVE_KINDS.includes(type)) return fail(`primitive must be one of ${PRIMITIVE_KINDS.join(', ')}.`);
  const mesh = isPrimitiveMeshType(type);
  const spec: Partial<Omit<PrimitiveSpec, 'type'>> = mesh
    ? {
      ...(i.radius !== undefined ? { radius: i.radius } : {}),
      ...(i.height !== undefined ? { height: i.height } : {}),
      ...(i.width !== undefined ? { width: i.width } : {}),
      ...(i.depth !== undefined ? { depth: i.depth } : {}),
      ...(i.tube !== undefined ? { tube: i.tube } : {}),
    }
    : {};
  const comp = await ctx.comp.get();
  // The mesh's size rides in the insert (the Primitive component is laid with it).
  const id = await insertPrimitive3DLayer(ctx.engine, type, i.name, { x: i.x ?? comp.width / 2, y: i.y ?? comp.height / 2 }, spec);
  if (!id) return fail(`Could not create a ${type} primitive — the insert produced no layer.`);
  bindAlias(ctx, i.id, id);
  if (!mesh) {
    // A cube is an extruded square, a plane a flat card: the layer box is their size.
    const side = i.width ?? (i.radius !== undefined ? i.radius * 2 : undefined);
    if (side !== undefined) await ctx.scene.setProp(id, 'width', side);
    const tall = i.height ?? side;
    if (tall !== undefined) await ctx.scene.setProp(id, 'height', tall);
    const deep = i.depth ?? side;
    if (type === 'cube' && deep !== undefined) await ctx.scene.setProp(id, 'extrusionDepth', deep);
  }
  if (i.fill) await ctx.scene.setProp(id, 'fill', i.fill);
  if (i.parent) await ctx.scene.reparent(id, i.parent);
  const made = await ctx.scene.get(id);
  return ok(
    `Created 3D ${type} '${made?.name ?? i.name}' with id ${id}: 3D on, lit, casting shadows. ` +
    'Give it a material with update_layer (shading "pbr", metal, roughness), light it with set_light, and frame it with a camera.',
    { id, name: made?.name ?? i.name, primitive: type },
  );
}

const createLayer: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    id?: string; kind: string; name: string; x?: number; y?: number; width?: number; height?: number;
    text?: string; shape?: string; fill?: string; parent?: string;
    points?: number; outerRadius?: number; innerRadius?: number; roundness?: number;
    primitive?: string; radius?: number; depth?: number; tube?: number;
  } & StrokeToolInput;
  if (i.parent && !await ctx.scene.has(i.parent)) return fail((await unknownNode(ctx, i.parent)));
  if (i.kind === 'primitive') return createPrimitive(i, ctx);
  // Accept x-only or y-only (the old code discarded BOTH if either was missing,
  // silently centring the layer). Only when NEITHER is given do we hand the
  // facade `undefined`, which fans the layer out instead of stacking at centre.
  const comp = await ctx.comp.get();
  // A FULL-FRAME layer — an adjustment layer, or a solid with no size of its
  // own (the engine sizes both to the comp) — is centred on the comp: its quad
  // is centred on its position, so at the engine's default (0, 0) a rain /
  // grain / vignette pass covered only the top-left quarter of the frame (B1).
  const fullFrame = i.kind === 'adjustment' || (i.kind === 'solid' && i.width === undefined && i.height === undefined);
  const at =
    i.x !== undefined || i.y !== undefined || fullFrame
      ? { x: i.x ?? comp.width / 2, y: i.y ?? comp.height / 2 }
      : undefined;
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
  }
  // The outline is part of the insert (B5): a rect or ellipse is the layer
  // factory's own kind; a line or a polystar is inserted whole (pasteLayers).
  const shape = i.kind === 'shape' && i.shape
    ? (polystar
      ? { shapeType: 'polystar', polystar: polystar as unknown as Record<string, unknown> }
      : i.shape === 'line'
        ? { shapeType: 'line', width: i.width ?? 200, height: i.height ?? 200, ...(i.fill && i.fill !== 'none' ? { color: i.fill } : {}) }
        : { shapeType: i.shape })
    : undefined;
  const id = await ctx.scene.create(i.kind, i.name, at, shape);
  if (!id) return fail(`Could not create a ${i.kind} layer — the insert produced no node.`);
  // Bind the caller's handle BEFORE anything else, so a later call in the same
  // batch can address this layer without a round-trip through the model.
  bindAlias(ctx, i.id, id);
  if (i.text !== undefined) await ctx.scene.setProp(id, 'content', i.text);
  // A line's `fill` is its stroke colour (laid into the insert above).
  if (i.fill && i.shape !== 'line') await ctx.scene.setProp(id, 'fill', i.fill);
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

  // The outline asked for in the same call (STROKE_PROPS). A refusal here is
  // the whole call's: the layer exists, and the reply must not say it has a
  // stroke it does not.
  const strokePatch = strokePatchOf(i);
  if (Object.keys(strokePatch).length > 0) {
    const refused = await applyStrokePatch(ctx, id, strokePatch);
    if (refused) return fail(`Created ${i.kind} layer ${id}, but its stroke was not set: ${refused.content}`);
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
  const strokeNote = Object.keys(strokePatch).length > 0 ? ` Stroke set: ${strokeFieldNames(strokePatch).join(', ')}.` : '';
  return ok(
    `Created ${i.kind} layer '${realName}' with id ${id}${renamed}. Use this id in later calls.${shapeNote}${strokeNote}`,
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
  // An adjustment layer re-parents keep-world like any other: the engine reads
  // its transform (worldxf.cpp is_drawable_kind, B1) instead of identity.
  await ctx.scene.reparent(nodeId, parentId ?? null);
  return ok(`Re-parented ${nodeId} to ${parentId ?? 'the top level'}.`);
};

const setAudio: AiTool['handler'] = async (input, ctx) => {
  const i = input as { nodeId: string; loop?: number; levelDb?: number; fadeInSec?: number; fadeOutSec?: number };
  if (!await ctx.scene.has(i.nodeId)) return fail(await unknownNode(ctx, i.nodeId));
  const m = documentMirror();
  await m.loadTree(i.nodeId);
  const info = m.layer(i.nodeId)!;
  if (!m.property(i.nodeId, AUDIO_LEVELS_PATH)) return fail(`'${i.nodeId}' (${info.kind}) has no sound — set_audio applies to audio layers and video layers with a track.`);
  const done: string[] = [];
  if (i.loop !== undefined) {
    if (!info.source) return fail(`'${i.nodeId}' plays no footage item, so it cannot loop.`);
    await ctx.engine.apply([{ type: 'setInterpretation', items: [info.source], patch: { loops: i.loop } } as Command]);
    done.push(i.loop === 0 ? 'loops for as long as its bar lasts' : `plays ${i.loop}×`);
  }
  if (i.levelDb !== undefined) {
    await ctx.engine.apply([{ type: 'setProperty', prop: { layer: i.nodeId, path: AUDIO_LEVELS_PATH }, value: { kind: 'scalar', value: i.levelDb }, time: secondsToFlicks(activePlayheadSeconds()) } as Command]);
    done.push(`level ${i.levelDb} dB`);
  }
  for (const [side, sec] of [['in', i.fadeInSec], ['out', i.fadeOutSec]] as const) {
    if (sec === undefined) continue;
    await engineIdle();
    await m.loadTree(i.nodeId);
    const keys = planFadeKeysIn(m, i.nodeId, side, sec, (t) => t);
    if (keys.length !== 2) return fail(`No audible span on '${i.nodeId}' to fade ${side} over ${sec}s (is its bar on the timeline?).`);
    await ctx.engine.apply([{
      type: 'addKeyframes',
      keys: keys.map((k) => ({ prop: { layer: i.nodeId, path: AUDIO_LEVELS_PATH }, time: secondsToFlicks(k.seconds), value: { kind: 'scalar', value: k.value }, spatialIn: [], spatialOut: [] })),
    } as Command]);
    done.push(`fade ${side} ${keys[0]!.seconds.toFixed(2)}–${keys[1]!.seconds.toFixed(2)}s`);
  }
  if (done.length === 0) return fail('Nothing to change — pass loop, levelDb, fadeInSec or fadeOutSec.');
  return ok(`'${i.nodeId}': ${done.join(', ')}.` + (i.loop !== undefined && i.loop !== 1 ? ' Extend its bar with set_layer_timing (outSec) to hear the repeats.' : ''));
};

interface PaintStrokeArgs {
  points: number[][];
  color?: string;
  size?: number;
  hardness?: number;
  opacity?: number;
  minSize?: number;
  angle?: number;
  roundness?: number;
  spacing?: number;
  flow?: number;
  mode?: 'paint' | 'erase' | 'clone';
  cloneOffsetX?: number;
  cloneOffsetY?: number;
  reveal?: { from: number; to: number };
}

const pct = (v: number | undefined, fallback: number): number => Math.min(100, Math.max(0, v ?? fallback)) / 100;

const paintStrokes: AiTool['handler'] = async (input, ctx) => {
  const i = input as { nodeId: string; strokes: PaintStrokeArgs[]; onTransparent?: boolean };
  if (!await ctx.scene.has(i.nodeId)) return fail(await unknownNode(ctx, i.nodeId));
  const info = documentMirror().layer(i.nodeId)!;
  // Reveal keys are on the stroke's own axis: LAYER seconds (the layer's start time off).
  const layerStart = flicksToSeconds(info.timing.startTime);
  // The tool speaks the layer's top-left (how anyone describes a drawing);
  // stored paint points are centre-relative layer px.
  const box = await layerBox(i.nodeId);
  const ox = (box.width ?? 0) / 2;
  const oy = (box.height ?? 0) / 2;
  const ids: string[] = [];
  for (const [n, s] of i.strokes.entries()) {
    const pts = s.points.filter((p) => p.length >= 2 && p.every((v) => Number.isFinite(v)));
    if (pts.length === 0) return fail(`strokes[${n}] has no finite points.`);
    const pressured = pts.some((p) => p.length >= 3);
    const mode = s.mode === 'erase' || s.mode === 'clone' ? s.mode : 'paint';
    // The tip, in the model's units (paintStrokes.ts: fractions; degrees for
    // the angle). Spacing is written only when asked: its PRESENCE switches
    // the stroke to the dab renderer, and a continuous polyline is the default.
    const stroke: Record<string, unknown> = {
      points: pts.map((p) => ({ x: p[0]! - ox, y: p[1]! - oy })),
      color: s.color ?? '#000000',
      size: s.size ?? 12,
      hardness: pct(s.hardness, 80),
      opacity: pct(s.opacity, 100),
      mode,
      ...(typeof s.angle === 'number' ? { angle: Math.max(-180, Math.min(180, s.angle)) } : {}),
      ...(typeof s.roundness === 'number' ? { roundness: Math.max(0.01, pct(s.roundness, 100)) } : {}),
      ...(typeof s.spacing === 'number' ? { spacing: Math.max(0.01, Math.min(10, s.spacing / 100)) } : {}),
      ...(typeof s.flow === 'number' ? { flow: pct(s.flow, 100) } : {}),
      ...(mode === 'clone' ? { cloneOffsetX: s.cloneOffsetX ?? 0, cloneOffsetY: s.cloneOffsetY ?? 0 } : {}),
      ...(pressured ? {
        pressure: pts.map((p) => Math.min(1, Math.max(0, p[2] ?? 1))),
        dynamics: { size: 'pressure', minSize: Math.min(100, Math.max(0, s.minSize ?? 10)) / 100 },
      } : {}),
    };
    const keys = s.reveal && s.reveal.to > s.reveal.from
      ? [{ param: 'end', time: s.reveal.from - layerStart, value: 0 }, { param: 'end', time: s.reveal.to - layerStart, value: 100 }]
      : [];
    const r = await ctx.engine.apply([{ type: 'addPaintStroke', layer: i.nodeId, stroke: JSON.stringify(stroke), keys } as Command]);
    ids.push((r[0] as { stroke?: string }).stroke ?? '');
  }
  if (i.onTransparent !== undefined) await ctx.engine.apply([{ type: 'setPaintOnTransparent', layers: [i.nodeId], on: i.onTransparent } as Command]);
  const modes = [...new Set(i.strokes.map((s) => s.mode ?? 'paint'))];
  return ok(
    `Painted ${ids.length} ${modes.join('/')} stroke(s) on ${i.nodeId}: ${ids.join(', ')}.` +
    ` Their numeric params animate as "paint.<strokeId>.<param>" with set_keyframes: start, end (0..100, the write-on), diameter, angle, hardness, roundness, spacing, opacity, flow, positionX, positionY, scale, rotation.`,
    { strokes: ids },
  );
};

const reorderLayer: AiTool['handler'] = async (input, ctx) => {
  const i = input as { nodeIds: string[]; position: 'top' | 'bottom' | 'above' | 'below'; relativeTo?: string };
  for (const id of i.nodeIds) if (!await ctx.scene.has(id)) return fail(await unknownNode(ctx, id));
  const m = documentMirror();
  const comp = m.layer(i.nodeIds[0]!)?.comp;
  if (!comp) return fail(`'${i.nodeIds[0]}' is not in a composition.`);
  if (i.nodeIds.some((id) => m.layer(id)?.comp !== comp)) return fail('Layers moved together must be in one composition.');
  const parent = m.layer(i.nodeIds[0]!)?.parent ?? null;
  if (i.nodeIds.some((id) => (m.layer(id)?.parent ?? null) !== parent)) {
    return fail('Layers moved together must share a parent — reparent_layer them first, or move them one at a time.');
  }
  // reorderLayers' toIndex counts the front-first stack WITHOUT the moving layers.
  const moving = new Set(i.nodeIds);
  const stack = [...(m.comp(comp)?.layers ?? [])].filter((id) => !moving.has(id));
  let toIndex: number;
  if (i.position === 'top') toIndex = 0;
  else if (i.position === 'bottom') toIndex = stack.length;
  else {
    if (!i.relativeTo) return fail(`position "${i.position}" needs relativeTo: the layer to sit ${i.position}.`);
    if (!await ctx.scene.has(i.relativeTo)) return fail(await unknownNode(ctx, i.relativeTo));
    if (moving.has(i.relativeTo)) return fail('relativeTo cannot be one of the layers being moved.');
    if (m.layer(i.relativeTo)?.comp !== comp) return fail(`'${i.relativeTo}' is in another composition.`);
    const at = stack.indexOf(i.relativeTo);
    toIndex = i.position === 'above' ? at : at + 1;
  }
  await ctx.engine.apply([{ type: 'reorderLayers', comp, layers: [...i.nodeIds], toIndex } as Command]);
  const after = [...(documentMirror().comp(comp)?.layers ?? [])];
  const where = i.nodeIds.map((id) => `${id} → #${after.indexOf(id) + 1}`).join(', ');
  return ok(`Moved ${where} (layer 1 is the top of the stack, drawn over everything below it).`);
};

/** update_layer's numeric Material / Geometry Options rows: field (= the engine track), clamp range (the catalog's). */
const MATERIAL_TRACKS = [
  ['metal', 0, 100], ['roughness', 0, 100], ['reflectionIntensity', 0, 100], ['reflectionSharpness', 0, 100],
  ['transparency', 0, 100], ['ior', 1, 4], ['lightTransmission', 0, 100],
  ['extrusionDepth', 0, 1000], ['bevelDepth', 0, 200],
] as const;
/** AE's Casts Shadows: Off / On / Only. */
const CASTS_SHADOWS: Readonly<Record<string, number>> = { off: 0, on: 1, only: 2 };
/** update_layer's choice options: field → the catalog field it sets, and its choices. */
const MATERIAL_CHOICES = [
  ['shading', 'shadingModel', ['phong', 'pbr', 'toon']],
  ['bevelStyle', 'bevelStyle', ['angular', 'concave', 'convex']],
] as const satisfies ReadonlyArray<readonly [string, string, readonly string[]]>;

const updateLayer: AiTool['handler'] = async (input, ctx) => {
  const i = input as Record<string, unknown> & {
    nodeId: string;
    threeD?: boolean;
    acceptsLights?: boolean;
    ambient?: number;
    diffuse?: number;
    specular?: number;
    shininess?: number;
    shading?: string;
    metal?: number;
    roughness?: number;
    reflectionIntensity?: number;
    reflectionSharpness?: number;
    transparency?: number;
    ior?: number;
    lightTransmission?: number;
    castsShadows?: string;
    acceptsShadows?: boolean;
    toonBands?: number;
    extrusionDepth?: number;
    bevelDepth?: number;
    bevelStyle?: string;
    name?: string;
    visible?: boolean;
    locked?: boolean;
    motionBlur?: boolean;
    blendMode?: string;
    matte?: { mode: string; inverted?: boolean; sourceId?: string } | string;
    removeMatte?: boolean;
  } & StrokeToolInput;
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

  const node = layerInfo(i.nodeId);
  const applied: string[] = [];

  const sw = (patch: Record<string, unknown>): Command[] => [{ type: 'setLayerSwitches', layers: [i.nodeId], patch } as Command];
  if (i.threeD !== undefined && node) {
    await ctx.engine.apply(sw({ threeD: !!i.threeD }));
    applied.push(`threeD=${!!i.threeD}`);
  }
  // Material switches. Without these `set_light` was a tool that could not
  // change a pixel from a library-emitted batch: shading is gated on the 3D
  // switch AND `acceptsLights`, the flag defaults to false, and the only writer
  // was the inspector checkbox. A light could be created, positioned and tuned,
  // and nothing in the scene would ever be lit by it.
  // Material Options are the catalog's `material/…` rows (B3z): ONE
  // `setProperties`, a key at the playhead where an option is animated — what
  // the Inspector sends. Clamped as the legacy setters clamp. A layer whose
  // catalog does not address them (not 3D) is told so — the rows exist only on
  // a 3D layer, which `threeD: true` in the same call makes it.
  const material: Array<[string, number]> = [];
  if (i.acceptsLights !== undefined) material.push(['acceptsLights', i.acceptsLights ? 1 : 0]);
  for (const key of ['ambient', 'diffuse'] as const) {
    const v = i[key];
    if (typeof v === 'number') material.push([key, Math.max(0, Math.min(100, v))]);
  }
  if (typeof i.specular === 'number') material.push(['specular', Math.max(0, Math.min(100, i.specular))]);
  if (typeof i.shininess === 'number') material.push(['shininess', Math.max(1, i.shininess)]);
  // The engine's PBR / glass response and the geometry rows (Geometry
  // Options), each clamped to its catalog range.
  for (const [key, lo, hi] of MATERIAL_TRACKS) {
    const v = i[key];
    if (typeof v === 'number' && Number.isFinite(v)) material.push([key, Math.max(lo, Math.min(hi, v))]);
  }
  if (i.castsShadows !== undefined) {
    const n = CASTS_SHADOWS[i.castsShadows];
    if (n === undefined) return fail(`castsShadows must be one of ${Object.keys(CASTS_SHADOWS).join(', ')}.`);
    material.push(['castsShadows', n]);
  }
  if (i.acceptsShadows !== undefined) material.push(['acceptsShadows', i.acceptsShadows ? 1 : 0]);
  if (material.length > 0 && node) {
    const at = activePlayheadSeconds();
    const writes = material.map(([track, v]) => memberWrite(i.nodeId, track, v, at));
    const cmds = writes.every((w) => w !== null)
      ? [{ type: 'setProperties', writes: writes.map((w) => ({ prop: w!.prop, value: w!.value, ...(w!.time !== undefined ? { time: w!.time } : {}) })) } as Command]
      : null;
    await engineOnly(ctx.engine, `update_layer material/geometry options: ${i.nodeId} has none (turn threeD on first; cameras, lights and nulls have no geometry)`, cmds, () => undefined);
    for (const [track, v] of material) applied.push(`${track}=${track === 'acceptsLights' || track === 'acceptsShadows' ? v === 1 : track === 'castsShadows' ? i.castsShadows : v}`);
  }
  // The two choices among them: static catalog fields, the Inspector's dropdowns.
  for (const [key, field, choices] of MATERIAL_CHOICES) {
    const v = i[key];
    if (v === undefined || !node) continue;
    if (!(choices as readonly string[]).includes(v)) return fail(`${key} must be one of ${choices.join(', ')}.`);
    if (!await ctx.scene.setProp(i.nodeId, field, v)) return fail(`update_layer ${key}: ${i.nodeId} has no ${key} (turn threeD on first).`);
    applied.push(`${key}=${v}`);
  }
  if (typeof i.toonBands === 'number' && node) {
    const bands = Math.round(Math.max(2, Math.min(8, i.toonBands)));
    if (!await ctx.scene.setProp(i.nodeId, 'toonBands', bands)) return fail(`update_layer toonBands: ${i.nodeId} has no toonBands (turn threeD on first).`);
    applied.push(`toonBands=${bands}`);
  }
  if (i.name !== undefined && node) {
    await ctx.engine.apply([{ type: 'renameLayer', layer: i.nodeId, name: String(i.name) } as Command]);
    applied.push('name');
  }
  if (i.visible !== undefined && node) {
    await ctx.engine.apply(sw({ visible: !!i.visible }));
    applied.push('visible');
  }
  if (i.locked !== undefined && node) {
    await ctx.engine.apply(sw({ locked: !!i.locked }));
    applied.push('locked');
  }
  if (i.motionBlur !== undefined && node) {
    await ctx.engine.apply(sw({ motionBlur: !!i.motionBlur }));
    applied.push(`motionBlur=${!!i.motionBlur}`);
  }
  if (i.blendMode !== undefined && node) {
    await ctx.engine.apply([{ type: 'setBlendMode', layers: [i.nodeId], mode: i.blendMode } as Command]);
    applied.push(`blendMode=${i.blendMode}`);
  }
  if (i.removeMatte && node) {
    await ctx.engine.apply([trackMatteCommand(i.nodeId, undefined)]);
    applied.push('removeMatte');
  } else if (i.matte !== undefined && node) {
    // readMatte normalises whatever the model sent: the 1.2.0 {mode,inverted}
    // shape or the legacy four-value spelling. Tolerating both means the tool
    // schema and the prompt do not need a flag day. `setTrackMatte`, as the
    // Inspector's Track Matte menu sends it.
    await ctx.engine.apply([trackMatteCommand(i.nodeId, readMatte(i.matte))]);
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
    // AE's tracking unit, the italic face, and where point text anchors
    // (audit 2026-10-18: every AI paragraph was ragged and upright).
    'tracking', 'fontStyle', 'textAnchor',
    // Paragraph text (boxWidth > 0: the text wraps inside the box and `align`
    // places each line in it), vertical type (tategaki) and RTL paragraphs —
    // the Character / Paragraph panels' fields, unreachable from any tool.
    'boxWidth', 'boxHeight', 'orientation', 'direction', 'language',
    // Both are read by buildSnapshot (cornerRadius:189, backdropBlur:190) and
    // were unreachable from any tool. `backdropBlur` in particular is the whole
    // glass-surface vocabulary and it was already fully wired and tested.
    'cornerRadius', 'cornerRadiusTL', 'cornerRadiusTR', 'cornerRadiusBR', 'cornerRadiusBL', 'backdropBlur',
    // Static 3D placement. Previously the ONLY way to give a layer a z was a
    // one-keyframe `set_keyframes` call, which sets the value but also creates
    // an animation track — so a technique that later animated z inherited a
    // keyframe it did not author and started from the wrong place.
    'z', 'rotationX', 'rotationY',
    // Transform extras the catalog addresses as numbers (STATIC_PROPERTY_META):
    // a pivot that is not the centre, a slant, a fill that fades apart from
    // its stroke. `setProp` refuses one the layer's tree does not carry.
    'anchorX', 'anchorY', 'skew', 'skewAxis', 'fillOpacity',
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
    if ((CAMERA_PROPS as readonly string[]).includes(key) && node && kindOf(i.nodeId) !== 'camera') {
      return fail(
        `'${key}' is a camera property and '${i.nodeId}' is a ${kindOf(i.nodeId)}. ` +
        `Create one with create_layer { kind: "camera" } first.`,
      );
    }
    // The switch as it stands now (a `threeD` in this call was applied first).
    if ((THREE_D_PROPS as readonly string[]).includes(key) && node && !layerInfo(i.nodeId)?.switches.threeD) {
      return fail(
        `'${key}' needs the layer's 3D switch — pass threeD: true in this same call (it is applied first).`,
      );
    }
    if (await ctx.scene.setProp(i.nodeId, map[key] ?? key, i[key])) applied.push(key);
  }

  const strokePatch = strokePatchOf(i);
  if (Object.keys(strokePatch).length > 0 && node) {
    const r = await applyStrokePatch(ctx, i.nodeId, strokePatch);
    if (r) return r;
    applied.push(...strokeFieldNames(strokePatch));
  }

  if (!applied.length) return fail('Nothing to update — pass at least one property besides nodeId.');
  refreshAfterLegacy(ctx);
  return ok(`Updated ${i.nodeId}: ${applied.join(', ')}.`);
};

/**
 * The tool-side stroke fields (STROKE_PROPS) as a patch on a stored `Stroke`:
 * percentages become fractions, the dash list is trimmed to AE's three pairs,
 * and the Taper / Wave groups are complete objects `normalizeStroke` can
 * drop when they say nothing (an identity taper, a zero wave).
 */
interface StrokeToolInput {
  stroke?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  strokeCap?: string;
  strokeJoin?: string;
  miterLimit?: number;
  strokeDash?: number[];
  strokeDashOffset?: number;
  strokeTaper?: { startLength?: number; endLength?: number; startWidth?: number; endWidth?: number; startEase?: number; endEase?: number };
  strokeWave?: { amount?: number; wavelength?: number; phase?: number; units?: string };
}

type StrokePatch = Partial<Pick<Stroke, 'color' | 'width' | 'opacity' | 'cap' | 'join' | 'miterLimit' | 'dash' | 'dashOffset' | 'taper' | 'wave'>>;

function strokePatchOf(i: StrokeToolInput): StrokePatch {
  const p: StrokePatch = {};
  if (typeof i.stroke === 'string') p.color = i.stroke;
  if (typeof i.strokeWidth === 'number') p.width = Math.max(0, i.strokeWidth);
  if (typeof i.strokeOpacity === 'number') p.opacity = pct(i.strokeOpacity, 100);
  if (i.strokeCap === 'butt' || i.strokeCap === 'round' || i.strokeCap === 'square') p.cap = i.strokeCap;
  if (i.strokeJoin === 'miter' || i.strokeJoin === 'round' || i.strokeJoin === 'bevel') p.join = i.strokeJoin;
  if (typeof i.miterLimit === 'number') p.miterLimit = Math.max(1, i.miterLimit);
  if (Array.isArray(i.strokeDash)) {
    p.dash = i.strokeDash.filter((n) => Number.isFinite(n) && n >= 0).slice(0, MAX_STROKE_DASH_ENTRIES);
  }
  if (typeof i.strokeDashOffset === 'number') p.dashOffset = i.strokeDashOffset;
  if (i.strokeTaper && typeof i.strokeTaper === 'object') {
    const t = i.strokeTaper;
    const ease = (v: number | undefined): number => Math.max(-1, Math.min(1, v ?? 0));
    // A taper whose ends are not given tapers TO A POINT — what "taper" means
    // to anyone asking for one. Width 100 (= 1) at an end leaves it full.
    p.taper = {
      startLength: pct(t.startLength, 0), endLength: pct(t.endLength, 0),
      startWidth: pct(t.startWidth, 0), endWidth: pct(t.endWidth, 0),
      startEase: ease(t.startEase), endEase: ease(t.endEase),
    };
  }
  if (i.strokeWave && typeof i.strokeWave === 'object') {
    const w = i.strokeWave;
    p.wave = {
      amount: Math.max(0, w.amount ?? 0),
      wavelength: Math.max(0, w.wavelength ?? 0),
      phase: w.phase ?? 0,
      ...(w.units === 'cycles' ? { units: 'cycles' as const } : {}),
    };
  }
  return p;
}

const STROKE_FIELD_NAME: Readonly<Record<keyof StrokePatch, string>> = {
  color: 'stroke', width: 'strokeWidth', opacity: 'strokeOpacity', cap: 'strokeCap', join: 'strokeJoin',
  miterLimit: 'miterLimit', dash: 'strokeDash', dashOffset: 'strokeDashOffset', taper: 'strokeTaper', wave: 'strokeWave',
};

const strokeFieldNames = (p: StrokePatch): string[] => (Object.keys(p) as (keyof StrokePatch)[]).map((k) => STROKE_FIELD_NAME[k]);

/**
 * Stroke 1 of the layer's stroke stack (`layer/strokes`, Contents ▸ Stroke),
 * patched whole as the Inspector's stroke rows patch it: created from the
 * default when the layer has none. Text strokes live elsewhere (and have no
 * cap, join, dashes, taper or wave), and a kind with no shape path has no
 * outline to stroke — both refused, not dropped. Returns the refusal, or null
 * when the stroke was written.
 */
async function applyStrokePatch(ctx: ToolContext, nodeId: string, patch: StrokePatch): Promise<ToolResult | null> {
  const kind = (await ctx.scene.get(nodeId))?.kind ?? 'shape';
  if (kind === 'text') {
    const shapeOnly = strokeFieldNames(patch).filter((k) => k !== 'stroke' && k !== 'strokeWidth' && k !== 'strokeOpacity');
    if (shapeOnly.length) {
      return fail(
        `${shapeOnly.join(' / ')} belong to a shape layer's Stroke; a text layer's Character stroke has only colour, width and opacity. ` +
        `For a dashed, tapered or wavy outline on type, convert the text to shapes or draw the line as a shape layer.`,
      );
    }
    // Type's own stroke — the Character panel's Stroke Color / Stroke Width
    // (`text/stroke`, the Text component's latent `strokeWidth`); opacity
    // is the colour's alpha, as in the panel's picker.
    const writes = await textStrokeWrites(nodeId, patch);
    if (!writes) return fail(`Could not set the stroke of text layer '${nodeId}'.`);
    await ctx.engine.apply([{ type: 'setProperties', writes } as Command]);
    return null;
  }
  if (NO_PATH_PIPELINE.has(kind)) {
    return fail(
      `${strokeFieldNames(patch).join(' / ')} apply to shape, solid and text layers; '${nodeId}' is a ${kind}. Stroke a shape layer instead.`,
    );
  }
  const stack = mirrorStrokes(documentMirror(), nodeId);
  const next = stack.length > 0 ? [...stack] : [defaultStroke()];
  next[0] = normalizeStroke({ ...(next[0] ?? defaultStroke()), ...patch, enabled: true });
  await ctx.engine.apply([{
    type: 'setProperty',
    prop: { layer: nodeId, path: 'layer/strokes' },
    value: { kind: 'json', value: JSON.stringify(next) },
  } as Command]);
  return null;
}

/**
 * A text layer's stroke as the Character panel writes it: `text/stroke` (the
 * colour; opacity is its alpha) and the Text component's `strokeWidth`. A
 * colour or width turns No Stroke off. Null when the layer does not address one.
 */
async function textStrokeWrites(nodeId: string, patch: { color?: string; width?: number; opacity?: number }): Promise<PropertyWrite[] | null> {
  const m = documentMirror();
  await m.loadTree(nodeId);
  const text = componentOfType(nodeId, 'Text');
  if (!text) return null;
  const t = activePlayheadSeconds();
  const writes: PropertyWrite[] = [];
  if (patch.color !== undefined || patch.opacity !== undefined) {
    let color = patch.color;
    if (patch.opacity !== undefined) {
      const cur = m.tree(nodeId)?.nodes.get('text/stroke')?.value;
      const c = patch.color !== undefined ? parseCssColor(patch.color) : null;
      const rgb = c ? [c[0], c[1], c[2]]
        : cur?.kind === 'color' ? [cur.value.r * 255, cur.value.g * 255, cur.value.b * 255] : [0, 0, 0];
      color = `rgba(${rgb.map((n) => Math.round(n)).join(', ')}, ${patch.opacity})`;
    }
    const w = fieldWrite(nodeId, text, 'stroke', color, t);
    if (!w) return null;
    writes.push(w);
  }
  if (patch.width !== undefined) {
    const w = memberWrite(nodeId, 'strokeWidth', patch.width, t);
    if (!w) return null;
    writes.push(w);
  }
  if (patch.color !== undefined || (patch.width ?? 0) > 0) {
    const w = fieldWrite(nodeId, text, 'noStroke', false, t);
    if (w) writes.push(w);
  }
  return writes;
}

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
  const valid: Array<{ i: number; k: KeyframeInput }> = [];

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
      !layerInfo(k.nodeId)?.switches.threeD
    ) {
      bad.push(`keyframes[${i}]: '${k.prop}' needs the 3D switch — call update_layer { nodeId: '${k.nodeId}', threeD: true } first.`);
      continue;
    }

    valid.push({ i, k });
  }

  // Where the engine will store each key (the frame-snapped layer axis) — only
  // to spot two requested times collapsing onto one key. The WRITES below
  // speak composition time; the engine converts the value AND its easing
  // together, which is the bug this design exists to prevent. Asked all at
  // once: one query per key in sequence was most of a long track's write time.
  const layerTimes = await Promise.all(valid.map(({ k }) => ctx.time.toLayerTime(k.nodeId, k.t)));
  for (const [n, { i, k }] of valid.entries()) {
    const lt = layerTimes[n]!;
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
    touched.add(trackKey);
    applied++;
  }
  // The writes: one engine batch when the facade has it (a tracked path is
  // hundreds of keys), then the bezier handles, which address existing keys.
  const writes = valid.map(({ k }) => ({ nodeId: k.nodeId, prop: k.prop, t: k.t, value: k.value, easing: k.easing ?? 'linear' }));
  if (ctx.anim.setKeyframes) {
    await ctx.anim.setKeyframes(writes);
  } else {
    for (const w of writes) await ctx.anim.setKeyframe(w.nodeId, w.prop, w.t, w.value, w.easing);
  }
  for (const { k } of valid) {
    if (k.easing === 'bezier' && k.bezier) await ctx.anim.setBezier(k.nodeId, k.prop, k.t, k.bezier);
  }

  // A single keyframe on a property holds a constant — usually a mistake worth
  // naming, since the model thinks it animated something.
  const singles = await filterSeq([...touched], async (key) => {
    const [nodeId, ...rest] = key.split('.');
    const prop = rest.join('.');
    const list = await ctx.anim.tracks(nodeId!);
    // Uniform `scale` keys land on the Scale vector, which tracks report as its
    // two axes: count those, or every scale gesture reads as one key.
    const track = list.find((t) => t.prop === prop) ?? (prop === 'scale' ? list.find((t) => t.prop === 'scaleX') : undefined);
    return (track?.keyframes.length ?? 0) < 2;
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
    return fail(`Expression rejected and not applied: ${err}. Fix that and send the whole expression again; the last expression statement must give the property's value.`);
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

/**
 * Bars, in composition seconds — one `setLayerTiming` for the whole batch.
 *
 * Validated against the bar as it stands, so `outSec` alone may shorten a
 * layer and `inSec` alone may delay it; what is refused is a bar that would
 * end at or before it starts. Partial success: the valid items go through.
 */
const setLayerTiming: AiTool['handler'] = async (input, ctx) => {
  const { items } = input as { items: LayerTimingSeconds[] };
  const bad: string[] = [];
  const good: LayerTimingSeconds[] = [];
  for (const [n, it] of items.entries()) {
    if (!await ctx.scene.has(it.nodeId)) { bad.push(`items[${n}]: ${await unknownNode(ctx, it.nodeId)}`); continue; }
    if (it.startSec === undefined && it.inSec === undefined && it.outSec === undefined) {
      bad.push(`items[${n}]: nothing to set on ${it.nodeId} — give inSec, outSec or startSec.`);
      continue;
    }
    const t = layerInfo(it.nodeId)?.timing;
    const inSec = it.inSec ?? (t ? flicksToSeconds(t.inPoint) : 0);
    const outSec = it.outSec ?? (t ? flicksToSeconds(t.outPoint) : Number.POSITIVE_INFINITY);
    if (outSec <= inSec) {
      bad.push(
        `items[${n}]: ${it.nodeId} would end (${outSec}s) at or before it starts (${inSec}s) — ` +
          `outSec must be after inSec.`,
      );
      continue;
    }
    good.push(it);
  }
  const applied = good.length > 0 ? await applyLayerTiming(ctx.engine, good) : 0;
  const summary = good
    .slice(0, 6)
    .map((g) => `${g.nodeId} ${g.inSec ?? '…'}s→${g.outSec ?? '…'}s`)
    .join(', ');
  const done = `Set the bar of ${applied} layer(s)${summary ? `: ${summary}${good.length > 6 ? ', …' : ''}` : ''}.`;
  if (bad.length) return { ok: false, content: `${done} Rejected:\n- ${bad.join('\n- ')}` };
  return ok(`${done} Outside its bar a layer does not render; keyframes keep their composition times.`, { applied });
};

// ── Write: effects + text ─────────────────────────────────────────

const addEffectHandler: AiTool['handler'] = async (input, ctx) => {
  const { nodeId, type, amount, id: wantedId, params: initial } = input as {
    nodeId: string; type: string; amount?: number; id?: string; params?: Record<string, unknown>;
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
  // Initial values: the same write update_effect_param makes, one per key.
  const set: string[] = [];
  const unknown: string[] = [];
  for (const [key, raw] of Object.entries(initial ?? {})) {
    const def = d?.params.find((p) => p.key === key);
    const known = d ? def !== undefined : true;
    // A point list is a value too: Curves / Lumetri curves take [[x, y], …].
    if (!known || !(typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean' || Array.isArray(raw))) {
      unknown.push(key);
      continue;
    }
    // A layer param takes a layer id — or the handle a create_layer in this turn bound.
    const resolved = def?.type === 'layer' && typeof raw === 'string' && raw !== '' ? resolveAlias(ctx, raw) : raw;
    if (def?.type === 'layer' && typeof resolved === 'string' && resolved !== '' && !(await ctx.scene.has(resolved))) {
      unknown.push(key);
      continue;
    }
    // Held to the catalog's range, and said (B4): the engine clamps silently.
    const { value, note } = clampEffectParam(def, resolved);
    await ctx.scene.updateEffectParam(nodeId, id, key, value);
    set.push(`${key}=${Array.isArray(value) ? JSON.stringify(value) : String(value)}${note ? ` (${note})` : ''}`);
  }
  const primary = d?.params.find((p) => p.type === 'number');
  const params = d?.params.map((p) => p.key).join(', ') ?? '';
  return ok(
    `Added ${type} to ${nodeId} with effectId '${id}'.` +
      (set.length ? ` Set ${set.join(', ')}.` : '') +
      (unknown.length ? ` NOT set (unknown key or non-scalar value): ${unknown.join(', ')}.` : '') +
      ` Params: ${params}.` +
      (primary
        ? ` ${primary.key} ranges ${primary.min}..${primary.max}${primary.unit ? ` ${primary.unit}` : ''}.`
        : '') +
      ` Animate any numeric param by keyframing prop "effect.${id}.<param>".` +
      (EFFECT_AI_NOTES[type] ? ` NOTE: ${EFFECT_AI_NOTES[type]}` : ''),
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

/**
 * The default range-selector sweep (B3): offset 0 → 100 over a Start 0 /
 * End 100 selector uncovers the characters once, left to right. The scene-
 * script compiler (packages/author) spells the same defaults out.
 */
export const SWEEP_FROM_OFFSET = 0;
export const SWEEP_TO_OFFSET = 100;

const textAnimator: AiTool['handler'] = async (input, ctx) => {
  const i = input as Record<string, unknown> & { nodeId: string; index?: number; remove?: boolean };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));
  if (kindOf(i.nodeId) !== 'text') {
    return fail(`${i.nodeId} is not a text layer — text animators only apply to text.`);
  }

  let index = i.index;
  if (index === undefined) {
    index = await addTextAnimatorGroup(ctx.engine, i.nodeId);
  } else {
    const count = (await textAnimators(ctx.engine, i.nodeId)).length;
    if (index >= count) return fail(`${i.nodeId} has no animator at index ${index}. It has ${count}.`);
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
  if (Object.keys(patch).length) await patchTextAnimator(ctx.engine, i.nodeId, index, patch);

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
    // The selector is Start 0 / End 100, so Offset o covers the characters in
    // [o%, o% + 100%]: 0 covers them all, 100 none. The default sweep 0 → 100
    // therefore uncovers the text once, left to right (a reveal when the
    // animator hides what it covers). The old −100 → 100 covered the text in
    // the MIDDLE of the sweep and left it uncovered at both ends (B3).
    const fromOffset = sweep.fromOffset ?? SWEEP_FROM_OFFSET;
    const toOffset = sweep.toOffset ?? SWEEP_TO_OFFSET;
    await ctx.anim.setKeyframe(i.nodeId, prop, a, fromOffset, easing);
    await ctx.anim.setKeyframe(i.nodeId, prop, b, toOffset, 'linear');
    if (easing === 'bezier') {
      // A default that is not linear: a linear selector sweep gives every
      // character exactly the same timing, which is the flat machine-gun type-on.
      await ctx.anim.setBezier(i.nodeId, prop, a, (sweep.bezier as [number, number, number, number]) ?? [0.22, 0.61, 0.36, 1]);
    }
    swept = ` Selector offset sweeps ${fromOffset}% → ${toOffset}% between ${sweep.fromSec}s and ${sweep.toSec}s` +
      ' (Start 0 / End 100 covers [offset, offset + 100]% of the characters: offset 0 covers all of them, ±100 none;' +
      ' 0 → 100 uncovers the text once, left to right; 100 → 0 covers it once).';
    // A bump is below full strength at its edges and selects nothing outside
    // itself, so a hiding animator leaves those characters showing (Operand).
    // AE ramps hold full strength on one side (Ramp Up past the window's end,
    // Ramp Down before its start): swept fully across they hide all, then none.
    const shape = typeof i.shape === 'string' ? i.shape : undefined;
    const rampUp = shape === 'rampUp';
    if (rampUp || shape === 'rampDown') {
      const full = rampUp ? fromOffset <= -100 && toOffset >= 100 : fromOffset >= 100 && toOffset <= -100;
      if (!full) {
        swept += ` NOTE: shape ${shape} holds full strength only ${rampUp ? 'past the window\'s end' : 'before the window\'s start'} and ramps` +
          ' inside it, so this sweep leaves some characters part-selected at one end. For a soft reveal (opacity / scale 0) sweep' +
          ` ${rampUp ? '−100 → 100' : '100 → −100'}; for a hard one use shape square.`;
      }
    } else if (shape && shape !== 'square') {
      swept += ` NOTE: shape ${shape} never selects every character fully — characters outside the window and at its soft edges keep` +
        ' (most of) their own look before and after the sweep. For a reveal (opacity / scale 0) use shape square (its smoothness softens' +
        ' the edge) or rampUp swept −100 → 100.';
    }
  }

  refreshAfterLegacy(ctx);
  return ok(
    `Text animator ${index} on ${i.nodeId} is ready.${swept}` +
    (sweep ? '' : ` It has a STATIC selector, so it currently applies a constant style rather than an animation — pass \`sweep\`, or keyframe "ta.${index}.offset".`),
    { index },
  );
};

// ── Media ─────────────────────────────────────────────────────────

/** list_fonts' friendly script names → the ISO 15924 codes FontInfo.scripts carries. */
const SCRIPT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ja: ['Jpan', 'Hira', 'Kana'], japanese: ['Jpan', 'Hira', 'Kana'],
  zh: ['Hani', 'Hans', 'Hant'], chinese: ['Hani', 'Hans', 'Hant'],
  ko: ['Hang', 'Kore'], korean: ['Hang', 'Kore'],
  hi: ['Deva'], hindi: ['Deva'], th: ['Thai'], thai: ['Thai'],
  ar: ['Arab'], arabic: ['Arab'], he: ['Hebr'], hebrew: ['Hebr'],
  ru: ['Cyrl'], el: ['Grek'], latin: ['Latn'],
};

/** list_fonts' grouping: faces → families (styles, scripts), filtered by script (alias or ISO 15924), sorted. */
export function fontFamiliesOf(
  fonts: ReadonlyArray<{ family: string; style: string; scripts: readonly string[] }>,
  script?: string,
): Array<[string, { styles: Set<string>; scripts: Set<string> }]> {
  const want = script ? (SCRIPT_ALIASES[script.toLowerCase()] ?? [script]) : null;
  const families = new Map<string, { styles: Set<string>; scripts: Set<string> }>();
  for (const f of fonts) {
    if (want && !f.scripts.some((s) => want.some((w) => w.toLowerCase() === s.toLowerCase()))) continue;
    const e = families.get(f.family) ?? { styles: new Set<string>(), scripts: new Set<string>() };
    e.styles.add(f.style);
    for (const s of f.scripts) e.scripts.add(s);
    families.set(f.family, e);
  }
  return [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const listFonts: AiTool['handler'] = async (input) => {
  const i = input as { query?: string; script?: string; limit?: number };
  const res = await engine().query({ type: 'listFonts', query: i.query ?? '' });
  if (!res.ok) return fail(`listFonts: ${res.error.message}`);
  const all = fontFamiliesOf(res.value.fonts, i.script);
  const families = new Map(all);
  const limit = i.limit ?? 80;
  const rows = all.slice(0, limit);
  if (rows.length === 0) {
    return ok(`No font${i.script ? ` covering ${i.script}` : ''}${i.query ? ` matching "${i.query}"` : ''}. Text in that script will render as boxes in any other face.`, { families: [] });
  }
  const lines = rows.map(([fam, e]) => `- ${fam} (${[...e.styles].slice(0, 6).join(', ')}${e.styles.size > 6 ? ', …' : ''}) scripts: ${[...e.scripts].slice(0, 10).join(' ')}`);
  return ok(`${families.size} famil${families.size === 1 ? 'y' : 'ies'}${families.size > limit ? ` (first ${limit})` : ''}:\n${lines.join('\n')}`, { families: rows.map(([f]) => f) });
};

/** A stored stroke in the tool's own units (STROKE_PROPS): percentages, px, degrees. */
function strokeReadback(s: Stroke): { row: Record<string, unknown>; text: string } {
  const r = (n: number): number => Math.round(n * 100) / 100;
  const row: Record<string, unknown> = {
    stroke: s.color, strokeWidth: s.width, strokeOpacity: r(s.opacity * 100), strokeCap: s.cap, strokeJoin: s.join,
    ...(s.miterLimit !== undefined ? { miterLimit: s.miterLimit } : {}),
    ...(s.dash.length ? { strokeDash: s.dash, strokeDashOffset: s.dashOffset ?? 0 } : {}),
    ...(s.taper ? {
      strokeTaper: {
        startLength: r(s.taper.startLength * 100), endLength: r(s.taper.endLength * 100),
        startWidth: r(s.taper.startWidth * 100), endWidth: r(s.taper.endWidth * 100),
        startEase: s.taper.startEase, endEase: s.taper.endEase,
      },
    } : {}),
    ...(s.wave ? { strokeWave: { amount: s.wave.amount, wavelength: s.wave.wavelength, phase: s.wave.phase, ...(s.wave.units ? { units: s.wave.units } : {}) } } : {}),
  };
  const parts = [`${s.color} ${s.width}px`, `${s.cap} cap`, `${s.join} join`];
  if (s.dash.length) parts.push(`dash [${s.dash.join(', ')}]${s.dashOffset ? ` offset ${s.dashOffset}` : ''}`);
  if (s.taper) parts.push(`taper ${r(s.taper.startLength * 100)}%/${r(s.taper.endLength * 100)}%`);
  if (s.wave) parts.push(`wave ${s.wave.amount}px every ${s.wave.wavelength}${s.wave.units === 'cycles' ? ' cycles' : 'px'}`);
  return { row, text: parts.join(', ') };
}

const inspectLayers: AiTool['handler'] = async (input) => {
  const i = input as { nodeIds?: string[]; t?: number };
  const m = documentMirror();
  const comp = activeCompRootId() as string;
  const ids = (i.nodeIds && i.nodeIds.length > 0 ? i.nodeIds : [...(m.comp(comp)?.layers ?? [])]).slice(0, 60);
  const unknown = ids.filter((id) => !m.layer(id));
  if (unknown.length > 0) return fail(`Unknown layer id(s): ${unknown.join(', ')}.`);
  const seconds = i.t ?? activePlayheadSeconds();
  const time = secondsToFlicks(seconds);
  const box = async (includeEffects: boolean): Promise<Map<string, { x: number; y: number; width: number; height: number }>> => {
    const r = await engine().query({ type: 'getLayerBounds', layers: ids, time, space: 'comp', includeEffects });
    return new Map(r.ok ? r.value.bounds.map((b) => [b.layer, b.bounds] as const) : []);
  };
  // The plain box as the frame shows it: a 3D layer projected through the camera.
  const [plain, withFx] = await Promise.all([renderedBoxes(ids, seconds), box(true)]);
  const errorsByComp = new Map<string, readonly { layer: string; stage: string; message: string }[]>();
  const errorsOf = (id: string): string[] => {
    const c = m.layer(id)?.comp ?? comp;
    if (!errorsByComp.has(c)) errorsByComp.set(c, m.layerErrors(c));
    return errorsByComp.get(c)!.filter((e) => e.layer === id).map((e) => `${e.stage}: ${e.message}`);
  };
  const compInfo = m.comp(comp)?.settings;
  const fmt = (b?: { x: number; y: number; width: number; height: number }): string =>
    b ? `x ${Math.round(b.x)}..${Math.round(b.x + b.width)}, y ${Math.round(b.y)}..${Math.round(b.y + b.height)} (${Math.round(b.width)}×${Math.round(b.height)})` : 'none';
  const rows: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const id of ids) {
    await m.loadTree(id);
    const info = m.layer(id)!;
    const kind = kindOf(id) ?? info.kind;
    const b = plain.get(id);
    const fx = withFx.get(id);
    const fill = colorValueHex(m.valueAt(id, 'layer/fill', time) ?? m.property(id, 'layer/fill')?.value);
    // Asked of the engine, not valueAt: the mirror's cache lands asynchronously, so a first read
    // returned the pre-expression base value.
    const evald = await engine().query({ type: 'getPropertyValues', props: [{ layer: id, path: 'transform/opacity' }, { layer: id, path: 'transform/rotation' }], time, evaluated: true });
    const opacity = evald.ok ? evald.value.values[0]?.value : m.valueAt(id, 'transform/opacity', time);
    const rotation = evald.ok ? evald.value.values[1]?.value : undefined;
    const driven = (path: string): boolean => { const p = m.property(id, path); return !!p && p.expression !== '' && p.expressionEnabled; };
    const row: Record<string, unknown> = { id, name: info.name, kind, bounds: b ?? null, boundsWithEffects: fx ?? null };
    let line = `- ${id} "${info.name}" (${kind}) bounds ${fmt(b)}`;
    if (fx && b && (fx.width > b.width + 1 || fx.height > b.height + 1)) line += `, with effects ${fmt(fx)}`;
    if (b && compInfo && (b.x + b.width <= 0 || b.y + b.height <= 0 || b.x >= compInfo.width || b.y >= compInfo.height)) line += ' — OFF-SCREEN';
    if (fill) { row.fill = fill; line += `, fill ${fill}`; }
    // Stroke 1 as written (update_layer's STROKE_PROPS read back): the model
    // can see a dash, taper or wave landed instead of trusting the reply.
    const stroke = kind === 'text' ? undefined : mirrorStrokes(m, id)[0];
    if (stroke && stroke.enabled && stroke.width > 0) {
      const s = strokeReadback(stroke);
      row.stroke = s.row;
      line += `, stroke ${s.text}`;
    }
    if (opacity?.kind === 'scalar') { row.opacity = opacity.value; line += `, opacity ${Math.round(opacity.value)}%${driven('transform/opacity') ? ' (from expression)' : ''}`; }
    if (rotation?.kind === 'scalar' && (rotation.value !== 0 || driven('transform/rotation'))) { row.rotation = rotation.value; line += `, rotation ${Math.round(rotation.value * 100) / 100}°${driven('transform/rotation') ? ' (from expression)' : ''}`; }
    if (kind === 'text') {
      const fam = m.property(id, 'text/fontFamily')?.value;
      if (fam?.kind === 'string') { row.fontFamily = fam.value; line += `, font "${fam.value}"`; }
      const t = await engine().query({ type: 'getTextLayout', layer: id, time });
      if (t.ok) {
        row.lines = t.value.lines;
        row.textBox = t.value.box;
        line += `, ${t.value.lines} line(s)`;
      }
    }
    const errs = errorsOf(id);
    if (errs.length > 0) { row.problems = errs; line += `\n    PROBLEMS: ${errs.join('; ')}`; }
    rows.push(row);
    lines.push(line);
  }
  return ok(`At ${seconds.toFixed(2)}s (composition ${compInfo?.width ?? '?'}×${compInfo?.height ?? '?'}):\n${lines.join('\n')}`, { layers: rows });
};

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

  // The Project panel's insert (contain-fitted, SVG / audio routed), built
  // off-document and sent as ONE pasteLayers; placed in the same build.
  const id = await insertAssetLayer(ctx.engine, asset, { x, y });
  if (!id) return fail(`Placed "${asset.name}" but could not resolve the new layer id.`);
  bindAlias(ctx, alias, id);
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

  // Same request, same asset: a replayed call (an author-mode revision) must
  // not generate — and bill — the same picture again.
  const key = generationKey({ kind: 'image', prompt, model: provider, aspect, ...dims });
  const reusedId = cachedAsset(key, (id) => useAssetStore.getState().assets.some((a) => a.id === id));
  const reused = reusedId ? useAssetStore.getState().assets.find((a) => a.id === reusedId) : undefined;
  if (reused) {
    const id = await insertAssetLayer(ctx.engine, reused, { x, y });
    if (!id) return fail(`Could not place the existing image "${reused.name}".`);
    bindAlias(ctx, alias, id);
    return ok(`Reused the image "${reused.name}" generated earlier for the same prompt and placed it as layer '${id}'.`, { id, assetId: reused.id, reused: true });
  }

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

  // The bytes become a footage item through the engine (`importBytes`: the
  // same importer as a picked file), then a layer like any placed asset.
  const asset = await importAssetBytes(ctx.engine, file);
  rememberAsset(key, asset.id);
  const id = await insertAssetLayer(ctx.engine, asset, { x, y });
  if (!id) return fail(`Generated "${name}" and added it to the library, but could not resolve the new layer id.`);
  bindAlias(ctx, alias, id);
  // No credits any more — image generation runs on the user's own key and their
  // provider bills them directly, so there is nothing of ours to report.
  return ok(
    `Generated an image and placed it as layer '${id}'.` +
      ` It is in the asset library as "${name}" — reuse it rather than generating again.`,
    { id, assetId: asset.id },
  );
};

async function bytesToAsset(
  ctx: ToolContext,
  res: AiMediaResult,
  name: string,
  mimeOverride?: string,
): Promise<{ ok: true; asset: ImportedAsset } | { ok: false; message: string }> {
  if (!res.ok) return { ok: false, message: res.message };
  const mime = mimeOverride ?? res.mime;
  const bytes = decodeBase64Bytes(res.base64);
  const file = new File([bytes as BlobPart], name, { type: mime });
  return { ok: true, asset: await importAssetBytes(ctx.engine, file) };
}

/**
 * Generate a clip and place it: model, length, frame shape, fit and WHEN.
 *
 * - The model is the call's, else the user's default (Settings → Assistant →
 *   Media), which is the free preview until they pick a paid one.
 * - The length is snapped to one the model makes, and the reply says so.
 * - The same request in the same session reuses its asset (aiMediaCache): an
 *   author-mode revision that replays this call must not pay for it twice.
 * - `startSec` places the layer's bar (`applyLayerTiming`): the clip's first
 *   frame plays at startSec and the layer ends with the clip.
 * - `fit: "cover"` scales the contain-fitted layer up until it fills the frame.
 */
const generateVideo: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    id?: string; prompt: string; durationSec?: number; aspect?: 'landscape' | 'portrait' | 'square';
    startSec?: number; model?: string; fit?: 'contain' | 'cover'; x?: number; y?: number;
  };
  const model = videoModel(i.model ?? useAiMediaPrefsStore.getState().videoModel) ?? videoModel(PREVIEW_VIDEO_MODEL)!;
  const durationSec = snapVideoDuration(model, i.durationSec);
  const aspect = i.aspect && model.aspects.includes(i.aspect) ? i.aspect : model.aspects[0]!;
  const notes: string[] = [];
  if (i.durationSec !== undefined && i.durationSec !== durationSec) notes.push(`${model.label} makes ${model.durations.join(' / ')} s clips, so it is ${durationSec}s, not ${i.durationSec}s`);
  if (i.aspect && i.aspect !== aspect) notes.push(`${model.label} makes ${model.aspects.join(' / ')} clips, so it is ${aspect}`);

  const key = generationKey({ kind: 'video', prompt: i.prompt, model: model.id, aspect, durationSec });
  const assets = () => useAssetStore.getState().assets;
  const reusedId = cachedAsset(key, (id) => assets().some((a) => a.id === id));
  let asset = reusedId ? assets().find((a) => a.id === reusedId) : undefined;
  let name = asset?.name ?? '';
  if (!asset) {
    let res: AiMediaResult;
    try {
      res = await generateVideoBytes({ prompt: i.prompt, durationSec, model: model.id, aspect });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(`Video generation failed: ${message}. The scene is unchanged.`);
    }
    if (!res.ok) return fail(`Video generation failed: ${res.message}. The scene is unchanged.`);
    name = `${i.prompt.slice(0, 36).replace(/[^\w -]/g, '').trim() || 'generated'}.${res.extension}`;
    const placed = await bytesToAsset(ctx, res, name, 'video/mp4');
    if (!placed.ok) return fail(placed.message);
    asset = placed.asset;
    rememberAsset(key, asset.id);
  }

  const nodeId = await insertAssetLayer(ctx.engine, asset, { x: i.x, y: i.y });
  if (!nodeId) return fail(`Generated "${name}" but could not resolve the new layer id.`);
  bindAlias(ctx, i.id, nodeId);

  if (i.fit === 'cover') {
    const comp = await ctx.comp.get();
    const w = asset.metadata?.width;
    const h = asset.metadata?.height;
    if (w && h) {
      // The insert contain-fits; cover is that, scaled by the ratio of the two fits.
      const k = Math.max(comp.width / w, comp.height / h) / Math.min(comp.width / w, comp.height / h);
      await ctx.scene.setProp(nodeId, 'scaleX', k);
      await ctx.scene.setProp(nodeId, 'scaleY', k);
    } else {
      notes.push('the clip\'s size is not known yet, so it is contain-fitted rather than covering the frame');
    }
  }
  const start = i.startSec ?? 0;
  // The bar ends with the clip that actually arrived: a model may return a few
  // frames under the length it was asked for, and a bar past the footage's end
  // is refused by the engine.
  const clipSec = asset.metadata?.duration;
  const lengthSec = clipSec !== undefined && clipSec > 0 && clipSec < durationSec ? clipSec : durationSec;
  if (lengthSec < durationSec) notes.push(`the clip is ${Number(lengthSec.toFixed(2))}s long, so the layer ends there`);
  await applyLayerTiming(ctx.engine, [{ nodeId, startSec: start, inSec: start, outSec: start + lengthSec }]);

  return ok(
    `${reusedId ? 'Reused' : 'Generated'} a ${durationSec}s ${aspect} clip with ${model.label} and placed it as layer '${nodeId}', ` +
      `playing ${start}s → ${start + lengthSec}s${i.fit === 'cover' ? ', covering the frame' : ''}. Asset "${name}" is in the library.` +
      (notes.length ? ` Note: ${notes.join('; ')}.` : '') +
      (model.paid ? '' : ' This is the free PREVIEW clip — a stand-in for layout and timing; pick a paid video model in Settings for real footage.'),
    { id: nodeId, assetId: asset.id, model: model.id, durationSec, reused: !!reusedId },
  );
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
  const placed = await bytesToAsset(ctx, res, name, 'audio/mpeg');
  if (!placed.ok) return fail(placed.message);

  const nodeId = await insertAssetLayer(ctx.engine, placed.asset);
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
  const placed = await bytesToAsset(ctx, res, label, res.mime);
  if (!placed.ok) return fail(placed.message);

  // Place a 3D null as a scene placeholder — the compositor does not yet draw
  // glTF meshes, but the asset is in the library and the layer anchors it.
  const comp = await ctx.comp.get();
  const nodeId = await insertModelPlaceholder(ctx.engine, label.replace(/\.(glb|gltf)$/i, '') || '3D Model', {
    x: comp.width / 2,
    y: comp.height / 2,
  }, placed.asset.id);
  if (!nodeId) return fail(`Generated a 3D model (asset ${placed.asset.id}) but could not place its layer.`);

  return ok(
    `Generated a 3D model (asset ${placed.asset.id}) and placed null layer '${nodeId}' in 3D space. ` +
    'The GLB is in the library; mesh draw of glTF is not in the compositor yet — the null marks its place.',
    { id: nodeId, assetId: placed.asset.id },
  );
};

const placeBehindSubjectTool: AiTool['handler'] = async (input, ctx) => {
  const i = input as { nodeIds: string[]; point?: { x: number; y: number } };
  for (const id of i.nodeIds) if (!await ctx.scene.has(id)) return fail(await unknownNode(ctx, id));
  const r = await placeBehindSubject(i.nodeIds, i.point ? { point: i.point } : {});
  if (!r.ok) return fail(r.message);
  const how = r.matte === 'kept'
    ? 'it already had a subject matte'
    : r.matte === 'made'
      ? `the subject was selected over ${r.frames ?? 0} frames`
      : 'no subject yet: the user is asked to click the subject with the Object Matte tool (or call again with `point`)';
  return ok(`Placed ${i.nodeIds.join(', ')} behind the subject of footage '${r.subject}'; ${how}.`, { subject: r.subject, matte: r.matte });
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
  return ok(
    `Queued ${format ?? 'mp4'} export as job '${result.jobId}' in the Render Queue` +
    (result.started ? ' and started rendering.' : '. Open Render Queue to choose an output folder and Start.') +
    ` Follow it with get_export_status { jobId: '${result.jobId}' }.`,
    { jobId: result.jobId },
  );
};

/** A job main's export queue renders (handed over from the page's Render Queue), as a status row. */
function mainExportRow(j: ExportJobRecord, id: string): { id: string; comp: string; status: string; progress: number; output: string; error?: string } {
  return {
    id,
    comp: j.spec.label,
    status: j.status,
    progress: Math.round((j.progress.fraction ?? 0) * 100),
    output: j.spec.outPath,
    ...(j.error ? { error: j.error } : {}),
  };
}

const getExportStatus: AiTool['handler'] = async (input) => {
  const { jobId } = input as { jobId?: string };
  const q = useRenderQueueStore.getState();
  const main = useExportQueueStore.getState().jobs;
  const jobs = jobId ? q.jobs.filter((j) => j.id === jobId) : q.jobs;
  // Started jobs leave the page's list for main's queue (export_video
  // immediate, In Motion 2026-10-15): follow the id there.
  if (jobId && jobs.length === 0) {
    const mainId = handedOverJobId(jobId) ?? jobId;
    const m = main.find((j) => j.id === mainId);
    if (m) {
      const r = mainExportRow(m, jobId);
      return ok(`- ${r.id} "${r.comp}": ${r.status}${r.status === 'rendering' ? ` ${r.progress}%` : ''} → ${r.output}${r.error ? ` (error: ${r.error})` : ''}`, { jobs: [r] });
    }
    return fail(`No Render Queue job '${jobId}'. Jobs: ${[...q.jobs.map((j) => j.id), ...main.map((j) => j.id)].join(', ') || '(none)'}.`);
  }
  if (!jobId && main.length > 0) {
    const rows = main.map((j) => mainExportRow(j, j.id));
    const pending = q.jobs.length ? `\n${q.jobs.length} more waiting in the Render Queue.` : '';
    return ok(rows.map((r) => `- ${r.id} "${r.comp}": ${r.status}${r.status === 'rendering' ? ` ${r.progress}%` : ''} → ${r.output}${r.error ? ` (error: ${r.error})` : ''}`).join('\n') + pending, { jobs: rows });
  }
  if (jobs.length === 0) return ok('The Render Queue is empty.', { jobs: [] });
  const sep = q.outputDir && /\\/.test(q.outputDir) ? '\\' : '/';
  const file = (p: string): string => (q.outputDir ? `${q.outputDir.replace(/[\\/]+$/, '')}${sep}${p}` : p);
  const rows = jobs.map((j) => {
    const waiting = j.status === 'queued' && !q.outputDir;
    return {
      id: j.id,
      comp: j.compositionName,
      status: waiting ? 'waiting for an output folder' : j.status,
      progress: Math.round(j.progress * 100),
      output: file(j.outputPath),
      ...(j.error ? { error: j.error } : {}),
      ...(j.attention ? { attention: j.attention } : {}),
    };
  });
  const lines = rows.map((r) =>
    `- ${r.id} "${r.comp}": ${r.status}${r.status === 'rendering' ? ` ${r.progress}%` : ''} → ${r.output}` +
    (r.error ? ` (error: ${r.error})` : '') + (r.attention ? ` (${r.attention})` : ''));
  const needsFolder = rows.some((r) => r.status === 'waiting for an output folder');
  return ok(
    lines.join('\n') + (needsFolder ? '\nThe user must choose an output folder in the Render Queue (one dialog) before anything renders.' : ''),
    { jobs: rows },
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

  const nodeId = await insertSvgMarkupLayer(ctx.engine, markup, name, {
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
  const layer = layerInfo(nodeId);
  if (!layer) return fail(`No layer with id '${nodeId}'.`);

  const src = layer.source ? documentMirror().item(layer.source)?.mediaUrl : undefined;
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

  let asset: ImportedAsset;
  try {
    // A reference image the user attached to the AI prompt, imported as
    // footage through the engine (`importBytes`).
    asset = await importAssetBytes(ctx.engine, file);
  } catch (err) {
    return fail(`Failed to import reference image: ${err instanceof Error ? err.message : err}`);
  }

  const id = await insertAssetLayer(ctx.engine, asset, { x, y });
  if (!id) return fail(`Placed attachment "${asset.name}" but could not resolve the new layer id.`);
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
    x?: number;
    y?: number;
  };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

  // Size the mask to the layer's bounds unless told otherwise. Text has no
  // width/height prop, so fall back to a sensible square the AI can resize.
  const box = await layerBox(i.nodeId);
  const w = i.width ?? (box.width !== undefined && box.width > 0 ? box.width : 200);
  const h = i.height ?? (box.height !== undefined && box.height > 0 ? box.height : 200);

  const path = maskPathFor(i.shape, w, h, i.x ?? 0, i.y ?? 0);
  if (i.mode) path.mode = i.mode;
  if (i.feather !== undefined) path.feather = i.feather;
  if (i.opacity !== undefined) path.opacity = i.opacity;
  if (i.expansion !== undefined) path.expansion = i.expansion;
  if (i.inverted !== undefined) path.inverted = i.inverted;

  // `addMask` (+ its Feather / Opacity / Expansion): the engine mints the id.
  const maskId = await addMaskFromPath(ctx.engine, i.nodeId, path, maskToBezier(path));
  return ok(
    `Added a ${i.shape} mask (${Math.round(w)}×${Math.round(h)}, mode ${path.mode}) to ${i.nodeId} ` +
      `with maskId '${maskId}'. It clips the layer to the ${path.inverted ? 'outside' : 'inside'} of the shape.`,
    { maskId },
  );
};

/** A rectangle / ellipse mask outline `w × h`, centred `(x, y)` from the layer centre (layer px). */
function maskPathFor(shape: 'rectangle' | 'ellipse', w: number, h: number, x: number, y: number): MaskPath {
  const path = shape === 'ellipse' ? ellipseMask(w, h) : rectangleMask(w, h);
  if (x !== 0 || y !== 0) {
    path.points = path.points.map((p) => ({ ...p, x: p.x + x, y: p.y + y, inX: p.inX + x, inY: p.inY + y, outX: p.outX + x, outY: p.outY + y }));
  }
  return path;
}

interface MaskShapeArgs { shape?: 'rectangle' | 'ellipse'; width?: number; height?: number; x?: number; y?: number }

const updateMask: AiTool['handler'] = async (input, ctx) => {
  const i = input as MaskShapeArgs & {
    nodeId: string; maskId: string; remove?: boolean; mode?: string; feather?: number; opacity?: number;
    expansion?: number; inverted?: boolean; keys?: Array<MaskShapeArgs & { t: number }>;
  };
  if (!await ctx.scene.has(i.nodeId)) return fail(await unknownNode(ctx, i.nodeId));
  await documentMirror().loadTree(i.nodeId);
  const masks = mirrorMaskIds(documentMirror().tree(i.nodeId));
  if (!masks.includes(i.maskId)) {
    return fail(`'${i.nodeId}' has no mask '${i.maskId}'. Its masks: ${masks.join(', ') || '(none — create_mask first)'}.`);
  }
  if (i.remove) {
    await removeMask(ctx.engine, i.nodeId, i.maskId);
    return ok(`Deleted mask '${i.maskId}' from ${i.nodeId}.`);
  }
  const box = await layerBox(i.nodeId);
  const outline = (a: MaskShapeArgs): BezierPath => {
    const shape = a.shape ?? i.shape ?? 'rectangle';
    const w = a.width ?? i.width ?? (box.width !== undefined && box.width > 0 ? box.width : 200);
    const h = a.height ?? i.height ?? (box.height !== undefined && box.height > 0 ? box.height : 200);
    return maskToBezier(maskPathFor(shape, w, h, a.x ?? i.x ?? 0, a.y ?? i.y ?? 0));
  };
  const reshaped = i.shape !== undefined || i.width !== undefined || i.height !== undefined || i.x !== undefined || i.y !== undefined;
  const done: string[] = [];
  const patch: MaskPatch = {};
  if (reshaped && !i.keys) { patch.path = outline({}); done.push('outline'); }
  for (const k of ['feather', 'opacity', 'expansion', 'mode', 'inverted'] as const) {
    if (i[k] !== undefined) { (patch as Record<string, unknown>)[k] = i[k]; done.push(k); }
  }
  await patchMask(ctx.engine, i.nodeId, i.maskId, patch);
  if (i.keys) {
    await keyMaskPath(ctx.engine, i.nodeId, i.maskId, i.keys.map((k) => ({ t: k.t, path: outline(k) })));
    done.push(`${i.keys.length} Mask Path key(s) at ${i.keys.map((k) => `${k.t}s`).join(', ')}`);
  }
  if (done.length === 0) return fail('Nothing to change — pass a shape / size / offset, a style field, keys, or remove: true.');
  return ok(`Updated mask '${i.maskId}' on ${i.nodeId}: ${done.join(', ')}.`);
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

// add_camera_move (every camera move: recipes, techniques, rig / fly-to / path / shake) — cameraMoveTool.ts.
// The registry runs a technique's emitted calls through these same handlers.
const addCameraMove: AiTool['handler'] = makeAddCameraMove(() => {
  const r = new ToolRegistry();
  for (const t of buildAiTools()) r.register(t);
  return r;
});

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
  const i = input as { index: number; startSec: number; durationSec: number; background?: string; transition?: 'dissolve' | 'cut'; style?: string; append?: boolean };
  // A scene that already exists is REPLACED, not stacked: the second call of
  // add_scene { index: 2 } used to put a second background and a second set of
  // content under the first, and the comp carried the whole script twice
  // (docs/PROGRAM_3D_PERF_UX.md M1). One handler call = one undo entry, so the
  // removal and the rebuild undo together.
  let replaced = 0;
  if (i.append !== true) {
    for (const old of sceneElementIds(i.index)) {
      if (!(await ctx.scene.has(old))) continue;
      await ctx.scene.remove(old);
      replaced++;
    }
    forgetSceneElements(i.index);
  }
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
      `Content added now enters at ${i.startSec}s and exits at its end.` +
      (replaced > 0 ? ` Replaced the scene ${i.index} built earlier (${replaced} layer(s) removed; pass append: true to keep an earlier build).` : ''),
    { id, ...(replaced > 0 ? { replaced } : {}) },
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
    name: string; x: number; y: number; kind?: string;
    rotation?: number; stiffness?: number; scale?: number; overlap?: number;
  }[];
  mesh?: { density?: number; expansion?: number; mode?: string; solver?: string; maxRotationDeg?: number; traceAccuracy?: number; alphaThreshold?: number };
  append?: boolean;
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
  const puppetKind = kindOf(i.layerId);
  if (puppetKind && !isRiggableKind(puppetKind)) {
    return fail(
      `Layer '${i.layerId}' is a ${puppetKind} — puppet rigs only apply to shape or image layers. ` +
        `Rasterize it first (the "Rig Logo for Animation" command flattens a group/precomp to a single riggable image).`,
    );
  }
  // `append`: the stored rig's pins and mesh stay, the new pins join them
  // (their tracks survive — a replaced rig drops the tracks of pins it lost).
  const stored = i.append === true ? await storedPuppet(ctx, i.layerId) : null;
  const kept = stored && Array.isArray(stored.pins) ? (stored.pins as PuppetPin[]) : [];
  // Ordinal ids, not timestamps: `pin_${Date.now}_${idx}` collided whenever
  // two rigs were authored inside the same millisecond, and colliding pins
  // share one set of animation tracks.
  const pinIds = nextRigIds(
    'pin_',
    usedRigIds([...(await puppetPins(i.layerId)), ...kept]),
    i.pins.length,
  );
  const PIN_KINDS: ReadonlySet<string> = new Set(['position', 'advanced', 'bend', 'starch', 'overlap']);
  const pinsList: PuppetPin[] = i.pins.map((p, idx) => {
    const kind = (p.kind && PIN_KINDS.has(p.kind) ? p.kind : 'advanced') as PinKind;
    return {
      id: pinIds[idx]!,
      name: p.name || `Pin ${kept.length + idx + 1}`,
      x: p.x,
      y: p.y,
      kind,
      ...(typeof p.rotation === 'number' ? { rotation: p.rotation } : {}),
      // A starch pin stiffens by default; an overlap pin comes forward (the tools' defaults, puppet.ts draftPin).
      ...(typeof p.stiffness === 'number' ? { stiffness: Math.max(0, p.stiffness) } : kind === 'starch' ? { stiffness: 8 } : {}),
      ...(typeof p.scale === 'number' ? { scale: Math.max(0.01, p.scale) } : {}),
      ...(typeof p.overlap === 'number'
        ? { overlap: Math.max(-100, Math.min(100, p.overlap)) }
        : kind === 'overlap' ? { overlap: 50 } : {}),
    };
  });
  // Mesh settings: what the call names over what the layer had (append) or the defaults.
  const m = i.mesh ?? {};
  const prev = stored ?? {};
  const prevAny = prev as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
  const mesh = {
    ...(num(m.density ?? prev.meshDensity, 2, 50) !== undefined ? { meshDensity: Math.round(num(m.density ?? prev.meshDensity, 2, 50)!) } : {}),
    ...(num(m.expansion ?? prev.meshExpansion, 0, 200) !== undefined ? { meshExpansion: num(m.expansion ?? prev.meshExpansion, 0, 200) } : {}),
    ...((m.mode ?? prev.meshMode) === 'grid' || (m.mode ?? prev.meshMode) === 'silhouette' ? { meshMode: (m.mode ?? prev.meshMode) as 'grid' | 'silhouette' } : {}),
    ...((m.solver ?? prev.solver) === 'lbs' || (m.solver ?? prev.solver) === 'arap' ? { solver: (m.solver ?? prev.solver) as 'lbs' | 'arap' } : {}),
    ...(num(m.maxRotationDeg ?? prev.maxRotationDeg, 0, 180) !== undefined ? { maxRotationDeg: num(m.maxRotationDeg ?? prev.maxRotationDeg, 0, 180) } : {}),
    // Image layers: the alpha trace (rigSpecs.ts puppet/mesh/traceAccuracy, /alphaThreshold).
    ...(num(m.traceAccuracy ?? prevAny.traceAccuracy, 0, 100) !== undefined ? { traceAccuracy: num(m.traceAccuracy ?? prevAny.traceAccuracy, 0, 100) } : {}),
    ...(num(m.alphaThreshold ?? prevAny.alphaThreshold, 0, 255) !== undefined ? { alphaThreshold: Math.round(num(m.alphaThreshold ?? prevAny.alphaThreshold, 0, 255)!) } : {}),
  };
  const all = [...kept, ...pinsList];
  await ctx.scene.setPuppet(i.layerId, { ...prev, ...mesh, pins: all });
  const ids = pinsList.map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
  const meshText = Object.keys(mesh).length ? ` Mesh: ${Object.entries(mesh).map(([k, v]) => `${k} ${String(v)}`).join(', ')}.` : '';
  return {
    ok: true,
    content:
      `${stored ? `Added ${pinsList.length} pins to the puppet rig (now ${all.length})` : `Created puppet rig with ${pinsList.length} pins`} on layer '${i.layerId}'. ` +
      `Pins: ${pinsList.map((p) => `${p.id} '${p.name}' ${p.kind}`).join(', ')}.${meshText} ` +
      `Animate positions with set_puppet_pin_keyframes; puppet.<pinId>.rotation / .stiffness / .scale with set_keyframes. render_rig_view shows them on the layer.`,
    data: { layerId: i.layerId, pinsCount: all.length, pins: ids, mesh },
  };
};

/** The layer's stored puppet rig (`layer/puppet`, JSON), or null. */
async function storedPuppet(ctx: ToolContext, layer: string): Promise<Partial<PuppetRig> | null> {
  try {
    const r = await ctx.engine.query({ type: 'getPropertyValues', props: [{ layer, path: 'layer/puppet' }], time: 0, evaluated: false });
    const v = r.values[0]?.value;
    if (!v || v.kind !== 'json' || typeof v.value !== 'string') return null;
    const parsed: unknown = JSON.parse(v.value);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<PuppetRig>) : null;
  } catch {
    return null;
  }
}

interface PuppetPinKey { timeSec: number; x: number; y: number; easing?: string; bezier?: number[]; tangentIn?: number[]; tangentOut?: number[] }
interface SetPuppetPinKeyframesInput {
  layerId: string;
  pins?: { pinId: string; keyframes: PuppetPinKey[] }[];
  pinId?: string;
  keyframes?: PuppetPinKey[];
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
  // Both forms: many pins, or the old one pin.
  const batches = [...(i.pins ?? []), ...(i.pinId && i.keyframes ? [{ pinId: i.pinId, keyframes: i.keyframes }] : [])];
  if (batches.length === 0) return fail('Give `pins` [{ pinId, keyframes }] (or pinId + keyframes).');
  const ids = rig.pins.map((p) => p.id).join(', ');
  const written: Record<string, number> = {};
  for (const b of batches) {
    if (!rig.pins.some((p) => p.id === b.pinId)) {
      return { ok: false, content: `Pin '${b.pinId}' is not on layer '${i.layerId}'. Pins: ${ids || 'none'}.` };
    }
    if (!b.keyframes || b.keyframes.length === 0) return fail(`Pin '${b.pinId}': provide at least one keyframe.`);
    const prop = `puppet.${b.pinId}.position`;
    for (const k of b.keyframes) {
      // Composition seconds — the engine converts. The ease and the spatial
      // handles ride the insert itself (one write per key).
      await ctx.anim.setPointsKeyframe(i.layerId, prop, k.timeSec, [{ x: k.x, y: k.y }], {
        ...(k.easing ? { easing: k.easing } : {}),
        ...(k.bezier ? { bezier: k.bezier } : {}),
        ...(k.tangentIn ? { tangentIn: k.tangentIn } : {}),
        ...(k.tangentOut ? { tangentOut: k.tangentOut } : {}),
      });
    }
    written[b.pinId] = (written[b.pinId] ?? 0) + b.keyframes.length;
  }
  const total = Object.values(written).reduce((a, n) => a + n, 0);
  return {
    ok: true,
    content:
      `Set ${total} position keyframe(s) on ${Object.keys(written).length} pin(s) of layer '${i.layerId}': ` +
      `${Object.entries(written).map(([p, n]) => `${p} ×${n}`).join(', ')}. Each pin animates along puppet.<pinId>.position; check a pose with render_rig_view.`,
    data: { layerId: i.layerId, pins: written, keyframes: total },
  };
};

import type { MergeOp } from '@core/scene/mergePaths';

/**
 * Live merge keeps sources animatable — the designed-motion default. The
 * engine's `createLiveMerge`: the result layer made, the operands flagged
 * `layer/booleanOperand` and hidden — the menus' own route.
 */
const mergePathsHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as { op: MergeOp; nodeIds: string[] };
  const missing = await filterSeq(i.nodeIds, async (id) => !(await ctx.scene.has(id)));
  if (missing.length > 0) return fail(`Unknown nodeId(s): ${missing.join(', ')}`);
  let resultId: string | null = null;
  try {
    const out = await ctx.engine.apply([{ type: 'createLiveMerge', layers: i.nodeIds, op: i.op } as Command]);
    resultId = (out[0] as { layer?: string } | undefined)?.layer ?? null;
  } catch {
    return fail(`Failed to apply merge operation '${i.op}': give at least two overlapping shape layers with closed paths.`);
  }
  if (!resultId) return fail(`Failed to apply merge operation '${i.op}' on layers.`);
  useSelectionStore.getState().set([resultId]);
  return ok(`Applied live merge '${i.op}'. Result: ${resultId}. Sources stay editable.`, { resultIds: [resultId] });
};

/** Patch (creating if absent) a node's trim entry through the engine; resolves to its op id. */
async function applyTrim(ctx: ToolContext, nodeId: string, i: { start?: number; end?: number; offset?: number }): Promise<string> {
  const patch: Partial<PathOp> = {};
  if (i.start !== undefined) patch.start = i.start;
  if (i.end !== undefined) patch.end = i.end;
  if (i.offset !== undefined) patch.offset = i.offset;
  const opId = await ensurePathOperator(ctx.engine, nodeId, 'trim');
  await patchPathOperator(ctx.engine, nodeId, opId, patch);
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
  const i = input as { nodeId: string; id?: string; start?: number; end?: number; offset?: number; convertSvg?: boolean };
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
    const groupId = await convertSvgLayer(ctx.engine, i.nodeId);
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
    const trims = await mapSeq(shapeIds, async (id) => ({ nodeId: id, opId: await applyTrim(ctx, id, i) }));
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
  const opId = await applyTrim(ctx, i.nodeId, i);
  // The caller's handle for `pathop.<handle>.…` later in the same batch.
  bindAlias(ctx, i.id, opId);
  const t = (await pathOperators(ctx.engine, i.nodeId)).find((o) => o.id === opId)?.params;
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
    id?: string;
  };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

  const repeaters = (await pathOperators(ctx.engine, i.nodeId))
    .filter((o) => o.type === 'repeater')
    .map((o) => ({ id: o.id, copies: o.params.copies }));

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
    await patchPathOperator(ctx.engine, i.nodeId, target.id, patch);
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
  const repOpId = await addPathOperator(ctx.engine, i.nodeId, 'repeater', {
    copies,
    offsetX: i.positionX ?? 0,
    offsetY: i.positionY ?? 0,
    offsetRotation: i.rotation ?? 0,
    offsetScale: i.scale ?? 1,
    offsetOpacity: perCopyOpacity(copies, start, end),
    ...(i.anchorX !== undefined ? { anchorX: i.anchorX } : {}),
    ...(i.anchorY !== undefined ? { anchorY: i.anchorY } : {}),
  });
  bindAlias(ctx, i.id, repOpId);

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
    id?: string;
  };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));

  const type = PATH_OP_ALIASES[i.op];
  if (!type) {
    return fail(
      `Unknown path operator '${i.op}'. Use one of: ${Object.keys(PATH_OP_ALIASES).join(', ')}.`,
    );
  }

  // The TYPE's own defaults come with the operator: the engine adds it with
  // `defaultPathOpOf(type)` (a wiggleTransform keeps its 2 wiggles/second and
  // correlation 50), so only what the call NAMES is written after it is pushed
  // onto the chain (`contents`). Re-sending the defaults wrote wiggles/second
  // on operators that have no such property (Pucker & Bloat), which the API
  // does not address — and refused the whole call.
  const opId = await addPathOperator(ctx.engine, i.nodeId, type, {
    ...(i.amount !== undefined ? { amount: i.amount } : {}),
    ...(i.detail !== undefined ? { detail: i.detail } : {}),
    ...(i.wigglesPerSecond !== undefined ? { wigglesPerSecond: Math.max(0, i.wigglesPerSecond) } : {}),
  });
  bindAlias(ctx, i.id, opId);

  const chain = await pathOperators(ctx.engine, i.nodeId);
  return ok(
    `Added '${type}' to '${i.nodeId}' (operator ${chain.length} in the chain, id '${opId}'). ` +
      `Keyframe 'pathop.${opId}.amount' to animate the deformation.`,
    { nodeId: i.nodeId, opId },
  );
};

const createSkeletonRigHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    layerId: string;
    bones: Array<{ id: string; parentId?: string; length: number; x?: number; y?: number; rotation?: number }>;
    ik?: Array<{ boneId: string; x: number; y: number; chainLength?: number; pole?: { x: number; y: number } }>;
    mesh?: { density?: number; expansion?: number; mode?: string; traceAccuracy?: number; alphaThreshold?: number; preserveVolume?: boolean };
  };
  if (!await ctx.scene.has(i.layerId)) return fail((await unknownNode(ctx, i.layerId)));
  const skelKind = kindOf(i.layerId);
  if (!skelKind) return fail(`Node '${i.layerId}' not found.`);
  if (!isRiggableKind(skelKind)) {
    return fail(
      `Layer '${i.layerId}' is a ${skelKind} — skeleton rigs only apply to shape or image layers. ` +
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
    // The tool takes degrees; the stored rig is radians (rig/skeleton.ts
    // fromTRS). Written as given, a 90° bone was stored as 90 rad.
    rotation: ((b.rotation ?? 0) * Math.PI) / 180,
  }));
  const boneIds = new Set(bones.map((b) => b.id));
  const badIk = (i.ik ?? []).filter((g) => !boneIds.has(g.boneId)).map((g) => g.boneId);
  if (badIk.length > 0) return fail(`IK goal(s) on unknown bone(s): ${badIk.join(', ')}.`);
  const ikTargets = (i.ik ?? []).map((g) => ({
    boneId: g.boneId,
    x: g.x,
    y: g.y,
    chainLength: Math.max(1, Math.min(8, Math.round(g.chainLength ?? 2))),
    // A pole picks the elbow / knee side (the side of the root→goal line it is
    // on — rig_mesh.cpp apply_ik); none keeps the rest pose's side.
    ...(g.pole && Number.isFinite(g.pole.x) && Number.isFinite(g.pole.y) ? { pole: { x: g.pole.x, y: g.pole.y } } : {}),
  }));
  // The skin mesh (rigSpecs.ts skeleton/mesh/*): only what the call names; the rest takes the defaults.
  const sm = i.mesh ?? {};
  const clampNum = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
  const mesh: Record<string, unknown> = {
    ...(clampNum(sm.density, 2, 50) !== undefined ? { meshDensity: Math.round(clampNum(sm.density, 2, 50)!) } : {}),
    ...(clampNum(sm.expansion, 0, 200) !== undefined ? { meshExpansion: clampNum(sm.expansion, 0, 200) } : {}),
    ...(sm.mode === 'grid' || sm.mode === 'silhouette' ? { meshMode: sm.mode } : {}),
    ...(clampNum(sm.traceAccuracy, 0, 100) !== undefined ? { traceAccuracy: clampNum(sm.traceAccuracy, 0, 100) } : {}),
    ...(clampNum(sm.alphaThreshold, 0, 255) !== undefined ? { alphaThreshold: Math.round(clampNum(sm.alphaThreshold, 0, 255)!) } : {}),
    ...(typeof sm.preserveVolume === 'boolean' ? { preserveVolume: sm.preserveVolume ? 'on' : 'off' } : {}),
  };
  // The whole rig as `layer/skeleton` (a rig preset's route, rigPaths.ts).
  await ctx.engine.apply([{ type: 'setProperty', prop: { layer: i.layerId, path: 'layer/skeleton' }, value: { kind: 'json', value: JSON.stringify({ bones, ikTargets, ...mesh }) } } as Command]);
  const meshText = Object.keys(mesh).length ? ` Mesh: ${Object.entries(mesh).map(([k, v]) => `${k} ${String(v)}`).join(', ')}.` : '';
  return ok(
    `Created skeleton rig with ${bones.length} bones${ikTargets.length ? ` and ${ikTargets.length} IK goal(s)` : ''} on layer '${i.layerId}'.${meshText}` +
      (ikTargets.length ? ' Animate a goal with pose_skeleton ikPoses (or set_keyframes on ikTarget.<boneId>.x / .y, layer px); ikMode.<boneId> blends FK (0) → IK (1).' : ''),
    { layerId: i.layerId, boneCount: bones.length, ikCount: ikTargets.length, mesh },
  );
};

const poseSkeletonHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    layerId: string;
    bonePoses?: Array<{ boneId: string; timeSec: number; rotation?: number; x?: number; y?: number; easing?: string }>;
    ikPoses?: Array<{ boneId: string; timeSec: number; x?: number; y?: number; poleX?: number; poleY?: number; ik?: boolean; ikBlend?: number; easing?: string }>;
  };
  if (!await ctx.scene.has(i.layerId)) return fail((await unknownNode(ctx, i.layerId)));
  const keys: { nodeId: string; prop: string; t: number; value: number; easing?: string }[] = [];
  const ease = (e: string | undefined): string => e ?? 'easeInOut';
  for (const p of i.bonePoses ?? []) {
    // Composition seconds — the engine converts. Degrees here; the stored
    // bone rotation is radians (create_skeleton_rig converts too).
    if (p.rotation !== undefined) keys.push({ nodeId: i.layerId, prop: `bone.${p.boneId}.rotation`, t: p.timeSec, value: p.rotation, easing: ease(p.easing) });
    if (p.x !== undefined) keys.push({ nodeId: i.layerId, prop: `bone.${p.boneId}.x`, t: p.timeSec, value: p.x, easing: ease(p.easing) });
    if (p.y !== undefined) keys.push({ nodeId: i.layerId, prop: `bone.${p.boneId}.y`, t: p.timeSec, value: p.y, easing: ease(p.easing) });
    if (p.rotation === undefined && p.x === undefined && p.y === undefined) return fail(`bonePoses: bone '${p.boneId}' at ${p.timeSec}s names no rotation, x or y.`);
  }
  for (const g of i.ikPoses ?? []) {
    if (g.x !== undefined) keys.push({ nodeId: i.layerId, prop: `ikTarget.${g.boneId}.x`, t: g.timeSec, value: g.x, easing: ease(g.easing) });
    if (g.y !== undefined) keys.push({ nodeId: i.layerId, prop: `ikTarget.${g.boneId}.y`, t: g.timeSec, value: g.y, easing: ease(g.easing) });
    if (g.poleX !== undefined) keys.push({ nodeId: i.layerId, prop: `ikPole.${g.boneId}.x`, t: g.timeSec, value: g.poleX, easing: ease(g.easing) });
    if (g.poleY !== undefined) keys.push({ nodeId: i.layerId, prop: `ikPole.${g.boneId}.y`, t: g.timeSec, value: g.poleY, easing: ease(g.easing) });
    // The IK/FK blend (0 = FK … 1 = IK): a boolean is the whole switch, a number a partial hand-over, eased like the goal.
    if (g.ik !== undefined || g.ikBlend !== undefined) {
      const blend = typeof g.ikBlend === 'number' ? g.ikBlend : g.ik ? 1 : 0;
      if (!Number.isFinite(blend) || blend < 0 || blend > 1) return fail(`ikPoses: '${g.boneId}' ikBlend must be between 0 (FK) and 1 (IK).`);
      keys.push({ nodeId: i.layerId, prop: `ikMode.${g.boneId}`, t: g.timeSec, value: blend, easing: ease(g.easing) });
    }
  }
  if (keys.length === 0) return fail('Give `bonePoses` (FK) and/or `ikPoses` (IK goals / poles / switch).');
  const rejected: string[] = [];
  if (ctx.anim.setKeyframes) {
    try {
      await ctx.anim.setKeyframes(keys);
    } catch (err) {
      return fail(`pose_skeleton: ${err instanceof Error ? err.message : String(err)} — the bone / goal ids must be the rig's (render_rig_view lists them).`);
    }
  } else {
    for (const k of keys) {
      try { await ctx.anim.setKeyframe(k.nodeId, k.prop, k.t, k.value, k.easing); } catch (err) { rejected.push(`${k.prop}@${k.t}: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }
  refreshAfterLegacy(ctx);
  const bones = new Set(keys.map((k) => k.prop.split('.')[1]));
  return ok(
    `Set ${keys.length - rejected.length} key(s) on ${bones.size} bone(s) / goal(s) of layer '${i.layerId}'${rejected.length ? `; rejected: ${rejected.join('; ')}` : ''}. Check the pose with render_rig_view at those times.`,
    { layerId: i.layerId, keys: keys.length - rejected.length, rejected },
  );
};

/** apply_layer_style's enum → the style key and how its generic fields map onto that style's own. */
const LAYER_STYLE_KEYS: Readonly<Record<string, keyof LayerStyles>> = {
  drop_shadow: 'dropShadow', inner_shadow: 'innerShadow', outer_glow: 'outerGlow', inner_glow: 'innerGlow', satin: 'satin',
  bevel: 'bevel', color_overlay: 'colorOverlay', gradient_overlay: 'gradientOverlay', stroke: 'stroke', glass: 'glass',
};

const applyLayerStyleHandler: AiTool['handler'] = async (input, ctx) => {
  const i = input as {
    nodeId: string; styleType: string; enabled?: boolean; color?: string; opacity?: number; size?: number; spread?: number; distance?: number; angle?: number;
    useGlobalLight?: boolean; invert?: boolean; depth?: number; direction?: string; altitude?: number; highlightColor?: string; highlightOpacity?: number;
    shadowColor?: string; shadowOpacity?: number; from?: string; to?: string; position?: string; glass?: Record<string, unknown>;
  };
  if (!await ctx.scene.has(i.nodeId)) return fail((await unknownNode(ctx, i.nodeId)));
  const key = LAYER_STYLE_KEYS[i.styleType];
  if (!key) return fail(`Unknown styleType '${i.styleType}'. One of: ${Object.keys(LAYER_STYLE_KEYS).join(', ')}.`);
  const enabled = i.enabled !== false;
  const set = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const light = i.useGlobalLight !== undefined ? { useGlobalLight: i.useGlobalLight } : {};
  let patch: Record<string, unknown>;
  switch (key) {
    case 'dropShadow':
      patch = set({ color: i.color ?? '#000000', opacity: i.opacity ?? 0.5, blur: i.size ?? 8, distance: i.distance ?? 8, angle: i.angle ?? 90, spread: i.spread, ...light });
      break;
    case 'innerShadow':
      patch = set({ color: i.color ?? '#000000', opacity: i.opacity ?? 0.5, size: i.size ?? 8, distance: i.distance ?? 6, angle: i.angle ?? 90, ...light });
      break;
    case 'outerGlow':
      patch = set({ color: i.color ?? '#ffffff', opacity: i.opacity ?? 0.9, size: i.size ?? 16, spread: i.spread });
      break;
    case 'innerGlow':
      patch = set({ color: i.color ?? '#ffffff', opacity: i.opacity ?? 0.75, size: i.size ?? 12 });
      break;
    case 'satin':
      patch = set({ color: i.color ?? '#000000', opacity: i.opacity ?? 0.5, size: i.size ?? 14, distance: i.distance ?? 8, angle: i.angle ?? 19, invert: i.invert });
      break;
    case 'bevel':
      patch = set({
        size: i.size ?? 5, depth: i.depth ?? 100, direction: i.direction === 'down' ? 'down' : i.direction === 'up' ? 'up' : undefined, angle: i.angle ?? 120, altitude: i.altitude ?? 30,
        highlightColor: i.highlightColor ?? '#ffffff', highlightOpacity: i.highlightOpacity ?? 0.75, shadowColor: i.shadowColor ?? '#000000', shadowOpacity: i.shadowOpacity ?? 0.75, ...light,
      });
      break;
    case 'colorOverlay':
      patch = set({ color: i.color ?? '#ffffff', opacity: i.opacity ?? 1 });
      break;
    case 'gradientOverlay':
      patch = set({ from: i.from ?? i.color ?? '#ffffff', to: i.to ?? '#000000', opacity: i.opacity ?? 1, angle: i.angle ?? 90, ...light });
      break;
    case 'stroke':
      patch = set({ color: i.color ?? '#ffffff', opacity: i.opacity ?? 1, size: i.size ?? 3, position: i.position });
      break;
    default: {
      // Glass: the defaults already look like glass; only what the call names is written.
      const g = i.glass ?? {};
      patch = set({ ...g, tintColor: g.tintColor ?? i.color, tintOpacity: g.tintOpacity ?? i.opacity, blur: g.blur ?? i.size, ...light });
      if (Object.keys(patch).length === 0) patch = { ...defaultGlassStyle() };
      delete patch.enabled;
      break;
    }
  }
  try {
    await patchLayerStyle(ctx.engine, i.nodeId, key, { enabled, ...(enabled ? patch : {}) });
  } catch (err) {
    return fail(`apply_layer_style ${i.styleType}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!enabled) {
    await ctx.engine.apply([{ type: 'setGroupEnabled', groups: [{ layer: i.nodeId, path: `styles/${key}` }], enabled: false } as Command]);
    return ok(`Switched the ${i.styleType} layer style off on '${i.nodeId}' (its settings are kept).`, { nodeId: i.nodeId, style: key, enabled: false });
  }
  const fields = Object.entries(patch).map(([k, v]) => `${k} ${String(v)}`).join(', ');
  return ok(
    `Applied ${i.styleType} layer style on '${i.nodeId}': ${fields}. Its fields are keyframeable (${key === 'glass' ? 'glass.<field>' : `effect.layerstyle:${key}.<param>`} with set_keyframes).`,
    { nodeId: i.nodeId, style: key, enabled: true, fields: patch },
  );
};

const recolorLottieVectorHandler: AiTool['handler'] = async (input, ctx) => {
  const { nodeId, color } = input as { nodeId: string; color: string };
  if (!await ctx.scene.has(nodeId)) return fail((await unknownNode(ctx, nodeId)));

  // Every shape's fill (`layer/fill`, a key at the playhead where animated) in
  // ONE setProperties — the Inspector's fill write, per layer.
  const at = activePlayheadSeconds();
  const writes: PropertyWrite[] = [];
  const traverseAndRecolor = (id: string) => {
    const layer = layerInfo(id);
    if (!layer) return;
    if (uiKindOf(layer) === 'shape') {
      const style = componentOfType(id, 'Style');
      const w = style ? fieldWrite(id, style, 'fill', color, at) : null;
      if (w) writes.push(w);
    }
    for (const childId of layer.children) {
      traverseAndRecolor(childId);
    }
  };

  traverseAndRecolor(nodeId);
  if (writes.length > 0) {
    await ctx.engine.apply([{ type: 'setProperties', writes: writes.map((w) => ({ prop: w.prop, value: w.value, ...(w.time !== undefined ? { time: w.time } : {}) })) } as Command]);
  }
  const count = writes.length;
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
 * Mutating tools whose handlers write ONLY through the ToolContext facades,
 * engine commands and off-document builders sent as ONE engine command
 * (hostWrites.ts) — audited for B5. A write the API cannot express is REFUSED
 * (a failed tool call), never made around the engine. `export_video` writes
 * no document state (the editor's render-job queue, persisted with the app's
 * settings — not the project's `addRenderItems` queue). `merge_paths` is
 * one batch: the result pasted, the operands flagged `layer/booleanOperand`.
 */
export const ENGINE_ROUTED_TOOLS: ReadonlySet<string> = new Set([
  'create_layer', 'delete_layer', 'reparent_layer', 'reorder_layer', 'set_audio', 'paint_strokes', 'update_layer',
  'set_keyframes', 'remove_keyframes', 'set_easing', 'set_expression', 'set_layer_timing',
  'add_effect', 'update_effect', 'update_effect_param', 'update_composition', 'apply_preset',
  'set_spring', 'set_motion_blur', 'create_precomp', 'set_time_remap', 'set_light', 'set_shadow_stack',
  'create_puppet_rig', 'set_puppet_pin_keyframes', 'pose_skeleton',
  // B5 finish: text animators, masks, media, SVG, path operators, rigs, layer
  // styles, gradients and the compose recipes.
  'text_animator', 'create_mask', 'update_mask', 'create_media', 'create_media_from_attachment', 'generate_image',
  'generate_video', 'generate_speech', 'generate_3d_model', 'import_svg', 'set_trim_path', 'add_repeater',
  'add_path_operator', 'create_skeleton_rig', 'apply_layer_style', 'recolor_lottie_vector', 'create_gradient',
  'add_surface_treatment', 'define_style', 'add_background', 'add_title', 'add_emblem', 'add_cards', 'stagger_in',
  'add_camera_move', 'add_kinetic_title', 'add_light_sweep', 'add_ambient_orbs', 'add_lower_third', 'add_scene',
  'add_transition', 'add_logo_reveal', 'add_radial_burst', 'add_path_morph', 'export_video', 'merge_paths',
  'place_behind_subject',
  // Footage (mediaTools.ts): engine jobs and commands only.
  'select_subject', 'refine_subject', 'follow_subject', 'apply_subject_style', 'track_point', 'attach_to_track', 'transcribe',
]);

const HANDLERS: Record<string, AiTool['handler']> = {
  // The craft primitives (spring, precomp, time remap, shadow stack, surface
  // treatment, …) live in their own file — this one is already 1300 lines.
  ...CRAFT_HANDLERS,
  ...MEDIA_HANDLERS,
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
  list_fonts: listFonts,
  inspect_layers: inspectLayers,
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
  reorder_layer: reorderLayer,
  set_audio: setAudio,
  paint_strokes: paintStrokes,
  update_layer: updateLayer,
  set_keyframes: setKeyframes,
  remove_keyframes: removeKeyframes,
  set_easing: setEasing,
  set_expression: setExpression,
  set_layer_timing: setLayerTiming,
  add_effect: addEffectHandler,
  update_effect: updateEffectHandler,
  text_animator: textAnimator,
  create_media: createMedia,
  generate_image: generateImage,
  generate_video: generateVideo,
  generate_speech: generateSpeech,
  generate_3d_model: generate3dModel,
  export_video: exportVideoTool,
  place_behind_subject: placeBehindSubjectTool,
  get_export_status: getExportStatus,
  import_svg: importSvg,
  analyse_audio: analyseAudioTool,
  create_media_from_attachment: createMediaFromAttachment,
  create_mask: createMask,
  update_mask: updateMask,
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

