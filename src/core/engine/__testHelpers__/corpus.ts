/**
 * The replay corpus (ENGINE_API.md §12): scripted editing sessions covering
 * every command family. Shared by replay.test.ts (TS engine → fresh TS engine,
 * byte-exact) and crossEngine.test.ts (TS engine → the C++ engine process,
 * C3's exit criterion) — so it lives here, not in either test file.
 */

import type { Harness } from './harness';
import { sec } from './harness';
import { buildScene } from './scene';
import {
  AlphaModeValues, AutoOrientValues, BitDepthValues, BlendModeValues, ColorWorkingSpaceValues, EasingValues, EdgeValues, ExpressionEngineValues,
  FieldOrderValues, FrameBlendValues, LayerConversionValues, LayerKindValues, LayerQualityValues, MaskModeValues, MatteModeValues,
  PrecomposeModeValues, Renderer3dValues, RetimeModeValues, SpatialInterpValues, TimeDisplayValues, WorkAreaEditValues,
  type Command, type CompSettingsPatch, type InterpretationPatch, type KeyframePatch, type KeyframeSet, type LayerInfo, type LayerSwitchesPatch,
  type Marker, type MarkerPatch, type ProjectSettingsPatch, type PropertyInfo, type Value,
} from '@motion/engine-api';
import { EFFECT_DEFS } from '@core/effects/effects';
import { listPresets } from '@core/animation/animationPresets';
import { LAYER_STYLE_LABEL } from '@core/effects/layerStyles';
import { PATH_OP_CATALOG } from '@core/scene/pathOps';
import { projectDocumentIO } from '@core/project/projectDocumentIO';
import type { EditorDocument } from '@core/api/cloudDocument';
import type { SceneNode } from '@core/types';
import { makeLayerNode } from '../handlers/layerFactory';
import { sanitizeSvg } from '@core/svg/svgSanitize';
import { scanSvgCapabilities } from '@core/svg/svgCapabilities';
import { makeSvgComponent } from '@core/svg/svgLayer';
import { buildLayerFragment } from '../offDocument';
import { insertCamera, insertLight, insertShape, insertText } from '@core/scene/sceneInsert';
import { buildLottieItem, LOTTIE_ITEMS } from '@core/library/lottieLibrary';
import { buildMographItem, MOGRAPH_ITEMS } from '@core/library/mographLibrary';
import { setNodeMatte } from '@core/effects/matte';
import { useSelectionStore } from '@stores/selectionStore';

export type Session = (h: Harness) => Promise<void>;

/** Project files a session opens that no session wrote (seeded into both engines' file ports). */
export const FIXTURE_EXTRAS = 'C:/fixtures/extras.motion';
export const FIXTURE_BARE = 'C:/fixtures/bare.motion';
export const FIXTURE_GRADIENTS = 'C:/fixtures/gradients.motion';
export const FIXTURE_SVG = 'C:/fixtures/svg.motion';

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><style>#dot { fill: blue } .x { stroke: url(#g) }</style></defs><rect id="box" width="50" height="50" fill="url(#g)"/><circle id="dot" cx="70" cy="70" r="10"><animate id="a1" attributeName="r" from="10" to="20" dur="1s"/><animate attributeName="cx" begin="a1.end" to="80" dur="1s"/></circle><use href="#box" x="10"/></svg>';

/** An SVG layer sanitised by the editor (scoped to its node id), for the precompose re-scope (G2 #12). */
function svgFixture(): EditorDocument {
  const doc = projectDocumentIO.createEmpty('Svg');
  const comp = doc.comps!.comp_root!;
  const base = makeLayerNode({ kind: 'shape', id: 'layer_1', comp, name: 'Logo' });
  const clean = sanitizeSvg(SVG_SOURCE, 'layer_1', scanSvgCapabilities(new DOMParser().parseFromString(SVG_SOURCE, 'image/svg+xml')));
  if (!clean) throw new Error('the SVG fixture did not sanitise');
  const t = base.components.find((c) => c.type === 'Transform')!;
  const node: SceneNode = {
    ...base, parent: 'comp_root',
    components: [
      { ...t, props: { ...t.props, __kind: 'svg', width: 100, height: 100 } },
      makeSvgComponent('layer_1_svg', { sourceMarkup: SVG_SOURCE, sanitizedMarkup: clean.markup, size: { width: clean.width, height: clean.height, viewBox: clean.viewBox }, capabilities: scanSvgCapabilities(new DOMParser().parseFromString(SVG_SOURCE, 'image/svg+xml')), fileName: 'logo.svg' }) as SceneNode['components'][number],
    ],
  };
  const scene = doc.scene as { nodes: SceneNode[] };
  scene.nodes.find((n) => n.id === 'comp_root')!.children = ['layer_1'];
  scene.nodes.push(node);
  return doc;
}

/** A document carrying every extra the engines save: guides, swatches, materials, transitions, plugin storage. */
function extrasFixture(): EditorDocument {
  const doc = projectDocumentIO.createEmpty('Extras');
  return {
    ...doc,
    guides: {
      ...doc.guides!,
      grid: true, rulers: true, gridSpacing: 50.4, gridSubdivisions: 99, gridStyle: 'dots', proportionalColumns: 3,
      gridColor: '#ff000080', motionPathDots: 'large',
      cameraBookmarks: { comp_root: [
        { slot: 3, name: 'Three', mode: 'top', framing: { center: { x: 1, y: 2 }, zoom: 1.5 } },
        { slot: 1.2, mode: 'nonsense', framing: { center: { x: 0, y: 0 }, zoom: 1 } },
        { slot: 12, mode: 'active', framing: { center: { x: 0, y: 0 }, zoom: 1 } },
      ] },
      overlayOpacity: 0.1,
      motionPathShow: 'window', motionPathWindowSeconds: 3,
      userGuides: [
        { axis: 'x', value: 120, unit: 'px', edge: 'start', color: '#e5484d', locked: true },
        { axis: 'y', position: 40 } as never,
        { axis: 'z', value: 1 } as never,
      ],
    } as EditorDocument['guides'],
    swatches: [
      { id: 'sw_1', name: 'Brand', hex: '#FF8800' },
      { id: 'sw_2', name: '  ', hex: 'abcf' } as never,
      { id: 'sw_1', name: 'Dup id', hex: '#123' },
      { id: 'sw_3', name: 'Bad', hex: 'nothex' },
    ] as EditorDocument['swatches'],
    materials: [
      { id: 'mat_1', name: ' Chrome ', swatch: '#AABBCC', params: { shading: 'pbr', metal: 150, roughness: 12, castsShadows: 2, acceptsLights: 1, toonBands: 5.6 } },
      { id: 'builtin:gold', name: 'Fake gold', params: {} },
    ] as unknown as EditorDocument['materials'],
    transitions: { comp_root: [{ id: 'tr_1', kind: 'crossDissolve', duration: 0.5 }] } as unknown as EditorDocument['transitions'],
    pluginStorage: { 'com.example.rig': { spine: 'layer_1', mode: 'fk' }, 'com.example.empty': {} },
  };
}

/** A document stating none of the extras (absent = keep; plugin storage is assigned whole). */
function bareFixture(): EditorDocument {
  const { guides: _g, swatches: _s, materials: _m, transitions: _t, ...rest } = projectDocumentIO.createEmpty('Bare');
  return rest as EditorDocument;
}

/**
 * Text and shape layers with gradient paints (a gradient fill, a text stroke
 * gradient, a fill STACK): the gradient geometry rows (G2 #10). No API command
 * sets a gradient paint, so the layers arrive in a document.
 */
function gradientsFixture(): EditorDocument {
  const doc = projectDocumentIO.createEmpty('Gradients');
  const comp = doc.comps!.comp_root!;
  const stops = [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }];
  const radial = { type: 'radial', cx: 0.25, cy: 0.75, radius: 0.6, stops };
  const linear = { type: 'linear', angle: 30, stops };
  const withFx = (n: SceneNode, fx: Record<string, unknown>): SceneNode => ({ ...n, parent: 'comp_root', components: [...n.components, { id: `${n.id}_fx`, type: 'fx', props: fx }] });
  const text1 = withFx(makeLayerNode({ kind: 'text', id: 'layer_1', comp, name: 'Radial text' }), { fill: radial });
  const t1 = text1.components.find((c) => c.type === 'Text')!;
  (t1.props as Record<string, unknown>).strokePaint = linear;
  const text2 = withFx(makeLayerNode({ kind: 'text', id: 'layer_2', comp, name: 'Linear text' }), { fill: linear });
  const shape = withFx(makeLayerNode({ kind: 'shape', id: 'layer_3', comp, name: 'Stacked shape' }), {
    fill: radial, fills: [radial, { type: 'solid', color: '#00ff00' }, 'junk'],
    // Paint strokes stored out of the editor's key order, with fields normalizeStroke drops or clamps.
    paint: { strokes: [
      { mode: 'erase', size: -4, points: [{ x: 1, y: 2 }, { x: 30, y: 40 }], id: 'ps_1', pressure: [1], eraseMode: 'lastStroke', spacing: 40, flow: 7, opacity: 2 },
      { hardness: 0.5, points: [{ x: 5, y: 5 }], color: '#123456', id: 'ps_2', mode: 'clone', cloneLockTime: true, cloneTimeShift: 0.5, roundness: 0 },
    ] },
  });
  const scene = doc.scene as { nodes: SceneNode[] };
  const root = scene.nodes.find((n) => n.id === 'comp_root')!;
  root.children = ['layer_3', 'layer_2', 'layer_1'];
  scene.nodes.push(text1, text2, shape);
  return doc;
}

/**
 * B3z WS-K: a pre-API document whose member tracks DISAGREE — Position x keyed at
 * 0/1/2 with y keyed only at 1 (lone member keys), Scale X / Y keyed together but
 * eased differently (per-dimension ease), Opacity keyed later. Written by the
 * legacy helpers; the engine must read each as whole keys and normalise on edit.
 */
export const FIXTURE_MEMBER_KEYS = 'C:/fixtures/member-keys.motion';
function memberKeysFixture(): EditorDocument {
  const doc = projectDocumentIO.createEmpty('Member keys');
  const comp = doc.comps!.comp_root!;
  const a = { ...makeLayerNode({ kind: 'solid', id: 'layer_1', comp, name: 'Lone keys' }), parent: 'comp_root' };
  const b = { ...makeLayerNode({ kind: 'solid', id: 'layer_2', comp, name: 'Target' }), parent: 'comp_root' };
  const scene = doc.scene as { nodes: SceneNode[] };
  scene.nodes.find((n) => n.id === 'comp_root')!.children = ['layer_2', 'layer_1'];
  scene.nodes.push(a, b);
  const track = (nodeId: string, prop: string, keyframes: unknown[]) => ({ nodeId, prop, keyframes });
  return {
    ...doc,
    animation: {
      tracks: {
        layer_1: {
          x: track('layer_1', 'x', [{ t: 0, value: 100 }, { t: 1, value: 300, easing: 'bezier', bezier: [0.3, 0, 0.7, 1] }, { t: 2, value: 500 }]),
          y: track('layer_1', 'y', [{ t: 1, value: 50, easing: 'linear' }]),
          scaleX: track('layer_1', 'scaleX', [{ t: 0, value: 1, easing: 'bezier', bezier: [0.2, 0, 0.8, 1], continuous: true }, { t: 1.5, value: 2 }]),
          scaleY: track('layer_1', 'scaleY', [{ t: 0, value: 1 }, { t: 1.5, value: 1.5 }]),
          opacity: track('layer_1', 'opacity', [{ t: 0.5, value: 100 }, { t: 2.5, value: 0 }]),
        },
      },
      expressions: {},
    } as unknown as EditorDocument['animation'],
  };
}

export const CORPUS_FIXTURES: Record<string, () => EditorDocument> = {
  [FIXTURE_MEMBER_KEYS]: memberKeysFixture,
  [FIXTURE_EXTRAS]: extrasFixture,
  [FIXTURE_BARE]: bareFixture,
  [FIXTURE_GRADIENTS]: gradientsFixture,
  [FIXTURE_SVG]: svgFixture,
};

const v2 = (x: number, y: number) => ({ kind: 'vec2' as const, value: { x, y } });
const v3 = (x: number, y: number, z: number) => ({ kind: 'vec3' as const, value: { x, y, z } });
const scalar = (value: number) => ({ kind: 'scalar' as const, value });

export const CORPUS: Record<string, Session> = {
  'layers, parenting, groups, reorder, undo/redo interleaved': async (h) => {
    const s = await buildScene(h);
    await h.run({ type: 'renameLayer', layer: s.A, name: 'Hero' });
    await h.run({ type: 'setParent', layers: [s.B], parent: s.P, keepWorldTransform: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    const { layer: g } = await h.run({ type: 'groupLayers', layers: [s.A, s.T], name: 'Titles' });
    await h.run({ type: 'duplicateLayers', layers: [s.V] });
    await h.run({ type: 'reorderLayers', comp: s.comp, layers: [s.P], toIndex: 0 });
    await h.run({ type: 'undo' });
    await h.run({ type: 'ungroupLayer', group: g });
    await h.run({ type: 'setLayerSwitches', layers: [s.A, s.V], patch: { shy: true, solo: true, label: 4, locked: false } });
    await h.run({ type: 'setBlendMode', layers: [s.A], mode: 'multiply' });
    await h.run({ type: 'setTrackMatte', layer: s.A, matte: { layer: s.B, mode: 'alpha' } });
    await h.run({ type: 'deleteLayers', layers: [s.T] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'setLayerComment', layer: s.A, comment: 'approved' });
  },

  'keyframes and gestures: drags, Esc, retime, easing': async (h) => {
    const s = await buildScene(h);
    const { gesture } = await h.run({ type: 'beginGesture', label: 'Drag Position' });
    for (let i = 0; i < 20; i++) await h.run({ type: 'setProperty', prop: { layer: s.B, path: 'transform/position' }, value: v2(100 + i * 5, 100), time: 0 });
    await h.run({ type: 'endGesture', gesture, commit: true });
    const g2 = (await h.run({ type: 'beginGesture', label: 'Nudge (cancelled)' })).gesture;
    await h.run({ type: 'moveKeyframes', ids: [s.posKeys[1]!], delta: sec(0.5) });
    await h.run({ type: 'endGesture', gesture: g2, commit: false });
    await h.run({ type: 'moveKeyframes', ids: [s.posKeys[1]!], delta: sec(1) });
    await h.run({ type: 'updateKeyframes', patches: [{ id: s.posKeys[0]!, easing: 'easeInOut', roving: false, label: 2, spatialIn: [], spatialOut: [] }] });
    const { ids } = await h.run({ type: 'addKeyframes', keys: [0, 1, 2, 3].map((i) => ({ prop: { layer: s.A, path: 'transform/rotation' }, time: sec(i), value: scalar(i * 45), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'scaleKeyframes', ids, pivot: 0, factor: 0.5 });
    await h.run({ type: 'reverseKeyframes', ids });
    await h.run({ type: 'undo' });
    await h.run({ type: 'deleteKeyframes', ids: [ids[3]!] });
    const got = await h.query({ type: 'getKeyframes', props: [{ layer: s.B, path: 'transform/position' }] });
    await h.run({ type: 'pasteKeyframes', prop: { layer: s.T, path: 'transform/position' }, time: sec(2), keys: got.sets[0]!.keyframes });
    await h.run({ type: 'setAnimated', prop: { layer: s.A, path: 'transform/opacity' }, animated: true, time: sec(1) });
    await h.run({ type: 'setExpression', prop: { layer: s.P, path: 'transform/rotation' }, source: 'time * 30', enabled: true });
    await h.run({ type: 'convertExpressionToKeyframes', prop: { layer: s.P, path: 'transform/rotation' }, range: { start: 0, duration: sec(0.5) }, step: 0 });
    await h.run({ type: 'linkProperty', prop: { layer: s.V, path: 'transform/position' }, target: { layer: s.B, path: 'transform/position' } });
    await h.run({ type: 'setDimensionsSeparated', layer: s.B, path: 'transform/position', separated: true });
  },

  'precompose, split, ripple, work area, sequence, retime': async (h) => {
    const s = await buildScene(h);
    await h.run({ type: 'setLayerTiming', items: [{ layer: s.A, inPoint: 0, outPoint: sec(2) }, { layer: s.B, inPoint: sec(2), outPoint: sec(4) }, { layer: s.T, inPoint: sec(4), outPoint: sec(6) }] });
    await h.run({ type: 'splitLayers', layers: [s.B], time: sec(3) });
    await h.run({ type: 'rippleDeleteLayers', layers: [s.A] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'slideLayer', layer: s.B, delta: sec(0.25) });
    await h.run({ type: 'rollEdit', left: s.A, right: s.B, delta: sec(0.5) });
    await h.run({ type: 'editWorkArea', comp: s.comp, edit: 'lift', layers: [s.V] });
    await h.run({ type: 'insertGap', comp: s.comp, time: sec(5), duration: sec(1) });
    await h.run({ type: 'sequenceLayers', layers: [s.A, s.B, s.T], overlap: sec(0.5), crossfade: true });
    await h.run({ type: 'precompose', comp: s.comp, layers: [s.A, s.B], name: 'Pre-comp 1', mode: 'moveAll', adjustDuration: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'setRetime', layer: s.V, mode: 'speed', speed: 200 });
    await h.run({ type: 'setTimeRemap', layer: s.P, enabled: true });
    await h.run({ type: 'freezeFrame', layer: s.V, lastFrame: true });
    await h.run({ type: 'timeReverseLayers', layers: [s.T] });
    await h.run({ type: 'trimCompToWorkArea', comp: s.comp });
  },

  'effects, masks, layer styles, shape contents, presets': async (h) => {
    const s = await buildScene(h);
    const { groups: [fx2] } = await h.run({ type: 'addEffect', layers: [s.A], effect: 'drop-shadow', params: [] });
    await h.run({ type: 'movePropertyGroup', group: { layer: s.A, path: fx2! }, toIndex: 0 });
    await h.run({ type: 'addKeyframes', keys: [{ prop: { layer: s.A, path: `effects/${s.fx}/radius` }, time: sec(1), spatialIn: [], spatialOut: [] }] }).catch(() => undefined);
    await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: s.A, path: `masks/${s.mask}` }] });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/feather` }, value: scalar(12) });
    await h.run({ type: 'setAnimated', prop: { layer: s.A, path: `masks/${s.mask}/path` }, animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: `masks/${s.mask}/path` }, time: sec(1), value: { kind: 'path', value: { vertices: [0, 0, 200, 0, 200, 200, 0, 200], inTangents: [], outTangents: [], closed: true, featherPoints: [] } } });
    await h.run({ type: 'renamePropertyGroup', group: { layer: s.A, path: `masks/${s.mask}` }, name: 'Window' });
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: s.A, path: `effects/${s.fx}` }], enabled: false });
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: s.A, path: `effects/${s.fx}` }], toLayers: [s.B] });
    await h.run({ type: 'addPropertyGroup', layer: s.B, parent: 'styles', matchName: 'style:dropShadow', init: [] });
    const { groups: [op] } = await h.run({ type: 'addPropertyGroup', layer: s.B, parent: 'contents', matchName: 'pathop:trim', init: [] });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: s.B, path: op! }] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'applyPreset', layers: [s.T], preset: 'Fade In', time: sec(1) });
    await h.run({ type: 'setPluginData', layer: s.A, group: `effects/${s.fx}`, key: 'k', data: new Uint8Array([9, 8, 7]) });
  },

  'text: source text, animators, selectors': async (h) => {
    const s = await buildScene(h);
    const doc = (text: string) => ({ kind: 'textDocument' as const, value: { text, runs: [], paragraphs: [], orientation: 'horizontal' as const, kerning: 'metrics' } });
    await h.run({ type: 'setProperty', prop: { layer: s.T, path: 'text/sourceText' }, value: doc('Hello') });
    await h.run({ type: 'setAnimated', prop: { layer: s.T, path: 'text/sourceText' }, animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: { layer: s.T, path: 'text/sourceText' }, value: doc('World'), time: sec(2) });
    const { groups: [a2] } = await h.run({ type: 'addPropertyGroup', layer: s.T, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [], name: 'Second' });
    const a2id = a2!.split('/')[2]!;
    await h.run({ type: 'setAnimated', prop: { layer: s.T, path: `text/animators/${a2id}/props/opacity` }, animated: true, time: 0 });
    await h.run({ type: 'addPropertyGroup', layer: s.T, parent: `text/animators/${a2id}/selectors`, matchName: 'ADBE Text Wiggly Selector', init: [] });
    await h.run({ type: 'movePropertyGroup', group: { layer: s.T, path: a2! }, toIndex: 0 });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: s.T, path: `text/animators/${s.animator}` }] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: s.T, path: a2! }] });
  },

  '3D: switches, cameras, lights, vector properties': async (h) => {
    const s = await buildScene(h);
    await h.run({ type: 'setLayerSwitches', layers: [s.A, s.B], patch: { threeD: true } });
    const { layer: cam } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'camera', name: 'Cam', init: [] });
    const { layer: light } = await h.run({ type: 'createLayer', comp: s.comp, kind: 'light', init: [] });
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: 'transform/position' }, value: v3(10, 20, -300) });
    await h.run({ type: 'setAnimated', prop: { layer: s.A, path: 'transform/orientation' }, animated: true, time: 0 }).catch(() => undefined);
    await h.run({ type: 'setProperty', prop: { layer: cam, path: 'transform/position' }, value: v3(960, 540, -1200) });
    const tree = await h.query({ type: 'getPropertyTree', layer: light, path: '', depth: 0 });
    const intensity = tree.nodes.find((n) => n.path.endsWith('/intensity'));
    if (intensity) await h.run({ type: 'setProperty', prop: { layer: light, path: intensity.path }, value: scalar(150) });
    await h.run({ type: 'setParent', layers: [s.A], parent: cam, keepWorldTransform: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'createLayer', comp: s.comp, kind: 'model3d', init: [] });
  },

  'markers, compositions, items, render queue, project settings': async (h) => {
    const s = await buildScene(h);
    const { ids } = await h.run({ type: 'addMarkers', markers: [{ owner: { comp: s.comp, layer: s.A }, time: sec(1), duration: 0, name: 'beat', comment: '', label: 1 }] });
    await h.run({ type: 'updateMarkers', patches: [{ id: ids[0]!, name: 'drop', cuePoint: 'cue1' }, { id: s.marker, chapter: 'Act 1' }] });
    await h.run({ type: 'moveMarkers', ids: [s.marker], delta: sec(1) });
    await h.run({ type: 'deleteMarkers', ids: [ids[0]!] });
    await h.run({ type: 'setCompositionSettings', comp: s.comp, patch: { name: 'Main', frameRate: { num: 24, den: 1 }, duration: sec(12) } });
    await h.run({ type: 'setWorkArea', comp: s.comp, range: { start: 0, duration: sec(6) } });
    const { item: dup } = await h.run({ type: 'duplicateComposition', comp: s.comp2, deep: false });
    await h.run({ type: 'createLayer', comp: s.comp, kind: 'precomp', source: dup, init: [] });
    await h.run({ type: 'cropComposition', comp: s.comp2, region: { x: 0, y: 0, width: 400, height: 300 } });
    await h.run({ type: 'createComposition', settings: { name: 'From clip' }, fromItems: [s.footage] });
    await h.run({ type: 'assembleComposition', items: [s.footage, s.footage2], name: 'Cut', overlap: 0 });
    await h.run({ type: 'importFiles', files: [{ path: 'C:/m/logo.png', asSequence: false, createComposition: false }] });
    await h.run({ type: 'moveItems', items: [s.footage2], folder: s.folder });
    await h.run({ type: 'setInterpretation', items: [s.footage], patch: { conformFrameRate: { num: 24, den: 1 } } });
    await h.run({ type: 'setItemLabel', items: [s.footage], label: 5 });
    await h.run({ type: 'setItemTags', item: s.footage, tags: ['a'] });
    await h.run({ type: 'setItemComment', item: s.footage, comment: 'x' });
    await h.run({ type: 'relinkItem', item: s.footage2, path: 'D:/new/clip2.mp4', keepInterpretation: false });
    await h.run({ type: 'replaceLayerSource', layer: s.V, source: s.footage2, keepSize: true });
    await h.run({ type: 'removeUnusedItems' });
    await h.run({ type: 'undo' });
    const { items: rq } = await h.run({ type: 'addRenderItems', comps: [s.comp, s.comp2], settings: { format: 'png-seq' } });
    await h.run({ type: 'setRenderItem', item: rq[0]!, patch: { quality: 90 } });
    await h.run({ type: 'reorderRenderItems', items: [rq[1]!], toIndex: 0 });
    await h.run({ type: 'removeRenderItems', items: [rq[0]!] });
    await h.run({ type: 'setProjectSettings', patch: { bitDepth: 'f32', timeDisplay: 'frames' } });
    await h.run({ type: 'removeItems', items: [s.comp2], removeUsingLayers: true });
    await h.run({ type: 'undo' });
    const frag = await h.query({ type: 'copyLayers', layers: [s.A] });
    await h.run({ type: 'pasteLayers', comp: s.comp2, fragment: { version: frag.version, data: frag.data } });
    await h.run({ type: 'saveProject', path: 'C:/p/x.motion', copy: true });
    await h.run({ type: 'importProject', path: 'C:/p/x.motion' });
  },

  'transport and batches between edits': async (h) => {
    const s = await buildScene(h);
    await h.run({ type: 'setActiveComposition', comp: s.comp });
    await h.run({ type: 'seek', time: sec(1.5), mode: 'exact' });
    // keepWorldTransform decisions read the playhead the log carries.
    await h.run({ type: 'setParent', layers: [s.B], parent: s.P, keepWorldTransform: true });
    await h.batch('Align Left', [
      { type: 'setProperty', prop: { layer: s.A, path: 'transform/position' }, value: v2(0, 0) },
      { type: 'setProperty', prop: { layer: s.T, path: 'transform/position' }, value: v2(0, 50) },
    ]);
    await h.run({ type: 'step', frames: 10 });
    await h.run({ type: 'undo' });
    await h.run({ type: 'jumpToHistory', position: 3 });
    await h.run({ type: 'redo' });
  },

  // Only commands the C++ engine implements (C2's subset), so the cross-engine
  // replay (crossEngine.test.ts) compares every step, not just the survivors.
  'native subset: comps, solids, transform in AE units, gestures, keys, batches, history': async (h) => {
    const { item: comp } = await h.run({ type: 'createComposition', settings: { name: 'Parity', width: 1280, height: 720, frameRate: { num: 30, den: 1 }, duration: sec(10) }, fromItems: [] });
    const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
    const { layer: b } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'B', init: [] });
    const { layer: n } = await h.run({ type: 'createLayer', comp, kind: 'null', name: 'N', init: [] });
    await h.run({ type: 'setProperty', prop: { layer: a, path: 'transform/opacity' }, value: scalar(50) });
    await h.run({ type: 'setProperty', prop: { layer: a, path: 'transform/scale' }, value: v2(150, 75) });
    await h.run({ type: 'setProperty', prop: { layer: a, path: 'transform/rotation' }, value: scalar(30) });
    await h.run({ type: 'setProperty', prop: { layer: b, path: 'transform/anchorPoint' }, value: v2(10, -20) });
    // A drag: one gesture, one undo entry.
    const { gesture } = await h.run({ type: 'beginGesture', label: 'Drag Position' });
    for (let i = 0; i < 12; i++) await h.run({ type: 'setProperty', prop: { layer: b, path: 'transform/position' }, value: v2(200 + i * 10, 300) });
    await h.run({ type: 'endGesture', gesture, commit: true });
    // Esc: a cancelled gesture leaves the document as it was.
    const g2 = (await h.run({ type: 'beginGesture', label: 'Nudge' })).gesture;
    await h.run({ type: 'setProperty', prop: { layer: a, path: 'transform/rotation' }, value: scalar(90) });
    await h.run({ type: 'endGesture', gesture: g2, commit: false });
    const { ids } = await h.run({ type: 'addKeyframes', keys: [0, 1, 2].map((i) => ({ prop: { layer: a, path: 'transform/position' }, time: sec(i), value: v2(100 + 200 * i, 360), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'setProperty', prop: { layer: a, path: 'transform/position' }, value: v2(500, 500), time: sec(1) });
    await h.run({ type: 'deleteKeyframes', ids: [ids[2]!] });
    await h.run({ type: 'setAnimated', prop: { layer: b, path: 'transform/opacity' }, animated: true, time: sec(0.5) });
    await h.batch('Align', [
      { type: 'setProperty', prop: { layer: b, path: 'transform/rotation' }, value: scalar(-45) },
      { type: 'setProperty', prop: { layer: n, path: 'transform/position' }, value: v2(0, 0) },
    ]);
    await h.run({ type: 'setProperties', writes: [{ prop: { layer: a, path: 'transform/opacity' }, value: scalar(80) }, { prop: { layer: n, path: 'transform/scale' }, value: v2(50, 50) }] });
    await h.run({ type: 'renameLayer', layer: n, name: 'Controller' });
    await h.run({ type: 'reorderLayers', comp, layers: [a], toIndex: 0 });
    await h.run({ type: 'deleteLayers', layers: [b] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    const { position: top } = await h.query({ type: 'getHistory' });
    await h.run({ type: 'jumpToHistory', position: 4 });
    await h.run({ type: 'jumpToHistory', position: 9 });
    await h.run({ type: 'jumpToHistory', position: top });
    await h.run({ type: 'setCompositionSettings', comp, patch: { name: 'Parity 2' } });
  },
};

/**
 * D1b: focused sessions per command family, written while porting each family
 * to the C++ engine (crossEngine.test.ts replays them against both engines).
 * Each family keeps its sessions under its own marker comment.
 */
export const FAMILY_CORPUS: Record<string, Session> = {
  // @@family:comps-layers
  'catalog: every layer kind, footage, precomp, 2D and 3D': async (h) => {
    const comp = 'comp_root';
    const kinds = ['null', 'solid', 'shape', 'rectangle', 'ellipse', 'polygon', 'path', 'text', 'camera', 'light', 'group', 'particle', 'model3d', 'adjustment'] as const;
    const ids: string[] = [];
    for (const kind of kinds) ids.push((await h.run({ type: 'createLayer', comp, kind, name: `K ${kind}`, init: [] })).layer);
    const { items: [clip, still, sound] } = await h.run({
      type: 'importFiles',
      files: [
        { path: 'C:/m/clip.mp4', asSequence: false, createComposition: false },
        { path: 'C:/m/still.png', asSequence: false, createComposition: false },
        { path: 'C:/m/sound.wav', asSequence: false, createComposition: false },
      ],
    });
    await h.run({ type: 'createLayer', comp, kind: 'video', source: clip!, init: [] });
    await h.run({ type: 'createLayer', comp, kind: 'image', source: still!, init: [] });
    await h.run({ type: 'createLayer', comp, kind: 'audio', source: sound!, init: [] });
    await h.run({ type: 'createLayer', comp, kind: 'sequence', source: still!, name: 'Seq', init: [] });
    const { item: inner } = await h.run({ type: 'createComposition', settings: { name: 'Inner', width: 640, height: 480 }, fromItems: [] });
    await h.run({ type: 'createLayer', comp, kind: 'precomp', source: inner, init: [] });
    await h.run({ type: 'setLayerSwitches', layers: [ids[1]!, ids[2]!, ids[7]!, ids[0]!], patch: { threeD: true } });
    await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'Init', init: [{ path: 'transform/opacity', value: scalar(40) }, { path: 'transform/position', value: v2(10, 20) }], index: 2 });
    await h.run({ type: 'createLayer', comp, kind: 'null', name: 'Child', parent: ids[0]!, init: [] });
    await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'Timed', inPoint: sec(1), outPoint: sec(3), startTime: sec(0.5), init: [] });
  },

  'compositions: create, settings, work area, trim, crop, duplicate, assemble': async (h) => {
    const comp = 'comp_root';
    const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: a, path: 'transform/position' }, time: 0, value: v2(100, 100), spatialIn: [], spatialOut: [] },
      { prop: { layer: a, path: 'transform/position' }, time: sec(2), value: v2(500, 300), spatialIn: [], spatialOut: [] },
    ] });
    const { item: c2 } = await h.run({ type: 'createComposition', settings: { name: 'Settings', width: 1280, height: 720, frameRate: { num: 24, den: 1 }, duration: sec(6), background: { r: 1, g: 0, b: 0, a: 1 }, transparent: true }, fromItems: [] });
    await h.run({ type: 'createLayer', comp: c2, kind: 'shape', name: 'S', init: [] });
    await h.run({ type: 'setCompositionSettings', comp: c2, patch: { frameRate: { num: 30000, den: 1001 }, pixelAspect: 0.9, globalLightAngle: 30, globalLightAltitude: 60, renderer3d: 'advanced', dropFrame: true } });
    await h.run({ type: 'setCompositionSettings', comp, patch: { duration: sec(8), workArea: { start: sec(1), duration: sec(4) }, startTimecode: sec(1) } });
    await h.run({ type: 'setCompositionSettings', comp, patch: { motionBlur: { shutterAngle: 90, shutterPhase: -45, samplesPerFrame: 4, adaptiveSampleLimit: 64 } } });
    await h.run({ type: 'setWorkArea', comp: c2, range: { start: sec(0.5), duration: sec(2) } });
    await h.run({ type: 'trimCompToWorkArea', comp });
    await h.run({ type: 'undo' });
    await h.run({ type: 'trimCompToWorkArea', comp });
    await h.run({ type: 'cropComposition', comp, region: { x: 100, y: 50, width: 800, height: 600 } });
    const { item: dup } = await h.run({ type: 'duplicateComposition', comp, deep: false });
    await h.run({ type: 'createLayer', comp: dup, kind: 'precomp', source: c2, init: [] });
    await h.run({ type: 'duplicateComposition', comp: dup, deep: true });
    await h.run({ type: 'setCompositionSettings', comp: c2, patch: { width: 3 } }).catch(() => undefined);
    await h.run({ type: 'setWorkArea', comp, range: { start: sec(100), duration: sec(1) } }).catch(() => undefined);
    const { items: [f1, f2] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/m/one.mp4', asSequence: false, createComposition: false }, { path: 'C:/m/two.mp4', asSequence: false, createComposition: false }] });
    await h.run({ type: 'assembleComposition', items: [f1!, f2!], name: 'Cut', overlap: sec(0.5) });
    await h.run({ type: 'createComposition', settings: {}, fromItems: [f2!] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
  },
  // @@family:items-markers-misc
  'project items: folders, assignment, interpretation survive save → New Project → open (674bf37d)': async (h) => {
    const comp = 'comp_root';
    const { items: [clip, still, sound] } = await h.run({ type: 'importFiles', files: [
      { path: 'C:/m/plate.mp4', asSequence: false, createComposition: false },
      { path: 'C:/m/logo.png', asSequence: false, createComposition: false },
      { path: 'C:/m/vo.wav', asSequence: false, createComposition: false },
    ] });
    const { item: f1 } = await h.run({ type: 'createFolder', name: 'Footage' });
    const { item: f2 } = await h.run({ type: 'createFolder', name: 'Plates', parent: f1 });
    await h.run({ type: 'moveItems', items: [clip!], folder: f2 });
    await h.run({ type: 'moveItems', items: [still!], folder: f1 });
    await h.run({ type: 'setInterpretation', items: [clip!], patch: { conformFrameRate: { num: 24, den: 1 }, alpha: 'premultiplied', fieldOrder: 'upperFirst', loops: 3, pixelAspect: 2 } });
    await h.run({ type: 'setItemLabel', items: [clip!, sound!], label: 5 });
    await h.run({ type: 'setItemTags', item: clip!, tags: ['hero', 'plate'] });
    await h.run({ type: 'setItemComment', item: still!, comment: 'approved' });
    await h.run({ type: 'createLayer', comp, kind: 'video', source: clip!, init: [] });
    await h.run({ type: 'saveProject', path: 'C:/p/items.motion', copy: false });
    await h.run({ type: 'newProject' });
    // New Project starts with no items and no folders.
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    // An EMPTY project saves a stated-empty item list, and reopens empty.
    await h.run({ type: 'saveProject', path: 'C:/p/empty.motion', copy: true });
    await h.run({ type: 'openProject', path: 'C:/p/items.motion' });
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    // Organisation changed after the save is not kept on reopen: the document decides.
    await h.run({ type: 'moveItems', items: [clip!] });
    await h.run({ type: 'setInterpretation', items: [clip!], patch: { clearConform: true, loops: 1 } });
    // Fields the document leaves OUT are cleared on reopen, not kept from the session.
    await h.run({ type: 'moveItems', items: [sound!], folder: f1 });
    await h.run({ type: 'setItemComment', item: sound!, comment: 'late' });
    await h.run({ type: 'setItemTags', item: sound!, tags: ['late'] });
    await h.run({ type: 'setInterpretation', items: [sound!], patch: { loops: 2 } });
    await h.run({ type: 'openProject', path: 'C:/p/items.motion' });
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    await h.run({ type: 'openProject', path: 'C:/p/empty.motion' });
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    await h.run({ type: 'openProject', path: 'C:/p/items.motion' });
  },
  'items: import, folders, move, rename, interpret, label, tags, comment, proxy, relink, remove': async (h) => {
    const comp = 'comp_root';
    const fail = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);
    await fail(h.run({ type: 'importFiles', files: [] }));
    await fail(h.run({ type: 'importFiles', files: [{ path: 'C:/m/a.mp4', asSequence: false, folder: 'nope', createComposition: false }] }));
    await fail(h.run({ type: 'importFiles', files: [{ path: 'C:/m/a.mp4', asSequence: false, createComposition: true }] }));
    await fail(h.run({ type: 'importFiles', files: [{ path: 'C:/m/a.mp4', asSequence: false, createComposition: false, interpretation: { alpha: 'ignore' } }] }));
    const { item: bin } = await h.run({ type: 'createFolder', name: '  Bin  ' });
    const { item: sub } = await h.run({ type: 'createFolder', name: '', parent: bin });
    await fail(h.run({ type: 'createFolder', name: 'X', parent: 'nope' }));
    const { items: [clip, still, sound] } = await h.run({
      type: 'importFiles',
      files: [
        { path: 'C:/m/clip.mp4', asSequence: false, createComposition: false, folder: bin, interpretation: { conformFrameRate: { num: 24, den: 1 }, pixelAspect: 2, fieldOrder: 'upperFirst', loops: 2 } },
        { path: 'C:/m/still.png', asSequence: false, createComposition: false },
        { path: 'C:/m/sound.wav', asSequence: false, createComposition: false },
      ],
    });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    await h.run({ type: 'createLayer', comp, kind: 'video', source: clip!, init: [] });
    await h.run({ type: 'renameItem', item: clip!, name: 'Hero clip' });
    await h.run({ type: 'renameItem', item: sub, name: 'Sub' });
    await h.run({ type: 'renameItem', item: comp, name: 'Main' });
    await fail(h.run({ type: 'renameItem', item: still!, name: '   ' }));
    await fail(h.run({ type: 'renameItem', item: 'nope', name: 'x' }));
    await h.run({ type: 'moveItems', items: [still!, comp], folder: sub });
    await h.run({ type: 'moveItems', items: [comp] });
    await fail(h.run({ type: 'moveItems', items: [bin], folder: sub }));
    await fail(h.run({ type: 'moveItems', items: [still!], folder: 'nope' }));
    await h.run({ type: 'setInterpretation', items: [clip!, still!], patch: { alpha: 'straight', fieldOrder: 'progressive', clearConform: true } });
    await h.run({ type: 'setInterpretation', items: [still!], patch: { alpha: 'auto', loops: 3 } });
    await fail(h.run({ type: 'setInterpretation', items: [comp], patch: { loops: 1 } }));
    await fail(h.run({ type: 'setInterpretation', items: [still!], patch: { pixelAspect: 0 } }));
    await fail(h.run({ type: 'setInterpretation', items: [still!], patch: { invertAlpha: true } }));
    await fail(h.run({ type: 'setInterpretation', items: [still!], patch: { colorProfile: 'sRGB' } }));
    await fail(h.run({ type: 'setInterpretation', items: [still!], patch: { conformFrameRate: { num: 0, den: 1 } } }));
    await h.run({ type: 'setItemLabel', items: [clip!, comp], label: 3 });
    await h.run({ type: 'setItemLabel', items: [clip!], label: 0 });
    await fail(h.run({ type: 'setItemLabel', items: [bin], label: 1 }));
    await fail(h.run({ type: 'setItemLabel', items: [clip!], label: 99 }));
    await h.run({ type: 'setItemTags', item: still!, tags: ['bg', 'plate'] });
    await h.run({ type: 'setItemTags', item: still!, tags: [] });
    await h.run({ type: 'setItemTags', item: sound!, tags: ['vo'] });
    await fail(h.run({ type: 'setItemTags', item: comp, tags: ['x'] }));
    await h.run({ type: 'setItemComment', item: clip!, comment: 'hero' });
    await h.run({ type: 'setItemComment', item: comp, comment: 'main comp' });
    await h.run({ type: 'setItemComment', item: comp, comment: '' });
    await fail(h.run({ type: 'setItemComment', item: bin, comment: 'x' }));
    await h.run({ type: 'setProxy', item: clip!, path: 'C:/p/clip_proxy.mp4', enabled: true });
    await h.run({ type: 'setProxy', item: clip!, enabled: false });
    await h.run({ type: 'setProxy', item: still!, path: 'C:/p/still_proxy.png', enabled: false });
    await h.run({ type: 'setProxy', item: still!, enabled: false });
    await fail(h.run({ type: 'setProxy', item: comp, enabled: true }));
    await h.run({ type: 'relinkItem', item: clip!, path: 'D:/moved/clip.mp4', keepInterpretation: true });
    await h.run({ type: 'relinkItem', item: still!, path: 'D:/moved/still.png', keepInterpretation: false });
    await fail(h.run({ type: 'relinkItem', item: comp, path: 'D:/x.mp4', keepInterpretation: false }));
    await fail(h.run({ type: 'relinkItem', item: still!, path: '  ', keepInterpretation: false }));
    await h.batch('Organise', [
      { type: 'renameItem', item: sound!, name: 'VO' },
      { type: 'moveItems', items: [sound!], folder: bin },
      { type: 'setItemLabel', items: [sound!], label: 5 },
    ]);
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    await fail(h.run({ type: 'removeItems', items: [], removeUsingLayers: false }));
    await fail(h.run({ type: 'removeItems', items: [clip!], removeUsingLayers: false }));
    await h.run({ type: 'removeItems', items: [bin], removeUsingLayers: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'removeUnusedItems' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'removeItems', items: [clip!, still!], removeUsingLayers: true });
    await h.run({ type: 'undo' });
    const { item: c2 } = await h.run({ type: 'createComposition', settings: { name: 'Inner' }, fromItems: [] });
    await h.run({ type: 'createLayer', comp: c2, kind: 'solid', name: 'S', init: [] });
    await h.run({ type: 'createLayer', comp, kind: 'precomp', source: c2, init: [] });
    await fail(h.run({ type: 'removeItems', items: [c2], removeUsingLayers: false }));
    await h.run({ type: 'removeItems', items: [c2], removeUsingLayers: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
  },

  'render queue: add, settings, queue state, reorder, remove, refusals': async (h) => {
    const comp = 'comp_root';
    const fail = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);
    const { item: c2 } = await h.run({ type: 'createComposition', settings: { name: 'Two', duration: sec(4) }, fromItems: [] });
    await fail(h.run({ type: 'addRenderItems', comps: [], settings: {} }));
    await fail(h.run({ type: 'addRenderItems', comps: ['nope'], settings: {} }));
    const { items: [r1, r2] } = await h.run({ type: 'addRenderItems', comps: [comp, c2], settings: { format: 'png-seq', width: 640, quality: 50 } });
    const { items: [r3] } = await h.run({ type: 'addRenderItems', comps: [c2], settings: {} });
    await h.run({ type: 'setRenderItem', item: r1!, patch: { outputPath: 'C:/out/a', bitDepth: 'u16', frameRate: { num: 25, den: 1 }, encoderOptions: '{"crf":18}' } });
    await h.run({ type: 'setRenderItem', item: r2!, patch: {}, queued: false });
    await h.run({ type: 'setRenderItem', item: r2!, patch: { includeAlpha: true }, queued: true });
    await fail(h.run({ type: 'setRenderItem', item: 'nope', patch: {} }));
    await h.run({ type: 'reorderRenderItems', items: [r3!], toIndex: 0 });
    await h.run({ type: 'reorderRenderItems', items: [r3!, r1!], toIndex: 3 });
    await h.run({ type: 'reorderRenderItems', items: [r2!], toIndex: 1 });
    await fail(h.run({ type: 'reorderRenderItems', items: [r2!], toIndex: 9 }));
    await fail(h.run({ type: 'reorderRenderItems', items: ['nope'], toIndex: 0 }));
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.query({ type: 'getRenderQueue' }).catch(() => undefined);
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    await fail(h.run({ type: 'removeRenderItems', items: [r1!, 'nope'] }));
    await h.run({ type: 'removeRenderItems', items: [r1!, r3!] });
    await h.run({ type: 'undo' });
    await h.batch('Queue', [
      { type: 'setRenderItem', item: r3!, patch: { quality: 99 } },
      { type: 'removeRenderItems', items: [r1!] },
    ]);
    await h.run({ type: 'removeItems', items: [c2], removeUsingLayers: true });
  },

  'markers: composition and layer markers, update, move, delete, refusals': async (h) => {
    const comp = 'comp_root';
    const fail = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);
    const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
    const { item: c2 } = await h.run({ type: 'createComposition', settings: { name: 'C24', frameRate: { num: 24, den: 1 } }, fromItems: [] });
    const { layer: b } = await h.run({ type: 'createLayer', comp: c2, kind: 'shape', name: 'B', init: [] });
    await fail(h.run({ type: 'addMarkers', markers: [] }));
    await fail(h.run({ type: 'addMarkers', markers: [{ owner: { comp: 'nope' }, time: 0, duration: 0, name: '', comment: '', label: 0 }] }));
    await fail(h.run({ type: 'addMarkers', markers: [{ owner: { comp, layer: b }, time: 0, duration: 0, name: '', comment: '', label: 0 }] }));
    await fail(h.run({ type: 'addMarkers', markers: [{ owner: { comp }, time: 0, duration: -5, name: '', comment: '', label: 0 }] }));
    await fail(h.run({ type: 'addMarkers', markers: [{ owner: { comp }, time: 0, duration: 0, name: '', comment: '', label: 42 }] }));
    const { ids: [m1, m2, m3] } = await h.run({ type: 'addMarkers', markers: [
      { owner: { comp }, time: sec(3), duration: sec(1), name: 'Chorus', comment: 'loud', label: 2 },
      { owner: { comp }, time: sec(1), duration: 0, name: 'Intro', comment: '', label: 0 },
      { owner: { comp, layer: a }, time: sec(0.5), duration: 0, name: 'hit', comment: '', label: 7 },
    ] });
    const { ids: [m4] } = await h.run({ type: 'addMarkers', markers: [{ owner: { comp: c2, layer: b }, time: sec(2), duration: sec(0.5), name: 'b', comment: '', label: 1 }] });
    await h.run({ type: 'addMarkers', markers: [{ owner: { comp: c2 }, time: sec(1), duration: 0, name: 'c2', comment: '', label: 0 }] });
    await h.query({ type: 'getMarkers', owner: { comp } });
    await h.query({ type: 'getMarkers', owner: { comp, layer: a } });
    await h.run({ type: 'updateMarkers', patches: [
      { id: m1!, time: sec(0.25), name: 'Chorus 2', label: 0, chapter: 'Ch 1', url: 'https://example.com', cuePoint: 'cue', protectedRegion: true },
      { id: m3!, duration: sec(2), comment: 'note', label: 4 },
      { id: m4!, time: sec(0.5) },
    ] });
    await fail(h.run({ type: 'updateMarkers', patches: [] }));
    await fail(h.run({ type: 'updateMarkers', patches: [{ id: 'nope', name: 'x' }] }));
    await fail(h.run({ type: 'updateMarkers', patches: [{ id: m1!, duration: -1 }] }));
    await fail(h.run({ type: 'updateMarkers', patches: [{ id: m1!, label: 77 }] }));
    await h.run({ type: 'moveMarkers', ids: [m2!, m4!], delta: sec(2) });
    await h.run({ type: 'moveMarkers', ids: [m1!], delta: -sec(0.1) });
    await fail(h.run({ type: 'moveMarkers', ids: ['nope'], delta: sec(1) }));
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.batch('Marker pass', [
      { type: 'addMarkers', markers: [{ owner: { comp }, time: sec(5), duration: 0, name: 'Out', comment: '', label: 3 }] },
      { type: 'updateMarkers', patches: [{ id: m2!, name: 'Start' }] },
    ]);
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    await fail(h.run({ type: 'deleteMarkers', ids: [] }));
    await fail(h.run({ type: 'deleteMarkers', ids: [m2!, 'nope'] }));
    await h.run({ type: 'deleteMarkers', ids: [m2!, m3!] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'deleteMarkers', ids: [m4!] });
    await h.query({ type: 'getComposition', comp: c2 });
  },

  'project: settings, plugin data, save → open → revert, import project, jobs': async (h) => {
    const comp = 'comp_root';
    const fail = (p: Promise<unknown>): Promise<unknown> => p.catch(() => undefined);
    await fail(h.run({ type: 'setProjectSettings', patch: { framesStartAt: 2 } }));
    await fail(h.run({ type: 'setProjectSettings', patch: { audioSampleRate: 100 } }));
    await h.run({ type: 'setProjectSettings', patch: { bitDepth: 'f32', workingSpace: 'acescg', timeDisplay: 'frames', framesStartAt: 1 } });
    await h.run({ type: 'setProjectSettings', patch: { bitDepth: 'u16', audioSampleRate: 44100, linearBlending: true } });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await fail(h.run({ type: 'applyJobResult', job: 'job_1' }));
    const { items: [clip, still] } = await h.run({ type: 'importFiles', files: [
      { path: 'C:/m/clip.mp4', asSequence: false, createComposition: false },
      { path: 'C:/m/still.png', asSequence: false, createComposition: false },
    ] });
    const { item: bin } = await h.run({ type: 'createFolder', name: 'Bin' });
    await h.run({ type: 'moveItems', items: [still!], folder: bin });
    await h.run({ type: 'setItemTags', item: still!, tags: ['t'] });
    const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
    const { layer: v } = await h.run({ type: 'createLayer', comp, kind: 'video', source: clip!, init: [] });
    await h.run({ type: 'addKeyframes', keys: [0, 1].map((i) => ({ prop: { layer: a, path: 'transform/position' }, time: sec(i), value: v2(100 + i * 300, 200), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'setPluginData', layer: a, group: 'effects/x', key: 'k', data: new Uint8Array([1, 2, 3, 250]) });
    await h.run({ type: 'setPluginData', layer: a, group: 'effects/x', key: 'j', data: new Uint8Array([7]) });
    await h.run({ type: 'setPluginData', layer: a, group: 'effects/x', key: 'k', data: new Uint8Array([]) });
    await fail(h.run({ type: 'setPluginData', layer: a, group: 'g', key: '', data: new Uint8Array([1]) }));
    await fail(h.run({ type: 'setPluginData', layer: 'nope', group: 'g', key: 'k', data: new Uint8Array([1]) }));
    await h.run({ type: 'addMarkers', markers: [{ owner: { comp }, time: sec(1), duration: 0, name: 'M', comment: '', label: 1 }, { owner: { comp, layer: v }, time: sec(0.5), duration: 0, name: 'L', comment: '', label: 0 }] });
    await h.run({ type: 'setWorkArea', comp, range: { start: sec(1), duration: sec(2) } });
    const { items: [rq] } = await h.run({ type: 'addRenderItems', comps: [comp], settings: { format: 'png-seq' } });
    await h.run({ type: 'setRenderItem', item: rq!, patch: { quality: 70 }, queued: false });
    const { item: inner } = await h.run({ type: 'createComposition', settings: { name: 'Inner', width: 640, height: 360 }, fromItems: [] });
    await h.run({ type: 'createLayer', comp: inner, kind: 'text', name: 'Title', init: [] });
    await h.run({ type: 'createLayer', comp, kind: 'precomp', source: inner, init: [] });
    await h.run({ type: 'saveProject', path: 'C:/p/a.motion', copy: false });
    await h.run({ type: 'renameLayer', layer: a, name: 'Changed' });
    await h.run({ type: 'setProjectSettings', patch: { timeDisplay: 'timecode' } });
    await h.run({ type: 'revertProject' });
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    await h.run({ type: 'importProject', path: 'C:/p/a.motion', folder: bin });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await fail(h.run({ type: 'importProject', path: 'C:/p/missing.motion' }));
    await fail(h.run({ type: 'importProject', path: 'C:/p/a.aep' }));
    await fail(h.run({ type: 'importProject', path: 'C:/p/a.motion', folder: 'nope' }));
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    // Footage the session no longer holds reopens as a missing placeholder.
    await h.run({ type: 'removeItems', items: [still!], removeUsingLayers: true });
    await h.run({ type: 'openProject', path: 'C:/p/a.motion' });
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    await h.run({ type: 'relinkItem', item: still!, path: 'E:/found/still.png', keepInterpretation: true });
    await h.run({ type: 'saveProject', path: 'C:/p/b.motion', copy: true });
    const { items: imported } = await h.run({ type: 'importProject', path: 'C:/p/b.motion' });
    await fail(h.run({ type: 'openProject', path: 'C:/p/none.motion' }));
    await h.query({ type: 'getDocument', includeProperties: false, includeKeyframes: false });
    // Imported layers are minted without appearing in any result (the replay's
    // id map cannot pair them), so the session removes what it imported.
    await h.run({ type: 'removeItems', items: imported, removeUsingLayers: true });
    // documentReset carries no layer records: restate the name the mirrors hold.
    await h.run({ type: 'renameLayer', layer: a, name: 'Final' });
  },
  // @@family:layertime
  'layer time: timing, stretch, move, trim, slip, slide, roll, ripple, refusals': async (h) => {
    const comp = 'comp_root';
    const mk = async (name: string) => (await h.run({ type: 'createLayer', comp, kind: 'solid', name, init: [] })).layer;
    const A = await mk('A');
    const B = await mk('B');
    const C = await mk('C');
    const D = await mk('D');
    const { items: [clip] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/m/clip.mp4', asSequence: false, createComposition: false }] });
    const { layer: V } = await h.run({ type: 'createLayer', comp, kind: 'video', source: clip!, name: 'V', init: [] });
    const { item: c2 } = await h.run({ type: 'createComposition', settings: { name: 'Other', width: 640, height: 360 }, fromItems: [] });
    const { layer: O } = await h.run({ type: 'createLayer', comp: c2, kind: 'solid', name: 'O', init: [] });
    await h.run({ type: 'addKeyframes', keys: [0, 1, 2].map((i) => ({ prop: { layer: B, path: 'transform/position' }, time: sec(2 + i), value: v2(100 * i, 50), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'setLayerTiming', items: [{ layer: A, inPoint: 0, outPoint: sec(2) }, { layer: B, inPoint: sec(2), outPoint: sec(4) }, { layer: C, inPoint: sec(4), outPoint: sec(6) }, { layer: D, inPoint: sec(7), outPoint: sec(8) }] });
    await h.run({ type: 'setLayerTiming', items: [{ layer: V, startTime: sec(1) }, { layer: B, stretch: 0.5 }, { layer: C, stretch: -2 }] });
    await h.run({ type: 'setLayerTiming', items: [{ layer: V, inPoint: sec(1.5), outPoint: sec(4) }, { layer: D, startTime: sec(6), stretch: 1 }] });
    // Refusals.
    await h.run({ type: 'setLayerTiming', items: [] }).catch(() => undefined);
    await h.run({ type: 'setLayerTiming', items: [{ layer: 'layer_nope', inPoint: 0 }] }).catch(() => undefined);
    await h.run({ type: 'setLayerTiming', items: [{ layer: A, stretch: 0 }] }).catch(() => undefined);
    await h.run({ type: 'setLayerTiming', items: [{ layer: A, stretch: 20 }] }).catch(() => undefined);
    await h.run({ type: 'setLayerTiming', items: [{ layer: A, inPoint: sec(3) }] }).catch(() => undefined);
    await h.run({ type: 'setLayerTiming', items: [{ layer: V, outPoint: sec(9) }] }).catch(() => undefined);
    await h.run({ type: 'setLayerTiming', items: [{ layer: V, inPoint: 0 }] }).catch(() => undefined);
    // Move (+ ripple), trim (+ ripple), slip.
    await h.run({ type: 'moveLayersInTime', layers: [A], delta: sec(0.5), ripple: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'moveLayersInTime', layers: [A, B], delta: sec(-0.25), ripple: false });
    await h.run({ type: 'moveLayersInTime', layers: [A, O], delta: sec(1), ripple: false }).catch(() => undefined);
    await h.run({ type: 'moveLayersInTime', layers: [A, A], delta: sec(1), ripple: false }).catch(() => undefined);
    await h.run({ type: 'moveLayersInTime', layers: [], delta: sec(1), ripple: false }).catch(() => undefined);
    await h.run({ type: 'trimLayers', layers: [B], edge: 'in', time: sec(2.5), ripple: true });
    await h.run({ type: 'trimLayers', layers: [A], edge: 'out', time: sec(1.5), ripple: true });
    await h.run({ type: 'trimLayers', layers: [C], edge: 'out', time: sec(7.5), ripple: false });
    await h.run({ type: 'trimLayers', layers: [C, D], edge: 'out', time: sec(7.5), ripple: false }).catch(() => undefined);
    await h.run({ type: 'trimLayers', layers: [A], edge: 'in', time: sec(5), ripple: false }).catch(() => undefined);
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'slipLayers', layers: [V], delta: sec(0.25) });
    await h.run({ type: 'slipLayers', layers: [V], delta: sec(-5) }).catch(() => undefined);
    await h.run({ type: 'slipLayers', layers: [V], delta: sec(5) }).catch(() => undefined);
    await h.run({ type: 'slipLayers', layers: [A, B], delta: sec(1) });
    // Slide between neighbours, roll a cut.
    await h.run({ type: 'setLayerTiming', items: [{ layer: A, inPoint: 0, outPoint: sec(2) }, { layer: B, inPoint: sec(2), outPoint: sec(4) }, { layer: C, inPoint: sec(4), outPoint: sec(6) }] });
    await h.run({ type: 'slideLayer', layer: B, delta: sec(0.25) });
    await h.run({ type: 'slideLayer', layer: B, delta: sec(-5) }).catch(() => undefined);
    await h.run({ type: 'rollEdit', left: B, right: C, delta: sec(-0.5) });
    await h.run({ type: 'rollEdit', left: A, right: C, delta: sec(0.5) }).catch(() => undefined);
    await h.run({ type: 'rollEdit', left: A, right: B, delta: sec(-3) }).catch(() => undefined);
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.batch('Nudge Cut', [
      { type: 'moveLayersInTime', layers: [D], delta: sec(0.5), ripple: false },
      { type: 'trimLayers', layers: [D], edge: 'in', time: sec(6.75), ripple: false },
      { type: 'slipLayers', layers: [V], delta: sec(0.1) },
    ]);
    await h.batch('Bad Batch', [
      { type: 'moveLayersInTime', layers: [D], delta: sec(0.5), ripple: false },
      { type: 'trimLayers', layers: [D], edge: 'out', time: 0, ripple: false },
    ]).catch(() => undefined);
    await h.query({ type: 'getLayers', layers: [A, B, C, D, V] });
  },

  'layer time: split, ripple delete, work area, insert gap, sequence': async (h) => {
    const comp = 'comp_root';
    const mk = async (name: string, kind: 'solid' | 'shape' | 'null' = 'solid') => (await h.run({ type: 'createLayer', comp, kind, name, init: [] })).layer;
    const A = await mk('A');
    const B = await mk('B', 'shape');
    const C = await mk('C');
    const N = await mk('N', 'null');
    const { items: [clip] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/m/clip.mp4', asSequence: false, createComposition: false }] });
    const { layer: V } = await h.run({ type: 'createLayer', comp, kind: 'video', source: clip!, name: 'V', init: [] });
    const { layer: K } = await h.run({ type: 'createLayer', comp, kind: 'null', name: 'Kid', parent: B, init: [] });
    await h.run({ type: 'addKeyframes', keys: [0, 1, 2].map((i) => ({ prop: { layer: A, path: 'transform/position' }, time: sec(i), value: v2(100 + 100 * i, 300), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'addKeyframes', keys: [0, 2].map((i) => ({ prop: { layer: A, path: 'transform/opacity' }, time: sec(i), value: scalar(100 - 40 * i), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'setExpression', prop: { layer: A, path: 'transform/rotation' }, source: 'time * 10', enabled: true });
    await h.run({ type: 'setLayerSwitches', layers: [A], patch: { shy: true, solo: true, label: 3 } });
    await h.run({ type: 'setLayerTiming', items: [{ layer: A, inPoint: 0, outPoint: sec(3) }, { layer: B, inPoint: sec(3), outPoint: sec(5) }, { layer: C, inPoint: sec(5), outPoint: sec(8) }, { layer: N, inPoint: sec(8), outPoint: sec(9) }] });
    // Split: some cut, one not, one footage; a time that cuts nothing.
    const { layers: halves } = await h.run({ type: 'splitLayers', layers: [A, V, N], time: sec(1) });
    await h.run({ type: 'setProperty', prop: { layer: halves[0]!, path: 'transform/position' }, value: v2(1, 2), time: sec(2) });
    await h.run({ type: 'splitLayers', layers: [N], time: sec(2) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'splitLayers', layers: [B, C], time: sec(6) });
    // Ripple delete: a layer with a child, a refusal on a locked layer.
    await h.run({ type: 'rippleDeleteLayers', layers: [B] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'rippleDeleteLayers', layers: [B, N] });
    await h.run({ type: 'setLayerSwitches', layers: [C], patch: { locked: true } });
    await h.run({ type: 'rippleDeleteLayers', layers: [C] }).catch(() => undefined);
    await h.run({ type: 'setLayerSwitches', layers: [C], patch: { locked: false } });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    // Work area lift / extract (all layers, and a subset); refusals.
    await h.run({ type: 'setWorkArea', comp, range: { start: sec(0.5), duration: sec(1) } });
    await h.run({ type: 'editWorkArea', comp, edit: 'lift', layers: [] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'editWorkArea', comp, edit: 'extract', layers: [] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'editWorkArea', comp, edit: 'extract', layers: [A, K] });
    const { item: c2 } = await h.run({ type: 'createComposition', settings: { name: 'Other' }, fromItems: [] });
    await h.run({ type: 'editWorkArea', comp: c2, edit: 'lift', layers: [A] }).catch(() => undefined);
    await h.run({ type: 'editWorkArea', comp: 'comp_nope', edit: 'lift', layers: [] }).catch(() => undefined);
    await h.run({ type: 'editWorkArea', comp: c2, edit: 'lift', layers: [] });
    // Insert gap.
    await h.run({ type: 'insertGap', comp, time: sec(2), duration: sec(1) });
    await h.run({ type: 'insertGap', comp, time: sec(50), duration: sec(1) });
    await h.run({ type: 'insertGap', comp, time: sec(2), duration: 0 }).catch(() => undefined);
    await h.run({ type: 'insertGap', comp: 'comp_nope', time: 0, duration: sec(1) }).catch(() => undefined);
    // Sequence with crossfades (keys onto layers that have none and one that has).
    await h.run({ type: 'sequenceLayers', layers: [C, A, N, V], overlap: sec(0.5), crossfade: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'sequenceLayers', layers: [N, C], overlap: 0, crossfade: true });
    await h.run({ type: 'sequenceLayers', layers: [A, B], overlap: sec(-1), crossfade: false });
    await h.run({ type: 'sequenceLayers', layers: [A, K], overlap: sec(0.25), crossfade: true }).catch(() => undefined);
    await h.batch('Split and Close', [
      { type: 'splitLayers', layers: [C], time: sec(3) },
      { type: 'insertGap', comp, time: sec(1), duration: sec(0.5) },
    ]);
  },

  'layer time: reverse, time remap, freeze, retime speed and frame conversions': async (h) => {
    const comp = 'comp_root';
    const { items: [clip] } = await h.run({ type: 'importFiles', files: [{ path: 'C:/m/clip.mp4', asSequence: false, createComposition: false }] });
    const { layer: V } = await h.run({ type: 'createLayer', comp, kind: 'video', source: clip!, name: 'V', init: [] });
    const { layer: W } = await h.run({ type: 'createLayer', comp, kind: 'video', source: clip!, name: 'W', init: [] });
    const { layer: A } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
    await h.run({ type: 'addKeyframes', keys: [0, 1, 3].map((i) => ({ prop: { layer: A, path: 'transform/rotation' }, time: sec(i), value: scalar(i * 30), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'addKeyframes', keys: [0.5, 2].map((i) => ({ prop: { layer: V, path: 'transform/opacity' }, time: sec(i), value: scalar(i * 20), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'setLayerTiming', items: [{ layer: V, inPoint: sec(0.5), outPoint: sec(3.5) }, { layer: W, startTime: sec(1) }] });
    // Reverse on and off.
    await h.run({ type: 'timeReverseLayers', layers: [V, A] });
    await h.run({ type: 'timeReverseLayers', layers: [A] });
    await h.run({ type: 'timeReverseLayers', layers: ['layer_nope'] }).catch(() => undefined);
    // Time remap on / off / off-again.
    await h.run({ type: 'setTimeRemap', layer: W, enabled: true });
    await h.run({ type: 'setTimeRemap', layer: W, enabled: true });
    await h.run({ type: 'setTimeRemap', layer: W, enabled: false });
    await h.run({ type: 'setTimeRemap', layer: A, enabled: false });
    await h.run({ type: 'setTimeRemap', layer: A, enabled: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'setTimeRemap', layer: 'layer_nope', enabled: true }).catch(() => undefined);
    // Freeze: last frame, at a time, default.
    await h.run({ type: 'freezeFrame', layer: A, time: sec(1.5), lastFrame: false });
    await h.run({ type: 'freezeFrame', layer: V, lastFrame: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'freezeFrame', layer: W, lastFrame: false });
    await h.run({ type: 'freezeFrame', layer: 'layer_nope', lastFrame: true }).catch(() => undefined);
    await h.run({ type: 'setLayerTiming', items: [{ layer: A, stretch: 1.5 }] });
    // Retime: normal → speed → frames → speed → normal, and the refusals.
    await h.run({ type: 'setRetime', layer: V, mode: 'speed' });
    await h.run({ type: 'setRetime', layer: V, mode: 'speed', speed: 50 });
    await h.run({ type: 'setRetime', layer: V, mode: 'speed', speed: 5000 });
    await h.run({ type: 'setRetime', layer: V, mode: 'frames' });
    await h.run({ type: 'setRetime', layer: V, mode: 'speed' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'setRetime', layer: V, mode: 'normal' });
    await h.run({ type: 'setRetime', layer: V, mode: 'normal' });
    await h.run({ type: 'setRetime', layer: V, mode: 'frames', speed: 50 }).catch(() => undefined);
    await h.run({ type: 'setRetime', layer: V, mode: 'speed', speed: Number.NaN }).catch(() => undefined);
    await h.run({ type: 'setRetime', layer: 'layer_nope', mode: 'speed' }).catch(() => undefined);
    // A shaped speed curve (hold, linear, eased) baked to frames and back.
    await h.run({ type: 'setRetime', layer: W, mode: 'speed', speed: 100 });
    const { ids: sk } = await h.run({ type: 'addKeyframes', keys: [[1.5, 40], [2.5, 250], [3.5, 80]].map(([t, v]) => ({ prop: { layer: W, path: 'layer/timeSpeed' }, time: sec(t!), value: scalar(v!), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'updateKeyframes', patches: [{ id: sk[0]!, easing: 'hold', spatialIn: [], spatialOut: [] }, { id: sk[1]!, easing: 'easeInOut', spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'setRetime', layer: W, mode: 'frames' });
    await h.run({ type: 'setRetime', layer: W, mode: 'speed' });
    await h.run({ type: 'setRetime', layer: W, mode: 'frames' });
    await h.run({ type: 'setTimeRemap', layer: W, enabled: false });
    await h.run({ type: 'setRetime', layer: A, mode: 'frames' });
    await h.run({ type: 'setRetime', layer: A, mode: 'speed', speed: -200 });
    // Keyframes survive a retime of the bar (move, split, stretch).
    await h.run({ type: 'moveLayersInTime', layers: [A, V], delta: sec(0.5), ripple: false });
    await h.run({ type: 'splitLayers', layers: [A, V], time: sec(2) });
    await h.batch('Retime Both', [
      { type: 'setRetime', layer: V, mode: 'speed', speed: 150 },
      { type: 'timeReverseLayers', layers: [W] },
      { type: 'freezeFrame', layer: A, lastFrame: true },
    ]);
  },
  // @@family:groups
  'groups: effects — add with params, index, many layers, move, duplicate, copy, enable, rename, remove, refusals': async (h) => {
    const comp = 'comp_root';
    const mk = async (kind: 'solid' | 'shape' | 'text' | 'null', name: string): Promise<string> =>
      (await h.run({ type: 'createLayer', comp, kind, name, init: [] })).layer;
    const A = await mk('solid', 'A');
    const B = await mk('shape', 'B');
    const N = await mk('null', 'N');
    const { groups: [g1, g2] } = await h.run({ type: 'addEffect', layers: [A, B], effect: 'deep-glow', params: [
      { path: 'radius', value: scalar(40) },
      { path: 'tint', value: { kind: 'color', value: { r: 1, g: 0.5, b: 0.25, a: 1 } } },
      { path: 'glowOnly', value: { kind: 'bool', value: true } },
      { path: 'quality', value: { kind: 'choice', value: 'High (8 octaves)' } },
    ] });
    await h.run({ type: 'addEffect', layers: [A], effect: 'set-matte', index: 0, params: [
      { path: 'matteLayerId', value: { kind: 'layer', value: B } },
      { path: 'invert', value: { kind: 'bool', value: true } },
    ] });
    await h.run({ type: 'addEffect', layers: [A], effect: 'vegas', params: [] });
    await h.run({ type: 'addEffect', layers: [A], effect: 'write-on', index: 1, params: [] });
    await h.run({ type: 'addEffect', layers: [N], effect: 'drop-shadow', params: [] });
    // refusals
    await h.run({ type: 'addEffect', layers: [], effect: 'glow', params: [] }).catch(() => undefined);
    await h.run({ type: 'addEffect', layers: [A], effect: 'no-such-effect', params: [] }).catch(() => undefined);
    await h.run({ type: 'addEffect', layers: [A, 'ghost'], effect: 'glow', params: [] }).catch(() => undefined);
    await h.run({ type: 'addEffect', layers: [B, A], effect: 'glow', index: 3, params: [] }).catch(() => undefined);
    await h.run({ type: 'addEffect', layers: [A], effect: 'glow', params: [{ path: 'nope', value: scalar(1) }] }).catch(() => undefined);
    await h.run({ type: 'addEffect', layers: [A], effect: 'deep-glow', params: [{ path: 'quality', value: { kind: 'choice', value: 'Ultra' } }] }).catch(() => undefined);
    await h.run({ type: 'addEffect', layers: [A], effect: 'deep-glow', params: [{ path: 'glowOnly', value: scalar(1) }] }).catch(() => undefined);
    // move
    await h.run({ type: 'movePropertyGroup', group: { layer: A, path: g1! }, toIndex: 0 });
    await h.run({ type: 'movePropertyGroup', group: { layer: A, path: g1! }, toIndex: 3 });
    await h.run({ type: 'movePropertyGroup', group: { layer: A, path: g1! }, toIndex: 9 }).catch(() => undefined);
    await h.run({ type: 'movePropertyGroup', group: { layer: A, path: 'effects/ghost' }, toIndex: 0 }).catch(() => undefined);
    await h.run({ type: 'movePropertyGroup', group: { layer: 'ghost', path: g1! }, toIndex: 0 }).catch(() => undefined);
    await h.run({ type: 'movePropertyGroup', group: { layer: A, path: 'bogus/x/y' }, toIndex: 0 }).catch(() => undefined);
    // duplicate / copy
    const { groups: [dup] } = await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: A, path: g1! }] });
    await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: A, path: g1! }, { layer: B, path: g2! }] });
    await h.run({ type: 'duplicatePropertyGroups', groups: [] }).catch(() => undefined);
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: A, path: g1! }, { layer: A, path: dup! }], toLayers: [B, N] });
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: A, path: g1! }], toLayers: [] }).catch(() => undefined);
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: A, path: g1! }], toLayers: ['ghost'] }).catch(() => undefined);
    // enable / rename
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: A, path: g1! }, { layer: B, path: g2! }], enabled: false });
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: A, path: g1! }], enabled: true });
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: A, path: g1! }], enabled: true });
    await h.run({ type: 'setGroupEnabled', groups: [], enabled: true }).catch(() => undefined);
    await h.run({ type: 'renamePropertyGroup', group: { layer: A, path: g1! }, name: 'Bloom' });
    await h.run({ type: 'renamePropertyGroup', group: { layer: A, path: dup! }, name: 'Second Bloom' });
    await h.run({ type: 'renamePropertyGroup', group: { layer: A, path: dup! }, name: '   ' });
    await h.run({ type: 'invokeEffectAction', group: { layer: A, path: g1! }, action: 'reset' }).catch(() => undefined);
    await h.run({ type: 'invokeEffectAction', group: { layer: A, path: 'effects/ghost' }, action: 'reset' }).catch(() => undefined);
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    // remove
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: A, path: g1! }, { layer: B, path: g2! }] });
    await h.run({ type: 'removePropertyGroups', groups: [] }).catch(() => undefined);
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: A, path: g1! }] }).catch(() => undefined);
    await h.run({ type: 'undo' });
    await h.batch('Effect Batch', [
      { type: 'addEffect', layers: [N], effect: 'gaussian-blur', params: [] },
      { type: 'setGroupEnabled', groups: [{ layer: A, path: dup! }], enabled: false },
      { type: 'renamePropertyGroup', group: { layer: B, path: g2! }, name: 'B glow' },
    ]);
    await h.batch('Bad Effect Batch', [
      { type: 'addEffect', layers: [N], effect: 'gaussian-blur', params: [] },
      { type: 'removePropertyGroups', groups: [{ layer: N, path: 'effects/ghost' }] },
    ]).catch(() => undefined);
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
  },

  'groups: masks — add at index, modes, names, move, duplicate, copy, enable (mode none), rename, remove, animated shapes': async (h) => {
    const comp = 'comp_root';
    const { layer: A } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
    const { layer: B } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'B', init: [] });
    const square = { vertices: [0, 0, 100, 0, 100, 100, 0, 100], inTangents: [], outTangents: [], closed: true, featherPoints: [] };
    const curve = { vertices: [0, 0, 50, 80, 120, 10], inTangents: [0, 0, -10, 0, 0, 0], outTangents: [0, 0, 10, 0, 0, 0], closed: false, featherPoints: [] };
    const { groups: [m1] } = await h.run({ type: 'addMask', layer: A, path: square, mode: 'add', inverted: false });
    const { groups: [m2] } = await h.run({ type: 'addMask', layer: A, path: curve, mode: 'subtract', inverted: true, name: 'Cut' });
    const { groups: [m3] } = await h.run({ type: 'addMask', layer: A, path: square, mode: 'intersect', inverted: false, index: 0, name: '' });
    await h.run({ type: 'addMask', layer: B, path: square, mode: 'difference', inverted: false });
    await h.run({ type: 'addMask', layer: A, path: square, mode: 'add', inverted: false, index: 7 }).catch(() => undefined);
    await h.run({ type: 'addMask', layer: A, path: { ...square, inTangents: [1, 2] }, mode: 'add', inverted: false }).catch(() => undefined);
    await h.run({ type: 'addMask', layer: 'ghost', path: square, mode: 'add', inverted: false }).catch(() => undefined);
    await h.run({ type: 'movePropertyGroup', group: { layer: A, path: m1! }, toIndex: 2 });
    await h.run({ type: 'movePropertyGroup', group: { layer: A, path: m1! }, toIndex: 3 }).catch(() => undefined);
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: A, path: m2! }, { layer: A, path: m3! }], enabled: false });
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: A, path: m2! }], enabled: false });
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: A, path: m2! }], enabled: true });
    await h.run({ type: 'renamePropertyGroup', group: { layer: A, path: m1! }, name: 'Window' });
    await h.run({ type: 'renamePropertyGroup', group: { layer: A, path: m2! }, name: '' });
    await h.run({ type: 'renamePropertyGroup', group: { layer: A, path: 'masks/ghost' }, name: 'x' }).catch(() => undefined);
    const { groups: [d1] } = await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: A, path: m1! }] });
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: A, path: m1! }, { layer: A, path: m3! }], toLayers: [B] });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: A, path: d1! }, { layer: A, path: m3! }] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: B, path: 'masks/ghost' }] }).catch(() => undefined);
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
  },

  'groups: masks with keyframed shapes and tracks — duplicate, copy, move, remove carry them': async (h) => {
    const comp = 'comp_root';
    const { layer: A } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
    const { layer: B } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'B', init: [] });
    const square = { vertices: [0, 0, 100, 0, 100, 100, 0, 100], inTangents: [], outTangents: [], closed: true, featherPoints: [] };
    const { groups: [m1] } = await h.run({ type: 'addMask', layer: A, path: square, mode: 'add', inverted: false });
    const { groups: [m2] } = await h.run({ type: 'addMask', layer: A, path: square, mode: 'add', inverted: false });
    await h.run({ type: 'setAnimated', prop: { layer: A, path: `${m1}/path` }, animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: { layer: A, path: `${m1}/path` }, time: sec(1), value: { kind: 'path', value: { vertices: [0, 0, 200, 0, 200, 200, 0, 200], inTangents: [], outTangents: [], closed: true, featherPoints: [] } } });
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: A, path: `${m1}/feather` }, time: 0, value: scalar(0), spatialIn: [], spatialOut: [] },
      { prop: { layer: A, path: `${m1}/feather` }, time: sec(1), value: scalar(20), spatialIn: [], spatialOut: [] },
    ] });
    const { groups: [d] } = await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: A, path: m1! }] });
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: A, path: m1! }], toLayers: [B] });
    await h.run({ type: 'movePropertyGroup', group: { layer: A, path: m2! }, toIndex: 0 });
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: A, path: d! }], enabled: false });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: A, path: m1! }] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: A, path: m1! }, { layer: A, path: m2! }, { layer: A, path: d! }] });
    await h.run({ type: 'undo' });
  },

  'groups: text animators and selectors — every selector kind, indices, move, duplicate, enable, rename, remove, refusals': async (h) => {
    const comp = 'comp_root';
    const { layer: T } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
    const { layer: S } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'S', init: [] });
    const add = (parent: string, matchName: string, extra: { index?: number; name?: string; init?: Array<{ path: string; value: ReturnType<typeof scalar> }> } = {}) =>
      h.run({
        type: 'addPropertyGroup', layer: T, parent, matchName, init: extra.init ?? [],
        ...(extra.index !== undefined ? { index: extra.index } : {}),
        ...(extra.name !== undefined ? { name: extra.name } : {}),
      });
    const { groups: [a1] } = await add('text/animators', 'ADBE Text Animator');
    const { groups: [a2] } = await add('text/animators', 'ADBE Text Animator', { name: 'Second', init: [{ path: 'props/opacity', value: scalar(0) }] });
    const { groups: [a0] } = await add('text/animators', 'ADBE Text Animator', { index: 0, name: '' });
    await add('text/animators', 'ADBE Text Animator', { index: 9 }).catch(() => undefined);
    await h.run({ type: 'addPropertyGroup', layer: S, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] }).catch(() => undefined);
    const a2id = a2!.split('/')[2]!;
    const a1id = a1!.split('/')[2]!;
    const { groups: [sw] } = await add(`text/animators/${a2id}/selectors`, 'ADBE Text Wiggly Selector');
    const { groups: [se] } = await add(`text/animators/${a2id}/selectors`, 'ADBE Text Expressible Selector', { index: 0 });
    const { groups: [sr] } = await add(`text/animators/${a1id}/selectors`, 'ADBE Text Selector', { index: 1 });
    await add(`text/animators/${a2id}/selectors`, 'ADBE Text Selector', { index: 7 }).catch(() => undefined);
    await add('text/animators/ghost/selectors', 'ADBE Text Selector').catch(() => undefined);
    await add(`text/animators/${a2id}/selectors`, 'ADBE Text Bogus Selector').catch(() => undefined);
    await add('text', 'ADBE Text Animator').catch(() => undefined);
    await h.run({ type: 'addPropertyGroup', layer: 'ghost', parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] }).catch(() => undefined);
    // tracks under index-addressed animators move with their animator
    await h.run({ type: 'setAnimated', prop: { layer: T, path: `${a2}/props/opacity` }, animated: true, time: 0 }).catch(() => undefined);
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: T, path: `${a2}/props/scale` }, time: 0, value: scalar(50), spatialIn: [], spatialOut: [] },
      { prop: { layer: T, path: `${sw}/maxAmount` }, time: sec(1), value: scalar(40), spatialIn: [], spatialOut: [] },
    ] }).catch(() => undefined);
    await h.run({ type: 'movePropertyGroup', group: { layer: T, path: a2! }, toIndex: 0 });
    await h.run({ type: 'movePropertyGroup', group: { layer: T, path: sw! }, toIndex: 0 });
    await h.run({ type: 'movePropertyGroup', group: { layer: T, path: se! }, toIndex: 5 }).catch(() => undefined);
    await h.run({ type: 'movePropertyGroup', group: { layer: T, path: a0! }, toIndex: 3 }).catch(() => undefined);
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: T, path: a1! }, { layer: T, path: se! }], enabled: false });
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: T, path: a1! }], enabled: true });
    await h.run({ type: 'renamePropertyGroup', group: { layer: T, path: a1! }, name: 'First' });
    await h.run({ type: 'renamePropertyGroup', group: { layer: T, path: sr! }, name: 'Range 2' });
    await h.run({ type: 'renamePropertyGroup', group: { layer: T, path: sr! }, name: ' ' });
    await h.run({ type: 'renamePropertyGroup', group: { layer: T, path: `${a1}/selectors/ghost` }, name: 'x' }).catch(() => undefined);
    const { groups: [dupA] } = await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: T, path: a2! }] });
    await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: T, path: sw! }] }).catch(() => undefined);
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: T, path: a1! }], toLayers: [S] }).catch(() => undefined);
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: T, path: se! }, { layer: T, path: a0! }] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    const a0sel = (await h.query({ type: 'getPropertyTree', layer: T, path: a1!, depth: 0 }).catch(() => null));
    void a0sel;
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: T, path: `${a0}/selectors/x` }] }).catch(() => undefined);
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: T, path: dupA! }, { layer: T, path: a1! }] });
    await h.run({ type: 'undo' });
    await h.batch('Animator Batch', [
      { type: 'addPropertyGroup', layer: T, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] },
      { type: 'movePropertyGroup', group: { layer: T, path: a1! }, toIndex: 0 },
      { type: 'setGroupEnabled', groups: [{ layer: T, path: a2! }], enabled: false },
    ]);
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
  },

  'groups: text selectors — removing the last selector is refused; removing others re-keys': async (h) => {
    const comp = 'comp_root';
    const { layer: T } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
    const { groups: [a] } = await h.run({ type: 'addPropertyGroup', layer: T, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] });
    const tree = await h.query({ type: 'getPropertyTree', layer: T, path: '', depth: 0 });
    const sel0 = tree.nodes.map((n) => n.path).find((p) => p.startsWith(`${a}/selectors/`) && p.split('/').length === 5);
    if (sel0) await h.run({ type: 'removePropertyGroups', groups: [{ layer: T, path: sel0 }] }).catch(() => undefined);
    const { groups: [s1] } = await h.run({ type: 'addPropertyGroup', layer: T, parent: `${a}/selectors`, matchName: 'ADBE Text Wiggly Selector', init: [] });
    const { groups: [s2] } = await h.run({ type: 'addPropertyGroup', layer: T, parent: `${a}/selectors`, matchName: 'ADBE Text Expressible Selector', init: [] });
    if (sel0) await h.run({ type: 'removePropertyGroups', groups: [{ layer: T, path: sel0 }, { layer: T, path: s2! }] });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: T, path: s1! }] }).catch(() => undefined);
    await h.run({ type: 'undo' });
  },

  'groups: layer styles (all ten) and shape operators (every type) — add, init, enable, duplicate, copy, move, remove, refusals': async (h) => {
    const comp = 'comp_root';
    const { layer: A } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'A', init: [] });
    const { layer: B } = await h.run({ type: 'createLayer', comp, kind: 'rectangle', name: 'B', init: [] });
    const styles = ['glass', 'dropShadow', 'outerGlow', 'innerShadow', 'innerGlow', 'satin', 'bevel', 'colorOverlay', 'gradientOverlay', 'stroke'];
    for (const s of styles) await h.run({ type: 'addPropertyGroup', layer: A, parent: 'styles', matchName: `style:${s}`, init: [] });
    await h.run({ type: 'addPropertyGroup', layer: B, parent: 'styles', matchName: 'style:dropShadow', init: [{ path: 'distance', value: scalar(25) }] }).catch(() => undefined);
    await h.run({ type: 'addPropertyGroup', layer: B, parent: 'styles', matchName: 'style:stroke', init: [] });
    await h.run({ type: 'addPropertyGroup', layer: A, parent: 'styles', matchName: 'style:dropShadow', init: [] }).catch(() => undefined);
    await h.run({ type: 'addPropertyGroup', layer: A, parent: 'styles', matchName: 'style:sparkle', init: [] }).catch(() => undefined);
    await h.run({ type: 'addPropertyGroup', layer: A, parent: 'styles', matchName: 'dropShadow', init: [] }).catch(() => undefined);
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: A, path: 'styles/bevel' }, { layer: A, path: 'styles/glass' }], enabled: false });
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: A, path: 'styles/bevel' }], enabled: true });
    await h.run({ type: 'movePropertyGroup', group: { layer: A, path: 'styles/bevel' }, toIndex: 0 }).catch(() => undefined);
    await h.run({ type: 'renamePropertyGroup', group: { layer: A, path: 'styles/bevel' }, name: 'x' }).catch(() => undefined);
    await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: A, path: 'styles/satin' }] }).catch(() => undefined);
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: A, path: 'styles/satin' }, { layer: A, path: 'styles/innerGlow' }], toLayers: [B] });
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: A, path: 'styles/stroke' }], toLayers: [B] }).catch(() => undefined);
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: A, path: 'styles/glass' }, { layer: A, path: 'styles/gradientOverlay' }] });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: A, path: 'styles/glass' }] }).catch(() => undefined);
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    // shape operators
    const ops = ['zigzag', 'roundCorners', 'pucker', 'twist', 'offset', 'roughen', 'trim', 'repeater', 'wiggleTransform'];
    const paths: string[] = [];
    for (const t of ops) paths.push((await h.run({ type: 'addPropertyGroup', layer: B, parent: 'contents', matchName: `pathop:${t}`, init: [] })).groups[0]!);
    await h.run({ type: 'addPropertyGroup', layer: B, parent: 'contents', matchName: 'pathop:trim', index: 0, init: [{ path: 'end', value: scalar(50) }] });
    await h.run({ type: 'addPropertyGroup', layer: B, parent: 'contents', matchName: 'pathop:none', index: 2, init: [] });
    await h.run({ type: 'addPropertyGroup', layer: B, parent: 'contents', matchName: 'pathop:mystery', init: [] });
    await h.run({ type: 'addPropertyGroup', layer: B, parent: 'contents', matchName: 'pathop:trim', index: 99, init: [] }).catch(() => undefined);
    await h.run({ type: 'addPropertyGroup', layer: B, parent: 'contents', matchName: 'repeater', init: [] }).catch(() => undefined);
    await h.run({ type: 'addPropertyGroup', layer: B, parent: 'bogus', matchName: 'pathop:trim', init: [] }).catch(() => undefined);
    await h.run({ type: 'movePropertyGroup', group: { layer: B, path: paths[0]! }, toIndex: 5 });
    await h.run({ type: 'movePropertyGroup', group: { layer: B, path: paths[0]! }, toIndex: 50 }).catch(() => undefined);
    await h.run({ type: 'setGroupEnabled', groups: [{ layer: B, path: paths[6]! }], enabled: false });
    await h.run({ type: 'renamePropertyGroup', group: { layer: B, path: paths[6]! }, name: 'x' }).catch(() => undefined);
    const { groups: [dupOp] } = await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: B, path: paths[6]! }, { layer: B, path: paths[7]! }] });
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: B, path: paths[6]! }, { layer: B, path: dupOp! }], toLayers: [A] });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: B, path: paths[1]! }, { layer: B, path: paths[2]! }] });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: B, path: 'contents/ghost' }] }).catch(() => undefined);
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
  },

  'groups: presets — keyframed, relative units, 3D, text rigs, effects, behaviours, camera and dolly zoom, refusals': async (h) => {
    const comp = 'comp_root';
    const mk = async (kind: 'solid' | 'shape' | 'text' | 'camera' | 'light' | 'null', name: string): Promise<string> =>
      (await h.run({ type: 'createLayer', comp, kind, name, init: [] })).layer;
    const A = await mk('solid', 'A');
    const B = await mk('shape', 'B');
    const T = await mk('text', 'T');
    const T2 = await mk('text', 'T2');
    const C = await mk('camera', 'Cam');
    const L = await mk('light', 'Light');
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: B, path: 'transform/position' }, time: 0, value: v2(100, 100), spatialIn: [], spatialOut: [] },
      { prop: { layer: B, path: 'transform/position' }, time: sec(2), value: v2(300, 200), spatialIn: [], spatialOut: [] },
    ] });
    await h.run({ type: 'applyPreset', layers: [A, B], preset: 'Fade In', time: sec(1) });
    await h.run({ type: 'applyPreset', layers: [B], preset: 'Slide In', time: sec(0.5) });
    await h.run({ type: 'applyPreset', layers: [A], preset: 'Rise Up', time: 0 });
    await h.run({ type: 'applyPreset', layers: [A], preset: 'Pop In', time: sec(2) });
    await h.run({ type: 'applyPreset', layers: [B], preset: 'Shake', time: sec(1) });
    await h.run({ type: 'applyPreset', layers: [A], preset: 'Depth Push In', time: sec(3) });
    await h.run({ type: 'applyPreset', layers: [L], preset: 'Cinematic Pan 3D', time: 0 });
    await h.run({ type: 'applyPreset', layers: [B], preset: '3D Twirl In', time: sec(0.25) });
    await h.run({ type: 'applyPreset', layers: [T], preset: 'Typewriter', time: sec(1) });
    await h.run({ type: 'applyPreset', layers: [T], preset: 'Cascade', time: 0 });
    await h.run({ type: 'applyPreset', layers: [T], preset: 'Word Rise', time: sec(2) });
    await h.run({ type: 'applyPreset', layers: [T2], preset: 'Spotlight', time: 0 });
    await h.run({ type: 'applyPreset', layers: [T2], preset: 'Jitter', time: 0 });
    await h.run({ type: 'applyPreset', layers: [T2], preset: 'Inch Worm', time: sec(1) });
    await h.run({ type: 'applyPreset', layers: [A], preset: 'Wipe In', time: sec(1) });
    await h.run({ type: 'applyPreset', layers: [A], preset: 'Broadcast Interference', time: 0 });
    await h.run({ type: 'applyPreset', layers: [B], preset: 'Teal & Orange', time: 0 });
    await h.run({ type: 'applyPreset', layers: [B], preset: 'Drift', time: 0 });
    await h.run({ type: 'applyPreset', layers: [B], preset: 'Fade In+Out', time: 0 });
    await h.run({ type: 'applyPreset', layers: [C], preset: 'Push In', time: sec(1) });
    await h.run({ type: 'applyPreset', layers: [C], preset: 'Orbit Sweep', time: 0 });
    await h.run({ type: 'applyPreset', layers: [C], preset: 'Dolly Zoom (Vertigo)', time: sec(2) });
    await h.run({ type: 'applyPreset', layers: [C], preset: 'Handheld', time: 0 });
    // refusals
    await h.run({ type: 'applyPreset', layers: [], preset: 'Fade In', time: 0 }).catch(() => undefined);
    await h.run({ type: 'applyPreset', layers: [A], preset: 'No Such Preset', time: 0 }).catch(() => undefined);
    await h.run({ type: 'applyPreset', layers: [A, 'ghost'], preset: 'Fade In', time: 0 }).catch(() => undefined);
    await h.run({ type: 'applyPreset', layers: [A], preset: 'Typewriter', time: 0 }).catch(() => undefined);
    await h.run({ type: 'applyPreset', layers: [T, A], preset: 'Push In', time: 0 }).catch(() => undefined);
    await h.run({ type: 'applyPreset', layers: [A], preset: 'Dolly Zoom (Vertigo)', time: 0 }).catch(() => undefined);
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.batch('Preset Batch', [
      { type: 'applyPreset', layers: [A], preset: 'Spin', time: 0 },
      { type: 'applyPreset', layers: [T], preset: 'Wave', time: 0 },
      { type: 'applyPreset', layers: [A], preset: 'Iris In', time: sec(1) },
    ]);
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
  },

  // G2 #6: `time` is composition time; the keys land on each layer's own axis.
  'G2: presets on offset, stretched and trimmed layers land at the composition time': async (h) => {
    const comp = 'comp_root';
    const mk = async (kind: 'solid' | 'shape' | 'text', name: string): Promise<string> =>
      (await h.run({ type: 'createLayer', comp, kind, name, init: [] })).layer;
    const A = await mk('solid', 'Offset');
    const B = await mk('shape', 'Stretched');
    const C = await mk('solid', 'Offset + stretched');
    const T = await mk('text', 'Text offset');
    await h.run({ type: 'moveLayersInTime', layers: [A, C, T], delta: sec(1), ripple: false });
    await h.run({ type: 'setLayerTiming', items: [{ layer: B, stretch: 2 }, { layer: C, stretch: 0.5 }] });
    await h.run({ type: 'applyPreset', layers: [A], preset: 'Fade In', time: sec(2) });
    await h.run({ type: 'applyPreset', layers: [B], preset: 'Pop In', time: sec(1) });
    await h.run({ type: 'applyPreset', layers: [C], preset: 'Fade In', time: sec(1.5) });
    await h.run({ type: 'applyPreset', layers: [T], preset: 'Typewriter', time: sec(1.5) });
    await h.run({ type: 'applyPreset', layers: [A, B], preset: 'Slide In', time: sec(0.5) });
    for (const layer of [A, B, C, T]) await h.query({ type: 'getKeyframes', props: [{ layer, path: 'transform/opacity' }, { layer, path: 'transform/scale' }] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
  },

  // G2 #9: layer spaces of 3D layers, 3D parent chains (incl. a 2D parent),
  // cameras (one- and two-node) and lights in expressions (AE semantics:
  // toComp projects through the active camera; fromComp hits the layer plane).
  'G2: 3D layer spaces in expressions — toComp/fromComp/toWorld/fromWorld on 3D layers, parents, cameras, lights': async (h) => {
    const comp = 'comp_root';
    const mk = async (kind: 'solid' | 'shape' | 'null' | 'camera' | 'light', name: string): Promise<string> =>
      (await h.run({ type: 'createLayer', comp, kind, name, init: [] })).layer;
    const P = (layer: string, path: string) => ({ layer, path });
    const flatParent = await mk('null', 'FlatParent');
    const flat = await mk('shape', 'Flat');
    const rig2d = await mk('null', 'Rig2D');
    const rig = await mk('null', 'Rig');
    const box = await mk('solid', 'Box');
    const light = await mk('light', 'Light');
    const cam = await mk('camera', 'Cam');
    const r1 = await mk('shape', 'R1');
    const r2 = await mk('shape', 'R2');
    const r3 = await mk('shape', 'R3');
    await h.run({ type: 'setLayerSwitches', layers: [rig, box], patch: { threeD: true } });
    await h.run({ type: 'setParent', layers: [rig], parent: rig2d, keepWorldTransform: false });
    await h.run({ type: 'setParent', layers: [box], parent: rig, keepWorldTransform: false });
    await h.run({ type: 'setParent', layers: [flat], parent: flatParent, keepWorldTransform: false });
    await h.run({ type: 'setProperty', prop: P(rig2d, 'transform/position'), value: v2(40, -30) });
    await h.run({ type: 'setProperty', prop: P(rig2d, 'transform/rotation'), value: scalar(15) });
    await h.run({ type: 'setProperty', prop: P(rig, 'transform/position'), value: v3(960, 540, 200) });
    // Whatever 3D rotation / orientation rows the catalog has for a 3D layer.
    const rigTree = await h.query({ type: 'getPropertyTree', layer: rig, path: '', depth: 0 });
    for (const n of rigTree.nodes) {
      if (n.kind !== 'property') continue;
      if (/rotation(X|Y)$|xRotation$|yRotation$/i.test(n.path)) await h.run({ type: 'setProperty', prop: P(rig, n.path), value: scalar(25) });
      if (/orientation$/i.test(n.path) && n.value?.kind === 'vec3') await h.run({ type: 'setProperty', prop: P(rig, n.path), value: v3(10, 0, 5) });
    }
    await h.run({ type: 'addKeyframes', keys: [
      { prop: P(box, 'transform/position'), time: 0, value: v3(-100, 50, 0), spatialIn: [], spatialOut: [] },
      { prop: P(box, 'transform/position'), time: sec(2), value: v3(150, -80, -400), spatialIn: [], spatialOut: [] },
      { prop: P(box, 'transform/scale'), time: 0, value: v3(100, 100, 100), spatialIn: [], spatialOut: [] },
      { prop: P(box, 'transform/scale'), time: sec(2), value: v3(150, 80, 100), spatialIn: [], spatialOut: [] },
      { prop: P(flatParent, 'transform/rotation'), time: 0, value: scalar(0), spatialIn: [], spatialOut: [] },
      { prop: P(flatParent, 'transform/rotation'), time: sec(2), value: scalar(90), spatialIn: [], spatialOut: [] },
      { prop: P(cam, 'transform/position'), time: 0, value: v3(960, 540, -1500), spatialIn: [], spatialOut: [] },
      { prop: P(cam, 'transform/position'), time: sec(2), value: v3(700, 400, -1100), spatialIn: [], spatialOut: [] },
    ] });
    await h.run({ type: 'setProperty', prop: P(light, 'transform/position'), value: v3(100, 200, -300) });
    await h.run({ type: 'setProperty', prop: P(flatParent, 'transform/position'), value: v2(300, 200) });
    await h.run({ type: 'moveLayersInTime', layers: [flat], delta: sec(0.5), ripple: false });
    const ex = (layer: string, path: string, source: string) => h.run({ type: 'setExpression', prop: P(layer, path), source, enabled: true });
    // An expression-driven transform on a 2D layer another layer's space reads.
    await ex(flat, 'transform/rotation', 'time * 45');
    await ex(r1, 'transform/position', 'thisComp.layer("Box").toComp([50, 25])');
    await ex(r1, 'transform/rotation', 'thisComp.layer("Box").toWorld([10, 0])[2]');
    await ex(r1, 'transform/scale', 'thisComp.layer("Box").fromComp([960, 540])');
    await ex(r1, 'transform/anchorPoint', 'var w = thisComp.layer("Cam").toWorld([0, 0]); [w[0], w[2]]');
    await ex(r1, 'transform/opacity', 'thisComp.layer("Light").toWorld([0, 0])[2] / 10 + 50');
    await ex(r2, 'transform/position', 'thisComp.layer("Box").fromWorld(thisComp.layer("Rig").toWorld([0, 0]))');
    await ex(r2, 'transform/rotation', 'thisComp.layer("Flat").toComp([5, 5])[1]');
    await ex(r2, 'transform/scale', 'thisComp.layer("Flat").fromComp([400, 300])');
    await ex(r2, 'transform/anchorPoint', 'thisComp.layer("Rig").fromComp(thisComp.layer("Box").toComp([0, 0]))');
    await ex(r2, 'transform/opacity', 'thisComp.layer("Cam").fromWorld([960, 540, 0])[0] / 10');
    await ex(r3, 'transform/position', 'thisComp.layer("Light").toComp([0, 0])');
    await ex(r3, 'transform/rotation', 'thisComp.layer("Flat").toWorld([1, 1])[0] / 10');
    await ex(r3, 'transform/scale', 'thisComp.layer("Rig").toComp([0, 0])');
    const readers = [r1, r2, r3].flatMap((layer) => ['transform/position', 'transform/rotation', 'transform/scale', 'transform/opacity', 'transform/anchorPoint'].map((path) => P(layer, path)));
    const read = async (): Promise<void> => {
      for (const time of [0, sec(0.5), sec(1), sec(1.7)]) await h.query({ type: 'getPropertyValues', props: readers, time, evaluated: true });
    };
    await read();
    // Two-node camera: a point of interest (whatever the catalog calls it).
    const camTree = await h.query({ type: 'getPropertyTree', layer: cam, path: '', depth: 0 });
    const poi = camTree.nodes.find((n) => n.kind === 'property' && /interest|poi/i.test(n.path));
    if (poi?.value?.kind === 'vec3') await h.run({ type: 'setProperty', prop: P(cam, poi.path), value: v3(1000, 500, 100) });
    else if (poi?.value?.kind === 'vec2') await h.run({ type: 'setProperty', prop: P(cam, poi.path), value: v2(1000, 500) });
    await read();
    // A second camera above the first takes over; hiding it hands the shot back.
    const cam2 = await mk('camera', 'Cam2');
    await h.run({ type: 'setProperty', prop: P(cam2, 'transform/position'), value: v3(1200, 300, -900) });
    await read();
    await h.run({ type: 'setLayerSwitches', layers: [cam2], patch: { visible: false } });
    await read();
    // No camera at all: the default camera.
    await h.run({ type: 'deleteLayers', layers: [cam, cam2] });
    await read();
    await h.run({ type: 'undo' });
    await read();
  },

  // G2 #10: gradient geometry rows (text layers) — tree, static read/write
  // into the paint (fill stack included), keys; and paint strokes renormalised.
  'G2: gradient geometry rows and paint stroke normalisation': async (h) => {
    for (const [path, make] of Object.entries(CORPUS_FIXTURES)) if (!h.files.has(path)) h.files.set(path, make());
    await h.run({ type: 'openProject', path: FIXTURE_GRADIENTS });
    const doc = await h.query({ type: 'getDocument', includeProperties: true, includeKeyframes: true });
    const grad = doc.propertyTrees.flatMap((t) => t.nodes.filter((n) => n.kind === 'property' && /(fill|stroke)(Angle|Center[XY]|Radius)$/.test(n.path)).map((n) => ({ layer: t.layer, path: n.path })));
    // Every numeric paint-stroke row: a write renormalises the whole stroke.
    const paint = doc.propertyTrees.flatMap((t) => t.nodes.filter((n) => n.kind === 'property' && n.path.startsWith('paint/') && n.value?.kind === 'scalar').map((n) => ({ layer: t.layer, path: n.path, v: n.value! })));
    for (const p of paint) await h.run({ type: 'setProperty', prop: { layer: p.layer, path: p.path }, value: p.v }).catch(() => undefined);
    for (const p of grad) {
      await h.run({ type: 'setProperty', prop: p, value: scalar(p.path.endsWith('Radius') ? -3 : 0.4) }).catch(() => undefined);
    }
    if (grad[0]) {
      await h.run({ type: 'addKeyframes', keys: [0, sec(1)].map((time, i) => ({ prop: grad[0]!, time, value: scalar(10 + i * 50), spatialIn: [], spatialOut: [] })) });
      await h.query({ type: 'getPropertyValues', props: grad, time: sec(0.5), evaluated: true });
    }
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'saveProject', path: 'C:/p/gradients-out.motion', copy: true });
  },

  // G2 #12: precompose (leave attributes) re-scopes an SVG layer's sanitised markup to the content's id.
  'G2: precompose leave-attributes re-scopes SVG markup': async (h) => {
    for (const [path, make] of Object.entries(CORPUS_FIXTURES)) if (!h.files.has(path)) h.files.set(path, make());
    await h.run({ type: 'openProject', path: FIXTURE_SVG });
    await h.run({ type: 'precompose', comp: 'comp_root', layers: ['layer_1'], name: 'Logo comp', mode: 'leaveAttributes', adjustDuration: false });
    await h.run({ type: 'saveProject', path: 'C:/p/svg-a.motion', copy: true });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'saveProject', path: 'C:/p/svg-b.motion', copy: true });
  },

  // G2 #7: swatches, materials, guides, transitions and plugin storage ride
  // through open → save → New Project → open → save in both engines
  // (crossEngine.test.ts compares what each engine SAVED).
  'G2: document extras survive save → New Project → open': async (h) => {
    for (const [path, make] of Object.entries(CORPUS_FIXTURES)) if (!h.files.has(path)) h.files.set(path, make());
    await h.run({ type: 'openProject', path: FIXTURE_EXTRAS });
    await h.run({ type: 'saveProject', path: 'C:/p/extras-a.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'saveProject', path: 'C:/p/extras-new.motion', copy: true });
    await h.run({ type: 'openProject', path: 'C:/p/extras-a.motion' });
    await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'After open', init: [] });
    await h.run({ type: 'saveProject', path: 'C:/p/extras-b.motion', copy: true });
    // A document without the keys keeps the session's (absent = keep); plugin storage is assigned whole.
    await h.run({ type: 'openProject', path: FIXTURE_BARE });
    await h.run({ type: 'saveProject', path: 'C:/p/extras-c.motion', copy: true });
  },

  // G2 #1–#3: batches that create or remove across compositions; multi-entry jumps.
  'G2: batched comp creation and cross-comp editWorkArea undo exactly; jumps report every key list': async (h) => {
    const s = await buildScene(h);
    await h.batch('Two comps', [
      { type: 'createComposition', settings: { name: 'One' }, fromItems: [] },
      { type: 'createComposition', settings: { name: 'Two', width: 640, height: 360 }, fromItems: [s.footage] },
      { type: 'duplicateComposition', comp: s.comp2, deep: false },
    ]);
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'setWorkArea', comp: s.comp2, range: { start: 0, duration: sec(10) } });
    await h.batch('Lift both', [
      { type: 'editWorkArea', comp: s.comp, edit: 'lift', layers: [] },
      { type: 'editWorkArea', comp: s.comp2, edit: 'lift', layers: [] },
    ]);
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'undo' });
    const { position } = await h.query({ type: 'getHistory' });
    await h.run({ type: 'addKeyframes', keys: [{ prop: { layer: s.A, path: 'transform/opacity' }, time: sec(1), value: scalar(40), spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'moveLayersInTime', layers: [s.A], delta: sec(0.5), ripple: false });
    await h.run({ type: 'addKeyframes', keys: [{ prop: { layer: s.T, path: 'transform/rotation' }, time: sec(1), value: scalar(40), spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'deleteLayers', layers: [s.T] });
    await h.run({ type: 'jumpToHistory', position });
    await h.run({ type: 'jumpToHistory', position: position + 4 });
    await h.run({ type: 'jumpToHistory', position });
  },

  'groups: property writes and keys on created groups (effects, styles, operators, animators, selectors)': async (h) => {
    const comp = 'comp_root';
    const { layer: A } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'A', init: [] });
    const { layer: B } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'B', init: [] });
    const { layer: T } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
    const { groups: [fx] } = await h.run({ type: 'addEffect', layers: [A], effect: 'deep-glow', params: [] });
    await h.run({ type: 'addPropertyGroup', layer: A, parent: 'styles', matchName: 'style:dropShadow', init: [] });
    const { groups: [op] } = await h.run({ type: 'addPropertyGroup', layer: A, parent: 'contents', matchName: 'pathop:trim', init: [] });
    const { groups: [an] } = await h.run({ type: 'addPropertyGroup', layer: T, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] });
    const { groups: [sw] } = await h.run({ type: 'addPropertyGroup', layer: T, parent: `${an}/selectors`, matchName: 'ADBE Text Wiggly Selector', init: [] });
    await h.run({ type: 'setProperty', prop: { layer: A, path: `${fx}/radius` }, value: scalar(33) });
    await h.run({ type: 'setProperty', prop: { layer: A, path: `${fx}/quality` }, value: { kind: 'choice', value: 'Low (4 octaves)' } });
    await h.run({ type: 'setProperty', prop: { layer: A, path: 'styles/dropShadow/distance' }, value: scalar(12) });
    await h.run({ type: 'setProperty', prop: { layer: A, path: `${op}/end` }, value: scalar(70) });
    await h.run({ type: 'addKeyframes', keys: [
      { prop: { layer: A, path: `${fx}/radius` }, time: 0, value: scalar(10), spatialIn: [], spatialOut: [] },
      { prop: { layer: A, path: `${fx}/radius` }, time: sec(1), value: scalar(80), spatialIn: [], spatialOut: [] },
      { prop: { layer: A, path: 'styles/dropShadow/distance' }, time: 0, value: scalar(4), spatialIn: [], spatialOut: [] },
      { prop: { layer: A, path: `${op}/end` }, time: sec(1), value: scalar(20), spatialIn: [], spatialOut: [] },
      { prop: { layer: T, path: `${an}/props/opacity` }, time: 0, value: scalar(0), spatialIn: [], spatialOut: [] },
      { prop: { layer: T, path: `${sw}/maxAmount` }, time: sec(1), value: scalar(60), spatialIn: [], spatialOut: [] },
    ] });
    await h.run({ type: 'setExpression', prop: { layer: A, path: `${fx}/exposure` }, source: 'time * 2', enabled: true }).catch(() => undefined);
    const { groups: [fx2] } = await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: A, path: fx! }] });
    await h.run({ type: 'copyPropertyGroups', groups: [{ layer: A, path: fx! }, { layer: A, path: 'styles/dropShadow' }, { layer: A, path: op! }], toLayers: [B] });
    const { groups: [an2] } = await h.run({ type: 'duplicatePropertyGroups', groups: [{ layer: T, path: an! }] });
    await h.run({ type: 'movePropertyGroup', group: { layer: T, path: an2! }, toIndex: 0 });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: A, path: fx2! }, { layer: A, path: op! }, { layer: A, path: 'styles/dropShadow' }] });
    await h.run({ type: 'removePropertyGroups', groups: [{ layer: T, path: an! }] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
  },
  // @@family:g1-fields
  // G1: static fields (text / animator / selector), optional animator
  // properties, Path Options ▸ Path, the unified wght/wdth/slnt axes, Blur Y,
  // the layer fill colour, style runs, the comp motion-blur switch — every
  // write, refusal, undo, and a save → open round trip in each engine.
  'G1: text fields, animator and selector fields, optional properties, path, axes, fill, runs — save → open': async (h) => {
    const comp = 'comp_root';
    const ignore = (): undefined => undefined;
    const P = (layer: string, path: string) => ({ layer, path });
    const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
    const { layer: t3 } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T3', init: [] });
    const { layer: s } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'S', init: [] });
    const { layer: sh } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'Sh', init: [] });
    await h.run({ type: 'setLayerSwitches', layers: [t3], patch: { threeD: true } });
    const str = (value: string) => ({ kind: 'string' as const, value });
    const choice = (value: string) => ({ kind: 'choice' as const, value });
    const bool = (value: boolean) => ({ kind: 'bool' as const, value });
    const color = (r: number, g: number, b: number, a = 1) => ({ kind: 'color' as const, value: { r, g, b, a } });
    const box = (n: number) => ({ vertices: [0, 0, n, 0, n, n, 0, n], inTangents: [], outTangents: [], closed: true, featherPoints: [] });
    // Text component fields: every value type, clear-at-default, the strokeOrder mirror, refusals.
    await h.run({ type: 'setProperty', prop: P(t, 'text/fontFamily'), value: str('Roboto Mono') });
    await h.run({ type: 'setProperty', prop: P(t, 'text/align'), value: choice('center') });
    await h.run({ type: 'setProperty', prop: P(t, 'text/strokeOrder'), value: choice('all-strokes-over-all-fills') });
    await h.run({ type: 'setProperty', prop: P(t, 'text/fauxBold'), value: bool(true) });
    await h.run({ type: 'setProperty', prop: P(t, 'text/ligatures'), value: bool(false) });
    await h.run({ type: 'setProperty', prop: P(t, 'text/ligatures'), value: bool(true) });
    await h.run({ type: 'setProperty', prop: P(t, 'text/stylisticSets'), value: { kind: 'scalars', value: { values: [1, 4] } } });
    await h.run({ type: 'setProperty', prop: P(t, 'text/stroke'), value: color(1, 0.5, 0) });
    await h.run({ type: 'setProperty', prop: P(t, 'text/boxWidth'), value: scalar(420) });
    await h.run({ type: 'setProperty', prop: P(t, 'text/tateChuYokoDigits'), value: scalar(3) });
    await h.run({ type: 'setProperty', prop: P(t, 'text/tateChuYokoDigits'), value: scalar(9) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(t, 'text/align'), value: choice('middle') }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(t, 'text/align'), value: str('center') }).catch(ignore);
    await h.run({ type: 'setAnimated', prop: P(t, 'text/align'), animated: true, time: 0 }).catch(ignore);
    await h.run({ type: 'setExpression', prop: P(t, 'text/fontFamily'), source: 'value', enabled: true }).catch(ignore);
    await h.run({ type: 'resetProperty', prop: P(t, 'text/fauxBold') });
    await h.batch('Paragraph', [
      { type: 'setProperty', prop: P(t, 'text/direction'), value: choice('rtl') },
      { type: 'setProperty', prop: P(t, 'text/leftIndent'), value: scalar(12) },
      { type: 'setProperty', prop: P(t, 'text/anchorGrouping'), value: choice('word') },
    ]);
    // Grouping Alignment's first static write lands on the Text component (gap 1).
    const { groups: [a1] } = await h.run({ type: 'addPropertyGroup', layer: t, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] });
    await h.run({ type: 'setProperty', prop: P(t, 'text/groupingAlignX'), value: scalar(-40) });
    await h.run({ type: 'setAnimated', prop: P(t, 'text/groupingAlignY'), animated: true, time: sec(1) });
    // Animator fields and optional properties.
    await h.run({ type: 'setProperty', prop: P(t, `${a1}/props/trackingType`), value: choice('beforeAfter') });
    await h.run({ type: 'setProperty', prop: P(t, `${a1}/props/characterRange`), value: choice('full') });
    await h.run({ type: 'setProperty', prop: P(t, `${a1}/props/characterRange`), value: choice('preserve') });
    await h.run({ type: 'setProperty', prop: P(t, `${a1}/props/color`), value: color(1, 0, 0) }).catch(ignore);
    const { paths } = await h.run({ type: 'addProperties', parent: P(t, `${a1}/props`), names: ['anchorX', 'color', 'axisGRAD', 'fillHue', 'anchorX'] });
    await h.run({ type: 'setProperty', prop: P(t, `${a1}/props/color`), value: color(0, 1, 0.25) });
    await h.run({ type: 'addKeyframes', keys: [0, 1].map((i) => ({ prop: P(t, paths[0]!), time: sec(i), value: scalar(10 * i), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'setAnimated', prop: P(t, paths[2]!), animated: true, time: 0 });
    await h.run({ type: 'addProperties', parent: P(t, `${a1}/props`), names: ['anchorZ'] }).catch(ignore);
    await h.run({ type: 'addProperties', parent: P(t, `${a1}/props`), names: ['bogus'] }).catch(ignore);
    await h.run({ type: 'addProperties', parent: P(t, `${a1}/props`), names: [] }).catch(ignore);
    await h.run({ type: 'addProperties', parent: P(t, `${a1}/selectors`), names: ['anchorX'] }).catch(ignore);
    await h.run({ type: 'addProperties', parent: P(s, 'text/animators/ghost/props'), names: ['anchorX'] }).catch(ignore);
    await h.run({ type: 'addProperties', parent: P(t, `${a1}/props`), names: ['axisAAAA', 'axisBBBB', 'axisCCCC', 'axisDDDD', 'axisEEEE', 'axisFFFF', 'axisGGGG', 'axisHHHH'] }).catch(ignore);
    await h.run({ type: 'removeProperties', props: [P(t, paths[0]!), P(t, paths[2]!), P(t, paths[0]!)] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'removeProperties', props: [P(t, `${a1}/props/opacity`)] }).catch(ignore);
    await h.run({ type: 'removeProperties', props: [P(t, `${a1}/props/skewAxis`)] }).catch(ignore);
    await h.run({ type: 'removeProperties', props: [] }).catch(ignore);
    // Blur Y: addressable before it is written (reads as Blur X), then unlinked and keyed.
    await h.run({ type: 'setProperty', prop: P(t, `${a1}/props/blur`), value: scalar(6) });
    await h.query({ type: 'getPropertyValues', props: [P(t, `${a1}/props/blurY`)], time: 0, evaluated: false });
    await h.run({ type: 'setAnimated', prop: P(t, `${a1}/props/blurY`), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(t, `${a1}/props/blurY`), value: scalar(20), time: sec(1) });
    // Selector fields: every kind, the kind switched in place (id kept, stale keys dropped).
    const sel = (await h.query({ type: 'getPropertyTree', layer: t, path: `${a1}/selectors`, depth: 0 })).nodes.find((n) => n.path.split('/').length === 5)!.path;
    await h.run({ type: 'addKeyframes', keys: [0, 2].map((i) => ({ prop: P(t, `${sel}/offset`), time: sec(i), value: scalar(50 * i), spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'setExpression', prop: P(t, `${sel}/amount`), source: 'value * 0.5', enabled: true });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/basedOn`), value: choice('words') });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/shape`), value: choice('rampUp') });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/randomizeOrder`), value: bool(true) });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/randomSeed`), value: scalar(7) });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/kind`), value: choice('wiggly') });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/lockDimensions`), value: bool(true) });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/units`), value: choice('index') }).catch(ignore);
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/kind`), value: choice('expression') });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/expression`), value: str('textIndex * 10') });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/kind`), value: choice('range') });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/kind`), value: choice('range') });
    await h.run({ type: 'setProperty', prop: P(t, `${sel}/mode`), value: choice('subtract') });
    // 3D layer: anchorZ is optional there.
    const { groups: [a3] } = await h.run({ type: 'addPropertyGroup', layer: t3, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] });
    await h.run({ type: 'addProperties', parent: P(t3, `${a3}/props`), names: ['anchorZ', 'strokeColor', 'axisopsz'] });
    // Path Options ▸ Path: attach to a mask, move the margin, detach, refusals.
    await h.run({ type: 'addMask', layer: t, mode: 'add', inverted: false, path: box(200) });
    const { groups: [mk] } = await h.run({ type: 'addMask', layer: t, mode: 'none', inverted: false, path: box(90) });
    const maskId = mk!.split('/')[1]!;
    await h.run({ type: 'setProperty', prop: P(t, 'text/pathOptions/path'), value: str(maskId) });
    await h.run({ type: 'setProperty', prop: P(t, 'text/pathOptions/firstMargin'), value: scalar(30) });
    await h.run({ type: 'setAnimated', prop: P(t, 'text/pathOptions/firstMargin'), animated: true, time: sec(0.5) });
    await h.run({ type: 'setProperty', prop: P(t, 'text/pathOptions/path'), value: str('mask_nope') }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(t, 'text/pathOptions/path'), value: str('') });
    await h.run({ type: 'undo' });
    // wght / wdth / slnt: one path each; a string weight reads as its number, a write stores a number.
    await h.run({ type: 'setProperty', prop: P(t, 'text/axes/wght'), value: scalar(650) });
    await h.run({ type: 'setAnimated', prop: P(t, 'text/axes/wdth'), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(t, 'text/axes/wdth'), value: scalar(120), time: sec(1) });
    await h.run({ type: 'setProperty', prop: P(t, 'text/axes/slnt'), value: scalar(-8) });
    // Style runs (a json value) and Source Text dropping them when the text changes.
    await h.run({ type: 'setProperty', prop: P(t, 'text/styleRuns'), value: { kind: 'json', value: JSON.stringify([{ start: 0, end: 1, style: { fontSize: 40, fill: '#ff0000' } }]) } });
    await h.run({ type: 'setProperty', prop: P(t, 'text/styleRuns'), value: { kind: 'json', value: '{"no": 1}' } }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(t, 'text/styleRuns'), value: { kind: 'json', value: 'nope' } }).catch(ignore);
    await h.batch('Retype', [
      { type: 'setProperty', prop: P(t, 'text/sourceText'), value: str('Hello') },
      { type: 'setProperty', prop: P(t, 'text/styleRuns'), value: { kind: 'json', value: JSON.stringify([{ start: 1, end: 3, style: { fauxItalic: true } }]) } },
    ]);
    // The layer's fill colour: solid, shape, text; static, keyed, un-keyed.
    await h.run({ type: 'setProperty', prop: P(s, 'layer/fill'), value: color(0.2, 0.4, 0.6) });
    await h.run({ type: 'setProperty', prop: P(t, 'layer/fill'), value: color(1, 1, 0) });
    await h.run({ type: 'setAnimated', prop: P(sh, 'layer/fill'), animated: true, time: 0 });
    await h.run({ type: 'addKeyframes', keys: [{ prop: P(sh, 'layer/fill'), time: sec(1), spatialIn: [], spatialOut: [] }, { prop: P(sh, 'layer/fill'), time: sec(2), value: color(0, 0, 1, 0.5), spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'setAnimated', prop: P(sh, 'layer/fill'), animated: false, time: sec(1.5) });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/fill'), value: scalar(1) }).catch(ignore);
    // Paint objects (json fields): a gradient primary fill, a fill stack, a text stroke paint, refusals.
    const json = (v: unknown) => ({ kind: 'json' as const, value: JSON.stringify(v) });
    const grad = { type: 'linear', angle: 30, stops: [{ id: 'a', offset: 0, color: '#ff0000' }, { id: 'b', offset: 1, color: '#0000ff' }] };
    await h.run({ type: 'setProperty', prop: P(sh, 'layer/fillPaint'), value: json(grad) });
    await h.run({ type: 'setProperty', prop: P(sh, 'layer/fill'), value: color(1, 0, 0) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(sh, 'layer/fills'), value: json([grad, { type: 'solid', color: '#00ff0080' }]) });
    await h.run({ type: 'setProperty', prop: P(sh, 'layer/fillPaint'), value: json({ type: 'solid', color: '#123456' }) });
    await h.run({ type: 'setProperty', prop: P(sh, 'layer/fillPaint'), value: json(null) });
    await h.run({ type: 'setProperty', prop: P(sh, 'layer/fillPaint'), value: json({ type: 'plaid' }) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(sh, 'layer/fills'), value: json({}) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(t, 'text/strokePaint'), value: json({ type: 'radial', cx: 0.5, cy: 0.5, radius: 0.5, stops: [] }) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'setProperty', prop: P(t3, 'text/strokePaint'), value: json(null) });
    // The composition's motion-blur switch.
    await h.run({ type: 'setCompositionSettings', comp, patch: { motionBlur: { shutterAngle: 270, shutterPhase: -90, samplesPerFrame: 16, adaptiveSampleLimit: 128, enabled: false } } });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    // Persist: save, start over, reopen — every field must come back.
    await h.run({ type: 'saveProject', path: 'C:/p/g1.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'openProject', path: 'C:/p/g1.motion' });
    await h.query({ type: 'getPropertyTree', layer: t, path: '', depth: 0 });
    await h.query({ type: 'getComposition', comp });
  },

  // B3z WS-K: one key per time (lone member keys normalised on edit), per-dimension
  // ease, roving re-timing, setKeyframes (+ as a cancelled / committed gesture),
  // member expressions, failing expressions kept on, Convert Expression to
  // Keyframes disabling (not removing), Time-Reverse over the whole selection.
  'B3z WS-K: member keys, per-dimension ease, roving, setKeyframes, expressions, reverse': async (h) => {
    for (const [path, make] of Object.entries(CORPUS_FIXTURES)) if (!h.files.has(path)) h.files.set(path, make());
    await h.run({ type: 'openProject', path: FIXTURE_MEMBER_KEYS });
    const P = (layer: string, path: string) => ({ layer, path });
    const pos = P('layer_1', 'transform/position');
    const scale = P('layer_1', 'transform/scale');
    const opacity = P('layer_1', 'transform/opacity');
    const keys = async (p: { layer: string; path: string }) => (await h.query({ type: 'getKeyframes', props: [p] })).sets[0]!.keyframes;
    let k = await keys(pos);
    // The lone key at 0 (x only) re-eased: y gets a key there too.
    await h.run({ type: 'updateKeyframes', patches: [{ id: k[0]!.id, easing: 'hold', spatialIn: [], spatialOut: [] }] });
    // The lone key at 2 moved: the whole key moves.
    k = await keys(pos);
    await h.run({ type: 'moveKeyframes', ids: [k[2]!.id], delta: sec(0.5) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    // Per-dimension ease: Scale Y's handle alone, then continuity on X alone.
    let s = await keys(scale);
    await h.run({ type: 'updateKeyframes', patches: [{ id: s[0]!.id, dim: 1, easing: 'bezier', bezier: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 }, spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'updateKeyframes', patches: [{ id: s[0]!.id, dim: 0, continuous: false, spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'updateKeyframes', patches: [{ id: s[0]!.id, dim: 2, easing: 'linear', spatialIn: [], spatialOut: [] }] }).catch(() => undefined);
    // Roving: the middle position key roves (spatial), then an anchor moves → re-roved.
    k = await keys(pos);
    await h.run({ type: 'updateKeyframes', patches: [{ id: k[1]!.id, roving: true, spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'moveKeyframes', ids: [k[2]!.id], delta: sec(1) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'setProperty', prop: pos, value: { kind: 'vec2', value: { x: 900, y: 10 } }, time: k[2]!.time });
    // Opacity (scalar) roving between three keys.
    await h.run({ type: 'addKeyframes', keys: [{ prop: opacity, time: sec(1), value: { kind: 'scalar', value: 90 }, roving: true, spatialIn: [], spatialOut: [] }] });
    // setKeyframes: replace Scale (one id kept, one new, per-dimension ease), then as a preview gesture.
    s = await keys(scale);
    await h.run({ type: 'setKeyframes', prop: scale, keys: [
      { ...s[0]!, value: { kind: 'vec2', value: { x: 50, y: 60 } } },
      { ...s[1]!, id: '', time: sec(2), dims: [{ easing: 'hold', continuous: false }, { easing: 'bezier', bezier: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 1.2 }, continuous: true }] },
      { ...s[1]!, id: 'nope', time: sec(3), value: { kind: 'vec2', value: { x: 10, y: 20 } }, dims: [] },
    ] });
    await h.run({ type: 'setKeyframes', prop: scale, keys: [] }).catch(() => undefined);
    await h.run({ type: 'setKeyframes', prop: scale, keys: [s[0]!, { ...s[1]!, time: s[0]!.time }] }).catch(() => undefined);
    for (const commit of [false, true]) {
      const { gesture } = await h.run({ type: 'beginGesture', label: 'The Smoother' });
      for (const x of [110, 120, 130]) {
        await h.run({ type: 'setKeyframes', prop: scale, keys: [{ ...s[0]!, value: { kind: 'vec2', value: { x, y: x } } }, s[1]!] });
      }
      await h.run({ type: 'endGesture', gesture, commit });
    }
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    // Paste keys that carry per-dimension ease onto another layer.
    s = await keys(scale);
    await h.run({ type: 'pasteKeyframes', prop: P('layer_2', 'transform/scale'), time: sec(0.25), keys: s });
    // Expressions: a failing one stays on; one dimension's own expression; its switch; bake → disabled.
    const r1 = await h.run({ type: 'setExpression', prop: opacity, source: 'value +', enabled: true });
    void r1;
    await h.run({ type: 'setExpression', prop: pos, source: 'value[1] + time * 100', enabled: true, member: 1 });
    await h.run({ type: 'setExpressionEnabled', props: [pos], enabled: false, member: 1 });
    await h.run({ type: 'setExpressionEnabled', props: [pos], enabled: true, member: 1 });
    await h.run({ type: 'setExpression', prop: pos, source: 'time', enabled: true, member: 5 }).catch(() => undefined);
    await h.run({ type: 'setExpression', prop: opacity, source: 'time', enabled: true, member: 0 }).catch(() => undefined);
    await h.run({ type: 'convertExpressionToKeyframes', prop: pos, range: { start: 0, duration: sec(0.5) }, step: 0 });
    await h.query({ type: 'getPropertyTree', layer: 'layer_1', path: 'transform', depth: 2 });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    // Time-Reverse over position + opacity as ONE block.
    const all = [...(await keys(pos)).map((x) => x.id), ...(await keys(opacity)).map((x) => x.id)];
    await h.run({ type: 'reverseKeyframes', ids: all });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'saveProject', path: 'C:/p/wsk.motion', copy: true });
  },

  // B3z: the layer fields (layerFieldSpecs.ts) — component props and fx
  // configs as static properties: encodings, clear-at-default, json shapes,
  // mirrors, refusals, save → open.
  'B3z: layer fields — material, geometry, light, camera, primitive, configs — save → open': async (h) => {
    const comp = 'comp_root';
    const ignore = (): undefined => undefined;
    const P = (layer: string, path: string) => ({ layer, path });
    const str = (value: string) => ({ kind: 'string' as const, value });
    const choice = (value: string) => ({ kind: 'choice' as const, value });
    const bool = (value: boolean) => ({ kind: 'bool' as const, value });
    const json = (v: unknown) => ({ kind: 'json' as const, value: JSON.stringify(v) });
    const { layer: s } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'S', init: [] });
    const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
    const { layer: l } = await h.run({ type: 'createLayer', comp, kind: 'light', name: 'L', init: [] });
    const { layer: c } = await h.run({ type: 'createLayer', comp, kind: 'camera', name: 'C', init: [] });
    const { layer: m } = await h.run({ type: 'createLayer', comp, kind: 'model3d', name: 'M', init: [] });
    const { layer: p } = await h.run({ type: 'createLayer', comp, kind: 'particle', name: 'P', init: [] });
    const { layer: g } = await h.run({ type: 'createLayer', comp, kind: 'group', name: 'G', init: [] });
    await h.run({ type: 'setLayerSwitches', layers: [s, t], patch: { threeD: true } });
    // Material / geometry: encoded choices, clear-at-default numbers, a json object.
    await h.run({ type: 'setProperty', prop: P(s, 'material/shading'), value: choice('toon') });
    await h.run({ type: 'setProperty', prop: P(s, 'material/toonBands'), value: scalar(5) });
    await h.run({ type: 'setProperty', prop: P(s, 'material/toonBands'), value: scalar(3) });
    await h.run({ type: 'setProperty', prop: P(s, 'material/toonBands'), value: scalar(12) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(s, 'material/shading'), value: choice('phong') });
    await h.run({ type: 'setProperty', prop: P(s, 'material/shading'), value: choice('lambert') }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(s, 'material/heightMap'), value: str('asset_1') });
    await h.run({ type: 'setProperty', prop: P(s, 'material/displacementSubdivisions'), value: scalar(2) });
    await h.run({ type: 'setProperty', prop: P(s, 'material/faceMaterials'), value: json({ side: { fill: '#ff0000' }, back: { gain: 1.5 } }) });
    await h.run({ type: 'setProperty', prop: P(s, 'material/faceMaterials'), value: json([1]) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(s, 'geometry/bevelStyle'), value: choice('convex') });
    await h.run({ type: 'setAnimated', prop: P(s, 'geometry/bevelStyle'), animated: true, time: 0 }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(t, 'text/perCharacter3D'), value: bool(true) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    // Light / camera options.
    await h.batch('Light look', [
      { type: 'setProperty', prop: P(l, 'light/lightType'), value: choice('spot') },
      { type: 'setProperty', prop: P(l, 'light/falloff'), value: choice('inverse-square') },
      { type: 'setProperty', prop: P(l, 'light/castsShadows'), value: bool(true) },
      { type: 'setProperty', prop: P(l, 'light/shadowMapSize'), value: scalar(2048) },
    ]);
    await h.run({ type: 'setProperty', prop: P(l, 'light/lightType'), value: choice('environment') });
    await h.run({ type: 'setProperty', prop: P(l, 'light/environment'), value: str('sunset') });
    await h.run({ type: 'setProperty', prop: P(l, 'light/glow'), value: bool(true) });
    await h.run({ type: 'setProperty', prop: P(l, 'light/glow'), value: bool(false) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'setProperty', prop: P(c, 'camera/filmSize'), value: scalar(24) });
    await h.run({ type: 'setProperty', prop: P(s, 'light/lightType'), value: choice('spot') }).catch(ignore);
    // Primitive: the type mirrors onto the Transform; params; a bool.
    await h.run({ type: 'setProperty', prop: P(m, 'primitive/type'), value: choice('torus') });
    await h.run({ type: 'setProperty', prop: P(m, 'primitive/tube'), value: scalar(20) });
    await h.run({ type: 'setProperty', prop: P(m, 'primitive/radialSegments'), value: scalar(2) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(m, 'primitive/capped'), value: bool(false) });
    // Structured configs: particle, cloner, physics, waveform, modifiers, precompose.
    await h.run({ type: 'setProperty', prop: P(p, 'layer/particle'), value: json({ emitterType: 'box', birthRate: 40, colorStart: '#ffffff' }) });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/cloner'), value: json({ enabled: true, mode: 'grid', countX: 3, countY: 2, step: { x: 10, y: 0, rotation: 0, scale: 0, opacity: 0, time: 0 } }) });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/physics'), value: json({ enabled: true, kind: 'dynamic', shape: 'box', mass: 2 }) });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/physics'), value: json(null) });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/cloner'), value: json('grid') }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(t, 'layer/audioWaveform'), value: json({ sourceLayerId: '', samples: 64, heightScale: 1, thickness: 2, mode: 'full', windowSec: 2 }) });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/modifiers'), value: json({ opacity: { modifiers: [{ id: 'm1', enabled: true, kind: 'offset', amount: 5 }], previous: null } }) });
    await h.run({ type: 'setProperty', prop: P(g, 'layer/precompose'), value: bool(true) });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/precompose'), value: bool(true) }).catch(ignore);
    // Persist.
    await h.run({ type: 'saveProject', path: 'C:/p/b3z.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'openProject', path: 'C:/p/b3z.motion' });
    for (const id of [s, t, l, c, m, p, g]) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
  },

  // B3z-a E2: audio / retime / tracker results as primitives — the Audio
  // Levels / Pan home (an audio layer's Audio component; a centred pan stored
  // absent), the legacy percent level read, Convert Audio to Keyframes' track
  // before its first key, a one-node camera's Point of Interest, the no-bar
  // clip fields and the tracker's solve-camera tag; retime keys; silence
  // removal's split / delete / local shift; save → open.
  'B3z-a E2: audio levels home, amplitude track, camera POI, clip fields, retime keys, tracker splice — save → open': async (h) => {
    const comp = 'comp_root';
    const ignore = (): undefined => undefined;
    const P = (layer: string, path: string) => ({ layer, path });
    const bool = (value: boolean) => ({ kind: 'bool' as const, value });
    const json = (v: unknown) => ({ kind: 'json' as const, value: JSON.stringify(v) });
    const lin = { easing: 'linear' as const, spatialIn: [], spatialOut: [] };
    const { items: [clip, sound] } = await h.run({
      type: 'importFiles',
      files: [
        { path: 'C:/m/e2clip.mp4', asSequence: false, createComposition: false },
        { path: 'C:/m/e2sound.wav', asSequence: false, createComposition: false },
      ],
    });
    const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'audio', source: sound!, name: 'Music', init: [] });
    const { layer: v } = await h.run({ type: 'createLayer', comp, kind: 'video', source: clip!, name: 'Take', init: [] });
    const { layer: c } = await h.run({ type: 'createLayer', comp, kind: 'camera', name: 'Cam', init: [] });
    const { layer: n } = await h.run({ type: 'createLayer', comp, kind: 'null', name: 'Tracked Null', init: [{ path: 'transform/position', value: v2(120, 80) }] });
    // Levels / pan: the legacy percent reads as dB; writes land on the home component; pan 0 = absent.
    await h.query({ type: 'getPropertyValues', props: [P(a, 'audio/levels'), P(v, 'audio/levels'), P(a, 'audio/pan')], time: 0, evaluated: false });
    await h.run({ type: 'setProperty', prop: P(a, 'audio/levels'), value: scalar(-6) });
    await h.run({ type: 'setProperty', prop: P(a, 'audio/pan'), value: scalar(30) });
    await h.run({ type: 'setProperty', prop: P(a, 'audio/pan'), value: scalar(0) });
    await h.run({ type: 'setProperty', prop: P(v, 'audio/levels'), value: scalar(-3) });
    await h.run({ type: 'setProperty', prop: P(v, 'audio/pan'), value: scalar(-20) });
    await h.run({ type: 'undo' });
    // A fade: keys in, the record fields, the expression rule.
    await h.run({ type: 'addKeyframes', keys: [{ prop: P(a, 'audio/levels'), time: sec(0), value: scalar(-60), ...lin }, { prop: P(a, 'audio/levels'), time: sec(1), value: scalar(-6), ...lin }] });
    await h.run({ type: 'setExpression', prop: P(a, 'audio/levels'), source: 'value', enabled: true });
    await h.batch('Duck Music', [
      { type: 'setProperty', prop: P(a, 'audio/ducking'), value: json({ duckDb: -12, thresholdDb: -30, attackMs: 50, releaseMs: 300, holdMs: 100, voiceNodeId: v }) },
      { type: 'setExpression', prop: P(a, 'audio/levels'), source: '', enabled: true },
      { type: 'addKeyframes', keys: [{ prop: P(a, 'audio/levels'), time: sec(0.5), value: scalar(-18), ...lin }] },
    ]);
    const levelKeys = await h.query({ type: 'getKeyframes', props: [P(a, 'audio/levels')] });
    const firstLevel = levelKeys.sets[0]?.keyframes[0]?.id;
    if (firstLevel) await h.run({ type: 'deleteKeyframes', ids: [firstLevel] });
    await h.run({ type: 'setProperty', prop: P(a, 'audio/gate'), value: json({ thresholdDb: -45, reductionDb: -30, fps: 30, startCompSec: 0 }) });
    await h.run({ type: 'setProperty', prop: P(a, 'audio/effects'), value: json([{ id: 'afx_1', type: 'eq', params: { gain: 3 } }]) });
    await h.run({ type: 'setProperty', prop: P(a, 'audio/drivers'), value: json({ audioLevelDb: { prop: 'audioLevelDb', sourceLayerId: 'mix', mode: 'baked' } }) });
    await h.run({ type: 'setProperty', prop: P(c, 'audio/drivers'), value: json({ zoom: { prop: 'zoom', sourceLayerId: 'mix', mode: 'expression' } }) });
    await h.run({ type: 'setLayerSwitches', layers: [a], patch: { audioEnabled: false } });
    // Convert Audio to Keyframes' track, before and after its first key.
    await h.run({ type: 'addKeyframes', keys: [{ prop: P(a, 'layer/audioAmplitude'), time: sec(0), value: scalar(12.5), ...lin }, { prop: P(a, 'layer/audioAmplitude'), time: sec(0.2), value: scalar(80), ...lin }] });
    await h.run({ type: 'addKeyframes', keys: [{ prop: P(v, 'layer/audioAmplitude'), time: sec(0), value: scalar(1), ...lin }] }).catch(ignore);
    // No-bar clip fields (stored whatever the bar says) and a refused negative.
    await h.batch('Timing', [
      { type: 'setProperty', prop: P(a, 'audio/clipStart'), value: scalar(0.5) },
      { type: 'setProperty', prop: P(a, 'audio/clipIn'), value: scalar(0.25) },
      { type: 'setProperty', prop: P(a, 'audio/clipOut'), value: scalar(2) },
    ]);
    await h.run({ type: 'setProperty', prop: P(a, 'audio/clipIn'), value: scalar(-1) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(v, 'audio/clipIn'), value: scalar(1) }).catch(ignore);
    await h.run({ type: 'setLayerTiming', items: [{ layer: a, inPoint: sec(0.2), outPoint: sec(1.6) }] });
    // Tracker: a one-node camera's POI keys + position, the solve tag; a null spliced.
    await h.run({ type: 'addKeyframes', keys: [
      { prop: P(c, 'camera/poiX'), time: sec(0), value: scalar(300), ...lin },
      { prop: P(c, 'camera/poiY'), time: sec(0), value: scalar(200), ...lin },
      { prop: P(c, 'transform/position'), time: sec(0), value: { kind: 'vec3', value: { x: 300, y: 200, z: -800 } }, ...lin },
    ] });
    await h.run({ type: 'setProperty', prop: P(c, 'camera/trackerSolve'), value: bool(true) });
    await h.run({ type: 'createLayer', comp, kind: 'camera', name: '3D Camera Tracker', init: [{ path: 'camera/trackerSolve', value: bool(true) }] });
    await h.run({ type: 'setProperty', prop: P(a, 'camera/trackerSolve'), value: bool(true) }).catch(ignore);
    await h.run({ type: 'addKeyframes', keys: [0, 1, 2, 3].map((i) => ({ prop: P(n, 'transform/position'), time: sec(i / 10), value: v2(120 + i, 80 - i), ...lin })) });
    const nk = await h.query({ type: 'getKeyframes', props: [P(n, 'transform/position')] });
    await h.run({ type: 'addKeyframes', keys: [1, 2].map((i) => ({ prop: P(n, 'transform/position'), time: sec(i / 10), value: v2(0, i), ...lin })) });
    await h.run({ type: 'deleteKeyframes', ids: nk.sets[0]!.keyframes.slice(1, 2).map((k) => k.id) }).catch(ignore);
    // Retime: speed curve CRUD, ramp style, preset replace, frames.
    await h.run({ type: 'setRetime', layer: v, mode: 'speed' });
    await h.run({ type: 'addKeyframes', keys: [{ prop: P(v, 'layer/timeSpeed'), time: sec(1), value: scalar(40), easing: 'easeInOut', spatialIn: [], spatialOut: [] }] });
    const sk = await h.query({ type: 'getKeyframes', props: [P(v, 'layer/timeSpeed')] });
    const ids = sk.sets[0]!.keyframes.map((k) => k.id);
    await h.run({ type: 'updateKeyframes', patches: ids.map((id) => ({ id, easing: 'step' as const, clearBezier: true, spatialIn: [], spatialOut: [] })) });
    await h.run({ type: 'updateKeyframes', patches: [{ id: ids[ids.length - 1]!, time: sec(1.5), value: scalar(250), spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'setLayerSwitches', layers: [v], patch: { frameBlend: 'pixelMotion' } });
    await h.run({ type: 'setKeyframes', prop: P(v, 'layer/timeSpeed'), keys: [0, 0.5, 1].map((t, i) => ({
      id: '', time: sec(t), value: scalar([300, 20, 100][i]!), easing: 'easeInOut' as const, continuous: false, roving: false,
      spatialInterp: 'legacy' as const, spatialIn: [], spatialOut: [], label: 0, dims: [],
    })) });
    await h.run({ type: 'setRetime', layer: v, mode: 'frames' });
    await h.run({ type: 'addKeyframes', keys: [{ prop: P(v, 'timeRemap'), time: sec(0.5), value: scalar(0.25), ...lin }] });
    await h.run({ type: 'setRetime', layer: v, mode: 'speed' });
    // Silence removal: split both edges, delete inside, shift the later part.
    const { layers: [right] } = await h.run({ type: 'splitLayers', layers: [a], time: sec(0.6) });
    const { layers: [tail] } = await h.run({ type: 'splitLayers', layers: [right!], time: sec(0.9) });
    await h.run({ type: 'deleteLayers', layers: [right!] });
    await h.run({ type: 'moveLayersInTime', layers: [tail!], delta: -sec(0.3), ripple: false });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    // Persist.
    await h.run({ type: 'saveProject', path: 'C:/p/b3z-e2.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'openProject', path: 'C:/p/b3z-e2.motion' });
    for (const id of [a, v, c, n]) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
  },

  'B3z WS-R: puppet pins and skeletons — groups, pin keys, bones, IK, pole, bind pose — save → open': async (h) => {
    const comp = 'comp_root';
    const ignore = (): undefined => undefined;
    const P = (layer: string, path: string) => ({ layer, path });
    const str = (value: string) => ({ kind: 'string' as const, value });
    const choice = (value: string) => ({ kind: 'choice' as const, value });
    const json = (v: unknown) => ({ kind: 'json' as const, value: JSON.stringify(v) });
    const { layer: s } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'Puppet', init: [] });
    const { layer: k } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'Rig', init: [] });
    const { layer: cam } = await h.run({ type: 'createLayer', comp, kind: 'camera', name: 'Cam', init: [] });
    // Puppet: pins (creating the rig), init, mesh fields, keys, tangents, reorder, rename.
    const { groups: [p1] } = await h.run({ type: 'addPropertyGroup', layer: s, parent: 'puppet/pins', matchName: 'ADBE FreePin3 PosPin Atom',
      init: [{ path: 'restPosition', value: v2(-20, 10) }, { path: 'kind', value: choice('position') }] });
    const { groups: [p2] } = await h.run({ type: 'addPropertyGroup', layer: s, parent: 'puppet/pins', matchName: 'ADBE FreePin3 PosPin Atom', name: 'Hand',
      init: [{ path: 'kind', value: choice('overlap') }] });
    await h.run({ type: 'addPropertyGroup', layer: s, parent: 'puppet/pins', matchName: 'ADBE FreePin3 PosPin Atom', index: 0,
      init: [{ path: 'kind', value: choice('starch') }, { path: 'position', value: v2(3, 4) }] });
    await h.run({ type: 'addPropertyGroup', layer: s, parent: 'puppet/pins', matchName: 'ADBE FreePin3 PosPin Atom', index: 9, init: [] }).catch(ignore);
    await h.run({ type: 'addPropertyGroup', layer: cam, parent: 'puppet/pins', matchName: 'ADBE FreePin3 PosPin Atom', init: [] }).catch(ignore);
    await h.run({ type: 'addPropertyGroup', layer: s, parent: '', matchName: 'ADBE FreePin3', init: [] }).catch(ignore);
    await h.batch('Mesh', [
      { type: 'setProperty', prop: P(s, 'puppet/mesh/density'), value: scalar(14) },
      { type: 'setProperty', prop: P(s, 'puppet/mesh/mode'), value: choice('silhouette') },
      { type: 'setProperty', prop: P(s, 'puppet/mesh/rotationRefinement'), value: scalar(30) },
      { type: 'setProperty', prop: P(s, 'puppet/mesh/solver'), value: choice('lbs') },
    ]);
    await h.run({ type: 'setProperty', prop: P(s, 'puppet/mesh/rotationRefinement'), value: scalar(0) });
    await h.run({ type: 'setProperty', prop: P(s, 'puppet/mesh/solver'), value: choice('fem') }).catch(ignore);
    await h.run({ type: 'addKeyframes', keys: [
      { prop: P(s, `${p1}/position`), time: sec(0), value: v2(-20, 10), spatialIn: [], spatialOut: [4, -2] },
      { prop: P(s, `${p1}/position`), time: sec(1), value: v2(30, 40), spatialIn: [-3, 1], spatialOut: [] },
      { prop: P(s, `${p2}/rotation`), time: sec(0.5), value: scalar(45), spatialIn: [], spatialOut: [] },
    ] });
    await h.run({ type: 'beginGesture', label: 'Move Puppet Pin' });
    for (const x of [31, 35, 42]) await h.run({ type: 'setProperty', prop: P(s, `${p1}/position`), value: v2(x, x + 10), time: sec(1) });
    await h.run({ type: 'endGesture', gesture: 0, commit: true });
    await h.run({ type: 'setProperty', prop: P(s, `${p2}/scale`), value: scalar(150) });
    await h.run({ type: 'setProperty', prop: P(s, `${p2}/overlap`), value: scalar(120) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(s, `${p2}/overlapExtent`), value: scalar(2) });
    await h.run({ type: 'setAnimated', prop: P(s, `${p2}/stiffness`), animated: true, time: sec(0.25) });
    await h.run({ type: 'movePropertyGroup', group: P(s, p2!), toIndex: 0 });
    await h.run({ type: 'renamePropertyGroup', group: P(s, p1!), name: 'Elbow' });
    await h.run({ type: 'renamePropertyGroup', group: P(s, 'puppet'), name: 'X' }).catch(ignore);
    const pk = await h.query({ type: 'getKeyframes', props: [P(s, `${p1}/position`)] });
    await h.run({ type: 'updateKeyframes', patches: [{ id: pk.sets[0]!.keyframes[0]!.id, spatialIn: [], spatialOut: [9, 9] }] });
    await h.run({ type: 'deleteKeyframes', ids: pk.sets[0]!.keyframes.map((x) => x.id) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'setAnimated', prop: P(s, `${p1}/position`), animated: false, time: sec(0.5) });
    await h.run({ type: 'removePropertyGroups', groups: [P(s, p2!)] });
    await h.run({ type: 'undo' });
    // Skeleton: bones (creating the skeleton), parent, IK goal + pole, controller, weight paint, bind pose.
    const { groups: [b1] } = await h.run({ type: 'addPropertyGroup', layer: k, parent: 'skeleton/bones', matchName: 'Premation Bone',
      init: [{ path: 'position', value: v2(-50, 0) }, { path: 'length', value: scalar(60) }, { path: 'rotation', value: scalar(30) }] });
    const { groups: [b2] } = await h.run({ type: 'addPropertyGroup', layer: k, parent: 'skeleton/bones', matchName: 'Premation Bone',
      init: [{ path: 'parent', value: str('bone_1') }, { path: 'position', value: v2(60, 0) }, { path: 'length', value: scalar(40) }] });
    await h.run({ type: 'addPropertyGroup', layer: k, parent: 'skeleton/bones', matchName: 'Premation Bone', init: [{ path: 'parent', value: str('bone_9') }] }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(k, `${b1}/parent`), value: str('bone_2') }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(k, `${b2}/rotation`), value: scalar(-45) });
    await h.run({ type: 'setProperty', prop: P(k, `${b1}/restRotation`), value: scalar(20) });
    await h.run({ type: 'setProperty', prop: P(k, `${b2}/restScale`), value: v2(110, 90) });
    await h.run({ type: 'setProperty', prop: P(k, `${b2}/influenceRadius`), value: scalar(80) });
    await h.run({ type: 'setProperty', prop: P(k, `${b2}/influenceRadius`), value: scalar(0) });
    await h.run({ type: 'addPropertyGroup', layer: k, parent: b2!, matchName: 'Premation IK Goal', init: [{ path: 'target', value: v2(70, 30) }, { path: 'chainLength', value: scalar(2) }] });
    await h.run({ type: 'addPropertyGroup', layer: k, parent: b2!, matchName: 'Premation IK Goal', init: [] }).catch(ignore);
    await h.run({ type: 'addProperties', parent: P(k, `${b2}/ik`), names: ['pole'] });
    await h.run({ type: 'addProperties', parent: P(k, `${b2}/ik`), names: ['nope'] }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(k, `${b2}/ik/pole`), value: v2(10, -40) });
    await h.run({ type: 'setAnimated', prop: P(k, `${b2}/ik/target`), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(k, `${b2}/ik/target`), value: v2(80, 20), time: sec(1) });
    await h.run({ type: 'addKeyframes', keys: [{ prop: P(k, `${b2}/ik/mode`), time: sec(0.5), value: scalar(0), spatialIn: [], spatialOut: [] }] });
    await h.run({ type: 'setGroupEnabled', groups: [P(k, `${b2}/ik`)], enabled: false });
    await h.run({ type: 'setGroupEnabled', groups: [P(k, b1!)], enabled: false }).catch(ignore);
    await h.run({ type: 'addPropertyGroup', layer: k, parent: 'skeleton/controllers', matchName: 'Premation Rig Controller', name: 'Hand ctrl',
      init: [{ path: 'drives', value: choice('bone') }, { path: 'bone', value: str('bone_2') }, { path: 'offset', value: v2(5, 0) }] });
    await h.run({ type: 'setProperty', prop: P(k, 'skeleton/weightPaint'), value: json({ vertexCount: 12, bones: { bone_1: { 3: 0.5 }, bone_2: { 4: 1 } } }) });
    await h.run({ type: 'setProperty', prop: P(k, 'skeleton/weightPaint'), value: json([1]) }).catch(ignore);
    await h.run({ type: 'setAnimated', prop: P(k, `${b1}/rotation`), animated: true, time: 0 });
    const bk = await h.query({ type: 'getKeyframes', props: [P(k, `${b1}/rotation`)] });
    await h.run({ type: 'deleteKeyframes', ids: bk.sets[0]!.keyframes.map((x) => x.id) });
    await h.run({ type: 'removeProperties', props: [P(k, `${b2}/ik/pole`)] });
    await h.run({ type: 'removePropertyGroups', groups: [P(k, b1!)] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'duplicatePropertyGroups', groups: [P(k, b1!)] }).catch(ignore);
    // Whole-rig replace (a rig preset) drops the keys of removed bones.
    await h.run({ type: 'setProperty', prop: P(k, 'layer/skeleton'), value: json({ bones: [{ id: 'bone_1', name: 'Root', parentId: null, length: 50, x: 0, y: 0, rotation: 0 }], ikTargets: [] }) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'saveProject', path: 'C:/p/wsr.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'openProject', path: 'C:/p/wsr.motion' });
    for (const id of [s, k]) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
    await h.run({ type: 'removePropertyGroups', groups: [P(s, 'puppet'), P(k, 'skeleton')] });
    await h.run({ type: 'undo' });
  },

  'B3z: Layer Above track matte and latent text Tracking / Leading — save → open': async (h) => {
    const comp = 'comp_root';
    const P = (layer: string, path: string) => ({ layer, path });
    const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
    const { layer: b } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'B', init: [] });
    const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
    // The positional matte (no source layer), then by reference, then none.
    await h.run({ type: 'setTrackMatte', layer: a, matte: { mode: 'lumaInverted' } });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'setTrackMatte', layer: a, matte: { layer: b, mode: 'alpha' } });
    await h.run({ type: 'setTrackMatte', layer: a, matte: { mode: 'alpha' } });
    await h.run({ type: 'setTrackMatte', layer: a, matte: { mode: 'none' } });
    await h.run({ type: 'undo' });
    await h.run({ type: 'setTrackMatte', layer: a, matte: { layer: a, mode: 'alpha' } }).catch(() => undefined);
    // Latent text Tracking / Leading: first static write homes on the Text component; then keyed.
    await h.batch('Text preset', [
      { type: 'setProperties', writes: [{ prop: P(t, 'text/letterSpacing'), value: scalar(6), time: 0 }, { prop: P(t, 'text/lineHeight'), value: scalar(1.4), time: 0 }] },
    ]);
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'setAnimated', prop: P(t, 'text/letterSpacing'), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(t, 'text/letterSpacing'), value: scalar(12), time: 705_600_000 });
    await h.run({ type: 'saveProject', path: 'C:/p/b3zb.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'openProject', path: 'C:/p/b3zb.motion' });
    for (const id of [a, b, t]) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
  },

  'B3z: paint — stroke stack, removeStroke, gradient Colors, latent numbers, point of interest — save → open': async (h) => {
    const comp = 'comp_root';
    const ignore = (): undefined => undefined;
    const P = (layer: string, path: string) => ({ layer, path });
    const bool = (value: boolean) => ({ kind: 'bool' as const, value });
    const json = (v: unknown) => ({ kind: 'json' as const, value: JSON.stringify(v) });
    const color = (r: number, g: number, b: number) => ({ kind: 'color' as const, value: { r, g, b, a: 1 } });
    const grad = (stops: Array<[number, number, number, number]>) => ({
      kind: 'gradient' as const,
      value: { kind: 'linear' as const, stops: stops.map(([offset, r, g, b]) => ({ offset, color: { r, g, b, a: 1 } })), alphaStops: [] },
    });
    const stroke = (width: number, extra: Record<string, unknown> = {}) =>
      ({ enabled: true, color: '#ff0000', width, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter', ...extra });
    const { layer: s } = await h.run({ type: 'createLayer', comp, kind: 'rectangle', name: 'R', init: [] });
    const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
    const { layer: l } = await h.run({ type: 'createLayer', comp, kind: 'light', name: 'L', init: [] });
    const { layer: c } = await h.run({ type: 'createLayer', comp, kind: 'camera', name: 'C', init: [] });
    const { layer: m } = await h.run({ type: 'createLayer', comp, kind: 'model3d', name: 'M', init: [] });
    for (const id of [s, t, l, c, m]) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
    // The stroke stack: three strokes, a dash, a gradient paint, taper and wave.
    await h.run({ type: 'setProperty', prop: P(s, 'layer/strokes'), value: json([
      stroke(4), stroke(2, { dash: [10, 5], dashOffset: 3 }),
      stroke(3, { paint: { type: 'linear', angle: 30, stops: [{ id: 'a', offset: 0, color: '#ffffff' }, { id: 'b', offset: 1, color: '#000000' }] }, taper: { startWidth: 0.5, endWidth: 1, startLength: 0.3, endLength: 0, startEase: 0, endEase: 0 } }),
    ]) });
    await h.query({ type: 'getPropertyTree', layer: s, path: '', depth: 0 });
    // The stroke rows' static seam: width / opacity / miter / dash / offset / taper / wave / gradient points / colour.
    await h.batch('Stroke looks', [
      { type: 'setProperty', prop: P(s, 'layer/strokeWidth'), value: scalar(6) },
      { type: 'setProperty', prop: P(s, 'layer/strokeOpacity'), value: scalar(0.5) },
      { type: 'setProperty', prop: P(s, 'layer/strokeMiterLimit'), value: scalar(7) },
      { type: 'setProperty', prop: P(s, 'layer/stroke.1.gap1'), value: scalar(-4) },
      { type: 'setProperty', prop: P(s, 'layer/stroke.1.dashOffset'), value: scalar(12) },
      { type: 'setProperty', prop: P(s, 'layer/stroke.2.taperEndLength'), value: scalar(0.25) },
      { type: 'setProperty', prop: P(s, 'layer/stroke.2.gradientEndX'), value: scalar(0.8) },
      { type: 'setProperty', prop: P(s, 'layer/strokeWaveAmount'), value: scalar(6) },
      { type: 'setProperty', prop: P(s, 'layer/stroke.1.color'), value: color(0, 0.5, 1) },
    ]);
    await h.run({ type: 'setProperty', prop: P(s, 'layer/strokeTaperStartWidth'), value: scalar(0.4) });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/stroke.1.gap2'), value: scalar(2) }).catch(ignore);
    // Keys on strokes 2 and 3, then a shortened dash, removeStroke, and a shortened stack.
    await h.run({ type: 'setAnimated', prop: P(s, 'layer/stroke.1.gap1'), animated: true, time: 0 });
    await h.run({ type: 'setAnimated', prop: P(s, 'layer/stroke.2.width'), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/stroke.2.width'), value: scalar(9), time: sec(1) });
    await h.run({ type: 'setExpression', prop: P(s, 'layer/stroke.2.opacity'), source: 'value', enabled: true }).catch(ignore);
    await h.run({ type: 'setAnimated', prop: P(s, 'layer/stroke.2.taperStartWidth'), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/strokes'), value: json([stroke(4), stroke(2, { dash: [10] }), stroke(3)]) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'removeStroke', layer: s, index: 1 });
    await h.query({ type: 'getPropertyTree', layer: s, path: '', depth: 0 });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'removeStroke', layer: s, index: 9 }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(s, 'layer/strokes'), value: json([{ color: 'x' }]) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(s, 'layer/strokes'), value: json([stroke(5)]) });
    await h.run({ type: 'undo' });
    // Gradient Fill ▸ Colors: static, stopwatch, a key, a typed error, stopwatch off.
    await h.run({ type: 'setProperty', prop: P(s, 'layer/fillPaint'), value: json({ type: 'linear', angle: 0, stops: [{ id: 'a', offset: 0, color: '#ff0000' }, { id: 'b', offset: 1, color: '#0000ff' }] }) });
    await h.query({ type: 'getPropertyTree', layer: s, path: '', depth: 0 });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/fillStops'), value: grad([[0, 0, 1, 0], [0.5, 1, 1, 1], [1, 0, 0, 0]]) });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/fillAngle'), value: scalar(45) });
    await h.run({ type: 'setAnimated', prop: P(s, 'layer/fillStops'), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/fillStops'), value: grad([[0, 1, 1, 1], [1, 0.2, 0.4, 0.6]]), time: sec(1) });
    await h.run({ type: 'setProperty', prop: P(s, 'layer/fillStops'), value: json([]), time: sec(1) }).catch(ignore);
    await h.query({ type: 'getPropertyValues', props: [P(s, 'layer/fillStops')], time: sec(0.5), evaluated: true });
    await h.run({ type: 'setAnimated', prop: P(s, 'layer/fillStops'), animated: false, time: sec(1) });
    await h.run({ type: 'undo' });
    // Latent numbers: corners (Style), text stroke width (Text), skew, light / camera options, morph.
    await h.batch('Corners', [
      { type: 'setProperty', prop: P(s, 'layer/cornerRadiusTL'), value: scalar(12) },
      { type: 'setProperty', prop: P(s, 'layer/cornerRadiusBR'), value: scalar(4) },
    ]);
    await h.run({ type: 'setProperty', prop: P(s, 'layer/skew'), value: scalar(10) });
    await h.run({ type: 'setProperty', prop: P(t, 'layer/strokeWidth'), value: scalar(3) });
    await h.run({ type: 'setAnimated', prop: P(t, 'layer/fillOpacity'), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(l, 'light/falloffDistance'), value: scalar(250) });
    await h.run({ type: 'setAnimated', prop: P(l, 'light/shadowBias'), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(c, 'camera/irisRotation'), value: scalar(15) });
    await h.run({ type: 'setAnimated', prop: P(c, 'camera/dofStrength'), animated: true, time: 0 });
    // Point of Interest on / off, with a key that goes with it.
    await h.run({ type: 'setProperty', prop: P(c, 'transform/orientTowardsPointOfInterest'), value: bool(true) });
    await h.run({ type: 'setAnimated', prop: P(c, 'camera/poiX'), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(c, 'transform/orientTowardsPointOfInterest'), value: bool(false) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'setProperty', prop: P(l, 'transform/orientTowardsPointOfInterest'), value: bool(true) });
    await h.run({ type: 'setProperty', prop: P(s, 'transform/orientTowardsPointOfInterest'), value: bool(true) }).catch(ignore);
    for (const id of [s, t, l, c, m]) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
    // Persist.
    await h.run({ type: 'saveProject', path: 'C:/p/b3z-paint.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'openProject', path: 'C:/p/b3z-paint.motion' });
    for (const id of [s, t, l, c, m]) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
  },

  // @@family:properties
  ...((): Record<string, Session> => {
    const P = (layer: string, path: string) => ({ layer, path });
    const doc = (text: string) => ({ kind: 'textDocument' as const, value: { text, runs: [], paragraphs: [], orientation: 'horizontal' as const, kerning: 'metrics' } });
    const square = (s: number) => ({ kind: 'path' as const, value: { vertices: [0, 0, s, 0, s, s, 0, s], inTangents: [], outTangents: [], closed: true, featherPoints: [] } });
    const ignore = (): undefined => undefined;
    /**
     * Every property of a layer: read the tree, write a new value to each
     * (static), then — keyed — two keys on every animatable numeric one, a
     * refused un-timed write, a timed write between them, and reads of the
     * evaluated values and the keys.
     */
    const sweep = async (h: Harness, layer: string, keyed: boolean, k = 0): Promise<void> => {
      const tree = await h.query({ type: 'getPropertyTree', layer, path: '', depth: 0 });
      type N = (typeof tree.nodes)[number];
      type V = NonNullable<N['value']>;
      const bump = (n: N, j: number): V | undefined => {
        const v = n.value;
        if (!v) return undefined;
        const clamp = (x: number): number => Math.min(n.max ?? Infinity, Math.max(n.min ?? -Infinity, x));
        switch (v.kind) {
          case 'scalar': return { kind: 'scalar', value: n.min !== undefined && n.max !== undefined ? n.min + (n.max - n.min) * (0.3 + 0.2 * j) : clamp(v.value + 7 * (j + 1)) };
          case 'vec2': return { kind: 'vec2', value: { x: v.value.x + 11 * (j + 1), y: v.value.y - 5 * (j + 1) } };
          case 'vec3': return { kind: 'vec3', value: { x: v.value.x + 11 * (j + 1), y: v.value.y - 5 * (j + 1), z: v.value.z + 13 * (j + 1) } };
          case 'color': return { kind: 'color', value: { r: 0.25 + 0.5 * j, g: 0.5, b: 0.75 - 0.5 * j, a: 1 } };
          case 'bool': return { kind: 'bool', value: !v.value };
          case 'choice': return n.choices.length > 0 ? { kind: 'choice', value: n.choices[(n.choices.indexOf(v.value) + 1 + j) % n.choices.length]! } : v;
          case 'textDocument': return doc(`Text ${j}`);
          case 'path': return square(50 + 25 * j);
          default: return v;
        }
      };
      const props = tree.nodes.filter((n) => n.kind === 'property');
      for (const n of props) {
        const v = bump(n, k);
        if (v) await h.run({ type: 'setProperty', prop: P(layer, n.path), value: v }).catch(ignore);
      }
      if (keyed) {
        const numeric = props.filter((n) => n.animatable && ['scalar', 'vec2', 'vec3', 'color', 'path', 'textDocument'].includes(n.valueType));
        for (const n of numeric) {
          const a = bump(n, 0);
          const b = bump(n, 1);
          if (!a || !b) continue;
          await h.run({ type: 'addKeyframes', keys: [
            { prop: P(layer, n.path), time: 0, value: a, spatialIn: [], spatialOut: [] },
            { prop: P(layer, n.path), time: sec(1), value: b, spatialIn: [], spatialOut: [] },
          ] }).catch(ignore);
          await h.run({ type: 'setProperty', prop: P(layer, n.path), value: a }).catch(ignore);
          await h.run({ type: 'setProperty', prop: P(layer, n.path), value: b, time: sec(0.5) }).catch(ignore);
        }
      }
      const paths = props.map((n) => P(layer, n.path));
      await h.query({ type: 'getPropertyValues', props: paths, time: sec(0.25), evaluated: true }).catch(ignore);
      await h.query({ type: 'getPropertyValues', props: paths, time: sec(0.75), evaluated: false }).catch(ignore);
      await h.query({ type: 'getKeyframes', props: paths }).catch(ignore);
      await h.query({ type: 'getPropertyTree', layer, path: '', depth: 0 }).catch(ignore);
    };
    const kinds = ['null', 'solid', 'shape', 'rectangle', 'ellipse', 'polygon', 'path', 'text', 'camera', 'light', 'group', 'particle', 'model3d', 'adjustment'] as const;

    return {
      'properties: every property of every layer kind, static then keyed': async (h) => {
        const comp = 'comp_root';
        const ids: string[] = [];
        for (const kind of kinds) ids.push((await h.run({ type: 'createLayer', comp, kind, name: `K ${kind}`, init: [] })).layer);
        await h.run({ type: 'setLayerSwitches', layers: [ids[1]!, ids[2]!, ids[7]!], patch: { threeD: true } });
        for (const id of ids) await sweep(h, id, false, 0);
        for (const id of ids) await sweep(h, id, true, 1);
        await h.run({ type: 'undo' });
        await h.run({ type: 'undo' });
        await h.run({ type: 'redo' });
      },

      'properties: effects of every param type, masks, layer styles, path ops, text animators': async (h) => {
        const comp = 'comp_root';
        const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
        const { layer: s } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'S', init: [] });
        const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
        for (const effect of ['glow', 'satin', 'set-matte', 'spotlight', 'arithmetic', 'audio-spectrum', 'curves', 'drop-shadow']) {
          await h.run({ type: 'addEffect', layers: [a], effect, params: [] }).catch(ignore);
        }
        await h.run({ type: 'addMask', layer: a, mode: 'add', inverted: false, path: square(100).value }).catch(ignore);
        await h.run({ type: 'addMask', layer: a, mode: 'subtract', inverted: true, path: square(40).value }).catch(ignore);
        for (const style of ['dropShadow', 'stroke', 'colorOverlay', 'bevel', 'outerGlow']) {
          await h.run({ type: 'addPropertyGroup', layer: s, parent: 'styles', matchName: `style:${style}`, init: [] }).catch(ignore);
        }
        for (const op of ['trim', 'zigzag', 'roundCorners', 'repeater', 'offset']) {
          await h.run({ type: 'addPropertyGroup', layer: s, parent: 'contents', matchName: `pathop:${op}`, init: [] }).catch(ignore);
        }
        const an = await h.run({ type: 'addPropertyGroup', layer: t, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] }).catch(ignore);
        if (an) await h.run({ type: 'addPropertyGroup', layer: t, parent: `${an.groups[0]!}/selectors`, matchName: 'ADBE Text Wiggly Selector', init: [] }).catch(ignore);
        for (const id of [a, s, t]) await sweep(h, id, false, 0);
        for (const id of [a, s, t]) await sweep(h, id, true, 1);
        await h.run({ type: 'undo' });
        await h.run({ type: 'redo' });
      },

      'properties: footage and precomp layers — video, image, audio levels and pan, time remap': async (h) => {
        const comp = 'comp_root';
        const { items: [clip, still, sound] } = await h.run({ type: 'importFiles', files: [
          { path: 'C:/m/clip.mp4', asSequence: false, createComposition: false },
          { path: 'C:/m/still.png', asSequence: false, createComposition: false },
          { path: 'C:/m/sound.wav', asSequence: false, createComposition: false },
        ] });
        const { item: inner } = await h.run({ type: 'createComposition', settings: { name: 'Inner', width: 640, height: 480 }, fromItems: [] });
        const ids: string[] = [];
        ids.push((await h.run({ type: 'createLayer', comp, kind: 'video', source: clip!, init: [] })).layer);
        ids.push((await h.run({ type: 'createLayer', comp, kind: 'image', source: still!, init: [] })).layer);
        ids.push((await h.run({ type: 'createLayer', comp, kind: 'audio', source: sound!, init: [] })).layer);
        ids.push((await h.run({ type: 'createLayer', comp, kind: 'precomp', source: inner, init: [] })).layer);
        for (const id of ids) await sweep(h, id, false, 0);
        for (const id of ids) await sweep(h, id, true, 1);
        await h.run({ type: 'setProperty', prop: P(ids[2]!, 'audio/levels'), value: v2(-6, 3), time: sec(2) }).catch(ignore);
        await h.run({ type: 'setExpression', prop: P(ids[2]!, 'audio/levels'), source: 'value - [time, time]', enabled: true }).catch(ignore);
        await h.run({ type: 'setTimeRemap', layer: ids[0]!, enabled: true }).catch(ignore);
        await sweep(h, ids[0]!, true, 0);
      },

      'properties: text animators with every selector kind, 2D and 3D, keyed and expressed': async (h) => {
        const comp = 'comp_root';
        const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
        const { layer: t3 } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T3', init: [] });
        await h.run({ type: 'setLayerSwitches', layers: [t3], patch: { threeD: true } });
        for (const layer of [t, t3]) {
          const a1 = await h.run({ type: 'addPropertyGroup', layer, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] }).catch(ignore);
          const a2 = await h.run({ type: 'addPropertyGroup', layer, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [], name: 'Second' }).catch(ignore);
          if (a1) await h.run({ type: 'addPropertyGroup', layer, parent: `${a1.groups[0]!}/selectors`, matchName: 'ADBE Text Expressible Selector', init: [] }).catch(ignore);
          if (a2) await h.run({ type: 'addPropertyGroup', layer, parent: `${a2.groups[0]!}/selectors`, matchName: 'ADBE Text Wiggly Selector', init: [] }).catch(ignore);
          if (a2) await h.run({ type: 'addPropertyGroup', layer, parent: `${a2.groups[0]!}/selectors`, matchName: 'ADBE Text Selector', init: [] }).catch(ignore);
        }
        for (const id of [t, t3]) await sweep(h, id, false, 0);
        for (const id of [t, t3]) await sweep(h, id, true, 1);
        const tree = await h.query({ type: 'getPropertyTree', layer: t, path: 'text', depth: 0 });
        const animProps = tree.nodes.filter((n) => n.kind === 'property' && n.path.startsWith('text/animators/') && n.valueType === 'scalar').map((n) => n.path);
        for (const [i, path] of animProps.slice(0, 6).entries()) await h.run({ type: 'setExpression', prop: P(t, path), source: `time * ${i + 1}`, enabled: true }).catch(ignore);
        await h.query({ type: 'getPropertyValues', props: animProps.map((path) => P(t, path)), time: sec(0.4), evaluated: true });
        if (animProps[0]) await h.run({ type: 'convertExpressionToKeyframes', prop: P(t, animProps[0]), range: { start: 0, duration: sec(0.3) }, step: 0 }).catch(ignore);
        await h.run({ type: 'undo' });
        await h.run({ type: 'redo' });
      },

      'properties: every shape operator and layer style, static then keyed': async (h) => {
        const comp = 'comp_root';
        const { layer: s } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'S', init: [] });
        const { layer: x } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'X', init: [] });
        for (const op of ['zigzag', 'roundCorners', 'pucker', 'twist', 'offset', 'roughen', 'trim', 'repeater', 'wiggleTransform', 'none', 'mystery']) {
          await h.run({ type: 'addPropertyGroup', layer: s, parent: 'contents', matchName: `pathop:${op}`, init: [] }).catch(ignore);
        }
        for (const style of ['glass', 'dropShadow', 'outerGlow', 'innerShadow', 'innerGlow', 'satin', 'bevel', 'colorOverlay', 'gradientOverlay', 'stroke']) {
          await h.run({ type: 'addPropertyGroup', layer: x, parent: 'styles', matchName: `style:${style}`, init: [] }).catch(ignore);
        }
        for (const id of [s, x]) await sweep(h, id, false, 0);
        for (const id of [s, x]) await sweep(h, id, true, 1);
      },

      'properties: set, reset, animate, separate, batches, gestures and every refusal': async (h) => {
        const comp = 'comp_root';
        const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
        const { layer: n } = await h.run({ type: 'createLayer', comp, kind: 'null', name: 'N', init: [] });
        const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
        const { layer: m } = await h.run({ type: 'createLayer', comp, kind: 'model3d', name: 'M', init: [] });
        // Refusals, in the TS engine's check order.
        await h.run({ type: 'setProperty', prop: P('nope', 'transform/position'), value: v2(1, 2) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, 'transform/nope'), value: v2(1, 2) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, 'transform/position'), value: scalar(1) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, 'transform/opacity'), value: v2(1, 2) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, 'transform/opacity'), value: { kind: 'color', value: { r: 1, g: 0, b: 0, a: 1 } } }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, 'transform/opacity'), value: { kind: 'string', value: 'x' } }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, 'transform/opacity'), value: { kind: 'bool', value: true } }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, 'transform/opacity'), value: { kind: 'int', value: 40 } }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, 'transform/position'), value: v3(1, 2, 3) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(m, 'transform/position'), value: v2(5, 6) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(t, 'text/sourceText'), value: scalar(1) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(t, 'text/sourceText'), value: { kind: 'string', value: 'Plain' } }).catch(ignore);
        await h.run({ type: 'setAnimated', prop: P(t, 'text/fontSize'), animated: true, time: 0 });
        await h.run({ type: 'setAnimated', prop: P(t, 'text/fontSize'), animated: true, time: sec(1) });
        // Static writes of each kind, then reset.
        await h.run({ type: 'setProperty', prop: P(a, 'transform/scale'), value: v2(250, 50) });
        await h.run({ type: 'setProperty', prop: P(a, 'transform/rotation'), value: scalar(-720.5) });
        await h.run({ type: 'setProperty', prop: P(m, 'transform/orientation'), value: v3(10, 20, 30) });
        await h.run({ type: 'setProperty', prop: P(m, 'transform/xRotation'), value: scalar(45) });
        await h.run({ type: 'setProperty', prop: P(m, 'transform/scale'), value: v3(10, 20, 30) });
        await h.run({ type: 'resetProperty', prop: P(a, 'transform/scale') }).catch(ignore);
        await h.run({ type: 'resetProperty', prop: P(a, 'transform/rotation') }).catch(ignore);
        await h.run({ type: 'resetProperty', prop: P(m, 'transform/orientation') }).catch(ignore);
        await h.run({ type: 'resetProperty', prop: P(t, 'text/sourceText') }).catch(ignore);
        await h.run({ type: 'resetProperty', prop: P(a, 'transform/nope') }).catch(ignore);
        // Animate / stop animating (value kept at the stop time), animated writes need a time.
        await h.run({ type: 'setAnimated', prop: P(a, 'transform/position'), animated: true, time: sec(0.5) });
        await h.run({ type: 'setAnimated', prop: P(a, 'transform/position'), animated: true, time: sec(1) });
        await h.run({ type: 'setProperty', prop: P(a, 'transform/position'), value: v2(1, 2) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, 'transform/position'), value: v2(700, 20), time: sec(2) });
        await h.run({ type: 'setProperty', prop: P(a, 'transform/position'), value: v2(710, 30), time: sec(2) });
        await h.run({ type: 'resetProperty', prop: P(a, 'transform/position'), time: sec(1) }).catch(ignore);
        await h.run({ type: 'resetProperty', prop: P(a, 'transform/position') }).catch(ignore);
        await h.run({ type: 'setAnimated', prop: P(a, 'transform/position'), animated: false, time: sec(1.25) });
        await h.run({ type: 'setAnimated', prop: P(a, 'transform/position'), animated: false, time: sec(1.25) });
        await h.run({ type: 'setAnimated', prop: P(t, 'text/sourceText'), animated: true, time: 0 });
        await h.run({ type: 'setProperty', prop: P(t, 'text/sourceText'), value: doc('Later'), time: sec(1) });
        await h.run({ type: 'setProperty', prop: P(t, 'text/sourceText'), value: doc('Now') }).catch(ignore);
        await h.run({ type: 'setAnimated', prop: P(t, 'text/sourceText'), animated: false, time: sec(1.5) });
        await h.run({ type: 'setAnimated', prop: P(a, 'transform/opacity'), animated: true, time: 0 });
        await h.run({ type: 'setProperty', prop: P(a, 'transform/opacity'), value: scalar(10), time: sec(1) });
        await h.run({ type: 'undo' });
        await h.run({ type: 'undo' });
        await h.run({ type: 'redo' });
        // Separate dimensions: separated position, its combined row, then merge.
        await h.run({ type: 'setDimensionsSeparated', layer: n, path: 'transform/scale', separated: true }).catch(ignore);
        await h.run({ type: 'setDimensionsSeparated', layer: 'nope', path: 'transform/position', separated: true }).catch(ignore);
        await h.run({ type: 'addKeyframes', keys: [{ prop: P(n, 'transform/position'), time: 0, value: v2(0, 0), spatialIn: [], spatialOut: [] }, { prop: P(n, 'transform/position'), time: sec(2), value: v2(200, 100), spatialIn: [], spatialOut: [] }] });
        await h.run({ type: 'setDimensionsSeparated', layer: n, path: 'transform/position', separated: true });
        await h.query({ type: 'getPropertyTree', layer: n, path: 'transform', depth: 0 });
        await h.run({ type: 'setProperty', prop: P(n, 'transform/position'), value: v2(3, 4) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(n, 'transform/position/x'), value: scalar(33), time: sec(1) });
        await h.run({ type: 'setProperty', prop: P(n, 'transform/position/y'), value: scalar(44), time: sec(0.5) });
        await h.run({ type: 'addKeyframes', keys: [{ prop: P(n, 'transform/position'), time: sec(3), spatialIn: [], spatialOut: [] }] }).catch(ignore);
        await h.query({ type: 'getKeyframes', props: [P(n, 'transform/position/x'), P(n, 'transform/position/y'), P(n, 'transform/position')] }).catch(ignore);
        await h.run({ type: 'setDimensionsSeparated', layer: n, path: 'transform/position', separated: false });
        await h.query({ type: 'getKeyframes', props: [P(n, 'transform/position')] });
        await h.run({ type: 'undo' });
        await h.run({ type: 'setDimensionsSeparated', layer: m, path: 'transform/position', separated: true });
        await h.run({ type: 'setProperty', prop: P(m, 'transform/position/z'), value: scalar(-50) });
        await h.run({ type: 'setDimensionsSeparated', layer: m, path: 'transform/position', separated: false });
        // setProperties: a batch of writes, one entry; empty refused; any failure refuses the whole.
        await h.run({ type: 'setProperties', writes: [] }).catch(ignore);
        await h.run({ type: 'setProperties', writes: [{ prop: P(a, 'transform/rotation'), value: scalar(5) }, { prop: P(a, 'transform/rotation'), value: scalar(6) }, { prop: P(n, 'transform/scale'), value: v2(50, 60) }] });
        await h.run({ type: 'setProperties', writes: [{ prop: P(a, 'transform/rotation'), value: scalar(7) }, { prop: P(a, 'transform/opacity'), value: scalar(8) }] }).catch(ignore);
        await h.run({ type: 'setProperties', writes: [{ prop: P(a, 'transform/opacity'), value: scalar(20), time: sec(1) }, { prop: P(a, 'transform/opacity'), value: scalar(30), time: sec(1) }] });
        // A gesture of animated writes, and a cancelled one.
        const { gesture } = await h.run({ type: 'beginGesture', label: 'Scrub Opacity' });
        for (let i = 0; i < 8; i++) await h.run({ type: 'setProperty', prop: P(a, 'transform/opacity'), value: scalar(10 * i), time: sec(0.5) });
        await h.run({ type: 'endGesture', gesture, commit: true });
        const g2 = (await h.run({ type: 'beginGesture', label: 'Esc' })).gesture;
        await h.run({ type: 'setProperty', prop: P(m, 'transform/xRotation'), value: scalar(90) });
        await h.run({ type: 'setProperty', prop: P(m, 'transform/xRotation'), value: scalar(91) });
        await h.run({ type: 'endGesture', gesture: g2, commit: false });
        await h.batch('Mixed', [
          { type: 'setProperty', prop: P(n, 'transform/rotation'), value: scalar(12) },
          { type: 'setAnimated', prop: P(n, 'transform/rotation'), animated: true, time: sec(1) },
          { type: 'resetProperty', prop: P(m, 'transform/scale') },
        ]);
        await h.batch('Refused', [
          { type: 'setProperty', prop: P(n, 'transform/rotation'), value: scalar(99) },
          { type: 'setProperty', prop: P(n, 'transform/nope'), value: scalar(99) },
        ]).catch(ignore);
        await h.run({ type: 'undo' });
        await h.run({ type: 'undo' });
        await h.run({ type: 'redo' });
      },

      'keyframes: add, update, move, scale, reverse, delete, paste — easing, bezier, spatial, roving, labels': async (h) => {
        const comp = 'comp_root';
        const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
        const { layer: b } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'B', init: [] });
        const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
        const { layer: l } = await h.run({ type: 'createLayer', comp, kind: 'light', name: 'L', init: [] });
        const masks: string[] = [];
        const pos = P(a, 'transform/position');
        // Refusals.
        await h.run({ type: 'addKeyframes', keys: [] }).catch(ignore);
        await h.run({ type: 'addKeyframes', keys: [{ prop: P(a, 'transform/nope'), time: 0, spatialIn: [], spatialOut: [] }] }).catch(ignore);
        await h.run({ type: 'addKeyframes', keys: [{ prop: pos, time: 0, value: scalar(3), spatialIn: [], spatialOut: [] }] }).catch(ignore);
        if (masks[0]) await h.run({ type: 'addKeyframes', keys: [{ prop: P(a, masks[0].replace(/path$/, 'inverted')), time: 0, spatialIn: [], spatialOut: [] }] }).catch(ignore);
        // Keys with every field: easing kinds, bezier, roving, spatial interp + tangents.
        const easings = ['linear', 'hold', 'bezier', 'ease', 'easeIn', 'easeOut', 'easeInOut', 'autoBezier', 'continuousBezier'] as const;
        const { ids } = await h.run({ type: 'addKeyframes', keys: easings.map((easing, i) => ({
          prop: pos, time: sec(i * 0.25), value: v2(100 + 40 * i, 200 + 15 * (i % 3)), easing,
          ...(easing === 'bezier' ? { bezier: { x1: 0.2, y1: 0, x2: 0.3, y2: 1 } } : {}),
          ...(i === 3 ? { roving: true } : {}),
          ...(i === 4 ? { spatialInterp: 'bezier' as const } : {}),
          spatialIn: i === 2 ? [5, -5] : [], spatialOut: i === 2 ? [-5, 5] : [],
        })) });
        // Absent value = the evaluated value there; an existing time keeps its id.
        await h.run({ type: 'addKeyframes', keys: [{ prop: pos, time: sec(0.1), spatialIn: [], spatialOut: [] }, { prop: pos, time: sec(0.25), spatialIn: [], spatialOut: [] }, { prop: P(a, 'transform/opacity'), time: sec(1), spatialIn: [], spatialOut: [] }, { prop: P(a, 'transform/scale'), time: sec(2), value: v2(50, 150), spatialIn: [], spatialOut: [] }] });
        await h.run({ type: 'addKeyframes', keys: [{ prop: P(t, 'text/sourceText'), time: 0, value: doc('One'), spatialIn: [], spatialOut: [] }, { prop: P(t, 'text/sourceText'), time: sec(1), spatialIn: [], spatialOut: [] }, { prop: P(t, 'text/sourceText'), time: sec(2), value: { kind: 'string', value: 'Three' }, easing: 'hold', spatialIn: [], spatialOut: [] }] });
        await h.run({ type: 'addKeyframes', keys: [{ prop: P(l, 'transform/orientation'), time: 0, value: v3(0, 90, 0), spatialIn: [], spatialOut: [] }, { prop: P(l, 'light/intensity'), time: sec(1), value: scalar(250), easing: 'easeOut', spatialIn: [], spatialOut: [] }, { prop: P(l, 'transform/scale'), time: sec(1), spatialIn: [], spatialOut: [] }] });
        const maskIds: string[] = [];
        for (const mp of masks) {
          const r = await h.run({ type: 'addKeyframes', keys: [{ prop: P(a, mp), time: 0, spatialIn: [], spatialOut: [] }, { prop: P(a, mp), time: sec(1), value: square(180), spatialIn: [], spatialOut: [] }] }).catch(ignore);
          if (r) maskIds.push(...r.ids);
        }
        const all = async () => (await h.query({ type: 'getKeyframes', props: [pos, P(a, 'transform/opacity'), P(a, 'transform/scale'), P(t, 'text/sourceText'), P(l, 'transform/orientation'), P(l, 'light/intensity'), ...masks.map((mp) => P(a, mp))] })).sets;
        await all();
        // updateKeyframes: every field, clears, retime by time, refusals.
        await h.run({ type: 'updateKeyframes', patches: [] }).catch(ignore);
        await h.run({ type: 'updateKeyframes', patches: [{ id: 'k999999', spatialIn: [], spatialOut: [] }] }).catch(ignore);
        await h.run({ type: 'updateKeyframes', patches: [{ id: ids[0]!, value: scalar(1), spatialIn: [], spatialOut: [] }] }).catch(ignore);
        await h.run({ type: 'updateKeyframes', patches: [
          { id: ids[0]!, value: v2(1, 2), easing: 'easeInOut', label: 3, spatialIn: [], spatialOut: [] },
          { id: ids[1]!, bezier: { x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 }, continuous: true, spatialIn: [1, 2], spatialOut: [3, 4] },
          { id: ids[2]!, clearBezier: true, clearSpatial: true, roving: true, spatialInterp: 'linear', spatialIn: [], spatialOut: [] },
          { id: ids[3]!, roving: false, label: 0, spatialInterp: 'legacy', spatialIn: [], spatialOut: [] },
          { id: ids[4]!, time: sec(3.5), easing: 'hold', spatialIn: [], spatialOut: [] },
          { id: ids[5]!, time: sec(0), spatialIn: [], spatialOut: [] },
        ] });
        if (maskIds[0]) await h.run({ type: 'updateKeyframes', patches: [{ id: maskIds[0], value: square(20), easing: 'easeIn', label: 2, spatialIn: [], spatialOut: [] }, { id: maskIds[1]!, time: sec(1.5), spatialIn: [], spatialOut: [] }] }).catch(ignore);
        const ks = await all();
        const textIds = ks[3]!.keyframes.map((k) => k.id);
        await h.run({ type: 'updateKeyframes', patches: [{ id: textIds[1]!, value: doc('Two!'), easing: 'linear', spatialIn: [], spatialOut: [] }, { id: textIds[0]!, value: scalar(4), spatialIn: [], spatialOut: [] }] }).catch(ignore);
        await h.run({ type: 'updateKeyframes', patches: [{ id: textIds[1]!, value: doc('Two!'), label: 5, spatialIn: [], spatialOut: [] }] });
        // move / scale / reverse across properties and layers.
        const now = await all();
        const posIds = now[0]!.keyframes.map((k) => k.id);
        await h.run({ type: 'moveKeyframes', ids: [], delta: sec(1) });
        await h.run({ type: 'moveKeyframes', ids: ['nope'], delta: sec(1) }).catch(ignore);
        await h.run({ type: 'moveKeyframes', ids: [posIds[1]!, posIds[2]!, posIds[2]!, textIds[0]!], delta: sec(0.3) });
        await h.run({ type: 'moveKeyframes', ids: [posIds[3]!], delta: -sec(0.75) });
        await h.run({ type: 'moveKeyframes', ids: [posIds[0]!], delta: sec(0.25) });
        if (maskIds[1]) await h.run({ type: 'moveKeyframes', ids: [maskIds[1], maskIds[3] ?? maskIds[1]], delta: sec(0.5) }).catch(ignore);
        await h.run({ type: 'scaleKeyframes', ids: posIds.slice(0, 5), pivot: sec(1), factor: 0 }).catch(ignore);
        await h.run({ type: 'scaleKeyframes', ids: posIds.slice(0, 5), pivot: sec(1), factor: -2 }).catch(ignore);
        await h.run({ type: 'scaleKeyframes', ids: posIds.slice(0, 5), pivot: sec(1), factor: 1.7 });
        await h.run({ type: 'scaleKeyframes', ids: [...posIds.slice(2), ...textIds], pivot: sec(0.1), factor: 0.37 });
        await h.run({ type: 'reverseKeyframes', ids: posIds });
        await h.run({ type: 'reverseKeyframes', ids: [...textIds, ...maskIds] }).catch(ignore);
        await h.run({ type: 'undo' });
        await h.run({ type: 'undo' });
        await h.run({ type: 'redo' });
        const after = await all();
        // paste onto another layer's property, onto itself (existing times keep ids), onto the wrong type.
        await h.run({ type: 'pasteKeyframes', prop: P(b, 'transform/position'), time: sec(1), keys: after[0]!.keyframes });
        await h.run({ type: 'pasteKeyframes', prop: P(b, 'transform/position'), time: sec(1), keys: after[0]!.keyframes.slice(0, 3) });
        await h.run({ type: 'pasteKeyframes', prop: P(b, 'transform/opacity'), time: 0, keys: after[0]!.keyframes }).catch(ignore);
        await h.run({ type: 'pasteKeyframes', prop: P(b, 'transform/opacity'), time: 0, keys: [] }).catch(ignore);
        await h.run({ type: 'pasteKeyframes', prop: P(b, 'transform/opacity'), time: sec(0.5), keys: after[1]!.keyframes });
        await h.run({ type: 'pasteKeyframes', prop: P(b, 'transform/scale'), time: sec(0.5), keys: after[2]!.keyframes });
        await h.run({ type: 'pasteKeyframes', prop: P(t, 'text/sourceText'), time: sec(4), keys: after[3]!.keyframes });
        if (masks[1] && after[6]) await h.run({ type: 'pasteKeyframes', prop: P(a, masks[1]), time: sec(2), keys: after[6].keyframes }).catch(ignore);
        // delete: partial, a whole property (the static value stays at the last key), refusals.
        await h.run({ type: 'deleteKeyframes', ids: [] }).catch(ignore);
        await h.run({ type: 'deleteKeyframes', ids: ['k424242'] }).catch(ignore);
        const fin = await all();
        await h.run({ type: 'deleteKeyframes', ids: [fin[0]!.keyframes[1]!.id, fin[0]!.keyframes[1]!.id, fin[4]!.keyframes[0]!.id] });
        await h.run({ type: 'deleteKeyframes', ids: fin[2]!.keyframes.map((k) => k.id) });
        await h.run({ type: 'deleteKeyframes', ids: fin[3]!.keyframes.map((k) => k.id) });
        await h.run({ type: 'deleteKeyframes', ids: fin[5]!.keyframes.map((k) => k.id) });
        if (fin[6]) await h.run({ type: 'deleteKeyframes', ids: fin[6].keyframes.map((k) => k.id) }).catch(ignore);
        await h.run({ type: 'undo' });
        await h.run({ type: 'redo' });
        await all();
        await h.query({ type: 'getKeyframes', props: [P(b, 'transform/position'), P(b, 'transform/opacity'), P(b, 'transform/scale')], range: { start: sec(0.5), duration: sec(1) } });
      },

      'properties and keyframes on masks: path, mode, inverted, feather, opacity, expansion, shape keys': async (h) => {
        const comp = 'comp_root';
        const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
        const { layer: b } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'B', init: [] });
        await h.run({ type: 'addMask', layer: a, mode: 'add', inverted: false, path: square(100).value });
        await h.run({ type: 'addMask', layer: a, mode: 'add', inverted: false, path: square(60).value });
        await h.run({ type: 'addMask', layer: b, mode: 'add', inverted: false, path: square(80).value });
        const masks = (await h.query({ type: 'getPropertyTree', layer: a, path: '', depth: 0 })).nodes.filter((x) => x.path.startsWith('masks/') && x.path.endsWith('/path')).map((x) => x.path);
        const bMask = (await h.query({ type: 'getPropertyTree', layer: b, path: '', depth: 0 })).nodes.find((x) => x.path.startsWith('masks/') && x.path.endsWith('/path'))!.path;
        const [m0, m1] = [masks[0]!, masks[1]!];
        const sib = (p: string, k: string): string => p.replace(/path$/, k);
        await h.run({ type: 'setProperty', prop: P(a, m0), value: scalar(1) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, sib(m0, 'mode')), value: { kind: 'choice', value: 'bogus' } }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, sib(m0, 'mode')), value: scalar(2) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, sib(m0, 'mode')), value: { kind: 'choice', value: 'subtract' } });
        await h.run({ type: 'setProperty', prop: P(a, sib(m0, 'inverted')), value: { kind: 'bool', value: true } });
        await h.run({ type: 'setProperty', prop: P(a, sib(m0, 'feather')), value: scalar(12) });
        await h.run({ type: 'setProperty', prop: P(a, sib(m0, 'opacity')), value: scalar(55) });
        await h.run({ type: 'setProperty', prop: P(a, sib(m1, 'expansion')), value: scalar(-4) });
        await h.run({ type: 'setAnimated', prop: P(a, sib(m0, 'mode')), animated: true, time: 0 }).catch(ignore);
        await h.run({ type: 'setAnimated', prop: P(a, m0), animated: true, time: 0 });
        await h.run({ type: 'setProperty', prop: P(a, m0), value: square(300) }).catch(ignore);
        await h.run({ type: 'setProperty', prop: P(a, m0), value: square(300), time: sec(2) });
        await h.run({ type: 'setProperty', prop: P(a, m1), value: square(33), time: sec(1) });
        await h.run({ type: 'setProperty', prop: P(a, sib(m0, 'mode')), value: { kind: 'choice', value: 'intersect' } });
        await h.run({ type: 'setProperty', prop: P(a, sib(m1, 'inverted')), value: { kind: 'bool', value: true } });
        const { ids } = await h.run({ type: 'addKeyframes', keys: [{ prop: P(a, m0), time: sec(0.5), spatialIn: [], spatialOut: [] }, { prop: P(a, m1), time: sec(1.5), value: square(180), easing: 'hold', spatialIn: [], spatialOut: [] }, { prop: P(a, sib(m0, 'feather')), time: sec(1), value: scalar(30), spatialIn: [], spatialOut: [] }] });
        const all = async () => (await h.query({ type: 'getKeyframes', props: [P(a, m0), P(a, m1), P(a, sib(m0, 'feather')), P(b, bMask)] })).sets;
        const k0 = await all();
        await h.run({ type: 'updateKeyframes', patches: [{ id: ids[0]!, value: square(20), easing: 'easeIn', label: 2, spatialIn: [], spatialOut: [] }, { id: ids[1]!, time: sec(2.5), bezier: { x1: 0, y1: 0, x2: 1, y2: 1 }, spatialIn: [], spatialOut: [] }] });
        await h.run({ type: 'updateKeyframes', patches: [{ id: ids[0]!, value: v2(1, 2), spatialIn: [], spatialOut: [] }] }).catch(ignore);
        await all();
        await h.run({ type: 'moveKeyframes', ids: [k0[0]!.keyframes[0]!.id, ids[1]!], delta: sec(0.5) }).catch(ignore);
        await h.run({ type: 'moveKeyframes', ids: [k0[0]!.keyframes[0]!.id], delta: sec(0.5) }).catch(ignore);
        await h.run({ type: 'scaleKeyframes', ids: k0[0]!.keyframes.map((k) => k.id), pivot: 0, factor: 0.5 }).catch(ignore);
        await h.run({ type: 'reverseKeyframes', ids: [...k0[0]!.keyframes.map((k) => k.id), ...k0[1]!.keyframes.map((k) => k.id)] }).catch(ignore);
        const k1 = await all();
        await h.run({ type: 'pasteKeyframes', prop: P(b, bMask), time: sec(1), keys: k1[0]!.keyframes });
        await h.run({ type: 'pasteKeyframes', prop: P(b, bMask), time: sec(1), keys: k1[2]!.keyframes }).catch(ignore);
        await h.run({ type: 'pasteKeyframes', prop: P(a, sib(m1, 'inverted')), time: sec(1), keys: k1[0]!.keyframes }).catch(ignore);
        await h.run({ type: 'setExpression', prop: P(a, m0), source: 'value', enabled: true }).catch(ignore);
        await h.run({ type: 'setExpression', prop: P(a, sib(m0, 'feather')), source: 'time * 10', enabled: true });
        await h.query({ type: 'getPropertyValues', props: [P(a, m0), P(a, m1), P(a, sib(m0, 'feather')), P(a, sib(m0, 'mode'))], time: sec(0.75), evaluated: true });
        await h.run({ type: 'deleteKeyframes', ids: [k1[0]!.keyframes[0]!.id] });
        await h.run({ type: 'setAnimated', prop: P(a, m0), animated: false, time: sec(1) });
        await h.run({ type: 'deleteKeyframes', ids: k1[1]!.keyframes.map((k) => k.id) }).catch(ignore);
        await h.run({ type: 'undo' });
        await h.run({ type: 'deleteKeyframes', ids: k1[1]!.keyframes.map((k) => k.id) }).catch(ignore);
        await h.run({ type: 'undo' });
        await h.run({ type: 'undo' });
        await h.run({ type: 'redo' });
        await all();
      },

      'expressions: set, invalid, enable, link, bake — thisComp, thisLayer, time, wiggle, valueAtTime, ctrl': async (h) => {
        const comp = 'comp_root';
        const { layer: a } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
        const { layer: b } = await h.run({ type: 'createLayer', comp, kind: 'shape', name: 'B', init: [] });
        const { layer: n } = await h.run({ type: 'createLayer', comp, kind: 'null', name: 'Ctl', init: [] });
        const { layer: t } = await h.run({ type: 'createLayer', comp, kind: 'text', name: 'T', init: [] });
        await h.run({ type: 'addKeyframes', keys: [
          { prop: P(b, 'transform/position'), time: 0, value: v2(100, 100), spatialIn: [], spatialOut: [] },
          { prop: P(b, 'transform/position'), time: sec(2), value: v2(500, 300), easing: 'easeInOut', spatialIn: [], spatialOut: [] },
          { prop: P(b, 'transform/rotation'), time: 0, value: scalar(0), spatialIn: [], spatialOut: [] },
          { prop: P(b, 'transform/rotation'), time: sec(1), value: scalar(90), spatialIn: [], spatialOut: [] },
        ] });
        const ex = (layer: string, path: string, source: string, enabled = true) => h.run({ type: 'setExpression', prop: P(layer, path), source, enabled }).catch(ignore);
        await ex(a, 'transform/rotation', 'time * 30');
        await ex(a, 'transform/position', '[thisComp.width / 2, thisComp.height / 2 + time * 10]');
        await ex(a, 'transform/opacity', 'wiggle(2, 20)');
        await ex(a, 'transform/scale', '[thisLayer.width / 10, thisComp.numLayers * 10]');
        await ex(a, 'transform/anchorPoint', 'thisComp.layer("B").transform.position.valueAtTime(time - 0.5)');
        await ex(n, 'transform/rotation', 'ctrl("Speed") + thisComp.duration + thisComp.frameDuration');
        await ex(n, 'transform/position', 'value + [Math.sin(time) * 100, 0]');
        await ex(n, 'transform/scale', 'thisComp.layer("B").transform.rotation.value');
        await ex(b, 'transform/opacity', 'thisComp.layer("Missing").transform.opacity');
        await ex(b, 'transform/scale', 'this is ( not valid');
        await ex(b, 'transform/anchorPoint', '[1, 2', false);
        await ex(t, 'transform/rotation', 'linear(time, 0, 1, 0, 360)');
        await ex(t, 'text/sourceText', '"Frame " + timeToFrames(time)');
        await ex(t, 'transform/opacity', 'loopOut()');
        await ex(a, 'transform/nope', 'time');
        await ex('nope', 'transform/rotation', 'time');
        const all = [a, b, n, t].flatMap((layer) => ['transform/position', 'transform/rotation', 'transform/scale', 'transform/opacity', 'transform/anchorPoint'].map((path) => P(layer, path)));
        for (const time of [0, sec(0.25), sec(1), sec(1.5)]) {
          await h.query({ type: 'getPropertyValues', props: all.filter((p) => p.layer !== n || p.path !== 'transform/opacity'), time, evaluated: true }).catch(ignore);
          await h.query({ type: 'getPropertyValues', props: all.filter((p) => p.layer !== n || p.path !== 'transform/opacity'), time, evaluated: false }).catch(ignore);
        }
        await h.query({ type: 'getPropertyTree', layer: a, path: 'transform', depth: 0 });
        await h.query({ type: 'getPropertyTree', layer: b, path: 'transform', depth: 0 });
        // Enable/disable, refusals.
        await h.run({ type: 'setExpressionEnabled', props: [], enabled: false }).catch(ignore);
        await h.run({ type: 'setExpressionEnabled', props: [P(n, 'transform/opacity')], enabled: false }).catch(ignore);
        await h.run({ type: 'setExpressionEnabled', props: [P(b, 'transform/rotation')], enabled: false }).catch(ignore);
        await h.run({ type: 'setExpressionEnabled', props: [P(a, 'transform/rotation'), P(a, 'transform/position')], enabled: false });
        await h.run({ type: 'setExpressionEnabled', props: [P(b, 'transform/scale')], enabled: true });
        await h.run({ type: 'setExpressionEnabled', props: [P(a, 'transform/rotation')], enabled: true });
        await h.run({ type: 'undo' });
        await h.run({ type: 'redo' });
        // Link (pick whip) and its refusals.
        await h.run({ type: 'linkProperty', prop: P(n, 'transform/anchorPoint'), target: P(b, 'transform/position') });
        await h.run({ type: 'linkProperty', prop: P(n, 'transform/opacity'), target: P(b, 'transform/rotation') }).catch(ignore);
        await h.run({ type: 'linkProperty', prop: P(t, 'transform/scale'), target: P(b, 'transform/rotation') }).catch(ignore);
        await h.run({ type: 'linkProperty', prop: P(t, 'text/sourceText'), target: P(b, 'transform/rotation') }).catch(ignore);
        await h.run({ type: 'linkProperty', prop: P(t, 'transform/rotation'), target: P('nope', 'transform/rotation') }).catch(ignore);
        await h.run({ type: 'linkProperty', prop: P(t, 'transform/rotation'), target: P(b, 'transform/rotation') });
        // Bake: ranges, steps, refusals.
        await h.run({ type: 'convertExpressionToKeyframes', prop: P(b, 'transform/position'), step: 0 }).catch(ignore);
        await h.run({ type: 'convertExpressionToKeyframes', prop: P(t, 'text/sourceText'), step: 0 }).catch(ignore);
        await h.run({ type: 'convertExpressionToKeyframes', prop: P(a, 'transform/rotation'), range: { start: sec(5), duration: 0 }, step: 0 }).catch(ignore);
        await h.run({ type: 'convertExpressionToKeyframes', prop: P(a, 'transform/rotation'), range: { start: 0, duration: sec(1) }, step: sec(0.2) });
        await h.run({ type: 'convertExpressionToKeyframes', prop: P(a, 'transform/opacity'), range: { start: sec(0.5), duration: sec(0.5) }, step: 0 });
        await h.run({ type: 'convertExpressionToKeyframes', prop: P(n, 'transform/anchorPoint'), step: sec(1) });
        await h.run({ type: 'undo' });
        await h.run({ type: 'redo' });
        // Remove (blank source) and replace.
        await ex(n, 'transform/rotation', '   ');
        await ex(n, 'transform/scale', '[time * 100, 50]');
        await ex(b, 'transform/rotation', 'value * 2');
        for (const time of [0, sec(0.5), sec(1)]) await h.query({ type: 'getPropertyValues', props: all.filter((p) => p.layer !== n || p.path !== 'transform/opacity'), time, evaluated: true }).catch(ignore);
      },
    };
  })(),
  'B3: paint strokes — add (Write On keys), patch, Shift-continue, Path stopwatch + keyed replace, remove, Paint on Transparent — save → open': async (h) => {
    const comp = 'comp_root';
    const ignore = (): undefined => undefined;
    const { layer: v } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'Plate', init: [] });
    const pts = (...xy: number[]) => Array.from({ length: xy.length / 2 }, (_, i) => ({ x: xy[2 * i]!, y: xy[2 * i + 1]! }));
    const add = async (stroke: object, keys: Array<{ param: string; time: number; value: number }> = []) =>
      (await h.run({ type: 'addPaintStroke', layer: v, stroke: JSON.stringify(stroke), keys })).stroke;
    const a = await add({ points: pts(0, 0, 10, 0, 20, 5), color: '#ff8000', size: 14, opacity: 0.8, hardness: 0.5, spacing: 0.25, pressure: [0.2, 0.6, 1], inPoint: 0 },
      [{ param: 'end', time: 0, value: 0 }, { param: 'end', time: 1 / 30, value: 55.5 }, { param: 'end', time: 2 / 30, value: 100 }]);
    const e = await add({ points: pts(5, 5, 6, 6), mode: 'erase', eraseMode: 'lastStroke', eraseTargetId: a, inPoint: 0.5, outPoint: 0.5 + 1 / 30 });
    await add({ points: pts(1, 1), mode: 'clone', cloneOffsetX: 40, cloneOffsetY: -3, cloneAligned: true, cloneTimeShift: -0.5, cloneLockTime: true });
    await h.query({ type: 'getPropertyTree', layer: v, path: '', depth: 0 });
    await h.run({ type: 'addPaintStroke', layer: v, stroke: JSON.stringify({ id: 'x', points: pts(0, 0) }), keys: [] }).catch(ignore);
    await h.run({ type: 'addPaintStroke', layer: v, stroke: JSON.stringify({ points: [] }), keys: [] }).catch(ignore);
    // The video switch, a renormalising patch, Shift-continue with padded pen input.
    await h.run({ type: 'updatePaintStroke', layer: v, stroke: a, patch: JSON.stringify({ visible: false, hardness: 7, name: 'Swoosh' }) });
    await h.run({ type: 'updatePaintStroke', layer: v, stroke: a, patch: JSON.stringify({ visible: null }) });
    await h.run({ type: 'updatePaintStroke', layer: v, stroke: e, patch: JSON.stringify({ points: pts(5, 5, 6, 6, 9, 9), pressure: [1, 1, 0.4] }) });
    await h.run({ type: 'updatePaintStroke', layer: v, stroke: 'nope', patch: '{}' }).catch(ignore);
    await h.run({ type: 'setProperty', prop: { layer: v, path: `paint/${a}/opacity` }, value: scalar(40), time: sec(1) }).catch(ignore);
    // Path: static replace, the stopwatch, a keyed replace, stopwatch off (undone).
    await h.run({ type: 'setPaintStrokePath', layer: v, stroke: a, points: JSON.stringify(pts(0, 0, 30, 30)), time: 0 });
    await h.run({ type: 'setPaintPathAnimated', layer: v, stroke: a, animated: true, time: 0 });
    await h.run({ type: 'setPaintStrokePath', layer: v, stroke: a, points: JSON.stringify(pts(3, 3, 33, 33, 60, 0)), time: sec(1) });
    await h.run({ type: 'setPaintStrokePath', layer: v, stroke: a, points: JSON.stringify(pts(4, 4)), time: sec(1) });
    await h.run({ type: 'setPaintPathAnimated', layer: v, stroke: a, animated: false, time: 0 });
    await h.run({ type: 'undo' });
    await h.query({ type: 'getPropertyTree', layer: v, path: '', depth: 0 });
    // Paint on Transparent, then remove (with the tracks), undo, redo.
    await h.run({ type: 'setPaintOnTransparent', layers: [v], on: true });
    await h.run({ type: 'removePaintStrokes', layer: v, strokes: [a, e] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'removePaintStrokes', layer: v, strokes: [] }).catch(ignore);
    await h.run({ type: 'saveProject', path: 'C:/p/b3paint.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'openProject', path: 'C:/p/b3paint.motion' });
    await h.query({ type: 'getPropertyTree', layer: v, path: '', depth: 0 });
  },

  'B3z-a: effects — compositing options, pasteEffects, keyed-shape mask settings, per-vertex feather, Glass, style switches — save → open': async (h) => {
    const comp = 'comp_root';
    const ignore = (): undefined => undefined;
    const P = (layer: string, path: string) => ({ layer, path });
    const str = (value: string) => ({ kind: 'string' as const, value });
    const choice = (value: string) => ({ kind: 'choice' as const, value });
    const bool = (value: boolean) => ({ kind: 'bool' as const, value });
    const color = (r: number, g: number, b: number) => ({ kind: 'color' as const, value: { r, g, b, a: 1 } });
    const path = (vertices: number[], featherPoints: Array<{ segment: number; t: number; radius: number; tension: number }> = []) =>
      ({ kind: 'path' as const, value: { vertices, inTangents: [], outTangents: [], closed: true, featherPoints } });
    const square = [0, 0, 100, 0, 100, 100, 0, 100];
    const { layer: A } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'A', init: [] });
    const { layer: B } = await h.run({ type: 'createLayer', comp, kind: 'solid', name: 'B', init: [] });
    const { groups: [fx] } = await h.run({ type: 'addEffect', layers: [A], effect: 'gaussian-blur', params: [] });
    await h.query({ type: 'getPropertyTree', layer: A, path: '', depth: 0 });
    // Effect Opacity: listed on every effect; static = Effect.opacity (cleared at >= 100), keyed on effect.<id>.fx.opacity.
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/opacity`), value: scalar(40) });
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/opacity`), value: scalar(100) });
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/opacity`), value: scalar(-20) });
    await h.run({ type: 'setAnimated', prop: P(A, `${fx}/compositing/opacity`), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/opacity`), value: scalar(80), time: sec(1) });
    await h.run({ type: 'setAnimated', prop: P(A, `${fx}/compositing/opacity`), animated: false, time: sec(0.5) });
    await h.run({ type: 'resetProperty', prop: P(A, `${fx}/compositing/opacity`) }).catch(ignore);
    await h.run({ type: 'undo' });
    // Effect Mask and label colour.
    const { groups: [m1] } = await h.run({ type: 'addMask', layer: A, path: path(square).value, mode: 'none', inverted: false });
    const mid = m1!.split('/')[1]!;
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/mask`), value: str(mid) });
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/mask`), value: str('mask_ghost') }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/mask`), value: scalar(1) }).catch(ignore);
    await h.run({ type: 'setAnimated', prop: P(A, `${fx}/compositing/mask`), animated: true, time: 0 }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/label`), value: str('#5282b8') });
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/label`), value: str('red') }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/label`), value: str('') });
    await h.run({ type: 'setProperty', prop: P(A, `${fx}/compositing/label`), value: str('#d0705a') });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    // pasteEffects: a captured snapshot with keys, switch, compositing options and a label.
    const captured = JSON.stringify([
      {
        effect: { id: 'fx_src', type: 'gaussian-blur', params: { blurriness: 12 }, enabled: false, opacity: 50, maskId: mid, labelColor: '#4ea885' },
        tracks: {
          blurriness: [{ t: 1, value: 30, easing: 'easeIn', bezier: [0.3, 0, 0.7, 1], id: 'k99' }, { t: 0, value: 10, label: 2, roving: false }],
          'fx.opacity': [{ t: 0.5, value: 50, easing: 'nope', spatialInterp: 'auto' }],
          empty: [],
        },
        sourceNodeId: 'layer_gone',
      },
      { effect: { type: 'fill', params: { color: '#ff0000' } } },
    ]);
    await h.run({ type: 'pasteEffects', layers: [A, B], effects: captured, index: 0 });
    await h.run({ type: 'pasteEffects', layers: [B], effects: captured });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'pasteEffects', layers: [A], effects: '[]' }).catch(ignore);
    await h.run({ type: 'pasteEffects', layers: [A], effects: 'nope' }).catch(ignore);
    await h.run({ type: 'pasteEffects', layers: [A], effects: '[{"effect":{}}]' }).catch(ignore);
    await h.run({ type: 'pasteEffects', layers: [A], effects: '[{"effect":{"type":"fill"},"tracks":{"a":[{"t":"x","value":1}]}}]' }).catch(ignore);
    await h.run({ type: 'pasteEffects', layers: [A], effects: '[{"effect":{"type":"fill"},"tracks":[]}]' }).catch(ignore);
    await h.run({ type: 'pasteEffects', layers: [A], effects: captured, index: 99 }).catch(ignore);
    await h.run({ type: 'pasteEffects', layers: [], effects: captured }).catch(ignore);
    await h.run({ type: 'pasteEffects', layers: ['ghost'], effects: captured }).catch(ignore);
    // Feather / Opacity / Expansion on a keyed-shape mask hold across every shape key.
    await h.run({ type: 'setAnimated', prop: P(A, `${m1}/path`), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(A, `${m1}/path`), value: path([0, 0, 200, 0, 200, 200, 0, 200]), time: sec(1) });
    await h.run({ type: 'setProperty', prop: P(A, `${m1}/feather`), value: scalar(12) });
    await h.run({ type: 'setProperty', prop: P(A, `${m1}/opacity`), value: scalar(40) });
    await h.run({ type: 'setProperty', prop: P(A, `${m1}/expansion`), value: scalar(-3) });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    // Per-vertex feather (BezierPath.featherPoints): set, keep (empty list), clear (negative marker), refusals.
    await h.run({ type: 'setProperty', prop: P(A, `${m1}/path`), value: path(square, [{ segment: 1, t: 0, radius: 8, tension: 0 }, { segment: 3, t: 0, radius: 2.5, tension: 0 }]), time: sec(1) });
    await h.run({ type: 'setProperty', prop: P(A, `${m1}/path`), value: path([0, 0, 110, 0, 110, 110, 0, 110]), time: sec(1) });
    await h.run({ type: 'setProperty', prop: P(A, `${m1}/path`), value: path(square, [{ segment: 3, t: 0, radius: -1, tension: 0 }]), time: sec(1) });
    await h.run({ type: 'setProperty', prop: P(A, `${m1}/path`), value: path(square, [{ segment: 1, t: 0.5, radius: 8, tension: 0 }]), time: sec(1) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(A, `${m1}/path`), value: path(square, [{ segment: 9, t: 0, radius: 8, tension: 0 }]), time: sec(1) }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(A, `${m1}/path`), value: path(square, [{ segment: 1, t: 0, radius: 8, tension: 0 }, { segment: 1, t: 0, radius: 4, tension: 0 }]), time: sec(1) }).catch(ignore);
    const { groups: [m2] } = await h.run({ type: 'addMask', layer: B, path: path(square, [{ segment: 2, t: 0, radius: 6, tension: 0 }]).value, mode: 'add', inverted: false });
    await h.run({ type: 'setProperty', prop: P(B, `${m2}/path`), value: path([0, 0, 90, 0, 90, 90, 0, 90]) });
    await h.query({ type: 'getPropertyValues', props: [P(A, `${m1}/path`), P(B, `${m2}/path`)], time: sec(1), evaluated: false });
    // Layer styles: Glass as a first-class style, the switches, a bound-angle edit as one batch.
    for (const key of ['glass', 'bevel', 'stroke', 'dropShadow', 'satin']) {
      await h.run({ type: 'addPropertyGroup', layer: A, parent: 'styles', matchName: `style:${key}`, init: [] });
    }
    await h.run({ type: 'setProperty', prop: P(A, 'styles/glass/blur'), value: scalar(40) });
    await h.run({ type: 'setProperty', prop: P(A, 'styles/glass/tintColor'), value: color(1, 0.5, 0) });
    await h.run({ type: 'setAnimated', prop: P(A, 'styles/glass/rimAngle'), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(A, 'styles/glass/rimAngle'), value: scalar(90), time: sec(1) });
    await h.run({ type: 'setAnimated', prop: P(A, 'styles/glass/rimColor'), animated: true, time: 0 });
    await h.run({ type: 'setProperty', prop: P(A, 'styles/glass/tintOpacity'), value: scalar(0.4) });
    await h.run({ type: 'setProperty', prop: P(A, 'styles/glass/useGlobalLight'), value: bool(false) });
    await h.run({ type: 'setProperty', prop: P(A, 'styles/bevel/direction'), value: choice('down') });
    await h.run({ type: 'setProperty', prop: P(A, 'styles/bevel/direction'), value: choice('sideways') }).catch(ignore);
    await h.run({ type: 'setProperty', prop: P(A, 'styles/stroke/position'), value: choice('center') });
    await h.run({ type: 'setProperty', prop: P(A, 'styles/satin/invert'), value: bool(true) });
    await h.batch('Set Angle', [
      { type: 'setProperty', prop: P(A, 'styles/dropShadow/useGlobalLight'), value: bool(false) },
      { type: 'setProperty', prop: P(A, 'styles/dropShadow/angle'), value: scalar(30) },
    ]);
    await h.run({ type: 'setProperty', prop: P(B, 'styles/satin/invert'), value: bool(true) }).catch(ignore);
    await h.run({ type: 'copyPropertyGroups', groups: [P(A, 'styles/glass')], toLayers: [B] });
    await h.run({ type: 'removePropertyGroups', groups: [P(A, 'styles/glass')] });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'undo' });
    for (const id of [A, B]) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
    // Persist.
    await h.run({ type: 'saveProject', path: 'C:/p/b3za.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'openProject', path: 'C:/p/b3za.motion' });
    for (const id of [A, B]) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
  },

  'B3z WS-L1: builder fragments — text preset, shape, Lottie, camera + light, a matte rig, a motion graphic — into the comp and into a group, save → open': async (h) => {
    const s = await buildScene(h);
    // The editor's inserts: a legacy builder runs off-document, its layers travel as ONE
    // pasteLayers fragment (offDocument.ts) — the bytes are recorded in the log, so both
    // engines paste exactly what the builder produced.
    const built = (build: () => unknown) => {
      const b = buildLayerFragment(s.comp, build);
      if (!b) throw new Error('the builder added no layers');
      return b;
    };
    const paste = async (b: ReturnType<typeof built>, extra: Record<string, unknown> = {}) =>
      (await h.run({ type: 'pasteLayers', comp: s.comp, fragment: b.fragment, index: b.index, ...extra } as Command)) as { layers: string[] };
    const text = await paste(built(() => insertText('Title', 96, 800, { fill: '#ff3366', letterSpacing: 4 })));
    const star = await paste(built(() => insertShape('star', 'Star')));
    const lottie = await paste(built(() => buildLottieItem(LOTTIE_ITEMS[0]!.id, 400, 300)));
    const cam = await paste(built(() => insertCamera({ name: 'Cam', focalLength: 1500, twoNode: true })));
    const light = await paste(built(() => insertLight({ name: 'Key', type: 'spot', intensity: 80, color: '#ff8800', coneAngle: 30, ambientFill: false })));
    // A rig whose fill is track-matted by its own matte layer: the reference follows the copies.
    const rigFrag = built(() => {
      insertShape('rect', 'Matte');
      const matte = useSelectionStore.getState().ids[0]!;
      insertText('Matted');
      setNodeMatte(useSelectionStore.getState().ids[0]!, { mode: 'luma', inverted: true, sourceId: matte });
    });
    const rig = await paste(rigFrag);
    const mg = await paste(built(() => buildMographItem(MOGRAPH_ITEMS[0]!.id, 500, 500)));
    // Into a group (pasteLayers `parent`), deeper in the stack.
    const { layer: G } = await h.run({ type: 'groupLayers', layers: [s.P], name: 'Holder' });
    const inG = await paste(rigFrag, { parent: G, index: 1 });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    await h.run({ type: 'undo' });
    await h.run({ type: 'redo' });
    const all = [text, star, lottie, cam, light, rig, mg, inG].flatMap((r) => r.layers);
    for (const id of all) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
    await h.run({ type: 'saveProject', path: 'C:/p/wsl1.motion', copy: false });
    await h.run({ type: 'newProject' });
    await h.run({ type: 'openProject', path: 'C:/p/wsl1.motion' });
    for (const id of all) await h.query({ type: 'getPropertyTree', layer: id, path: '', depth: 0 });
  },
};

// ─── The generated corpus (D1b) ──────────────────────────────────────────────
// Seeded random sessions over EVERY edit command family: each step reads the
// document back (getDocument with trees, keyframes and markers — itself
// replayed and compared), then issues a command built from what is really
// there (valid ids, values of the property's own type, the property's own
// choices), sometimes inside a gesture or a batch, sometimes undone/redone.
// Refusals are part of the corpus: both engines must refuse identically.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  constructor(private readonly r: () => number) {}
  int(n: number): number { return Math.floor(this.r() * n); }
  coin(p = 0.5): boolean { return this.r() < p; }
  pick<T>(xs: readonly T[]): T | undefined { return xs.length ? xs[this.int(xs.length)] : undefined; }
  some<T>(xs: readonly T[], max = 3): T[] {
    const pool = [...xs];
    const out: T[] = [];
    const n = 1 + this.int(Math.max(1, Math.min(max, pool.length)));
    for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(this.int(pool.length), 1)[0]!);
    return out;
  }
  /** A frame-aligned time (30 fps) in [0, maxFrames). */
  time(maxFrames = 150): number { return sec(this.int(maxFrames) / 30); }
  /** A frame-aligned signed delta. */
  delta(maxFrames = 30): number { return sec((this.int(2 * maxFrames + 1) - maxFrames) / 30); }
  num(lo: number, hi: number, step = 0.5): number { return lo + Math.round((this.r() * (hi - lo)) / step) * step; }
}

interface Prop { layer: string; info: PropertyInfo }
interface World {
  comps: string[];
  layers: LayerInfo[];
  props: Prop[];
  groups: Prop[];
  keys: Array<{ layer: string; path: string; id: string }>;
  keySets: KeyframeSet[];
  markers: Marker[];
  footage: string[];
  compItems: string[];
  folders: string[];
  items: string[];
  renderItems: string[];
}

const GROUP_PATH = /^(effects|masks|contents|styles)\/[^/]+$|^text\/animators\/[^/]+(\/selectors\/[^/]+)?$|^(puppet|skeleton)$|^puppet\/pins\/[^/]+$|^skeleton\/(bones|controllers)\/[^/]+$|^skeleton\/bones\/[^/]+\/ik$/;

async function observe(h: Harness): Promise<World> {
  const doc = await h.query({ type: 'getDocument', includeProperties: true, includeKeyframes: true });
  const props: Prop[] = [];
  const groups: Prop[] = [];
  for (const t of doc.propertyTrees) {
    for (const n of t.nodes) {
      if (n.kind === 'property') props.push({ layer: t.layer, info: n });
      else if (GROUP_PATH.test(n.path)) groups.push({ layer: t.layer, info: n });
    }
  }
  return {
    props, groups,
    keys: doc.keyframes.flatMap((s) => s.keyframes.map((k) => ({ layer: s.prop.layer, path: s.prop.path, id: k.id }))),
    keySets: doc.keyframes,
    markers: [...doc.comps.flatMap((c) => c.markers), ...doc.layers.flatMap((l) => l.markers)],
    comps: doc.comps.map((c) => c.id),
    layers: doc.layers,
    footage: doc.items.filter((i) => i.kind === 'footage').map((i) => i.id),
    compItems: doc.items.filter((i) => i.kind === 'composition').map((i) => i.id),
    folders: doc.items.filter((i) => i.kind === 'folder').map((i) => i.id),
    items: doc.items.map((i) => i.id),
    renderItems: doc.renderQueue.map((r) => r.id),
  };
}

const EXPRESSIONS_SCALAR = ['time * 30', 'value + 10', 'value * 0.5', 'Math.sin(time * 2) * 20 + value', 'index * 5', 'thisComp.width / 100'];
const EXPRESSIONS_ANY = ['value', 'valueAtTime(time - 0.5)', 'loopOut()'];
const GENERATED_SAVE = 'C:/p/generated.motion';
const FILES = ['C:/g/a.mp4', 'C:/g/b.png', 'C:/g/c.wav', 'C:/g/d.mp4', 'C:/g/e.jpg'];
const FOOTAGE_KINDS: Partial<Record<string, true>> = { image: true, video: true, audio: true, sequence: true, svg: true };
const EFFECT_TYPES = EFFECT_DEFS.map((d) => d.type as string);
const PRESET_NAMES = listPresets().map((p) => p.name);
const STYLE_KEYS = Object.keys(LAYER_STYLE_LABEL);
const PATH_OP_TYPES = PATH_OP_CATALOG.map((p) => p.type as string);

function tweak(g: Gen, info: PropertyInfo, w: World): Value | undefined {
  const v = info.value;
  if (!v) return undefined;
  const clamp = (x: number) => Math.min(info.max ?? Infinity, Math.max(info.min ?? -Infinity, x));
  switch (v.kind) {
    case 'scalar': return { kind: 'scalar', value: clamp(v.value + g.num(-20, 20)) };
    case 'int': return { kind: 'int', value: clamp(v.value + 1) };
    case 'vec2': return { kind: 'vec2', value: { x: v.value.x + g.num(-50, 50), y: v.value.y + g.num(-50, 50) } };
    case 'vec3': return { kind: 'vec3', value: { x: v.value.x + g.num(-50, 50), y: v.value.y + g.num(-50, 50), z: v.value.z + g.num(-50, 50) } };
    case 'vec4': return { kind: 'vec4', value: { x: v.value.x + g.num(-5, 5), y: v.value.y + g.num(-5, 5), z: v.value.z + g.num(-5, 5), w: v.value.w + g.num(-5, 5) } };
    case 'color': return { kind: 'color', value: { r: g.num(0, 1, 0.125), g: g.num(0, 1, 0.125), b: g.num(0, 1, 0.125), a: 1 } };
    case 'bool': return { kind: 'bool', value: !v.value };
    case 'choice': return { kind: 'choice', value: g.pick(info.choices) ?? v.value };
    case 'string': return { kind: 'string', value: `s${g.int(100)}` };
    case 'textDocument': return { kind: 'textDocument', value: { ...v.value, text: `${v.value.text}${g.int(10)}` } };
    case 'scalars': return { kind: 'scalars', value: { values: g.some([1, 2, 3, 5, 8, 13, 20], 3).sort((a, b) => a - b) } };
    case 'path': return { kind: 'path', value: { ...v.value, vertices: v.value.vertices.map((x) => x + g.num(-10, 10)) } };
    case 'layer': return { kind: 'layer', value: g.pick(w.layers.map((l) => l.id)) ?? '' };
    case 'json': {
      // B3z: a json field (a layer config, a paint): clear it, empty a list, or stamp a key on an object.
      let cur: unknown;
      try { cur = JSON.parse(v.value); } catch { cur = null; }
      if (g.coin(0.2)) return { kind: 'json', value: 'null' };
      if (Array.isArray(cur)) return { kind: 'json', value: JSON.stringify(g.coin() ? [] : cur) };
      const base = cur && typeof cur === 'object' ? cur as Record<string, unknown> : {};
      return { kind: 'json', value: JSON.stringify({ ...base, seed: g.int(9) }) };
    }
    case 'none': return undefined;
    default: return v;
  }
}

const animatable = (w: World) => w.props.filter((p) => p.info.animatable && p.info.value && p.info.value.kind !== 'none');
/** G1: the static (non-animatable) fields — choices, switches, strings, colours, numbers, lists. */
const staticFields = (w: World) => w.props.filter((p) => !p.info.animatable && p.info.value && ['choice', 'bool', 'string', 'scalar', 'color', 'scalars', 'json'].includes(p.info.value.kind));
/** G1: what Add ▸ Property offers a text animator. */
const OPTIONAL_NAMES = ['anchorX', 'anchorY', 'anchorZ', 'skewAxis', 'lineAnchor', 'characterValue', 'fillHue', 'strokeOpacity', 'color', 'strokeColor', 'axisGRAD', 'axisopsz', 'axisXTRA', 'nope'];
const OPTIONAL_PROP = /^text\/animators\/[^/]+\/props\/(anchor[XYZ]|skewAxis|lineAnchor|characterValue|fill(Hue|Saturation|Brightness)|stroke(Opacity|Hue|Saturation|Brightness|Color)|color|axis[A-Za-z0-9]{4})$/;
const layersOf = (w: World, comp: string) => w.layers.filter((l) => l.comp === comp);
const ids = (ls: readonly LayerInfo[]) => ls.map((l) => l.id);
/** Several layers of ONE composition. */
function sameComp(g: Gen, w: World, max = 3): string[] {
  const l = g.pick(w.layers);
  return l ? g.some(ids(layersOf(w, l.comp)), max) : [];
}
const ref = (p: Prop) => ({ layer: p.layer, path: p.info.path });
const compOf = (w: World, layer: string | undefined) => w.layers.find((l) => l.id === layer)?.comp;

type Built = Command | undefined;
type Builder = (g: Gen, w: World, h: Harness) => Built | Promise<Built>;

/** One builder per edit command (plus setProjectSettings). */
const BUILDERS: Record<string, Builder> = {
  // ── items ──
  importFiles: (g, w) => ({ type: 'importFiles', files: g.some(FILES, 2).map((path) => ({ path, asSequence: false, createComposition: g.coin(0.15), ...(g.coin(0.2) && w.folders.length ? { folder: g.pick(w.folders)! } : {}) })) }),
  relinkItem: (g, w) => { const item = g.pick(w.footage); return item ? { type: 'relinkItem', item, path: g.pick(FILES)!.replace('/g/', '/r/'), keepInterpretation: g.coin() } : undefined; },
  removeItems: (g, w) => (g.coin(0.3) && w.footage.length + w.folders.length ? { type: 'removeItems', items: g.some([...w.footage, ...w.folders], 1), removeUsingLayers: g.coin() } : undefined),
  renameItem: (g, w) => { const item = g.pick(w.items); return item ? { type: 'renameItem', item, name: `Item ${g.int(50)}` } : undefined; },
  createFolder: (g, w) => ({ type: 'createFolder', name: `Folder ${g.int(20)}`, ...(g.coin(0.3) && w.folders.length ? { parent: g.pick(w.folders)! } : {}) }),
  moveItems: (g, w) => ({ type: 'moveItems', items: g.some(w.items, 2), ...(g.coin(0.7) && w.folders.length ? { folder: g.pick(w.folders)! } : {}) }),
  setInterpretation: (g, w) => {
    const patches: InterpretationPatch[] = [
      { alpha: g.pick(AlphaModeValues)! }, { pixelAspect: g.pick([1, 0.9, 2])! }, { loops: g.int(4) + 1 }, { invertAlpha: g.coin() },
      { conformFrameRate: { num: g.pick([24, 25, 60])!, den: 1 } }, { clearConform: true }, { fieldOrder: g.pick(FieldOrderValues)! }, { startTimecode: g.time() },
    ];
    return w.footage.length ? { type: 'setInterpretation', items: g.some(w.footage, 2), patch: g.pick(patches)! } : undefined;
  },
  setItemLabel: (g, w) => ({ type: 'setItemLabel', items: g.some(w.items, 2), label: g.int(17) }),
  removeUnusedItems: (g) => (g.coin(0.2) ? { type: 'removeUnusedItems' } : undefined),
  setProxy: (g, w) => { const item = g.pick(w.footage); return item ? { type: 'setProxy', item, ...(g.coin(0.7) ? { path: 'C:/g/proxy.mp4' } : {}), enabled: g.coin() } : undefined; },
  setItemComment: (g, w) => { const item = g.pick(w.items); return item ? { type: 'setItemComment', item, comment: `c${g.int(9)}` } : undefined; },
  setItemTags: (g, w) => { const item = g.pick(w.items); return item ? { type: 'setItemTags', item, tags: g.some(['a', 'b', 'hero', 'bg'], 2) } : undefined; },
  // ── compositions ──
  createComposition: (g, w) => ({
    type: 'createComposition',
    settings: {
      name: `Comp ${g.int(30)}`,
      ...(g.coin() ? { width: g.pick([640, 1280, 1920])!, height: g.pick([360, 720, 1080])! } : {}),
      ...(g.coin(0.3) ? { frameRate: { num: g.pick([24, 25, 30, 60])!, den: 1 } } : {}),
      ...(g.coin(0.3) ? { duration: sec(g.int(8) + 2) } : {}),
    },
    fromItems: g.coin(0.2) && w.footage.length ? g.some(w.footage, 1) : [],
  }),
  duplicateComposition: (g, w) => ({ type: 'duplicateComposition', comp: g.pick(w.comps)!, deep: g.coin() }),
  setCompositionSettings: (g, w) => {
    const patches: CompSettingsPatch[] = [
      { name: `Renamed ${g.int(9)}` }, { width: g.pick([800, 1280, 1920])! }, { height: g.pick([600, 720, 1080])! },
      { frameRate: { num: g.pick([24, 25, 30, 60])!, den: 1 } }, { duration: sec(g.int(10) + 2) }, { startTimecode: g.time() },
      { background: { r: g.num(0, 1, 0.25), g: g.num(0, 1, 0.25), b: g.num(0, 1, 0.25), a: 1 } }, { transparent: g.coin() },
      { workArea: { start: g.time(60), duration: sec(1 + g.int(3)) } }, { pixelAspect: g.pick([1, 0.9, 1.5])! },
      { motionBlur: { shutterAngle: g.pick([90, 180, 360])!, shutterPhase: -45, samplesPerFrame: 8, adaptiveSampleLimit: 64 } },
      { renderer3d: g.pick(Renderer3dValues)! }, { globalLightAngle: g.int(180) }, { dropFrame: g.coin() },
    ];
    return { type: 'setCompositionSettings', comp: g.pick(w.comps)!, patch: g.pick(patches)! };
  },
  setWorkArea: (g, w) => ({ type: 'setWorkArea', comp: g.pick(w.comps)!, range: { start: g.time(90), duration: sec(1 + g.int(4)) } }),
  precompose: (g, w) => {
    const layers = sameComp(g, w, 2);
    const comp = compOf(w, layers[0]);
    return comp ? { type: 'precompose', comp, layers, name: g.coin() ? '' : `Pre ${g.int(9)}`, mode: g.pick(PrecomposeModeValues)!, adjustDuration: g.coin() } : undefined;
  },
  trimCompToWorkArea: (g, w) => ({ type: 'trimCompToWorkArea', comp: g.pick(w.comps)! }),
  cropComposition: (g, w) => ({ type: 'cropComposition', comp: g.pick(w.comps)!, region: { x: g.int(200), y: g.int(200), width: 200 + g.int(600), height: 200 + g.int(400) } }),
  assembleComposition: (g, w) => (w.footage.length ? { type: 'assembleComposition', items: g.some(w.footage, 3), name: `Cut ${g.int(9)}`, overlap: sec(g.int(3) / 4) } : undefined),
  addRenderItems: (g, w) => ({ type: 'addRenderItems', comps: g.some(w.comps, 2), settings: g.coin() ? {} : { format: 'mp4', quality: g.int(100) } }),
  setRenderItem: (g, w) => {
    const item = g.pick(w.renderItems);
    return item ? { type: 'setRenderItem', item, patch: g.coin() ? { outputPath: 'C:/out/x.mp4' } : { includeAudio: g.coin(), width: 1280 }, ...(g.coin() ? { queued: g.coin() } : {}) } : undefined;
  },
  removeRenderItems: (g, w) => (w.renderItems.length ? { type: 'removeRenderItems', items: g.some(w.renderItems, 1) } : undefined),
  reorderRenderItems: (g, w) => (w.renderItems.length ? { type: 'reorderRenderItems', items: g.some(w.renderItems, 1), toIndex: g.int(w.renderItems.length + 1) } : undefined),
  setProjectSettings: (g) => {
    const patches: ProjectSettingsPatch[] = [
      { bitDepth: g.pick(BitDepthValues)! }, { workingSpace: g.pick(ColorWorkingSpaceValues)! }, { linearBlending: g.coin() },
      { timeDisplay: g.pick(TimeDisplayValues)! }, { framesStartAt: g.int(2) }, { audioSampleRate: g.pick([44100, 48000])! },
      { expressionEngine: g.pick(ExpressionEngineValues)! },
    ];
    return { type: 'setProjectSettings', patch: g.pick(patches)! };
  },
  // ── layers ──
  createLayer: (g, w) => {
    if (w.layers.length > 45) return undefined;
    const comp = g.pick(w.comps)!;
    const kind = g.pick(LayerKindValues)!;
    const source = FOOTAGE_KINDS[kind] ? g.pick(w.footage) : kind === 'precomp' ? g.pick(w.compItems.filter((c) => c !== comp)) : undefined;
    const siblings = layersOf(w, comp);
    return {
      type: 'createLayer', comp, kind,
      ...(g.coin(0.7) ? { name: `${kind} ${g.int(99)}` } : {}),
      ...(source ? { source } : {}),
      ...(g.coin(0.15) && siblings.length ? { parent: g.pick(siblings)!.id } : {}),
      ...(g.coin(0.2) ? { index: g.int(siblings.length + 1) } : {}),
      ...(g.coin(0.2) ? { inPoint: g.time(30), outPoint: sec(2 + g.int(3)) } : {}),
      init: g.coin(0.3) ? [{ path: 'transform/opacity', value: { kind: 'scalar', value: g.int(101) } }] : [],
    };
  },
  deleteLayers: (g, w) => (g.coin(0.4) && w.layers.length > 6 ? { type: 'deleteLayers', layers: g.some(ids(w.layers), 1) } : undefined),
  duplicateLayers: (g, w) => (w.layers.length < 45 ? { type: 'duplicateLayers', layers: sameComp(g, w, 2) } : undefined),
  reorderLayers: (g, w) => {
    const layers = sameComp(g, w, 2);
    const comp = compOf(w, layers[0]);
    return comp ? { type: 'reorderLayers', comp, layers, toIndex: g.int(layersOf(w, comp).length) } : undefined;
  },
  setParent: (g, w) => {
    const layers = sameComp(g, w, 2);
    const comp = compOf(w, layers[0]);
    const parent = comp && g.coin(0.75) ? g.pick(layersOf(w, comp))?.id : undefined;
    return layers.length ? { type: 'setParent', layers, ...(parent ? { parent } : {}), keepWorldTransform: g.coin() } : undefined;
  },
  renameLayer: (g, w) => { const l = g.pick(w.layers); return l ? { type: 'renameLayer', layer: l.id, name: `L${g.int(99)}` } : undefined; },
  setLayerSwitches: (g, w) => {
    const patches: LayerSwitchesPatch[] = [
      { visible: g.coin() }, { solo: g.coin() }, { shy: g.coin() }, { locked: g.coin(0.15) }, { collapse: g.coin() },
      { quality: g.pick(LayerQualityValues)! }, { effectsEnabled: g.coin() }, { motionBlur: g.coin() },
      { adjustment: g.coin() }, { threeD: g.coin() }, { guide: g.coin() }, { frameBlend: g.pick(FrameBlendValues)! },
      { autoOrient: g.pick(AutoOrientValues)! }, { preserveTransparency: g.coin() }, { label: g.int(17) }, { audioEnabled: g.coin() },
    ];
    return { type: 'setLayerSwitches', layers: g.some(ids(w.layers), 2), patch: { ...g.pick(patches)!, ...(g.coin(0.3) ? g.pick(patches)! : {}) } };
  },
  setBlendMode: (g, w) => ({ type: 'setBlendMode', layers: g.some(ids(w.layers), 2), mode: g.pick(BlendModeValues)! }),
  setTrackMatte: (g, w) => {
    const layers = sameComp(g, w, 2);
    return layers[0] ? { type: 'setTrackMatte', layer: layers[0], matte: { ...(layers[1] && g.coin(0.8) ? { layer: layers[1] } : {}), mode: g.pick(MatteModeValues)! } } : undefined;
  },
  replaceLayerSource: (g, w) => {
    const l = g.pick(w.layers.filter((x) => FOOTAGE_KINDS[x.kind] || x.kind === 'precomp'));
    const source = g.pick([...w.footage, ...w.compItems]);
    return l && source ? { type: 'replaceLayerSource', layer: l.id, source, keepSize: g.coin() } : undefined;
  },
  groupLayers: (g, w) => ({ type: 'groupLayers', layers: sameComp(g, w, 3), name: `G${g.int(9)}` }),
  ungroupLayer: (g, w) => { const l = g.pick(w.layers.filter((x) => x.kind === 'group')); return l ? { type: 'ungroupLayer', group: l.id } : undefined; },
  convertLayer: (g, w) => { const l = g.pick(w.layers); return l ? { type: 'convertLayer', layer: l.id, conversion: g.pick(LayerConversionValues)! } : undefined; },
  pasteLayers: async (g, w, h) => {
    const layers = sameComp(g, w, 2);
    if (!layers.length || w.layers.length > 45) return undefined;
    const fragment = await h.query({ type: 'copyLayers', layers }).catch(() => undefined);
    if (!fragment) return undefined;
    const comp = g.pick(w.comps)!;
    const cmd: Command = { type: 'pasteLayers', comp, fragment, ...(g.coin() ? { time: g.time(60) } : {}), ...(g.coin(0.3) ? { index: 0 } : {}) };
    // WS-L1: paste INTO a layer (a group, or any layer — parenting nests) at a deeper index.
    const into = g.coin(0.3) ? g.pick(layersOf(w, comp).filter((l) => l.kind === 'group' || g.coin(0.3))) : undefined;
    if (into) return { ...cmd, parent: into.id, index: g.int(layersOf(w, comp).length + 1) } as Command;
    return cmd;
  },
  separateLayer: (g, w) => { const l = g.pick(w.layers); return l ? { type: 'separateLayer', layer: l.id } : undefined; },
  autoTrace: (g, w) => { const l = g.pick(w.layers); return l ? { type: 'autoTrace', layer: l.id, range: { start: 0, duration: sec(1) }, channel: 'alpha', threshold: 50, tolerance: 1 } : undefined; },
  setLayerComment: (g, w) => { const l = g.pick(w.layers); return l ? { type: 'setLayerComment', layer: l.id, comment: `note ${g.int(9)}` } : undefined; },
  // ── layer time ──
  setLayerTiming: (g, w) => ({
    type: 'setLayerTiming',
    items: g.some(w.layers, 2).map((l) => {
      const which = g.int(4);
      return which === 0 ? { layer: l.id, inPoint: g.time(60) }
        : which === 1 ? { layer: l.id, outPoint: sec(2) + g.time(90) }
          : which === 2 ? { layer: l.id, startTime: g.delta(45) }
            : { layer: l.id, stretch: g.pick([50, 100, 200, -100])! };
    }),
  }),
  moveLayersInTime: (g, w) => ({ type: 'moveLayersInTime', layers: sameComp(g, w, 2), delta: g.delta(), ripple: g.coin(0.3) }),
  trimLayers: (g, w) => ({ type: 'trimLayers', layers: sameComp(g, w, 2), edge: g.pick(EdgeValues)!, time: g.time(), ripple: g.coin(0.3) }),
  slipLayers: (g, w) => ({ type: 'slipLayers', layers: sameComp(g, w, 2), delta: g.delta() }),
  slideLayer: (g, w) => { const l = g.pick(w.layers); return l ? { type: 'slideLayer', layer: l.id, delta: g.delta() } : undefined; },
  rollEdit: (g, w) => { const ls = sameComp(g, w, 2); return ls.length === 2 ? { type: 'rollEdit', left: ls[0]!, right: ls[1]!, delta: g.delta(10) } : undefined; },
  splitLayers: (g, w) => (w.layers.length < 45 ? { type: 'splitLayers', layers: sameComp(g, w, 2), time: g.time() } : undefined),
  rippleDeleteLayers: (g, w) => (g.coin(0.3) && w.layers.length > 6 ? { type: 'rippleDeleteLayers', layers: sameComp(g, w, 1) } : undefined),
  editWorkArea: (g, w) => { const comp = g.pick(w.comps)!; return { type: 'editWorkArea', comp, edit: g.pick(WorkAreaEditValues)!, layers: g.coin() ? [] : g.some(ids(layersOf(w, comp)), 2) }; },
  insertGap: (g, w) => ({ type: 'insertGap', comp: g.pick(w.comps)!, time: g.time(), duration: sec(g.int(8) / 4) }),
  timeReverseLayers: (g, w) => ({ type: 'timeReverseLayers', layers: sameComp(g, w, 2) }),
  setTimeRemap: (g, w) => { const l = g.pick(w.layers); return l ? { type: 'setTimeRemap', layer: l.id, enabled: g.coin(0.7) } : undefined; },
  freezeFrame: (g, w) => { const l = g.pick(w.layers); return l ? { type: 'freezeFrame', layer: l.id, ...(g.coin() ? { time: g.time(60) } : {}), lastFrame: g.coin(0.3) } : undefined; },
  setRetime: (g, w) => { const l = g.pick(w.layers); return l ? { type: 'setRetime', layer: l.id, mode: g.pick(RetimeModeValues)!, ...(g.coin(0.7) ? { speed: g.pick([50, 150, 200, 25])! } : {}) } : undefined; },
  sequenceLayers: (g, w) => ({ type: 'sequenceLayers', layers: sameComp(g, w, 3), overlap: sec(g.int(3) / 4), crossfade: g.coin(0.3) }),
  // ── properties ──
  setProperty: (g, w) => {
    // G1: now and then a static field (a choice, a switch, a string, a list…).
    const p = (g.coin(0.25) ? g.pick(staticFields(w)) : undefined) ?? g.pick(animatable(w));
    const value = p && tweak(g, p.info, w);
    return p && value ? { type: 'setProperty', prop: ref(p), value, ...(g.coin(0.4) ? { time: g.time() } : {}) } : undefined;
  },
  setProperties: (g, w) => {
    const writes = g.some(animatable(w), 3).flatMap((p) => {
      const value = tweak(g, p.info, w);
      return value ? [{ prop: ref(p), value, ...(g.coin(0.3) ? { time: g.time() } : {}) }] : [];
    });
    return writes.length ? { type: 'setProperties', writes } : undefined;
  },
  resetProperty: (g, w) => { const p = g.pick(w.props); return p ? { type: 'resetProperty', prop: ref(p), ...(g.coin(0.3) ? { time: g.time() } : {}) } : undefined; },
  setAnimated: (g, w) => { const p = g.pick(animatable(w)); return p ? { type: 'setAnimated', prop: ref(p), animated: g.coin(0.7), time: g.time() } : undefined; },
  setDimensionsSeparated: (g, w) => {
    const l = g.pick(w.layers);
    return l ? { type: 'setDimensionsSeparated', layer: l.id, path: g.pick(['transform/position', 'transform/scale', 'transform/orientation'])!, separated: g.coin(0.6) } : undefined;
  },
  setExpression: (g, w) => {
    const p = g.pick(animatable(w));
    if (!p) return undefined;
    const source = p.info.value?.kind === 'scalar' && g.coin(0.7) ? g.pick(EXPRESSIONS_SCALAR)! : g.pick(EXPRESSIONS_ANY)!;
    // B3z WS-K: now and then one dimension of a vector (a member expression).
    const vec = ['vec2', 'vec3', 'color'].includes(p.info.value?.kind ?? '');
    return { type: 'setExpression', prop: ref(p), source: g.coin(0.1) ? '' : source, enabled: g.coin(0.85), ...(vec && g.coin(0.3) ? { member: g.int(2) } : {}) };
  },
  setExpressionEnabled: (g, w) => ({ type: 'setExpressionEnabled', props: g.some(animatable(w), 2).map(ref), enabled: g.coin(), ...(g.coin(0.15) ? { member: g.int(2) } : {}) }),
  convertExpressionToKeyframes: (g, w) => {
    const p = g.pick(animatable(w));
    return p ? { type: 'convertExpressionToKeyframes', prop: ref(p), ...(g.coin() ? { range: { start: 0, duration: sec(0.5) } } : {}), step: g.coin() ? 0 : sec(2 / 30) } : undefined;
  },
  linkProperty: (g, w) => {
    const p = g.pick(animatable(w));
    const t = p && g.pick(animatable(w).filter((q) => q.info.valueType === p.info.valueType && (q.layer !== p.layer || q.info.path !== p.info.path)));
    return p && t ? { type: 'linkProperty', prop: ref(p), target: ref(t) } : undefined;
  },
  addKeyframes: (g, w) => {
    const keys = g.some(animatable(w), 2).flatMap((p) => Array.from({ length: 1 + g.int(3) }, () => {
      const value = g.coin(0.85) ? tweak(g, p.info, w) : undefined;
      return {
        prop: ref(p), time: g.time(), spatialIn: [], spatialOut: [],
        ...(value ? { value } : {}),
        ...(g.coin(0.3) ? { easing: g.pick(EasingValues)! } : {}),
        ...(g.coin(0.15) ? { bezier: { x1: 0.3, y1: 0, x2: 0.7, y2: 1 } } : {}),
        ...(g.coin(0.1) ? { roving: g.coin() } : {}),
        ...(g.coin(0.15) ? { spatialInterp: g.pick(SpatialInterpValues)! } : {}),
      };
    }));
    return keys.length ? { type: 'addKeyframes', keys } : undefined;
  },
  deleteKeyframes: (g, w) => (w.keys.length ? { type: 'deleteKeyframes', ids: g.some(w.keys.map((k) => k.id), 2) } : undefined),
  moveKeyframes: (g, w) => (w.keys.length ? { type: 'moveKeyframes', ids: g.some(w.keys.map((k) => k.id), 3), delta: g.delta() } : undefined),
  updateKeyframes: (g, w) => {
    if (!w.keys.length) return undefined;
    const patches: Array<Omit<KeyframePatch, 'id' | 'spatialIn' | 'spatialOut'>> = [
      { easing: g.pick(EasingValues)! }, { time: g.time() }, { roving: g.coin() }, { continuous: g.coin() }, { label: g.int(17) },
      { bezier: { x1: 0.2, y1: 0.1, x2: 0.8, y2: 0.9 } }, { clearBezier: true }, { spatialInterp: g.pick(SpatialInterpValues)! }, { clearSpatial: true },
      // B3z WS-K: per-dimension ease.
      { dim: g.int(3), easing: 'bezier', bezier: { x1: 0.4, y1: 0, x2: 0.6, y2: 1 } }, { dim: g.int(2), continuous: g.coin(), clearBezier: g.coin() },
    ];
    return { type: 'updateKeyframes', patches: g.some(w.keys, 2).map((k) => ({ id: k.id, spatialIn: [], spatialOut: [], ...g.pick(patches)! })) };
  },
  scaleKeyframes: (g, w) => (w.keys.length ? { type: 'scaleKeyframes', ids: g.some(w.keys.map((k) => k.id), 3), pivot: g.time(30), factor: g.pick([0.5, 2, 1.5, -1])! } : undefined),
  reverseKeyframes: (g, w) => (w.keys.length ? { type: 'reverseKeyframes', ids: g.some(w.keys.map((k) => k.id), 3) } : undefined),
  pasteKeyframes: (g, w) => {
    const set = g.pick(w.keySets.filter((s) => s.keyframes.length));
    const type = set && w.props.find((x) => x.layer === set.prop.layer && x.info.path === set.prop.path)?.info.valueType;
    const p = type && g.pick(animatable(w).filter((q) => q.info.valueType === type));
    return set && p ? { type: 'pasteKeyframes', prop: ref(p), time: g.time(60), keys: set.keyframes } : undefined;
  },
  // B3z WS-K: replace a property's keys (an assistant's result) — kept / new ids, shifted, per-dimension ease.
  setKeyframes: (g, w) => {
    const set = g.pick(w.keySets.filter((s) => s.keyframes.length));
    if (!set) return undefined;
    const shift = g.coin() ? 0 : sec(g.int(3) / 10);
    const keys = set.keyframes.filter(() => g.coin(0.8)).map((k) => ({
      ...k, time: k.time + shift, id: g.coin(0.2) ? '' : k.id,
      dims: g.coin(0.2) && ['vec2', 'color'].includes(k.value.kind) ? (k.value.kind === 'vec2' ? [0, 1] : [0, 1, 2, 3]).map((i) => ({ easing: i % 2 ? 'hold' as const : 'linear' as const, continuous: false })) : k.dims,
    }));
    return keys.length ? { type: 'setKeyframes', prop: set.prop, keys } : undefined;
  },
  addEffect: (g, w) => ({ type: 'addEffect', layers: g.some(ids(w.layers), 2), effect: g.pick(EFFECT_TYPES)!, ...(g.coin(0.2) ? { index: 0 } : {}), params: [] }),
  addMask: (g, w) => {
    const l = g.pick(w.layers);
    const x = g.int(100);
    return l ? {
      type: 'addMask', layer: l.id, mode: g.pick(MaskModeValues)!, inverted: g.coin(0.2), ...(g.coin(0.3) ? { name: `Mask ${g.int(9)}` } : {}),
      path: {
        vertices: [x, 0, x + 100, 0, x + 100, 100, x, 100], inTangents: [], outTangents: [], closed: g.coin(0.9),
        // B3z-a: per-vertex feather (a vertex past the 4th is refused).
        featherPoints: g.coin(0.3) ? [{ segment: g.int(5), t: 0, radius: g.int(20), tension: 0 }] : [],
      },
    } : undefined;
  },
  addPropertyGroup: (g, w) => {
    const l = g.pick(w.layers);
    if (!l) return undefined;
    const anim = g.pick(w.groups.filter((x) => x.layer === l.id && /^text\/animators\/[^/]+$/.test(x.info.path)));
    const choice = g.int(4);
    if (choice === 0) return { type: 'addPropertyGroup', layer: l.id, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] };
    if (choice === 1 && anim) {
      return { type: 'addPropertyGroup', layer: l.id, parent: `${anim.info.path}/selectors`, matchName: g.pick(['ADBE Text Selector', 'ADBE Text Wiggly Selector', 'ADBE Text Expressible Selector'])!, init: [] };
    }
    if (choice === 2) return { type: 'addPropertyGroup', layer: l.id, parent: 'styles', matchName: `style:${g.pick(STYLE_KEYS)!}`, init: [] };
    return { type: 'addPropertyGroup', layer: l.id, parent: 'contents', matchName: `pathop:${g.pick(PATH_OP_TYPES)!}`, init: [], ...(g.coin(0.2) ? { index: 0 } : {}) };
  },
  removePropertyGroups: (g, w) => (w.groups.length ? { type: 'removePropertyGroups', groups: g.some(w.groups, 1).map(ref) } : undefined),
  // B3z WS-R: puppet pins, bones, IK goals, controllers (and the rigs they create).
  addRigGroup: (g, w) => {
    const l = g.pick(w.layers);
    if (!l) return undefined;
    const bone = g.pick(w.groups.filter((x) => x.layer === l.id && /^skeleton\/bones\/[^/]+$/.test(x.info.path)));
    const c = g.int(5);
    const v = { kind: 'vec2' as const, value: { x: g.int(200) - 100, y: g.int(200) - 100 } };
    if (c === 0) return { type: 'addPropertyGroup', layer: l.id, parent: 'puppet/pins', matchName: 'ADBE FreePin3 PosPin Atom', init: [{ path: 'restPosition', value: v }, { path: 'kind', value: { kind: 'choice', value: g.pick(['position', 'starch', 'bend', 'advanced', 'overlap'])! } }], ...(g.coin(0.2) ? { index: 0 } : {}) };
    if (c === 1) return { type: 'addPropertyGroup', layer: l.id, parent: 'skeleton/bones', matchName: 'Premation Bone', init: [{ path: 'position', value: v }, ...(bone && g.coin() ? [{ path: 'parent', value: { kind: 'string' as const, value: bone.info.path.split('/')[2]! } }] : [])] };
    if (c === 2 && bone) return { type: 'addPropertyGroup', layer: l.id, parent: bone.info.path, matchName: 'Premation IK Goal', init: [{ path: 'target', value: v }] };
    if (c === 3) return { type: 'addPropertyGroup', layer: l.id, parent: 'skeleton/controllers', matchName: 'Premation Rig Controller', init: [] };
    return { type: 'addPropertyGroup', layer: l.id, parent: '', matchName: g.pick(['ADBE FreePin3', 'Premation Skeleton'])!, init: [] };
  },
  addIkPole: (g, w) => {
    const ik = g.pick(w.groups.filter((x) => /\/ik$/.test(x.info.path)));
    if (!ik) return undefined;
    return g.coin()
      ? { type: 'addProperties', parent: { layer: ik.layer, path: ik.info.path }, names: ['pole'] }
      : { type: 'removeProperties', props: [{ layer: ik.layer, path: `${ik.info.path}/pole` }] };
  },
  addProperties: (g, w) => {
    const anim = g.pick(w.groups.filter((x) => /^text\/animators\/[^/]+$/.test(x.info.path)));
    return anim ? { type: 'addProperties', parent: { layer: anim.layer, path: `${anim.info.path}/props` }, names: g.some(OPTIONAL_NAMES, 3) } : undefined;
  },
  removeProperties: (g, w) => {
    const props = w.props.filter((p) => OPTIONAL_PROP.test(p.info.path));
    return props.length ? { type: 'removeProperties', props: g.some(props, 2).map(ref) } : undefined;
  },
  // B3z: delete Stroke N of a layer's stroke stack (an index past the end is outOfRange).
  removeStroke: (g, w) => {
    const p = g.pick(w.props.filter((x) => x.info.path === 'layer/strokes'));
    if (!p) return undefined;
    let n = 0;
    try { n = (JSON.parse((p.info.value as { value: string }).value) as unknown[]).length; } catch { n = 0; }
    return { type: 'removeStroke', layer: p.layer, index: g.int(n + 1) };
  },
  movePropertyGroup: (g, w) => { const p = g.pick(w.groups); return p ? { type: 'movePropertyGroup', group: ref(p), toIndex: g.int(3) } : undefined; },
  duplicatePropertyGroups: (g, w) => (w.groups.length ? { type: 'duplicatePropertyGroups', groups: g.some(w.groups, 1).map(ref) } : undefined),
  setGroupEnabled: (g, w) => (w.groups.length ? { type: 'setGroupEnabled', groups: g.some(w.groups, 2).map(ref), enabled: g.coin() } : undefined),
  renamePropertyGroup: (g, w) => { const p = g.pick(w.groups); return p ? { type: 'renamePropertyGroup', group: ref(p), name: `N${g.int(9)}` } : undefined; },
  copyPropertyGroups: (g, w) => (w.groups.length ? { type: 'copyPropertyGroups', groups: g.some(w.groups, 1).map(ref), toLayers: g.some(ids(w.layers), 2) } : undefined),
  // B3z-a: a captured effect snapshot (keys, switch, compositing options).
  pasteEffects: (g, w) => ({
    type: 'pasteEffects',
    layers: g.some(ids(w.layers), 2),
    effects: JSON.stringify([{
      effect: { type: g.pick(EFFECT_TYPES)!, params: {}, ...(g.coin(0.3) ? { opacity: g.int(100) } : {}), ...(g.coin(0.3) ? { enabled: false } : {}) },
      tracks: g.coin(0.5) ? { 'fx.opacity': [{ t: 0, value: g.int(100) }, { t: 1, value: g.int(100), easing: 'easeIn' }] } : {},
    }]),
    ...(g.coin(0.2) ? { index: 0 } : {}),
  }),
  applyPreset: (g, w) => ({ type: 'applyPreset', layers: g.some(ids(w.layers), 2), preset: g.pick(PRESET_NAMES)!, time: g.time(60) }),
  invokeEffectAction: (g, w) => {
    const p = g.pick(w.groups.filter((x) => x.info.path.startsWith('effects/')));
    return p ? { type: 'invokeEffectAction', group: ref(p), action: g.pick(['reset', 'nope'])! } : undefined;
  },
  setPluginData: (g, w) => { const l = g.pick(w.layers); return l && g.coin(0.2) ? { type: 'setPluginData', layer: l.id, group: 'effects/none', key: 'k', data: new Uint8Array([1, 2, 3]) } : undefined; },
  // ── markers ──
  addMarkers: (g, w) => {
    const comp = g.pick(w.comps)!;
    const layer = g.coin(0.4) ? g.pick(layersOf(w, comp)) : undefined;
    return {
      type: 'addMarkers',
      markers: [{ owner: { comp, ...(layer ? { layer: layer.id } : {}) }, time: g.time(), duration: g.coin(0.3) ? sec(0.5) : 0, name: `M${g.int(9)}`, comment: g.coin() ? '' : 'c', label: g.int(17) }],
    };
  },
  updateMarkers: (g, w) => {
    if (!w.markers.length) return undefined;
    const patches: Array<Omit<MarkerPatch, 'id'>> = [
      { time: g.time() }, { duration: sec(1) }, { name: 'Renamed' }, { comment: 'x' }, { label: g.int(17) },
      { chapter: 'ch' }, { url: 'https://x' }, { cuePoint: 'cue' }, { protectedRegion: g.coin() },
    ];
    return { type: 'updateMarkers', patches: g.some(w.markers, 2).map((m) => ({ id: m.id, ...g.pick(patches)! })) };
  },
  deleteMarkers: (g, w) => (w.markers.length ? { type: 'deleteMarkers', ids: g.some(w.markers.map((m) => m.id), 1) } : undefined),
  moveMarkers: (g, w) => (w.markers.length ? { type: 'moveMarkers', ids: g.some(w.markers.map((m) => m.id), 2), delta: g.delta() } : undefined),
  // ── jobs ──
  applyJobResult: (g) => (g.coin(0.2) ? { type: 'applyJobResult', job: 'job_none' } : undefined),
  // ── project ── (the session saves a copy of itself first)
  importProject: (g, w) => (g.coin(0.3) ? { type: 'importProject', path: GENERATED_SAVE, ...(g.coin(0.3) && w.folders.length ? { folder: g.pick(w.folders)! } : {}) } : undefined),
};

/** The command types the generated corpus builds (the rest of the edit set is io, left to the scripted sessions). */
export const GENERATED_COMMANDS: readonly string[] = Object.keys(BUILDERS);

// Every builder may be batched. (Until G2 the creators and editWorkArea were
// not: a batch's inverse took a part's first-seen before / last-seen after
// from captures that did not list parts created or removed by an earlier
// command of the batch — engineCorrectness.test.ts pins both fixes.)
const COALESCING = new Set(['setProperty', 'setProperties', 'moveKeyframes', 'setLayerTiming', 'moveLayersInTime', 'setCompositionSettings', 'setWorkArea', 'updateKeyframes', 'moveMarkers', 'slipLayers', 'setKeyframes']);

async function generatedSession(h: Harness, seed: number, steps: number): Promise<void> {
  const g = new Gen(mulberry32(seed));
  const ignore = () => undefined;
  // A varied start: the standard scene plus a precomp and a few more kinds.
  const s = await buildScene(h);
  await h.run({ type: 'createLayer', comp: s.comp, kind: 'precomp', source: s.comp2, init: [] });
  for (const kind of ['camera', 'light', 'ellipse', 'group'] as const) await h.run({ type: 'createLayer', comp: s.comp, kind, init: [] });
  await h.run({ type: 'saveProject', path: GENERATED_SAVE, copy: true });
  const names = Object.keys(BUILDERS);
  // Round-robin from a seed-dependent start, with jitter: a short run still reaches every family.
  let cursor = g.int(names.length);
  for (let step = 0; step < steps; step++) {
    const w = await observe(h);
    const roll = g.int(100);
    if (roll < 6) {
      await h.run({ type: 'undo' }).catch(ignore);
      if (g.coin()) await h.run({ type: 'redo' }).catch(ignore);
      continue;
    }
    if (roll < 8) {
      const hist = await h.query({ type: 'getHistory' });
      await h.run({ type: 'jumpToHistory', position: g.int(hist.entries.length + 1) }).catch(ignore);
      continue;
    }
    if (roll < 10) {
      await h.run({ type: 'seek', time: g.time(), mode: 'exact' }).catch(ignore);
      if (g.coin(0.3)) await h.run({ type: 'setActiveComposition', comp: g.pick(w.comps)! }).catch(ignore);
      continue;
    }
    const name = g.coin(0.6) ? names[cursor++ % names.length]! : g.pick(names)!;
    const make = BUILDERS[name]!;
    if (roll < 16 && COALESCING.has(name)) {
      const { gesture } = await h.run({ type: 'beginGesture', label: `Drag ${name}` });
      for (let i = 0, n = 1 + g.int(4); i < n; i++) {
        const c = await make(g, await observe(h), h);
        if (c) await h.run(c as never).catch(ignore);
      }
      await h.run({ type: 'endGesture', gesture, commit: g.coin(0.8) }).catch(ignore);
      continue;
    }
    if (roll < 22) {
      const cmds: Command[] = [];
      for (let i = 0, n = 2 + g.int(2); i < n; i++) {
        const c = await make(g, w, h);
        if (c) cmds.push(c);
      }
      if (cmds.length) await h.batch(`Batch ${name}`, cmds).catch(ignore);
      continue;
    }
    const c = await make(g, w, h);
    if (c) await h.run(c as never).catch(ignore);
  }
  const w = await observe(h);
  for (const time of [0, sec(0.5), sec(1.5)]) {
    await h.query({ type: 'getPropertyValues', props: animatable(w).slice(0, 300).map(ref), time, evaluated: true }).catch(ignore);
  }
}

/** Seeded sessions: with 160 steps each, every builder runs several times per seed. */
export const GENERATED_CORPUS: Record<string, Session> = Object.fromEntries(
  [11, 23, 37, 41, 59, 67].map((seed) => [`generated: seed ${seed}`, (h: Harness) => generatedSession(h, seed, 160)]),
);
