/**
 * ParentControl (Prompt E3) — the layer's "Parent" picker in the inspector.
 * Choosing a parent reparents the layer WITHOUT moving it on screen; the option
 * list already excludes the layer itself and its descendants, so it can never
 * create a cycle. "None" parents the layer back to the composition root.
 */

import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { eligibleParents, parentOfNode, reparentNode } from '@core/scene/parenting';
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
      onSelect: () => reparentNode(nodeId, null),
    },
    ...(options.length ? [{ type: 'separator' as const }] : []),
    ...options.map((o): DropdownItem => ({
      type: 'item',
      id: o.id,
      label: o.name,
      icon: o.id === currentParent ? 'check' : undefined,
      onSelect: () => reparentNode(nodeId, o.id),
    })),
  ];

  return (
    <div className={styles.row}>
      <span className={styles.label}>Parent</span>
      <Dropdown
        placement="bottom-end"
        trigger={
          <button type="button" className={styles.trigger} aria-label="Parent layer">
            <span className={styles.value}>{currentName}</span>
            <Icon name="chevron-down" size={12} />
          </button>
        }
        items={items}
      />
    </div>
  );
}

export default ParentControl;
