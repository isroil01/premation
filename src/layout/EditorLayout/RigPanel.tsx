/**
 * RigPanel — bones and puppet pins for the selected layer.
 *
 * Separate from Properties on purpose: rigging is a MODE, not a property of the
 * selection. You enter it with a tool, you leave it with a tool, and while you
 * are in it the controls you want are not the ones a transform section shows.
 *
 * Which of the two sections appear is a question about the layer AND the active
 * tool: a layer with a skeleton always shows Bones, a layer with neither shows
 * both (so there is somewhere to start), and picking up a tool reveals the
 * section that tool writes into.
 */

import { useState } from 'react';
import { Panel } from '@components/Panel';
import { Button } from '@components/Button';
import { Icon } from '@components/Icon';
import { EmptyState } from '@components/EmptyState';
import { SearchField } from '@components/SearchField';
import type { AccordionItem } from '@components/Accordion';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { getEventBus } from '@core/events/EventBus';
import { useMirrorLayer, useMirrorTree } from '@hooks/useMirror';
import { BoneControls } from '@layout/Inspector/BoneControls';
import { PuppetControls } from '@layout/Inspector/PuppetControls';
import { renderInspector } from '@layout/Inspector/InspectorContent';
import styles from './panels.module.css';

export function RigPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? null;
  const [query, setQuery] = useState('');

  return (
    <Panel
      id="rig"
      title="Rigging"
      icon="bone"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'rig' })}
    >
      {primary && (
        <div className={styles.searchRow}>
          <SearchField
            placeholder="Search rigging…"
            ariaLabel="Search rigging"
            value={query}
            onChange={setQuery}
          />
        </div>
      )}
      <RigPanelContent nodeId={primary} query={query} />
    </Panel>
  );
}

function RigPanelContent({ nodeId, query = '' }: { nodeId: string | null; query?: string }): JSX.Element {
  const activeTool = useUIStore((s) => s.activeTool);
  // B4: the layer and its rig groups from the mirror — `puppet` / `skeleton`
  // exist in the property tree exactly when the layer stores that rig
  // (rigProps.ts `rigGroupPaths`), and the tree key wakes this on add / remove.
  const layer = useMirrorLayer(nodeId);
  const tree = useMirrorTree(layer ? nodeId : null);
  if (!nodeId) {
    return (
      <EmptyState
        icon="bone"
        title="Character Rigging"
        message="Select a layer, then use the Puppet or Bone tool."
        action={
          <>
            <Button size="sm" variant="secondary" fullWidth onClick={() => useUIStore.getState().setActiveTool('bone')}>
              <Icon name="bone" size="sm" style={{ color: '#f97316' }} /> Bone Tool
            </Button>
            <Button size="sm" variant="secondary" fullWidth onClick={() => useUIStore.getState().setActiveTool('puppet-pin')}>
              <Icon name="puppet-pin" size="sm" /> Puppet Pin Tool
            </Button>
          </>
        }
      />
    );
  }
  if (!layer) return <div className={styles.empty}>No node data</div>;

  const items: AccordionItem[] = [];
  const hasSkeleton = !!tree?.nodes.has('skeleton');
  const hasPuppet = !!tree?.nodes.has('puppet');

  if (hasSkeleton || activeTool === 'bone' || !hasPuppet) {
    items.push({
      id: 'skeleton',
      title: 'Bones',
      icon: 'bone',
      defaultOpen: true,
      content: <BoneControls nodeId={nodeId} />,
    });
  }

  if (hasPuppet || activeTool === 'puppet-pin' || !hasSkeleton) {
    items.push({
      id: 'puppet',
      title: 'Puppet',
      icon: 'puppet-pin',
      defaultOpen: true,
      content: <PuppetControls nodeId={nodeId} />,
    });
  }

  return renderInspector(items, query);
}

export default RigPanel;
