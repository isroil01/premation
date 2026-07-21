import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { useSceneRevision } from '@stores/sceneStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { BLEND_MODES, getNodeBlend, setNodeBlend } from '@core/effects/blendMode';
import { MATTE_OPTIONS, getNodeMatte, setNodeMatte, getMatteMode, getMatteSourceId } from '@core/effects/matte';
import styles from '../Effects/EffectsPanel.module.css';

export function CompositingControls({ nodeId }: { nodeId: string }): JSX.Element {
  useSceneRevision((s) => s.rev);

  const blend = getNodeBlend(nodeId);
  const blendLabel = BLEND_MODES.find((b) => b.mode === blend)?.label ?? 'Normal';
  const blendItems: DropdownItem[] = BLEND_MODES.map((b) => ({
    type: 'item',
    id: b.mode,
    label: b.label,
    icon: b.mode === blend ? 'check' : undefined,
    onSelect: () => setNodeBlend(nodeId, b.mode),
  }));

  const matte = getNodeMatte(nodeId);
  const currentMode = getMatteMode(matte) ?? 'none';
  const currentSourceId = getMatteSourceId(matte);
  
  const node = defaultSceneGraph.getNode(nodeId);
  const siblings = node && node.parent ? defaultSceneGraph.getChildren(node.parent).filter(n => n.id !== nodeId) : [];

  const matteLabel = MATTE_OPTIONS.find((m) => m.value === currentMode)?.label ?? 'No matte';
  const matteItems: DropdownItem[] = MATTE_OPTIONS.map((m) => ({
    type: 'item',
    id: m.value,
    label: m.label,
    icon: m.value === currentMode ? 'check' : undefined,
    onSelect: () => {
      if (m.value === 'none') {
        setNodeMatte(nodeId, 'none');
      } else {
        setNodeMatte(nodeId, currentSourceId ? { mode: m.value, sourceId: currentSourceId } : m.value);
      }
    },
  }));

  const sourceLabel = currentSourceId && currentMode !== 'none'
    ? siblings.find(s => s.id === currentSourceId)?.name ?? 'Layer Above'
    : 'Layer Above';

  const sourceItems: DropdownItem[] = [
    { 
      type: 'item', 
      id: 'layer-above', 
      label: 'Layer Above (Default)', 
      icon: !currentSourceId ? 'check' : undefined, 
      onSelect: () => {
        if (currentMode !== 'none') setNodeMatte(nodeId, currentMode);
      }
    },
    { type: 'separator' },
    ...siblings.map(s => ({
      type: 'item' as const,
      id: s.id,
      label: s.name || s.id,
      icon: (s.id === currentSourceId ? 'check' : undefined) as "check" | undefined,
      onSelect: () => {
        if (currentMode !== 'none') setNodeMatte(nodeId, { mode: currentMode, sourceId: s.id });
      }
    }))
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Blend Mode</span>
        <Dropdown
          placement="bottom-end"
          trigger={
            <button type="button" className={styles.blendTrigger}>
              {blendLabel}
              <Icon name="chevron-down" size={12} />
            </button>
          }
          items={blendItems}
        />
      </div>

      <div className={styles.blendRow}>
        <span className={styles.blendLabel}>Track Matte</span>
        <Dropdown
          placement="bottom-end"
          trigger={
            <button type="button" className={styles.blendTrigger}>
              {matteLabel}
              <Icon name="chevron-down" size={12} />
            </button>
          }
          items={matteItems}
        />
      </div>

      {currentMode !== 'none' && (
        <div className={styles.blendRow}>
          <span className={styles.blendLabel}>Matte Source</span>
          <Dropdown
            placement="bottom-end"
            trigger={
              <button type="button" className={styles.blendTrigger} style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sourceLabel}>
                {sourceLabel}
                <Icon name="chevron-down" size={12} />
              </button>
            }
            items={sourceItems}
          />
        </div>
      )}
    </div>
  );
}
