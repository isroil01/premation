/**
 * Every edit command: execute → document changed → undo → document EXACTLY as
 * before (canonical saved JSON) → redo → exactly as after. Runs with
 * `verifyScopes` (a command that changes a part outside its declared scope
 * fails) and `wire` (every request, response and event batch goes through the
 * binary codec). The coverage test at the bottom fails when a command is added
 * to the schema without a case here.
 */

import { COMMANDS, type Command, type CommandType } from '@motion/engine-api';
import { setupEngine, sec, docDiff, type Harness } from '../__testHelpers__/harness';
import { buildScene, type Scene } from '../__testHelpers__/scene';

jest.useFakeTimers();

interface Case {
  /** Build the command from the scene (may run preparatory commands first). */
  cmd: (s: Scene, h: Harness) => Command | Promise<Command>;
  /** The command is expected to fail with this code and change nothing. */
  fails?: string;
}

const pos = (layer: string) => ({ layer, path: 'transform/position' });

async function opacityKeys(h: Harness, layer: string): Promise<string[]> {
  await h.run({ type: 'addKeyframes', keys: [0, 1, 2].map((i) => ({ prop: { layer, path: 'transform/opacity' }, time: sec(i), value: { kind: 'scalar' as const, value: 20 * (i + 1) }, spatialIn: [], spatialOut: [] })) });
  const r = await h.query({ type: 'getKeyframes', props: [{ layer, path: 'transform/opacity' }] });
  return r.sets[0]!.keyframes.map((k) => k.id);
}

/** A paint stroke with pen input (the paint cases' fixture). */
function paintStroke(layer: string): Command {
  return {
    type: 'addPaintStroke', layer, keys: [],
    stroke: JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], pressure: [0.5, 1], mode: 'paint' }),
  };
}

export const CASES: Partial<Record<CommandType, Case>> = {
  // ── Project ──
  setProjectSettings: { cmd: () => ({ type: 'setProjectSettings', patch: { timeDisplay: 'frames', framesStartAt: 1 } }) },
  // B3z: a saved version restored as one undoable entry.
  restoreDocument: {
    cmd: async (s, h) => {
      await h.run({ type: 'saveProject', path: 'C:/p/version.motion', copy: true });
      await h.run({ type: 'renameLayer', layer: s.A, name: 'After the version' });
      await h.run({ type: 'deleteLayers', layers: [s.B] });
      const bytes = new TextEncoder().encode(JSON.stringify(h.files.get('C:/p/version.motion')));
      return { type: 'restoreDocument', document: bytes, label: 'Restore Version' };
    },
  },
  importProject: {
    cmd: async (_s, h) => {
      await h.run({ type: 'saveProject', path: 'C:/p/other.motion', copy: true });
      return { type: 'importProject', path: 'C:/p/other.motion' };
    },
  },
  // ── Items ──
  importFiles: { cmd: () => ({ type: 'importFiles', files: [{ path: 'C:/media/new.png', asSequence: false, createComposition: false }] }) },
  importBytes: { cmd: (s) => ({ type: 'importBytes', files: [{ name: 'matte.png', data: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', folder: s.folder }] }) },
  relinkItem: { cmd: (s) => ({ type: 'relinkItem', item: s.footage2, path: 'D:/moved/clip2.mp4', keepInterpretation: true }) },
  removeItems: { cmd: (s) => ({ type: 'removeItems', items: [s.footage], removeUsingLayers: true }) },
  renameItem: { cmd: (s) => ({ type: 'renameItem', item: s.comp2, name: 'Renamed' }) },
  createFolder: { cmd: (s) => ({ type: 'createFolder', name: 'Sub', parent: s.folder }) },
  moveItems: { cmd: (s) => ({ type: 'moveItems', items: [s.footage, s.comp2], folder: s.folder }) },
  setInterpretation: { cmd: (s) => ({ type: 'setInterpretation', items: [s.footage], patch: { pixelAspect: 2, loops: 3 } }) },
  setItemLabel: { cmd: (s) => ({ type: 'setItemLabel', items: [s.footage, s.comp2], label: 3 }) },
  removeUnusedItems: { cmd: () => ({ type: 'removeUnusedItems' }) },
  setProxy: { cmd: (s) => ({ type: 'setProxy', item: s.footage, path: 'C:/proxy.mp4', enabled: true }) },
  setItemComment: { cmd: (s) => ({ type: 'setItemComment', item: s.footage, comment: 'hero plate' }) },
  setItemTags: { cmd: (s) => ({ type: 'setItemTags', item: s.footage, tags: ['hero', 'wide'] }) },
  // ── Compositions ──
  createComposition: { cmd: (s) => ({ type: 'createComposition', settings: { name: 'From Footage' }, fromItems: [s.footage] }) },
  duplicateComposition: { cmd: (s) => ({ type: 'duplicateComposition', comp: s.comp, deep: true }) },
  setCompositionSettings: { cmd: (s) => ({ type: 'setCompositionSettings', comp: s.comp, patch: { width: 1280, frameRate: { num: 25, den: 1 }, duration: sec(8), background: { r: 1, g: 0, b: 0, a: 1 } } }) },
  setWorkArea: { cmd: (s) => ({ type: 'setWorkArea', comp: s.comp, range: { start: sec(2), duration: sec(1) } }) },
  precompose: { cmd: (s) => ({ type: 'precompose', comp: s.comp, layers: [s.A, s.B], name: 'Pre 1', mode: 'moveAll', adjustDuration: false }) },
  trimCompToWorkArea: { cmd: (s) => ({ type: 'trimCompToWorkArea', comp: s.comp }) },
  cropComposition: { cmd: (s) => ({ type: 'cropComposition', comp: s.comp, region: { x: 100, y: 50, width: 800, height: 600 } }) },
  assembleComposition: { cmd: (s) => ({ type: 'assembleComposition', items: [s.footage, s.footage2], name: 'Assembly', overlap: sec(0.5) }) },
  // ── Render queue ──
  addRenderItems: { cmd: (s) => ({ type: 'addRenderItems', comps: [s.comp], settings: { outputPath: 'C:/out.mp4' } }) },
  setRenderItem: {
    cmd: async (s, h) => {
      const { items: [id] } = await h.run({ type: 'addRenderItems', comps: [s.comp], settings: {} });
      return { type: 'setRenderItem', item: id!, patch: { quality: 55 }, queued: false };
    },
  },
  removeRenderItems: {
    cmd: async (s, h) => {
      const { items: [id] } = await h.run({ type: 'addRenderItems', comps: [s.comp], settings: {} });
      return { type: 'removeRenderItems', items: [id!] };
    },
  },
  reorderRenderItems: {
    cmd: async (s, h) => {
      const { items } = await h.run({ type: 'addRenderItems', comps: [s.comp, s.comp2], settings: {} });
      return { type: 'reorderRenderItems', items: [items[1]!], toIndex: 0 };
    },
  },
  // ── Layers ──
  createLayer: { cmd: (s) => ({ type: 'createLayer', comp: s.comp, kind: 'text', name: 'New', index: 2, init: [{ path: 'transform/opacity', value: { kind: 'scalar', value: 50 } }], inPoint: sec(1), outPoint: sec(3) }) },
  deleteLayers: { cmd: (s) => ({ type: 'deleteLayers', layers: [s.B, s.A] }) },
  duplicateLayers: { cmd: (s) => ({ type: 'duplicateLayers', layers: [s.B] }) },
  reorderLayers: { cmd: (s) => ({ type: 'reorderLayers', comp: s.comp, layers: [s.P], toIndex: 0 }) },
  setParent: { cmd: (s) => ({ type: 'setParent', layers: [s.B], parent: s.P, keepWorldTransform: true }) },
  renameLayer: { cmd: (s) => ({ type: 'renameLayer', layer: s.A, name: 'Alpha' }) },
  setLayerSwitches: { cmd: (s) => ({ type: 'setLayerSwitches', layers: [s.A, s.B], patch: { shy: true, solo: true, locked: true, label: 2, threeD: true, motionBlur: true } }) },
  setBlendMode: { cmd: (s) => ({ type: 'setBlendMode', layers: [s.A], mode: 'screen' }) },
  setTrackMatte: { cmd: (s) => ({ type: 'setTrackMatte', layer: s.A, matte: { layer: s.B, mode: 'lumaInverted' } }) },
  replaceLayerSource: { cmd: (s) => ({ type: 'replaceLayerSource', layer: s.V, source: s.footage2, keepSize: false }) },
  groupLayers: { cmd: (s) => ({ type: 'groupLayers', layers: [s.A, s.B], name: 'G' }) },
  ungroupLayer: {
    cmd: async (s, h) => {
      const { layer } = await h.run({ type: 'groupLayers', layers: [s.A, s.B], name: 'G' });
      return { type: 'ungroupLayer', group: layer };
    },
  },
  convertLayer: { cmd: (s) => ({ type: 'convertLayer', layer: s.T, conversion: 'shapesFromText' }), fails: 'unsupported' },
  pasteLayers: {
    cmd: async (s, h) => {
      const frag = await h.query({ type: 'copyLayers', layers: [s.B] });
      return { type: 'pasteLayers', comp: s.comp2, fragment: { version: frag.version, data: frag.data }, time: sec(1) };
    },
  },
  separateLayer: { cmd: (s) => ({ type: 'separateLayer', layer: s.T }), fails: 'unsupported' },
  autoTrace: { cmd: (s) => ({ type: 'autoTrace', layer: s.A, range: { start: 0, duration: sec(1) }, channel: 'alpha', threshold: 0.5, tolerance: 1 }), fails: 'unsupported' },
  setLayerComment: { cmd: (s) => ({ type: 'setLayerComment', layer: s.A, comment: 'check this' }) },
  // ── B3z (WS-T, WS-K, effects, strokes) ──
  clearWorkArea: { cmd: (s) => ({ type: 'clearWorkArea', comp: s.comp }) },
  timeStretchLayers: { cmd: (s) => ({ type: 'timeStretchLayers', layers: [s.B], stretch: 2, hold: 'inPoint' }) },
  unfreezeLayers: {
    cmd: async (s, h) => {
      await h.run({ type: 'freezeFrame', layer: s.V, time: sec(1), lastFrame: false });
      return { type: 'unfreezeLayers', layers: [s.V] };
    },
  },
  rippleDeleteRange: { cmd: (s) => ({ type: 'rippleDeleteRange', comp: s.comp, range: { start: sec(1), duration: sec(1) }, layers: [] }) },
  shiftLayerKeyframes: { cmd: (s) => ({ type: 'shiftLayerKeyframes', items: [{ layer: s.B, delta: sec(0.5) }] }) },
  addTransition: {
    cmd: async (s, h) => {
      await h.run({ type: 'setLayerTiming', items: [
        { layer: s.A, startTime: 0, inPoint: sec(1), outPoint: sec(2) },
        { layer: s.B, startTime: 0, inPoint: sec(2), outPoint: sec(3) },
      ] });
      return { type: 'addTransition', left: s.A, right: s.B, kind: 'dipToBlack', duration: sec(0.4), alignment: 'centred' };
    },
  },
  setTransition: {
    cmd: async (s, h) => {
      await h.run({ type: 'setLayerTiming', items: [
        { layer: s.A, startTime: 0, inPoint: sec(1), outPoint: sec(2) },
        { layer: s.B, startTime: 0, inPoint: sec(2), outPoint: sec(3) },
      ] });
      const { transition } = await h.run({ type: 'addTransition', left: s.A, right: s.B, kind: 'dipToBlack', duration: sec(0.4), alignment: 'centred' });
      return { type: 'setTransition', transition, duration: sec(0.2), alignment: 'startAtCut' };
    },
  },
  removeTransitions: {
    cmd: async (s, h) => {
      await h.run({ type: 'setLayerTiming', items: [
        { layer: s.A, startTime: 0, inPoint: sec(1), outPoint: sec(2) },
        { layer: s.B, startTime: 0, inPoint: sec(2), outPoint: sec(3) },
      ] });
      const { transition } = await h.run({ type: 'addTransition', left: s.A, right: s.B, kind: 'dipToBlack', duration: sec(0.4), alignment: 'centred' });
      return { type: 'removeTransitions', transitions: [transition] };
    },
  },
  pasteEffects: {
    cmd: (s) => ({ type: 'pasteEffects', layers: [s.B], effects: JSON.stringify([{ effect: { id: 'fx_src', type: 'glow', params: {}, enabled: true }, tracks: {} }]) }),
  },
  removeStroke: {
    cmd: async (s, h) => {
      const stroke = (width: number) => ({ enabled: true, color: '#ff0000', width, opacity: 1, align: 'center', dash: [], cap: 'butt', join: 'miter' });
      await h.run({ type: 'setProperty', prop: { layer: s.B, path: 'layer/strokes' }, value: { kind: 'json', value: JSON.stringify([stroke(2), stroke(4)]) } });
      return { type: 'removeStroke', layer: s.B, index: 0 };
    },
  },
  // ── Paint strokes (B3) ──
  addPaintStroke: {
    cmd: (s) => ({
      type: 'addPaintStroke', layer: s.B,
      stroke: JSON.stringify({ points: [{ x: 0, y: 0 }, { x: 10, y: 5 }], color: '#ff0000', size: 8, mode: 'paint', spacing: 0.25, inPoint: 0.5 }),
      keys: [{ param: 'end', time: 0.5, value: 0 }, { param: 'end', time: 1, value: 100 }],
    }),
  },
  updatePaintStroke: {
    cmd: async (s, h) => {
      const { stroke } = await h.run(paintStroke(s.B)) as { stroke: string };
      return { type: 'updatePaintStroke', layer: s.B, stroke, patch: JSON.stringify({ visible: false, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], pressure: null }) };
    },
  },
  removePaintStrokes: {
    cmd: async (s, h) => {
      const { stroke } = await h.run(paintStroke(s.B)) as { stroke: string };
      await h.run(paintStroke(s.B));
      await h.run({ type: 'setProperty', prop: { layer: s.B, path: `paint/${stroke}/end` }, time: sec(1), value: { kind: 'scalar', value: 40 } });
      await h.run({ type: 'setPaintPathAnimated', layer: s.B, stroke, animated: true, time: sec(0) });
      return { type: 'removePaintStrokes', layer: s.B, strokes: [stroke] };
    },
  },
  setPaintOnTransparent: {
    cmd: async (s, h) => {
      await h.run(paintStroke(s.B));
      return { type: 'setPaintOnTransparent', layers: [s.B], on: true };
    },
  },
  setPaintStrokePath: {
    cmd: async (s, h) => {
      const { stroke } = await h.run(paintStroke(s.B)) as { stroke: string };
      await h.run({ type: 'setPaintPathAnimated', layer: s.B, stroke, animated: true, time: sec(0) });
      return { type: 'setPaintStrokePath', layer: s.B, stroke, points: JSON.stringify([{ x: 4, y: 4 }, { x: 8, y: 0 }]), time: sec(1) };
    },
  },
  setPaintPathAnimated: {
    cmd: async (s, h) => {
      const { stroke } = await h.run(paintStroke(s.B)) as { stroke: string };
      return { type: 'setPaintPathAnimated', layer: s.B, stroke, animated: true, time: sec(1) };
    },
  },
  editPathTopology: {
    cmd: async (s, h) => {
      const prop = { layer: s.A, path: `masks/${s.mask}/path` };
      await h.run({ type: 'setAnimated', prop, animated: true, time: 0 });
      return { type: 'editPathTopology', prop, op: { kind: 'insert', segment: 1, u: 0.25, indices: [], atStart: false }, closed: false };
    },
  },
  setShapeOutline: {
    cmd: (s) => ({
      type: 'setShapeOutline', layer: s.B,
      runs: [0, 1].map((i) => ({ vertices: [i * 50, 0, i * 50 + 40, 0, i * 50 + 40, 40], inTangents: [], outTangents: [], closed: i === 0, featherPoints: [], vertexStates: [{ vertex: 1, broken: true }] })),
    }),
  },
  // ── Layer time ──
  setLayerTiming: { cmd: (s) => ({ type: 'setLayerTiming', items: [{ layer: s.A, inPoint: sec(1), outPoint: sec(4) }, { layer: s.B, stretch: -2 }] }) },
  moveLayersInTime: { cmd: (s) => ({ type: 'moveLayersInTime', layers: [s.A], delta: sec(1), ripple: false }) },
  trimLayers: { cmd: (s) => ({ type: 'trimLayers', layers: [s.B], edge: 'out', time: sec(5), ripple: true }) },
  slipLayers: {
    cmd: async (s, h) => {
      await h.run({ type: 'trimLayers', layers: [s.V], edge: 'in', time: sec(1), ripple: false });
      return { type: 'slipLayers', layers: [s.V], delta: sec(-0.5) };
    },
  },
  slideLayer: {
    cmd: async (s, h) => {
      await h.run({ type: 'setLayerTiming', items: [{ layer: s.A, inPoint: 0, outPoint: sec(2) }, { layer: s.B, inPoint: sec(2), outPoint: sec(4) }, { layer: s.T, inPoint: sec(4), outPoint: sec(6) }] });
      return { type: 'slideLayer', layer: s.B, delta: sec(0.5) };
    },
  },
  rollEdit: {
    cmd: async (s, h) => {
      await h.run({ type: 'setLayerTiming', items: [{ layer: s.A, inPoint: 0, outPoint: sec(2) }, { layer: s.B, inPoint: sec(2), outPoint: sec(4) }] });
      return { type: 'rollEdit', left: s.A, right: s.B, delta: sec(0.5) };
    },
  },
  splitLayers: { cmd: (s) => ({ type: 'splitLayers', layers: [s.A, s.B], time: sec(2) }) },
  rippleDeleteLayers: {
    cmd: async (s, h) => {
      await h.run({ type: 'setLayerTiming', items: [{ layer: s.A, inPoint: 0, outPoint: sec(2) }, { layer: s.B, inPoint: sec(2), outPoint: sec(4) }] });
      return { type: 'rippleDeleteLayers', layers: [s.A] };
    },
  },
  editWorkArea: { cmd: (s) => ({ type: 'editWorkArea', comp: s.comp, edit: 'extract', layers: [] }) },
  insertGap: {
    cmd: async (s, h) => {
      await h.run({ type: 'setLayerTiming', items: [{ layer: s.B, inPoint: sec(2), outPoint: sec(4) }] });
      return { type: 'insertGap', comp: s.comp, time: sec(1), duration: sec(1) };
    },
  },
  timeReverseLayers: { cmd: (s) => ({ type: 'timeReverseLayers', layers: [s.B] }) },
  setTimeRemap: { cmd: (s) => ({ type: 'setTimeRemap', layer: s.V, enabled: true }) },
  freezeFrame: { cmd: (s) => ({ type: 'freezeFrame', layer: s.V, time: sec(1), lastFrame: false }) },
  setRetime: { cmd: (s) => ({ type: 'setRetime', layer: s.V, mode: 'speed', speed: 50 }) },
  sequenceLayers: { cmd: (s) => ({ type: 'sequenceLayers', layers: [s.A, s.B, s.T], overlap: sec(0.5), crossfade: true }) },
  // ── Properties ──
  setProperty: { cmd: (s) => ({ type: 'setProperty', prop: pos(s.B), value: { kind: 'vec2', value: { x: 7, y: 8 } }, time: sec(1) }) },
  setProperties: { cmd: (s) => ({ type: 'setProperties', writes: [{ prop: pos(s.A), value: { kind: 'vec2', value: { x: 1, y: 2 } } }, { prop: { layer: s.T, path: 'transform/rotation' }, value: { kind: 'scalar', value: 45 } }] }) },
  resetProperty: {
    cmd: async (s, h) => {
      await h.run({ type: 'setProperty', prop: { layer: s.A, path: 'transform/rotation' }, value: { kind: 'scalar', value: 30 } });
      return { type: 'resetProperty', prop: { layer: s.A, path: 'transform/rotation' } };
    },
  },
  setAnimated: { cmd: (s) => ({ type: 'setAnimated', prop: pos(s.B), animated: false, time: sec(0.5) }) },
  setDimensionsSeparated: { cmd: (s) => ({ type: 'setDimensionsSeparated', layer: s.B, path: 'transform/position', separated: true }) },
  setExpression: { cmd: (s) => ({ type: 'setExpression', prop: { layer: s.A, path: 'transform/rotation' }, source: 'time * 90', enabled: true }) },
  setExpressionEnabled: {
    cmd: async (s, h) => {
      await h.run({ type: 'setExpression', prop: { layer: s.A, path: 'transform/rotation' }, source: 'time * 90', enabled: true });
      return { type: 'setExpressionEnabled', props: [{ layer: s.A, path: 'transform/rotation' }], enabled: false };
    },
  },
  convertExpressionToKeyframes: {
    cmd: async (s, h) => {
      await h.run({ type: 'setExpression', prop: { layer: s.A, path: 'transform/rotation' }, source: 'time * 90', enabled: true });
      return { type: 'convertExpressionToKeyframes', prop: { layer: s.A, path: 'transform/rotation' }, range: { start: 0, duration: sec(1) }, step: 0 };
    },
  },
  linkProperty: { cmd: (s) => ({ type: 'linkProperty', prop: pos(s.A), target: pos(s.B) }) },
  // ── Keyframes ──
  addKeyframes: { cmd: (s) => ({ type: 'addKeyframes', keys: [{ prop: pos(s.B), time: sec(2), spatialIn: [], spatialOut: [], easing: 'easeInOut' }, { prop: { layer: s.T, path: 'text/sourceText' }, time: sec(1), value: { kind: 'textDocument', value: { text: 'Hello', runs: [], paragraphs: [], orientation: 'horizontal', kerning: 'metrics' } }, spatialIn: [], spatialOut: [] }] }) },
  deleteKeyframes: { cmd: (s) => ({ type: 'deleteKeyframes', ids: [s.posKeys[1]!] }) },
  moveKeyframes: { cmd: (s) => ({ type: 'moveKeyframes', ids: [s.posKeys[1]!], delta: sec(1) }) },
  updateKeyframes: { cmd: (s) => ({ type: 'updateKeyframes', patches: [{ id: s.posKeys[0]!, easing: 'bezier', bezier: { x1: 0.3, y1: 0, x2: 0.7, y2: 1 }, continuous: true, roving: false, label: 4, spatialIn: [], spatialOut: [] }] }) },
  scaleKeyframes: { cmd: async (s, h) => ({ type: 'scaleKeyframes', ids: await opacityKeys(h, s.A), pivot: 0, factor: 2 }) },
  reverseKeyframes: { cmd: async (s, h) => ({ type: 'reverseKeyframes', ids: await opacityKeys(h, s.A) }) },
  pasteKeyframes: {
    cmd: async (s, h) => {
      const r = await h.query({ type: 'getKeyframes', props: [pos(s.B)] });
      return { type: 'pasteKeyframes', prop: pos(s.A), time: sec(3), keys: r.sets[0]!.keyframes };
    },
  },
  setKeyframes: {
    cmd: async (s, h) => {
      const r = await h.query({ type: 'getKeyframes', props: [pos(s.B)] });
      const [k0, k1] = r.sets[0]!.keyframes;
      return {
        type: 'setKeyframes', prop: pos(s.B), keys: [
          { ...k0!, value: { kind: 'vec2', value: { x: 5, y: 6 } } },
          { ...k1!, id: '', time: sec(2.5), dims: [{ easing: 'hold', continuous: false }, { easing: 'bezier', bezier: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 }, continuous: true }] },
        ],
      };
    },
  },
  // ── Groups ──
  addEffect: { cmd: (s) => ({ type: 'addEffect', layers: [s.A, s.B], effect: 'drop-shadow', index: 0, params: [] }) },
  addMask: { cmd: (s) => ({ type: 'addMask', layer: s.B, mode: 'subtract', inverted: true, name: 'Hole', path: { vertices: [0, 0, 10, 0, 10, 10], inTangents: [], outTangents: [], closed: true, featherPoints: [], vertexStates: [] } }) },
  addPropertyGroup: { cmd: (s) => ({ type: 'addPropertyGroup', layer: s.T, parent: 'text/animators', matchName: 'ADBE Text Animator', index: 0, init: [], name: 'First' }) },
  removePropertyGroups: { cmd: (s) => ({ type: 'removePropertyGroups', groups: [{ layer: s.A, path: `effects/${s.fx}` }, { layer: s.A, path: `masks/${s.mask}` }, { layer: s.T, path: `text/animators/${s.animator}` }] }) },
  movePropertyGroup: {
    cmd: async (s, h) => {
      await h.run({ type: 'addEffect', layers: [s.A], effect: 'drop-shadow', params: [] });
      return { type: 'movePropertyGroup', group: { layer: s.A, path: `effects/${s.fx}` }, toIndex: 1 };
    },
  },
  duplicatePropertyGroups: { cmd: (s) => ({ type: 'duplicatePropertyGroups', groups: [{ layer: s.A, path: `effects/${s.fx}` }, { layer: s.A, path: `masks/${s.mask}` }] }) },
  setGroupEnabled: { cmd: (s) => ({ type: 'setGroupEnabled', groups: [{ layer: s.A, path: `effects/${s.fx}` }, { layer: s.A, path: `masks/${s.mask}` }, { layer: s.T, path: `text/animators/${s.animator}` }], enabled: false }) },
  renamePropertyGroup: { cmd: (s) => ({ type: 'renamePropertyGroup', group: { layer: s.A, path: `masks/${s.mask}` }, name: 'Window' }) },
  copyPropertyGroups: { cmd: (s) => ({ type: 'copyPropertyGroups', groups: [{ layer: s.A, path: `effects/${s.fx}` }], toLayers: [s.B, s.T] }) },
  applyPreset: { cmd: (s) => ({ type: 'applyPreset', layers: [s.B], preset: 'Fade In', time: sec(1) }) },
  invokeEffectAction: { cmd: (s) => ({ type: 'invokeEffectAction', group: { layer: s.A, path: `effects/${s.fx}` }, action: 'reset' }), fails: 'unsupported' },
  addProperties: { cmd: (s) => ({ type: 'addProperties', parent: { layer: s.T, path: `text/animators/${s.animator}/props` }, names: ['anchorX', 'fillHue', 'axisGRAD', 'color'] }) },
  removeProperties: {
    cmd: async (s, h) => {
      const parent = { layer: s.T, path: `text/animators/${s.animator}/props` };
      await h.run({ type: 'addProperties', parent, names: ['skewAxis', 'axisGRAD'] });
      await h.run({ type: 'setAnimated', prop: { layer: s.T, path: `${parent.path}/skewAxis` }, animated: true, time: 0 });
      return { type: 'removeProperties', props: [{ layer: s.T, path: `${parent.path}/skewAxis` }, { layer: s.T, path: `${parent.path}/axisGRAD` }] };
    },
  },
  // ── Markers ──
  addMarkers: { cmd: (s) => ({ type: 'addMarkers', markers: [{ owner: { comp: s.comp, layer: s.A }, time: sec(1), duration: sec(1), name: 'L', comment: 'c', label: 2 }] }) },
  updateMarkers: { cmd: (s) => ({ type: 'updateMarkers', patches: [{ id: s.marker, name: 'Chapter 1', chapter: 'Intro', protectedRegion: true, time: sec(3) }] }) },
  deleteMarkers: { cmd: (s) => ({ type: 'deleteMarkers', ids: [s.marker] }) },
  moveMarkers: { cmd: (s) => ({ type: 'moveMarkers', ids: [s.marker], delta: sec(-1) }) },
  // ── Jobs / plugins ──
  applyJobResult: { cmd: () => ({ type: 'applyJobResult', job: 'job1' }), fails: 'notFound' },
  setPluginData: { cmd: (s) => ({ type: 'setPluginData', layer: s.A, group: `effects/${s.fx}`, key: 'state', data: new Uint8Array([1, 2, 3, 250]) }) },
};

let h: Harness;
beforeEach(async () => { h = await setupEngine(); });
afterEach(async () => { await h.dispose(); });

const edits = (Object.keys(COMMANDS) as CommandType[]).filter((t) => COMMANDS[t].kind === 'edit');

test('every edit command in the schema has a case', () => {
  expect(edits.filter((t) => !CASES[t])).toEqual([]);
  expect(edits.length).toBe(114);
});

describe.each(edits)('%s', (type) => {
  test('execute → undo restores exactly → redo reapplies exactly', async () => {
    const c = CASES[type]!;
    const s = await buildScene(h);
    const cmd = await c.cmd(s, h);
    const before = h.doc();
    const rev0 = h.engine.documentRevision;
    const res = await h.engine.execute(cmd);
    if (c.fails) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe(c.fails);
      expect(docDiff(before, h.doc())).toEqual([]);
      expect(h.engine.documentRevision).toBe(rev0);
      return;
    }
    if (!res.ok) throw new Error(`${type}: ${res.error.code} ${res.error.message}`);
    const after = h.doc();
    expect(after).not.toBe(before);
    expect(h.engine.documentRevision).toBe(rev0 + 1);
    await h.run({ type: 'undo' });
    expect(docDiff(before, h.doc())).toEqual([]);
    await h.run({ type: 'redo' });
    expect(docDiff(after, h.doc())).toEqual([]);
    await h.run({ type: 'undo' });
    expect(docDiff(before, h.doc())).toEqual([]);
  });
});
