/**
 * ShapeEffects — one consolidated inspector section for a shape layer's
 * procedural effects (Repeater, Path Operator, Trim Paths). A SINGLE "+ Add"
 * menu is the one visible entry point (no three stacked per-effect "Add"
 * buttons); each effect's controls appear inline once added, and each self-
 * hides when absent. Keeps one home per action — no duplication.
 */

import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readRepeaterConfig, setRepeater, defaultRepeater } from '@core/scene/repeater';
import { readPathOpConfig, setPathOp, defaultPathOp } from '@core/scene/pathOps';
import { readTrimConfig, setTrim, defaultTrim } from '@core/scene/trimPath';
import { RepeaterControls } from './RepeaterControls';
import { PathOpControls } from './PathOpControls';
import { TrimPathControls } from './TrimPathControls';
import styles from './TextAnimatorControls.module.css';

export function ShapeEffects({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'shape') return null;

  const hasRepeater = !!readRepeaterConfig(node);
  const hasPathOp = !!readPathOpConfig(node);
  const hasTrim = !!readTrimConfig(node);

  const items: DropdownItem[] = [
    {
      type: 'item',
      id: 'add-pathop',
      label: 'Path Operator',
      icon: 'pen',
      disabled: hasPathOp,
      onSelect: () => setPathOp(nodeId, defaultPathOp()),
    },
    {
      type: 'item',
      id: 'add-trim',
      label: 'Trim Paths',
      icon: 'shape',
      disabled: hasTrim,
      onSelect: () => setTrim(nodeId, defaultTrim()),
    },
    {
      type: 'item',
      id: 'add-repeater',
      label: 'Repeater',
      icon: 'layers',
      disabled: hasRepeater,
      onSelect: () => setRepeater(nodeId, defaultRepeater()),
    },
  ];

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.title}>Shape Effects</span>
        <Dropdown
          placement="bottom-end"
          trigger={
            <button type="button" className={styles.add} aria-label="Add shape effect">
              <Icon name="plus" size={12} />
              <span>Add</span>
            </button>
          }
          items={items}
        />
      </div>
      {!hasRepeater && !hasPathOp && !hasTrim && (
        <div className={styles.empty}>Fan into copies, deform, or trim the outline.</div>
      )}
      <PathOpControls nodeId={nodeId} />
      <TrimPathControls nodeId={nodeId} />
      <RepeaterControls nodeId={nodeId} />
    </div>
  );
}

export default ShapeEffects;
