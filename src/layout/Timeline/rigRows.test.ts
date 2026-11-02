/**
 * C2 (rig keyframing UX), the pure half: how the Rig section's rows nest
 * (rigRowGroups), how a pin's one-track Position gets its X / Y views
 * (trackIndex), and how the row projection's rig rows merge with keys
 * (buildPropertyRows over synthetic sources — no engine). The engine side of
 * the same rows is pinned in native/engine/tests/test_ptree_rig.cpp.
 */

import type { Keyframe, PropertyInfo, TimelineRow } from '@motion/engine-api';
import { membersOf, pinPositionAxes, trackRefIn, type MirrorTreeLike } from '@core/mirror/trackIndex';
import { groupForPropWith, isRigTrack, TIMELINE_GROUP_ORDER } from '@core/timeline/propertyTree';
import { buildPropertyRows, type PropertyRowSources } from './buildPropertyRows';
import { groupRigRows, nestedIndent, rigNodeCount, rigOwnerOfRow } from './rigRowGroups';
import type { TimelinePropertyTrack } from './TimelineModel';

const L = 'layer_1';

function prop(path: string, name: string, matchName: string, valueType: PropertyInfo['valueType'], dimensions: number, extra: Partial<PropertyInfo> = {}): PropertyInfo {
  return {
    path, name, matchName, kind: 'property', valueType, animatable: true, animated: false, dimensions, separated: false,
    enabled: true, choices: [], unit: '', expression: '', expressionEnabled: false, expressionError: '', keyframeCount: 0,
    children: [], hidden: false, memberExpressions: [], ...extra,
  };
}

function group(path: string, name: string, children: string[]): PropertyInfo {
  return { ...prop(path, name, name, 'scalar', 0), kind: 'group', children };
}

function key(id: string, time: number, value: Keyframe['value']): Keyframe {
  return { id, time, value, easing: 'linear', continuous: true, roving: false, spatialInterp: 'linear', spatialIn: [], spatialOut: [], label: 0, dims: [] };
}

/** A layer with one pin and one bone, as the mirror tree names them. */
function tree(): MirrorTreeLike {
  const nodes = new Map<string, PropertyInfo>();
  const add = (p: PropertyInfo): void => { nodes.set(p.path, p); };
  add(group('puppet', 'Puppet', ['puppet/mesh', 'puppet/pins']));
  add(group('puppet/pins', 'Deform', ['puppet/pins/pin_1']));
  add(group('puppet/pins/pin_1', 'Left Hand', ['puppet/pins/pin_1/position', 'puppet/pins/pin_1/rotation']));
  add(prop('puppet/pins/pin_1/position', 'Position', 'ADBE FreePin3 PosPin Position', 'vec2', 2));
  add(prop('puppet/pins/pin_1/rotation', 'Rotation', 'ADBE FreePin3 PosPin Rotation', 'scalar', 1, { unit: '°' }));
  add(prop('puppet/mesh/density', 'Density', 'ADBE FreePin3 Mesh Density', 'scalar', 1, { animatable: false }));
  add(group('skeleton', 'Skeleton', ['skeleton/bones']));
  add(group('skeleton/bones', 'Bones', ['skeleton/bones/b1']));
  add(group('skeleton/bones/b1', 'Arm', ['skeleton/bones/b1/position', 'skeleton/bones/b1/rotation', 'skeleton/bones/b1/ik']));
  add(prop('skeleton/bones/b1/position', 'Position', 'Premation Bone Position', 'vec2', 2));
  add(prop('skeleton/bones/b1/rotation', 'Rotation', 'Premation Bone Rotation', 'scalar', 1, { unit: '°' }));
  add(prop('skeleton/bones/b1/ik/target', 'Target', 'Premation IK Target', 'vec2', 2));
  return { layer: L, nodes };
}

/** The engine's row projection for that layer (what ptree.cpp `rig_rows` emits). */
function projection(): TimelineRow[] {
  const row = (p: Partial<TimelineRow> & Pick<TimelineRow, 'prop' | 'label' | 'members'>): TimelineRow =>
    ({ group: 'rig', valueProps: p.members, maskTrack: false, ...p });
  return [
    row({ prop: 'puppet/mesh/density', label: 'Density', members: [], valueProps: ['puppet/mesh/density'] }),
    row({ prop: 'puppet.pin_1.position', label: 'Position', members: ['puppet.pin_1.position'], valueProps: ['puppet.pin_1.position.x', 'puppet.pin_1.position.y'], valueUnit: 'px' }),
    row({ prop: 'puppet.pin_1.rotation', label: 'Rotation', members: ['puppet.pin_1.rotation'], valueUnit: '°' }),
    row({ prop: 'skeleton/bones/b1/position', label: 'Position', members: ['bone.b1.x', 'bone.b1.y'], merged: 'skeleton/bones/b1/position' }),
    row({ prop: 'bone.b1.rotation', label: 'Rotation', members: ['bone.b1.rotation'], valueUnit: '°' }),
    row({ prop: 'skeleton/bones/b1/ik/target', label: 'IK Goal', members: ['ikTarget.b1.x', 'ikTarget.b1.y'], merged: 'skeleton/bones/b1/ik/target' }),
  ];
}

function sources(keys: Record<string, Keyframe[]> = {}): PropertyRowSources {
  return { layer: undefined, tree: tree(), keys: new Map(Object.entries(keys)), rows: projection() };
}

describe('rig tracks and the rig group', () => {
  it('names the rig keyframe tracks and files them under the rig section, between Effects and Transform', () => {
    for (const t of ['puppet.pin_1.position', 'bone.b1.rotation', 'ikTarget.b1.x', 'ikPole.b1.y', 'ikMode.b1']) {
      expect(isRigTrack(t)).toBe(true);
      expect(groupForPropWith(t)).toBe('rig');
    }
    expect(isRigTrack('puppetX')).toBe(false);
    expect(groupForPropWith('rotation')).toBe('transform');
    expect(TIMELINE_GROUP_ORDER.effects).toBeLessThan(TIMELINE_GROUP_ORDER.rig);
    expect(TIMELINE_GROUP_ORDER.rig).toBeLessThan(TIMELINE_GROUP_ORDER.transform);
  });
});

describe('a pin Position track has X and Y views', () => {
  it('keeps the one data track as the member and answers <track>.x / .y as its two dimensions', () => {
    const tr = tree();
    const info = tr.nodes.get('puppet/pins/pin_1/position')!;
    expect(membersOf(info)).toEqual(['puppet.pin_1.position']);
    const [x, y] = pinPositionAxes('puppet.pin_1.position');
    expect(trackRefIn(tr, x)).toMatchObject({ path: 'puppet/pins/pin_1/position', member: 0, members: [x, y] });
    expect(trackRefIn(tr, y)).toMatchObject({ path: 'puppet/pins/pin_1/position', member: 1 });
    // The bare track and the API path still resolve (the stopwatch, the pick whip).
    expect(trackRefIn(tr, 'puppet.pin_1.position')?.member).toBe(0);
    expect(trackRefIn(tr, 'puppet/pins/pin_1/position')?.member).toBe(0);
    // A bone's Position is two real tracks: no views are invented for it.
    expect(trackRefIn(tr, 'bone.b1.x.x')).toBeNull();
  });
});

describe('buildPropertyRows over the rig projection', () => {
  const byProp = (rows: TimelinePropertyTrack[]): Map<string, TimelinePropertyTrack> => new Map(rows.map((r) => [r.prop, r]));

  it('shows every pin and bone property unlit, with a stopwatch on its tracks and value fields', () => {
    const rows = byProp(buildPropertyRows(L, sources()));
    const pos = rows.get('puppet.pin_1.position')!;
    expect(pos.group).toBe('rig');
    expect(pos.animated).toBe(false);
    expect(pos.stopwatchProps).toEqual(['puppet.pin_1.position']);
    expect(pos.valueProps).toEqual(['puppet.pin_1.position.x', 'puppet.pin_1.position.y']);
    expect(pos.valueUnit).toBe('px');
    const bonePos = rows.get('skeleton/bones/b1/position')!;
    expect(bonePos.stopwatchProps).toEqual(['bone.b1.x', 'bone.b1.y']);
    expect(bonePos.valueProps).toEqual(['bone.b1.x', 'bone.b1.y']);
    // The mesh setting: a value, no stopwatch.
    const density = rows.get('puppet/mesh/density')!;
    expect(density.stopwatchProps).toBeUndefined();
    expect(density.valueProps).toEqual(['puppet/mesh/density']);
  });

  it('keeps a keyed pin Position as ONE row drawing the data track\'s keys, its X / Y fields intact', () => {
    const k = [key('k1', 0, { kind: 'vec2', value: { x: 10, y: 20 } }), key('k2', 705600000, { kind: 'vec2', value: { x: 30, y: 40 } })];
    const rows = buildPropertyRows(L, sources({ 'puppet/pins/pin_1/position': k }));
    const pos = rows.filter((r) => r.prop === 'puppet.pin_1.position');
    expect(pos).toHaveLength(1);
    expect(pos[0]!.animated).toBeUndefined();
    expect(pos[0]!.label).toBe('Position');
    expect(pos[0]!.keyframes.map((kf) => kf.time)).toEqual([0, 1]);
    expect(pos[0]!.valueProps).toEqual(['puppet.pin_1.position.x', 'puppet.pin_1.position.y']);
    expect(rows.filter((r) => r.label === 'Position X')).toHaveLength(0);
    // Nothing else split or lit.
    expect(rows.find((r) => r.prop === 'puppet.pin_1.rotation')!.animated).toBe(false);
  });

  it('keeps a keyed bone Position / IK goal as one merged row on both tracks (as Transform Position does)', () => {
    const k = [key('k1', 0, { kind: 'vec2', value: { x: 1, y: 2 } })];
    const rows = buildPropertyRows(L, sources({ 'skeleton/bones/b1/position': k, 'skeleton/bones/b1/ik/target': k }));
    const bone = rows.filter((r) => r.prop === 'skeleton/bones/b1/position');
    expect(bone).toHaveLength(1);
    expect(bone[0]!.keyframes).toHaveLength(1);
    expect(bone[0]!.stopwatchProps).toEqual(['bone.b1.x', 'bone.b1.y']);
    expect(bone[0]!.label).toBe('Position');
    expect(rows.filter((r) => r.prop === 'bone.b1.x' || r.prop === 'bone.b1.y')).toHaveLength(0);
    const goal = rows.find((r) => r.prop === 'skeleton/bones/b1/ik/target')!;
    expect(goal.label).toBe('IK Goal');
    expect(goal.keyframes).toHaveLength(1);
  });
});

describe('the Rig section nests Puppet ▸ Pins ▸ <pin> and Skeleton ▸ Bones ▸ <bone>', () => {
  it('reads the owner off the row name, whatever the label', () => {
    expect(rigOwnerOfRow('puppet.pin_1.rotation')).toEqual({ root: 'puppet', part: 'pin', id: 'pin_1' });
    expect(rigOwnerOfRow('puppet/mesh/density')).toEqual({ root: 'puppet', part: 'mesh' });
    expect(rigOwnerOfRow('bone.b1.rotation')).toEqual({ root: 'skeleton', part: 'bone', id: 'b1' });
    expect(rigOwnerOfRow('skeleton/bones/b1/position')).toEqual({ root: 'skeleton', part: 'bone', id: 'b1' });
    expect(rigOwnerOfRow('skeleton/bones/b1/ik/target')).toEqual({ root: 'skeleton', part: 'bone', id: 'b1' });
    expect(rigOwnerOfRow('ikTarget.b1.x')).toEqual({ root: 'skeleton', part: 'bone', id: 'b1' });
    expect(rigOwnerOfRow('ikMode.b1')).toEqual({ root: 'skeleton', part: 'bone', id: 'b1' });
    expect(rigOwnerOfRow('skeleton/mesh/density')).toEqual({ root: 'skeleton', part: 'mesh' });
    expect(rigOwnerOfRow('opacity')).toBeNull();
  });

  it('groups the rows by part, naming pins and bones from the tree, in first-appearance order', () => {
    const rows = buildPropertyRows(L, sources());
    const roots = groupRigRows(rows, tree());
    expect(roots.map((r) => r.key)).toEqual(['rig/puppet', 'rig/skeleton']);
    const puppet = roots[0]!;
    expect(puppet.children.map((c) => c.key)).toEqual(['rig/puppet/mesh', 'rig/puppet/pins']);
    const pin = puppet.children[1]!.children[0]!;
    expect(pin.key).toBe('rig/puppet/pins/pin_1');
    expect(pin.label).toBe('Left Hand');
    expect(pin.props.map((p) => p.prop)).toEqual(['puppet.pin_1.position', 'puppet.pin_1.rotation']);
    expect(rigNodeCount(puppet)).toBe(3);
    const bone = roots[1]!.children[0]!.children[0]!;
    expect(bone.label).toBe('Arm');
    expect(bone.props.map((p) => p.label)).toEqual(['Position', 'Rotation', 'IK Goal']);
    // A bone the tree does not name reads as its id.
    const loose = groupRigRows([{ prop: 'bone.b9.rotation', label: 'Rotation', keyframes: [] }], undefined);
    expect(loose[0]!.children[0]!.children[0]!.label).toBe('b9');
  });

  it('indents one step per level under the section', () => {
    expect(nestedIndent('rig')).toBe(0);
    expect(nestedIndent('rig/puppet')).toBe(14);
    expect(nestedIndent('rig/puppet/pins/pin_1')).toBe(42);
    expect(nestedIndent('effects/fx_1')).toBe(14);
    expect(nestedIndent('effects/fx_1/selections')).toBe(28);
  });
});
