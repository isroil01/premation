/**
 * ParentControl — the layer's "Parent" picker in the inspector.
 *
 * Two ways to set it, because people reach for two. The DROPDOWN is the one you
 * use when you know the layer's name and it is off screen. The PICK-WHIP is the
 * one every After Effects user reaches for first: drag the spiral onto a layer
 * in the scene tree or the timeline and it becomes the parent. Both go through
 * `reparentNode`, so a layer never moves on screen when it is parented, and
 * neither can create a cycle — the dropdown's option list and the whip's
 * `accept` ask `eligibleParents` the same question.
 *
 * "None" parents the layer back to the composition root.
 *
 * ── Modifiers (After Effects) ────────────────────────────────────────────
 * PLAIN picks parent WITHOUT a jump: the layer keeps its world pose.
 * SHIFT is AE's Parent & Link jump: the layer snaps onto the parent, its
 * position set to the parent's anchor point.
 * ALT (Option) is the older "keep values" variant — link without compensating,
 * so typed values are reinterpreted in the parent's space (the Lottie importer
 * parents this way). See `parentOptionsFor` for the one place the modifiers
 * become options, shared by every surface that parents.
 */

import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { PickWhip } from '@components/PickWhip';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { eligibleParents, parentOfNode } from '@core/scene/parenting';
import { parentLayer } from './inspectorEdits';
import styles from './ParentControl.module.css';

export function ParentControl({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || nodeId === 'comp_root') return null;

  const currentParent = parentOfNode(nodeId);
  const options = eligibleParents(nodeId);
  const currentName = currentParent
    ? options.find((o) => o.id === currentParent)?.name ?? 'Parent'
    : 'None';

  const items: DropdownItem[] = [
    {
      type: 'item',
      id: '__none__',
      label: 'None',
      icon: currentParent === null ? 'check' : undefined,
      onSelect: (m) => parentLayer(nodeId, null, m),
    },
    ...(options.length ? [{ type: 'separator' as const }] : []),
    ...options.map((o): DropdownItem => ({
      type: 'item',
      id: o.id,
      label: o.name,
      icon: o.id === currentParent ? 'check' : undefined,
      onSelect: (m) => parentLayer(nodeId, o.id, m),
    })),
  ];

  return (
    <div className={styles.row}>
      <span className={styles.label}>Parent</span>
      <PickWhip
        label="Parent pick-whip — drag onto a layer (Shift: jump to the parent · Alt: keep values)"
        // The same question the dropdown's list answers, asked of one id:
        // `eligibleParents` already excludes this layer and its descendants,
        // so a cycle cannot be dropped and the line greys out over one.
        accept={(target) => options.some((o) => o.id === target.nodeId)}
        onPick={(target, m) => parentLayer(nodeId, target.nodeId, m)}
      />
      <Dropdown
        placement="left-start"
        trigger={
          <button type="button" className={styles.trigger} aria-label="Parent layer">
            <span className={styles.value}>{currentName}</span>
            <Icon name="chevron-down" size="sm" />
          </button>
        }
        items={items}
      />
    </div>
  );
}

export default ParentControl;
