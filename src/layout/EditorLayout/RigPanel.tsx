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
import { useActiveWorkspace } from '@stores/projectStore';
import { useRigSelectionStore } from '@stores/rigSelectionStore';
import { edit } from '@core/engine/uiEdits';
import { keyRigAtPlayheadCommands } from '@layout/Inspector/rigEdits';
import { RigPoseButtons } from '@layout/Inspector/RigPoseButtons';
import { getEventBus } from '@core/events/EventBus';
import { useMirrorLayer, useMirrorTree } from '@hooks/useMirror';
import { BoneControls } from '@layout/Inspector/BoneControls';
import { PuppetControls } from '@layout/Inspector/PuppetControls';
import { renderInspector } from '@layout/Inspector/InspectorContent';
import styles from './panels.module.css';
import { t } from '@core/i18n';

const NO_BONES: readonly string[] = [];

export function RigPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  const primary = selected[0] ?? null;
  const [query, setQuery] = useState('');

  return (
    <Panel
      id="rig"
      title={t('panel.rig', 'Rigging')}
      icon="bone"
      hideHeader
      onClose={() => getEventBus().emit('PanelClosed', { panelId: 'rig' })}
    >
      {primary && (
        <div className={styles.searchRow}>
          <SearchField
            placeholder={t('editor.rig.searchPlaceholder', 'Search rigging…')}
            ariaLabel={t('editor.rig.search', 'Search rigging')}
            value={query}
            onChange={setQuery}
          />
        </div>
      )}
      {primary && <KeyPoseRow nodeId={primary} />}
      <RigPanelContent nodeId={primary} query={query} />
    </Panel>
  );
}

/**
 * "Key selected" / "Key all" (C2): one keyframe at the playhead on the pose of
 * the selected pins and bones, or of every pin and bone — AE's "set a keyframe
 * here" over a whole pose, one undo entry (rigEdits `keyRigAtPlayheadCommands`).
 * Copy, Paste and Mirror Pose sit under it on a skeleton. Hidden while the layer
 * has no rig.
 */
function KeyPoseRow({ nodeId }: { nodeId: string }): JSX.Element | null {
  const layer = useMirrorLayer(nodeId);
  const tree = useMirrorTree(layer ? nodeId : null);
  const seconds = useActiveWorkspace()?.time ?? 0;
  const pinIds = useRigSelectionStore((s) => (s.nodeId === nodeId ? s.pinIds : []));
  const boneIds = useRigSelectionStore((s) => (s.nodeId === nodeId ? s.boneIds : NO_BONES));
  const hasSkeleton = !!tree?.nodes.has('skeleton');
  const hasRig = !!tree && (tree.nodes.has('puppet') || hasSkeleton);
  if (!layer || !hasRig) return null;
  const anySelected = pinIds.length > 0 || boneIds.length > 0;
  return (
    <>
    <div className={styles.searchRow} style={{ display: 'flex', gap: 6 }}>
      <Button
        size="sm"
        variant="secondary"
        disabled={!anySelected}
        title={t('editor.rig.keySelectedHint', 'Keyframe the selected pins and bones at the playhead')}
        onClick={() => {
          void edit('Key Selected Rig', keyRigAtPlayheadCommands(nodeId, seconds, { pins: pinIds, bones: boneIds }));
        }}
      >
        <Icon name="diamond" size="sm" /> {t('editor.rig.keySelected', 'Key selected')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        title={t('editor.rig.keyAllHint', 'Keyframe every pin and bone at the playhead')}
        onClick={() => { void edit('Key Rig Pose', keyRigAtPlayheadCommands(nodeId, seconds, { pins: null, bones: null })); }}
      >
        <Icon name="diamond" size="sm" /> {t('editor.rig.keyAll', 'Key all')}
      </Button>
    </div>
    {hasSkeleton && (
      <div className={styles.searchRow} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <RigPoseButtons nodeId={nodeId} seconds={seconds} />
      </div>
    )}
    </>
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
        title={t('editor.rig.emptyTitle', 'Character Rigging')}
        message={t('editor.rig.emptyMessage', 'Select a layer, then use the Puppet or Bone tool.')}
        action={
          <>
            <Button size="sm" variant="secondary" fullWidth onClick={() => useUIStore.getState().setActiveTool('bone')}>
              <Icon name="bone" size="sm" style={{ color: '#f97316' }} /> {t('editor.rig.boneTool', 'Bone Tool')}
            </Button>
            <Button size="sm" variant="secondary" fullWidth onClick={() => useUIStore.getState().setActiveTool('puppet-pin')}>
              <Icon name="puppet-pin" size="sm" /> {t('editor.rig.puppetPinTool', 'Puppet Pin Tool')}
            </Button>
          </>
        }
      />
    );
  }
  if (!layer) return <div className={styles.empty}>{t('editor.rig.noNodeData', 'No node data')}</div>;

  const items: AccordionItem[] = [];
  const hasSkeleton = !!tree?.nodes.has('skeleton');
  const hasPuppet = !!tree?.nodes.has('puppet');

  if (hasSkeleton || activeTool === 'bone' || !hasPuppet) {
    items.push({
      id: 'skeleton',
      title: t('editor.rig.bones', 'Bones'),
      icon: 'bone',
      defaultOpen: true,
      content: <BoneControls nodeId={nodeId} />,
    });
  }

  if (hasPuppet || activeTool === 'puppet-pin' || !hasSkeleton) {
    items.push({
      id: 'puppet',
      title: t('editor.rig.puppet', 'Puppet'),
      icon: 'puppet-pin',
      defaultOpen: true,
      content: <PuppetControls nodeId={nodeId} />,
    });
  }

  return renderInspector(items, query);
}

export default RigPanel;
