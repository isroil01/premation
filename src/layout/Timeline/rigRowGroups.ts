/**
 * The Rig section of a layer's timeline rows, After Effects' way:
 *
 *     Puppet
 *       Mesh            density, expansion, rotation refinement
 *       Pins
 *         Pin 1         Position / Rotation / Scale / Stiffness / Overlap
 *         Pin 2         …
 *     Skeleton
 *       Mesh
 *       Bones
 *         Arm           Position / Rotation / Scale / IK Goal / IK Pole / IK/FK
 *
 * Pure: the caller hands in the section's rows (the engine's row projection,
 * `buildPropertyRows`) and the layer's mirror tree, which names each pin and
 * bone (the `puppet/pins/<pin>` / `skeleton/bones/<bone>` group nodes). The
 * owner of a row is read off its prop — a rig TRACK (`puppet.<pin>.rotation`,
 * `bone.<id>.rotation`, `ikTarget.<id>.x`, …) or a rig API path
 * (`puppet/mesh/density`, `skeleton/bones/<id>/position`) — so nothing here
 * depends on the row's label.
 */

import type { IconName } from '@components/Icon';
import { t } from '@core/i18n';
import type { MirrorTreeLike } from '@core/mirror/trackIndex';
import type { TimelinePropertyTrack } from './TimelineModel';

export interface RigRowNode {
  /** The category key under the `rig` section (`rig/puppet/pins/<pin>`); one twirl state per key. */
  key: string;
  label: string;
  icon: IconName;
  /** Rows directly under this twirl, in projection order. */
  props: TimelinePropertyTrack[];
  children: RigRowNode[];
}

type Owner =
  | { root: 'puppet' | 'skeleton'; part: 'mesh' }
  | { root: 'puppet'; part: 'pin'; id: string }
  | { root: 'skeleton'; part: 'bone'; id: string }
  | { root: 'puppet' | 'skeleton'; part: 'loose' };

/** Which rig part a row belongs to. Null for a row that is not a rig row. */
export function rigOwnerOfRow(prop: string): Owner | null {
  let m = /^puppet\/mesh\//.exec(prop);
  if (m) return { root: 'puppet', part: 'mesh' };
  m = /^puppet\.([^.]+)\./.exec(prop);
  if (m) return { root: 'puppet', part: 'pin', id: m[1]! };
  m = /^puppet\/pins\/([^/]+)\//.exec(prop);
  if (m) return { root: 'puppet', part: 'pin', id: m[1]! };
  if (/^puppet(\/|$)/.test(prop)) return { root: 'puppet', part: 'loose' };
  m = /^skeleton\/mesh\//.exec(prop);
  if (m) return { root: 'skeleton', part: 'mesh' };
  m = /^bone\.([^.]+)\./.exec(prop);
  if (m) return { root: 'skeleton', part: 'bone', id: m[1]! };
  m = /^skeleton\/bones\/([^/]+)\//.exec(prop);
  if (m) return { root: 'skeleton', part: 'bone', id: m[1]! };
  m = /^ik(?:Target|Pole)\.([^.]+)\./.exec(prop);
  if (m) return { root: 'skeleton', part: 'bone', id: m[1]! };
  m = /^ikMode\.([^.]+)$/.exec(prop);
  if (m) return { root: 'skeleton', part: 'bone', id: m[1]! };
  if (/^skeleton(\/|$)/.test(prop)) return { root: 'skeleton', part: 'loose' };
  return null;
}

/** Every row under a node and its children. */
export function rigNodeCount(n: RigRowNode): number {
  return n.props.length + n.children.reduce((s, c) => s + rigNodeCount(c), 0);
}

function partName(tree: MirrorTreeLike | undefined, groupPath: string, fallback: string): string {
  const name = tree?.nodes.get(groupPath)?.name;
  return name && name.length > 0 ? name : fallback;
}

/**
 * The section's rows as the Puppet / Skeleton trees above. Pins and bones
 * keep the order they first appear in (the rig's own order, which is the row
 * projection's). A root with no rows is omitted.
 */
export function groupRigRows(props: readonly TimelinePropertyTrack[], tree: MirrorTreeLike | undefined): RigRowNode[] {
  const roots = new Map<'puppet' | 'skeleton', RigRowNode>();
  const rootOf = (root: 'puppet' | 'skeleton'): RigRowNode => {
    let n = roots.get(root);
    if (!n) {
      n = root === 'puppet'
        ? { key: 'rig/puppet', label: t('timeline.rig.puppet', 'Puppet'), icon: 'puppet-pin', props: [], children: [] }
        : { key: 'rig/skeleton', label: t('timeline.rig.skeleton', 'Skeleton'), icon: 'bone', props: [], children: [] };
      roots.set(root, n);
    }
    return n;
  };
  const childOf = (parent: RigRowNode, key: string, label: string, icon: IconName): RigRowNode => {
    let n = parent.children.find((c) => c.key === key);
    if (!n) {
      n = { key, label, icon, props: [], children: [] };
      parent.children.push(n);
    }
    return n;
  };
  for (const p of props) {
    const owner = rigOwnerOfRow(p.prop);
    if (!owner) continue;
    const root = rootOf(owner.root);
    switch (owner.part) {
      case 'mesh':
        childOf(root, `${root.key}/mesh`, t('timeline.rig.mesh', 'Mesh'), 'shape').props.push(p);
        break;
      case 'pin': {
        const pins = childOf(root, `${root.key}/pins`, t('timeline.rig.pins', 'Pins'), 'puppet-pin');
        childOf(pins, `${pins.key}/${owner.id}`, partName(tree, `puppet/pins/${owner.id}`, owner.id), 'puppet-pin').props.push(p);
        break;
      }
      case 'bone': {
        const bones = childOf(root, `${root.key}/bones`, t('timeline.rig.bones', 'Bones'), 'bone');
        childOf(bones, `${bones.key}/${owner.id}`, partName(tree, `skeleton/bones/${owner.id}`, owner.id), 'bone').props.push(p);
        break;
      }
      default:
        root.props.push(p);
    }
  }
  // Puppet first, as the row projection lists it.
  return [...(roots.has('puppet') ? [roots.get('puppet')!] : []), ...(roots.has('skeleton') ? [roots.get('skeleton')!] : [])];
}

/** The indent (px) of a nested category / its rows: one step (14 px) per level under the section. */
export function nestedIndent(categoryKey: string): number {
  return (categoryKey.split('/').length - 1) * 14;
}
