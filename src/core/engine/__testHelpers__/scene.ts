/** A standard scene every command test starts from, built through the engine itself. */

import type { Harness } from './harness';
import { sec } from './harness';

export interface Scene {
  comp: string;
  comp2: string;
  c2layer: string;
  footage: string;
  footage2: string;
  folder: string;
  A: string;
  B: string;
  T: string;
  V: string;
  P: string;
  fx: string;
  mask: string;
  animator: string;
  marker: string;
  posKeys: string[];
}

export async function buildScene(h: Harness): Promise<Scene> {
  const comp = 'comp_root';
  const { items: [footage, footage2] } = await h.run({
    type: 'importFiles',
    files: [
      { path: 'C:/media/clip.mp4', asSequence: false, createComposition: false },
      { path: 'C:/media/clip2.mp4', asSequence: false, createComposition: false },
    ],
  });
  const { item: folder } = await h.run({ type: 'createFolder', name: 'Footage' });
  const mk = async (kind: 'solid' | 'shape' | 'text' | 'video' | 'null', name: string, source?: string): Promise<string> =>
    (await h.run({ type: 'createLayer', comp, kind, name, ...(source ? { source } : {}), init: [] })).layer;
  const P = await mk('null', 'P');
  const V = await mk('video', 'V', footage);
  const T = await mk('text', 'T');
  const B = await mk('shape', 'B');
  const A = await mk('solid', 'A');
  const { ids: posKeys } = await h.run({
    type: 'addKeyframes',
    keys: [
      { prop: { layer: B, path: 'transform/position' }, time: 0, value: { kind: 'vec2', value: { x: 100, y: 100 } }, spatialIn: [], spatialOut: [] },
      { prop: { layer: B, path: 'transform/position' }, time: sec(1), value: { kind: 'vec2', value: { x: 300, y: 200 } }, spatialIn: [], spatialOut: [] },
    ],
  });
  const { groups: [fxPath] } = await h.run({ type: 'addEffect', layers: [A], effect: 'glow', params: [] });
  const { groups: [maskPath] } = await h.run({
    type: 'addMask', layer: A, mode: 'add', inverted: false,
    path: { vertices: [0, 0, 100, 0, 100, 100, 0, 100], inTangents: [], outTangents: [], closed: true, featherPoints: [], vertexStates: [] },
  });
  const { groups: [animPath] } = await h.run({ type: 'addPropertyGroup', layer: T, parent: 'text/animators', matchName: 'ADBE Text Animator', init: [] });
  const { item: comp2 } = await h.run({ type: 'createComposition', settings: { name: 'C2', width: 800, height: 600 }, fromItems: [] });
  const { layer: c2layer } = await h.run({ type: 'createLayer', comp: comp2, kind: 'solid', name: 'C2 solid', init: [] });
  const { ids: [marker] } = await h.run({ type: 'addMarkers', markers: [{ owner: { comp }, time: sec(2), duration: 0, name: 'M1', comment: '', label: 0 }] });
  await h.run({ type: 'setWorkArea', comp, range: { start: sec(1), duration: sec(3) } });
  return {
    comp, comp2, c2layer, footage: footage!, footage2: footage2!, folder, A, B, T, V, P,
    fx: fxPath!.split('/')[1]!, mask: maskPath!.split('/')[1]!, animator: animPath!.split('/')[2]!, marker: marker!, posKeys,
  };
}
