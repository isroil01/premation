/**
 * AnchorControl (E4 / MG-A) — the layer's Anchor Point. Enabling adds an
 * anchor offset (the pivot rotation/scale spin around). Editing X/Y uses the
 * pan-behind compensation so the layer stays visually put while the pivot moves.
 */

import { Switch } from '@components/Switch';
import { ValueField } from '@components/ValueField';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeAnchor, hasAnchor, setAnchorEnabled, moveAnchorCompensated } from '@core/scene/anchor';
import { InspectorRow } from '@components/Inspector';
import styles from './ParentControl.module.css';

export function AnchorControl({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || nodeId === 'comp_root') return null;
  if (!node.components.some((c) => c.type === 'Transform')) return null;

  const on = hasAnchor(node);
  const anchor = readNodeAnchor(node);

  return (
    <>
      <div className={styles.row}>
        <span className={styles.label}>Anchor Point</span>
        <Switch
          checked={on}
          onChange={(e) => setAnchorEnabled(nodeId, e.currentTarget.checked)}
          aria-label="Anchor point (pan-behind pivot)"
        />
      </div>
      {on && (
        <>
          <InspectorRow label="Anchor X" align="center">
            <ValueField value={anchor.x} unit="px" onChange={(v) => moveAnchorCompensated(nodeId, v, anchor.y)} aria-label="Anchor X" />
          </InspectorRow>
          <InspectorRow label="Anchor Y" align="center">
            <ValueField value={anchor.y} unit="px" onChange={(v) => moveAnchorCompensated(nodeId, anchor.x, v)} aria-label="Anchor Y" />
          </InspectorRow>
        </>
      )}
    </>
  );
}

export default AnchorControl;
