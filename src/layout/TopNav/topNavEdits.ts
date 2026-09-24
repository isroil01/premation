/**
 * The top bar's document edits through the engine API (B3z,
 * docs/B3_PATTERNS.md): the Animate menu's text-animator rigs and the Image
 * Sequence picker. One user action = one undo entry.
 */

import type { Command, CubicBezier, Easing, PropRef } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { reportEngineError } from '@core/engine/uiEdits';
import { insertBuiltLayers } from '@core/engine/offDocument';
import { isLayer } from '@core/engine/doc';
import { compTime, paths, values } from '@core/engine/propRefs';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { makeNode } from '@core/scene/sceneInsert';
import { detectImageSequence } from '@core/scene/imageSequence';
import { activeInsertTarget } from '@layout/Scene/activeInsertTarget';

// ── Text animator rigs (Animate ▸ Bounce In Words, …) ─────────────────

interface RigKey {
  value: number;
  easing: Easing;
  bezier?: CubicBezier;
}

/** A one-click text rig: a new animator, its range selector's options, two keys on one selector param. */
export interface TextRig {
  label: string;
  /** The animator's property values (`text/animators/<id>/props/<name>`). */
  props: Readonly<Record<string, number>>;
  /** The range selector's options (Based On / Shape choices, Smoothness %). */
  basedOn: 'characters' | 'words';
  shape: 'square' | 'rampDown';
  smoothness?: number;
  /** The keyed selector parameter and its keys at the playhead and `durationSec` later. */
  param: 'start' | 'offset';
  from: RigKey;
  to: RigKey;
}

const bez = (x1: number, y1: number, x2: number, y2: number): CubicBezier => ({ x1, y1, x2, y2 });

/** The Animate menu's rigs — the legacy assistants' values (keyframeAssistants.ts). */
export const TEXT_RIGS = {
  bounceInWords: {
    label: 'Bounce In Words',
    props: { y: -80, opacity: 0, scale: 50, scaleY: 50 },
    basedOn: 'words', shape: 'rampDown', param: 'offset',
    from: { value: -100, easing: 'bezier', bezier: bez(0.175, 0.885, 0.32, 1.275) },
    to: { value: 100, easing: 'linear' },
  },
  spinFadeCharacters: {
    label: 'Spin & Fade Characters',
    props: { rotation: 90, opacity: 0, scale: 150, scaleY: 150 },
    basedOn: 'characters', shape: 'rampDown', param: 'offset',
    from: { value: -100, easing: 'bezier', bezier: bez(0.16, 1, 0.3, 1) },
    to: { value: 100, easing: 'linear' },
  },
  trackingReveal: {
    label: 'Tracking Reveal',
    props: { tracking: 40, opacity: 0 },
    basedOn: 'characters', shape: 'square', param: 'start',
    from: { value: 0, easing: 'bezier', bezier: bez(0.4, 0, 0.2, 1) },
    to: { value: 100, easing: 'linear' },
  },
} satisfies Record<string, TextRig>;

/**
 * Build a text rig as ONE undo entry: `addPropertyGroup` on `text/animators`
 * with the animator's values as `init`, then — its range selector's id minted
 * by the engine, so inside the same engine gesture — the selector's options and
 * the two keys (comp time `seconds` and `seconds + durationSec`). Resolves
 * whether the rig was built (a refusal is toasted and nothing is left behind).
 */
export async function textRigEdit(nodeId: string, rig: TextRig, seconds: number, durationSec = 1.5): Promise<boolean> {
  if (!isLayer(nodeId)) return false;
  const label = rig.label;
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return false;
  }
  let ok = false;
  const added = await client.execute({
    type: 'addPropertyGroup', layer: nodeId, parent: paths.animatorsGroup(), matchName: 'ADBE Text Animator',
    init: Object.entries(rig.props).map(([name, v]) => ({ path: `props/${name}`, value: values.scalar(v) })),
  });
  if (!added.ok) reportEngineError(label, added.error);
  else {
    const animatorId = ((added.value as { groups?: string[] }).groups?.[0] ?? '').split('/')[2] ?? '';
    // The new animator's range selector, asked of the engine (a query for a write, B4_MIRROR.md §2).
    const selBase = `${paths.animatorGroup(animatorId)}/selectors/`;
    const tree = await client.query({ type: 'getPropertyTree', layer: nodeId, path: `${paths.animatorGroup(animatorId)}/selectors`, depth: 0 });
    const selPath = tree.ok ? tree.value.nodes.find((n) => n.path.startsWith(selBase) && !n.path.slice(selBase.length).includes('/'))?.path : undefined;
    const selectorId = selPath?.slice(selBase.length);
    if (!selectorId) reportEngineError(label, { code: 'internal', message: 'the new animator has no range selector' });
    else {
      const at = (p: string): PropRef => ({ layer: nodeId, path: paths.selectorParam(animatorId, selectorId, p) });
      const cmds: Command[] = [
        { type: 'setProperty', prop: at('basedOn'), value: values.choice(rig.basedOn) },
        { type: 'setProperty', prop: at('shape'), value: values.choice(rig.shape) },
        ...(rig.smoothness !== undefined ? [{ type: 'setProperty', prop: at('smoothness'), value: values.scalar(rig.smoothness) } as Command] : []),
        {
          type: 'addKeyframes',
          keys: [
            { prop: at(rig.param), time: compTime(seconds), value: values.scalar(rig.from.value), easing: rig.from.easing, ...(rig.from.bezier ? { bezier: rig.from.bezier } : {}), spatialIn: [], spatialOut: [] },
            { prop: at(rig.param), time: compTime(seconds + durationSec), value: values.scalar(rig.to.value), easing: rig.to.easing, ...(rig.to.bezier ? { bezier: rig.to.bezier } : {}), spatialIn: [], spatialOut: [] },
          ],
        },
      ];
      const res = await client.batch(label, cmds);
      if (!res.ok) reportEngineError(label, res.error);
      else ok = true;
    }
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  return ok;
}

// ── Image sequence from picked files ──────────────────────────────────

/**
 * Insert picked image files as ONE image-sequence layer (the legacy
 * `insertImageSequence`: the frames are object URLs of the files, the layer is
 * sized to the first frame and centred in the composition) — built
 * off-document and sent as one `pasteLayers`. The frames are layer data, not
 * project items, so nothing is imported. Resolves false when the files are
 * not a numbered sequence (the object URLs are released).
 */
export async function insertImageSequenceEdit(files: readonly File[], fps = 30): Promise<boolean> {
  if (files.length < 2) return false;
  const detected = detectImageSequence(files.map((f) => f.name));
  if (!detected) return false;
  const byName = new Map(files.map((f) => [f.name, f]));
  const frames: string[] = [];
  for (const n of detected.frames) {
    const f = byName.get(n);
    if (f) frames.push(URL.createObjectURL(f));
  }
  const release = (): false => {
    for (const url of frames) URL.revokeObjectURL(url);
    return false;
  };
  if (frames.length < 2) return release();
  const dims = await new Promise<{ w: number; h: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.width, h: img.height });
    img.onerror = () => resolve({ w: 400, h: 400 });
    img.src = frames[0]!;
  });
  const target = activeInsertTarget();
  if (!target) return release();
  const { comp } = target;
  const into = target.parent ?? comp;
  const info = await engine().query({ type: 'getComposition', comp });
  const size = info.ok ? info.value.comp.settings : { width: 1920, height: 1080 };
  const ids = await insertBuiltLayers(`Insert ${detected.base}`, comp, () => {
    const node = makeNode('image', detected.base);
    const t = node.components.find((c) => c.type === 'Transform');
    if (t) {
      Object.assign(t.props, { width: dims.w, height: dims.h, src: frames[0], x: size.width / 2, y: size.height / 2 });
      node.transform.position.x = size.width / 2;
      node.transform.position.y = size.height / 2;
    }
    defaultSceneGraph.addChild(into, node);
    defaultSceneGraph.setImageSequence(node.id, { frames, fps });
  });
  if (!ids || ids.length === 0) return release();
  return true;
}
