/**
 * The layer property tree — AE's twirl-down structure.
 *
 * The load-bearing claim is that a row EXISTS BEFORE it is animated. Every
 * assertion here runs on a layer with no keyframes at all, because that is the
 * state the old timeline could not express: it derived its rows from the
 * animated tracks, so a Glow's radius had no row until something else had
 * already keyframed it.
 *
 * The second claim is that a row only promises what the engine can keep. A row
 * with `members` says "my stopwatch keys these paths and the renderer will read
 * them"; a registry entry flagged `keyframeable: false` gets a value row and
 * no members. (Material Options carried that flag until `readNodeMaterial`
 * learned to take the frame's animated values; none does today.)
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { addEffect, getNodeEffects, effectPropPath } from '@core/effects/effects';
import { setLayerStyles } from '@core/effects/layerStyles';
import { addPathOp, defaultPathOp } from '@core/scene/pathOps';
import { addMaskPath, rectangleMask, ellipseMask } from '@core/effects/mask';
import { addTextAnimator } from '@core/text/textAnimators';
import type { SceneNode } from '@core/types';
import { buildStaticPropertyTree, groupForProp, MASK_ANIM_PROP } from './propertyTree';

function node(id: string, kind = 'shape', extra: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, ...extra } },
      { id: `${id}_s`, type: 'Style', props: { fill: '#fff', opacity: 100 } },
      { id: `${id}_g`, type: 'Geometry', props: { width: 200, height: 100 } },
    ],
  };
}

/** A text layer: the Text component is what makes animators legal. */
function textNode(id: string): SceneNode {
  const n = node(id, 'text');
  n.components.push({ id: `${id}_c`, type: 'Text', props: { content: 'Hi', fontSize: 32, opacity: 100 } });
  return n;
}

const props = (nodeId: string): string[] => buildStaticPropertyTree(nodeId).map((r) => r.prop);
const labels = (nodeId: string): string[] => buildStaticPropertyTree(nodeId).map((r) => r.label);
const groups = (nodeId: string): string[] => [...new Set(buildStaticPropertyTree(nodeId).map((r) => r.group))];

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultAnimation.clear();
  defaultSceneGraph.addNode(node('a'));
});

describe('the tree exists before anything is animated', () => {
  it('gives an untouched layer its whole Transform group', () => {
    expect(defaultAnimation.tracksFor('a')).toHaveLength(0);
    expect(labels('a')).toEqual(
      expect.arrayContaining(['Anchor Point', 'Position', 'Scale', 'Rotation', 'Opacity']),
    );
  });

  it('lists every keyframeable parameter of an applied effect', () => {
    addEffect('a', 'glow');
    const id = getNodeEffects('a')[0]!.id;
    const rows = buildStaticPropertyTree('a').filter((r) => r.group === 'effects');
    expect(rows.length).toBeGreaterThan(0);
    // Every effect row names a real `effect.<id>.<key>` path...
    for (const r of rows) expect(r.prop.startsWith(`effect.${id}.`)).toBe(true);
    // ...and its stopwatch keys exactly that path (or a colour's four channels).
    for (const r of rows) {
      expect(r.members.length === 1 || r.members.length === 4).toBe(true);
      for (const m of r.members) expect(m.startsWith(`effect.${id}.`)).toBe(true);
    }
  });

  it('lists a layer style the same way, under its own group', () => {
    setLayerStyles('a', { dropShadow: { enabled: true, color: '#000', opacity: 0.5, distance: 8, angle: 135, blur: 4 } });
    const rows = buildStaticPropertyTree('a').filter((r) => r.group === 'styles');
    const paths = rows.flatMap((r) => r.members);
    expect(paths).toEqual(expect.arrayContaining([effectPropPath('layerstyle:dropShadow', 'distance')]));
    // The compiled effect's param name, not the style's field name — that is
    // the path the renderer samples.
    expect(paths).toEqual(expect.arrayContaining([effectPropPath('layerstyle:dropShadow', 'softness')]));
  });

  it('lists a path operator parameter by parameter', () => {
    addPathOp('a', { ...defaultPathOp(), id: 'op_1', type: 'trim' });
    const rows = buildStaticPropertyTree('a').filter((r) => r.prop.startsWith('pathop.'));
    expect(rows.map((r) => r.label)).toEqual(
      expect.arrayContaining(['Trim Paths Start', 'Trim Paths End', 'Trim Paths Offset']),
    );
    expect(rows.every((r) => r.group === 'contents')).toBe(true);
  });

  it('picks the layer geometry up from its components', () => {
    expect(labels('a')).toEqual(expect.arrayContaining(['Width', 'Height']));
  });

  it('gives a masked layer a shape row whose stopwatch routes to the mask store', () => {
    addMaskPath('a', rectangleMask(100, 50));
    const shape = buildStaticPropertyTree('a').find((r) => r.maskTrack)!;
    // The SHAPE is a whole-mask snapshot track, not a numeric one: its
    // stopwatch names no engine members at all.
    expect(shape.members).toHaveLength(0);
    expect(shape.prop).toBe(MASK_ANIM_PROP);
    expect(shape.group).toBe('masks');
  });

  it('says how many paths a multi-path mask has, since they share one track', () => {
    addMaskPath('a', rectangleMask(100, 50));
    addMaskPath('a', ellipseMask(80, 80));
    expect(buildStaticPropertyTree('a').find((r) => r.maskTrack)!.label).toBe('Mask Shape (2 paths)');
  });

  it('lists a text animator property by property, with its selector', () => {
    defaultSceneGraph.addNode(textNode('t'));
    addTextAnimator('t');
    const rows = buildStaticPropertyTree('t').filter((r) => r.group === 'text');
    const paths = rows.flatMap((r) => r.members);
    expect(paths).toEqual(expect.arrayContaining(['ta.0.tracking', 'ta.0.opacity']));
    // Selector 0's window params keep their legacy flat spelling — the path the
    // preset library and every existing project already animate.
    expect(paths).toEqual(expect.arrayContaining(['ta.0.start', 'ta.0.end', 'ta.0.offset']));
  });
});

describe('a row only promises what the engine keeps', () => {
  it('lists every Material Options row on a 3D layer before anything is keyed', () => {
    // 3D is "carries a depth prop", not a `threeD` flag — match enable3D.
    defaultSceneGraph.addNode(node('m', 'shape', { z: 0 }));
    const rows = buildStaticPropertyTree('m').filter((r) => r.group === 'material');
    expect(rows.map((r) => r.prop)).toEqual([
      'acceptsLights', 'ambient', 'diffuse', 'specular', 'shininess', 'metal',
      'castsShadows', 'acceptsShadows', 'lightTransmission', 'roughness',
    ]);
    for (const r of rows) expect(r.members).toEqual([r.prop]);
  });

  it('does not list Material Options on a 2D layer', () => {
    expect(buildStaticPropertyTree('a').some((r) => r.group === 'material')).toBe(false);
  });

  it('collapses Position into one row, and splits it when dimensions separate', () => {
    const merged = buildStaticPropertyTree('a').find((r) => r.merged);
    expect(merged?.members).toEqual(['x', 'y']);

    defaultSceneGraph.addNode(node('s', 'shape', { separateDimensions: true }));
    expect(props('s')).toEqual(expect.arrayContaining(['x', 'y']));
    expect(buildStaticPropertyTree('s').some((r) => r.merged)).toBe(false);
  });

  it('leaves a camera the transform properties a camera actually has', () => {
    defaultSceneGraph.addNode(node('cam', 'camera'));
    const l = labels('cam');
    expect(l).toEqual(expect.arrayContaining(['Position', 'Orientation']));
    expect(l).not.toEqual(expect.arrayContaining(['Anchor Point', 'Scale']));
  });

  it('gives an audio layer a level row and no transform', () => {
    defaultSceneGraph.addNode(node('snd', 'audio'));
    const rows = buildStaticPropertyTree('snd');
    expect(rows.find((r) => r.group === 'audio')?.members).toEqual(['audioLevelDb']);
    expect(rows.some((r) => r.group === 'transform')).toBe(false);
  });
});

describe('groupForProp places what the tree did not describe', () => {
  it('separates a layer style from the effects it compiles to', () => {
    expect(groupForProp('effect.fx_1.radius')).toBe('effects');
    expect(groupForProp('effect.layerstyle:dropShadow.distance')).toBe('styles');
  });

  it('places structured paths by their prefix, not by their label', () => {
    expect(groupForProp('pathop.op_1.amount')).toBe('contents');
    expect(groupForProp('ta.0.blur')).toBe('text');
    expect(groupForProp(MASK_ANIM_PROP)).toBe('masks');
    expect(groupForProp('audioLevelDb')).toBe('audio');
    // A text animator's Blur and a Gaussian Blur's radius no longer land in one
    // bucket, which is what the label-substring guess did.
    expect(groupForProp('x')).toBe('transform');
  });
});

describe('the tree is only as big as the layer', () => {
  it('says nothing about a layer that has no effects, styles, masks or ops', () => {
    expect(groups('a')).toEqual(expect.not.arrayContaining(['effects', 'styles', 'masks', 'text']));
  });
});

describe('mask property tracks', () => {
  it('lists Feather, Opacity and Expansion per mask path after the shape row', () => {
    addMaskPath('a', { ...rectangleMask(100, 50), id: 'mk_1' });
    const rows = buildStaticPropertyTree('a').filter((r) => r.group === 'masks');
    expect(rows[0]!.maskTrack).toBe(true);
    expect(rows.slice(1).map((r) => r.prop)).toEqual(['mask.mk_1.feather', 'mask.mk_1.opacity', 'mask.mk_1.expansion']);
    expect(rows.slice(1).map((r) => r.label)).toEqual(['Mask 1 Feather', 'Mask 1 Opacity', 'Mask 1 Expansion']);
    for (const r of rows.slice(1)) expect(r.members).toEqual([r.prop]);
  });
});
