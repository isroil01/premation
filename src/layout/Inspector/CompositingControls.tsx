import { Icon } from '@components/Icon';
import { Dropdown, type DropdownItem } from '@components/Dropdown';
import { documentMirror } from '@stores/documentMirror';
import { mirrorMatte } from '@core/mirror/layerFacts';
import type { LayerBlendMode } from '@core/effects/blendMode';
import { blendDropdownItems, blendModeLabel } from './blendMenu';
import { setLayerMatte, setLayersBlend } from './inspectorEdits';
import { siblingsOf, useCompLayersWatch } from './inspectorMirror';
import { MATTE_OPTIONS, matteOptionId, applyMatteOption, setMatteSource } from '@components/MatteControl/matteMenu';
import styles from '../Effects/EffectsPanel.module.css';

export function CompositingControls({ nodeId }: { nodeId: string }): JSX.Element {
  // The header (blend, matte) and every layer of the comp (the matte-source list).
  const layer = useCompLayersWatch(nodeId);

  const blend = (layer?.blendMode ?? 'normal') as LayerBlendMode;
  const blendLabel = blendModeLabel(blend);
  const blendItems: DropdownItem[] = blendDropdownItems(blend, (m) => setLayersBlend([nodeId], m));

  const matte = mirrorMatte(layer);
  const currentOption = matteOptionId(matte);
  const currentSourceId = matte?.sourceId;

  // Back to front, the order the matte-source list has always used.
  const siblings = layer ? siblingsOf(documentMirror(), layer) : [];

  const matteLabel = MATTE_OPTIONS.find((m) => m.id === currentOption)?.label ?? 'No matte';
  const matteItems: DropdownItem[] = MATTE_OPTIONS.map((m) => ({
    type: 'item',
    id: m.id,
    label: m.label,
    icon: m.id === currentOption ? 'check' : undefined,
    // applyMatteOption carries the explicit source across a mode change.
    onSelect: () => setLayerMatte(nodeId, applyMatteOption(matte, m.id)),
  }));

  const sourceLabel = currentSourceId && matte
    ? siblings.find(s => s.id === currentSourceId)?.name ?? 'Layer Above'
    : 'Layer Above';

  const sourceItems: DropdownItem[] = [
    {
      type: 'item',
      id: 'layer-above',
      label: 'Layer Above (Default)',
      icon: !currentSourceId ? 'check' : undefined,
      onSelect: () => setLayerMatte(nodeId, setMatteSource(matte, undefined)),
    },
    { type: 'separator' },
    ...siblings.map(s => ({
      type: 'item' as const,
      id: s.id,
      label: s.name || s.id,
      icon: (s.id === currentSourceId ? 'check' : undefined) as "check" | undefined,
      onSelect: () => setLayerMatte(nodeId, setMatteSource(matte, s.id)),
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
              <Icon name="chevron-down" size="sm" />
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
              <Icon name="chevron-down" size="sm" />
            </button>
          }
          items={matteItems}
        />
      </div>

      {matte && (
        <div className={styles.blendRow}>
          <span className={styles.blendLabel}>Matte Source</span>
          <Dropdown
            placement="bottom-end"
            trigger={
              <button type="button" className={styles.blendTrigger} style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sourceLabel}>
                {sourceLabel}
                <Icon name="chevron-down" size="sm" />
              </button>
            }
            items={sourceItems}
          />
        </div>
      )}
    </div>
  );
}
