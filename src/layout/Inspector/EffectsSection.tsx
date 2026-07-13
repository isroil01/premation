import { useState } from 'react';
import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { EFFECT_DEFS, addEffect } from '@core/effects/effects';
import { EffectStack } from '../Effects/EffectStack';
import styles from './TransformSection.module.css';

export function EffectsSection({ nodeId }: { nodeId: string }): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);

  const addItems: DropdownItem[] = EFFECT_DEFS.map((d) => ({
    type: 'item',
    id: d.type,
    label: d.label,
    onSelect: () => addEffect(nodeId, d.type),
  }));

  return (
    <div className={styles.section} style={{ borderBottom: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(255, 255, 255, 0.4)',
            fontSize: 11,
            fontWeight: 'bold',
            textTransform: 'uppercase',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
            padding: 0
          }}
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
          Effects
        </button>
        {!collapsed && (
          <Dropdown
            placement="bottom-end"
            trigger={
              <button
                type="button"
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#38bdf8',
                  fontSize: 10,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  padding: 0
                }}
              >
                <Icon name="plus" size={10} /> Add
              </button>
            }
            items={addItems}
          />
        )}
      </div>
      {!collapsed && <EffectStack nodeId={nodeId} />}
    </div>
  );
}

export default EffectsSection;
